import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// A gateway that dies without saying why costs hours of guessing. These
// handlers make every abnormal exit leave a machine-readable record with the
// error, the process footprint, and the in-flight registry at that moment.
const MAX_CAUSE_DEPTH = 3;
// A repeating rejection writes a record each time; keep the newest ones only.
export const MAX_CRASH_RECORDS = 50;

export function describeError(value, depth = 0) {
  if (!(value instanceof Error)) {
    return { message: String(value), stack: null, cause: null };
  }
  const described = {
    name: value.name,
    message: value.message,
    stack: value.stack ? String(value.stack) : null,
  };
  const code = value.code;
  if (typeof code === "string" || typeof code === "number") described.code = code;
  const cause = value.cause;
  described.cause = cause && depth < MAX_CAUSE_DEPTH ? describeError(cause, depth + 1) : null;
  return described;
}

export function createCrashRecorder({
  cacheDir,
  snapshot,
  log = (message) => console.error(message),
  now = () => new Date(),
  pid = process.pid,
  uptime = () => process.uptime(),
  memory = () => process.memoryUsage(),
  maxRecords = MAX_CRASH_RECORDS,
}) {
  const dir = resolve(cacheDir, "crashes");
  return {
    dir,
    record(kind, error) {
      const at = now().toISOString();
      let inflight = null;
      try {
        inflight = snapshot?.() ?? null;
      } catch (snapshotError) {
        inflight = { error: describeError(snapshotError) };
      }
      const usage = memory();
      const described = describeError(error);
      const payload = {
        kind,
        at,
        pid,
        uptimeSeconds: Math.round(Number(uptime()) || 0),
        node: process.version,
        memory: {
          rss: usage.rss,
          heapTotal: usage.heapTotal,
          heapUsed: usage.heapUsed,
          external: usage.external,
          arrayBuffers: usage.arrayBuffers,
        },
        error: described,
        inflight,
      };
      let path = null;
      try {
        mkdirSync(dir, { recursive: true });
        path = resolve(dir, `${at.replace(/[:.]/gu, "-")}-${kind}.json`);
        writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        pruneRecords(dir, maxRecords);
      } catch (writeError) {
        path = null;
        log(`gateway crash record write failed: ${describeError(writeError).message}`);
      }
      const active = Array.isArray(inflight?.active) ? inflight.active.length : "unknown";
      log([
        `gateway ${kind} pid=${pid} at=${at} active=${active} record=${path || "unwritten"}`,
        described.stack || described.message,
      ].join("\n"));
      return { path, payload };
    },
  };
}

// Losing one Telegram edit must not kill the router: a rejected promise has no
// owner here, so Node would treat it as fatal. Record it and keep serving.
//
// An uncaught exception is different: it can leave the process half-broken
// (a dead socket server, a stopped loop) while it still looks alive, and
// systemd restarts only a process that exits. Record it, then exit non-zero.
export function installCrashDiagnostics({
  cacheDir,
  snapshot,
  log,
  processRef = process,
  exit = (code) => processRef.exit(code),
  ...rest
}) {
  const recorder = createCrashRecorder({ cacheDir, snapshot, log, ...rest });
  let exiting = false;
  const onRejection = (reason) => {
    recorder.record("unhandledRejection", reason);
  };
  const onException = (error) => {
    if (exiting) return;
    exiting = true;
    recorder.record("uncaughtException", error);
    exit(1);
  };
  const onExit = (code) => {
    // An exit that follows a recorded exception already has its record.
    if (code === 0 || exiting) return;
    recorder.record("exit", new Error(`gateway exited with code ${code}`));
  };
  processRef.on("unhandledRejection", onRejection);
  processRef.on("uncaughtException", onException);
  processRef.on("exit", onExit);
  return {
    recorder,
    uninstall() {
      processRef.off("unhandledRejection", onRejection);
      processRef.off("uncaughtException", onException);
      processRef.off("exit", onExit);
    },
  };
}

function pruneRecords(dir, maxRecords) {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of files.slice(0, Math.max(0, files.length - maxRecords))) {
    rmSync(resolve(dir, name), { force: true });
  }
}

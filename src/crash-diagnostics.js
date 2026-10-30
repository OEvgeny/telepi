import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// A gateway that dies without saying why costs hours of guessing. These
// handlers make every abnormal exit leave a machine-readable record with the
// error, the process footprint, and the in-flight registry at that moment.
const MAX_CAUSE_DEPTH = 3;

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
export function installCrashDiagnostics({ cacheDir, snapshot, log, processRef = process, ...rest }) {
  const recorder = createCrashRecorder({ cacheDir, snapshot, log, ...rest });
  const onRejection = (reason) => {
    recorder.record("unhandledRejection", reason);
  };
  const onException = (error) => {
    recorder.record("uncaughtException", error);
  };
  const onExit = (code) => {
    if (code === 0) return;
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

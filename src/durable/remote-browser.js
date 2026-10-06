import { createHash } from "node:crypto";
import { Type, StringEnum } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const ACTIONS = ["start", "navigate", "interact", "inspect", "verify", "capture", "close"];
const RESETS = ["reload", "newPage", "preserve"];
const PRESETS = ["focus", "fonts", "geometry", "a11y", "network", "console", "health"];
const OPERATIONS = ["run", "recordCase"];
const BRIDGE_SOURCE = String.raw`import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { openSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const socketPath = process.argv[3];
const packageRoot = process.argv[4];
const cwd = process.argv[5];
const inputPath = process.argv[6];
const chromiumBin = mode === "serve" ? process.argv[6] : process.argv[7];
if (chromiumBin) process.env.CHROMIUM_BIN = chromiumBin;

function exchange(payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", reject);
    socket.on("close", () => {
      try { resolve(JSON.parse(output)); }
      catch (error) { reject(new Error("Invalid browser bridge response: " + output.slice(0, 500))); }
    });
  });
}

async function request(payload) {
  try { return await exchange(payload); }
  catch {}
  const logPath = socketPath + ".log";
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, [process.argv[1], "serve", socketPath, packageRoot, cwd, chromiumBin || ""], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { return await exchange(payload); }
    catch (error) { lastError = error; }
  }
  throw new Error("Remote browser bridge did not start: " + (lastError?.message || "unknown error"));
}

async function serve() {
  await mkdir(join(socketPath, ".."), { recursive: true });
  await rm(socketPath, { force: true });
  const { Session } = await import(pathToFileURL(join(packageRoot, "src", "session.mjs")).href);
  const output = await import(pathToFileURL(join(packageRoot, "src", "output.mjs")).href);
  let session = null;
  let queue = Promise.resolve();
  const ensureSession = () => {
    if (!session) session = new Session({ cwd, artifactsDir: join(cwd, ".assets", "browser-evidence") });
    return session;
  };
  const closeSession = async () => {
    try { await session?.close(); } catch {}
    session = null;
  };
  const perform = async (params) => {
    const action = params.action;
    let text;
    let details = { action };
    if (action === "start") {
      const info = await ensureSession().start({ serve: params.serve, url: params.url, path: params.path, viewport: params.viewport, ready: params.ready, media: params.media });
      text = output.renderReady(info); details = { ...details, ...info };
    } else if (action === "navigate") {
      const info = await ensureSession().navigate({ url: params.url, path: params.path, viewport: params.viewport, ready: params.ready, media: params.media });
      text = "NAVIGATED " + info.url + " · " + info.viewport.width + "×" + info.viewport.height; details = { ...details, ...info };
    } else if (action === "interact") {
      if (!Array.isArray(params.steps) || params.steps.length === 0) throw new Error("interact requires a non-empty steps array");
      const result = await ensureSession().interact({ reset: params.reset, steps: params.steps });
      text = output.renderInteract(result); details = { ...details, result };
      if (result.status !== "ok") throw new Error(output.bound(text));
    } else if (action === "inspect") {
      const result = await ensureSession().inspect({ preset: params.expression ? undefined : params.preset, expression: params.expression, targets: params.targets, overlay: params.overlay, viewport: params.viewport });
      text = output.renderInspect(result); details = { ...details, preset: result.preset, dataPath: result.dataPath, files: result.files };
    } else if (action === "verify") {
      if (params.operation === "recordCase") {
        const result = await ensureSession().verify({ operation: "recordCase", name: params.name });
        text = output.renderRecordCase(result); details = { ...details, ...result };
      } else {
        if (!params.spec && !params.inline) throw new Error("verify requires spec (path) or inline (object)");
        const result = await ensureSession().verify({ specPath: params.spec, spec: params.inline, cases: params.cases, artifactsDir: undefined });
        text = output.renderRunSummary(result, { specPath: params.spec ?? null }); details = { ...details, ok: result.ok, cases: result.cases.length, artifacts: result.artifacts };
        if (!result.ok) throw new Error(output.bound(text));
      }
    } else if (action === "capture") {
      const result = await ensureSession().capture({ url: params.url, path: params.path, viewport: params.viewport, output: params.output, name: params.name, fullPage: params.fullPage });
      text = output.renderCapture(result); details = { ...details, ...result };
    } else if (action === "close") {
      await closeSession(); text = "browser session closed";
    } else {
      throw new Error("unknown browser action: " + action);
    }
    return { ok: true, text: output.bound(text), details };
  };
  const server = createServer({ allowHalfOpen: true }, (stream) => {
    let input = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { input += chunk; });
    stream.on("end", () => {
      queue = queue.then(async () => {
        const request = JSON.parse(input);
        if (request.admin === "shutdown") {
          await closeSession();
          stream.end(JSON.stringify({ ok: true, text: "browser bridge closed", details: {} }));
          server.close();
          return;
        }
        try { stream.end(JSON.stringify(await perform(request))); }
        catch (error) { stream.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); }
      }).catch((error) => stream.end(JSON.stringify({ ok: false, error: String(error) })));
    });
  });
  server.listen(socketPath, async () => { await chmod(socketPath, 0o600); });
  const shutdown = async () => { await closeSession(); server.close(); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

if (mode === "serve") {
  await serve();
} else {
  const payload = mode === "shutdown" ? { admin: "shutdown" } : JSON.parse(await readFile(inputPath, "utf8"));
  const response = await request(payload);
  process.stdout.write(JSON.stringify(response));
}
`;

export class RemoteBrowserManager {
  constructor() {
    this.bridges = new Map();
  }

  async execute(params, api, context, metadataDoc) {
    if (!api.env) return failed("Browser requires an execution environment");
    const metadata = await api.snapshot(metadataDoc, api.conversationId, context);
    const packageRoot = metadata?.browserPackageRoot;
    if (!packageRoot) return failed("The selected remote agent directory does not provide a browser package");
    const cwd = api.env.cwd;
    const bridge = await this.prepare(api.env, packageRoot, cwd, context);
    const requestPath = `${bridge.directory}/request-${safeName(api.callId)}.json`;
    const written = await api.env.writeFile(requestPath, JSON.stringify(params), context);
    if (!written.ok) return failed(written.error.message);
    try {
      await requireChmod(api.env, "600", requestPath, context);
    } catch (error) {
      await api.env.remove(requestPath, { force: true }, context);
      return failed(error instanceof Error ? error.message : String(error));
    }
    let output = "";
    let diagnostics = "";
    try {
      const result = await api.env.exec(
        ["node", bridge.script, "request", bridge.socket, packageRoot, cwd, requestPath, bridge.chromiumBin || ""],
        {
          timeout: 180,
          onOutput: (text, _outputContext, info) => {
            if (info.stream === "stdout") output += text;
            else diagnostics += text;
          },
        },
        context,
      );
      if (!result.ok) return failed(result.error.message);
      if (result.value.exitCode !== 0) {
        return failed(`Remote browser bridge exited with code ${result.value.exitCode}: ${diagnostics.trim()}`);
      }
      let response;
      try {
        response = JSON.parse(output);
      } catch (error) {
        return failed(`Invalid remote browser response: ${output.slice(0, 1000)}`);
      }
      if (!response.ok) return failed(response.error || "Remote browser action failed");
      return { content: [{ type: "text", text: response.text }], details: response.details || {} };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    } finally {
      await api.env.remove(requestPath, { force: true }, context);
    }
  }

  async prepare(env, packageRoot, cwd, context) {
    const key = `${env.id}\0${cwd}\0${packageRoot}`;
    let bridge = this.bridges.get(key);
    if (bridge) return bridge;
    const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const directory = `/tmp/telepi-browser-${hash}`;
    const script = `${directory}/bridge.mjs`;
    const socket = `${directory}/bridge.sock`;
    const created = await env.createDir(directory, { recursive: true }, context);
    if (!created.ok) throw created.error;
    await requireChmod(env, "700", directory, context);
    const written = await env.writeFile(script, BRIDGE_SOURCE, context);
    if (!written.ok) throw written.error;
    const chromiumBin = await findRemoteChromium(env, context);
    bridge = { env, directory, script, socket, packageRoot, cwd, chromiumBin };
    this.bridges.set(key, bridge);
    return bridge;
  }

  async cleanup(context) {
    const bridges = [...this.bridges.values()];
    this.bridges.clear();
    await Promise.allSettled(bridges.map(async (bridge) => {
      await bridge.env.exec(
        ["node", bridge.script, "shutdown", bridge.socket, bridge.packageRoot, bridge.cwd, "", bridge.chromiumBin || ""],
        { timeout: 10 },
        context,
      );
    }));
  }
}

export function createRemoteBrowserExtension(manager, metadataDoc) {
  return defineExtension({
    name: "telepi-remote-browser",
    tools: [defineTool({
      name: "browser",
      label: "Browser",
      description: "Drive the selected remote agent's native headless Chromium browser. Sessions and evidence stay in the remote workspace.",
      promptSnippet: "Verify, interact with, inspect, and capture web pages in real headless Chromium on the remote host",
      promptGuidelines: [
        "Use browser(action:start, url:...) before interactive browsing, then use interact, inspect, navigate, capture, or close on the same remote browser session.",
        "Browser evidence paths are in the remote workspace and can be inspected with the ordinary remote coding tools.",
      ],
      parameters: Type.Object({
        action: StringEnum(ACTIONS),
        url: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        serve: Type.Optional(Type.Object({ root: Type.String(), fallback: Type.Optional(Type.String()) })),
        viewport: Type.Optional(Type.Object({ width: Type.Integer(), height: Type.Integer(), mobile: Type.Optional(Type.Boolean()) })),
        ready: Type.Optional(Type.String()),
        media: Type.Optional(Type.Array(Type.Any())),
        steps: Type.Optional(Type.Array(Type.Any())),
        reset: Type.Optional(StringEnum(RESETS)),
        spec: Type.Optional(Type.String()),
        inline: Type.Optional(Type.Any()),
        cases: Type.Optional(Type.Array(Type.String())),
        preset: Type.Optional(StringEnum(PRESETS)),
        targets: Type.Optional(Type.Array(Type.Any())),
        expression: Type.Optional(Type.String()),
        output: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
        operation: Type.Optional(StringEnum(OPERATIONS)),
        overlay: Type.Optional(Type.Boolean()),
        fullPage: Type.Optional(Type.Boolean()),
      }),
      replay: "unsafe",
      executionMode: "sequential",
      outputLimits: { maxBytes: 8 * 1024, maxLines: 200, retain: "tail" },
      execute: (params, api, context) => manager.execute(params, api, context, metadataDoc),
    })],
  });
}

async function requireChmod(env, mode, path, context) {
  const result = await env.exec(["chmod", mode, path], { timeout: 10 }, context);
  if (!result.ok) throw result.error;
  if (result.value.exitCode !== 0) throw new Error(`Could not secure remote browser path ${path}`);
}

async function findRemoteChromium(env, context) {
  let stdout = "";
  const result = await env.exec(
    ["sh", "-lc", "command -v chromium || command -v chromium-browser || command -v google-chrome || true"],
    { timeout: 10, onOutput: (text, _outputContext, info) => { if (info.stream === "stdout") stdout += text; } },
    context,
  );
  if (!result.ok || result.value.exitCode !== 0) return null;
  return stdout.trim().split(/\r?\n/).find(Boolean) || null;
}

function failed(message) {
  return { content: [{ type: "text", text: `Browser failed: ${message}` }], isError: true, details: { error: message } };
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

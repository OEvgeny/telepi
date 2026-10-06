import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DURABLE_PROTOCOL,
  DURABLE_READY_TIMEOUT_MS,
  MAX_DURABLE_FRAME_BYTES,
  MAX_DURABLE_PENDING_REQUESTS,
  assertDurableFrame,
  durableFrame,
  isDurableConnectFrame,
} from "./protocol.js";

const DEFAULT_HOST_PATH = fileURLToPath(new URL("./host.js", import.meta.url));
const MAX_STDERR_BYTES = 256 * 1024;
const HOST_EXIT_GRACE_MS = 5_000;

export class DurableDriver {
  constructor(options) {
    if (!options?.socketPath) throw new Error("Durable broker socket path is required");
    if (!options?.storageDir) throw new Error("Durable storage directory is required");
    this.socketPath = resolve(options.socketPath);
    this.storageDir = resolve(options.storageDir);
    this.projectRoot = resolve(options.projectRoot || process.cwd());
    this.infrastructureAgentDir = options.infrastructureAgentDir
      ? resolve(options.infrastructureAgentDir)
      : undefined;
    this.hostPath = options.hostPath || DEFAULT_HOST_PATH;
    this.spawnProcess = options.spawnProcess || spawn;
    this.env = sanitizeHostEnv(options.env || process.env, options.telegramTokenEnv);
    this.log = options.log || ((message) => console.error(message));
    this.readyTimeoutMs = options.readyTimeoutMs ?? DURABLE_READY_TIMEOUT_MS;
    this.maxPendingRequests = options.maxPendingRequests ?? MAX_DURABLE_PENDING_REQUESTS;
    this.gatewayRequestHandler = options.gatewayRequestHandler;
    this.pending = new Map();
    this.listeners = new Set();
    this.requestSequence = 0;
    this.generation = undefined;
    this.initPromise = undefined;
    this.restartBarrier = Promise.resolve();
    this.closing = false;
    this.stderr = "";
  }

  get isReady() {
    return Boolean(this.generation?.ready.settled && this.generation?.peer);
  }

  get isClosing() {
    return this.closing;
  }

  init() {
    if (this.closing) return Promise.reject(new Error("Durable driver is closing"));
    if (this.isReady) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    const starting = this.startGeneration();
    const initialized = starting.finally(() => {
      if (this.initPromise === initialized) this.initPromise = undefined;
    });
    this.initPromise = initialized;
    return initialized;
  }

  acceptConnection(frame, peer) {
    const looksDurable = typeof frame?.protocol === "string" && frame.protocol.startsWith("telepi.durable/");
    if (!looksDurable) return false;

    if (!isDurableConnectFrame(frame)) {
      peer.end(durableFrame("host.rejected", { error: `Unsupported Durable protocol: ${frame?.protocol || "unknown"}` }));
      return true;
    }

    const generation = this.generation;
    if (!generation || frame.nonce !== generation.nonce || generation.peer) {
      peer.end(durableFrame("host.rejected", {
        nonce: frame.nonce,
        error: !generation || frame.nonce !== generation.nonce
          ? "Stale or unknown Durable host generation"
          : "Durable host generation is already connected",
      }));
      return true;
    }

    peer.setMaxFrameBytes(MAX_DURABLE_FRAME_BYTES);
    generation.peer = peer;
    void this.attachGeneration(generation);
    return true;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(method, params = {}, options = {}) {
    const retryOnDisconnect = options.retryOnDisconnect ?? true;
    const attempts = retryOnDisconnect ? 2 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.init();
        return await this.sendRequest(method, params, options);
      } catch (error) {
        lastError = error;
        if (!(error instanceof DurableConnectionLost) || attempt === attempts || this.closing) throw error;
      }
    }
    throw lastError;
  }

  ensureEndpoint(spec) {
    return this.request("endpoint.ensure", spec, { operationId: `endpoint:${spec.endpointKey}` });
  }

  submit(endpointKey, submission) {
    return this.request("submission.submit", { endpointKey, submission }, {
      operationId: submission.requestId,
    });
  }

  waitSubmission(endpointKey, submissionId) {
    return this.request("submission.wait", { endpointKey, submissionId }, {
      operationId: `wait:${endpointKey}:${submissionId}`,
    });
  }

  abort(endpointKey) {
    return this.request("conversation.abort", { endpointKey }, {
      operationId: `abort:${endpointKey}:${randomUUID()}`,
    });
  }

  compact(endpointKey, instructions) {
    return this.request("conversation.compact", { endpointKey, instructions }, {
      operationId: `compact:${endpointKey}:${randomUUID()}`,
      retryOnDisconnect: false,
    });
  }

  inspect() {
    return this.request("host.inspect", {}, { operationId: `inspect:${randomUUID()}` });
  }

  async drainAndClose() {
    if (this.closing) return;
    this.closing = true;
    const generation = this.generation;
    if (!generation?.peer || !generation.ready.settled) {
      await this.stopGeneration(generation);
      return;
    }

    generation.expectedExit = true;
    try {
      await this.sendRequest("host.shutdown", {}, {
        operationId: `shutdown:${generation.nonce}`,
        retryOnDisconnect: false,
      });
    } catch (error) {
      if (!(error instanceof DurableConnectionLost)) throw error;
    }
    await this.waitForChildExit(generation.child);
    this.clearGeneration(generation, new DurableConnectionLost("Durable host closed"));
  }

  async startGeneration() {
    await this.restartBarrier;
    if (this.closing) throw new Error("Durable driver is closing");
    const nonce = randomUUID();
    const ready = deferred();
    const exited = deferred();
    const args = [
      this.hostPath,
      "--socket", this.socketPath,
      "--nonce", nonce,
      "--storage-dir", this.storageDir,
      "--project-root", this.projectRoot,
      ...(this.infrastructureAgentDir ? ["--infrastructure-agent-dir", this.infrastructureAgentDir] : []),
    ];
    const child = this.spawnProcess(process.execPath, args, {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: this.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const generation = { nonce, child, ready, exited, peer: undefined, expectedExit: false };
    this.generation = generation;
    this.stderr = "";

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderr = `${this.stderr}${text}`.slice(-MAX_STDERR_BYTES);
      if (text) process.stderr.write(text);
    });
    child.once("error", (error) => this.loseGeneration(generation, new Error(`Durable host error: ${error.message}`)));
    child.once("exit", (code, signal) => {
      exited.resolve({ code, signal });
      if (!generation.expectedExit) {
        this.loseGeneration(
          generation,
          new DurableConnectionLost(
            `Durable host exited (code=${code} signal=${signal})${this.stderr ? `. Stderr: ${this.stderr}` : ""}`,
          ),
        );
      }
    });

    try {
      await withTimeout(ready.promise, this.readyTimeoutMs, "Timed out waiting for Durable host readiness");
      this.log(`durable host ready pid=${child.pid} protocol=${DURABLE_PROTOCOL}`);
    } catch (error) {
      await this.stopGeneration(generation);
      throw error;
    }
  }

  async attachGeneration(generation) {
    const peer = generation.peer;
    try {
      await peer.send(durableFrame("host.accepted", { nonce: generation.nonce }));
      while (this.generation === generation) {
        const frame = assertDurableFrame(await peer.read());
        if (frame.nonce !== generation.nonce) throw new Error("Durable host frame generation mismatch");
        if (frame.type === "host.ready") {
          generation.ready.resolve();
          continue;
        }
        if (frame.type === "response") {
          const pending = this.pending.get(frame.id);
          if (!pending) continue;
          this.pending.delete(frame.id);
          if (frame.success) pending.resolve(frame.data);
          else pending.reject(new Error(frame.error || "Durable host request failed"));
          continue;
        }
        if (frame.type === "gateway.request") {
          void this.handleGatewayRequest(generation, frame);
          continue;
        }
        if (frame.type === "event") {
          for (const listener of this.listeners) {
            try {
              listener(frame.event, frame.data);
            } catch (error) {
              this.log(`durable event listener failed: ${error instanceof Error ? error.stack || error.message : error}`);
            }
          }
          continue;
        }
        throw new Error(`Unsupported Durable host frame: ${frame.type}`);
      }
    } catch (error) {
      this.loseGeneration(generation, error);
    }
  }

  async handleGatewayRequest(generation, frame) {
    try {
      if (!frame.id || !frame.method) throw new Error("Malformed Durable gateway request");
      if (!this.gatewayRequestHandler) throw new Error("Durable gateway tools are unavailable");
      const data = await this.gatewayRequestHandler(frame.method, frame.params || {});
      if (this.generation !== generation || !generation.peer) return;
      await generation.peer.send(durableFrame("gateway.response", {
        nonce: generation.nonce,
        id: frame.id,
        success: true,
        data,
      }));
    } catch (error) {
      if (this.generation !== generation || !generation.peer) return;
      await generation.peer.send(durableFrame("gateway.response", {
        nonce: generation.nonce,
        id: frame.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })).catch(() => undefined);
    }
  }

  sendRequest(method, params, options) {
    const generation = this.generation;
    if (!generation?.peer || !generation.ready.settled) {
      return Promise.reject(new DurableConnectionLost("Durable host is not connected"));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error(`Durable request queue is full (${this.maxPendingRequests})`));
    }

    const id = `durable_${++this.requestSequence}`;
    return new Promise((resolvePromise, rejectPromise) => {
      let timer;
      const timeoutMs = options.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          rejectPromise(new Error(`Timed out waiting for Durable ${method} after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      generation.peer.send(durableFrame("request", {
        nonce: generation.nonce,
        id,
        method,
        operationId: options.operationId,
        params,
      })).catch((error) => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(new DurableConnectionLost(error.message));
      });
    });
  }

  loseGeneration(generation, error) {
    if (this.generation !== generation) return;
    const failure = error instanceof DurableConnectionLost
      ? error
      : new DurableConnectionLost(error instanceof Error ? error.message : String(error));
    generation.ready.reject(failure);
    generation.peer?.destroy();
    generation.peer = undefined;
    if (generation.expectedExit) {
      this.rejectPending(failure);
      return;
    }
    generation.child?.kill?.("SIGTERM");
    this.restartBarrier = this.waitForChildExit(generation.child);
    this.generation = undefined;
    this.initPromise = undefined;
    this.rejectPending(failure);
  }

  clearGeneration(generation, error) {
    if (!generation || this.generation !== generation) return;
    generation.expectedExit = true;
    generation.peer?.destroy();
    generation.peer = undefined;
    this.generation = undefined;
    this.initPromise = undefined;
    this.rejectPending(error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async stopGeneration(generation) {
    if (!generation) return;
    generation.expectedExit = true;
    generation.peer?.destroy();
    if (generation.child && generation.child.exitCode == null && generation.child.signalCode == null) {
      generation.child.kill("SIGTERM");
      await this.waitForChildExit(generation.child);
    }
    this.clearGeneration(generation, new DurableConnectionLost("Durable host stopped"));
  }

  async waitForChildExit(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    let timer;
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => {
        timer = setTimeout(resolvePromise, HOST_EXIT_GRACE_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => {
        const killTimer = setTimeout(resolvePromise, 1_000);
        killTimer.unref?.();
      }),
    ]);
  }
}

export class DurableConnectionLost extends Error {
  constructor(message) {
    super(message);
    this.name = "DurableConnectionLost";
  }
}

export function sanitizeHostEnv(env, telegramTokenEnv) {
  const sanitized = { ...env };
  delete sanitized.PI_TELEGRAM_BOT_TOKEN;
  delete sanitized.TELEPI_BOT_TOKEN;
  if (telegramTokenEnv) delete sanitized[telegramTokenEnv];
  sanitized.TELEPI_DURABLE_HOST = "1";
  return sanitized;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const state = { settled: false, promise: undefined, resolve: undefined, reject: undefined };
  state.promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  // A readiness rejection may precede the init() waiter during process startup.
  state.promise.catch(() => undefined);
  state.resolve = (value) => {
    if (state.settled) return;
    state.settled = true;
    resolvePromise(value);
  };
  state.reject = (error) => {
    if (state.settled) return;
    state.settled = true;
    rejectPromise(error);
  };
  return state;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

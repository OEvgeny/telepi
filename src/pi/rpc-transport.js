import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BROKER_PROTOCOL_VERSION, MAX_BROKER_RPC_FRAME_BYTES } from "../broker-ipc.js";

const RPC_BRIDGE_PATH = fileURLToPath(new URL("./rpc-bridge.js", import.meta.url));
const RPC_RESPONSE_TIMEOUT_MS = 30_000;
const RPC_START_TIMEOUT_MS = 30_000;
const RPC_STOP_TIMEOUT_MS = 1_000;
const MAX_STDERR_BYTES = 256 * 1024;

export function createPiRpcBroker() {
  const clients = new Map();
  return {
    createClient(options) {
      return new BrokerRpcClient(options, {
        reserve(runId, client) {
          if (clients.has(runId)) throw new Error(`Pi RPC run is already registered: ${runId}`);
          clients.set(runId, client);
        },
        release(runId, client) {
          if (clients.get(runId) === client) clients.delete(runId);
        },
      });
    },
    acceptConnection(frame, peer) {
      if (frame?.type !== "pi_rpc_connect") return false;
      const client = clients.get(frame.runId);
      if (frame.version !== BROKER_PROTOCOL_VERSION || !client) {
        peer.end({
          version: BROKER_PROTOCOL_VERSION,
          type: "pi_rpc_rejected",
          runId: frame?.runId,
          error: !client ? "Unknown Pi RPC run" : `Unsupported broker protocol version: ${frame.version}`,
        });
        return true;
      }
      peer.setMaxFrameBytes(MAX_BROKER_RPC_FRAME_BYTES);
      client.attach(peer);
      return true;
    },
  };
}

export const piRpcBroker = createPiRpcBroker();

class BrokerRpcClient {
  constructor(options, registry) {
    this.options = options;
    this.registry = registry;
    this.runId = randomUUID();
    this.bridge = undefined;
    this.peer = undefined;
    this.eventListeners = [];
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.stderr = "";
    this.exitError = undefined;
    this.started = false;
    this.stopping = false;
    this.ready = deferred();
    this.exited = deferred();
    this.bridgeExited = deferred();
  }

  async start() {
    if (this.started) throw new Error("Client already started");
    this.started = true;
    const socketPath = this.options.env?.TELEPI_BROKER_SOCKET;
    if (!socketPath) throw new Error("TELEPI_BROKER_SOCKET is required for the Pi RPC bridge");
    this.registry.reserve(this.runId, this);

    const args = [
      RPC_BRIDGE_PATH,
      "--socket", socketPath,
      "--run-id", this.runId,
      "--worker", this.options.workerPath,
      "--",
      "--mode", "rpc",
      ...(this.options.args || []),
    ];
    const bridge = spawn(process.execPath, args, {
      cwd: resolve(this.options.cwd),
      env: { ...process.env, ...this.options.env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.bridge = bridge;
    bridge.stderr.on("data", (chunk) => this.appendStderr(chunk.toString("utf8"), false));
    bridge.once("error", (error) => this.fail(new Error(`Pi RPC bridge error: ${error.message}`)));
    bridge.once("exit", (code, signal) => {
      if (!this.exited.settled) {
        this.fail(this.createProcessExitError(code, signal));
        this.exited.resolve({ code, signal });
      }
      this.bridgeExited.resolve({ code, signal });
      this.registry.release(this.runId, this);
    });

    try {
      await withTimeout(this.ready.promise, RPC_START_TIMEOUT_MS, "Timed out waiting for Pi RPC bridge startup");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  attach(peer) {
    if (this.peer) {
      peer.end({
        version: BROKER_PROTOCOL_VERSION,
        type: "pi_rpc_rejected",
        runId: this.runId,
        error: "Pi RPC run is already connected",
      });
      return;
    }
    this.peer = peer;
    void peer.send({
      version: BROKER_PROTOCOL_VERSION,
      type: "pi_rpc_connected",
      runId: this.runId,
    }).then(() => this.readFrames()).catch((error) => this.fail(error));
  }

  async readFrames() {
    try {
      while (true) {
        const frame = await this.peer.read();
        if (frame?.version !== BROKER_PROTOCOL_VERSION || frame?.runId !== this.runId) {
          throw new Error("Received an invalid Pi RPC bridge frame");
        }
        if (frame.type === "pi_rpc_ready") {
          this.ready.resolve();
          continue;
        }
        if (frame.type === "pi_rpc_stderr") {
          this.appendStderr(frame.text, true);
          continue;
        }
        if (frame.type === "pi_rpc_error") {
          throw new Error(frame.error || "Pi RPC bridge failed");
        }
        if (frame.type === "pi_rpc_exit") {
          const error = this.createProcessExitError(frame.code, frame.signal);
          if (!this.stopping) this.fail(error);
          else this.rejectPendingRequests(error);
          this.exited.resolve({ code: frame.code, signal: frame.signal });
          this.peer.end();
          return;
        }
        if (frame.type !== "pi_rpc" || !frame.body || typeof frame.body !== "object") {
          throw new Error(`Unsupported Pi RPC bridge frame: ${frame.type}`);
        }
        this.handleRpcBody(frame.body);
      }
    } catch (error) {
      if (!this.stopping) this.fail(error);
      this.peer?.destroy();
    }
  }

  onEvent(listener) {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index >= 0) this.eventListeners.splice(index, 1);
    };
  }

  getStderr() {
    return this.stderr;
  }

  prompt(message, images) {
    return this.send({ type: "prompt", message, images });
  }

  steer(message, images) {
    return this.send({ type: "steer", message, images });
  }

  async abort() {
    // Pi 0.85's abort waits for the whole session to become idle before it
    // responds. Clear queued steers first so aborting the current model/tool
    // operation cannot immediately continue into older steering work, then
    // report transport acceptance instead of mistaking slow settlement for a
    // failed stop.
    await this.sendAccepted({ type: "clear_queue" });
    await this.sendAccepted({ type: "abort" });
  }

  async stop() {
    if (!this.started) return;
    this.stopping = true;
    if (this.peer && !this.exited.settled) {
      await this.peer.send({
        version: BROKER_PROTOCOL_VERSION,
        type: "pi_rpc_stop",
        runId: this.runId,
      }).catch(() => undefined);
    }
    if (!this.exited.settled) {
      await withTimeout(this.exited.promise, RPC_STOP_TIMEOUT_MS, "").catch(() => {
        this.bridge?.kill("SIGTERM");
      });
    }
    if (!this.exited.settled) {
      await withTimeout(this.exited.promise, RPC_STOP_TIMEOUT_MS, "").catch(() => {
        this.bridge?.kill("SIGKILL");
      });
    }
    if (!this.bridgeExited.settled) {
      await withTimeout(this.bridgeExited.promise, RPC_STOP_TIMEOUT_MS, "").catch(() => {
        this.bridge?.kill("SIGKILL");
      });
    }
    this.peer?.destroy();
    this.registry.release(this.runId, this);
    this.started = false;
  }

  handleRpcBody(body) {
    if (body.type === "response" && body.id && this.pendingRequests.has(body.id)) {
      const pending = this.pendingRequests.get(body.id);
      this.pendingRequests.delete(body.id);
      pending.resolve(body);
      return;
    }
    for (const listener of this.eventListeners) listener(body);
  }

  send(command) {
    if (!this.started || !this.peer) return Promise.reject(new Error("Client not started"));
    if (this.exitError) return Promise.reject(this.exitError);
    const id = `req_${++this.requestId}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectPromise(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
      }, RPC_RESPONSE_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolvePromise(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          rejectPromise(error);
        },
      });
      this.sendFrame(command, id).catch((error) => {
        const pending = this.pendingRequests.get(id);
        this.pendingRequests.delete(id);
        pending?.reject(error);
      });
    });
  }

  async sendAccepted(command) {
    if (!this.started || !this.peer) throw new Error("Client not started");
    if (this.exitError) throw this.exitError;
    const id = `req_${++this.requestId}`;
    // Consume a later correlated response without making transport acceptance
    // wait for command completion. stop() rejects this observer harmlessly if
    // the worker settles and is closed before Pi writes the response.
    this.pendingRequests.set(id, {
      resolve: () => undefined,
      reject: () => undefined,
    });
    try {
      await this.sendFrame(command, id);
    } catch (error) {
      this.pendingRequests.delete(id);
      throw error;
    }
  }

  sendFrame(command, id) {
    return this.peer.send({
      version: BROKER_PROTOCOL_VERSION,
      type: "pi_rpc",
      runId: this.runId,
      body: { ...command, id },
    });
  }

  appendStderr(text, echo) {
    const value = String(text || "");
    this.stderr = `${this.stderr}${value}`.slice(-MAX_STDERR_BYTES);
    if (echo && value) process.stderr.write(value);
  }

  createProcessExitError(code, signal) {
    return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
  }

  rejectPendingRequests(error) {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  fail(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.exitError ||= failure;
    this.ready.reject(this.exitError);
    this.rejectPendingRequests(this.exitError);
  }
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const state = {
    settled: false,
    promise: undefined,
    resolve: undefined,
    reject: undefined,
  };
  state.promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
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
      timer = setTimeout(() => rejectPromise(new Error(message || "Timed out")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

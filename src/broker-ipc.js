import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, resolve } from "node:path";

export const BROKER_PROTOCOL_VERSION = 1;
export const DEFAULT_BROKER_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_BROKER_FRAME_BYTES = 1024 * 1024;

export function resolveBrokerSocketPath(config, env = process.env) {
  const configured = env.TELEPI_BROKER_SOCKET?.trim();
  return resolve(configured || resolve(config.project.cache_dir, "broker.sock"));
}

export async function startBrokerIpcServer({
  socketPath,
  onRequest,
  maxFrameBytes = MAX_BROKER_FRAME_BYTES,
}) {
  if (!socketPath) throw new Error("broker socket path is required");
  if (typeof onRequest !== "function") throw new Error("broker request handler is required");

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);

  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleServerConnection(socket, onRequest, maxFrameBytes);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
  await chmod(socketPath, 0o600);

  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
      await rm(socketPath, { force: true });
    },
  };
}

export async function requestBroker(socketPath, request, {
  signal,
  timeoutMs = DEFAULT_BROKER_REQUEST_TIMEOUT_MS,
  maxFrameBytes = MAX_BROKER_FRAME_BYTES,
} = {}) {
  if (!socketPath) throw new Error("Telepi broker socket path is not configured");
  signal?.throwIfAborted();

  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("Broker request cancelled"));
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for Telepi broker after ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxFrameBytes) {
        finish(new Error(`Telepi broker response exceeds ${maxFrameBytes} bytes`));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;

      let response;
      try {
        response = JSON.parse(buffer.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
      } catch (error) {
        finish(new Error(`Invalid response from Telepi broker: ${error.message}`));
        return;
      }
      if (response?.id !== request.id) {
        finish(new Error(`Telepi broker response id mismatch: expected ${request.id}, received ${response?.id || "none"}`));
        return;
      }
      if (!response.success) {
        finish(new Error(response?.error || "Telepi broker rejected the request"));
        return;
      }
      finish(undefined, response.data);
    });
    socket.once("error", (error) => {
      const unavailable = error?.code === "ENOENT" || error?.code === "ECONNREFUSED";
      finish(unavailable
        ? new Error(`Telepi broker is unavailable at ${socketPath}`)
        : error);
    });
    socket.once("end", () => {
      if (!settled) finish(new Error("Telepi broker closed the connection without a response"));
    });
  });
}

function handleServerConnection(socket, onRequest, maxFrameBytes) {
  let buffer = Buffer.alloc(0);
  let handled = false;
  socket.setTimeout(DEFAULT_BROKER_REQUEST_TIMEOUT_MS, () => socket.destroy());

  const respond = (response) => {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}\n`);
  };

  socket.on("data", (chunk) => {
    if (handled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxFrameBytes) {
      handled = true;
      respond({ type: "response", success: false, error: `Broker request exceeds ${maxFrameBytes} bytes` });
      return;
    }

    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    handled = true;
    const trailing = buffer.subarray(newline + 1).toString("utf8").trim();
    if (trailing) {
      respond({ type: "response", success: false, error: "Broker accepts one request per connection" });
      return;
    }

    let request;
    try {
      request = JSON.parse(buffer.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
    } catch (error) {
      respond({ type: "response", success: false, error: `Invalid broker request JSON: ${error.message}` });
      return;
    }

    Promise.resolve(onRequest(request))
      .then((data) => respond({ id: request?.id, type: "response", success: true, data }))
      .catch((error) => respond({
        id: request?.id,
        type: "response",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
  });
}

async function removeStaleSocket(socketPath) {
  const state = await probeSocket(socketPath);
  if (state === "active") throw new Error(`Telepi broker socket is already active at ${socketPath}`);
  if (state === "stale") await rm(socketPath, { force: true });
}

function probeSocket(socketPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timeout = setTimeout(() => finish("active"), 250);
    socket.once("connect", () => finish("active"));
    socket.once("error", (error) => {
      if (error?.code === "ENOENT") finish("absent");
      else if (error?.code === "ECONNREFUSED") finish("stale");
      else finish(undefined, error);
    });
  });
}

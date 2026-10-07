import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, resolve } from "node:path";

export const BROKER_PROTOCOL_VERSION = 1;
export const DEFAULT_BROKER_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_BROKER_FRAME_BYTES = 1024 * 1024;
export const MAX_BROKER_RPC_FRAME_BYTES = 64 * 1024 * 1024;

export function resolveBrokerSocketPath(config, env = process.env) {
  const configured = env.TELEPI_BROKER_SOCKET?.trim();
  return resolve(configured || resolve(config.project.cache_dir, "broker.sock"));
}

export async function startBrokerIpcServer({
  socketPath,
  onRequest,
  onConnection,
  maxFrameBytes = MAX_BROKER_FRAME_BYTES,
  initialFrameTimeoutMs = DEFAULT_BROKER_REQUEST_TIMEOUT_MS,
}) {
  if (!socketPath) throw new Error("broker socket path is required");
  if (typeof onRequest !== "function") throw new Error("broker request handler is required");

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);

  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleServerConnection(socket, { onRequest, onConnection, maxFrameBytes, initialFrameTimeoutMs });
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
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
          finish(new Error(`Timed out waiting for Telepi broker after ${timeoutMs}ms`));
        }, timeoutMs)
      : undefined;

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

export function connectBrokerPeer(socketPath, {
  maxFrameBytes = MAX_BROKER_FRAME_BYTES,
} = {}) {
  if (!socketPath) throw new Error("Telepi broker socket path is not configured");
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    const onError = (error) => {
      socket.destroy();
      const unavailable = error?.code === "ENOENT" || error?.code === "ECONNREFUSED";
      rejectPromise(unavailable
        ? new Error(`Telepi broker is unavailable at ${socketPath}`)
        : error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolvePromise(createJsonlPeer(socket, { maxFrameBytes }));
    });
  });
}

export function createJsonlPeer(socket, {
  maxFrameBytes = MAX_BROKER_FRAME_BYTES,
} = {}) {
  let frameLimit = maxFrameBytes;
  let buffer = Buffer.alloc(0);
  let terminalError;
  const frames = [];
  const readers = [];

  const rejectReaders = (error) => {
    while (readers.length) readers.shift().reject(error);
  };
  const fail = (error) => {
    if (terminalError) return;
    terminalError = error instanceof Error ? error : new Error(String(error));
    rejectReaders(terminalError);
  };
  const deliver = (frame) => {
    const reader = readers.shift();
    if (reader) reader.resolve(frame);
    else frames.push(frame);
  };

  socket.on("data", (chunk) => {
    if (terminalError) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > frameLimit) {
        fail(new Error(`Telepi broker frame exceeds ${frameLimit} bytes`));
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(newline + 1);
      try {
        deliver(JSON.parse(line));
      } catch (error) {
        fail(new Error(`Invalid Telepi broker frame JSON: ${error.message}`));
        return;
      }
    }
    if (buffer.length > frameLimit) {
      fail(new Error(`Telepi broker frame exceeds ${frameLimit} bytes`));
    }
  });
  socket.once("error", fail);
  socket.once("end", () => fail(new Error("Telepi broker connection ended")));
  socket.once("close", () => fail(new Error("Telepi broker connection closed")));

  return {
    get queuedFrameCount() {
      return frames.length;
    },
    setMaxFrameBytes(value) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid Telepi broker frame limit");
      frameLimit = value;
    },
    read() {
      if (frames.length) return Promise.resolve(frames.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolvePromise, rejectPromise) => {
        readers.push({ resolve: resolvePromise, reject: rejectPromise });
      });
    },
    async send(frame) {
      if (terminalError || socket.destroyed || !socket.writable) {
        throw terminalError || new Error("Telepi broker connection is not writable");
      }
      const line = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(line) > frameLimit + 1) {
        throw new Error(`Telepi broker frame exceeds ${frameLimit} bytes`);
      }
      if (socket.write(line)) return;
      await new Promise((resolvePromise, rejectPromise) => {
        const onDrain = () => {
          cleanup();
          resolvePromise();
        };
        const onError = (error) => {
          cleanup();
          rejectPromise(error);
        };
        const cleanup = () => {
          socket.off("drain", onDrain);
          socket.off("error", onError);
        };
        socket.once("drain", onDrain);
        socket.once("error", onError);
      });
    },
    end(frame) {
      if (socket.destroyed) return;
      if (frame === undefined) socket.end();
      else socket.end(`${JSON.stringify(frame)}\n`);
    },
    destroy(error) {
      socket.destroy(error);
    },
  };
}

async function handleServerConnection(socket, { onRequest, onConnection, maxFrameBytes, initialFrameTimeoutMs }) {
  socket.setTimeout(initialFrameTimeoutMs, () => socket.destroy());
  const peer = createJsonlPeer(socket, { maxFrameBytes });
  let request;
  try {
    request = await peer.read();
    // The timeout protects against clients that connect without sending a
    // frame. Once a valid frame arrives, the operation itself may legitimately
    // be long-lived (notably a drain waiting for Durable to become idle).
    socket.setTimeout(0);
    if (onConnection && await onConnection(request, peer)) {
      return;
    }
    const data = await onRequest(request);
    if (peer.queuedFrameCount) {
      throw new Error("Broker accepts one request per connection");
    }
    peer.end({ id: request?.id, type: "response", success: true, data });
  } catch (error) {
    peer.end({
      id: request?.id,
      type: "response",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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

#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { connectBrokerPeer } from "../broker-ipc.js";
import { assertDurablePackageVersions } from "./packages.js";
import { acquireDurableStorageLock } from "./storage-lock.js";
import {
  MAX_DURABLE_FRAME_BYTES,
  assertDurableFrame,
  durableFrame,
} from "./protocol.js";
import { openDurableHost } from "./runtime.js";

const args = parseArgs(process.argv.slice(2));
let ownership;
let runtime;
let peer;
let closing = false;
let exitCode = 0;
const handlers = new Set();
const operations = new Map();
const gatewayPending = new Map();
let sendQueue = Promise.resolve();

try {
  assertDurablePackageVersions();
  ownership = await acquireDurableStorageLock(args.storageDir, { nonce: args.nonce });
  runtime = await openDurableHost({
    storageDir: args.storageDir,
    infrastructureAgentDir: args.infrastructureAgentDir,
    projectRoot: args.projectRoot,
    onReport: (report) => console.error(`durable report ${report?.kind || "unknown"}: ${report?.error instanceof Error ? report.error.stack || report.error.message : report?.error}`),
    onSshLog: (text) => console.error(`durable ssh: ${String(text).trim()}`),
    gatewayRequest,
  });
  peer = await connectBrokerPeer(args.socket, { maxFrameBytes: MAX_DURABLE_FRAME_BYTES });
  await peer.send(durableFrame("host.connect", { nonce: args.nonce, pid: process.pid }));
  const accepted = assertDurableFrame(await peer.read());
  if (accepted.type !== "host.accepted" || accepted.nonce !== args.nonce) {
    throw new Error(accepted.error || "Durable gateway rejected the host connection");
  }
  await send(durableFrame("host.ready", {
    nonce: args.nonce,
    pid: process.pid,
    databasePath: runtime.databasePath,
  }));

  installSignalHandlers();
  while (!closing) {
    const frame = assertDurableFrame(await peer.read());
    if (frame.nonce !== args.nonce) throw new Error("Durable gateway frame generation mismatch");
    if (frame.type === "gateway.response") {
      const pending = gatewayPending.get(frame.id);
      if (!pending) continue;
      gatewayPending.delete(frame.id);
      if (frame.success) pending.resolve(frame.data);
      else pending.reject(new Error(frame.error || "Durable gateway request failed"));
      continue;
    }
    if (frame.type !== "request") throw new Error(`Unsupported Durable gateway frame: ${frame.type}`);
    if (!frame.id || !frame.method) throw new Error("Malformed Durable request");
    const handler = handleRequest(frame).finally(() => handlers.delete(handler));
    handlers.add(handler);
  }
  await Promise.allSettled([...handlers]);
} catch (error) {
  if (!closing) {
    exitCode = 1;
    console.error(error instanceof Error ? error.stack || error.message : String(error));
  }
} finally {
  closing = true;
  await boundedClose(runtime, false);
  await ownership?.release().catch((error) => console.error(`durable lock release failed: ${error.message}`));
  peer?.end();
}

process.exit(exitCode);

async function handleRequest(frame) {
  let operation;
  try {
    operation = executeOperation(frame);
    const data = await operation;
    await send(durableFrame("response", {
      nonce: args.nonce,
      id: frame.id,
      success: true,
      data,
    }));
    if (frame.method === "host.shutdown") {
      closing = true;
      peer.end();
    }
  } catch (error) {
    await send(durableFrame("response", {
      nonce: args.nonce,
      id: frame.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })).catch(() => undefined);
  }
}

function executeOperation(frame) {
  const operationId = String(frame.operationId || "").trim();
  const signature = JSON.stringify({ method: frame.method, params: frame.params || {} });
  if (operationId) {
    const existing = operations.get(operationId);
    if (existing) {
      if (existing.signature !== signature) {
        return Promise.reject(new Error(`Durable operation id was reused with different content: ${operationId}`));
      }
      return existing.promise;
    }
  }

  const promise = dispatch(frame.method, frame.params || {});
  if (operationId) {
    operations.set(operationId, { signature, promise });
    while (operations.size > 4096) operations.delete(operations.keys().next().value);
  }
  return promise;
}

async function dispatch(method, params) {
  switch (method) {
    case "endpoint.ensure": {
      const result = await runtime.ensureEndpoint(params);
      await runtime.watchEndpoint(params.endpointKey, (events) => send(durableFrame("event", {
        nonce: args.nonce,
        event: "conversation.events",
        data: { endpointKey: params.endpointKey, events },
      })));
      return result;
    }
    case "submission.submit":
      return runtime.submit(params.endpointKey, params.submission || {});
    case "submission.wait":
      return runtime.waitSubmission(params.endpointKey, params.submissionId);
    case "conversation.abort":
      return runtime.abort(params.endpointKey);
    case "conversation.compact":
      return runtime.compact(params.endpointKey, params.instructions);
    case "host.inspect":
      return runtime.inspect();
    case "host.shutdown":
      await runtime.close({ waitForIdle: true });
      return { closed: true };
    default:
      throw new Error(`Unsupported Durable host method: ${method}`);
  }
}

function gatewayRequest(method, params = {}, requestContext) {
  if (closing || !peer) return Promise.reject(new Error("Durable gateway connection is closed"));
  const id = `host_${randomUUID()}`;
  return new Promise((resolvePromise, rejectPromise) => {
    gatewayPending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    send(durableFrame("gateway.request", {
      nonce: args.nonce,
      id,
      method,
      params,
    })).catch((error) => {
      gatewayPending.delete(id);
      rejectPromise(error);
    });
    requestContext?.signal?.addEventListener?.("abort", () => {
      if (!gatewayPending.delete(id)) return;
      rejectPromise(new Error("Durable gateway request was aborted"));
    }, { once: true });
  });
}

function send(frame) {
  const sending = sendQueue.then(() => peer.send(frame));
  sendQueue = sending.catch(() => undefined);
  return sending;
}

function installSignalHandlers() {
  const stop = (signal) => {
    if (closing) return;
    closing = true;
    console.error(`durable host received ${signal}; preserving committed work`);
    peer?.destroy();
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}

async function boundedClose(opened, waitForIdle) {
  if (!opened) return;
  await Promise.race([
    opened.close({ waitForIdle }).catch((error) => {
      console.error(`durable host close failed: ${error.message}`);
    }),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--socket", "--nonce", "--storage-dir", "--project-root", "--infrastructure-agent-dir"].includes(flag)) {
      throw new Error(`Unknown Durable host option: ${flag}`);
    }
    values[flag.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = argv[++index];
  }
  for (const key of ["socket", "nonce", "storageDir", "projectRoot", "infrastructureAgentDir"]) {
    if (!values[key]) throw new Error(`Missing Durable host option: ${key}`);
  }
  return values;
}

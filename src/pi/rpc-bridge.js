#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BROKER_PROTOCOL_VERSION,
  MAX_BROKER_RPC_FRAME_BYTES,
  connectBrokerPeer,
} from "../broker-ipc.js";

export function parseRpcBridgeArgs(argv) {
  const separator = argv.indexOf("--");
  const ownArgs = separator < 0 ? argv : argv.slice(0, separator);
  const workerArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const values = {};
  const known = new Set(["--socket", "--run-id", "--worker"]);
  for (let index = 0; index < ownArgs.length; index += 2) {
    const name = ownArgs[index];
    if (!known.has(name)) throw new Error(`Unknown RPC bridge option: ${name}`);
    if (index + 1 >= ownArgs.length) throw new Error(`Missing value for RPC bridge option: ${name}`);
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate RPC bridge option: ${name}`);
    values[name] = ownArgs[index + 1];
  }
  for (const name of known) {
    if (!values[name]) throw new Error(`Missing RPC bridge option: ${name}`);
  }
  return {
    socketPath: resolve(values["--socket"]),
    runId: values["--run-id"],
    workerPath: resolve(values["--worker"]),
    workerArgs,
  };
}

export async function runRpcBridge(argv = process.argv.slice(2)) {
  const args = parseRpcBridgeArgs(argv);
  const peer = await connectBrokerPeer(args.socketPath, { maxFrameBytes: MAX_BROKER_RPC_FRAME_BYTES });
  await peer.send({
    version: BROKER_PROTOCOL_VERSION,
    type: "pi_rpc_connect",
    runId: args.runId,
  });
  const connected = await peer.read();
  if (connected?.type !== "pi_rpc_connected" || connected?.runId !== args.runId) {
    throw new Error(connected?.error || `RPC bridge connection was rejected for run ${args.runId}`);
  }

  const worker = spawn(process.execPath, [args.workerPath, ...args.workerArgs], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stopping = false;
  let stdoutBuffer = Buffer.alloc(0);
  let outbound = Promise.resolve();
  const queueFrame = (frame) => {
    outbound = outbound.then(() => peer.send({
      version: BROKER_PROTOCOL_VERSION,
      runId: args.runId,
      ...frame,
    }));
    outbound.catch(() => terminate("SIGTERM"));
    return outbound;
  };
  const terminate = (signal = "SIGTERM") => {
    if (worker.exitCode !== null || worker.signalCode) return;
    stopping = true;
    worker.kill(signal);
  };

  worker.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (true) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > MAX_BROKER_RPC_FRAME_BYTES) {
        void queueFrame({ type: "pi_rpc_error", error: `Pi RPC frame exceeds ${MAX_BROKER_RPC_FRAME_BYTES} bytes` });
        terminate();
        return;
      }
      const line = stdoutBuffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      try {
        void queueFrame({ type: "pi_rpc", body: JSON.parse(line) });
      } catch (error) {
        void queueFrame({ type: "pi_rpc_error", error: `Invalid Pi RPC output: ${error.message}` });
        terminate();
        return;
      }
    }
    if (stdoutBuffer.length > MAX_BROKER_RPC_FRAME_BYTES) {
      void queueFrame({ type: "pi_rpc_error", error: `Pi RPC frame exceeds ${MAX_BROKER_RPC_FRAME_BYTES} bytes` });
      terminate();
    }
  });
  worker.stderr.on("data", (chunk) => {
    void queueFrame({ type: "pi_rpc_stderr", text: chunk.toString("utf8") });
  });
  worker.stdin.on("error", () => undefined);

  const workerClosed = new Promise((resolvePromise) => {
    worker.once("error", (error) => {
      void queueFrame({ type: "pi_rpc_error", error: `Pi worker process error: ${error.message}` });
    });
    worker.once("close", (code, signal) => {
      void outbound
        .catch(() => undefined)
        .then(() => queueFrame({ type: "pi_rpc_exit", code, signal }))
        .catch(() => undefined)
        .finally(resolvePromise);
    });
  });

  process.once("SIGTERM", () => terminate("SIGTERM"));
  process.once("SIGINT", () => terminate("SIGTERM"));

  await peer.send({
    version: BROKER_PROTOCOL_VERSION,
    type: "pi_rpc_ready",
    runId: args.runId,
  });

  const inbound = (async () => {
    while (worker.exitCode === null && !worker.signalCode) {
      const frame = await peer.read();
      if (frame?.runId !== args.runId) throw new Error("RPC bridge received a frame for another run");
      if (frame.type === "pi_rpc_stop") {
        terminate("SIGTERM");
        return;
      }
      if (frame.type !== "pi_rpc" || !frame.body || typeof frame.body !== "object") {
        throw new Error(`RPC bridge received an unsupported frame: ${frame?.type || "unknown"}`);
      }
      const line = `${JSON.stringify(frame.body)}\n`;
      if (!worker.stdin.write(line)) {
        await new Promise((resolvePromise, rejectPromise) => {
          worker.stdin.once("drain", resolvePromise);
          worker.stdin.once("error", rejectPromise);
        });
      }
    }
  })().catch((error) => {
    if (!stopping) {
      console.error(error.stack || error.message);
      terminate("SIGTERM");
    }
  });

  await workerClosed;
  await inbound;
  peer.end();
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runRpcBridge().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

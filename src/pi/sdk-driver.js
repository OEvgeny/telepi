import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTopicSession } from "../config.js";
import { startRpcRun } from "./rpc-run.js";
import { piRpcBroker } from "./rpc-transport.js";
import { buildTopicRunSpec, formatTopicMessage } from "./topic-spec.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));

// Gateway-side driver for the Telepi-aware SDK worker.
export async function startPiForTopic(config, topic, envelope, options = {}) {
  const spec = buildSdkRunSpec(config, topic, envelope, options);
  return startRpcRun(spec.args, {
    workerPath: spec.workerPath,
    cwd: spec.cwd,
    idleTimeoutMs: spec.idleTimeoutMs,
    hardTimeoutMs: spec.hardTimeoutMs,
    onText: options.onText,
    onEvent: options.onEvent,
    env: spec.env,
    initialMessage: spec.initialMessage,
    sessionDir: config.project.sessions_dir,
    sessionId: spec.sessionId,
    steerMessage: (steerEnvelope) => formatTopicMessage(config, topic, steerEnvelope),
    createRpcClient: (clientOptions) => piRpcBroker.createClient(clientOptions),
  });
}

export function acceptSdkRpcConnection(frame, peer) {
  return piRpcBroker.acceptConnection(frame, peer);
}

export function buildSdkRunSpec(config, topic, envelope, options = {}) {
  if (options.session || options.fork || options.name) {
    throw new Error("The SDK worker driver only opens the topic's configured session");
  }
  if (!config._path) throw new Error("The SDK worker requires the loaded Telepi config path");

  // Runtime construction itself happens only in worker.js.
  const base = buildTopicRunSpec(config, topic, envelope, options);
  const configuredSessionId = resolveTopicSession(config, topic, { agent: base.agent }).id;
  if (base.sessionId !== configuredSessionId) {
    throw new Error(`The SDK worker session override does not match the configured topic: ${base.sessionId}`);
  }

  return {
    ...base,
    workerPath: WORKER_PATH,
    args: [
      "--config", resolve(config._path),
      "--chat-id", String(topic.chat_id),
      "--topic-id", topic.topic_id == null ? "" : String(topic.topic_id),
      "--expected-topic-name", String(topic.name || ""),
      "--expected-agent", String(topic.agent),
      "--expected-session-id", configuredSessionId,
    ],
  };
}

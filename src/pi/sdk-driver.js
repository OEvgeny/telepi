import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPiRunSpec, formatTopicMessage, startRpcProcess } from "./cli-driver.js";
import { piRpcBroker } from "./rpc-transport.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));

// Gateway-side driver for the Telepi-aware SDK worker. The stock CLI driver is
// retained during rollout, while both paths share the proven RPC lifecycle.
export async function runPiForTopic(config, topic, envelope, options = {}) {
  const run = await startPiForTopic(config, topic, envelope, options);
  return run.promise;
}

export async function startPiForTopic(config, topic, envelope, options = {}) {
  const spec = buildSdkRunSpec(config, topic, envelope, options);
  return startRpcProcess(spec.args, {
    cliPath: spec.cliPath,
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

  // Reuse the legacy driver's transport formatting and environment while the
  // two drivers coexist. Runtime construction itself happens only in worker.js.
  const base = buildPiRunSpec(config, topic, envelope, options);
  const configuredSessionId = String(topic.session_id || base.agent.session_id || `${topic.agent}-${topic.topic_id}`);
  if (base.sessionId !== configuredSessionId) {
    throw new Error(`The SDK worker session override does not match the configured topic: ${base.sessionId}`);
  }

  return {
    ...base,
    cliPath: WORKER_PATH,
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

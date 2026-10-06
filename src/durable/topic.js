import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  getAgent,
  resolvePath,
  resolveTopicModel,
  resolveTopicSession,
} from "../config.js";
import { formatTopicMessage, topicMessageDeliveryId } from "../pi/topic-spec.js";

export const TOPIC_BACKEND_PI = "pi";
export const TOPIC_BACKEND_DURABLE = "durable";
export const TOPIC_BACKENDS = new Set([TOPIC_BACKEND_PI, TOPIC_BACKEND_DURABLE]);

export function resolveTopicBackend(topic) {
  return topic?.backend || TOPIC_BACKEND_PI;
}

export function formatBackendSwitchNotice(backend) {
  return backend === TOPIC_BACKEND_DURABLE
    ? "Backend: Durable. Pi history preserved."
    : "Backend: Pi. Durable history preserved.";
}

export function formatLocationSwitchNotice(type) {
  return `Location: ${type === "ssh" ? "SSH" : "local"}. Fresh context; previous history preserved.`;
}

export function isDurableTopic(topic) {
  return resolveTopicBackend(topic) === TOPIC_BACKEND_DURABLE;
}

export function hasEnabledDurableTopics(config) {
  return (config.topics || []).some((topic) => topic.enabled !== false && isDurableTopic(topic));
}

export function resolveInfrastructureAgentDir(env = process.env) {
  return resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

export function durableEndpointKey(topic) {
  const base = `telegram:${String(topic.chat_id)}:${topic.topic_id == null ? "root" : String(topic.topic_id)}`;
  const generation = durableEndpointGeneration(topic);
  return generation > 0 ? `${base}:g${generation}` : base;
}

export function rotateDurableEndpoint(topic) {
  topic.durable_endpoint_generation = durableEndpointGeneration(topic) + 1;
  return topic.durable_endpoint_generation;
}

function durableEndpointGeneration(topic) {
  const generation = Number(topic.durable_endpoint_generation || 0);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

export function buildDurableEndpointSpec(config, topic, options = {}) {
  const agent = getAgent(config, topic.agent);
  const session = resolveTopicSession(config, topic, { agent });
  const modelSpec = resolveTopicModel(config, topic, agent);
  if (!modelSpec) throw new Error(`Durable topic ${topic.name} has no configured model`);
  const infrastructureAgentDir = options.infrastructureAgentDir || resolveInfrastructureAgentDir();
  const agentDir = session.location ? session.entityDir : infrastructureAgentDir;
  return {
    endpointKey: durableEndpointKey(topic),
    agentId: topic.agent,
    agentDir,
    cwd: session.cwd,
    location: session.location?.type === "ssh" ? session.location : { type: "local" },
    chatId: String(topic.chat_id),
    topicId: topic.topic_id == null ? null : String(topic.topic_id),
    topicName: topic.name,
    modelSpec,
    legacySessionId: session.id,
    skillPaths: (agent.skills || []).map((path) => resolvePath(config.project.root, path)),
    systemPrompt: agent.system_prompt ? String(agent.system_prompt) : null,
  };
}

export function buildDurableSubmission(config, topic, envelope, options = {}) {
  const deliveryId = topicMessageDeliveryId(envelope)
    || String(envelope.updateId || envelope.messageId || "").trim();
  if (!deliveryId) throw new Error(`Durable submission for ${topic.name} has no stable message id`);
  const source = envelope.transport === "telepi" ? "telepi" : "telegram";
  return {
    requestId: `${source}:${String(topic.chat_id)}:${topic.topic_id == null ? "root" : String(topic.topic_id)}:${deliveryId}`,
    content: formatTopicMessage(config, topic, envelope),
    whenBusy: options.whenBusy || "followUp",
  };
}

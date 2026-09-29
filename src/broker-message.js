import { BROKER_PROTOCOL_VERSION } from "./broker-ipc.js";

const MAX_MESSAGE_TEXT_LENGTH = 256 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_METADATA_LENGTH = 512;

export function normalizeBrokerSubmitRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Broker request must be an object");
  }
  if (value.version !== BROKER_PROTOCOL_VERSION) {
    throw new Error(`Unsupported broker protocol version: ${value.version ?? "missing"}`);
  }
  if (value.type !== "submit") throw new Error(`Unsupported broker request type: ${value.type || "missing"}`);

  const id = requiredString(value.id, "id", MAX_ID_LENGTH);
  const text = requiredString(value.message?.text, "message.text", MAX_MESSAGE_TEXT_LENGTH, { trim: false });
  if (!text.trim()) throw new Error("message.text must not be empty");

  const target = normalizeTarget(value.target);
  const kind = optionalString(value.origin?.kind, "origin.kind", 32) || "cli";
  if (!new Set(["agent", "cli", "system"]).has(kind)) {
    throw new Error(`Unsupported broker origin kind: ${kind}`);
  }
  const origin = {
    kind,
    name: optionalString(value.origin?.name, "origin.name", MAX_METADATA_LENGTH) || kind,
    agentId: optionalString(value.origin?.agentId, "origin.agentId", MAX_METADATA_LENGTH),
    topicName: optionalString(value.origin?.topicName, "origin.topicName", MAX_METADATA_LENGTH),
    source: optionalString(value.origin?.source, "origin.source", MAX_METADATA_LENGTH),
  };

  return {
    version: BROKER_PROTOCOL_VERSION,
    type: "submit",
    id,
    target,
    message: { text },
    origin,
    options: { echo: value.options?.echo === true },
  };
}

export function resolveBrokerTarget(config, target) {
  if (target.topic) {
    const topic = config.topics.find((entry) => entry.name === target.topic);
    if (!topic) throw new Error(`Unknown topic mapping: ${target.topic}`);
    if (topic.enabled === false) throw new Error(`Topic is disabled: ${topic.name}`);
    return topic;
  }

  if (target.agent) return resolveUniqueAgentTopic(config, target.agent);

  const topic = config.topics.find((entry) => entry.name === target.name && entry.enabled !== false);
  if (topic) return topic;
  return resolveUniqueAgentTopic(config, target.name);
}

export function createBrokerEchoDisplay(config, submit) {
  const origin = submit.origin || {};
  let header = "📨 Posted message";
  if (origin.kind === "agent") {
    const agentName = config.agents?.[origin.agentId]?.name || origin.name || origin.agentId;
    if (agentName) header = `📨 Message from ${agentName}`;
  }
  return {
    text: `${header}\n\n${submit.message.text}`,
    blockquoteHeader: header,
  };
}

export function createBrokerEnvelope(topic, submit, { telegramMessageId = "" } = {}) {
  const origin = submit.origin;
  const sourceIdentity = origin.agentId || origin.topicName || origin.name;
  return {
    updateId: `broker:${submit.id}`,
    brokerMessageId: submit.id,
    chatId: String(topic.chat_id),
    topicId: topic.topic_id == null ? null : String(topic.topic_id),
    userId: null,
    userName: origin.name,
    messageId: telegramMessageId ? String(telegramMessageId) : "",
    text: submit.message.text,
    source: origin.source || `broker:${origin.kind}:${sourceIdentity}`,
    transport: "telepi",
    origin,
    attachments: [],
    queueAck: false,
  };
}

function normalizeTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("target must be an object");
  }
  const topic = optionalString(value.topic, "target.topic", MAX_METADATA_LENGTH);
  const agent = optionalString(value.agent, "target.agent", MAX_METADATA_LENGTH);
  const name = optionalString(value.name, "target.name", MAX_METADATA_LENGTH);
  const count = [topic, agent, name].filter(Boolean).length;
  if (count !== 1) throw new Error("target must contain exactly one of topic, agent, or name");
  return { topic, agent, name };
}

function resolveUniqueAgentTopic(config, agentId) {
  const matches = config.topics.filter((topic) => topic.agent === agentId && topic.enabled !== false);
  if (!matches.length) throw new Error(`No enabled topic mapping for agent or topic: ${agentId}`);
  if (matches.length > 1) {
    throw new Error(
      `Agent ${agentId} has multiple enabled topics; address one by topic name: ${matches.map((topic) => topic.name).join(", ")}`,
    );
  }
  return matches[0];
}

function requiredString(value, label, maxLength, options) {
  const normalized = optionalString(value, label, maxLength, options);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function optionalString(value, label, maxLength, { trim = true } = {}) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return normalized || undefined;
}

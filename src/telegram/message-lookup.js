import { findTopicByName } from "../config.js";

export function lookupTelegramMessage(config, telegram, request) {
  const topicName = String(request?.topicName || "").trim();
  const agentId = String(request?.agentId || "").trim();
  const chatId = String(request?.chatId || "").trim();
  const topicId = nullable(request?.topicId);
  const messageId = normalizeMessageId(request?.messageId);
  const topic = findTopicByName(config, topicName);

  if (!topic || topic.enabled === false) throw new Error("Current Telepi topic is not available");
  if (String(topic.agent) !== agentId
    || String(topic.chat_id) !== chatId
    || nullable(topic.topic_id) !== topicId) {
    throw new Error("Telegram message lookup is limited to the current topic");
  }

  const record = telegram.findTelegramMessageRecord(chatId, messageId);
  if (!record || nullable(record.topic_id) !== topicId) {
    return {
      found: false,
      messageId,
      limitation: "Telegram's Bot API cannot fetch an arbitrary message by id; Telepi can return only messages in its local recent-message archive.",
    };
  }

  return {
    found: true,
    messageId,
    text: record.text || "",
    textTruncated: record.text_truncated === true,
    direction: record.direction || "unknown",
    userName: record.user_name || null,
    agentId: record.agent_id || null,
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    createdAt: record.created_at || null,
  };
}

function normalizeMessageId(value) {
  const id = String(value || "").trim();
  if (!/^\d+$/.test(id) || id === "0") throw new Error("Telegram message id must be a positive integer");
  return id;
}

function nullable(value) {
  return value == null || value === "" ? null : String(value);
}

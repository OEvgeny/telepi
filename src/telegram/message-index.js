import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_RECORDS = 12_000;
const KEPT_RECORDS = 8_000;
const MAX_TEXT_CHARS = 16_384;
const MAX_ATTACHMENTS = 10;

export class TelegramMessageIndex {
  constructor(path) {
    this.path = path;
    this.records = new Map();
  }

  init() {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) return;
    let lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_RECORDS) {
      lines = lines.slice(-KEPT_RECORDS);
      writeFileSync(this.path, `${lines.join("\n")}\n`);
    }
    for (const line of lines) {
      try {
        const record = normalizeRecord(JSON.parse(line));
        if (record) this.records.set(recordKey(record.chat_id, record.message_id), record);
      } catch {
        // A malformed historical row does not invalidate the rest of the index.
      }
    }
  }

  record(input) {
    const record = normalizeRecord(input);
    if (!record) return null;
    this.records.set(recordKey(record.chat_id, record.message_id), record);
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    return record;
  }

  find(chatId, messageId) {
    return this.records.get(recordKey(chatId, messageId)) || null;
  }
}

function normalizeRecord(input) {
  if (!input || typeof input !== "object") return null;
  const chatId = String(input.chat_id ?? input.chatId ?? "").trim();
  const messageId = String(input.message_id ?? input.messageId ?? "").trim();
  if (!chatId || !messageId) return null;
  const originalText = String(input.text || "");
  const text = originalText.slice(0, MAX_TEXT_CHARS);
  const attachments = normalizeAttachments(input.attachments);
  return {
    chat_id: chatId,
    message_id: messageId,
    topic_id: nullable(input.topic_id ?? input.topicId),
    direction: input.direction ? String(input.direction) : "outgoing",
    text,
    text_truncated: input.text_truncated === true || originalText.length > text.length,
    user_id: nullable(input.user_id ?? input.userId),
    user_name: nullable(input.user_name ?? input.userName),
    agent_id: nullable(input.agent_id ?? input.agentId),
    created_at: input.created_at ? String(input.created_at) : new Date().toISOString(),
    ...(attachments.length ? { attachments } : {}),
  };
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_ATTACHMENTS).flatMap((attachment) => {
    if (!attachment || typeof attachment !== "object") return [];
    const kind = String(attachment.kind || attachment.type || "attachment");
    return [{
      kind,
      file_name: nullable(attachment.file_name ?? attachment.fileName),
      mime_type: nullable(attachment.mime_type ?? attachment.mimeType),
    }];
  });
}

function nullable(value) {
  return value == null || value === "" ? null : String(value);
}

function recordKey(chatId, messageId) {
  return `${String(chatId)}:${String(messageId)}`;
}

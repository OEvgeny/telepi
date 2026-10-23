import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BROKER_PROTOCOL_VERSION } from "../broker-ipc.js";
import { normalizeBrokerSubmitRequest } from "../broker-message.js";
import { lookupTelegramMessage } from "../telegram/message-lookup.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function createDurableGatewayToolHandler({ getConfig, telegram, submitBroker }) {
  const completed = new Map();
  return async (method, params) => {
    const id = String(params.requestId || "").trim();
    if (!id) throw new Error("Durable gateway tool request has no request id");
    const signature = JSON.stringify({ method, params });
    const existing = completed.get(id);
    if (existing) {
      if (existing.signature !== signature) throw new Error(`Durable gateway tool request id was reused: ${id}`);
      return existing.promise;
    }
    const promise = dispatch(method, params, { getConfig, telegram, submitBroker });
    completed.set(id, { signature, promise });
    while (completed.size > 4096) completed.delete(completed.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      if (completed.get(id)?.promise === promise) completed.delete(id);
      throw error;
    }
  };
}

async function dispatch(method, params, services) {
  if (method === "telegram.getMessage") {
    return lookupTelegramMessage(services.getConfig(), services.telegram, params);
  }
  if (method === "telegram.sendMessage") return sendMessage(params, services);
  if (method === "telegram.sendImage") return sendImage(params, services);
  if (method === "telegram.sendButtons") return sendButtons(params, services);
  throw new Error(`Unsupported Durable gateway tool method: ${method}`);
}

async function sendMessage(params, { submitBroker }) {
  const target = String(params.to || "").trim();
  const agentId = String(params.currentAgentId || "").trim();
  const topicName = String(params.currentTopicName || "").trim();
  if (!target) throw new Error("telepi_send_message requires a target");
  if (target === topicName || target === agentId) {
    throw new Error("telepi_send_message cannot target the current topic or agent; reply normally instead");
  }
  const request = normalizeBrokerSubmitRequest({
    version: BROKER_PROTOCOL_VERSION,
    type: "submit",
    id: params.requestId,
    target: { name: target },
    message: { text: String(params.message || "") },
    origin: {
      kind: "agent",
      name: topicName || agentId || "durable-agent",
      agentId: agentId || undefined,
      topicName: topicName || undefined,
      source: agentId ? `agent:${agentId}` : "durable-agent",
    },
    options: { echo: false },
  });
  return submitBroker(request);
}

async function sendImage(params, { telegram }) {
  const chatId = required(params.chatId, "Telegram chat id");
  const bytes = Buffer.from(required(params.dataBase64, "image data"), "base64");
  if (!bytes.length) throw new Error("Image is empty");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image is too large (max ${MAX_IMAGE_BYTES} bytes)`);
  const topicId = nullable(params.topicId);
  const caption = params.caption ? String(params.caption).slice(0, 1024) : undefined;
  const sent = await telegram.client.sendPhoto({
    chatId,
    topicId,
    fileData: bytes,
    fileName: safeFileName(params.fileName),
    caption,
    replyToMessageId: nullable(params.replyToMessageId),
  });
  telegram.recordSentMessages({ chatId, topicId, caption }, [sent]);
  return {
    chatId: String(chatId),
    topicId,
    messageId: String(sent.message_id),
  };
}

async function sendButtons(params, { getConfig, telegram }) {
  const chatId = required(params.chatId, "Telegram chat id");
  const topicId = nullable(params.topicId);
  const buttons = normalizeButtons(params.buttons);
  const token = randomBytes(9).toString("base64url");
  const replyMarkup = {
    inline_keyboard: layoutRows(buttons).map((row) => row.map((button) => (
      button.url
        ? { text: button.label, url: button.url }
        : { text: button.label, callback_data: `telepi:btn:${token}:${buttons.indexOf(button)}` }
    ))),
  };
  const text = String(params.text || "").slice(0, 4096);
  const sent = await telegram.client.sendMessage({
    chatId,
    topicId,
    text,
    replyMarkup,
  });
  telegram.recordSentMessages({ chatId, topicId, text, agentId: params.agentId }, [sent]);
  const config = getConfig();
  const path = resolve(config.project.cache_dir, "button-callbacks.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({
    token,
    chat_id: String(chatId),
    topic_id: topicId,
    agent_id: params.agentId || null,
    topic_name: params.topicName || null,
    message_id: String(sent.message_id),
    buttons: buttons.map((button) => ({ label: button.label, data: button.data ?? null })),
    created_at: new Date().toISOString(),
  })}\n`, "utf8");
  return {
    chatId: String(chatId),
    topicId,
    messageId: String(sent.message_id),
    buttons: buttons.length,
  };
}

function normalizeButtons(input) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("buttons must be a non-empty array");
  if (input.length > 24) throw new Error("buttons may contain at most 24 entries");
  return input.map((entry, index) => {
    const button = typeof entry === "string" ? { label: entry } : entry;
    const label = String(button?.label || "").trim();
    if (!label) throw new Error(`button ${index + 1} is missing label`);
    if (label.length > 64) throw new Error(`button ${index + 1} label is too long (max 64 chars)`);
    const url = button.url ? String(button.url).trim() : "";
    if (url && !/^https?:\/\//i.test(url)) throw new Error(`button ${index + 1} url must start with http:// or https://`);
    const data = button.data == null ? undefined : String(button.data);
    if (data && data.length > 2000) throw new Error(`button ${index + 1} data is too long (max 2000 chars)`);
    if (url && data) throw new Error(`button ${index + 1} must use either url or data, not both`);
    return url ? { label, url } : { label, data };
  });
}

function layoutRows(buttons) {
  const rows = [];
  let row = [];
  let rowChars = 0;
  for (const button of buttons) {
    const fits = row.length < 3 && rowChars + button.label.length <= 24;
    if (row.length && !fits) {
      rows.push(row);
      row = [];
      rowChars = 0;
    }
    row.push(button);
    rowChars += button.label.length;
  }
  if (row.length) rows.push(row);
  return rows;
}

function required(value, label) {
  const result = String(value || "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function nullable(value) {
  return value == null || value === "" ? null : String(value);
}

function safeFileName(value) {
  return String(value || "photo.jpg").replace(/[\\/\0]/g, "_").slice(-200) || "photo.jpg";
}

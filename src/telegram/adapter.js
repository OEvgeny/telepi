import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { findTopic, getBotToken } from "../config.js";
import {
  TelegramClient,
  attributeBotReplyToAgent,
  hydrateEnvelopeMedia,
  updateToEnvelope,
} from "./client.js";
import { blockquoteEntities, italicEntities, toTelegramMarkdownV2 } from "./format.js";

// Concrete in-process Telegram orchestration for the gateway. This module is
// intentionally not a generalized transport interface; its methods follow the
// existing Telegram envelope and run-state shapes.
const GATEWAY_TELEGRAM_MIN_INTERVAL_MS = 1000;
const TOOL_UPDATE_DEBOUNCE_MS = 1000;
const MAX_GATEWAY_RATE_LIMIT_RETRY_MS = 5000;
const GATEWAY_RATE_LIMITED_TELEGRAM_METHODS = new Set([
  "sendMessage",
  "editMessageText",
  "editMessageReplyMarkup",
  "setMessageReaction",
  "sendPhoto",
]);

export async function createTelegramAdapter(config) {
  const rawClient = new TelegramClient(getBotToken(config));
  const me = await rawClient.getMe();
  await configureBotCommands(rawClient, config);
  const adapter = new TelegramAdapter(createTelegramIssueLimiter(rawClient), me);
  adapter.initSentMessageIndex(config);
  console.error(`telepi gateway connected as ${me.first_name} (@${me.username || "unknown"})`);
  return adapter;
}

class TelegramAdapter {
  constructor(client, me) {
    this.client = client;
    this.me = me;
    this.sentMessageIndexPath = undefined;
    this.typingByTopic = new Map();
  }

  async poll({ getConfig, inFlight, onMessage, onButtonMessage, onReactionMessage }) {
    let offset = Number(process.env.TELEPI_UPDATE_OFFSET || 0) || undefined;
    let pollFailures = 0;

    while (true) {
      const config = getConfig();
      let updates;
      try {
        updates = await this.client.getUpdates({
          offset,
          timeoutSeconds: config.telegram.poll_timeout_seconds,
          limit: config.telegram.poll_limit,
        });
        pollFailures = 0;
      } catch (error) {
        pollFailures += 1;
        const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(pollFailures - 1, 5));
        console.error(`getUpdates failed (attempt ${pollFailures}), retrying in ${delayMs}ms: ${error.message}`);
        await sleep(delayMs);
        continue;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          this.handleCallbackQuery(config, inFlight, update.callback_query, onButtonMessage).catch((error) => {
            console.error(`callback handling failed: ${error.stack || error.message}`);
          });
          continue;
        }
        if (update.message_reaction) {
          this.handleMessageReaction(config, update.message_reaction, onReactionMessage).catch((error) => {
            console.error(`reaction handling failed: ${error.stack || error.message}`);
          });
          continue;
        }

        const rawMessage = update.message || update.edited_message;
        if (rawMessage) logReceivedMessageUpdate(update, rawMessage);
        let envelope = updateToEnvelope(update);
        if (!envelope) {
          if (rawMessage) logDroppedMessageUpdate(update, rawMessage, "no_text_or_supported_attachment");
          continue;
        }
        envelope = normalizeTelegramCommands(envelope, this.me.username);
        if (!isAllowedUser(config, envelope.userId)) {
          console.error(`ignored unauthorized user ${envelope.userId}`);
          continue;
        }
        const topic = findTopic(config, envelope.chatId, envelope.topicId);
        if (!topic || topic.enabled === false) {
          console.error(`ignored unknown topic chat=${envelope.chatId} topic=${envelope.topicId}`);
          continue;
        }
        envelope = attributeBotReplyToAgent(envelope, {
          botUserId: this.me.id,
          agentId: topic.agent,
          agentName: config.agents?.[topic.agent]?.name || topic.name,
        });
        await onMessage(config, topic, envelope);
      }
    }
  }

  hydrateEnvelope(config, envelope) {
    return hydrateEnvelopeMedia(this.client, config, envelope);
  }

  sendLongMessage(message) {
    return sendLongMessage(this, message);
  }

  setLoggedMessageReaction(details) {
    return setLoggedMessageReaction(this.client, details);
  }

  startWorkingIndicator(config, topic, envelope) {
    return startWorkingIndicator(this, config, topic, envelope);
  }

  queueAssistantTextDisplay(active, envelope, text) {
    active.displayQueue = active.displayQueue
      .catch(() => undefined)
      .then(() => sendStreamingText(this, active, envelope, text));
    return active.displayQueue;
  }

  queueDisplayPiEvent(active, envelope, event, displayMessages, options = {}) {
    const excluded = new Set(options.excludeTypes || []);
    const items = displayItemsFromPiEvent(event)
      .filter((item) => !excluded.has(item.type) && isDisplayMessageAllowed(displayMessages, item.type));
    for (const item of items) {
      active.displayQueue = active.displayQueue
        .catch(() => undefined)
        .then(() => displayPiItem(this, active, envelope, item));
    }
  }

  resetReasoningDisplayFromPiEvent(active, event) {
    if (event?.type !== "message_start" || event.message?.role !== "user") return;
    active.displayQueue = active.displayQueue
      .catch(() => undefined)
      .then(() => {
        active.reasoningDisplayMessage = undefined;
      });
  }

  updateReplyAnchorFromPiEvent(active, event) {
    if (event?.type !== "message_start" || event.message?.role !== "user") return;
    const messageId = telegramMessageIdFromPiMessage(event.message);
    if (messageId) active.currentReplyToMessageId = messageId;
  }

  messageIdFromPiMessage(message) {
    return telegramMessageIdFromPiMessage(message);
  }

  isDisplayMessageAllowed(displayMessages, type) {
    return isDisplayMessageAllowed(displayMessages, type);
  }

  isDeliveryEvent(event) {
    return isTelegramDeliveryEvent(event);
  }

  clearCancelButton(active) {
    return clearCancelButton(this, active);
  }

  initSentMessageIndex(config) {
    this.sentMessageIndexPath = resolve(config.project.cache_dir, "sent-messages.jsonl");
    mkdirSync(resolve(config.project.cache_dir), { recursive: true });
    if (!existsSync(this.sentMessageIndexPath)) return;
    const lines = readFileSync(this.sentMessageIndexPath, "utf8").split("\n").filter(Boolean);
    if (lines.length > 4000) {
      writeFileSync(this.sentMessageIndexPath, lines.slice(-2000).join("\n") + "\n");
    }
  }

  recordSentMessages(message, sentMessages) {
    if (!this.sentMessageIndexPath) return;
    for (const sent of sentMessages) {
      if (!sent?.message_id) continue;
      appendFileSync(this.sentMessageIndexPath, JSON.stringify({
        chat_id: String(sent.chat?.id || message.chatId),
        message_id: String(sent.message_id),
        topic_id: message.topicId == null ? null : String(message.topicId),
        text: String(sent.text || message.text || "").slice(0, 150),
      }) + "\n");
    }
  }

  findSentMessageRecord(chatId, messageId) {
    if (!this.sentMessageIndexPath || !existsSync(this.sentMessageIndexPath)) return null;
    const lines = readFileSync(this.sentMessageIndexPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const record = JSON.parse(lines[i]);
        if (record.chat_id === String(chatId) && record.message_id === String(messageId)) return record;
      } catch {}
    }
    return null;
  }

  async handleCallbackQuery(config, inFlight, query, onButtonMessage) {
    const userId = query.from?.id == null ? null : String(query.from.id);
    if (!isAllowedUser(config, userId)) {
      await this.client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Not allowed",
        showAlert: true,
      }).catch((error) => {
        console.error(`answer unauthorized callback failed: ${error.message}`);
      });
      console.error(`ignored unauthorized callback user ${userId}`);
      return;
    }

    const buttonRef = parseButtonCallbackData(query.data);
    if (buttonRef) {
      await this.handleButtonCallback(config, query, buttonRef, onButtonMessage);
      return;
    }

    const token = parseCancelCallbackData(query.data);
    if (!token) {
      await this.client.answerCallbackQuery({ callbackQueryId: query.id }).catch((error) => {
        console.error(`answer unknown callback failed: ${error.message}`);
      });
      return;
    }

    const active = [...inFlight.values()].find((run) => run.cancelToken === token);
    if (!active) {
      await this.client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "This run is no longer active.",
      }).catch((error) => {
        console.error(`answer stale cancel failed: ${error.message}`);
      });
      await removeCallbackMessageMarkup(this.client, query).catch((error) => {
        console.error(`remove stale cancel button failed: ${error.message}`);
      });
      return;
    }

    try {
      await active.ready;
      if (active.readyError) throw active.readyError;
      if (!active.abort) throw new Error("run is not accepting cancellation");
      await this.client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "Cancelling...",
      });
      active.cancelled = true;
      await active.abort();
      await this.clearCancelButton(active);
      console.error(`cancel requested token=${token} user=${userId}`);
    } catch (error) {
      console.error(`cancel failed token=${token}: ${error.stack || error.message}`);
      await this.client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: `Cancel failed: ${error.message}`,
        showAlert: true,
      }).catch((sendError) => {
        console.error(`answer cancel failure failed: ${sendError.message}`);
      });
    }
  }

  async handleButtonCallback(config, query, buttonRef, onButtonMessage) {
    const callback = findButtonCallback(config, buttonRef);
    if (!callback) {
      await this.client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "This button is no longer available.",
      }).catch((error) => {
        console.error(`answer unknown button failed: ${error.message}`);
      });
      await removeCallbackMessageMarkup(this.client, query).catch((error) => {
        console.error(`remove unknown button markup failed: ${error.message}`);
      });
      return;
    }

    const topic = findTopic(config, callback.chat_id, callback.topic_id);
    if (!topic || topic.enabled === false) {
      await this.client.answerCallbackQuery({
        callbackQueryId: query.id,
        text: "This topic is not routed here.",
        showAlert: true,
      }).catch((error) => {
        console.error(`answer unrouted button failed: ${error.message}`);
      });
      console.error(`ignored button for unknown topic chat=${callback.chat_id} topic=${callback.topic_id}`);
      return;
    }

    if (callback.action) {
      await handleButtonAction(this.client, query, callback);
      return;
    }

    const answered = this.client.answerCallbackQuery({
      callbackQueryId: query.id,
      text: callback.label ? `${callback.label}`.slice(0, 180) : "Selected",
    }).catch((error) => {
      console.error(`answer button callback failed: ${error.message}`);
    });
    if (!callback.sticky) {
      removeCallbackMessageMarkup(this.client, query).catch((error) => {
        console.error(`remove tapped button markup failed: ${error.message}`);
      });
    }

    const envelope = attributeBotReplyToAgent(envelopeFromButtonCallback(query, callback), {
      botUserId: query.message?.from?.id,
      agentId: topic.agent,
      agentName: config.agents?.[topic.agent]?.name || topic.name,
    });
    const submitted = onButtonMessage(config, topic, envelope);
    await answered;
    await submitted;
  }

  async handleMessageReaction(config, reaction, onReactionMessage) {
    const userId = String(reaction.user?.id || "");
    if (!isAllowedUser(config, userId)) return;
    const chatId = String(reaction.chat.id);
    const messageId = String(reaction.message_id);
    const record = this.findSentMessageRecord(chatId, messageId);
    if (!record) {
      console.error(`ignored reaction to unindexed message chat=${chatId} message=${messageId}`);
      return;
    }
    const topic = findTopic(config, chatId, record.topic_id);
    if (!topic || topic.enabled === false) return;
    const oldEmojis = reactionEmojis(reaction.old_reaction);
    const newEmojis = reactionEmojis(reaction.new_reaction);
    const added = newEmojis.filter((emoji) => !oldEmojis.includes(emoji));
    const removed = oldEmojis.filter((emoji) => !newEmojis.includes(emoji));
    if (!added.length && !removed.length) return;
    const parts = [];
    if (added.length) parts.push(`reacted ${added.join(" ")}`);
    if (removed.length) parts.push(`removed the ${removed.join(" ")} reaction`);
    const envelope = {
      chatId,
      topicId: record.topic_id,
      messageId,
      userId,
      userName: reaction.user?.first_name || "user",
      source: "telegram_reaction",
      queueAck: false,
      text: `[Telegram reaction] The user ${parts.join(" and ")} on your earlier message${record.text ? `: "${record.text}"` : ""}. A reaction is a lightweight gesture — usually it needs at most a short acknowledgment or a reaction back, and often no reply at all beyond a word.`,
    };
    console.error(`reaction chat=${chatId} topic=${record.topic_id} message=${messageId} ${parts.join("; ")}`);
    await onReactionMessage(config, topic, envelope);
  }
}

function logReceivedMessageUpdate(update, message) {
  console.error(`received ${update.edited_message ? "edited_message" : "message"} ${messageUpdateLogFields(update, message)}`);
}

function logDroppedMessageUpdate(update, message, reason) {
  console.error(`dropped ${update.edited_message ? "edited_message" : "message"} ${messageUpdateLogFields(update, message)} reason=${reason}`);
}

function messageUpdateLogFields(update, message) {
  const text = message.text || message.caption || "";
  const attachments = summarizeMessageAttachmentsForLog(message);
  const fields = [
    `update=${update.update_id}`,
    `chat=${message.chat?.id ?? "unknown"}`,
    `topic=${message.message_thread_id ?? "none"}`,
    `message=${message.message_id ?? "unknown"}`,
    `from=${message.from?.id ?? "unknown"}`,
    `username=${JSON.stringify(message.from?.username || message.from?.first_name || "unknown")}`,
    `bot=${Boolean(message.from?.is_bot)}`,
    `reply_to=${message.reply_to_message?.message_id ?? "none"}`,
    `text_len=${text.length}`,
    `attachments=${attachments || "none"}`,
  ];
  if (text) fields.push(`text=${JSON.stringify(previewForLog(text))}`);
  return fields.join(" ");
}

function summarizeMessageAttachmentsForLog(message) {
  const attachments = [];
  if (Array.isArray(message.photo) && message.photo.length) attachments.push("photo");
  if (message.document) attachments.push(`document:${message.document.file_name || message.document.mime_type || "unnamed"}`);
  if (message.voice) attachments.push(`voice:${message.voice.mime_type || "audio/ogg"}`);
  if (message.audio) attachments.push(`audio:${message.audio.file_name || message.audio.mime_type || "unnamed"}`);
  return attachments.join(",");
}

function previewForLog(text, maxLength = 120) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function createTelegramIssueLimiter(telegram, minIntervalMs = GATEWAY_TELEGRAM_MIN_INTERVAL_MS) {
  let queue = Promise.resolve();
  let nextAllowedAt = 0;

  return new Proxy(telegram, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!GATEWAY_RATE_LIMITED_TELEGRAM_METHODS.has(String(prop))) return value.bind(target);
      return (...args) => {
        const scheduled = queue.then(async () => {
          const waitMs = Math.max(0, nextAllowedAt - Date.now());
          if (waitMs > 0) await sleep(waitMs);
          nextAllowedAt = Date.now() + minIntervalMs;
          return value.apply(target, args);
        });
        queue = scheduled.catch(() => undefined);
        return scheduled;
      };
    },
  });
}

async function configureBotCommands(telegram, config) {
  const commands = [
    { command: "help", description: "Show telepi gateway commands" },
    { command: "compact", description: "Compact the current pi session with an optional prompt" },
    { command: "retry", description: "Retry the last prompt in this topic" },
  ];
  for (const scope of commandScopes(config)) {
    await telegram.deleteMyCommands({ scope }).catch((error) => {
      console.error(`delete bot commands failed scope=${JSON.stringify(scope)}: ${error.message}`);
    });
  }
  await telegram.setMyCommands(commands).catch((error) => {
    console.error(`set bot commands failed: ${error.message}`);
  });
  await telegram.setMyCommands(commands, { scope: { type: "all_private_chats" } }).catch((error) => {
    console.error(`set private bot commands failed: ${error.message}`);
  });
  for (const chatId of commandChatIds(config)) {
    await telegram.setMyCommands(commands, { scope: { type: "chat", chat_id: chatId } }).catch((error) => {
      console.error(`set chat bot commands failed chat=${chatId}: ${error.message}`);
    });
    await telegram.setChatMenuButton({ chatId, menuButton: { type: "commands" } }).catch((error) => {
      console.error(`set chat menu button failed chat=${chatId}: ${error.message}`);
    });
  }
  await telegram.setChatMenuButton({ menuButton: { type: "commands" } }).catch((error) => {
    console.error(`set default menu button failed: ${error.message}`);
  });
}

function commandScopes(config) {
  const scopes = [
    undefined,
    { type: "all_private_chats" },
    { type: "all_group_chats" },
    { type: "all_chat_administrators" },
  ];
  for (const chatId of commandChatIds(config)) scopes.push({ type: "chat", chat_id: chatId });
  return scopes;
}

function commandChatIds(config) {
  const chatIds = new Set();
  if (config.manager?.chat_id) chatIds.add(String(config.manager.chat_id));
  for (const user of Object.values(config.users?.aliases || {})) {
    if (user.id) chatIds.add(String(user.id));
  }
  for (const topic of config.topics || []) {
    if (topic.chat_id) chatIds.add(String(topic.chat_id));
  }
  return [...chatIds];
}

function normalizeTelegramCommands(envelope, botUsername) {
  if (!botUsername || !envelope.text) return envelope;
  const pattern = new RegExp(`^/(compact|help|retry)@${escapeRegExp(botUsername)}(?=\\s|$)`, "i");
  const text = envelope.text.replace(pattern, "/$1");
  return text === envelope.text ? envelope : { ...envelope, text };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllowedUser(config, userId) {
  const allowed = config.telegram.allowed_user_ids || [];
  if (!allowed.length || allowed.includes("*")) return true;
  return userId != null && allowed.includes(String(userId));
}

function parseCancelCallbackData(data) {
  const match = String(data || "").match(/^telepi:cancel:([A-Za-z0-9_-]+)$/);
  return match?.[1] || null;
}

function parseButtonCallbackData(data) {
  const match = String(data || "").match(/^telepi:btn:([A-Za-z0-9_-]+):(\d+)$/);
  return match ? { token: match[1], index: Number(match[2]) } : null;
}

function findButtonCallback(config, { token, index }) {
  const path = resolve(config.project.cache_dir, "button-callbacks.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
    try {
      const record = JSON.parse(lines[lineIndex]);
      if (record?.token === token) return normalizeButtonCallback(record, index);
    } catch {}
  }
  return null;
}

function normalizeButtonCallback(record, index) {
  const button = record.buttons?.[index];
  if (!button) return null;
  return {
    chat_id: String(record.chat_id || ""),
    topic_id: record.topic_id == null ? null : String(record.topic_id),
    message_id: record.message_id == null ? "" : String(record.message_id),
    label: button.label == null ? "" : String(button.label),
    data: button.data == null ? "" : String(button.data),
    action: button.action && typeof button.action === "object" ? button.action : null,
    sticky: record.sticky === true,
  };
}

function envelopeFromButtonCallback(query, callback) {
  const user = query.from || {};
  const userName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "unknown";
  return {
    updateId: `callback:${query.id}`,
    chatId: callback.chat_id,
    topicId: callback.topic_id,
    userId: user.id == null ? null : String(user.id),
    userName,
    messageId: callback.message_id || (query.message?.message_id == null ? "" : String(query.message.message_id)),
    text: callback.data || callback.label,
    attachments: [],
    replyTo: callback.message_id ? {
      messageId: callback.message_id,
      text: query.message?.text || query.message?.caption || "",
      userId: query.message?.from?.id == null ? undefined : String(query.message.from.id),
      userName: query.message?.from?.first_name || query.message?.from?.username || "",
      isBot: query.message?.from?.is_bot === true,
    } : undefined,
  };
}

async function handleButtonAction(telegram, query, callback) {
  const action = callback.action || {};
  try {
    if (action.type === "answer") {
      await telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: String(action.text || "").slice(0, 190),
        showAlert: true,
      });
      return;
    }
    if (action.type === "comfy-cancel") {
      const base = String(action.base_url || "").replace(/\/+$/, "");
      const promptId = String(action.prompt_id || "");
      if (!/^https?:\/\//.test(base) || !promptId) throw new Error("malformed cancel action");
      const queueResponse = await fetch(`${base}/queue`);
      if (!queueResponse.ok) throw new Error(`queue check failed: HTTP ${queueResponse.status}`);
      const queue = await queueResponse.json();
      const inList = (list) => Array.isArray(list) && list.some((item) => item?.[1] === promptId);
      let answer;
      if (inList(queue.queue_running)) {
        await fetch(`${base}/interrupt`, { method: "POST" });
        answer = "Interrupting…";
      } else if (inList(queue.queue_pending)) {
        await fetch(`${base}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delete: [promptId] }),
        });
        answer = "Removed from queue";
      } else {
        answer = "Already finished";
      }
      await telegram.answerCallbackQuery({ callbackQueryId: query.id, text: answer });
      await removeCallbackMessageMarkup(telegram, query).catch(() => {});
      console.error(`comfy-cancel prompt=${promptId}: ${answer}`);
      return;
    }
    throw new Error(`unknown button action type: ${action.type}`);
  } catch (error) {
    console.error(`button action failed: ${error.stack || error.message}`);
    await telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: `Action failed: ${error.message}`.slice(0, 190),
      showAlert: true,
    }).catch(() => {});
  }
}

async function removeCallbackMessageMarkup(telegram, query) {
  if (!query.message?.chat?.id || !query.message?.message_id) return;
  await telegram.editMessageReplyMarkup({
    chatId: String(query.message.chat.id),
    messageId: String(query.message.message_id),
  });
}

function reactionEmojis(reactions) {
  return (reactions || []).map((reaction) => reaction.emoji || reaction.custom_emoji_id || "?");
}

async function sendLongMessage(adapter, message) {
  const chunks = splitMessage(message.text);
  const sentMessages = [];
  for (const [index, chunk] of chunks.entries()) {
    const quoted = Boolean(message.quote);
    const italic = Boolean(message.italic);
    const converted = quoted || italic ? null : toTelegramMarkdownV2(chunk);
    const payload = {
      chatId: message.chatId,
      topicId: message.topicId,
      replyToMessageId: index === 0 ? message.replyToMessageId : undefined,
      text: converted ?? chunk,
      parseMode: converted ? "MarkdownV2" : undefined,
      entities: quoted ? blockquoteEntities(chunk) : italic ? italicEntities(chunk) : undefined,
      replyMarkup: index === chunks.length - 1 ? message.replyMarkup : undefined,
    };
    try {
      sentMessages.push(await sendMessageWithRateLimitRetry(adapter.client, payload));
    } catch (error) {
      if (isTelegramRateLimited(error)) {
        console.error(`send message rate limited after retries, dropping ${chunks.length - index} chunk(s) chat=${message.chatId} topic=${message.topicId}: ${error.message}`);
        break;
      } else if (payload.replyToMessageId && /reply|replied|message to be replied/i.test(error.message)) {
        console.error(`reply target unavailable chat=${message.chatId} topic=${message.topicId} message=${payload.replyToMessageId}; retrying without reply`);
        const sent = await sendTelegramMessageOrDropOnRateLimit(adapter.client, { ...payload, replyToMessageId: undefined }, message);
        if (!sent) break;
        sentMessages.push(sent);
      } else if (payload.entities && /entities|entity/i.test(error.message)) {
        console.error(`message entity failed chat=${message.chatId} topic=${message.topicId}; retrying as plain text: ${error.message}`);
        const sent = await sendTelegramMessageOrDropOnRateLimit(adapter.client, { ...payload, entities: undefined }, message);
        if (!sent) break;
        sentMessages.push(sent);
      } else if (payload.parseMode && /parse entities|can't parse entities|reserved and must be escaped/i.test(error.message)) {
        console.error(`MarkdownV2 parse failed after conversion chat=${message.chatId} topic=${message.topicId}; retrying as plain text: ${error.message}`);
        const sent = await sendTelegramMessageOrDropOnRateLimit(adapter.client, { ...payload, parseMode: undefined, text: chunk }, message);
        if (!sent) break;
        sentMessages.push(sent);
      } else {
        throw error;
      }
    }
  }
  adapter.recordSentMessages(message, sentMessages);
  return sentMessages;
}

async function sendTelegramMessageOrDropOnRateLimit(telegram, payload, originalMessage) {
  try {
    return await sendMessageWithRateLimitRetry(telegram, payload);
  } catch (error) {
    if (isTelegramRateLimited(error)) {
      console.error(`send message rate limited after retries chat=${originalMessage.chatId} topic=${originalMessage.topicId}: ${error.message}`);
      return null;
    }
    throw error;
  }
}

async function sendMessageWithRateLimitRetry(telegram, payload, maxRetries = 1) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await telegram.sendMessage(payload);
    } catch (error) {
      const delayMs = rateLimitDelayMs(error);
      if (delayMs == null || attempt >= maxRetries || delayMs > MAX_GATEWAY_RATE_LIMIT_RETRY_MS) throw error;
      console.error(`send message rate limited chat=${payload.chatId} topic=${payload.topicId}; waiting ${delayMs}ms: ${error.message}`);
      await sleep(delayMs);
    }
  }
}

function rateLimitDelayMs(error) {
  if (!isTelegramRateLimited(error)) return null;
  const seconds = Number(error.retryAfterSeconds ?? error.message.match(/retry after (\d+)/i)?.[1] ?? 5);
  return Math.min(60, Math.max(1, seconds)) * 1000;
}

async function editTelegramMessageText(adapter, message) {
  const text = message.text.length > 3900 ? `${message.text.slice(0, 3890)}\n[truncated]` : message.text;
  const italic = Boolean(message.italic);
  const converted = italic ? null : toTelegramMarkdownV2(text);
  const payload = {
    chatId: message.chatId,
    messageId: message.messageId,
    text: converted ?? text,
    parseMode: converted ? "MarkdownV2" : undefined,
    entities: italic ? italicEntities(text) : undefined,
    replyMarkup: message.replyMarkup,
  };
  try {
    await adapter.client.editMessageText(payload);
  } catch (error) {
    if ((payload.parseMode || payload.entities) && /parse entities|can't parse entities|reserved and must be escaped|entities|entity/i.test(error.message)) {
      try {
        await adapter.client.editMessageText({ ...payload, parseMode: undefined, entities: undefined, text });
      } catch (plainError) {
        if (isTelegramRateLimited(plainError)) {
          console.error(`edit message rate limited chat=${message.chatId} message=${message.messageId}: ${plainError.message}`);
          return;
        }
        throw plainError;
      }
    } else if (isTelegramRateLimited(error)) {
      console.error(`edit message rate limited chat=${message.chatId} message=${message.messageId}: ${error.message}`);
    } else if (!isReplyMarkupAlreadyClear(error)) {
      throw error;
    }
  }
}

async function setLoggedMessageReaction(telegram, { chatId, topicId, messageId, emoji, agent, reason }) {
  console.error(`setting reaction chat=${chatId} topic=${topicId || "none"} message=${messageId} agent=${agent || "unknown"} emoji=${emoji || "none"} reason=${reason || "unspecified"}`);
  const result = await telegram.setMessageReaction({ chatId, messageId, emoji });
  console.error(`set reaction chat=${chatId} topic=${topicId || "none"} message=${messageId} agent=${agent || "unknown"} emoji=${emoji || "none"} reason=${reason || "unspecified"}`);
  return result;
}

function startWorkingIndicator(adapter, config, topic, envelope) {
  if (config.telegram.working_indicator !== "typing") return () => undefined;
  let stopped = false;
  const key = `${envelope.chatId}:${envelope.topicId || ""}`;
  const sendTyping = () => {
    if (stopped) return;
    sendCoalescedTyping(adapter, key, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      action: "typing",
    }, (error) => {
      console.error(`typing indicator failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.message}`);
    });
  };
  sendTyping();
  const burstTimer = setTimeout(sendTyping, 750);
  const intervalMs = Math.min(5, Math.max(1, Number(config.telegram.typing_interval_seconds || 5))) * 1000;
  const timer = setInterval(sendTyping, intervalMs);
  return () => {
    stopped = true;
    clearCoalescedTyping(adapter, key);
    clearTimeout(burstTimer);
    clearInterval(timer);
  };
}

function sendCoalescedTyping(adapter, key, payload, onError) {
  let state = adapter.typingByTopic.get(key);
  if (!state) {
    state = { inFlight: false, pending: undefined };
    adapter.typingByTopic.set(key, state);
  }
  state.pending = { payload, onError };
  pumpCoalescedTyping(adapter, key, state);
}

function clearCoalescedTyping(adapter, key) {
  const state = adapter.typingByTopic.get(key);
  if (!state) return;
  state.pending = undefined;
  if (!state.inFlight) adapter.typingByTopic.delete(key);
}

function pumpCoalescedTyping(adapter, key, state) {
  if (state.inFlight || !state.pending) return;
  const next = state.pending;
  state.pending = undefined;
  state.inFlight = true;
  adapter.client.sendChatAction(next.payload)
    .catch((error) => next.onError?.(error))
    .finally(() => {
      state.inFlight = false;
      if (state.pending) pumpCoalescedTyping(adapter, key, state);
      else adapter.typingByTopic.delete(key);
    });
}

async function sendStreamingText(adapter, active, envelope, text, options = {}) {
  const previous = active.cancelMessage;
  active.cancelGeneration += 1;
  active.cancelMessage = undefined;
  active.cancelButtonAttached = false;
  clearTimeout(active.cancelAttachTimer);
  active.cancelAttachTimer = undefined;
  if (previous) {
    await clearTelegramMessageReplyMarkup(adapter.client, previous).catch((error) => {
      if (!isReplyMarkupAlreadyClear(error)) {
        console.error(`clear previous cancel button failed chat=${previous.chatId} message=${previous.messageId}: ${error.message}`);
      }
    });
  }

  const sentMessages = await adapter.sendLongMessage({
    chatId: envelope.chatId,
    topicId: envelope.topicId,
    replyToMessageId: active.currentReplyToMessageId || envelope.messageId,
    text,
    italic: options.italic,
  });
  const latest = sentMessages.at(-1);
  active.displayedMessageCount += sentMessages.length;
  if (!active.cancelled && latest?.message_id) {
    active.cancelMessage = {
      chatId: String(latest.chat?.id || envelope.chatId),
      messageId: String(latest.message_id),
    };
    scheduleCancelButton(adapter, active);
  }
  return sentMessages;
}

async function displayPiItem(adapter, active, envelope, item) {
  if (item.type === "assistant/reasoning") {
    await sendOrAppendReasoningDisplayText(adapter, active, envelope, item);
    return;
  }
  if (item.toolCallId) {
    await sendOrEditToolDisplayText(adapter, active, envelope, item);
    return;
  }
  await sendStreamingText(adapter, active, envelope, item.text, { italic: item.italic });
}

async function sendOrAppendReasoningDisplayText(adapter, active, envelope, item) {
  const existing = active.reasoningDisplayMessage;
  if (!existing) {
    const sentMessages = await sendStreamingText(adapter, active, envelope, item.text, { italic: true });
    const latest = sentMessages.at(-1);
    if (latest?.message_id) {
      active.reasoningDisplayMessage = {
        chatId: String(latest.chat?.id || envelope.chatId),
        messageId: String(latest.message_id),
        text: item.text,
        parts: [item.text],
      };
    }
    return;
  }
  if (existing.parts.includes(item.text)) return;
  const combined = `${existing.text}\n\n${item.text}`;
  if (combined.length > 3900) {
    active.reasoningDisplayMessage = undefined;
    await sendOrAppendReasoningDisplayText(adapter, active, envelope, item);
    return;
  }
  await editTelegramMessageText(adapter, {
    chatId: existing.chatId,
    messageId: existing.messageId,
    text: combined,
    italic: true,
    replyMarkup: shouldKeepCancelButton(active, existing) ? cancelButtonMarkup(active.cancelToken) : undefined,
  });
  existing.text = combined;
  existing.parts.push(item.text);
}

async function sendOrEditToolDisplayText(adapter, active, envelope, item) {
  const existing = active.toolDisplayMessages.get(item.toolCallId);
  if (!existing) {
    const sentMessages = await sendStreamingText(adapter, active, envelope, item.text);
    const latest = sentMessages.at(-1);
    if (latest?.message_id) {
      active.toolDisplayMessages.set(item.toolCallId, {
        chatId: String(latest.chat?.id || envelope.chatId),
        messageId: String(latest.message_id),
        text: item.text,
        lastEditedAt: Date.now(),
      });
    }
    return;
  }
  if (existing.text === item.text) return;
  const now = Date.now();
  if (!item.final && now - (existing.lastEditedAt || 0) < TOOL_UPDATE_DEBOUNCE_MS) return;
  await editTelegramMessageText(adapter, {
    chatId: existing.chatId,
    messageId: existing.messageId,
    text: item.text,
    replyMarkup: shouldKeepCancelButton(active, existing) ? cancelButtonMarkup(active.cancelToken) : undefined,
  });
  existing.text = item.text;
  existing.lastEditedAt = Date.now();
}

function shouldKeepCancelButton(active, message) {
  return Boolean(
    active.abort &&
    !active.cancelled &&
    active.cancelMessage &&
    String(active.cancelMessage.chatId) === String(message.chatId) &&
    String(active.cancelMessage.messageId) === String(message.messageId)
  );
}

function isDisplayMessageAllowed(displayMessages, type) {
  const values = displayMessages.map((value) => String(value).trim()).filter(Boolean);
  if (!values.length) return false;
  if (values.includes(type)) return true;
  return values.includes(type.split("/")[0]);
}

function isTelegramDeliveryEvent(event) {
  if (event?.type !== "tool_execution_end") return false;
  const details = event.result?.details;
  if (!details || typeof details !== "object") return false;
  if (details.message_id) return true;
  return Array.isArray(details.telegram_messages) && details.telegram_messages.some((entry) => entry?.messageId || entry?.message_id);
}

function displayItemsFromPiEvent(event) {
  if (!event || typeof event !== "object") return [];
  const assistantItem = assistantDisplayItemFromEvent(event);
  if (assistantItem) return [assistantItem];
  const customItem = customDisplayItemFromEvent(event);
  if (customItem) return [customItem];
  const toolItem = toolDisplayItemFromEvent(event);
  if (toolItem) return [toolItem];
  return [];
}

function assistantDisplayItemFromEvent(event) {
  if (event.type !== "message_update") return null;
  const messageEvent = event.assistantMessageEvent;
  if (!messageEvent?.type) return null;
  if (messageEvent.type === "text_end") {
    const text = String(messageEvent.content || "").trim();
    return text ? { type: "assistant/message", text } : null;
  }
  if (/reasoning|thinking/i.test(messageEvent.type)) {
    const text = firstTextValue(messageEvent, ["content", "text", "thinking", "reasoning"]);
    const italicText = text.replace(/\*\*|__/g, "");
    return italicText ? { type: "assistant/reasoning", text: italicText, italic: true } : null;
  }
  if (/tool/i.test(messageEvent.type)) {
    const text = compactJson(messageEvent);
    return text ? { type: "assistant/tool", text: `[assistant/tool]\n${text}` } : null;
  }
  return null;
}

function customDisplayItemFromEvent(event) {
  if (event.type !== "message_end" || event.message?.role !== "custom") return null;
  const message = event.message;
  if (message.display === false) return null;
  const customType = String(message.customType || "message");
  const text = textFromPiContent(message.content) || firstTextValue(message, ["text", "details"]);
  if (!text) return null;
  const title = customDisplayTitle(message, customType);
  return { type: `custom/${customType}`, text: formatCustomText(text, title) };
}

function toolDisplayItemFromEvent(event) {
  if (event.type === "tool_execution_update") {
    const customType = event.partialResult?.details?.customType;
    const text = textFromPiContent(event.partialResult?.content) || firstTextValue(event.partialResult, ["text", "message"]);
    if (customType && text) {
      const title = customDisplayTitle(event.partialResult, customType);
      return { type: `custom/${customType}`, text: formatCustomText(text, title), toolCallId: event.toolCallId, final: false };
    }
  }
  if (event.type === "tool_execution_end") {
    const customType = event.result?.details?.customType;
    const text = textFromPiContent(event.result?.content) || firstTextValue(event.result, ["text", "message"]);
    if (customType && text) {
      const title = customDisplayTitle(event.result, customType);
      return { type: `custom/${customType}`, text: formatCustomText(text, title), toolCallId: event.toolCallId, final: true };
    }
  }
  if (event.type === "message_end" && /tool/i.test(String(event.message?.role || ""))) {
    const name = String(event.message.toolName || event.message.name || "tool");
    const text = textFromPiContent(event.message.content) || firstTextValue(event.message, ["text", "details"]) || compactJson(event.message);
    return text ? { type: `tool/${name}`, text: `[tool/${name}]\n${text}` } : null;
  }
  if (/^tool/i.test(String(event.type || ""))) {
    const name = String(event.toolName || event.name || event.tool?.name || "event");
    const text = firstTextValue(event, ["content", "text", "message", "result", "error"]) || compactJson(event);
    return text ? { type: `tool/${name}`, text: `[tool/${name}]\n${text}` } : null;
  }
  return null;
}

function textFromPiContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text") return part.text || "";
      if (part.text) return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function customDisplayTitle(message, customType) {
  const details = message?.details;
  return firstStringValue(message, ["telepiTitle", "title"])
    || firstStringValue(details && typeof details === "object" ? details : undefined, ["telepiTitle", "title"])
    || (customType === "message" ? "" : `custom/${customType}`);
}

function formatCustomText(text, title) {
  return title ? `${title}\n${text}` : text;
}

function firstStringValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstTextValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const text = textFromPiContent(value);
      if (text) return text;
    }
  }
  return "";
}

function compactJson(value, maxLength = 1800) {
  try {
    const text = JSON.stringify(value);
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  } catch {
    return "";
  }
}

function telegramMessageIdFromPiMessage(message) {
  const text = (message.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("\n");
  const match = text.match(/^telegram_message_id=(.+)$/m);
  return match?.[1]?.trim() || null;
}

function scheduleCancelButton(adapter, active) {
  clearTimeout(active.cancelAttachTimer);
  const generation = active.cancelGeneration;
  active.cancelAttachTimer = setTimeout(() => {
    const message = active.cancelMessage;
    if (!message || active.cancelled || !active.abort) return;
    adapter.client.editMessageReplyMarkup({
      chatId: message.chatId,
      messageId: message.messageId,
      replyMarkup: cancelButtonMarkup(active.cancelToken),
    }).then(() => {
      if (active.cancelGeneration === generation && active.cancelMessage === message) {
        active.cancelButtonAttached = true;
      } else {
        return clearTelegramMessageReplyMarkup(adapter.client, message).catch((error) => {
          if (!isReplyMarkupAlreadyClear(error)) {
            console.error(`clear stale attached cancel button failed chat=${message.chatId} message=${message.messageId}: ${error.message}`);
          }
        });
      }
    }).catch((error) => {
      if (!isReplyMarkupAlreadyClear(error)) {
        console.error(`attach cancel button failed chat=${message.chatId} message=${message.messageId}: ${error.message}`);
      }
    });
  }, 900);
}

function cancelButtonMarkup(token) {
  return {
    inline_keyboard: [[{ text: "Cancel", callback_data: `telepi:cancel:${token}` }]],
  };
}

async function clearCancelButton(adapter, active) {
  active.cancelGeneration += 1;
  clearTimeout(active.cancelAttachTimer);
  active.cancelAttachTimer = undefined;
  const message = active.cancelMessage;
  active.cancelMessage = undefined;
  active.cancelButtonAttached = false;
  if (!message) return;
  await clearTelegramMessageReplyMarkup(adapter.client, message).catch((error) => {
    if (!isReplyMarkupAlreadyClear(error)) {
      console.error(`clear cancel button failed chat=${message.chatId} message=${message.messageId}: ${error.message}`);
    }
  });
}

async function clearTelegramMessageReplyMarkup(telegram, message) {
  await telegram.editMessageReplyMarkup({ chatId: message.chatId, messageId: message.messageId });
}

function isReplyMarkupAlreadyClear(error) {
  return /message is not modified/i.test(error.message);
}

function isTelegramRateLimited(error) {
  return /Too Many Requests|retry after/i.test(error.message || "");
}

function splitMessage(text, maxLength = 3900) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLength) {
    let index = rest.lastIndexOf("\n\n", maxLength);
    if (index < maxLength / 2) index = rest.lastIndexOf("\n", maxLength);
    if (index < maxLength / 2) index = rest.lastIndexOf(" ", maxLength);
    if (index < maxLength / 2) index = maxLength;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

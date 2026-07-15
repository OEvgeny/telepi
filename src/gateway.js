#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readConfig, getBotToken, findTopic, findTopicByName } from "./config.js";
import { TelegramClient, hydrateEnvelopeMedia, updateToEnvelope } from "./telegram.js";
import { parseCompactCommand } from "./pi-compact.js";
import { normalizePromptInboxInterval, startPromptInboxPolling } from "./prompt-inbox.js";
import { startPiForTopic } from "./pi-session.js";
import { blockquoteEntities, toTelegramMarkdownV2 } from "./telegram-format.js";
import { installTimestampedConsole } from "./logging.js";

installTimestampedConsole();

const execFileAsync = promisify(execFile);

const configPath = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]
  : undefined;

const GATEWAY_TELEGRAM_MIN_INTERVAL_MS = 1000;
const TOOL_UPDATE_DEBOUNCE_MS = 1000;
const MAX_GATEWAY_RATE_LIMIT_RETRY_MS = 5000;
const AUTO_RETRY_SOURCE = "auto-rpc-timeout-retry";
const GATEWAY_RATE_LIMITED_TELEGRAM_METHODS = new Set([
  "sendMessage",
  "editMessageText",
  "editMessageReplyMarkup",
  "setMessageReaction",
  "sendPhoto",
]);
const lastPromptByTopic = new Map();
const typingByTopic = new Map();
let queuePersistence;

async function main() {
  let config = readConfig(configPath);
  initSentMessageIndex(config);
  const telegramClient = new TelegramClient(getBotToken(config));
  const me = await telegramClient.getMe();
  await configureBotCommands(telegramClient, config);
  const telegram = createTelegramIssueLimiter(telegramClient);
  console.error(`telepi gateway connected as ${me.first_name} (@${me.username || "unknown"})`);

  let offset = Number(process.env.TELEPI_UPDATE_OFFSET || 0) || undefined;
  const inFlight = new Map();
  initPendingQueuePersistence(config, inFlight);
  startConfiguredPromptInbox(() => config, telegram, inFlight);
  let pollFailures = 0;

  while (true) {
    config = reloadConfig(config, configPath);
    let updates;
    try {
      updates = await telegram.getUpdates({
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
        handleCallbackQuery(config, telegram, inFlight, update.callback_query).catch((error) => {
          console.error(`callback handling failed: ${error.stack || error.message}`);
        });
        continue;
      }
      if (update.message_reaction) {
        handleMessageReaction(config, telegram, inFlight, update.message_reaction).catch((error) => {
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
      envelope = normalizeTelegramCommands(envelope, me.username);
      if (!isAllowedUser(config, envelope.userId)) {
        console.error(`ignored unauthorized user ${envelope.userId}`);
        continue;
      }
      const topic = findTopic(config, envelope.chatId, envelope.topicId);
      if (!topic || topic.enabled === false) {
        console.error(`ignored unknown topic chat=${envelope.chatId} topic=${envelope.topicId}`);
        continue;
      }
      const configForMessage = config;
      const key = `${envelope.chatId}:${envelope.topicId}`;
      const active = inFlight.get(key);
      if (isHelpCommand(envelope.text)) {
        await handleHelpCommand(telegram, configForMessage, topic, envelope);
        continue;
      }
      if (isRetryCommand(envelope.text)) {
        await handleRetryCommand(configForMessage, telegram, inFlight, topic, envelope, active);
        continue;
      }
      rememberRetryPrompt(envelope);
      if (active) {
        steerRunningTopic(configForMessage, telegram, inFlight, topic, envelope, active).catch((error) => {
          console.error(`steering dispatch failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.stack || error.message}`);
        });
        continue;
      }

      dispatchTopicRun(configForMessage, telegram, inFlight, topic, envelope);
    }
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

function startConfiguredPromptInbox(getConfig, telegram, inFlight) {
  const inboxDir = process.env.TELEPI_PROMPT_INBOX_DIR?.trim();
  if (!inboxDir) return () => undefined;

  const intervalMs = normalizePromptInboxInterval(process.env.TELEPI_PROMPT_INBOX_INTERVAL_MS);
  const defaultTopicName = process.env.TELEPI_PROMPT_INBOX_TOPIC?.trim() || "";
  console.error(`prompt inbox enabled dir=${inboxDir} interval=${intervalMs}ms${defaultTopicName ? ` default_topic=${defaultTopicName}` : ""}`);
  return startPromptInboxPolling({
    inboxDir,
    intervalMs,
    defaultTopicName,
    onInvalid: (claimed) => {
      console.error(`prompt inbox invalid file=${claimed.path}: ${claimed.invalidReason}`);
    },
    onError: (error) => {
      console.error(`prompt inbox polling failed: ${error.stack || error.message}`);
    },
    handlePrompt: async (claimed) => {
      const config = getConfig();
      const topic = findTopicByName(config, claimed.topicName);
      if (!topic || topic.enabled === false) {
        console.error(`prompt inbox unknown topic file=${claimed.path} topic=${claimed.topicName}`);
        await claimed.fail();
        return false;
      }
      const key = `${topic.chat_id}:${topic.topic_id}`;
      if (inFlight.has(key)) return false;
      const ownerAlias = config.users?.owner;
      const owner = ownerAlias ? config.users?.aliases?.[ownerAlias] : undefined;
      const envelope = {
        chatId: String(topic.chat_id),
        topicId: topic.topic_id == null ? null : String(topic.topic_id),
        userId: owner?.id || null,
        userName: owner?.alias || "prompt-inbox",
        messageId: `prompt-inbox:${Date.now()}`,
        text: claimed.prompt,
        source: `prompt-inbox:${claimed.fileName}`,
      };
      rememberRetryPrompt(envelope);
      dispatchTopicRun(config, telegram, inFlight, topic, envelope);
      console.error(`prompt inbox queued file=${claimed.path} topic=${topic.name}`);
      return true;
    },
  });
}

async function configureBotCommands(telegram, config) {
  const commands = [
    {
      command: "help",
      description: "Show telepi gateway commands",
    },
    {
      command: "compact",
      description: "Compact the current pi session with an optional prompt",
    },
    {
      command: "retry",
      description: "Retry the last prompt in this topic",
    },
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
  for (const chatId of commandChatIds(config)) {
    scopes.push({ type: "chat", chat_id: chatId });
  }
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

function reloadConfig(previousConfig, path) {
  try {
    return readConfig(path);
  } catch (error) {
    console.error(`config reload failed: ${error.message}`);
    return previousConfig;
  }
}

function isHelpCommand(text) {
  return /^\/help(?:@\S+)?(?:\s|$)/i.test(String(text || "").trim());
}

function isRetryCommand(text) {
  return /^\/retry(?:@\S+)?(?:\s|$)/i.test(String(text || "").trim());
}

function isGatewayCommand(text) {
  return /^\/(?:help|retry|compact)(?:@\S+)?(?:\s|$)/i.test(String(text || "").trim());
}

function retryKey(envelope) {
  return `${envelope.chatId}:${envelope.topicId}`;
}

function rememberRetryPrompt(envelope) {
  if (envelope.source === AUTO_RETRY_SOURCE || isGatewayCommand(envelope.text)) return;
  if (!String(envelope.text || "").trim() && !envelope.telegramAttachments?.length && !envelope.attachments?.length) return;
  lastPromptByTopic.set(retryKey(envelope), {
    ...envelope,
    telegramAttachments: envelope.telegramAttachments ? [...envelope.telegramAttachments] : undefined,
    attachments: envelope.attachments ? [...envelope.attachments] : undefined,
    replyTo: envelope.replyTo ? { ...envelope.replyTo } : undefined,
  });
}

async function handleHelpCommand(telegram, config, topic, envelope) {
  const inboxEnabled = Boolean(process.env.TELEPI_PROMPT_INBOX_DIR?.trim());
  const lines = [
    "telepi gateway commands:",
    "/help — show this message",
    "/compact [instructions] — compact this topic's pi session",
    "/retry — rerun the last prompt in this topic",
    inboxEnabled
      ? `Prompt inbox: enabled${process.env.TELEPI_PROMPT_INBOX_TOPIC ? ` (default topic: ${process.env.TELEPI_PROMPT_INBOX_TOPIC})` : ""}`
      : "Prompt inbox: disabled (set TELEPI_PROMPT_INBOX_DIR to enable)",
  ];
  await sendLongMessage(telegram, {
    chatId: envelope.chatId,
    topicId: envelope.topicId,
    replyToMessageId: envelope.messageId,
    text: lines.join("\n"),
    quote: true,
  });
}

async function handleRetryCommand(config, telegram, inFlight, topic, envelope, active) {
  if (active) {
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: envelope.messageId,
      text: `Cannot retry ${topic.name} while it is running.`,
      quote: true,
    });
    return;
  }
  const previous = lastPromptByTopic.get(retryKey(envelope));
  if (!previous) {
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: envelope.messageId,
      text: "No previous prompt remembered for this topic.",
      quote: true,
    });
    return;
  }
  const retryEnvelope = {
    ...previous,
    updateId: envelope.updateId,
    messageId: envelope.messageId,
    userId: envelope.userId,
    userName: envelope.userName,
    source: `retry of Telegram message ${previous.messageId}`,
  };
  dispatchTopicRun(config, telegram, inFlight, topic, retryEnvelope);
}

function startTopicMessage(config, telegram, topic, envelope) {
  let resolveReady;
  const run = {
    abort: undefined,
    steer: undefined,
    acceptsSteering: false,
    cancelled: false,
    cancelToken: randomBytes(9).toString("base64url"),
    cancelMessage: undefined,
    cancelAttachTimer: undefined,
    cancelButtonAttached: false,
    cancelGeneration: 0,
    currentReplyToMessageId: envelope.messageId,
    displayedMessageCount: 0,
    telegramDeliveryCount: 0,
    lastModelError: undefined,
    recoveredPromptTimeout: false,
    topic: {
      name: topic.name,
      agent: topic.agent,
      sessionId: topic.session_id,
    },
    envelope: serializeQueueEnvelope(envelope),
    startedAt: new Date().toISOString(),
    pending: [],
    steered: [],
    pendingDrained: false,
    displayQueue: Promise.resolve(),
    toolDisplayMessages: new Map(),
    ready: undefined,
    readyError: undefined,
    readySettled: false,
    resolveReady: undefined,
    promise: undefined,
  };
  run.ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  run.resolveReady = () => {
    if (run.readySettled) return;
    run.readySettled = true;
    resolveReady();
  };
  run.promise = (async () => {
    const hydratedEnvelope = await hydrateEnvelopeMedia(telegram, config, envelope).catch((error) => {
      console.error(`media hydration failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.stack || error.message}`);
      return envelope;
    });
    return handleTopicMessage(config, telegram, topic, hydratedEnvelope, run);
  })().catch(async (error) => {
    run.readyError = error;
    run.resolveReady();
    console.error(`message handling failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.stack || error.message}`);
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: envelope.messageId,
      text: `Failed to handle message for ${topic.name}: ${error.message}`,
      quote: true,
    }).catch((sendError) => {
      console.error(`failure response failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${sendError.message}`);
    });
  });
  return run;
}

function dispatchTopicRun(config, telegram, inFlight, topic, envelope, pending = []) {
  const key = `${envelope.chatId}:${envelope.topicId}`;
  const run = startTopicMessage(config, telegram, topic, envelope);
  run.pending.push(...pending);
  inFlight.set(key, run);
  markPendingQueueDirty();
  run.promise.finally(() => {
    // A steer is only durable in pi's transcript after its user message_start.
    // Replay any accepted-but-undelivered steers as ordinary queued messages
    // instead of losing them when a wedged run is closed.
    if (run.steered.length) {
      run.pending.unshift(...run.steered.splice(0));
      markPendingQueueDirty();
    }
    if (inFlight.get(key) === run) {
      inFlight.delete(key);
      markPendingQueueDirty();
    }
    drainPendingEnvelopes(config, telegram, inFlight, topic, run);
  });
  return run;
}

function drainPendingEnvelopes(config, telegram, inFlight, topic, run) {
  run.pendingDrained = true;
  if (!run.pending.length) return;
  const queued = run.pending.splice(0);
  const key = `${queued[0].chatId}:${queued[0].topicId}`;
  const active = inFlight.get(key);
  if (active && active !== run) {
    active.pending.push(...queued);
    markPendingQueueDirty();
    return;
  }
  const [next, ...rest] = queued;
  markPendingQueueDirty();
  console.error(`dispatching queued message chat=${next.chatId} topic=${next.topicId} agent=${topic.agent} message=${next.messageId} remaining=${rest.length}`);
  dispatchTopicRun(config, telegram, inFlight, topic, next, rest);
}

// Messages that arrive while the run can't be steered (compaction, the
// cleanup window after agent_end) are queued and replayed as regular
// messages once the run finishes. The 👀 reaction tells the user their
// message was heard and will be answered later.
async function queueEnvelopeForRun(config, telegram, inFlight, topic, run, envelope) {
  run.pending.push(envelope);
  markPendingQueueDirty();
  console.error(`queued message chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} message=${envelope.messageId}`);
  if (run.pendingDrained) {
    drainPendingEnvelopes(config, telegram, inFlight, topic, run);
  }
  if (envelope.queueAck === false) return;
  await setLoggedMessageReaction(telegram, {
    chatId: envelope.chatId,
    messageId: envelope.messageId,
    emoji: "👀",
    topicId: envelope.topicId,
    agent: topic.agent,
    reason: "message_queued",
  }).catch((error) => {
    console.error(`queued-message reaction failed chat=${envelope.chatId} message=${envelope.messageId}: ${error.message}`);
  });
}

async function setLoggedMessageReaction(telegram, { chatId, topicId, messageId, emoji, agent, reason }) {
  console.error(`setting reaction chat=${chatId} topic=${topicId || "none"} message=${messageId} agent=${agent || "unknown"} emoji=${emoji || "none"} reason=${reason || "unspecified"}`);
  const result = await telegram.setMessageReaction({ chatId, messageId, emoji });
  console.error(`set reaction chat=${chatId} topic=${topicId || "none"} message=${messageId} agent=${agent || "unknown"} emoji=${emoji || "none"} reason=${reason || "unspecified"}`);
  return result;
}

async function steerRunningTopic(config, telegram, inFlight, topic, envelope, active) {
  const compactInstructions = parseCompactCommand(envelope.text);
  if (compactInstructions !== null) {
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: envelope.messageId,
      text: `Cannot compact ${topic.name} while it is running. Send /compact after the current run finishes.`,
      quote: true,
    }).catch((error) => {
      console.error(`busy compact response failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.message}`);
    });
    return;
  }

  const hydratedEnvelope = await hydrateEnvelopeMedia(telegram, config, envelope).catch((error) => {
    console.error(`steering media hydration failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.stack || error.message}`);
    return envelope;
  });
  try {
    await active.ready;
    if (active.readyError) throw active.readyError;
    if (!active.acceptsSteering || !active.steer) throw new Error("topic is not accepting steering");
    active.steered.push(hydratedEnvelope);
    markPendingQueueDirty();
    try {
      await active.steer(hydratedEnvelope);
    } catch (error) {
      active.steered = active.steered.filter((item) => item !== hydratedEnvelope);
      markPendingQueueDirty();
      throw error;
    }
    console.error(`steered chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} message=${envelope.messageId}`);
  } catch (error) {
    console.error(`steering unavailable chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.message}`);
    await queueEnvelopeForRun(config, telegram, inFlight, topic, active, hydratedEnvelope);
  }
}

function shouldRecoverRpcPromptTimeout(result, active, envelope) {
  return Boolean(
    !result.ok &&
    result.code === 1 &&
    /Timeout waiting for response to prompt/i.test(result.stderr || "") &&
    !active.recoveredPromptTimeout &&
    envelope.source !== AUTO_RETRY_SOURCE,
  );
}

async function unlinkTopicSessionWithCli(topic, newSessionId) {
  const args = [
    resolve("bin/telepi.js"),
    "-c", configPath || "config/telepi.yaml",
    "session:unlink",
    "--name", topic.name,
    "--session-id", newSessionId,
    "--reason", "Automatic recovery after pi RPC prompt timeout",
  ];
  await execFileAsync(process.execPath, args, { cwd: resolve(".") });
  return { ok: true };
}

function freshSessionIdForTopic(topic, date = new Date()) {
  return `${topic.agent}-${topic.topic_id}-${compactTimestamp(date)}`;
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function handleTopicMessage(config, telegram, topic, envelope, active) {
  console.error(`routing chat=${envelope.chatId} topic=${envelope.topicId} to ${topic.agent}/${topic.session_id}`);
  const compactInstructions = parseCompactCommand(envelope.text);
  if (compactInstructions !== null) {
    active.acceptsSteering = false;
    active.resolveReady();
    await handleCompactCommand(config, telegram, topic, envelope, compactInstructions);
    return;
  }
  const startedAt = Date.now();
  const stopWorkingIndicator = startWorkingIndicator(config, telegram, topic, envelope);
  const displayMessages = configuredDisplayMessages(config, topic);
  const useDefaultAssistantDisplay = !hasConfiguredDisplayMessages(config, topic);
  let result;
  try {
    const piRun = await startPiForTopic(config, topic, envelope, {
      onText: useDefaultAssistantDisplay
        ? (text) => sendStreamingText(telegram, active, envelope, text)
        : undefined,
      onEvent: (event) => {
        acknowledgeSteeredEnvelope(active, event);
        updateReplyAnchorFromPiEvent(active, event);
        if (isTelegramDeliveryEvent(event)) active.telegramDeliveryCount += 1;
        const modelError = modelErrorFromPiEvent(event);
        if (modelError) active.lastModelError = modelError;
        if (!useDefaultAssistantDisplay) {
          queueDisplayPiEvent(config, telegram, active, envelope, event, displayMessages);
        }
      },
    });
    active.abort = piRun.abort;
    active.steer = piRun.steer;
    active.acceptsSteering = true;
    active.resolveReady();
    result = await piRun.promise;
  } finally {
    stopWorkingIndicator();
    active.acceptsSteering = false;
    active.abort = undefined;
    active.steer = undefined;
    active.resolveReady();
    await active.displayQueue.catch((error) => {
      console.error(`display queue failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.stack || error.message}`);
    });
    await clearCancelButton(telegram, active);
  }
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`completed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} ok=${result.ok} code=${result.code} duration=${durationSeconds}s`);
  if (shouldRecoverRpcPromptTimeout(result, active, envelope)) {
    const newSessionId = freshSessionIdForTopic(topic);
    const recovered = await unlinkTopicSessionWithCli(topic, newSessionId).catch((error) => ({ ok: false, error }));
    if (recovered.ok) {
      topic.session_id = newSessionId;
      active.recoveredPromptTimeout = true;
      active.pending.unshift({ ...envelope, source: AUTO_RETRY_SOURCE });
      console.error(`recovered rpc prompt timeout chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} new_session=${newSessionId}; retrying message=${envelope.messageId}`);
      return;
    }
    console.error(`rpc prompt timeout recovery failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${recovered.error?.stack || recovered.error?.message || recovered.error}`);
  }
  if (active.cancelled) {
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: active.currentReplyToMessageId || envelope.messageId,
      text: `Cancelled ${topic.name}.`,
      quote: true,
    });
    return;
  }
  // A turn that died on a model/API error must say so — silence or a
  // "completed without output" placeholder hides real failures (stalled
  // inference, timeouts) from the user.
  if (result.ok && active.lastModelError) {
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: active.currentReplyToMessageId || envelope.messageId,
      text: `⚠️ ${topic.agent} hit a model error: ${active.lastModelError}`,
      quote: true,
    });
    return;
  }
  // A turn that delivered its output through a tool (photo, buttons, …) is
  // not "without output" — suppress the placeholder for those.
  if (result.ok && (result.streamedTextCount > 0 || active.displayedMessageCount > 0 || active.telegramDeliveryCount > 0)) return;
  const output = result.stdout || result.stderr;
  const text = result.ok
    ? (output || `${topic.agent} completed without output.`)
    : `pi session failed (${result.code})\n\n${output || "No output"}`;
  await sendLongMessage(telegram, {
    chatId: envelope.chatId,
    topicId: envelope.topicId,
    replyToMessageId: active.currentReplyToMessageId || envelope.messageId,
    text,
    quote: !result.ok || !output,
  });
}

async function handleCallbackQuery(config, telegram, inFlight, query) {
  const userId = query.from?.id == null ? null : String(query.from.id);
  if (!isAllowedUser(config, userId)) {
    await telegram.answerCallbackQuery({
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
    await handleButtonCallback(config, telegram, inFlight, query, buttonRef);
    return;
  }

  const token = parseCancelCallbackData(query.data);
  if (!token) {
    await telegram.answerCallbackQuery({ callbackQueryId: query.id }).catch((error) => {
      console.error(`answer unknown callback failed: ${error.message}`);
    });
    return;
  }

  const active = [...inFlight.values()].find((run) => run.cancelToken === token);
  if (!active) {
    await telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "This run is no longer active.",
    }).catch((error) => {
      console.error(`answer stale cancel failed: ${error.message}`);
    });
    await removeCallbackMessageMarkup(telegram, query).catch((error) => {
      console.error(`remove stale cancel button failed: ${error.message}`);
    });
    return;
  }

  try {
    await active.ready;
    if (active.readyError) throw active.readyError;
    if (!active.abort) throw new Error("run is not accepting cancellation");
    await telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "Cancelling...",
    });
    active.cancelled = true;
    await active.abort();
    await clearCancelButton(telegram, active);
    console.error(`cancel requested token=${token} user=${userId}`);
  } catch (error) {
    console.error(`cancel failed token=${token}: ${error.stack || error.message}`);
    await telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: `Cancel failed: ${error.message}`,
      showAlert: true,
    }).catch((sendError) => {
      console.error(`answer cancel failure failed: ${sendError.message}`);
    });
  }
}

async function handleButtonCallback(config, telegram, inFlight, query, buttonRef) {
  const callback = findButtonCallback(config, buttonRef);
  if (!callback) {
    await telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "This button is no longer available.",
    }).catch((error) => {
      console.error(`answer unknown button failed: ${error.message}`);
    });
    await removeCallbackMessageMarkup(telegram, query).catch((error) => {
      console.error(`remove unknown button markup failed: ${error.message}`);
    });
    return;
  }

  const topic = findTopic(config, callback.chat_id, callback.topic_id);
  if (!topic || topic.enabled === false) {
    await telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "This topic is not routed here.",
      showAlert: true,
    }).catch((error) => {
      console.error(`answer unrouted button failed: ${error.message}`);
    });
    console.error(`ignored button for unknown topic chat=${callback.chat_id} topic=${callback.topic_id}`);
    return;
  }

  // Action buttons are handled by the gateway itself (the agent may be
  // blocked mid-turn, e.g. cancelling one of several running generations) —
  // they never route back to the model as a user message.
  if (callback.action) {
    await handleButtonAction(telegram, query, callback);
    return;
  }

  // Ack without awaiting so the inFlight check/registration below stays
  // synchronous; otherwise concurrent clicks could start duplicate runs.
  const answered = telegram.answerCallbackQuery({
    callbackQueryId: query.id,
    text: callback.label ? `${callback.label}`.slice(0, 180) : "Selected",
  }).catch((error) => {
    console.error(`answer button callback failed: ${error.message}`);
  });
  // Buttons are one-shot by default: drop the keyboard so the choice can't
  // be re-tapped. Records marked sticky keep theirs (e.g. an image
  // agent's Details/Regenerate/upscale buttons stay usable across taps).
  if (!callback.sticky) {
    removeCallbackMessageMarkup(telegram, query).catch((error) => {
      console.error(`remove tapped button markup failed: ${error.message}`);
    });
  }

  const envelope = envelopeFromButtonCallback(query, callback);
  const key = `${envelope.chatId}:${envelope.topicId}`;
  const active = inFlight.get(key);
  if (active) {
    await answered;
    await steerRunningTopic(config, telegram, inFlight, topic, envelope, active);
    return;
  }

  dispatchTopicRun(config, telegram, inFlight, topic, envelope);
  await answered;
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

function parseCancelCallbackData(data) {
  const match = String(data || "").match(/^telepi:cancel:([A-Za-z0-9_-]+)$/);
  return match?.[1] || null;
}

function parseButtonCallbackData(data) {
  const match = String(data || "").match(/^telepi:btn:([A-Za-z0-9_-]+):(\d+)$/);
  return match ? { token: match[1], index: Number(match[2]) } : null;
}

function findButtonCallback(config, { token, index }) {
  const path = buttonCallbackStorePath(config);
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

function buttonCallbackStorePath(config) {
  return resolve(config.project.cache_dir, "button-callbacks.jsonl");
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
      userName: query.message?.from?.first_name || query.message?.from?.username || "",
    } : undefined,
  };
}

async function sendStreamingText(telegram, active, envelope, text) {
  const previous = active.cancelMessage;
  active.cancelGeneration += 1;
  active.cancelMessage = undefined;
  active.cancelButtonAttached = false;
  clearTimeout(active.cancelAttachTimer);
  active.cancelAttachTimer = undefined;
  if (previous) {
    await clearTelegramMessageReplyMarkup(telegram, previous).catch((error) => {
      if (!isReplyMarkupAlreadyClear(error)) {
        console.error(`clear previous cancel button failed chat=${previous.chatId} message=${previous.messageId}: ${error.message}`);
      }
    });
  }

  const sentMessages = await sendLongMessage(telegram, {
    chatId: envelope.chatId,
    topicId: envelope.topicId,
    replyToMessageId: active.currentReplyToMessageId || envelope.messageId,
    text,
  });
  const latest = sentMessages.at(-1);
  active.displayedMessageCount += sentMessages.length;
  if (!active.cancelled && latest?.message_id) {
    active.cancelMessage = {
      chatId: String(latest.chat?.id || envelope.chatId),
      messageId: String(latest.message_id),
    };
    scheduleCancelButton(telegram, active);
  }
  return sentMessages;
}

function queueDisplayPiEvent(config, telegram, active, envelope, event, displayMessages) {
  const items = displayItemsFromPiEvent(event).filter((item) => isDisplayMessageAllowed(displayMessages, item.type));
  for (const item of items) {
    active.displayQueue = active.displayQueue
      .catch(() => undefined)
      .then(() => displayPiItem(telegram, active, envelope, item));
  }
}

async function displayPiItem(telegram, active, envelope, item) {
  if (item.toolCallId) {
    await sendOrEditToolDisplayText(telegram, active, envelope, item);
    return;
  }
  await sendStreamingText(telegram, active, envelope, item.text);
}

async function sendOrEditToolDisplayText(telegram, active, envelope, item) {
  const existing = active.toolDisplayMessages.get(item.toolCallId);
  if (!existing) {
    const sentMessages = await sendStreamingText(telegram, active, envelope, item.text);
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
  await editTelegramMessageText(telegram, {
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
    String(active.cancelMessage.messageId) === String(message.messageId),
  );
}

function configuredDisplayMessages(config, topic) {
  return configuredDisplayMessagesFor(config, topic) || ["assistant/message"];
}

function hasConfiguredDisplayMessages(config, topic) {
  return configuredDisplayMessagesFor(config, topic) != null;
}

function configuredDisplayMessagesFor(config, topic) {
  return topic.display_messages || config.agents?.[topic.agent]?.display_messages || config.telegram.display_messages;
}

function isDisplayMessageAllowed(displayMessages, type) {
  const values = displayMessages.map((value) => String(value).trim()).filter(Boolean);
  if (!values.length) return false;
  if (values.includes(type)) return true;
  const category = type.split("/")[0];
  return values.includes(category);
}

// Tool results that carry Telegram message ids prove the tool already
// delivered user-visible output (telepi_send_image, telepi_buttons, agent
// extensions like an image generator's generate_image).
// An assistant message that ended with stopReason "error" carries the real
// failure (e.g. "Request timed out." from a stalled model server). Cancels
// (stopReason "aborted") are not errors and are handled separately.
function modelErrorFromPiEvent(event) {
  if (event?.type !== "message_end") return null;
  const message = event.message;
  if (message?.role !== "assistant" || message.stopReason !== "error") return null;
  return String(message.errorMessage || "unknown model error");
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
    return text ? { type: "assistant/reasoning", text: `_${text}_` } : null;
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
  return {
    type: `custom/${customType}`,
    text: formatCustomText(customType, text, title),
  };
}

function toolDisplayItemFromEvent(event) {
  if (event.type === "tool_execution_update") {
    const customType = event.partialResult?.details?.customType;
    const text = textFromPiContent(event.partialResult?.content) || firstTextValue(event.partialResult, ["text", "message"]);
    if (customType && text) {
      const title = customDisplayTitle(event.partialResult, customType);
      return { type: `custom/${customType}`, text: formatCustomText(customType, text, title), toolCallId: event.toolCallId, final: false };
    }
  }
  if (event.type === "tool_execution_end") {
    const customType = event.result?.details?.customType;
    const text = textFromPiContent(event.result?.content) || firstTextValue(event.result, ["text", "message"]);
    if (customType && text) {
      const title = customDisplayTitle(event.result, customType);
      return { type: `custom/${customType}`, text: formatCustomText(customType, text, title), toolCallId: event.toolCallId, final: true };
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
  return firstStringValue(
    message,
    ["telepiTitle", "title"],
  ) || firstStringValue(
    details && typeof details === "object" ? details : undefined,
    ["telepiTitle", "title"],
  ) || (customType === "message" ? "" : `custom/${customType}`);
}

function formatCustomText(customType, text, title) {
  if (!title) return text;
  return `${title}\n${text}`;
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

function acknowledgeSteeredEnvelope(active, event) {
  if (event?.type !== "message_start" || event.message?.role !== "user") return;
  const messageId = telegramMessageIdFromPiMessage(event.message);
  if (!messageId) return;
  const index = active.steered.findIndex((envelope) => String(envelope.messageId) === String(messageId));
  if (index < 0) return;
  active.steered.splice(index, 1);
  markPendingQueueDirty();
}

function updateReplyAnchorFromPiEvent(active, event) {
  if (event?.type !== "message_start" || event.message?.role !== "user") return;
  const messageId = telegramMessageIdFromPiMessage(event.message);
  if (messageId) active.currentReplyToMessageId = messageId;
}

function telegramMessageIdFromPiMessage(message) {
  const text = (message.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("\n");
  const match = text.match(/^telegram_message_id=(.+)$/m);
  return match?.[1]?.trim() || null;
}

function scheduleCancelButton(telegram, active) {
  clearTimeout(active.cancelAttachTimer);
  const generation = active.cancelGeneration;
  active.cancelAttachTimer = setTimeout(() => {
    const message = active.cancelMessage;
    if (!message || active.cancelled || !active.abort) return;
    telegram.editMessageReplyMarkup({
      chatId: message.chatId,
      messageId: message.messageId,
      replyMarkup: cancelButtonMarkup(active.cancelToken),
    }).then(() => {
      if (active.cancelGeneration === generation && active.cancelMessage === message) {
        active.cancelButtonAttached = true;
      } else {
        return clearTelegramMessageReplyMarkup(telegram, message).catch((error) => {
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
    inline_keyboard: [
      [
        {
          text: "Cancel",
          callback_data: `telepi:cancel:${token}`,
        },
      ],
    ],
  };
}

async function clearCancelButton(telegram, active) {
  active.cancelGeneration += 1;
  clearTimeout(active.cancelAttachTimer);
  active.cancelAttachTimer = undefined;
  const message = active.cancelMessage;
  active.cancelMessage = undefined;
  active.cancelButtonAttached = false;
  if (!message) return;
  await clearTelegramMessageReplyMarkup(telegram, message).catch((error) => {
    if (!isReplyMarkupAlreadyClear(error)) {
      console.error(`clear cancel button failed chat=${message.chatId} message=${message.messageId}: ${error.message}`);
    }
  });
}

async function clearTelegramMessageReplyMarkup(telegram, message) {
  await telegram.editMessageReplyMarkup({
    chatId: message.chatId,
    messageId: message.messageId,
  });
}

async function removeCallbackMessageMarkup(telegram, query) {
  if (!query.message?.chat?.id || !query.message?.message_id) return;
  await telegram.editMessageReplyMarkup({
    chatId: String(query.message.chat.id),
    messageId: String(query.message.message_id),
  });
}

function isReplyMarkupAlreadyClear(error) {
  return /message is not modified/i.test(error.message);
}

async function handleCompactCommand(config, telegram, topic, envelope, instructions) {
  const startedAt = Date.now();
  const stopWorkingIndicator = startWorkingIndicator(config, telegram, topic, envelope);
  try {
    // Compaction uses pi's SDK. Run it behind the telepi CLI process boundary so
    // a long-lived gateway never retains an SDK/model registry from before a pi update.
    const outcome = await compactTopicSessionWithCli(topic, instructions);
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (outcome.status === "skipped") {
      console.error(`compact skipped chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} duration=${durationSeconds}s reason=${JSON.stringify(outcome.reason)}`);
      await sendLongMessage(telegram, {
        chatId: envelope.chatId,
        topicId: envelope.topicId,
        replyToMessageId: envelope.messageId,
        text: `Compaction skipped for ${topic.name}: ${outcome.reason}`,
        quote: true,
      });
      return;
    }
    console.error(`compacted chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} duration=${durationSeconds}s`);
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: envelope.messageId,
      text: `Compacted ${topic.name}.\n\nKept from entry: ${outcome.result.firstKeptEntryId}\nTokens before: ${outcome.result.tokensBefore}`,
      quote: true,
    });
  } catch (error) {
    const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`compact failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} duration=${durationSeconds}s: ${error.stack || error.message}`);
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: envelope.messageId,
      text: `Compact failed for ${topic.name}: ${error.message}`,
      quote: true,
    });
  } finally {
    stopWorkingIndicator();
  }
}

async function compactTopicSessionWithCli(topic, instructions) {
  const args = [
    resolve("bin/telepi.js"),
    "-c", configPath || "config/telepi.yaml",
    "session:compact",
    "--topic", topic.name,
    "--json",
  ];
  if (instructions) args.push("--instructions", instructions);

  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: resolve("."),
      maxBuffer: 1024 * 1024,
    });
    const line = stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!line) throw new Error("compaction worker returned no result");
    const outcome = JSON.parse(line);
    if (outcome.status !== "compacted" && outcome.status !== "skipped") {
      throw new Error(`compaction worker returned unknown status: ${outcome.status}`);
    }
    return outcome;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`compaction worker returned invalid JSON: ${error.message}`);
    }
    const workerMessage = String(error.stderr || "").trim().split("\n").filter(Boolean).at(-1);
    if (workerMessage) throw new Error(workerMessage);
    throw error;
  }
}

function startWorkingIndicator(config, telegram, topic, envelope) {
  if (config.telegram.working_indicator !== "typing") return () => undefined;

  let stopped = false;
  const key = `${envelope.chatId}:${envelope.topicId || ""}`;
  const sendTyping = () => {
    if (stopped) return;
    sendCoalescedTyping(telegram, key, {
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
    clearCoalescedTyping(key);
    clearTimeout(burstTimer);
    clearInterval(timer);
  };
}

function sendCoalescedTyping(telegram, key, payload, onError) {
  let state = typingByTopic.get(key);
  if (!state) {
    state = { inFlight: false, pending: undefined };
    typingByTopic.set(key, state);
  }
  state.pending = { payload, onError };
  pumpCoalescedTyping(telegram, key, state);
}

function clearCoalescedTyping(key) {
  const state = typingByTopic.get(key);
  if (!state) return;
  state.pending = undefined;
  if (!state.inFlight) typingByTopic.delete(key);
}

function pumpCoalescedTyping(telegram, key, state) {
  if (state.inFlight || !state.pending) return;
  const next = state.pending;
  state.pending = undefined;
  state.inFlight = true;
  telegram.sendChatAction(next.payload)
    .catch((error) => next.onError?.(error))
    .finally(() => {
      state.inFlight = false;
      if (state.pending) {
        pumpCoalescedTyping(telegram, key, state);
      } else {
        typingByTopic.delete(key);
      }
    });
}

function initPendingQueuePersistence(config, inFlight) {
  const queuePath = resolve(config.project.cache_dir, "gateway-inflight-debug.json");
  mkdirSync(resolve(config.project.cache_dir), { recursive: true });
  queuePersistence = {
    path: queuePath,
    inFlight,
    dirty: false,
    timer: setInterval(() => flushPendingQueueSnapshot("interval", { force: true, quiet: true }), 60_000),
    exiting: false,
  };
  queuePersistence.timer.unref?.();
  process.once("SIGINT", () => exitAfterQueueSnapshot("SIGINT"));
  process.once("SIGTERM", () => exitAfterQueueSnapshot("SIGTERM"));
  process.once("exit", () => flushPendingQueueSnapshot("exit", { force: true, quiet: true }));
}

function markPendingQueueDirty() {
  if (queuePersistence) queuePersistence.dirty = true;
}

function exitAfterQueueSnapshot(signal) {
  if (queuePersistence?.exiting) return;
  if (queuePersistence) queuePersistence.exiting = true;
  flushPendingQueueSnapshot(signal, { force: true });
  process.exit(0);
}

function flushPendingQueueSnapshot(reason, options = {}) {
  if (!queuePersistence) return;
  if (!options.force && !queuePersistence.dirty) return;
  const snapshot = serializePendingQueue(queuePersistence.inFlight);
  writePendingQueueSnapshot(queuePersistence.path, snapshot);
  queuePersistence.dirty = false;
  if (!options.quiet) {
    console.error(`persisted gateway inflight debug snapshot reason=${reason} active=${snapshot.active.length} pending=${snapshot.pendingCount}`);
  }
}

function serializePendingQueue(inFlight) {
  const active = [];
  for (const [key, run] of inFlight.entries()) {
    const [chatId, topicId = ""] = key.split(":");
    active.push({
      key,
      chatId,
      topicId,
      topic: run.topic,
      startedAt: run.startedAt,
      ageSeconds: run.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(run.startedAt)) / 1000)) : null,
      acceptsSteering: Boolean(run.acceptsSteering),
      cancelled: Boolean(run.cancelled),
      readySettled: Boolean(run.readySettled),
      readyError: run.readyError ? String(run.readyError.stack || run.readyError.message || run.readyError) : null,
      displayedMessageCount: run.displayedMessageCount || 0,
      telegramDeliveryCount: run.telegramDeliveryCount || 0,
      lastModelError: run.lastModelError || null,
      active: run.envelope,
      pending: (run.pending || []).map(serializeQueueEnvelope),
      steeredAwaitingDelivery: (run.steered || []).map(serializeQueueEnvelope),
    });
  }
  return {
    version: 2,
    purpose: "debug snapshot only; not restored or replayed by gateway",
    updatedAt: new Date().toISOString(),
    active,
    pendingCount: active.reduce((sum, item) => sum + item.pending.length, 0),
  };
}

function serializeQueueEnvelope(envelope) {
  return {
    ...envelope,
    chatId: envelope.chatId == null ? envelope.chatId : String(envelope.chatId),
    topicId: envelope.topicId == null ? envelope.topicId : String(envelope.topicId),
    messageId: envelope.messageId == null ? envelope.messageId : String(envelope.messageId),
    userId: envelope.userId == null ? envelope.userId : String(envelope.userId),
  };
}

function writePendingQueueSnapshot(path, snapshot) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}

// Reaction updates carry only chat_id + message_id (no topic), so the gateway
// keeps a rolling index of the messages it sent to route reactions back to
// the owning topic. Survives restarts; pruned at startup.
let sentMessageIndexPath;

function initSentMessageIndex(config) {
  sentMessageIndexPath = resolve(config.project.cache_dir, "sent-messages.jsonl");
  mkdirSync(resolve(config.project.cache_dir), { recursive: true });
  if (!existsSync(sentMessageIndexPath)) return;
  const lines = readFileSync(sentMessageIndexPath, "utf8").split("\n").filter(Boolean);
  if (lines.length > 4000) {
    writeFileSync(sentMessageIndexPath, lines.slice(-2000).join("\n") + "\n");
  }
}

function recordSentMessages(message, sentMessages) {
  if (!sentMessageIndexPath) return;
  for (const sent of sentMessages) {
    if (!sent?.message_id) continue;
    appendFileSync(sentMessageIndexPath, JSON.stringify({
      chat_id: String(sent.chat?.id || message.chatId),
      message_id: String(sent.message_id),
      topic_id: message.topicId == null ? null : String(message.topicId),
      text: String(sent.text || message.text || "").slice(0, 150),
    }) + "\n");
  }
}

function findSentMessageRecord(chatId, messageId) {
  if (!sentMessageIndexPath || !existsSync(sentMessageIndexPath)) return null;
  const lines = readFileSync(sentMessageIndexPath, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const record = JSON.parse(lines[i]);
      if (record.chat_id === String(chatId) && record.message_id === String(messageId)) return record;
    } catch {}
  }
  return null;
}

function reactionEmojis(reactions) {
  return (reactions || []).map((r) => r.emoji || r.custom_emoji_id || "?");
}

async function handleMessageReaction(config, telegram, inFlight, reaction) {
  const userId = String(reaction.user?.id || "");
  if (!isAllowedUser(config, userId)) return;
  const chatId = String(reaction.chat.id);
  const messageId = String(reaction.message_id);
  const record = findSentMessageRecord(chatId, messageId);
  if (!record) {
    console.error(`ignored reaction to unindexed message chat=${chatId} message=${messageId}`);
    return;
  }
  const topic = findTopic(config, chatId, record.topic_id);
  if (!topic || topic.enabled === false) return;
  const oldEmojis = reactionEmojis(reaction.old_reaction);
  const newEmojis = reactionEmojis(reaction.new_reaction);
  const added = newEmojis.filter((e) => !oldEmojis.includes(e));
  const removed = oldEmojis.filter((e) => !newEmojis.includes(e));
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
  const key = `${chatId}:${record.topic_id}`;
  const active = inFlight.get(key);
  if (active) {
    await steerRunningTopic(config, telegram, inFlight, topic, envelope, active);
    return;
  }
  dispatchTopicRun(config, telegram, inFlight, topic, envelope);
}

async function sendLongMessage(telegram, message) {
  const chunks = splitMessage(message.text);
  const sentMessages = [];
  for (const [index, chunk] of chunks.entries()) {
    const quoted = Boolean(message.quote);
    const converted = quoted ? null : toTelegramMarkdownV2(chunk);
    const payload = {
      chatId: message.chatId,
      topicId: message.topicId,
      replyToMessageId: index === 0 ? message.replyToMessageId : undefined,
      text: converted ?? chunk,
      parseMode: converted ? "MarkdownV2" : undefined,
      entities: quoted ? blockquoteEntities(chunk) : undefined,
      replyMarkup: index === chunks.length - 1 ? message.replyMarkup : undefined,
    };
    try {
      sentMessages.push(await sendMessageWithRateLimitRetry(telegram, payload));
    } catch (error) {
      if (isTelegramRateLimited(error)) {
        console.error(`send message rate limited after retries, dropping ${chunks.length - index} chunk(s) chat=${message.chatId} topic=${message.topicId}: ${error.message}`);
        break;
      } else if (payload.replyToMessageId && /reply|replied|message to be replied/i.test(error.message)) {
        console.error(`reply target unavailable chat=${message.chatId} topic=${message.topicId} message=${payload.replyToMessageId}; retrying without reply`);
        const sent = await sendTelegramMessageOrDropOnRateLimit(telegram, { ...payload, replyToMessageId: undefined }, message);
        if (!sent) break;
        sentMessages.push(sent);
      } else if (payload.entities && /entities|entity/i.test(error.message)) {
        console.error(`blockquote entity failed chat=${message.chatId} topic=${message.topicId}; retrying as plain text: ${error.message}`);
        const sent = await sendTelegramMessageOrDropOnRateLimit(telegram, { ...payload, entities: undefined }, message);
        if (!sent) break;
        sentMessages.push(sent);
      } else if (payload.parseMode && /parse entities|can't parse entities|reserved and must be escaped/i.test(error.message)) {
        console.error(`MarkdownV2 parse failed after conversion chat=${message.chatId} topic=${message.topicId}; retrying as plain text: ${error.message}`);
        const sent = await sendTelegramMessageOrDropOnRateLimit(telegram, { ...payload, parseMode: undefined, text: chunk }, message);
        if (!sent) break;
        sentMessages.push(sent);
      } else {
        throw error;
      }
    }
  }
  recordSentMessages(message, sentMessages);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function editTelegramMessageText(telegram, message) {
  const text = message.text.length > 3900 ? `${message.text.slice(0, 3890)}\n[truncated]` : message.text;
  const converted = toTelegramMarkdownV2(text);
  const payload = {
    chatId: message.chatId,
    messageId: message.messageId,
    text: converted ?? text,
    parseMode: converted ? "MarkdownV2" : undefined,
    replyMarkup: message.replyMarkup,
  };
  try {
    await telegram.editMessageText(payload);
  } catch (error) {
    if (payload.parseMode && /parse entities|can't parse entities|reserved and must be escaped/i.test(error.message)) {
      try {
        await telegram.editMessageText({ ...payload, parseMode: undefined, text });
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

function isAllowedUser(config, userId) {
  const allowed = config.telegram.allowed_user_ids || [];
  if (!allowed.length || allowed.includes("*")) return true;
  return userId != null && allowed.includes(String(userId));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

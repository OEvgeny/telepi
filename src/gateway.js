#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createReloadingConfigReader, findTopicByName, resolveTopicSession, setTopicSessionId } from "./config.js";
import { createTelegramAdapter } from "./telegram/adapter.js";
import { parseCompactCommand } from "./pi/compact.js";
import { normalizeBrokerSubmitRequest, resolveBrokerTarget, createBrokerEnvelope } from "./broker-message.js";
import { resolveBrokerSocketPath, startBrokerIpcServer } from "./broker-ipc.js";
import { normalizePromptInboxInterval, startPromptInboxPolling } from "./prompt-inbox.js";
import { acceptSdkRpcConnection, startPiForTopic } from "./pi/sdk-driver.js";
import { acknowledgeTopicMessageDelivery, topicMessageDeliveryId } from "./pi/topic-spec.js";
import { installTimestampedConsole } from "./logging.js";

installTimestampedConsole();

const execFileAsync = promisify(execFile);

const configPath = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]
  : undefined;

const AUTO_RETRY_SOURCE = "auto-rpc-timeout-retry";
const lastPromptByTopic = new Map();
let queuePersistence;

async function main() {
  const getConfig = createReloadingConfigReader(configPath, {
    onError: (error) => console.error(`config reload failed: ${error.message}`),
  });
  const config = getConfig();
  const telegram = await createTelegramAdapter(config);
  const inFlight = new Map();
  initPendingQueuePersistence(config, inFlight);
  await startBrokerApi(getConfig, telegram, inFlight);
  startConfiguredPromptInbox(getConfig, telegram, inFlight);

  await telegram.poll({
    getConfig,
    inFlight,
    onMessage: (configForMessage, topic, envelope) => handleTelegramMessage(
      configForMessage,
      telegram,
      inFlight,
      topic,
      envelope,
    ),
    onButtonMessage: (configForMessage, topic, envelope) => submitTopicEnvelope(
      configForMessage,
      telegram,
      inFlight,
      topic,
      envelope,
    ),
    onReactionMessage: (configForMessage, topic, envelope) => submitTopicEnvelope(
      configForMessage,
      telegram,
      inFlight,
      topic,
      envelope,
    ),
  });
}

async function handleTelegramMessage(config, telegram, inFlight, topic, envelope) {
  const key = `${envelope.chatId}:${envelope.topicId}`;
  const active = inFlight.get(key);
  if (isHelpCommand(envelope.text)) {
    await handleHelpCommand(telegram, config, topic, envelope);
    return;
  }
  if (isRetryCommand(envelope.text)) {
    await handleRetryCommand(config, telegram, inFlight, topic, envelope, active);
    return;
  }
  rememberRetryPrompt(envelope);
  submitTopicEnvelope(config, telegram, inFlight, topic, envelope).catch((error) => {
    console.error(`message submission failed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.stack || error.message}`);
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

async function startBrokerApi(getConfig, telegram, inFlight) {
  const initialConfig = getConfig();
  const socketPath = resolveBrokerSocketPath(initialConfig);
  const submissions = new Map();
  await startBrokerIpcServer({
    socketPath,
    onConnection: acceptSdkRpcConnection,
    onRequest: async (value) => {
      const request = normalizeBrokerSubmitRequest(value);
      const signature = JSON.stringify(request);
      const existing = submissions.get(request.id);
      if (existing) {
        if (existing.signature !== signature) throw new Error(`Broker message id was reused with different content: ${request.id}`);
        return existing.promise;
      }

      const promise = handleBrokerSubmission(getConfig(), telegram, inFlight, request);
      submissions.set(request.id, { signature, promise });
      while (submissions.size > 4096) submissions.delete(submissions.keys().next().value);
      try {
        return await promise;
      } catch (error) {
        if (submissions.get(request.id)?.promise === promise) submissions.delete(request.id);
        throw error;
      }
    },
  });
  console.error(`telepi broker listening socket=${socketPath}`);
}

async function handleBrokerSubmission(config, telegram, inFlight, request) {
  const topic = resolveBrokerTarget(config, request.target);
  let telegramMessageId = "";

  if (request.options.echo) {
    const sentMessages = await sendLongMessage(telegram, {
      chatId: topic.chat_id,
      topicId: topic.topic_id,
      text: request.message.text,
    });
    telegramMessageId = sentMessages[0]?.message_id == null
      ? ""
      : String(sentMessages[0].message_id);
  }

  const envelope = createBrokerEnvelope(topic, request, { telegramMessageId });
  const status = await submitTopicEnvelope(config, telegram, inFlight, topic, envelope);
  console.error(
    `broker accepted id=${request.id} target=${JSON.stringify(topic.name)} agent=${topic.agent} `
    + `origin=${request.origin.kind}:${JSON.stringify(request.origin.name)} status=${status}`,
  );
  return {
    accepted: true,
    id: request.id,
    status,
    topic: topic.name,
    agent: topic.agent,
    sessionId: resolveTopicSession(config, topic).id,
    telegramMessageId: telegramMessageId || null,
  };
}

function sendLongMessage(telegram, message) {
  return telegram.sendLongMessage(message);
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
      sessionId: resolveTopicSession(config, topic).id,
    },
    envelope: serializeQueueEnvelope(envelope),
    startedAt: new Date().toISOString(),
    pending: [],
    steered: [],
    pendingDrained: false,
    displayQueue: Promise.resolve(),
    reasoningDisplayMessage: undefined,
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
    const hydratedEnvelope = await telegram.hydrateEnvelope(config, envelope).catch((error) => {
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

async function submitTopicEnvelope(config, telegram, inFlight, topic, envelope) {
  const key = `${envelope.chatId}:${envelope.topicId}`;
  const active = inFlight.get(key);
  if (active) return steerRunningTopic(config, telegram, inFlight, topic, envelope, active);
  dispatchTopicRun(config, telegram, inFlight, topic, envelope);
  return "started";
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
  console.error(`dispatching queued message chat=${next.chatId} topic=${next.topicId} agent=${topic.agent} message=${topicMessageDeliveryId(next) || "unknown"} remaining=${rest.length}`);
  dispatchTopicRun(config, telegram, inFlight, topic, next, rest);
}

// Messages that arrive while the run can't be steered (compaction, the
// cleanup window after agent_end) are queued and replayed as regular
// messages once the run finishes. The 👀 reaction tells the user their
// message was heard and will be answered later.
async function queueEnvelopeForRun(config, telegram, inFlight, topic, run, envelope) {
  run.pending.push(envelope);
  markPendingQueueDirty();
  console.error(`queued message chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} message=${topicMessageDeliveryId(envelope) || "unknown"}`);
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

function setLoggedMessageReaction(telegram, details) {
  return telegram.setLoggedMessageReaction(details);
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
    return "rejected";
  }

  // A run can inherit backlog from the run before it. Do not steer a newer
  // arrival past those older envelopes: all sources share one FIFO topic queue.
  if (active.pending.length) {
    await queueEnvelopeForRun(config, telegram, inFlight, topic, active, envelope);
    return "queued";
  }

  const hydratedEnvelope = await telegram.hydrateEnvelope(config, envelope).catch((error) => {
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
    console.error(`steered chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} message=${topicMessageDeliveryId(hydratedEnvelope) || "unknown"}`);
    return "steered";
  } catch (error) {
    console.error(`steering unavailable chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent}: ${error.message}`);
    await queueEnvelopeForRun(config, telegram, inFlight, topic, active, hydratedEnvelope);
    return "queued";
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
  console.error(`routing chat=${envelope.chatId} topic=${envelope.topicId} to ${topic.agent}/${resolveTopicSession(config, topic).id}`);
  const compactInstructions = parseCompactCommand(envelope.text);
  if (compactInstructions !== null) {
    active.acceptsSteering = false;
    active.resolveReady();
    await handleCompactCommand(config, telegram, topic, envelope, compactInstructions);
    return;
  }
  const startedAt = Date.now();
  const stopWorkingIndicator = telegram.startWorkingIndicator(config, topic, envelope);
  const displayMessages = configuredDisplayMessages(config, topic);
  const useDefaultAssistantDisplay = !hasConfiguredDisplayMessages(config, topic);
  const streamAssistantMessages = useDefaultAssistantDisplay || telegram.isDisplayMessageAllowed(displayMessages, "assistant/message");
  let result;
  try {
    const piRun = await startPiForTopic(config, topic, envelope, {
      onText: streamAssistantMessages
        ? (text) => telegram.queueAssistantTextDisplay(active, envelope, text)
        : undefined,
      onEvent: (event) => {
        acknowledgeSteeredEnvelope(active, event);
        telegram.resetReasoningDisplayFromPiEvent(active, event);
        telegram.updateReplyAnchorFromPiEvent(active, event);
        if (telegram.isDeliveryEvent(event)) active.telegramDeliveryCount += 1;
        const modelError = modelErrorFromPiEvent(event);
        if (modelError) active.lastModelError = modelError;
        if (!useDefaultAssistantDisplay) {
          telegram.queueDisplayPiEvent(active, envelope, event, displayMessages, {
            excludeTypes: streamAssistantMessages ? ["assistant/message"] : [],
          });
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
    await telegram.clearCancelButton(active);
  }
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`completed chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} ok=${result.ok} code=${result.code} duration=${durationSeconds}s`);
  if (shouldRecoverRpcPromptTimeout(result, active, envelope)) {
    const newSessionId = freshSessionIdForTopic(topic);
    const recovered = await unlinkTopicSessionWithCli(topic, newSessionId).catch((error) => ({ ok: false, error }));
    if (recovered.ok) {
      setTopicSessionId(topic, newSessionId);
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
  if (!result.ok) {
    const output = result.stderr || result.stdout;
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: active.currentReplyToMessageId || envelope.messageId,
      text: `pi session failed (${result.code})\n\n${output || "No output"}`,
      quote: true,
    });
    return;
  }

  // stderr is process diagnostics, never successful assistant output. Provider
  // warnings belong in gateway logs even when the model emits no final text.
  const output = result.stdout;
  await sendLongMessage(telegram, {
    chatId: envelope.chatId,
    topicId: envelope.topicId,
    replyToMessageId: active.currentReplyToMessageId || envelope.messageId,
    text: output || `${topic.agent} completed without output.`,
    quote: !output,
  });
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

function modelErrorFromPiEvent(event) {
  if (event?.type !== "message_end") return null;
  const message = event.message;
  if (message?.role !== "assistant" || message.stopReason !== "error") return null;
  return String(message.errorMessage || "unknown model error");
}

function acknowledgeSteeredEnvelope(active, event) {
  if (event?.type !== "message_start" || event.message?.role !== "user") return;
  if (acknowledgeTopicMessageDelivery(active.steered, event.message)) markPendingQueueDirty();
}

async function handleCompactCommand(config, telegram, topic, envelope, instructions) {
  const startedAt = Date.now();
  const stopWorkingIndicator = telegram.startWorkingIndicator(config, topic, envelope);
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
    if (outcome.checkpoint?.sessionId) setTopicSessionId(topic, outcome.checkpoint.sessionId);
    console.error(`compacted chat=${envelope.chatId} topic=${envelope.topicId} agent=${topic.agent} duration=${durationSeconds}s checkpoint=${outcome.checkpoint?.sessionId || "none"}`);
    const checkpointText = outcome.checkpoint
      ? `\nCheckpoint session: ${outcome.checkpoint.sessionId}\nTranscript bytes: ${outcome.checkpoint.sourceBytes} → ${outcome.checkpoint.checkpointBytes}`
      : "";
    await sendLongMessage(telegram, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      replyToMessageId: envelope.messageId,
      text: `Compacted ${topic.name}.\n\nKept from entry: ${outcome.result.firstKeptEntryId}\nTokens before: ${outcome.result.tokensBefore}${checkpointText}`,
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

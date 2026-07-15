import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgent, getBotToken, resolveEntityDir, resolvePath, resolveTopicModel } from "./config.js";

export async function runPiForTopic(config, topic, envelope, options = {}) {
  const run = await startPiForTopic(config, topic, envelope, options);
  return run.promise;
}

export async function startPiForTopic(config, topic, envelope, options = {}) {
  const spec = buildPiRunSpec(config, topic, envelope, options);
  return startRpcProcess(spec.args, {
    cwd: spec.cwd,
    idleTimeoutMs: spec.idleTimeoutMs,
    hardTimeoutMs: spec.hardTimeoutMs,
    onText: options.onText,
    onEvent: options.onEvent,
    env: spec.env,
    initialMessage: spec.initialMessage,
    sessionDir: config.project.sessions_dir,
    sessionId: spec.sessionId,
    steerMessage: (steerEnvelope) => formatTelegramMessage(topic, withAliasName(config, steerEnvelope)),
  });
}

export function buildPiRunSpec(config, topic, envelope, options = {}) {
  const agent = getAgent(config, topic.agent);
  const entityDir = resolveEntityDir(config, agent);
  const sessionId = options.sessionId || topic.session_id || agent.session_id || `${topic.agent}-${topic.topic_id}`;
  mkdirSync(entityDir, { recursive: true });
  mkdirSync(config.project.sessions_dir, { recursive: true });

  const args = ["--session-dir", config.project.sessions_dir];
  if (options.session) {
    args.push("--session", resolvePath(config.project.root, options.session));
  } else if (options.fork) {
    args.push("--fork", resolvePath(config.project.root, options.fork));
  } else {
    args.push("--session-id", String(sessionId));
  }

  if (options.name) {
    args.push("--name", String(options.name));
  }

  for (const extension of config.project.extensions || []) {
    args.push("--extension", resolvePath(config.project.root, extension));
  }
  for (const skill of agent.skills || []) {
    args.push("--skill", resolvePath(config.project.root, skill));
  }
  for (const extension of agent.extensions || []) {
    args.push("--extension", resolvePath(config.project.root, extension));
  }
  if (agent.system_prompt) {
    args.push("--append-system-prompt", agent.system_prompt);
  }

  const model = resolveTopicModel(config, topic, agent);
  if (model) {
    args.push("--model", model);
  }

  return {
    cwd: entityDir,
    args,
    env: {
      TELEPI_CHAT_ID: envelope.chatId,
      TELEPI_TOPIC_ID: envelope.topicId || "",
      TELEPI_MESSAGE_ID: envelope.messageId || "",
      TELEPI_TOPIC_NAME: topic.name || "",
      TELEPI_AGENT_ID: topic.agent || "",
      TELEPI_BOT_TOKEN: options.botToken ?? getBotToken(config),
      TELEPI_BUTTON_STORE: resolvePath(config.project.cache_dir, "button-callbacks.jsonl"),
    },
    initialMessage: formatTelegramMessage(topic, withAliasName(config, envelope)),
    // Silence is not proof of a stalled run: a tool or provider request can work
    // for a long time without emitting pi events. Never apply a destructive idle
    // timeout by default; cancellation stays user-driven. Operators may still
    // opt into the legacy idle timeout or an explicit absolute hard limit.
    idleTimeoutMs: Number(agent.idle_timeout_ms ?? agent.timeout_ms ?? 0),
    hardTimeoutMs: Number(agent.hard_timeout_ms ?? 0),
    sessionId: String(sessionId),
    agent,
  };
}

// Agents should always see one stable name per person, regardless of the
// user's current Telegram username/first name.
function withAliasName(config, envelope) {
  const alias = Object.values(config.users?.aliases || {}).find((user) => user.id === String(envelope.userId))?.alias;
  return alias ? { ...envelope, userName: alias } : envelope;
}

function formatTelegramMessage(topic, envelope) {
  const userText = envelope.text || "[Telegram message contained attachment(s) without text.]";
  const isSkillDirective = /^\/skill:\S/.test(userText);

  const routing = [
    `Telegram topic route: ${topic.name}`,
    `local_time=${formatLocalTime(new Date())}`,
    `chat_id=${envelope.chatId}`,
    `topic_id=${envelope.topicId}`,
    `telegram_user_id=${envelope.userId || "unknown"}`,
    `telegram_user_name=${envelope.userName}`,
    `telegram_message_id=${envelope.messageId}`,
    ...(envelope.source ? [`telepi_message_source=${envelope.source}`] : []),
    ...(envelope.replyTo ? ["", "Telegram reply context:", ...formatReplyContext(envelope.replyTo)] : []),
    ...(envelope.attachments?.length
      ? ["", "Attachments (use the read tool on the path to view the content):", ...envelope.attachments.map(formatAttachment)]
      : []),
  ];

  // /skill:<name> directives must be at the very start of the message for pi to expand them.
  // When a skill directive is present, put it first, then append routing context.
  if (isSkillDirective) {
    return `${userText}\n\n${routing.join("\n")}`;
  }

  return `${routing.join("\n")}\n\n${userText}`;
}

// Models have no clock; anything time-aware (scheduling, "how long since",
// greetings) needs the current time in context.
function formatLocalTime(d) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${day})`;
}

function formatReplyContext(replyTo) {
  return [
    `reply_to_message_id=${replyTo.messageId || "unknown"}`,
    replyTo.userName ? `reply_to_user_name=${replyTo.userName}` : undefined,
    replyTo.text ? `reply_to_text=${replyTo.text}` : undefined,
    replyTo.hasPhoto ? "reply_to_has_photo=true" : undefined,
    replyTo.documentFileName ? `reply_to_document=${replyTo.documentFileName}` : undefined,
    replyTo.attachments?.length ? "reply_to_attachments:" : undefined,
    ...(replyTo.attachments || []).map((attachment) => [
      `- ${attachment.kind}`,
      attachment.fileName ? `  filename: ${attachment.fileName}` : undefined,
      attachment.mimeType ? `  mime_type: ${attachment.mimeType}` : undefined,
      attachment.fileSize ? `  size_bytes: ${attachment.fileSize}` : undefined,
    ].filter(Boolean).join("\n")),
  ].filter(Boolean);
}

function formatAttachment(attachment) {
  return [
    `- ${attachment.type}: ${attachment.path}`,
    attachment.fileName ? `  filename: ${attachment.fileName}` : undefined,
    attachment.mimeType ? `  mime_type: ${attachment.mimeType}` : undefined,
    attachment.fileSize ? `  size_bytes: ${attachment.fileSize}` : undefined,
  ].filter(Boolean).join("\n");
}

async function startRpcProcess(args, {
  cwd,
  idleTimeoutMs,
  hardTimeoutMs,
  env = {},
  onText,
  onEvent,
  initialMessage,
  steerMessage,
  sessionDir,
  sessionId,
}) {
  // Capture the pre-prompt byte boundary. Pi persists messages before all RPC
  // lifecycle events have necessarily escaped the process, so the transcript
  // is the authoritative fallback when RPC wedges after writing a final answer.
  const transcriptCursor = createSessionTranscriptCursor(sessionDir, sessionId);
  const { RpcClient } = await loadPiModule();
  const client = new RpcClient({
    cliPath: resolvePiCliPath(),
    cwd: resolve(cwd),
    env,
    args,
  });
  await client.start();

  let unsubscribe;
  let terminalSettleTimer;
  const promise = new Promise((resolvePromise) => {
    let stdout = "";
    let streamedTextCount = 0;
    let textQueue = Promise.resolve();
    let textDeliveryError = "";
    let terminalTranscriptText = "";
    const deliveredTexts = new Set();
    let streamedAssistantParts = [];
    let initialUserMessageSeen = false;
    let settled = false;
    let idleTimer;
    let transcriptTimer;
    const timeoutRun = (message) => {
      if (settled) return;
      settled = true;
      cleanup();
      textQueue
        .catch(() => undefined)
        .then(() => client.stop())
        .finally(() => {
          resolvePromise({
            ok: false,
            code: null,
            stdout: outputTextFromJson(stdout) || terminalTranscriptText,
            stderr: message,
            streamedTextCount,
          });
        });
    };
    const refreshIdleTimer = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutRun(`Timed out after ${idleTimeoutMs}ms without pi events`);
      }, idleTimeoutMs);
    };
    refreshIdleTimer();
    const hardTimer = hardTimeoutMs > 0
      ? setTimeout(() => {
        timeoutRun(`Timed out after hard limit ${hardTimeoutMs}ms`);
      }, hardTimeoutMs)
      : undefined;

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      await textQueue;
      if (textDeliveryError) {
        result.stderr = `${result.stderr ? `${result.stderr}\n` : ""}Streaming text delivery failed: ${textDeliveryError}`;
      }
      await client.stop();
      resolvePromise(result);
    };

    const cleanup = () => {
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      clearTimeout(terminalSettleTimer);
      clearInterval(transcriptTimer);
      unsubscribe?.();
      unsubscribe = undefined;
    };

    const enqueueText = (text) => {
      const normalized = String(text || "").trim();
      if (!normalized || !onText || deliveredTexts.has(normalized)) return;
      deliveredTexts.add(normalized);
      streamedTextCount += 1;
      textQueue = textQueue
        .catch(() => undefined)
        .then(() => onText(normalized))
        .catch((error) => {
          textDeliveryError = error.message;
          console.error(`pi assistant text delivery failed: ${error.stack || error.message}`);
        });
    };

    // A completed final assistant message should be followed immediately by
    // agent_end/agent_settled. If pi wedges after persisting that answer, allow
    // a grace period and then close only that completed lifecycle—not an
    // actively reasoning/tool-using turn. Gateway-owned steers not confirmed by
    // a transcript user message are replayed after this run closes.
    const scheduleTerminalSettle = () => {
      clearTimeout(terminalSettleTimer);
      if (settled) return;
      terminalSettleTimer = setTimeout(() => {
        console.error("pi emitted a terminal assistant message but did not settle; closing completed run");
        void finish({
          ok: true,
          code: 0,
          stdout: outputTextFromJson(stdout) || terminalTranscriptText,
          stderr: client.getStderr().trim(),
          streamedTextCount,
        });
      }, 60_000);
    };

    const pollTranscript = () => {
      for (const entry of readSessionTranscriptEntries(transcriptCursor)) {
        const message = entry?.type === "message" ? entry.message : null;
        if (message?.role !== "assistant" || message.stopReason !== "stop") continue;
        const finalText = textFromPiContent(message.content).trim();
        if (!finalText) continue;
        terminalTranscriptText = finalText;
        enqueueText(finalText);
        scheduleTerminalSettle();
      }
    };
    transcriptTimer = setInterval(pollTranscript, 500);
    transcriptTimer.unref?.();
    pollTranscript();

    unsubscribe = client.onEvent((event) => {
      refreshIdleTimer();
      onEvent?.(event);
      const line = JSON.stringify(event);
      stdout += `${line}\n`;

      if (event.type === "message_start" && event.message?.role === "assistant") {
        streamedAssistantParts = [];
      }
      if (event.type === "message_start" && event.message?.role === "user") {
        if (initialUserMessageSeen) {
          clearTimeout(terminalSettleTimer);
        } else {
          initialUserMessageSeen = true;
        }
      }

      const streamedText = textFromJsonEvent(line);
      if (streamedText) {
        streamedAssistantParts.push(streamedText);
        enqueueText(streamedText);
      }

      // Some provider/transport paths persist message_end without emitting a
      // usable text_end delta. Deliver the finalized assistant text as a
      // fallback, while avoiding duplication when text_end was observed.
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const finalText = textFromPiContent(event.message.content).trim();
        const streamedTextCombined = streamedAssistantParts.join("\n\n").trim();
        if (finalText && finalText !== streamedTextCombined) enqueueText(finalText);
        if (event.message.stopReason === "stop") scheduleTerminalSettle();
      }

      // agent_end is only a low-level boundary and may still be followed by
      // queued steering/follow-up work. agent_settled is the true completion.
      if (event.type === "agent_settled") {
        void finish({
          ok: true,
          code: 0,
          stdout: outputTextFromJson(stdout) || terminalTranscriptText,
          stderr: client.getStderr().trim(),
          streamedTextCount,
        });
      }
    });

    client.prompt(initialMessage).catch((error) => {
      void finish({
        ok: false,
        code: 1,
        stdout: outputTextFromJson(stdout) || terminalTranscriptText,
        stderr: `${error.message}${client.getStderr() ? `\n${client.getStderr().trim()}` : ""}`.trim(),
        streamedTextCount,
      });
    });
  });

  return {
    promise,
    abort: async () => {
      await client.abort();
    },
    steer: async (envelope) => {
      await client.steer(steerMessage(envelope));
    },
  };
}

function createSessionTranscriptCursor(sessionDir, sessionId) {
  const path = findSessionTranscriptFile(sessionDir, sessionId);
  return {
    sessionDir,
    sessionId: String(sessionId || ""),
    path,
    offset: path ? statSync(path).size : 0,
    pending: Buffer.alloc(0),
  };
}

function findSessionTranscriptFile(sessionDir, sessionId) {
  if (!sessionDir || !sessionId) return null;
  try {
    const candidates = readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => resolve(sessionDir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const path of candidates) {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(4096);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const newline = buffer.indexOf(0x0a, 0);
        const header = parseJsonLine(buffer.subarray(0, newline >= 0 ? newline : length).toString("utf8"));
        if (header?.type === "session" && String(header.id) === String(sessionId)) return path;
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function readSessionTranscriptEntries(cursor) {
  try {
    if (!cursor.path) {
      cursor.path = findSessionTranscriptFile(cursor.sessionDir, cursor.sessionId);
      if (!cursor.path) return [];
      cursor.offset = 0;
    }
    const size = statSync(cursor.path).size;
    if (size <= cursor.offset) return [];
    const buffer = Buffer.alloc(size - cursor.offset);
    const fd = openSync(cursor.path, "r");
    let length = 0;
    try {
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, cursor.offset + length);
        if (!count) break;
        length += count;
      }
    } finally {
      closeSync(fd);
    }
    cursor.offset += length;
    let unread = Buffer.concat([cursor.pending, buffer.subarray(0, length)]);
    const entries = [];
    let newline;
    while ((newline = unread.indexOf(0x0a)) >= 0) {
      const line = unread.subarray(0, newline).toString("utf8");
      unread = unread.subarray(newline + 1);
      const entry = parseJsonLine(line);
      if (entry) entries.push(entry);
    }
    cursor.pending = Buffer.from(unread);
    return entries;
  } catch {
    return [];
  }
}

function textFromPiContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n\n");
}

function textFromJsonEvent(line) {
  if (!line.trim()) return "";
  const event = parseJsonLine(line);
  if (!event || event.type !== "message_update") return "";
  const messageEvent = event.assistantMessageEvent;
  if (messageEvent?.type !== "text_end") return "";
  return String(messageEvent.content || "").trim();
}

function outputTextFromJson(output) {
  const chunks = [];
  for (const line of output.split("\n")) {
    const text = textFromJsonEvent(line);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

let piModulePromise;

async function loadPiModule() {
  piModulePromise ||= import(pathToFileURL(resolvePiPackageIndex()).href);
  return piModulePromise;
}

function resolvePiPackageIndex() {
  return resolve(dirname(resolvePiCliPath()), "index.js");
}

function resolvePiCliPath() {
  const piBin = execFileSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" }).trim();
  return realpathSync(piBin);
}

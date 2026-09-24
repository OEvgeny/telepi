import { mkdirSync } from "node:fs";
import { getAgent, getBotToken, resolveEntityDir, resolvePath } from "../config.js";
import { resolveBrokerSocketPath } from "../broker-ipc.js";

export function buildTopicRunSpec(config, topic, envelope, options = {}) {
  const agent = getAgent(config, topic.agent);
  const entityDir = resolveEntityDir(config, agent);
  const sessionId = options.sessionId || topic.session_id || agent.session_id || `${topic.agent}-${topic.topic_id}`;
  mkdirSync(entityDir, { recursive: true });
  mkdirSync(config.project.sessions_dir, { recursive: true });

  return {
    cwd: entityDir,
    env: {
      TELEPI_CHAT_ID: envelope.chatId,
      TELEPI_TOPIC_ID: envelope.topicId || "",
      TELEPI_MESSAGE_ID: envelope.messageId || "",
      TELEPI_TOPIC_NAME: topic.name || "",
      TELEPI_AGENT_ID: topic.agent || "",
      TELEPI_USER_MESSAGE: envelope.text || "",
      TELEPI_BOT_TOKEN: options.botToken ?? getBotToken(config),
      TELEPI_BUTTON_STORE: resolvePath(config.project.cache_dir, "button-callbacks.jsonl"),
      TELEPI_BROKER_SOCKET: resolveBrokerSocketPath(config),
    },
    initialMessage: formatTopicMessage(config, topic, envelope),
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

export function formatTopicMessage(config, topic, envelope) {
  return formatTelegramMessage(topic, withAliasName(config, envelope));
}

// Agents should always see one stable name per person, regardless of the
// user's current Telegram username/first name.
function withAliasName(config, envelope) {
  const alias = Object.values(config.users?.aliases || {}).find((user) => user.id === String(envelope.userId))?.alias;
  return alias ? { ...envelope, userName: alias } : envelope;
}

function formatTelegramMessage(topic, envelope) {
  const userText = envelope.text || (envelope.transport === "telepi"
    ? "[Telepi broker message contained no text.]"
    : "[Telegram message contained attachment(s) without text.]");
  const isSkillDirective = /^\/skill:\S/.test(userText);

  const routing = envelope.transport === "telepi"
    ? formatBrokerRouting(topic, envelope)
    : formatTelegramRouting(topic, envelope);

  // /skill:<name> directives must be at the very start of the message for pi to expand them.
  // When a skill directive is present, put it first, then append routing context.
  if (isSkillDirective) {
    return `${userText}\n\n${routing.join("\n")}`;
  }

  return `${routing.join("\n")}\n\n${userText}`;
}

function formatTelegramRouting(topic, envelope) {
  return [
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
      ? [
        "",
        "Attachments (use transcribe_file for audio/video; use read for supported image/text content):",
        ...envelope.attachments.map(formatAttachment),
      ]
      : []),
  ];
}

function formatBrokerRouting(topic, envelope) {
  const origin = envelope.origin || {};
  return [
    `Telepi broker route: ${topic.name}`,
    `local_time=${formatLocalTime(new Date())}`,
    `telepi_message_id=${envelope.brokerMessageId || envelope.updateId || "unknown"}`,
    `telepi_sender_kind=${origin.kind || "unknown"}`,
    `telepi_sender_name=${origin.name || envelope.userName || "unknown"}`,
    ...(origin.agentId ? [`telepi_sender_agent_id=${origin.agentId}`] : []),
    ...(origin.topicName ? [`telepi_sender_topic=${origin.topicName}`] : []),
    ...(envelope.source ? [`telepi_message_source=${envelope.source}`] : []),
    ...(envelope.attachments?.length
      ? [
        "",
        "Attachments (use transcribe_file for audio/video; use read for supported image/text content):",
        ...envelope.attachments.map(formatAttachment),
      ]
      : []),
  ];
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
    replyTo.agentId ? `reply_to_agent_id=${replyTo.agentId}` : undefined,
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

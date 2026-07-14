const TOPIC_COLOR_BY_NAME = {
  blue: 7322096,
  green: 9367192,
  yellow: 16766590,
  violet: 13338331,
  pink: 16749490,
  red: 16478047,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
const PHOTO_UPLOAD_TIMEOUT_MS = 120_000;

export class TelegramClient {
  constructor(token) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async request(method, payload = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    const response = await fetchWithTimeout(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, timeoutMs, `Telegram ${method}`);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const message = body?.description || `${response.status} ${response.statusText}`;
      const error = new Error(`Telegram ${method} failed: ${message}`);
      if (body?.parameters?.retry_after != null) error.retryAfterSeconds = Number(body.parameters.retry_after);
      throw error;
    }
    return body.result;
  }

  async getMe() {
    return this.request("getMe");
  }

  async getUpdates({ offset, timeoutSeconds = 25, limit = 50 } = {}) {
    return this.request("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      limit,
      allowed_updates: ["message", "edited_message", "callback_query", "message_reaction"],
    }, { timeoutMs: (Number(timeoutSeconds) + 10) * 1000 });
  }

  async getFile(fileId) {
    return this.request("getFile", { file_id: fileId });
  }

  async downloadFile(filePath) {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/file/bot${this.token}/${filePath}`,
      {},
      FILE_DOWNLOAD_TIMEOUT_MS,
      "Telegram file download",
    );
    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async sendMessage({ chatId, topicId, text, replyToMessageId, parseMode, entities, replyMarkup }) {
    return this.request("sendMessage", compact({
      chat_id: chatId,
      message_thread_id: topicId,
      text,
      reply_to_message_id: replyToMessageId,
      disable_web_page_preview: true,
      parse_mode: parseMode,
      entities,
      reply_markup: replyMarkup,
    }));
  }

  async editMessageText({ chatId, messageId, text, parseMode, replyMarkup }) {
    return this.request("editMessageText", compact({
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      parse_mode: parseMode,
      reply_markup: replyMarkup,
    }));
  }

  async editMessageReplyMarkup({ chatId, messageId, replyMarkup }) {
    return this.request("editMessageReplyMarkup", compact({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }));
  }

  async answerCallbackQuery({ callbackQueryId, text, showAlert }) {
    return this.request("answerCallbackQuery", compact({
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    }));
  }

  async setMessageReaction({ chatId, messageId, emoji }) {
    return this.request("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: "emoji", emoji }] : [],
    });
  }

  async sendPhoto({ chatId, topicId, filePath, caption, replyToMessageId }) {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (topicId != null) form.set("message_thread_id", String(topicId));
    if (caption) form.set("caption", caption);
    if (replyToMessageId) form.set("reply_to_message_id", String(replyToMessageId));
    const file = await import("node:fs/promises").then((fs) => fs.readFile(filePath));
    form.set("photo", new Blob([file]), filePath.split("/").pop() || "photo.jpg");

    const response = await fetchWithTimeout(`${this.baseUrl}/sendPhoto`, {
      method: "POST",
      body: form,
    }, PHOTO_UPLOAD_TIMEOUT_MS, "Telegram sendPhoto");
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      const message = body?.description || `${response.status} ${response.statusText}`;
      throw new Error(`Telegram sendPhoto failed: ${message}`);
    }
    return body.result;
  }

  async sendChatAction({ chatId, topicId, action = "typing" }) {
    return this.request("sendChatAction", compact({
      chat_id: chatId,
      message_thread_id: topicId,
      action,
    }));
  }

  async setMyCommands(commands, options = {}) {
    return this.request("setMyCommands", compact({
      commands,
      scope: options.scope,
      language_code: options.languageCode,
    }));
  }

  async deleteMyCommands(options = {}) {
    return this.request("deleteMyCommands", compact({
      scope: options.scope,
      language_code: options.languageCode,
    }));
  }

  async getMyCommands(options = {}) {
    return this.request("getMyCommands", compact({
      scope: options.scope,
      language_code: options.languageCode,
    }));
  }

  async setChatMenuButton({ chatId, menuButton } = {}) {
    return this.request("setChatMenuButton", compact({
      chat_id: chatId,
      menu_button: menuButton,
    }));
  }

  async getChatMenuButton({ chatId } = {}) {
    return this.request("getChatMenuButton", compact({
      chat_id: chatId,
    }));
  }

  async getForumTopicIconStickers() {
    return this.request("getForumTopicIconStickers");
  }

  async createTopic({ chatId, name, iconColor }) {
    return this.request("createForumTopic", compact({
      chat_id: chatId,
      name,
      icon_color: normalizeTopicColor(iconColor),
    }));
  }

  async createTopicWithIcon({ chatId, name, iconColor, iconCustomEmojiId }) {
    return this.request("createForumTopic", compact({
      chat_id: chatId,
      name,
      icon_color: iconCustomEmojiId ? undefined : normalizeTopicColor(iconColor),
      icon_custom_emoji_id: iconCustomEmojiId,
    }));
  }

  async editTopic({ chatId, topicId, name, iconCustomEmojiId }) {
    return this.request("editForumTopic", compact({
      chat_id: chatId,
      message_thread_id: topicId,
      name,
      icon_custom_emoji_id: iconCustomEmojiId,
    }));
  }

  async renameTopic({ chatId, topicId, name }) {
    return this.editTopic({ chatId, topicId, name });
  }
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveForumTopicIcon(telegram, { avatar, iconCustomEmojiId }) {
  if (iconCustomEmojiId) return String(iconCustomEmojiId);
  if (!avatar) return undefined;
  const stickers = await telegram.getForumTopicIconStickers();
  const match = stickers.find((sticker) => sticker.emoji === avatar);
  return match?.custom_emoji_id;
}

export function normalizeTopicColor(value) {
  if (value == null || value === "") return undefined;
  if (typeof value === "number") return value;
  const key = String(value).toLowerCase();
  if (TOPIC_COLOR_BY_NAME[key]) return TOPIC_COLOR_BY_NAME[key];
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid Telegram topic color: ${value}`);
  }
  return parsed;
}

export function updateToEnvelope(update) {
  const message = update.message || update.edited_message;
  if (!message) return null;
  const text = message.text || message.caption || "";
  const telegramAttachments = getMessageAttachments(message);
  if (!text && !telegramAttachments.length) return null;
  return {
    updateId: update.update_id,
    chatId: String(message.chat.id),
    topicId: message.message_thread_id == null ? null : String(message.message_thread_id),
    userId: message.from?.id == null ? null : String(message.from.id),
    userName: message.from?.username || message.from?.first_name || "unknown",
    messageId: String(message.message_id),
    replyTo: message.reply_to_message ? messageToReplyContext(message.reply_to_message) : undefined,
    text,
    telegramAttachments,
  };
}

function messageToReplyContext(message) {
  const attachments = getMessageAttachments(message);
  return {
    chatId: message.chat?.id == null ? undefined : String(message.chat.id),
    topicId: message.message_thread_id == null ? undefined : String(message.message_thread_id),
    messageId: message.message_id == null ? undefined : String(message.message_id),
    userId: message.from?.id == null ? undefined : String(message.from.id),
    userName: message.from?.username || message.from?.first_name || undefined,
    text: message.text || message.caption || "",
    hasPhoto: Array.isArray(message.photo) && message.photo.length > 0,
    documentFileName: message.document?.file_name,
    attachments: attachments.map((attachment) => ({
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      fileSize: attachment.fileSize,
    })),
  };
}

export async function hydrateEnvelopeMedia(telegram, config, envelope) {
  if (!envelope.telegramAttachments?.length) return envelope;
  const safeTopic = envelope.topicId == null ? "all" : envelope.topicId;
  const fs = await import("node:fs/promises");
  const attachments = [];

  for (const telegramAttachment of envelope.telegramAttachments) {
    const file = await telegram.getFile(telegramAttachment.fileId);
    const bytes = await telegram.downloadFile(file.file_path);
    const type = attachmentType(telegramAttachment);
    const extension = attachmentExtension(telegramAttachment.fileName || file.file_path, telegramAttachment.mimeType, type);
    const dir = `${config.project.cache_dir}/${type === "image" ? "images" : "files"}/${envelope.chatId}/${safeTopic}`;
    await fs.mkdir(dir, { recursive: true });
    const path = `${dir}/${envelope.messageId}-${telegramAttachment.kind}${extension}`;
    await fs.writeFile(path, bytes);
    attachments.push({
      type,
      path,
      fileId: telegramAttachment.fileId,
      mimeType: telegramAttachment.mimeType,
      fileName: telegramAttachment.fileName,
      fileSize: telegramAttachment.fileSize,
    });
  }

  return {
    ...envelope,
    // Consumed: hydrating an already-hydrated envelope (e.g. a queued
    // message replayed after a run finishes) must not re-download media.
    telegramAttachments: [],
    attachments: [
      ...(envelope.attachments || []),
      ...attachments,
    ],
  };
}

function getMessageAttachments(message) {
  const attachments = [];
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo.at(-1);
    attachments.push({
      kind: "photo",
      fileId: photo.file_id,
      mimeType: "image/jpeg",
      fileSize: photo.file_size,
    });
  }
  if (message.document) {
    attachments.push({
      kind: "document",
      fileId: message.document.file_id,
      mimeType: message.document.mime_type || "application/octet-stream",
      fileName: message.document.file_name,
      fileSize: message.document.file_size,
    });
  }
  return attachments;
}

function attachmentType(attachment) {
  return attachment.mimeType?.startsWith("image/") ? "image" : "file";
}

function attachmentExtension(fileName, mimeType, type) {
  const fromName = fileName?.match(/\.[A-Za-z0-9]{1,8}$/)?.[0];
  if (fromName) return fromName.toLowerCase();
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "text/plain") return ".txt";
  if (mimeType === "text/markdown") return ".md";
  if (mimeType === "application/json") return ".json";
  return type === "image" ? ".jpg" : ".bin";
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
}

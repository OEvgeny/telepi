import { convert } from "../vendor/telegram-markdown-v2/index.js";

const TELEGRAM_TEXT_LIMIT = 4096;

// Convert model markdown to Telegram MarkdownV2. Returns null when the text
// should be sent as plain text instead (conversion failed or inflated the
// chunk past Telegram's limit).
export function toTelegramMarkdownV2(text) {
  const source = String(text ?? "");
  if (!source.trim()) return null;
  try {
    // "escape" makes unsupported constructs (tables, etc.) valid MarkdownV2
    // instead of leaving reserved characters raw for Telegram to reject.
    const converted = convert(source, "escape").trimEnd();
    if (!converted || converted.length > TELEGRAM_TEXT_LIMIT) return null;
    return converted;
  } catch (error) {
    console.error(`markdown to MarkdownV2 conversion failed, sending plain: ${error.message}`);
    return null;
  }
}

export function blockquoteEntities(text) {
  const value = String(text ?? "");
  if (!value) return undefined;
  return [{ type: "blockquote", offset: 0, length: value.length }];
}

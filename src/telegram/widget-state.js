import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A widget can only speak to the bot through a request of at most 64 bytes,
// and only the bot can write the widget's state. This module keeps the state we
// have seen per widget message, so an agent can answer "what does the counter
// say now?" long after the tap, and so the state survives a gateway restart.

const MAX_STATES = 200;
const MAX_REQUEST_BYTES = 64;
const MAX_STATE_BYTES = 1024;

export function widgetStateKey({ chatId, messageId }) {
  return `message:${chatId}:${messageId}`;
}

export function sharedWidgetStateKey(widgetId) {
  return `widget:${widgetId}`;
}

// The widget sends its whole state as a JSON object, e.g. {"n":7}. Absolute
// state rather than a delta means a dropped request cannot corrupt the count.
export function readWidgetStateRequest(data) {
  const text = String(data ?? "");
  if (!text) return { error: "empty" };
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) return { error: "too-large" };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "not-json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "not-object" };
  const state = JSON.stringify(value);
  if (Buffer.byteLength(state, "utf8") > MAX_STATE_BYTES) return { error: "state-too-large" };
  return { state };
}

export function createWidgetStateStore(path) {
  let states = load();

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function flush() {
    // Keep the file bounded: newest entries win, the rest are dropped.
    const newest = Object.entries(states)
      .sort((left, right) => Date.parse(right[1]?.updatedAt ?? 0) - Date.parse(left[1]?.updatedAt ?? 0))
      .slice(0, MAX_STATES);
    states = Object.fromEntries(newest);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(states, null, 1)}\n`, "utf8");
    renameSync(temporary, path);
  }

  return {
    get(key) {
      return states[key] ?? null;
    },
    list() {
      return Object.values(states);
    },
    set(key, state, meta = {}) {
      states[key] = { state, updatedAt: new Date().toISOString(), ...meta };
      flush();
    },
  };
}

// Answer first (the widget is waiting, and a query expires after 15 seconds),
// mirror the state into the message, and record it even when the mirror fails:
// the store is what we sample, the edit is what the chat draws.
export async function handleWidgetQuery(query, { kind = "widget_query", store, api, log = console.error } = {}) {
  const request = readWidgetStateRequest(query.data);
  const shared = kind === "shared_widget_query";
  const key = shared ? sharedWidgetStateKey(query.widget_id) : widgetStateKey({
    chatId: query.chat?.id,
    messageId: query.message_id,
  });
  const meta = {
    chatId: query.chat?.id ?? null,
    messageId: query.message_id ?? null,
    widgetId: query.widget_id ?? null,
    fromId: query.from?.id ?? null,
  };

  if (request.error) {
    log(`widget query rejected key=${key} reason=${request.error} bytes=${Buffer.byteLength(String(query.data ?? ""), "utf8")}`);
    await api("answerWidgetQuery", { widget_query_id: query.id, data: JSON.stringify({ error: request.error }) });
    return { accepted: false, key, reason: request.error };
  }

  await api("answerWidgetQuery", { widget_query_id: query.id, data: JSON.stringify({ ok: 1 }) });

  try {
    if (shared) {
      await api("editSharedWidgetData", { widget_id: query.widget_id, public_data: request.state });
    } else {
      await api("editMessageWidgetData", {
        chat_id: query.chat.id,
        message_id: query.message_id,
        chat_data: request.state,
      });
    }
  } catch (error) {
    if (!/not modified/i.test(error?.description ?? error?.message ?? "")) {
      log(`widget state edit failed key=${key}: ${error?.description ?? error?.message}`);
    }
  }

  store.set(key, request.state, meta);
  return { accepted: true, key, state: request.state };
}

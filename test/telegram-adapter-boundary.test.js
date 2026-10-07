import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createTelegramAdapter } from "../src/telegram/adapter.js";

const root = resolve(new URL("..", import.meta.url).pathname);

test("gateway composes the concrete Telegram adapter without owning Bot API mechanics", async () => {
  const [gateway, adapter] = await Promise.all([
    readFile(resolve(root, "src/gateway.js"), "utf8"),
    readFile(resolve(root, "src/telegram/adapter.js"), "utf8"),
  ]);

  assert.match(gateway, /createTelegramAdapter/);
  assert.doesNotMatch(gateway, /TelegramClient|\.getUpdates\(|answerCallbackQuery|updateToEnvelope|hydrateEnvelopeMedia/);
  assert.match(gateway, /result\.undeliveredText/);

  assert.match(adapter, /new TelegramClient/);
  assert.match(adapter, /\.getUpdates\(/);
  assert.match(adapter, /answerCallbackQuery/);
  assert.match(adapter, /updateToEnvelope/);
  assert.match(adapter, /hydrateEnvelopeMedia/);
});

test("CLI configuration notices use concise quoted Telegram messages", async () => {
  const cli = await readFile(resolve(root, "bin/telepi.js"), "utf8");
  const notify = cli.match(/async function notifyTopicBestEffort[\s\S]*?\n}/)?.[0] || "";
  assert.match(notify, /sendCliLongMessage/);
  assert.match(notify, /quote: true/);
  assert.doesNotMatch(cli, /Execution backend changed for/);
  assert.doesNotMatch(cli, /Execution location changed for/);
});

test("active turns expose /stop without a cancel-button callback path", async () => {
  const [gateway, adapter] = await Promise.all([
    readFile(resolve(root, "src/gateway.js"), "utf8"),
    readFile(resolve(root, "src/telegram/adapter.js"), "utf8"),
  ]);

  assert.match(gateway, /stopRequested/);
  assert.doesNotMatch(gateway, /clearCancelButton|cancelToken|cancelMessage|cancelAttachTimer/);
  assert.doesNotMatch(adapter, /telepi:cancel|cancelButtonMarkup|clearCancelButton|parseCancelCallbackData/);
});

test("silent turn status uses one native preformatted Telegram message", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-turn-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, payload });
    const result = method === "getMe"
      ? { id: 99, first_name: "Test Bot", username: "test_bot" }
      : method === "sendMessage"
        ? { message_id: 456, chat: { id: payload.chat_id }, text: payload.text }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = await createTelegramAdapter({
    project: { cache_dir: directory },
    telegram: { bot_token: "test-token" },
    users: { aliases: {} },
    topics: [],
  });
  const active = { displayQueue: Promise.resolve() };
  adapter.startTurnStatus(active, { chatId: "10", topicId: "20" }, {
    silenceMs: 5,
    updateMs: 900,
  });
  adapter.updateTurnStatusFromPiEvent(active, { type: "turn_start", turnIndex: 2 });
  adapter.updateTurnStatusFromPiEvent(active, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "work" },
  });

  await waitFor(() => calls.some((call) => call.method === "sendMessage"));
  const sent = calls.find((call) => call.method === "sendMessage");
  assert.match(sent.payload.text, /^◐ Step 3 · ⚒ 0 · 0 tok\n→ Reasoning · /);
  assert.deepEqual(sent.payload.entities, [{
    type: "pre",
    offset: 0,
    length: sent.payload.text.length,
  }]);
  assert.equal(sent.payload.parse_mode, undefined);

  await waitFor(() => calls.some((call) => call.method === "editMessageText"));
  const edited = calls.find((call) => call.method === "editMessageText");
  assert.match(edited.payload.text, /^◓ Step 3 /);
  assert.equal(edited.payload.message_id, "456");
  assert.deepEqual(edited.payload.entities, [{
    type: "pre",
    offset: 0,
    length: edited.payload.text.length,
  }]);

  active.turnStatus.silenceMs = 60_000;
  adapter.noteTurnStatusVisibleActivity(active);
  await active.displayQueue;
  assert.ok(calls.some((call) => call.method === "deleteMessage"));
  adapter.stopTurnStatus(active);
});

test("assistant delivery retries one transient Telegram failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-telegram-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  let sendAttempts = 0;
  globalThis.fetch = async (url, options = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = options.body ? JSON.parse(options.body) : undefined;
    if (method === "sendMessage" && ++sendAttempts === 1) {
      throw new TypeError("fetch failed");
    }
    const result = method === "getMe"
      ? { id: 99, first_name: "Test Bot", username: "test_bot" }
      : method === "sendMessage"
        ? { message_id: 122, chat: { id: payload.chat_id }, text: payload.text }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = await createTelegramAdapter({
    project: { cache_dir: directory },
    telegram: { bot_token: "test-token" },
    users: { aliases: {} },
    topics: [],
  });
  const sent = await adapter.sendLongMessage({ chatId: "10", topicId: "20", text: "Retry me" });
  assert.equal(sendAttempts, 2);
  assert.equal(sent[0].message_id, 122);
});

test("concrete Telegram adapter initializes and renders through its client boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-telegram-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const payload = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, payload });
    const result = method === "getMe"
      ? { id: 99, first_name: "Test Bot", username: "test_bot" }
      : method === "sendMessage"
        ? { message_id: 123, chat: { id: payload.chat_id }, text: payload.text }
        : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = await createTelegramAdapter({
    project: { cache_dir: directory },
    telegram: { bot_token: "test-token" },
    users: { aliases: {} },
    topics: [],
  });
  const sent = await adapter.sendLongMessage({
    chatId: "10",
    topicId: "20",
    text: "Adapter boundary",
  });
  const header = "📨 Message from Source Agent";
  await adapter.sendLongMessage({
    chatId: "10",
    topicId: "20",
    text: `${header}\n\nSynthetic prompt`,
    blockquoteHeader: header,
  });

  assert.equal(sent[0].message_id, 123);
  assert.ok(calls.some((call) => call.method === "getMe"));
  const commands = calls.find((call) => call.method === "setMyCommands");
  assert.ok(commands.payload.commands.some((command) => command.command === "stop"));
  const sends = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sends[0].payload.chat_id, "10");
  assert.equal(sends[0].payload.message_thread_id, "20");
  assert.equal(sends[1].payload.text, `${header}\n\nSynthetic prompt`);
  assert.deepEqual(sends[1].payload.entities, [{
    type: "blockquote",
    offset: 0,
    length: header.length,
  }]);
  assert.equal(sends[1].payload.parse_mode, undefined);
});

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Telegram adapter call");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

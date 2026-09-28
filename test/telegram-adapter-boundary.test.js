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

  assert.match(adapter, /new TelegramClient/);
  assert.match(adapter, /\.getUpdates\(/);
  assert.match(adapter, /answerCallbackQuery/);
  assert.match(adapter, /updateToEnvelope/);
  assert.match(adapter, /hydrateEnvelopeMedia/);
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

  assert.equal(sent[0].message_id, 123);
  assert.ok(calls.some((call) => call.method === "getMe"));
  const commands = calls.find((call) => call.method === "setMyCommands");
  assert.ok(commands.payload.commands.some((command) => command.command === "stop"));
  const send = calls.find((call) => call.method === "sendMessage");
  assert.equal(send.payload.chat_id, "10");
  assert.equal(send.payload.message_thread_id, "20");
});

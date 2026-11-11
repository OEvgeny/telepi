import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTelegramAdapter } from "../src/telegram/adapter.js";

// `/compact` rewrites the topic's session id while the Telegram long poll is
// blocked inside getUpdates. The update that arrives after the switch must be
// resolved against the config read *after* the poll returns, or the gateway
// spawns a worker with the pre-compaction session and its route guard rejects
// the message with "Worker session changed before startup".
test("updates arriving after a route change use the config read after the poll", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telepi-poll-reload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const result = method === "getMe"
      ? { id: 99, first_name: "Test Bot", username: "test_bot" }
      : true;
    return Response.json({ ok: true, result });
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

  const makeConfig = (sessionId) => ({
    telegram: { poll_timeout_seconds: 25, poll_limit: 50 },
    users: { aliases: {} },
    agents: { freya: { name: "Freya" } },
    topics: [{ name: "Freya", agent: "freya", chat_id: "1", topic_id: "2", session_id: sessionId, enabled: true }],
  });

  let stored = "freya-old";
  let polls = 0;
  adapter.client.getUpdates = async () => {
    polls += 1;
    // The compaction lands while this poll is in flight.
    stored = "freya-checkpoint";
    return [{
      update_id: 1,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: "supergroup" },
        message_thread_id: 2,
        from: { id: 1, is_bot: false, first_name: "Owner", username: "owner" },
        text: "How many guardrails are in the story?",
      },
    }];
  };

  const seen = [];
  const stop = new Error("stop after one update");
  await assert.rejects(
    adapter.poll({
      getConfig: () => makeConfig(stored),
      onMessage: async (_config, topic) => {
        seen.push(topic.session_id);
        throw stop;
      },
      onButtonMessage: async () => {},
      onReactionMessage: async () => {},
    }),
    stop,
  );

  assert.equal(polls, 1);
  assert.deepEqual(seen, ["freya-checkpoint"]);
});

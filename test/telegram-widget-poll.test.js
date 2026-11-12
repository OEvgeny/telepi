import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTelegramAdapter } from "../src/telegram/adapter.js";

async function makeAdapter(t) {
  const directory = await mkdtemp(join(tmpdir(), "telepi-widget-poll-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const method = new URL(url).pathname.split("/").at(-1);
    const result = method === "getMe" ? { id: 99, first_name: "Test Bot", username: "test_bot" } : true;
    return Response.json({ ok: true, result });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return createTelegramAdapter({
    project: { cache_dir: directory },
    telegram: { bot_token: "test-token" },
    users: { aliases: {} },
    topics: [],
  });
}

const config = {
  telegram: { poll_timeout_seconds: 25, poll_limit: 50, allowed_user_ids: ["1"] },
  users: { aliases: {} },
  agents: {},
  topics: [],
};

test("a widget tap reaches the handler and a failure cannot stop the poll", async (t) => {
  const adapter = await makeAdapter(t);
  const seen = [];

  adapter.client.getUpdates = async () => [{
    update_id: 1,
    widget_query: { id: "q1", data: '{"n":3}', chat: { id: 151725717 }, message_id: 42, from: { id: 1 } },
  }, {
    update_id: 2,
    shared_widget_query: { id: "q2", data: '{"v":1}', widget_id: "77", from: { id: 1 } },
  }, {
    update_id: 3,
    widget_query: { id: "q3", data: '{"n":9}', chat: { id: 151725717 }, message_id: 43, from: { id: 404 } },
  }];

  // The poller reads config twice per iteration (poll parameters, then the
  // route) and loops forever; the third read is the exit hatch.
  let reads = 0;
  const sentinel = new Error("stop the poll");
  const failure = await adapter.poll({
    getConfig: () => {
      reads += 1;
      if (reads > 2) throw sentinel;
      return config;
    },
    onMessage: async () => {},
    onButtonMessage: async () => {},
    onReactionMessage: async () => {},
    onWidgetQuery: async (_config, query, kind) => {
      seen.push({ kind, id: query.id });
      if (query.id === "q1") throw new Error("handler exploded");
    },
  }).then(() => null, (error) => error);

  assert.equal(failure, sentinel);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // q3 belongs to a user outside allowed_user_ids and is dropped before handling.
  assert.deepEqual(seen, [
    { kind: "widget_query", id: "q1" },
    { kind: "shared_widget_query", id: "q2" },
  ]);
});

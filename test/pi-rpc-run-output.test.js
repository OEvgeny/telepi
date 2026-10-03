import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantOutputCollector, startRpcRun } from "../src/pi/rpc-run.js";

test("pi output collector retains only finalized assistant text", () => {
  const collector = createAssistantOutputCollector();
  const repeatedPartial = "x".repeat(4 * 1024 * 1024);

  assert.equal(collector.consume({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "done",
      partial: { content: repeatedPartial },
    },
  }), "");
  assert.equal(collector.consume({
    type: "agent_end",
    messages: [{ role: "toolResult", content: repeatedPartial }],
  }), "");
  assert.equal(collector.text(), "");

  assert.equal(collector.consume({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", content: " First answer. " },
  }), "First answer.");
  assert.equal(collector.consume({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", content: "Second answer." },
  }), "Second answer.");
  assert.equal(collector.text(), "First answer.\n\nSecond answer.");
});

test("RPC run delivers intermediate assistant messages before the final answer", async () => {
  const delivered = [];
  let listener;
  let stopped = false;
  const events = [
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "I will inspect the files." },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "I will inspect the files." }], stopReason: "toolUse" },
    },
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "The first check is done." }], stopReason: "toolUse" },
    },
    { type: "message_start", message: { role: "assistant" } },
    {
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "Everything is fixed." },
    },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Everything is fixed." }], stopReason: "stop" },
    },
    { type: "agent_settled" },
  ];
  const client = {
    async start() {},
    onEvent(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      for (const event of events) listener(event);
    },
    async abort() {},
    async steer() {},
    async stop() {
      stopped = true;
    },
    getStderr() {
      return "";
    },
  };

  const run = await startRpcRun([], {
    workerPath: "/tmp/telepi-test-worker.js",
    cwd: process.cwd(),
    idleTimeoutMs: 0,
    hardTimeoutMs: 0,
    onText: async (text) => delivered.push(text),
    initialMessage: "Start",
    steerMessage: (message) => message,
    sessionDir: "/tmp/telepi-test-missing-sessions",
    sessionId: "missing",
    createRpcClient: () => client,
  });
  const result = await run.promise;

  assert.deepEqual(delivered, [
    "I will inspect the files.",
    "The first check is done.",
    "Everything is fixed.",
  ]);
  assert.equal(result.streamedTextCount, 3);
  assert.equal(result.ok, true);
  assert.equal(stopped, true);
});

test("RPC abort force-settles a worker that accepts abort but never becomes idle", async () => {
  let listener;
  let abortAccepted = false;
  let stopped = false;
  const client = {
    async start() {},
    onEvent(callback) {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {},
    async abort() {
      abortAccepted = true;
    },
    async steer() {},
    async stop() {
      stopped = true;
    },
    getStderr() {
      return "";
    },
  };

  const run = await startRpcRun([], {
    workerPath: "/tmp/telepi-test-worker.js",
    cwd: process.cwd(),
    idleTimeoutMs: 0,
    hardTimeoutMs: 0,
    initialMessage: "Start",
    steerMessage: (message) => message,
    sessionDir: "/tmp/telepi-test-missing-sessions",
    sessionId: "missing",
    createRpcClient: () => client,
    abortGraceMs: 10,
  });

  await run.abort();
  assert.equal(abortAccepted, true);
  const result = await run.promise;

  assert.equal(result.ok, true);
  assert.equal(stopped, true);
  assert.equal(listener, undefined);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantOutputCollector, piColorEnvironment } from "../src/pi-session.js";

test("headless pi runs restore truecolor output", () => {
  assert.deepEqual(piColorEnvironment({ TERM: "dumb" }), {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    FORCE_COLOR: "3",
  });
});

test("pi color environment preserves caller overrides", () => {
  assert.deepEqual(piColorEnvironment({
    TERM: "screen-256color",
    COLORTERM: "24bit",
    FORCE_COLOR: "1",
  }), {
    TERM: "screen-256color",
    COLORTERM: "24bit",
    FORCE_COLOR: "1",
  });
  assert.deepEqual(piColorEnvironment({ TERM: "dumb", NO_COLOR: "1" }), {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  });
});

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

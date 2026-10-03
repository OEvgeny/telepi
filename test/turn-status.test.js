import assert from "node:assert/strict";
import test from "node:test";

import { advanceTurnStatus, createTurnStatusState, formatTurnStatus } from "../src/turn-status.js";

test("turn status renders current and previous model steps from Pi events", () => {
  const state = createTurnStatusState(0);
  advanceTurnStatus(state, { type: "turn_start", turnIndex: 0 }, 0);
  advanceTurnStatus(state, {
    type: "message_end",
    message: { role: "assistant", usage: { output: 5800 } },
  }, 1_000);
  advanceTurnStatus(state, {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
  }, 2_000);
  advanceTurnStatus(state, {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
  }, 5_000);
  advanceTurnStatus(state, {
    type: "turn_end",
    message: { role: "assistant", stopReason: "toolUse" },
    toolResults: [],
  }, 6_000);
  advanceTurnStatus(state, { type: "turn_start", turnIndex: 1 }, 7_000);
  advanceTurnStatus(state, {
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "work" },
  }, 8_000);

  assert.equal(formatTurnStatus(state, { now: 50_000, pulseIndex: 2 }), [
    "◑ Step 2 · ⚒ 1 · 5.8k tok",
    "→ Reasoning · 42s",
    "← Bash ✓ · 3s",
  ].join("\n"));
});

test("turn status counts parallel tools once and reports failed previous work", () => {
  const state = createTurnStatusState(0);
  advanceTurnStatus(state, { type: "turn_start", turnIndex: 3 }, 0);
  advanceTurnStatus(state, {
    type: "tool_execution_start",
    toolCallId: "bash-1",
    toolName: "bash",
  }, 1_000);
  advanceTurnStatus(state, {
    type: "tool_execution_start",
    toolCallId: "read-1",
    toolName: "read",
  }, 1_100);
  advanceTurnStatus(state, {
    type: "tool_execution_update",
    toolCallId: "bash-1",
    toolName: "bash",
  }, 1_200);
  advanceTurnStatus(state, {
    type: "tool_execution_end",
    toolCallId: "bash-1",
    toolName: "bash",
    isError: true,
  }, 2_000);
  advanceTurnStatus(state, {
    type: "tool_execution_end",
    toolCallId: "read-1",
    toolName: "read",
    isError: false,
  }, 3_000);
  advanceTurnStatus(state, {
    type: "turn_end",
    message: { role: "assistant", stopReason: "toolUse" },
  }, 4_000);

  assert.equal(state.toolsStarted, 2);
  assert.equal(state.previous.label, "Bash + Read ⚠1");
  assert.equal(formatTurnStatus(state, { now: 5_000, pulseIndex: 3 }), [
    "◒ Step 4 · ⚒ 2 · 0 tok",
    "→ Continuing · 1s",
    "← Bash + Read ⚠1 · 2s",
  ].join("\n"));
});

import assert from "node:assert/strict";
import test from "node:test";

import { advanceModelError } from "../src/pi/model-error.js";

function assistantEnd(stopReason, errorMessage) {
  return {
    type: "message_end",
    message: { role: "assistant", stopReason, errorMessage },
  };
}

test("a successful retry clears a transient model error", () => {
  const failed = advanceModelError(undefined, assistantEnd("error", "Connection error."));
  assert.deepEqual(failed, {
    lastError: "Connection error.",
    recoveredError: undefined,
  });

  const recovered = advanceModelError(failed.lastError, assistantEnd("stop"));
  assert.deepEqual(recovered, {
    lastError: undefined,
    recoveredError: "Connection error.",
  });
});

test("a terminal model error remains user-facing", () => {
  const failed = advanceModelError(undefined, assistantEnd("error", "Service unavailable"));
  const settled = advanceModelError(failed.lastError, { type: "agent_settled" });

  assert.equal(settled.lastError, "Service unavailable");
  assert.equal(settled.recoveredError, undefined);
});

test("tool continuation recovers an earlier error but abort does not", () => {
  const continued = advanceModelError("Connection error.", assistantEnd("toolUse"));
  assert.equal(continued.lastError, undefined);
  assert.equal(continued.recoveredError, "Connection error.");

  const aborted = advanceModelError("Connection error.", assistantEnd("aborted"));
  assert.equal(aborted.lastError, "Connection error.");
  assert.equal(aborted.recoveredError, undefined);
});

test("model errors without a provider message use a stable fallback", () => {
  const failed = advanceModelError(undefined, assistantEnd("error"));
  assert.equal(failed.lastError, "unknown model error");
});

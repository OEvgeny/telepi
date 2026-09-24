import assert from "node:assert/strict";
import test from "node:test";

import { createPendingControlTracker, summarizeTranscriptLifecycle } from "../src/pi/cli-driver.js";

const message = (role, content, stopReason) => ({
  type: "message",
  message: { role, content, stopReason },
});

test("RPC shutdown waits for an accepted control response", async () => {
  const tracker = createPendingControlTracker();
  let release;
  const control = tracker.track(() => new Promise((resolve) => {
    release = resolve;
  }));
  let finished = false;
  const waiting = tracker.wait().then(() => {
    finished = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  release();
  await control;
  await waiting;
  assert.equal(finished, true);
});

test("a terminal assistant schedules the settle fallback", () => {
  assert.deepEqual(summarizeTranscriptLifecycle([
    message("user", "initial prompt"),
    message("assistant", [{ type: "text", text: "done" }], "stop"),
  ]), {
    finalTexts: ["done"],
    settleAction: "schedule",
  });
});

test("a steer after a terminal assistant clears the settle fallback in the same poll", () => {
  assert.deepEqual(summarizeTranscriptLifecycle([
    message("assistant", [{ type: "text", text: "first answer" }], "stop"),
    message("user", "steered follow-up"),
  ]), {
    finalTexts: ["first answer"],
    settleAction: "clear",
  });
});

test("new work after a terminal assistant keeps the settle fallback cleared", () => {
  assert.deepEqual(summarizeTranscriptLifecycle([
    message("assistant", "first answer", "stop"),
    message("user", "steered follow-up"),
    message("assistant", "working", "toolUse"),
    message("toolResult", "still working"),
  ]), {
    finalTexts: ["first answer"],
    settleAction: "clear",
  });
});

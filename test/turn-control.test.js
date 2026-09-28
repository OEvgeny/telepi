import assert from "node:assert/strict";
import test from "node:test";

import { isStopCommand, requestTurnStop } from "../src/turn-control.js";

test("stop command accepts Telegram bot mentions but not command prefixes", () => {
  assert.equal(isStopCommand("/stop"), true);
  assert.equal(isStopCommand(" /STOP@telepi_bot "), true);
  assert.equal(isStopCommand("/stop now"), true);
  assert.equal(isStopCommand("/stopping"), false);
  assert.equal(isStopCommand("please /stop"), false);
});

test("turn stop waits until abort is ready and marks the run cancelled", async () => {
  let makeReady;
  let aborted = false;
  const active = {
    ready: new Promise((resolve) => {
      makeReady = resolve;
    }),
    readyError: undefined,
    cancelled: false,
    abort: async () => {
      aborted = true;
    },
  };

  const stopping = requestTurnStop(active);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborted, false);
  makeReady();

  assert.equal(await stopping, "requested");
  assert.equal(aborted, true);
  assert.equal(active.cancelled, true);
  assert.equal(await requestTurnStop(active), "stopping");
});

test("turn stop handles idle, unavailable, and failed cancellation", async () => {
  assert.equal(await requestTurnStop(undefined), "idle");
  assert.equal(await requestTurnStop({
    ready: Promise.resolve(),
    readyError: undefined,
    cancelled: false,
    abort: undefined,
  }), "unavailable");

  const failure = new Error("abort failed");
  const active = {
    ready: Promise.resolve(),
    readyError: undefined,
    cancelled: false,
    abort: async () => {
      throw failure;
    },
  };
  await assert.rejects(requestTurnStop(active), failure);
  assert.equal(active.cancelled, false);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pumpPendingSteers } from "../src/topic-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function optionsFor(active, delivered, overrides = {}) {
  return {
    canSteer: () => active.acceptsSteering && !active.stopRequested,
    hydrate: async (envelope) => ({ ...envelope, hydrated: true }),
    steer: async (envelope) => { delivered.push(envelope.id); },
    ...overrides,
  };
}

test("gateway starts the inherited-backlog pump and clears queue reactions on admission", async () => {
  const gateway = await readFile(new URL("../src/gateway.js", import.meta.url), "utf8");
  assert.match(gateway, /if \(run\.pending\.length\) steerInheritedPendingEnvelopes\(config, telegram, topic, run\)/);
  assert.match(gateway, /clearQueuedMessageReaction\(telegram, topic, envelope, "message_steered"\)/);
  assert.match(gateway, /clearQueuedMessageReaction\(telegram, topic, next, "message_dispatched"\)/);
});

test("inherited topic backlog steers into the fresh run in FIFO order", async () => {
  const ready = deferred();
  const active = {
    ready: ready.promise,
    readyError: undefined,
    acceptsSteering: false,
    stopRequested: false,
    pending: [{ id: "follow-up-one" }, { id: "follow-up-two" }],
  };
  const delivered = [];
  const pumping = pumpPendingSteers(active, optionsFor(active, delivered));

  active.acceptsSteering = true;
  ready.resolve();
  await pumping;

  assert.deepEqual(delivered, ["follow-up-one", "follow-up-two"]);
  assert.deepEqual(active.pending, []);
  assert.equal(active.pendingSteerPump, undefined);
});

test("new arrivals join an inherited backlog without overtaking it", async () => {
  const firstDelivery = deferred();
  const active = {
    ready: Promise.resolve(),
    readyError: undefined,
    acceptsSteering: true,
    stopRequested: false,
    pending: [{ id: "older" }],
  };
  const delivered = [];
  const pumping = pumpPendingSteers(active, optionsFor(active, delivered, {
    steer: async (envelope) => {
      delivered.push(envelope.id);
      if (envelope.id === "older") await firstDelivery.promise;
    },
  }));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  active.pending.push({ id: "newer" });
  firstDelivery.resolve();
  await pumping;

  assert.deepEqual(delivered, ["older", "newer"]);
  assert.deepEqual(active.pending, []);
});

test("stopping or failed steering leaves backlog replayable", async () => {
  const stopped = {
    ready: Promise.resolve(),
    readyError: undefined,
    acceptsSteering: true,
    stopRequested: true,
    pending: [{ id: "preserved-on-stop" }],
  };
  const delivered = [];
  await pumpPendingSteers(stopped, optionsFor(stopped, delivered));
  assert.deepEqual(delivered, []);
  assert.deepEqual(stopped.pending, [{ id: "preserved-on-stop" }]);

  const failure = new Error("steer unavailable");
  const failures = [];
  const active = {
    ready: Promise.resolve(),
    readyError: undefined,
    acceptsSteering: true,
    stopRequested: false,
    pending: [{ id: "preserved-on-failure" }, { id: "later" }],
  };
  await pumpPendingSteers(active, optionsFor(active, delivered, {
    steer: async () => { throw failure; },
    onFailure: (error, envelope) => failures.push({ error, envelope }),
  }));

  assert.deepEqual(active.pending, [{ id: "preserved-on-failure" }, { id: "later" }]);
  assert.deepEqual(failures, [{ error: failure, envelope: { id: "preserved-on-failure" } }]);
});

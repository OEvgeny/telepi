import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACTION_REQUEST_OVERRIDES as DIRECT_PI_OVERRIDES,
  createPiCompactionPolicyExtension as createDirectPiCompactionPolicyExtension,
} from "../extensions/compaction-reasoning-budget.js";
import {
  COMPACTION_REQUEST_OVERRIDES,
  createDurableCompactionModels,
  createPiCompactionPolicyExtension,
  piCompactionPolicyFactories,
  resolveCompactionRequestOverrides,
  withCompactionRequestOptions,
} from "../src/compaction-policy.js";

function createExtensionBus() {
  const listeners = new Map();
  return {
    api(handlers) {
      return {
        on(name, handler) {
          handlers.set(name, handler);
        },
        events: {
          emit(name, data) {
            for (const listener of listeners.get(name) || []) listener(data);
          },
          on(name, handler) {
            const entries = listeners.get(name) || [];
            entries.push(handler);
            listeners.set(name, entries);
            return () => entries.splice(entries.indexOf(handler), 1);
          },
        },
      };
    },
  };
}

test("compaction request overrides are fixed to Strata", () => {
  assert.deepEqual(resolveCompactionRequestOverrides("strata"), {
    reasoning_budget_tokens: 512,
  });
  assert.equal(resolveCompactionRequestOverrides("other"), null);
  assert.deepEqual(DIRECT_PI_OVERRIDES, COMPACTION_REQUEST_OVERRIDES);
  assert.equal(typeof createDirectPiCompactionPolicyExtension(async () => {}), "function");
});

test("Pi extension runs stock compaction through an overridden Strata stream", async () => {
  const handlers = new Map();
  const bus = createExtensionBus();
  const compactCalls = [];
  const streamCalls = [];
  const expectedCompaction = { summary: "summary", firstKeptEntryId: "kept" };
  const compact = async (...args) => {
    compactCalls.push(args);
    const streamFn = args[7];
    const streamResult = streamFn(
      { provider: "strata", id: "swift" },
      { messages: [] },
      { maxTokens: 13107, samplingParams: { top_p: 0.9 } },
    );
    assert.equal(streamResult, "stream");
    return expectedCompaction;
  };
  const retry = { enabled: true, maxRetries: 3, baseDelayMs: 1000 };
  createPiCompactionPolicyExtension(compact, { getRetrySettings: () => retry })(bus.api(handlers));

  const signal = new AbortController().signal;
  const event = {
    preparation: { firstKeptEntryId: "kept" },
    customInstructions: "focus",
    signal,
  };
  const context = {
    model: { provider: "strata", id: "swift" },
    thinkingLevel: "high",
    modelRegistry: {
      streamSimple(model, modelContext, options) {
        streamCalls.push({ model, modelContext, options });
        return "stream";
      },
    },
  };

  assert.deepEqual(await handlers.get("session_before_compact")(event, context), {
    compaction: expectedCompaction,
  });
  assert.equal(compactCalls.length, 1);
  assert.deepEqual(compactCalls[0].slice(0, 10), [
    event.preparation,
    context.model,
    undefined,
    undefined,
    "focus",
    signal,
    "high",
    compactCalls[0][7],
    undefined,
    retry,
  ]);
  assert.deepEqual(streamCalls, [{
    model: { provider: "strata", id: "swift" },
    modelContext: { messages: [] },
    options: {
      maxTokens: 13107,
      samplingParams: { top_p: 0.9, reasoning_budget_tokens: 512 },
    },
  }]);
  assert.deepEqual([...handlers.keys()], ["session_before_compact"]);

  assert.equal(await handlers.get("session_before_compact")(
    event,
    { ...context, model: { provider: "other", id: "model" } },
  ), undefined);
  assert.equal(compactCalls.length, 1);
});

test("Pi extension registers once when direct discovery and Telepi preload overlap", () => {
  const directHandlers = new Map();
  const preloadedHandlers = new Map();
  const bus = createExtensionBus();
  const compact = async () => ({ summary: "summary" });
  const compactionReasoningBudget = createPiCompactionPolicyExtension(compact);

  compactionReasoningBudget(bus.api(directHandlers));
  compactionReasoningBudget(bus.api(preloadedHandlers));
  assert.deepEqual([...directHandlers.keys()], ["session_before_compact"]);
  assert.deepEqual([...preloadedHandlers.keys()], []);
  assert.equal(typeof piCompactionPolicyFactories(compact)[0].factory, "function");
  assert.throws(() => piCompactionPolicyFactories()[0].factory, /Pi compact function is required/);
});

test("Durable compaction wrapper adds sampling params without changing ordinary streaming", async () => {
  const calls = [];
  const models = {
    marker: "models",
    completeSimple(model, context, options) {
      assert.equal(this.marker, "models");
      calls.push({ method: "completeSimple", model, context, options });
      return Promise.resolve({ stopReason: "stop" });
    },
    streamSimple(model, context, options) {
      assert.equal(this.marker, "models");
      calls.push({ method: "streamSimple", model, context, options });
      return "stream";
    },
  };
  const wrapped = createDurableCompactionModels(models);
  const model = { provider: "strata", id: "swift" };
  const context = { messages: [] };

  await wrapped.completeSimple(model, context, { samplingParams: { temperature: 0 } });
  assert.deepEqual(calls[0].options, {
    samplingParams: {
      temperature: 0,
      reasoning_budget_tokens: 512,
    },
  });
  assert.equal(wrapped.streamSimple(model, context, { reasoning: "high" }), "stream");
  assert.deepEqual(calls[1].options, { reasoning: "high" });
});

test("compaction options preserve existing sampling params and let policy win", () => {
  assert.deepEqual(withCompactionRequestOptions({
    maxTokens: 10000,
    samplingParams: { reasoning_budget_tokens: 0, top_p: 0.9 },
  }, "strata"), {
    maxTokens: 10000,
    samplingParams: { reasoning_budget_tokens: 512, top_p: 0.9 },
  });
});

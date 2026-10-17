import { compact } from "@earendil-works/pi-coding-agent";

const REGISTRATION_CHANNEL = "telepi:compaction-reasoning-budget:register";

export const COMPACTION_REQUEST_OVERRIDES = Object.freeze({
  strata: Object.freeze({
    reasoning_budget_tokens: 512,
  }),
});

export function createPiCompactionPolicyExtension(compactFn) {
  if (typeof compactFn !== "function") throw new TypeError("Pi compact function is required");

  return function compactionReasoningBudget(pi) {
    // Direct discovery can overlap Telepi's preloaded copy of the policy.
    const claim = { claimed: false };
    pi.events.emit(REGISTRATION_CHANNEL, claim);
    if (claim.claimed) return;
    pi.events.on(REGISTRATION_CHANNEL, (request) => {
      if (request && typeof request === "object") request.claimed = true;
    });

    pi.on("session_before_compact", async (event, context) => {
      if (!resolveCompactionRequestOverrides(context.model?.provider)) return undefined;

      // Pi invokes its Agent stream function directly for built-in summaries,
      // outside the Agent loop that attaches before_provider_request. Supply the
      // same stock compact() operation with the override on its model stream.
      const streamFn = (model, modelContext, options) => context.modelRegistry.streamSimple(
        model,
        modelContext,
        withCompactionRequestOptions(options, model.provider),
      );
      const compaction = await compactFn(
        event.preparation,
        context.model,
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        context.thinkingLevel,
        streamFn,
      );
      return { compaction };
    });
  };
}

export function resolveCompactionRequestOverrides(provider) {
  const overrides = COMPACTION_REQUEST_OVERRIDES[provider];
  return overrides ? { ...overrides } : null;
}

export function withCompactionRequestOptions(options, provider) {
  const overrides = resolveCompactionRequestOverrides(provider);
  if (!overrides) return options;
  return {
    ...options,
    samplingParams: {
      ...(options?.samplingParams || {}),
      ...overrides,
    },
  };
}

/**
 * Pi's extension loader maps this import to the active Pi installation, so a
 * linked copy never mixes its host runtime with Telepi's package dependency.
 */
export default createPiCompactionPolicyExtension(compact);

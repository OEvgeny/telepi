const REGISTRATION_CHANNEL = "telepi:compaction-reasoning-budget:register";

export const COMPACTION_REQUEST_OVERRIDES = Object.freeze({
  strata: Object.freeze({
    reasoning_budget_tokens: 512,
  }),
});

export function createPiCompactionPolicyExtension(compact) {
  if (typeof compact !== "function") throw new TypeError("Pi compact function is required");

  return function compactionReasoningBudget(pi) {
    // A default Pi profile may discover the linked extension while Telepi also
    // preloads this factory. Claim the shared runtime once through the event bus.
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
      // same stock compact() operation with a ModelRegistry stream that carries
      // the compaction-only sampling override explicitly.
      const streamFn = (model, modelContext, options) => context.modelRegistry.streamSimple(
        model,
        modelContext,
        withCompactionRequestOptions(options, model.provider),
      );
      const compaction = await compact(
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

export function piCompactionPolicyFactories(compact) {
  return [{
    name: "telepi-compaction-reasoning-budget",
    hidden: true,
    factory: createPiCompactionPolicyExtension(compact),
  }];
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

export function createDurableCompactionModels(models) {
  if (!models) return models;
  const completeSimple = models.completeSimple.bind(models);
  return new Proxy(models, {
    get(target, property) {
      if (property === "completeSimple") {
        return (model, context, options) => completeSimple(
          model,
          context,
          withCompactionRequestOptions(options, model.provider),
        );
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

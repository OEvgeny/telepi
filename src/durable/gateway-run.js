import { buildDurableEndpointSpec, buildDurableSubmission, durableEndpointKey } from "./topic.js";

export async function runDurableTopic(driver, config, telegram, topic, envelope, active) {
  const endpoint = buildDurableEndpointSpec(config, topic, {
    infrastructureAgentDir: driver.infrastructureAgentDir,
  });
  await driver.ensureEndpoint(endpoint);

  const waits = [];
  const submit = async (nextEnvelope, whenBusy) => {
    const admitted = await driver.submit(
      endpoint.endpointKey,
      buildDurableSubmission(config, topic, nextEnvelope, { whenBusy }),
    );
    waits.push({ submissionId: admitted.submissionId, envelope: nextEnvelope });
    return admitted;
  };

  active.abort = () => driver.abort(endpoint.endpointKey);
  active.steer = async (nextEnvelope) => {
    active.currentReplyToMessageId = nextEnvelope.messageId || active.currentReplyToMessageId;
    await submit(nextEnvelope, "steer");
    const recoveryIndex = active.steered.indexOf(nextEnvelope);
    if (recoveryIndex >= 0) active.steered.splice(recoveryIndex, 1);
  };
  active.acceptsSteering = true;
  await submit(envelope, "followUp");
  active.resolveReady();

  const deliveredEntries = new Set();
  let streamedTextCount = 0;
  for (let index = 0; index < waits.length; index += 1) {
    const waiting = waits[index];
    const result = await driver.waitSubmission(endpoint.endpointKey, waiting.submissionId);
    if (result.status !== "done") {
      if (active.stopRequested && result.reason === "aborted") continue;
      return {
        ok: false,
        code: 1,
        stdout: "",
        stderr: `Durable submission was not answered: ${result.reason || "unknown"}`,
        streamedTextCount,
      };
    }
    for (const answer of result.answers || []) {
      if (deliveredEntries.has(answer.entryId)) continue;
      deliveredEntries.add(answer.entryId);
      if (!answer.text) continue;
      telegram.queueAssistantTextDisplay(active, waiting.envelope, answer.text);
      streamedTextCount += 1;
    }
  }

  return { ok: true, code: 0, stdout: "", stderr: "", streamedTextCount };
}

export async function compactDurableTopic(driver, config, topic, instructions) {
  const endpoint = buildDurableEndpointSpec(config, topic, {
    infrastructureAgentDir: driver.infrastructureAgentDir,
  });
  await driver.ensureEndpoint(endpoint);
  return driver.compact(endpoint.endpointKey, instructions);
}

export async function abortDurableTopic(driver, topic) {
  return driver.abort(durableEndpointKey(topic));
}

export function durableUnavailableMessage(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/Durable (?:driver is closing|host (?:is not connected|closed|exited)|connection (?:was )?lost)/i.test(message)) {
    return "Durable backend is restarting. Please retry in a moment.";
  }
  return null;
}

export function durableEventToPiEvents(event, turnIndex = 0) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "turn_start") return [{ type: "turn_start", turnIndex }];
  if (event.type === "run_end") return [{ type: "agent_end" }];
  if (event.type === "message_start") return [{ type: "message_start", message: event.message }];
  if (event.type === "message_update") {
    return (event.changes || []).map((change) => ({
      type: "message_update",
      assistantMessageEvent: {
        type: change.type,
        ...(change.block?.type === "toolCall" ? { toolCall: change.block } : {}),
      },
    }));
  }
  if (event.type === "message_end") {
    const message = event.entry?.model?.find((candidate) => candidate.role === "assistant");
    return message ? [{ type: "message_end", message }] : [];
  }
  if (event.type === "tool_execution_end") {
    const message = event.entry?.model?.find((candidate) => candidate.role === "toolResult");
    return [{ ...event, isError: message?.isError === true }];
  }
  if ([
    "turn_end",
    "tool_execution_start",
    "tool_execution_update",
    "auto_retry_start",
    "auto_retry_end",
    "compaction_start",
    "compaction_end",
  ].includes(event.type)) return [event];
  return [];
}

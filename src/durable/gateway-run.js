import { buildDurableEndpointSpec, buildDurableSubmission, durableEndpointKey } from "./topic.js";

export async function runDurableTopic(driver, config, telegram, topic, envelope, active) {
  const endpoint = buildDurableEndpointSpec(config, topic, {
    infrastructureAgentDir: driver.infrastructureAgentDir,
  });
  await driver.ensureEndpoint(endpoint);

  const waits = [];
  const submit = async (nextEnvelope, whenBusy) => {
    const staged = await stageEnvelopeAttachments(driver, endpoint, nextEnvelope);
    const admitted = await driver.submit(
      endpoint.endpointKey,
      buildDurableSubmission(config, topic, staged, { whenBusy }),
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
  const textDelivery = createAssistantTextDelivery(telegram, active, active.envelope || envelope);
  // Durable streams each assistant entry as it commits. Deliver that text at
  // the commit, not when the submission settles, so narration before a tool
  // call reaches Telegram while the model is still working.
  const unsubscribe = typeof driver.onEvent === "function"
    ? driver.onEvent((event, data) => {
      if (event !== "conversation.events" || data?.endpointKey !== endpoint.endpointKey) return;
      if (!Array.isArray(data.events)) return;
      for (const durableEvent of data.events) {
        if (durableEvent?.type !== "message_end") continue;
        const text = assistantTextFromEntry(durableEvent.entry);
        if (text) void textDelivery.deliver(durableEvent.entry?.id, text).catch(() => undefined);
      }
    })
    : undefined;

  try {
    await submit(envelope, "followUp");
    active.resolveReady();

    const deliveredEntries = new Set();
    const undeliveredTexts = [];
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
          stderr: `Durable submission was not answered: ${result.reason || "unknown"}${result.detail ? ` (${result.detail})` : ""}`,
          streamedTextCount,
        };
      }
      for (const answer of result.answers || []) {
        if (deliveredEntries.has(answer.entryId)) continue;
        deliveredEntries.add(answer.entryId);
        if (!answer.text) continue;
        try {
          // The live watch may already have sent this entry; delivery is keyed
          // by entry, so a replayed view or a late settle cannot duplicate it.
          await textDelivery.deliver(answer.entryId, answer.text, waiting.envelope);
          streamedTextCount += 1;
        } catch (error) {
          undeliveredTexts.push(answer.text);
          console.error(`Durable assistant text delivery failed: ${error instanceof Error ? error.stack || error.message : error}`);
        }
      }
    }

    return {
      ok: true,
      code: 0,
      stdout: "",
      stderr: "",
      streamedTextCount,
      undeliveredText: undeliveredTexts.join("\n\n"),
    };
  } finally {
    unsubscribe?.();
  }
}

// One assistant entry can hold several text blocks; Telegram shows them as one
// message, exactly as the Pi path folds one assistant message into one send.
export function assistantTextFromEntry(entry) {
  const messages = Array.isArray(entry?.model) ? entry.model : [];
  return messages
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("")
    .trim();
}

// Live watch batches and the settled submission can name the same assistant
// entry, and a replayed view can repeat one. Deduplicate by entry ID, not by
// text: two entries that say the same words ("Checking.") are two messages.
// A Telegram failure keeps the entry retryable.
function createAssistantTextDelivery(telegram, active, envelope) {
  const delivered = new Set();
  const pending = new Map();
  const send = (key, replyEnvelope, text) => telegram.queueAssistantTextDisplay(active, replyEnvelope, text).then(
    () => {
      delivered.add(key);
      pending.delete(key);
      return true;
    },
    (error) => {
      pending.delete(key);
      throw error;
    },
  );
  return {
    deliver(entryId, text, replyEnvelope = envelope) {
      // An entry without an ID cannot be matched later; key it by its text.
      const key = entryId == null ? `text:${text}` : `entry:${entryId}`;
      if (delivered.has(key)) return Promise.resolve(false);
      const inFlight = pending.get(key);
      if (inFlight) return inFlight;
      const attempt = send(key, replyEnvelope || envelope, text);
      pending.set(key, attempt);
      return attempt;
    },
  };
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

// Attachments are downloaded on the gateway host. For a conversation at an SSH
// location, copy them to that machine so the paths in the prompt are real
// there. If the copy fails, the message still goes through: each attachment
// says it is unavailable and why, instead of naming a path that does not exist.
export async function stageEnvelopeAttachments(driver, endpoint, envelope) {
  const attachments = envelope?.attachments || [];
  if (endpoint?.location?.type !== "ssh" || !attachments.some((attachment) => attachment?.path)) return envelope;
  if (typeof driver.stageAttachments !== "function") return envelope;
  try {
    const staged = await driver.stageAttachments(endpoint.endpointKey, {
      chatId: envelope.chatId,
      topicId: envelope.topicId,
      attachments,
    });
    return { ...envelope, attachments: staged.attachments };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Durable attachment staging failed endpoint=${endpoint.endpointKey}: ${message}`);
    return {
      ...envelope,
      attachments: attachments.map((attachment) => (attachment?.path
        ? { ...attachment, unavailable: `not copied to ${endpoint.location.host}: ${message}` }
        : attachment)),
    };
  }
}

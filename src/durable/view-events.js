// Durable 1.5 removed `watchEvents()`: a client now renders the conversation
// view (entries plus the `pi.live` document) instead of a stream of events.
// Telepi's gateway still speaks the event vocabulary (turn status, reasoning
// reset, live assistant text), so this module derives those events from two
// successive views. It keeps the event shapes the 1.0 stream had, limited to
// what Telepi reads. It is pure: no Harness, only view values.

const LIVE_DOC = "pi.live";

export function createViewEventTranslator(initial) {
  let before = initial;
  let seenEntryId = newestEntryId(initial?.entries);
  return {
    advance(after) {
      const appended = (after?.entries || [])
        .filter((entry) => Number(entry?.id) > seenEntryId)
        .sort((left, right) => left.id - right.id);
      const events = translateView(before, after, appended);
      seenEntryId = Math.max(seenEntryId, newestEntryId(appended));
      before = after;
      return events;
    },
  };
}

export function translateView(before, after, appended) {
  const was = liveOf(before);
  const now = liveOf(after);
  const events = [];

  // Progress: tool starts, the in-flight answer, tool output, retries.
  const slotsBefore = new Map((was.tools || []).map((slot) => [slot.callId, slot]));
  const slots = now.tools || [];
  for (const slot of slots) {
    if (slot.status !== "running" || slotsBefore.get(slot.callId)?.status === "running") continue;
    events.push({ type: "tool_execution_start", toolCallId: slot.callId, toolName: slot.name, args: {} });
  }

  const partialBefore = was.generation?.message;
  const partial = now.generation?.message;
  if (partial !== undefined && partialBefore === undefined) {
    events.push({ type: "message_start", message: partial });
    const changes = messageChanges(undefined, partial);
    if (changes.length) events.push({ type: "message_update", usage: partial.usage, changes });
  } else if (partial !== undefined) {
    const changes = messageChanges(partialBefore, partial);
    if (changes.length) events.push({ type: "message_update", usage: partial.usage, changes });
  }

  for (const slot of slots) {
    const previous = slotsBefore.get(slot.callId);
    if (slot.status !== "running" || previous?.status !== "running") continue;
    if (slot.output === previous.output && slot.details === previous.details) continue;
    events.push({
      type: "tool_execution_update",
      toolCallId: slot.callId,
      toolName: slot.name,
      output: { set: slot.output ?? "" },
    });
  }

  const retry = now.generation?.retry;
  const retryBefore = was.generation?.retry;
  if (retry !== undefined && retryBefore === undefined) {
    events.push({ type: "auto_retry_start", attempt: now.generation.attempt, at: retry.at, errorMessage: retry.error });
  }
  if (retryBefore !== undefined && retry === undefined) {
    events.push({ type: "auto_retry_end", attempt: was.generation?.attempt });
  }

  // Tools that end: a slot that becomes done, one created done (a call the
  // request did not offer), or an unfinished one that vanishes with its run.
  const toolEnds = [];
  const endTool = (callId, name, entryId) => {
    const entry = entryId === undefined
      ? appended.find((candidate) => toolResultOf(candidate)?.toolCallId === callId)
      : appended.find((candidate) => candidate.id === entryId);
    toolEnds.push({
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: name,
      isError: toolResultOf(entry)?.isError === true,
      ...(entry === undefined ? {} : { entry }),
    });
  };
  for (const previous of slotsBefore.values()) {
    if (previous.status === "done") continue;
    const slot = slots.find((candidate) => candidate.callId === previous.callId);
    if (slot?.status === "done") endTool(previous.callId, previous.name, slot.entry);
    else if (slot === undefined) endTool(previous.callId, previous.name, undefined);
  }
  for (const slot of slots) {
    if (slot.status === "done" && !slotsBefore.has(slot.callId)) endTool(slot.callId, slot.name, slot.entry);
  }

  // Entries in append order; a tool's end directly precedes its result.
  let assistantAppended = false;
  for (const entry of appended) {
    events.push(...toolEnds.filter((end) => end.entry === entry));
    const message = Array.isArray(entry.model) ? entry.model[0] : undefined;
    if (message === undefined) {
      events.push({ type: "entry_appended", entry });
      continue;
    }
    // An answer that streamed already started with its first partial.
    const streamed = message.role === "assistant" && partialBefore !== undefined && !assistantAppended;
    if (message.role === "assistant") assistantAppended = true;
    if (!streamed) events.push({ type: "message_start", message });
    events.push({ type: "message_end", entry });
  }
  events.push(...toolEnds.filter((end) => end.entry === undefined));

  const compactionsBefore = was.compactions || [];
  const compactions = now.compactions || [];
  for (const { taskId, trigger } of compactionsBefore) {
    if (!compactions.some((status) => status.taskId === taskId)) {
      events.push({ type: "compaction_end", taskId, reason: trigger });
    }
  }

  // A run that ends without an answer because its task broke, as the 1.0
  // stream reported a faulted or orphaned task.
  const failure = now.runFailure;
  if (failure !== undefined
    && failure.taskId !== was.runFailure?.taskId
    && (failure.reason === "faulted" || failure.reason === "orphaned")) {
    events.push({
      type: "task_failed",
      taskId: failure.taskId,
      kind: "pi.generation",
      message: failure.detail || failure.reason,
    });
  }

  // The run's task is its generation, handed from one to the next: a new
  // task ID is a new turn, and the previous one has ended.
  const run = now.run;
  const runBefore = was.run;
  const turnChanged = run?.taskId !== runBefore?.taskId;
  if (runBefore !== undefined && turnChanged) events.push({ type: "turn_end" });
  const runChanged = run === undefined
    ? runBefore !== undefined
    : runBefore === undefined || run.inputs?.[0] !== runBefore.inputs?.[0];
  if (runBefore !== undefined && runChanged) events.push({ type: "run_end", inputs: runBefore.inputs || [] });

  for (const { taskId, trigger, blocking } of compactions) {
    if (!compactionsBefore.some((status) => status.taskId === taskId)) {
      events.push({ type: "compaction_start", taskId, reason: trigger, blocking });
    }
  }
  if (run !== undefined && runChanged) events.push({ type: "run_start", inputs: run.inputs || [] });
  if (run !== undefined && turnChanged) events.push({ type: "turn_start" });
  return events;
}

// The changes of the in-flight answer between two partials, as the 1.0
// stream's `message_update` carried them: starts of new blocks, appends to
// text and thinking, and argument changes of tool calls.
export function messageChanges(before, after) {
  const changes = [];
  const previous = Array.isArray(before?.content) ? before.content : [];
  const current = Array.isArray(after?.content) ? after.content : [];
  for (let index = 0; index < current.length; index += 1) {
    const block = current[index];
    const old = previous[index];
    if (!block) continue;
    if (!old || old.type !== block.type) {
      changes.push({ type: startType(block.type), contentIndex: index, block });
      continue;
    }
    if (block.type === "text" || block.type === "thinking") {
      const field = block.type;
      const text = String(block[field] || "");
      const oldText = String(old[field] || "");
      if (text === oldText) continue;
      changes.push(text.startsWith(oldText)
        ? { type: `${field}_delta`, contentIndex: index, delta: text.slice(oldText.length) }
        : { type: "block", contentIndex: index, block });
      continue;
    }
    if (block.type === "toolCall") {
      if (block.name === old.name && sameJson(block.arguments, old.arguments)) continue;
      changes.push({ type: "toolcall_delta", contentIndex: index, block });
    }
  }
  return changes;
}

function startType(type) {
  if (type === "text") return "text_start";
  if (type === "thinking") return "thinking_start";
  return "toolcall_start";
}

function liveOf(view) {
  return view?.docs?.[LIVE_DOC] || {};
}

function toolResultOf(entry) {
  const message = Array.isArray(entry?.model) ? entry.model[0] : undefined;
  return message?.role === "toolResult" ? message : undefined;
}

function newestEntryId(entries) {
  let newest = 0;
  for (const entry of entries || []) {
    const id = Number(entry?.id);
    if (Number.isFinite(id) && id > newest) newest = id;
  }
  return newest;
}

function sameJson(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

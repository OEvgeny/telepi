const PULSE_FRAMES = ["◐", "◓", "◑", "◒"];

export function createTurnStatusState(now = Date.now()) {
  return {
    step: 1,
    stepStartedAt: now,
    phase: { key: "starting", label: "Starting", startedAt: now },
    previous: undefined,
    toolsStarted: 0,
    toolCounts: new Map(),
    outputTokens: 0,
    activeTools: new Map(),
    currentStepTools: new Map(),
  };
}

export function advanceTurnStatus(state, event, now = Date.now()) {
  if (!state || !event || typeof event !== "object") return state;

  if (event.type === "turn_start") {
    const turnIndex = Number(event.turnIndex);
    state.step = Number.isInteger(turnIndex) && turnIndex >= 0 ? turnIndex + 1 : state.step + 1;
    state.stepStartedAt = now;
    state.currentStepTools = new Map();
    setPhase(state, "model", "Waiting for model", now);
    return state;
  }

  if (event.type === "message_start" && event.message?.role === "assistant") {
    setPhase(state, "model", "Waiting for model", now);
    return state;
  }

  if (event.type === "message_update") {
    const messageEvent = event.assistantMessageEvent;
    const type = String(messageEvent?.type || "");
    if (type.startsWith("thinking_")) setPhase(state, "reasoning", "Reasoning", now);
    else if (type.startsWith("text_")) setPhase(state, "drafting", "Drafting response", now);
    else if (type.startsWith("toolcall_")) {
      const name = messageEvent?.toolCall?.name || messageEvent?.toolName;
      setPhase(state, `calling:${name || "tool"}`, name ? `Calling ${displayToolName(name)}` : "Preparing tool call", now);
    }
    return state;
  }

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const output = Number(event.message.usage?.output);
    if (Number.isFinite(output) && output > 0) state.outputTokens += output;
    return state;
  }

  if (event.type === "tool_execution_start") {
    registerToolStart(state, event, now);
    setRunningToolsPhase(state, now);
    return state;
  }

  if (event.type === "tool_execution_update") {
    registerToolStart(state, event, now);
    setRunningToolsPhase(state, now);
    return state;
  }

  if (event.type === "tool_execution_end") {
    registerToolStart(state, event, now);
    const tool = state.currentStepTools.get(event.toolCallId);
    if (tool) {
      tool.isError = event.isError === true;
      tool.endedAt = now;
    }
    state.activeTools.delete(event.toolCallId);
    if (state.activeTools.size) setRunningToolsPhase(state, now);
    else setPhase(state, "processing", "Processing tool result", now);
    return state;
  }

  if (event.type === "turn_end") {
    state.previous = {
      step: state.step,
      label: previousStepLabel(state, event),
      durationMs: previousStepDuration(state, now),
    };
    setPhase(state, "continuing", "Continuing", now);
    return state;
  }

  if (event.type === "agent_end") {
    setPhase(state, "finishing", "Finishing", now);
    return state;
  }

  if (event.type === "ui_prompt_start") {
    setPhase(state, "input", "Waiting for input", now);
    return state;
  }

  if (event.type === "auto_retry_start") {
    setPhase(state, "retry", "Retrying model", now);
    return state;
  }

  if (/compaction_start$/i.test(String(event.type || ""))) {
    setPhase(state, "compacting", "Compacting context", now);
  }
  return state;
}

export function formatTurnStatus(state, { now = Date.now(), pulseIndex = 0 } = {}) {
  const pulse = PULSE_FRAMES[positiveModulo(pulseIndex, PULSE_FRAMES.length)];
  const currentDuration = formatDuration(Math.max(0, now - state.phase.startedAt));
  const previous = state.previous
    ? `${state.previous.label} · ${formatDuration(state.previous.durationMs)}`
    : "No completed step";
  return [
    `${pulse} Step ${state.step} · ⚒ ${state.toolsStarted} · ${formatTokenCount(state.outputTokens)} tok`,
    `→ ${state.phase.label} · ${currentDuration}`,
    `← ${previous}`,
  ].join("\n");
}

function registerToolStart(state, event, now) {
  const id = String(event.toolCallId || "");
  if (!id) return;
  const name = String(event.toolName || "tool");
  if (!state.currentStepTools.has(id)) {
    state.currentStepTools.set(id, { name, isError: false, startedAt: now, endedAt: undefined });
    state.toolsStarted += 1;
    state.toolCounts.set(name, (state.toolCounts.get(name) || 0) + 1);
  }
  if (event.type !== "tool_execution_end") state.activeTools.set(id, name);
}

function setRunningToolsPhase(state, now) {
  const counts = countNames(state.activeTools.values());
  const names = [...counts.entries()].map(([name, count]) => `${displayToolName(name)}${count > 1 ? `×${count}` : ""}`);
  const key = `tools:${[...counts.entries()].map(([name, count]) => `${name}:${count}`).join("|")}`;
  setPhase(state, key, `Running ${names.join(" + ") || "tool"}`, now);
}

function previousStepDuration(state, now) {
  const tools = [...state.currentStepTools.values()];
  if (!tools.length) return Math.max(0, now - state.stepStartedAt);
  const startedAt = Math.min(...tools.map((tool) => tool.startedAt));
  const endedAt = Math.max(...tools.map((tool) => tool.endedAt ?? now));
  return Math.max(0, endedAt - startedAt);
}

function previousStepLabel(state, event) {
  if (state.currentStepTools.size) {
    const counts = countNames([...state.currentStepTools.values()].map((tool) => tool.name));
    const names = [...counts.entries()].map(([name, count]) => `${displayToolName(name)}${count > 1 ? `×${count}` : ""}`);
    const failed = [...state.currentStepTools.values()].filter((tool) => tool.isError).length;
    return `${names.join(" + ")}${failed ? ` ⚠${failed}` : " ✓"}`;
  }
  const reason = String(event.message?.stopReason || "");
  if (reason === "error") return "Model error ⚠";
  if (reason === "aborted") return "Aborted";
  if (reason === "length") return "Token limit ⚠";
  return "Response ✓";
}

function setPhase(state, key, label, now) {
  if (state.phase.key === key) return;
  state.phase = { key, label, startedAt: now };
}

function countNames(names) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return counts;
}

function displayToolName(value) {
  const text = String(value || "tool").replace(/[_-]+/g, " ").trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Tool";
}

function formatTokenCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  if (count < 1000) return String(count);
  if (count < 1_000_000) return compactDecimal(count / 1000, "k");
  return compactDecimal(count / 1_000_000, "m");
}

function compactDecimal(value, suffix) {
  const digits = value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function positiveModulo(value, divisor) {
  return ((Number(value) || 0) % divisor + divisor) % divisor;
}

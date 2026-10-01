export function advanceModelError(lastError, event) {
  if (event?.type !== "message_end" || event.message?.role !== "assistant") {
    return { lastError, recoveredError: undefined };
  }

  const stopReason = event.message.stopReason;
  if (stopReason === "error") {
    return {
      lastError: String(event.message.errorMessage || "unknown model error"),
      recoveredError: undefined,
    };
  }

  // Pi can retry a failed provider request within the same turn. A later
  // completed assistant attempt means the earlier model error was transient;
  // keep it in diagnostics, but do not present it as the turn's outcome.
  if (stopReason !== "aborted" && lastError) {
    return { lastError: undefined, recoveredError: lastError };
  }

  return { lastError, recoveredError: undefined };
}

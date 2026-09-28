export function isStopCommand(text) {
  return /^\/stop(?:@\S+)?(?:\s|$)/i.test(String(text || "").trim());
}

export async function requestTurnStop(active) {
  if (!active) return "idle";
  await active.ready;
  if (active.readyError) throw active.readyError;
  if (active.cancelled) return "stopping";
  if (typeof active.abort !== "function") return "unavailable";

  active.cancelled = true;
  try {
    await active.abort();
    return "requested";
  } catch (error) {
    active.cancelled = false;
    throw error;
  }
}

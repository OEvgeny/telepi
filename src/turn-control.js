export function isStopCommand(text) {
  return /^\/stop(?:@\S+)?(?:\s|$)/i.test(String(text || "").trim());
}

export async function requestTurnStop(active) {
  if (!active) return "idle";
  await active.ready;
  if (active.readyError) throw active.readyError;
  if (active.stopRequested) return "stopping";
  if (typeof active.abort !== "function") return "unavailable";

  active.stopRequested = true;
  // Steers accepted into this Pi run belong to the turn being stopped. Pi's
  // clear_queue command removes them from its internal queue; remove the
  // gateway recovery copies before abort can settle the run so its finalizer
  // cannot replay them as a new turn.
  const stoppedSteers = Array.isArray(active.steered) ? active.steered.splice(0) : [];
  try {
    await active.abort();
    return "requested";
  } catch (error) {
    if (Array.isArray(active.steered)) active.steered.unshift(...stoppedSteers);
    active.stopRequested = false;
    throw error;
  }
}

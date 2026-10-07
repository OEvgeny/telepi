// Steer backlog inherited from a non-steerable run (for example /compact)
// into the fresh run that follows it. This preserves FIFO order without
// turning related follow-ups into separate future runs.
export function pumpPendingSteers(active, options) {
  if (!active?.pending?.length || active.pendingSteerPump) {
    return active?.pendingSteerPump || Promise.resolve();
  }

  let pump;
  pump = (async () => {
    await active.ready;
    if (active.readyError) return;

    while (active.pending.length && options.canSteer()) {
      const queued = active.pending[0];
      let hydrated;
      try {
        hydrated = await options.hydrate(queued);
        // Stop or terminal cleanup may have begun while media was hydrating.
        if (!options.canSteer()) return;
        await options.steer(hydrated);
      } catch (error) {
        options.onFailure?.(error, queued);
        return;
      }

      const index = active.pending.indexOf(queued);
      if (index >= 0) active.pending.splice(index, 1);
      options.onSteered?.(hydrated, queued);
    }
  })().finally(() => {
    if (active.pendingSteerPump === pump) active.pendingSteerPump = undefined;
  });
  active.pendingSteerPump = pump;
  return pump;
}

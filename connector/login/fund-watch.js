// Live balance watch for the fund page: reads the balance now and then while the tab is visible, and reports when it
// rises. No React, no network and no real timers here (all injected), so node --test drives it with fakes.

export const WATCH_INTERVAL_MS = 10_000;

/**
 * watchBalance({read, onUpdate, doc, setTimer, clearTimer, intervalMs}) -> {stop, refresh}
 *   read(): Promise<bigint>, the balance in base units.
 *   onUpdate({status: "ready", units, arrived}) after each good read (`arrived`: base units added since the last read,
 *   0n on the first read and when the balance did not rise); onUpdate({status: "error"}) after a failed read, which
 *   keeps the last good balance for the next comparison.
 *   doc: { visibilityState, addEventListener, removeEventListener } (the page's document). Hidden tab: no reads, no
 *   timer; visible again: one read at once, then the interval again.
 */
export function watchBalance({
  read,
  onUpdate,
  doc = globalThis.document,
  setTimer = (f, ms) => globalThis.setTimeout(f, ms),
  clearTimer = (t) => globalThis.clearTimeout(t),
  intervalMs = WATCH_INTERVAL_MS,
}) {
  let last = null,
    timer = null,
    stopped = false,
    inFlight = null,
    generation = 0;
  const visible = () => !doc || doc.visibilityState !== "hidden";
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = () => {
    cancel();
    if (!stopped && visible()) timer = setTimer(tick, intervalMs);
  };
  async function tick() {
    timer = null;
    if (stopped || !visible() || inFlight === generation) return;
    const mine = generation;
    inFlight = mine;
    try {
      const units = await read();
      if (stopped || mine !== generation) return;
      const arrived = last !== null && units > last ? units - last : 0n;
      last = units;
      onUpdate({ status: "ready", units, arrived });
    } catch {
      if (!stopped && mine === generation) onUpdate({ status: "error" });
    } finally {
      if (inFlight === mine) inFlight = null;
      if (mine === generation) schedule();
    }
  }
  const onVisibility = () => {
    if (stopped) return;
    if (visible()) tick();
    else cancel();
  };
  doc?.addEventListener?.("visibilitychange", onVisibility);
  tick();
  return {
    /** Reads now (the Refresh button, after the card flow closes). */
    refresh() {
      if (stopped) return;
      cancel();
      generation++; // a read still on its way is dropped
      tick();
    },
    stop() {
      stopped = true;
      cancel();
      doc?.removeEventListener?.("visibilitychange", onVisibility);
    },
  };
}

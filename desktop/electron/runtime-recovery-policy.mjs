// When the runtime child dies, the desktop restarts it. A crash loop must not
// spin, but it must not close Monarch either: three runtime exits inside a
// minute (live chaos run: the server killed three times while it recovered)
// showed a fatal dialog and quit the whole application. Restarts now wait
// longer each time, and the count starts over once a runtime stays up.

export const RUNTIME_RECOVERY_DELAYS_MS = Object.freeze([250, 1_000, 3_000, 10_000, 30_000, 60_000]);
/** A runtime that stayed up this long ended a crash series. */
export const RUNTIME_STABLE_MS = 120_000;

export function createRuntimeRecoveryPolicy({ now = Date.now } = {}) {
  let failures = 0;
  let healthySince = null;
  return {
    /** The runtime answered ready. */
    healthy() { healthySince = now(); },
    /** Wait before the next restart attempt; counts this attempt. */
    nextDelay() {
      if (healthySince !== null && now() - healthySince >= RUNTIME_STABLE_MS) failures = 0;
      healthySince = null;
      const delay = RUNTIME_RECOVERY_DELAYS_MS[Math.min(failures, RUNTIME_RECOVERY_DELAYS_MS.length - 1)];
      failures += 1;
      return delay;
    },
    get attempts() { return failures; },
  };
}

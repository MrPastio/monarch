/**
 * Delivers reminders the person asked Oscar for. The runtime only stores them;
 * the Desktop host asks for the ones that came due, shows a Windows notification
 * and marks each one delivered. A reminder that came due while Monarch was
 * closed is shown right after the next start.
 */
export function createReminderDelivery({
  fetchImpl = fetch,
  getRuntimeUrl,
  attestationToken,
  notify,
  onDelivered = () => undefined,
  intervalMs = 15_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let timer = null;
  let running = false;
  let stopped = true;
  const inFlight = new Set();

  const request = async (pathname, init = {}) => {
    const runtimeUrl = getRuntimeUrl();
    if (!runtimeUrl) return null;
    const response = await fetchImpl(new URL(pathname, runtimeUrl), {
      ...init,
      headers: { 'X-Monarch-Desktop-Attestation': attestationToken, ...(init.headers || {}) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  };

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const payload = await request('/api/reminders/due');
      const reminders = Array.isArray(payload?.reminders) ? payload.reminders : [];
      for (const reminder of reminders) {
        const id = String(reminder?.id || '');
        if (!/^rem_[a-f0-9]{32}$/u.test(id) || inFlight.has(id)) continue;
        inFlight.add(id);
        try {
          // Mark first: a crash after showing must not repeat the same reminder forever.
          const marked = await request(`/api/reminders/${id}/delivered`, { method: 'POST' });
          if (!marked?.reminder) continue;
          notify(reminder);
          onDelivered(marked.reminder);
        } finally {
          inFlight.delete(id);
        }
      }
    } catch {
      // The runtime may be restarting; the next tick tries again.
    } finally {
      running = false;
      schedule();
    }
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, intervalMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    /** Check right away, e.g. after a reminder was created for «через минуту». */
    poke() {
      if (!stopped) void tick();
    },
    tick,
  };
}

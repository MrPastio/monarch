/** Candidate runtimes wait for the launcher commit without delaying window health. */
export function scheduleBackgroundReconciliation(
  reconcile: () => Promise<{ ok: boolean; state: string }>,
  report: (result: { ok: boolean; state: string }) => Promise<void>,
  { intervalMs = 10000, attempts = 30 } = {},
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    let result: { ok: boolean; state: string };
    try { result = await reconcile(); }
    catch { result = { ok: false, state: 'startup-reconciliation-unavailable' }; }
    if (stopped) return;
    attempts -= 1;
    if (attempts > 0 && (!result.ok || result.state === 'awaiting-current-version' || result.state === 'superseded')) {
      timer = setTimeout(() => { void tick(); }, intervalMs);
      timer.unref?.();
      return;
    }
    await report(result).catch(() => {});
  };
  timer = setTimeout(() => { void tick(); }, 0);
  timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

// Host policy must lock the utility even if renderer JavaScript is stalled.
export async function enforceSafeHostLock({ isCurrent, requestLock, notify, close }) {
  if (!isCurrent()) return false;
  try {
    const pending = requestLock();
    try { notify(); } catch { /* UI cleanup is advisory. */ }
    const status = await pending;
    if (status?.unlocked !== false) throw new Error('safe-host-lock-not-sealed');
    return true;
  } catch {
    close(); // Captured resources only; never close a replacement session.
    return false;
  }
}

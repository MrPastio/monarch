import { afterEach, expect, it, vi } from 'vitest';
import { scheduleBackgroundReconciliation } from '../../src/modules/security/background-reconcile';
afterEach(() => vi.useRealTimers());

it('waits for commit then reports successful reconciliation once', async () => {
  vi.useFakeTimers();
  const reconcile = vi.fn().mockResolvedValueOnce({ ok: true, state: 'awaiting-current-version' }).mockResolvedValue({ ok: true, state: 'rebound' });
  const report = vi.fn().mockResolvedValue(undefined);
  const stop = scheduleBackgroundReconciliation(reconcile, report);
  await vi.advanceTimersByTimeAsync(10001);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledWith({ ok: true, state: 'rebound' });
  await vi.advanceTimersByTimeAsync(30000);
  expect(reconcile).toHaveBeenCalledTimes(2);
  stop();
});

it('stops retrying unavailable startup after a bounded number of attempts', async () => {
  vi.useFakeTimers();
  const reconcile = vi.fn().mockRejectedValue(new Error('unavailable'));
  const report = vi.fn().mockResolvedValue(undefined);
  scheduleBackgroundReconciliation(reconcile, report, { attempts: 2 });
  await vi.advanceTimersByTimeAsync(30000);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledWith({ ok: false, state: 'startup-reconciliation-unavailable' });
});

it('does not schedule or report after module disposal during an in-flight operation', async () => {
  vi.useFakeTimers();
  let finish!: (result: { ok: boolean; state: string }) => void;
  const reconcile = vi.fn(() => new Promise<{ ok: boolean; state: string }>(resolve => { finish = resolve; }));
  const report = vi.fn();
  const stop = scheduleBackgroundReconciliation(reconcile, report);
  await vi.advanceTimersByTimeAsync(1);
  stop();
  finish({ ok: true, state: 'awaiting-current-version' });
  await vi.advanceTimersByTimeAsync(30000);
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

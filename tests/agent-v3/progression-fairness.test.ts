import { setImmediate as immediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraWorkScheduler, type AstraWorkAdapter, type AstraWorkLimits } from '../../src/agent-v3/work-scheduler';

// Synthetic logical clock and immediate completions isolate event-loop starvation
// without CPU spin, sleeps, model inference or user filesystem access.
function setup(limits: Partial<AstraWorkLimits> = {}) {
  let now = 10000, executions = 0;
  const journal = new AstraJournal(':memory:');
  const adapter: AstraWorkAdapter = { id: 'finite_cpu_work', version: 'v1',
    compile: (input, context) => ({ input, bindingDigest: 'synthetic-only',
      resources: { kernelSlots: 0, modelSlots: 0, declaredBytes: 1024, exclusiveKeys: [] },
      storage: { maxActivations: 1, streams: [{ streamId: 'proof_' + context.jobId, commits: 1, eventBytes: 1024, checkpointBytes: 1024 }] } }),
    execute: async () => {
      executions++; now += 400;
      return { state: 'observed', checkpointRef: 'synthetic_proof', checkpointRevision: 1, progressDigest: 'proof_' + executions };
    },
    control: () => ({ state: 'cancelled', checkpointRef: 'synthetic_proof', checkpointRevision: 1, progressDigest: 'cancelled' }),
    reconcile: () => ({ state: 'indeterminate', checkpointRef: 'synthetic_proof', checkpointRevision: 1, progressDigest: 'unknown' }) };
  const options = { deployment: 'isolated-validation' as const, scopeId: 'fairness', journal, adapters: [adapter],
    now: () => now, limits: { maxActive: 1, leaseMs: 1000, ...limits } };
  const scheduler = new AstraWorkScheduler(options); scheduler.acquire();
  const jobs = Array.from({ length: 8 }, (_, index) => scheduler.submit({ requestId: 'request_' + index,
    adapterId: adapter.id, input: {}, startWithinMs: 10000, finishWithinMs: 10000 }));
  return { journal, scheduler, options, jobs, executions: () => executions, advance: (ms: number) => { now += ms; },
    close: async () => { await scheduler.close(); journal.close(); } };
}

describe('Astra cooperative progression under immediate bounded work', () => {
  it('keeps the same live owner across a long microtask chain and services other event-loop work', async () => {
    const s = setup(); let callsAtEvent = -1;
    const event = immediate().then(() => { callsAtEvent = s.executions(); });
    try {
      await s.scheduler.drain(); await event;
      expect(s.scheduler.list().map(job => job.state)).toEqual(Array(8).fill('observed'));
      expect(s.executions()).toBe(8); expect(callsAtEvent).toBeLessThan(8);
      expect(s.scheduler.ownerIsCurrent()).toBe(true);
      expect((s.journal.read('scheduler_fairness')!.checkpoint as { generation: number }).generation).toBe(1);
    } finally { await event; await s.close(); }
  });
  it('applies a queued cancellation while other immediate work progresses, without dispatching the cancelled job', async () => {
    const s = setup();
    const cancel = immediate().then(() => s.scheduler.command(s.jobs[7]!.id, 'cancel'));
    try {
      await s.scheduler.drain(); await cancel;
      expect(s.executions()).toBe(7); expect(s.scheduler.job(s.jobs[7]!.id).state).toBe('cancelled');
      expect(s.scheduler.list().slice(0, 7).every(job => job.state === 'observed')).toBe(true);
    } finally { await cancel; await s.close(); }
  });
  it('fences a competitor takeover at the cooperative boundary before any new dispatch', async () => {
    const s = setup(), competitor = new AstraWorkScheduler(s.options);
    const takeover = immediate().then(() => { s.advance(1001); competitor.acquire(); });
    try {
      await expect(s.scheduler.drain()).rejects.toThrow('owner-fenced'); await takeover;
      expect(s.executions()).toBe(0); expect(competitor.ownerIsCurrent()).toBe(true);
      expect(competitor.list().every(job => job.state === 'queued')).toBe(true);
    } finally { await takeover; await competitor.close(); await s.close(); }
  });
  it('cannot turn an idle cooperative call into lease renewal or revive an expired owner', async () => {
    const s = setup();
    try {
      const before = s.journal.read('scheduler_fairness');
      await expect(s.scheduler.yieldOwnedLease()).rejects.toThrow('progression-lease-required');
      expect(s.journal.read('scheduler_fairness')).toEqual(before);
      s.advance(1001); await expect(s.scheduler.withOwnedLease(() => s.scheduler.yieldOwnedLease())).rejects.toThrow('owner-fenced');
      expect(s.journal.read('scheduler_fairness')).toEqual(before);
    } finally { await s.close(); }
  });
  it('fences a stale continuation even when the same instance explicitly acquires a new generation during its yield', async () => {
    const s = setup();
    const takeover = immediate().then(() => { s.advance(1001); s.scheduler.acquire(); });
    try {
      await expect(s.scheduler.withOwnedLease(() => s.scheduler.yieldOwnedLease())).rejects.toThrow('owner-fenced');
      await takeover; expect(s.scheduler.ownerIsCurrent()).toBe(true); expect(s.executions()).toBe(0);
      expect((s.journal.read('scheduler_fairness')!.checkpoint as { generation: number }).generation).toBe(2);
    } finally { await takeover; await s.close(); }
  });
  it('services shutdown at the yield without starting queued work', async () => {
    const s = setup();
    try {
      const draining = s.scheduler.drain(); await s.scheduler.close(); await draining;
      expect(s.executions()).toBe(0); expect(s.scheduler.list().every(job => job.state === 'queued')).toBe(true);
    } finally { await s.close(); }
  });
  it('unwinds active waiters after a takeover without releasing unknown resources or accepting late results', async () => {
    const s = setup({ maxActive: 2, activationTimeoutMs: 50 }), competitor = new AstraWorkScheduler(s.options);
    let release!: () => void, calls = 0, callsAtTakeover = 0;
    const work = new Promise<void>(resolve => { release = resolve; }), signals: AbortSignal[] = [];
    let takeover: Promise<void> | undefined;
    s.options.adapters[0]!.execute = async (_input, control) => {
      calls++; signals.push(control.signal);
      takeover ??= immediate().then(() => { s.advance(1001); competitor.acquire(); callsAtTakeover = calls; });
      await work;
      return { state: 'observed', checkpointRef: 'synthetic_proof', checkpointRevision: 1, progressDigest: 'late' };
    };
    try {
      await expect(s.scheduler.drain()).rejects.toThrow('owner-fenced'); await takeover;
      expect(callsAtTakeover).toBeGreaterThan(0); expect(calls).toBe(callsAtTakeover);
      expect(signals.every(signal => signal.aborted)).toBe(true);
      const unknown = competitor.list().filter(job => job.state === 'indeterminate');
      expect(unknown).toHaveLength(callsAtTakeover);
      expect(unknown.every(job => s.journal.reservation(job.reservationId) !== null)).toBe(true);
      const before = s.journal.read('scheduler_fairness'); release(); await immediate();
      expect(s.journal.read('scheduler_fairness')).toEqual(before); expect(calls).toBe(callsAtTakeover);
    } finally { release(); await takeover; await competitor.close(); await s.close(); }
  });
});

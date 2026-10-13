import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraWorkScheduler, type AstraWorkAdapter, type AstraWorkResult } from '../../src/agent-v3/work-scheduler';
import { AstraApplicationTaskHost, type AstraTaskHostFailure, type AstraTaskRecoveryCandidate } from '../../src/app/astra-task-host';

// Lifecycle tests use the actual journal/scheduler; the progress port and work
// results are synthetic. Actual HTTP/Python/Kernel integration is a separate suite.
afterEach(() => vi.useRealTimers());
function deferred() { let resolve!: () => void; const promise = new Promise<void>(value => { resolve = value; }); return { promise, resolve }; }
function setup() {
  let now = 10000;
  const journal = new AstraJournal(':memory:');
  const result: AstraWorkResult = { state: 'indeterminate', checkpointRef: 'synthetic_fact', checkpointRevision: 1, progressDigest: 'synthetic-only' };
  const adapter: AstraWorkAdapter = { id: 'synthetic_host_work', version: 'v1',
    compile: input => ({ input, bindingDigest: 'synthetic-binding', resources: { kernelSlots: 0, modelSlots: 1, declaredBytes: 1024, exclusiveKeys: [] },
      storage: { streams: [{ streamId: 'synthetic_fact', commits: 2, eventBytes: 4096, checkpointBytes: 1024 }], maxActivations: 2 } }),
    execute: async () => result, control: () => result, reconcile: () => result, reconcileRemote: async () => result };
  const options = { deployment: 'isolated-validation' as const, journal, scopeId: 'lifecycle_scope', adapters: [adapter], now: () => now,
    limits: { leaseMs: 1000, activationTimeoutMs: 5000 } };
  const scheduler = new AstraWorkScheduler(options);
  let pending: AstraTaskRecoveryCandidate[] = [];
  const port = { drain: vi.fn<() => Promise<void>>(async () => undefined), recoveryCandidates: vi.fn(() => pending), reconcile: vi.fn(async (_taskId: string) => undefined),
    retire: vi.fn(async (_candidate: AstraTaskRecoveryCandidate, _failure: AstraTaskHostFailure) => undefined) };
  const host = new AstraApplicationTaskHost(scheduler, port);
  return { journal, scheduler, host, adapter, result, options, port, advance: (milliseconds: number) => { now += milliseconds; },
    pending: (items: AstraTaskRecoveryCandidate[]) => { pending = items; }, close: async () => { await host.stop(); journal.close(); } };
}

/** One stuck job and one ordinary job, against the real scheduler.
 *
 * `indeterminate` counts as occupancy: the scheduler cannot know whether the
 * native worker is still holding the model, so the job keeps its declared model
 * slot. With a single model slot that means one job nobody can reconcile stops
 * every later job from ever starting. */
function contendedSetup(adapterId = 'synthetic_contended_work') {
  let now = 20000;
  const journal = new AstraJournal(':memory:');
  const stuck: AstraWorkResult = { state: 'indeterminate', checkpointRef: 'contended_fact', checkpointRevision: 1, progressDigest: 'stuck' };
  const done: AstraWorkResult = { state: 'observed', checkpointRef: 'contended_fact', checkpointRevision: 1, progressDigest: 'done' };
  const outcome = (input: unknown): AstraWorkResult =>
    (input as { stuck?: boolean }).stuck ? stuck : done;
  const adapter: AstraWorkAdapter = { id: adapterId, version: 'v1',
    compile: (input) => ({ input, bindingDigest: 'synthetic-binding',
      resources: { kernelSlots: 0, modelSlots: 1, declaredBytes: 1024, exclusiveKeys: [] },
      storage: { streams: [{ streamId: 'contended_fact', commits: 8, eventBytes: 16384, checkpointBytes: 4096 }], maxActivations: 2 } }),
    execute: async (input) => outcome(input),
    // Cancelling is how an owner settles work it can no longer wait for, and
    // it is exempt from the per-job control budget for exactly that reason.
    control: (input, command) => (command === 'cancel'
      ? { ...stuck, state: 'cancelled' } : outcome(input)),
    reconcile: (input) => outcome(input) };
  const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation' as const, journal,
    scopeId: 'contended_scope', adapters: [adapter], now: () => now,
    limits: { leaseMs: 1000, activationTimeoutMs: 5000 } });
  const port = {
    drain: vi.fn<() => Promise<void>>(async () => { await scheduler.drain(); }),
    recoveryCandidates: vi.fn(() => scheduler.list()
      .filter((job) => ['indeterminate', 'pausing', 'cancelling'].includes(job.state))
      .map((job) => ({ taskId: 'task_' + job.id, jobId: job.id }))),
    // Reconciling reports success and changes nothing, which is what the live
    // profile did: the job stayed `indeterminate` and kept its model slot.
    reconcile: vi.fn(async (_taskId: string) => undefined),
    retire: vi.fn(async (candidate: AstraTaskRecoveryCandidate) => {
      scheduler.abandon(candidate.jobId, 'agent-runtime-host-retired');
    }),
    nextWakeAt: vi.fn<() => number | undefined>(() => undefined),
    stalled: vi.fn<(issue: string, failure: AstraTaskHostFailure | undefined) => void>(),
  };
  const host = new AstraApplicationTaskHost(scheduler, port);
  return { journal, scheduler, host, port, adapter, advance: (milliseconds: number) => { now += milliseconds; },
    submit: (requestId: string, stuck: boolean) => scheduler.submit({ requestId,
      adapterId: adapter.id, input: { stuck } }),
    close: async () => { await host.stop(); journal.close(); } };
}

describe('Astra Application host under a job nobody can reconcile', () => {
  it('keeps one wake for the clock instead of going silent with work still queued', async () => {
    // A job left `indeterminate` keeps its declared model slot on purpose:
    // nobody can say whether the native worker stopped. Its way out is the
    // task's own deadline — and the host used to go silent once its recovery
    // attempts were spent, so that deadline never arrived, the slot was never
    // released, and with one model slot every later task stayed queued for the
    // rest of the process lifetime. That is the reported symptom.
    vi.useFakeTimers(); const s = contendedSetup();
    const due = Date.now() + 5 * 60_000;
    s.port.nextWakeAt.mockReturnValue(due);
    try {
      s.host.start();
      const stuck = s.submit('contended_stuck', true);
      await s.host.drain();
      expect(s.scheduler.job(stuck.id).state).toBe('indeterminate');

      await vi.advanceTimersByTimeAsync(5000);
      // The clock wake is not a scheduled retry: the attempts are spent, and
      // reporting it as one is what kept the stall silent.
      expect(s.host.status()).toMatchObject({ issue: 'recovery-required', recoveryScheduled: false, deadlineWake: true });
      expect(s.port.nextWakeAt).toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('still names the stall when the only thing left is the clock', async () => {
    // The clock wake armed a timer, and the stall report treated any armed
    // timer as "recovery is still coming" and stayed quiet. The person was
    // left watching a Turn that never finished while the log said nothing.
    vi.useFakeTimers(); const s = contendedSetup();
    s.port.nextWakeAt.mockReturnValue(Date.now() + 5 * 60_000);
    try {
      s.host.start();
      s.submit('contended_clock_only', true);
      await s.host.drain();
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.port.stalled).toHaveBeenCalledTimes(1);
      expect(s.port.stalled.mock.calls[0]![0]).toBe('recovery-required');
      expect(s.port.stalled.mock.calls[0]![1]?.code).toBe('recovery-budget-exhausted');
    } finally { await s.close(); }
  });

  it('names one stall once, however many later wakes find it unchanged', async () => {
    // Every pass used to forget that the stall was already reported, so each
    // clock wake and each new request logged it again: live, one unresolvable
    // job produced ~1,400 identical lines.
    vi.useFakeTimers(); const s = contendedSetup();
    s.port.nextWakeAt.mockReturnValue(Date.now() + 5 * 60_000);
    try {
      s.host.start();
      s.submit('contended_repeat', true);
      await s.host.drain();
      await vi.advanceTimersByTimeAsync(5000);
      for (let pass = 0; pass < 4; pass++) await s.host.drain();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(s.host.status()).toMatchObject({ issue: 'recovery-required' });
      expect(s.port.stalled).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('retires overdue work by the scheduler deadline when the profile names no due time', async () => {
    // Only the agent profile reported `dueAt`; a stuck read or draft job that
    // held the model slot stayed `indeterminate` days past its deadline.
    const s = contendedSetup();
    try {
      s.host.start();
      const stuck = s.submit('contended_no_due_at', true);
      await s.host.drain();
      await s.host.drain(); await s.host.drain();
      expect(s.port.retire).not.toHaveBeenCalled();
      expect(s.scheduler.job(stuck.id).state).toBe('indeterminate');

      s.advance(300_001);
      await s.host.drain();
      const later = s.submit('contended_behind_no_due_at', false);
      for (let pass = 0; pass < 6 && s.scheduler.job(later.id).state === 'queued'; pass++) await s.host.drain();
      expect(s.port.retire).toHaveBeenCalledTimes(1);
      expect(s.port.retire.mock.calls[0]![1]).toMatchObject({ code: 'task-deadline-unreconciled' });
      expect(s.scheduler.job(stuck.id).state).toBe('blocked');
      expect(s.scheduler.job(later.id).state).toBe('observed');
    } finally { await s.close(); }
  });

  it('retires an unreconcilable model call at once; effectful work keeps waiting for its deadline', async () => {
    // Live: the whole app was killed during a model call; the job stayed
    // indeterminate with a deadline nine hours away and the Coder task froze.
    const model = contendedSetup('goal-agent-model');
    try {
      model.host.start();
      const stuck = model.submit('contended_model_call', true);
      for (let pass = 0; pass < 6 && model.scheduler.job(stuck.id).state !== 'blocked'; pass++) await model.host.drain();
      expect(model.port.retire).toHaveBeenCalledTimes(1);
      expect(model.port.retire.mock.calls[0]![1]).toMatchObject({ code: 'model-outcome-unknown' });
      expect(model.scheduler.job(stuck.id).state).toBe('blocked');
    } finally { await model.close(); }
    const effect = contendedSetup('goal-agent-capability');
    try {
      effect.host.start();
      const stuck = effect.submit('contended_effect', true);
      for (let pass = 0; pass < 6; pass++) await effect.host.drain();
      expect(effect.port.retire).not.toHaveBeenCalled();
      expect(effect.scheduler.job(stuck.id).state).toBe('indeterminate');
    } finally { await effect.close(); }
  });

  it('does not arm a clock wake when nothing is waiting on time', async () => {
    vi.useFakeTimers(); const s = contendedSetup();
    s.port.nextWakeAt.mockReturnValue(undefined);
    try {
      s.host.start();
      s.submit('contended_no_deadline', true);
      await s.host.drain();
      await vi.advanceTimersByTimeAsync(5000);
      expect(s.host.status()).toMatchObject({ issue: 'recovery-required', recoveryScheduled: false });
    } finally { await s.close(); }
  });

  it('ends work that is both unreconcilable and past due, and runs what waited behind it', async () => {
    // The three recovery attempts are spent in seconds; the deadline was
    // supposed to be the way out after that, and nothing ever applied it to a
    // job that had already started. One `indeterminate` job therefore held the
    // single model slot for the rest of the process lifetime — measured live
    // as an agent Turn still `running` 46 minutes past a 30 minute deadline,
    // with no outcome and a Stop that did nothing.
    const s = contendedSetup();
    let dueAt = Date.now() + 60_000;
    s.port.recoveryCandidates.mockImplementation(() => s.scheduler.list()
      .filter(job => ['indeterminate', 'pausing', 'cancelling'].includes(job.state))
      .map(job => ({ taskId: 'task_' + job.id, jobId: job.id, dueAt })));
    try {
      s.host.start();
      const stuck = s.submit('contended_overdue', true);
      await s.host.drain();
      expect(s.scheduler.job(stuck.id).state).toBe('indeterminate');

      const later = s.submit('contended_behind_overdue', false);
      await s.host.drain();
      expect(s.scheduler.job(later.id).state).toBe('queued');

      // Attempts are spent but the work is not due yet: nothing is retired.
      await s.host.drain();
      expect(s.port.retire).not.toHaveBeenCalled();
      expect(s.scheduler.job(stuck.id).state).toBe('indeterminate');

      dueAt = Date.now() - 1;
      for (let pass = 0; pass < 6 && s.scheduler.job(later.id).state === 'queued'; pass++) await s.host.drain();

      expect(s.port.retire).toHaveBeenCalledTimes(1);
      expect(s.scheduler.job(stuck.id).state).toBe('blocked');
      expect(s.scheduler.job(later.id).state).toBe('observed');
    } finally { await s.close(); }
  });

  it('releases unreconcilable work at once when the person pressed Stop, without waiting for the deadline', async () => {
    // Live 2026-09-29: Stop on a stalled agent task sat in `cancelling` for the
    // 30 minutes left on its deadline, and the task looked as if it had resumed.
    const s = contendedSetup();
    let cancelRequested = false;
    s.port.recoveryCandidates.mockImplementation(() => s.scheduler.list()
      .filter(job => ['indeterminate', 'pausing', 'cancelling'].includes(job.state))
      .map(job => ({ taskId: 'task_' + job.id, jobId: job.id, dueAt: Date.now() + 30 * 60_000,
        ...(cancelRequested ? { cancelRequested: true } : {}) })));
    try {
      s.host.start();
      const stuck = s.submit('contended_stop', true);
      await s.host.drain();
      await s.host.drain();
      expect(s.port.retire).not.toHaveBeenCalled();
      expect(s.scheduler.job(stuck.id).state).toBe('indeterminate');

      cancelRequested = true;
      for (let pass = 0; pass < 4 && s.scheduler.job(stuck.id).state === 'indeterminate'; pass++) await s.host.drain();
      expect(s.port.retire).toHaveBeenCalledTimes(1);
      expect(s.port.retire.mock.calls[0]![1]).toMatchObject({ code: 'task-cancel-unreconciled' });
      expect(s.scheduler.job(stuck.id).state).toBe('blocked');
    } finally { await s.close(); }
  });

  it('drains again after retiring overdue work even when nothing else was a candidate', async () => {
    // Retiring settles the JOB; the task that owned it only notices through a
    // drain, which used to run again in this same pass only when the pass
    // already had ordinary reconcile candidates. A job retired on an
    // otherwise-quiet pass - its own attempts long spent, nothing else
    // pending - got no such drain, so its task stayed reported as stranded
    // for the rest of the process lifetime: nothing was left in any candidate
    // set to ever reconcile it again.
    const s = contendedSetup();
    let dueAt = Date.now() + 60_000;
    s.port.recoveryCandidates.mockImplementation(() => s.scheduler.list()
      .filter(job => ['indeterminate', 'pausing', 'cancelling'].includes(job.state))
      .map(job => ({ taskId: 'task_' + job.id, jobId: job.id, dueAt })));
    try {
      s.host.start();
      const stuck = s.submit('contended_quiet_overdue', true);
      await s.host.drain();
      expect(s.scheduler.job(stuck.id).state).toBe('indeterminate');

      // Spend the three attempts with nothing else ever a candidate.
      await s.host.drain(); await s.host.drain(); await s.host.drain();
      expect(s.port.retire).not.toHaveBeenCalled();

      dueAt = Date.now() - 1;
      const drainsBefore = s.port.drain.mock.calls.length;
      await s.host.drain();

      expect(s.port.retire).toHaveBeenCalledTimes(1);
      expect(s.scheduler.job(stuck.id).state).toBe('blocked');
      // The pass had no ordinary candidates (attempts already spent) - the
      // extra drain exists only because retirement happened.
      expect(s.port.drain.mock.calls.length).toBeGreaterThan(drainsBefore + 1);
    } finally { await s.close(); }
  });

  it('runs the work that was queued behind the job once its deadline releases the slot', async () => {
    const s = contendedSetup();
    try {
      s.host.start();
      const stuck = s.submit('contended_expiring', true);
      await s.host.drain();
      const later = s.submit('contended_waiting', false);
      await s.host.drain();
      // Nothing else can start while the slot is held, which is correct.
      expect(s.scheduler.job(later.id).state).toBe('queued');

      // The deadline is the owner's escape: cancelling is exempt from the
      // per-job control budget precisely so a stuck job can still be settled.
      s.scheduler.command(stuck.id, 'cancel');
      for (let pass = 0; pass < 6 && s.scheduler.job(later.id).state === 'queued'; pass++) {
        await s.host.drain();
      }

      expect(s.scheduler.job(later.id).state).toBe('observed');
    } finally { await s.close(); }
  });
});

describe('Astra Application host going idle with work still queued', () => {
  it('names the fault instead of reporting a clean idle while a job waits to start', async () => {
    // A queued job with nobody able to start it is a fault, not a rest: the
    // pump has nothing to do and nothing will wake it. With a single model slot
    // that is the whole agent lane stopped, and it used to produce no signal.
    const s = contendedSetup();
    // The live shape: the job holding the slot is invisible to recovery, so
    // the host has no other issue to report and would otherwise look healthy.
    s.port.recoveryCandidates.mockReturnValue([]);
    try {
      s.host.start();
      s.submit('idle_stuck', true);
      await s.host.drain();
      s.submit('idle_waiting', false);
      await s.host.drain();

      expect(s.scheduler.list().some(job => job.state === 'queued')).toBe(true);
      expect(s.host.status()).toMatchObject({ issue: 'work-queued-while-idle' });
      expect(s.host.status().lastFailure?.code).toBe('work-queued-while-idle');
    } finally { await s.close(); }
  });

  it('stays quiet when nothing is queued', async () => {
    const s = contendedSetup();
    try {
      s.host.start();
      s.submit('idle_clean', false);
      await s.host.drain();
      expect(s.host.status().issue).toBeUndefined();
    } finally { await s.close(); }
  });
});

describe('Astra Application host and a job no task claims', () => {
  it('retires a job with no owner on the first attempt instead of spending recovery on it', async () => {
    // Acquiring the scheduler turns jobs a previous process left `running`
    // into `indeterminate`, which keeps their declared resources on purpose.
    // Recovery candidates come from the profiles' task lists, so once a task
    // was archived its job held a model slot that nothing could ever release.
    vi.useFakeTimers(); const s = setup();
    s.pending([{ taskId: 'astra_orphan_job:job_orphan', jobId: 'job_orphan' }]);
    s.port.reconcile.mockImplementation(async () => { throw Error('astra-scheduler:orphan-job'); });
    try {
      s.host.start(); await vi.advanceTimersByTimeAsync(2000);
      expect(s.port.reconcile).toHaveBeenCalledTimes(1);
      expect(s.port.retire).toHaveBeenCalledTimes(1);
      expect(s.port.retire.mock.calls[0]![0]).toEqual({ taskId: 'astra_orphan_job:job_orphan', jobId: 'job_orphan' });
    } finally { await s.close(); }
  });
});

describe('Astra single-owner Application host lifecycle', () => {
  it('survives repeated launches and recovers an exhausted legacy owner allocation without erasing history', async () => {
    const s = setup();
    try {
      s.scheduler.acquire(); await s.scheduler.close();
      const streamId = 'scheduler_lifecycle_scope';
      const legacyId = 'scheduler_budget_' + createHash('sha256').update('lifecycle_scope').digest('hex').slice(0, 32);
      for (let i = 0; i < 64; i++) {
        const before = s.journal.read(streamId)!;
        s.journal.appendAtomic({ primary: { streamId, requestId: 'legacy_' + i, expectedRevision: before.revision,
          checkpoint: before.checkpoint, events: [{ type: 'legacy-owner-write' }], reservationId: legacyId },
          reserve: [{ id: legacyId, allocations: [{ streamId, commits: 64, eventBytes: 64 * 4096, checkpointBytes: 1024 * 1024 }] }] });
      }
      expect(s.journal.reservation(legacyId)!.remaining[0].commits).toBe(0);
      const retained = s.journal.read(streamId)!;
      for (let i = 0; i < 80; i++) {
        const scheduler = new AstraWorkScheduler(s.options);
        scheduler.acquire(); expect(scheduler.ownerIsCurrent()).toBe(true);
        await scheduler.close();
      }
      expect(s.journal.read(streamId)!.revision).toBe(retained.revision + 160);
      expect(s.journal.reservation(legacyId)).toBeNull();
      expect(s.journal.history(streamId, retained.revision - 1, 1)[0].receipt.commitHash).toBe(retained.commitHash);
    } finally { await s.close(); }
  });
  it('keeps the same lease while Application progression waits between jobs, then stops all idle heartbeats', async () => {
    vi.useFakeTimers(); const s = setup(), gate = deferred();
    s.port.drain.mockImplementationOnce(() => gate.promise);
    try {
      s.host.start(); const generation = (s.journal.read('scheduler_lifecycle_scope')!.checkpoint as { generation: number }).generation;
      for (let tick = 0; tick < 6; tick++) { s.advance(300); await vi.advanceTimersByTimeAsync(300); }
      expect(s.scheduler.ownerIsCurrent()).toBe(true);
      expect((s.journal.read('scheduler_lifecycle_scope')!.checkpoint as { generation: number }).generation).toBe(generation);
      gate.resolve(); await s.host.drain(); const stable = s.journal.read('scheduler_lifecycle_scope');
      s.advance(1200); await vi.advanceTimersByTimeAsync(1200);
      expect(s.journal.read('scheduler_lifecycle_scope')).toEqual(stable); expect(s.scheduler.ownerIsCurrent()).toBe(false);
    } finally { gate.resolve(); await s.close(); }
  });
  it('does not revive an actually expired owner during a stalled progression pass', async () => {
    const s = setup(), gate = deferred(); s.port.drain.mockImplementationOnce(async () => {
      await gate.promise; if (!s.scheduler.ownerIsCurrent()) throw Error('synthetic-owner-fenced');
    });
    try {
      s.host.start(); s.advance(1001); const before = s.journal.read('scheduler_lifecycle_scope');
      gate.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(s.scheduler.ownerIsCurrent()).toBe(false); expect(s.journal.read('scheduler_lifecycle_scope')).toEqual(before);
    } finally { gate.resolve(); await s.close(); }
  });
  it('rejects a second lifecycle controller around the same scheduler instance', async () => {
    const s = setup();
    try { expect(() => new AstraApplicationTaskHost(s.scheduler, s.port)).toThrow('astra-host-already-attached'); }
    finally { await s.close(); }
  });
  it('requires start, does no idle writes and renews ownership on demand after idle expiry', async () => {
    const s = setup();
    try {
      expect(() => s.host.requireOwner()).toThrow('astra-host-not-running');
      s.host.start(); await s.host.drain(); const before = s.journal.read('scheduler_lifecycle_scope');
      s.advance(1001); expect(s.scheduler.ownerIsCurrent()).toBe(false);
      expect(s.host.status()).toEqual({ phase: 'running', recoveryScheduled: false });
      expect(s.journal.read('scheduler_lifecycle_scope')).toEqual(before);
      s.host.requireOwner(); expect(s.scheduler.ownerIsCurrent()).toBe(true);
      expect(s.journal.read('scheduler_lifecycle_scope')!.revision).toBe(before!.revision + 1);
      s.host.start(); expect(s.journal.read('scheduler_lifecycle_scope')!.revision).toBe(before!.revision + 1);
    } finally { await s.close(); }
  });

  it('does not take over a live competing owner and does not start a replacement loop', async () => {
    const s = setup(), competitor = new AstraWorkScheduler(s.options);
    try {
      s.host.start(); await s.host.drain(); s.advance(1001); competitor.acquire();
      const retained = s.journal.read('scheduler_lifecycle_scope'), calls = s.port.drain.mock.calls.length;
      expect(() => s.host.requireOwner()).toThrow('astra-host-unavailable');
      expect(s.host.status().issue).toBe('host-unavailable');
      expect(s.journal.read('scheduler_lifecycle_scope')).toEqual(retained); expect(s.port.drain).toHaveBeenCalledTimes(calls);
    } finally { await competitor.close(); await s.close(); }
  });

  it('waits through one stale lease window on process restart and then restores with the scheduler CAS', async () => {
    vi.useFakeTimers();
    const s = setup();
    const successorScheduler = new AstraWorkScheduler(s.options);
    const successorPort = { drain: vi.fn(async () => undefined), recoveryCandidates: vi.fn(() => []),
      reconcile: vi.fn(async (_taskId: string) => undefined) };
    const successor = new AstraApplicationTaskHost(successorScheduler, successorPort);
    try {
      s.host.start();
      const original = s.journal.read('scheduler_lifecycle_scope')!;
      const restore = vi.fn(async () => undefined);
      const starting = successor.startWithSourceRestore(restore);
      await Promise.resolve();
      expect(successor.status()).toMatchObject({ phase: 'created', issue: 'host-unavailable' });

      s.advance(1001);
      await vi.advanceTimersByTimeAsync(1025);
      await starting;

      expect(restore).toHaveBeenCalledTimes(1);
      expect(successor.status()).toEqual({ phase: 'running', recoveryScheduled: false });
      expect(successorScheduler.ownerIsCurrent()).toBe(true);
      expect(s.scheduler.ownerIsCurrent()).toBe(false);
      expect(s.journal.read('scheduler_lifecycle_scope')!.revision).toBe(original.revision + 1);
    } finally {
      await successor.stop();
      await s.close();
    }
  });

  it('does not take over a live owner that renews during the single restart wait window', async () => {
    vi.useFakeTimers();
    const s = setup();
    const gate = deferred(), entered = deferred();
    s.port.drain.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const successorScheduler = new AstraWorkScheduler(s.options);
    const successor = new AstraApplicationTaskHost(successorScheduler, {
      drain: vi.fn(async () => undefined), recoveryCandidates: vi.fn(() => []), reconcile: vi.fn(async () => undefined),
    });
    try {
      s.host.start();
      await entered.promise;
      const originalOwner = (s.journal.read('scheduler_lifecycle_scope')!.checkpoint as { ownerId: string }).ownerId;
      const restore = vi.fn(async () => undefined);
      const starting = successor.startWithSourceRestore(restore);
      const outcome = starting.then(() => null, error => error);

      for (let step = 0; step < 4; step++) {
        s.advance(300);
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(await outcome).toMatchObject({ message: 'astra-host-unavailable' });

      expect(restore).not.toHaveBeenCalled();
      expect(successor.status()).toMatchObject({ phase: 'created', issue: 'host-unavailable' });
      expect((s.journal.read('scheduler_lifecycle_scope')!.checkpoint as { ownerId: string }).ownerId).toBe(originalOwner);
      expect(s.scheduler.ownerIsCurrent()).toBe(true);
      expect(successorScheduler.ownerIsCurrent()).toBe(false);
    } finally {
      gate.resolve();
      await successor.stop();
      await s.close();
    }
  });

  it('bounds unknown recovery to three attempts and stops its timer without erasing unknown work', async () => {
    vi.useFakeTimers(); const s = setup(); s.pending([{ taskId: 'first', jobId: 'job_first' }]);
    try {
      s.host.start(); await vi.advanceTimersByTimeAsync(2000);
      expect(s.port.reconcile).toHaveBeenCalledTimes(3);
      // A stalled host has to name its own cause: without it the task froze
      // with no outcome and nothing anywhere said why.
      expect(s.host.status()).toMatchObject({ phase: 'running', issue: 'recovery-required', recoveryScheduled: false });
      expect(s.host.status().lastFailure?.code).toBe('recovery-budget-exhausted');
      await vi.advanceTimersByTimeAsync(60000); expect(s.port.reconcile).toHaveBeenCalledTimes(3);
      await s.host.drain(); expect(s.port.reconcile).toHaveBeenCalledTimes(3); // Explicit wake cannot reset automatic budget.
      expect(s.port.recoveryCandidates()).toEqual([{ taskId: 'first', jobId: 'job_first' }]);
    } finally { await s.close(); }
  });

  it('retires a job it provably cannot reconcile without waiting out the attempts', async () => {
    vi.useFakeTimers(); const s = setup(); s.pending([{ taskId: 'first', jobId: 'job_first' }]);
    s.port.reconcile.mockImplementation(async () => { throw Error('astra-scheduler:control-budget'); });
    try {
      s.host.start(); await vi.advanceTimersByTimeAsync(2000);
      expect(s.port.reconcile).toHaveBeenCalledTimes(1);
      expect(s.port.retire).toHaveBeenCalledTimes(1);
      expect(s.port.retire.mock.calls[0]![1]).toMatchObject({ message: 'astra-scheduler:control-budget' });
      await vi.advanceTimersByTimeAsync(60000); await s.host.drain();
      // Retiring twice would be a second claim about the same work.
      expect(s.port.retire).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });


  it('continues recovered work after a physical acknowledgement and leaves no recovery timer', async () => {
    vi.useFakeTimers(); const s = setup(); s.pending([{ taskId: 'first', jobId: 'job_first' }]);
    s.port.reconcile.mockImplementation(async () => { if (s.port.reconcile.mock.calls.length === 2) s.pending([]); });
    try {
      s.host.start(); await vi.advanceTimersByTimeAsync(2000);
      expect(s.port.reconcile).toHaveBeenCalledTimes(2); expect(s.port.drain.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(s.host.status()).toEqual({ phase: 'running', recoveryScheduled: false });
    } finally { await s.close(); }
  });

  it('gives previously unattempted tasks their first recovery before repeating others', async () => {
    vi.useFakeTimers(); const s = setup();
    s.pending(Array.from({ length: 6 }, (_, index) => ({ taskId: 'task_' + index, jobId: 'job_' + index })));
    try {
      s.host.start(); await vi.advanceTimersByTimeAsync(260);
      expect(s.port.reconcile.mock.calls.slice(0, 6).map(call => call[0])).toEqual(['task_0', 'task_1', 'task_2', 'task_3', 'task_4', 'task_5']);
    } finally { await s.close(); }
  });

  it('exposes persistence failure, avoids automatic fault retry, and preserves an explicit retry path', async () => {
    vi.useFakeTimers(); const s = setup(); s.port.drain.mockRejectedValue(Error('synthetic-store-failure'));
    try {
      s.host.start(); await vi.advanceTimersByTimeAsync(10000);
      expect(s.host.status()).toMatchObject({ phase: 'running', issue: 'progression-failed', recoveryScheduled: false });
      expect(s.host.status().lastFailure?.message).toBe('synthetic-store-failure');
      expect(s.port.drain).toHaveBeenCalledTimes(1);
      s.port.drain.mockResolvedValue(undefined); await s.host.drain();
      expect(s.host.status()).toEqual({ phase: 'running', recoveryScheduled: false });
    } finally { await s.close(); }
  });

  it('re-acquires its own lease lost to a process stall instead of freezing the running turn', async () => {
    vi.useFakeTimers(); const s = setup();
    s.port.drain.mockImplementationOnce(async () => { s.advance(1001); throw Error('astra-scheduler:owner-fenced'); });
    try {
      s.host.start(); const generation = (s.journal.read('scheduler_lifecycle_scope')!.checkpoint as { generation: number }).generation;
      await vi.advanceTimersByTimeAsync(0);
      expect(s.host.status()).toMatchObject({ phase: 'running', recoveryScheduled: true });
      expect(s.host.status().issue).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      expect(s.port.drain).toHaveBeenCalledTimes(2);
      expect(s.scheduler.ownerIsCurrent()).toBe(true);
      expect((s.journal.read('scheduler_lifecycle_scope')!.checkpoint as { generation: number }).generation).toBe(generation + 1);
      expect(s.host.status()).toEqual({ phase: 'running', recoveryScheduled: false });
    } finally { await s.close(); }
  });
  it('bounds lease self-recovery and then names the stall', async () => {
    vi.useFakeTimers(); const s = setup(), stalled = vi.fn();
    (s.port as { stalled?: typeof stalled }).stalled = stalled;
    s.port.drain.mockImplementation(async () => { s.advance(1001); throw Error('astra-scheduler:owner-fenced'); });
    try {
      s.host.start(); await vi.advanceTimersByTimeAsync(20_000);
      expect(s.port.drain).toHaveBeenCalledTimes(4);
      expect(s.host.status()).toMatchObject({ phase: 'running', issue: 'progression-failed', recoveryScheduled: false });
      expect(stalled).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('does not lose a second wake arriving during an active progress pass', async () => {
    const s = setup(), gate = deferred(); s.port.drain.mockImplementationOnce(() => gate.promise);
    try {
      s.host.start(); s.host.signal(); s.host.signal(); gate.resolve(); await s.host.drain();
      expect(s.port.drain).toHaveBeenCalledTimes(2); // Coalesced wakes, not two owners or a lost request.
    } finally { await s.close(); }
  });

  it('stops once, rejects admissions immediately and waits for in-flight controller unwind', async () => {
    const s = setup(), gate = deferred(); s.port.drain.mockImplementationOnce(() => gate.promise);
    const close = vi.spyOn(s.scheduler, 'close');
    try {
      s.host.start(); const stopping = s.host.stop(); expect(s.host.stop()).toBe(stopping);
      expect(() => s.host.requireOwner()).toThrow('astra-host-not-running'); expect(s.host.status().phase).toBe('stopping');
      gate.resolve(); expect(await stopping).toEqual({ unresolvedWork: 0 }); expect(close).toHaveBeenCalledTimes(1);
      expect(() => s.host.start()).toThrow('astra-host-stopped');
    } finally { gate.resolve(); await s.close(); }
  });

  it('refuses reacquisition while an old-generation asynchronous reconciliation is still in flight', async () => {
    const s = setup(), gate = deferred(), entered = deferred();
    s.adapter.reconcileRemote = async () => { entered.resolve(); await gate.promise; return s.result; };
    try {
      s.scheduler.acquire();
      const job = s.scheduler.submit({ requestId: 'owned_unknown', adapterId: s.adapter.id, input: {} });
      await s.scheduler.drain(); const recovering = s.scheduler.reconcileRemote(job.id); await entered.promise;
      s.advance(1001); expect(() => s.scheduler.acquire()).toThrow('previous-activation-active');
      gate.resolve(); expect((await recovering).state).toBe('indeterminate');
    } finally { gate.resolve(); await s.close(); }
  });
});

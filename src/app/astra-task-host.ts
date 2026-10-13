import { traceMonarchStartup } from '../core/startup-timing';
import type { AstraWorkScheduler } from '../agent-v3/work-scheduler';

export interface AstraTaskRecoveryCandidate {
  taskId: string; jobId: string;
  /** When this work stops being worth waiting for, in epoch milliseconds.
   *
   * Recovery attempts are spent in seconds; the deadline is what the design
   * calls the way out of `indeterminate`. Nothing acted on it, so a job nobody
   * could reconcile kept its model slot for the rest of the process lifetime. */
  dueAt?: number;
  /** The person pressed Stop. An explicit stop outranks the clock: a job this host
   * can no longer reconcile is released at once instead of at its deadline. */
  cancelRequested?: boolean;
}
export type AstraTaskHostIssue = 'progression-failed' | 'recovery-required' | 'host-unavailable'
  | 'source-restore-required' | 'work-queued-while-idle';
type AstraTaskHostPhase = 'created' | 'running' | 'stopping' | 'stopped';
/** Why the host stopped making progress, in a form a person can act on.
 *
 * The pump's failure used to be swallowed whole: the host went idle, the task
 * froze with no outcome, and nothing anywhere said why. A stalled executor has
 * to name its own cause. */
export interface AstraTaskHostFailure { at: number; code: string; message: string }

export interface AstraTaskHostPort {
  drain(): Promise<unknown>;
  recoveryCandidates(): AstraTaskRecoveryCandidate[];
  reconcile(taskId: string): Promise<unknown>;
  /** Retire a job this host can no longer reconcile, so it stops being a
   * recovery candidate. Cancellation is exempt from the scheduler's per-job
   * control budget precisely so a job that exhausted it can still be settled. */
  retire?(candidate: AstraTaskRecoveryCandidate, failure: AstraTaskHostFailure): Promise<unknown>;
  /** The earliest moment at which unsettled work becomes due by the clock,
   * usually a task's own deadline. Epoch milliseconds, or undefined when
   * nothing is waiting on time.
   *
   * A job left `indeterminate` is a deliberate refusal to guess whether a
   * native worker finished, and it keeps its declared resources for exactly
   * that reason. The way out is the task's deadline, which someone has to be
   * awake to notice: a host that had spent its recovery attempts went silent
   * forever, so the deadline never arrived, the slot was never released, and
   * with one model slot every later task stayed queued for the rest of the
   * process lifetime. */
  nextWakeAt?(): number | undefined;
  /** Called once when the host stops making progress and will not wake itself.
   * Work admitted before that moment is stranded until something signals the
   * host again, so whoever is waiting on it has to be told. */
  stalled?(issue: AstraTaskHostIssue, failure: AstraTaskHostFailure | undefined): void;
}
/** Three exact attempts per job in one host lifetime; the scheduler enforces
 * its own durable budget on top. */
const MAX_RECOVERY_ATTEMPTS = 3;
/** Bounds on the single clock wake: never a busy loop, never further out than
 * a day, whatever the port reports. */
const MIN_DEADLINE_WAKE_MS = 1_000;
const MAX_DEADLINE_WAKE_MS = 24 * 60 * 60 * 1000;
/** A lease this process lost to its own stall (GC, paging, a long synchronous
 * write) is not a store fault: nobody else took over, and the scheduler's CAS
 * acquisition turns the stranded activation into `indeterminate` work that the
 * ordinary exact recovery then reconciles. Waiting for an outside wake instead
 * left a running turn frozen with no outcome for the process lifetime. The last
 * delay is longer than any product lease so an old activation can unwind. */
const LEASE_RECOVERY_DELAYS_MS = [250, 2_000, 6_000];

class AstraTaskHostError extends Error {
  readonly statusCode = 503;
  constructor(readonly code: string) { super(code); }
}

/** Lifecycle for ONE externally assembled scheduler, not a second work queue or
 * durable execution owner. Idle means no timer/heartbeat/write. Authenticated
 * mutations acquire an expired idle lease by the scheduler's existing CAS.
 * Each unresolved job gets at most three automatic exact recovery attempts in
 * this host lifetime; the scheduler additionally enforces its durable budget.
 * Neither elapsed time nor shutdown is evidence of native-worker termination.
 */
export class AstraApplicationTaskHost {
  private static readonly owners = new WeakSet<AstraWorkScheduler>();
  private phase: AstraTaskHostPhase = 'created';
  private flight: Promise<void> | undefined;
  private stopping: Promise<{ unresolvedWork: number }> | undefined;
  private requested = false;
  private sourceRestoreHeld = false;
  private restoring = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** A timer armed because the recovery attempts are spent and only the clock
   * can release the job. It is not a pending retry, so it must not read as one. */
  private deadlineWake = false;
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly retired = new Set<string>();
  private issue: AstraTaskHostIssue | undefined;
  private lastFailure: AstraTaskHostFailure | undefined;
  private reportedIssue: AstraTaskHostIssue | undefined;
  private readonly delays = [250, 1000];
  private leaseRecoveries = 0;
  private leaseRecoveryDue = false;

  constructor(private readonly scheduler: AstraWorkScheduler, private readonly port: AstraTaskHostPort) {
    if (AstraApplicationTaskHost.owners.has(scheduler)) throw new AstraTaskHostError('astra-host-already-attached');
    AstraApplicationTaskHost.owners.add(scheduler);
  }

  start(): void {
    if (this.phase === 'running') return;
    if (this.phase !== 'created') throw new AstraTaskHostError('astra-host-stopped');
    this.acquire(); this.phase = 'running'; this.signal();
  }
  /** Same owner, no work until another durable source has restored its controls.
   * A failed restore keeps the barrier closed; only explicit retry or stop can
   * leave that state. In particular, pending cancel cannot race startup replay. */
  async startWithSourceRestore(restore: () => Promise<void>): Promise<void> {
    if (this.restoring) throw new AstraTaskHostError('astra-source-restore-in-progress');
    if (this.phase !== 'created' && !(this.phase === 'running' && this.sourceRestoreHeld))
      throw new AstraTaskHostError('astra-host-already-started');
    this.sourceRestoreHeld = true; this.restoring = true;
    try { await this.startAfterStaleLease(); }
    catch (error) { this.sourceRestoreHeld = false; this.restoring = false; throw error; }
    traceMonarchStartup('astra-host-lease-ready');
    this.issue = 'source-restore-required';
    try { await restore(); }
    catch (error) { this.issue = 'progression-failed'; throw error; }
    finally { this.restoring = false; }
    if (this.phase !== 'running') throw new AstraTaskHostError('astra-host-stopped');
    this.sourceRestoreHeld = false; this.issue = undefined; this.reportedIssue = undefined; this.signal();
  }
  requireOwner(): void {
    if (this.phase !== 'running') throw new AstraTaskHostError('astra-host-not-running');
    this.acquire();
  }
  status(): { phase: AstraTaskHostPhase; issue?: AstraTaskHostIssue; recoveryScheduled: boolean;
    deadlineWake?: boolean; lastFailure?: AstraTaskHostFailure } {
    return { phase: this.phase, ...(this.issue ? { issue: this.issue } : {}),
      recoveryScheduled: this.retryScheduled(),
      ...(this.deadlineWake ? { deadlineWake: true } : {}),
      ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}) };
  }
  async drain(): Promise<void> { this.requireOwner(); this.signal(); await this.flight; }

  signal(): void {
    if (this.phase !== 'running') return;
    this.requested = true; this.clearTimer();
    if (this.sourceRestoreHeld) return;
    if (this.flight) return;
    this.flight = this.pump().then(() => { this.leaseRecoveries = 0; }, (error: unknown) => {
      if (this.phase !== 'running') return;
      const failure = describeHostFailure(error);
      this.lastFailure = failure;
      if (isOwnLeaseLoss(failure) && this.leaseRecoveries < LEASE_RECOVERY_DELAYS_MS.length) { this.leaseRecoveryDue = true; return; }
      this.issue ??= 'progression-failed';
    }).finally(() => {
      this.flight = undefined;
      if (this.leaseRecoveryDue) { this.leaseRecoveryDue = false; this.armLeaseRecovery(); return; }
      this.scheduleRecovery(); this.noteQueuedWhileIdle(); this.reportStall();
      if (!this.issue) this.reportedIssue = undefined;
    });
  }

  /** Stop admissions first, abort scheduler waiters, await their bounded unwind.
   * The caller closes Journal/Kernel/model resources AFTER this resolves. Pending
   * messages, paused/queued work and unknown native occupancy remain durable.
   * Idempotent concurrent stop shares one promise; no second resource release. */
  stop(): Promise<{ unresolvedWork: number }> {
    if (this.stopping) return this.stopping;
    this.phase = 'stopping'; this.requested = false; this.clearTimer();
    this.stopping = (async () => {
      try { await this.scheduler.close(); await this.flight;
        return { unresolvedWork: this.scheduler.list().filter(job => ['running', 'pausing', 'cancelling', 'indeterminate'].includes(job.state)).length };
      } finally { this.phase = 'stopped'; }
    })();
    return this.stopping;
  }

  private acquire(): void {
    try { if (!this.scheduler.ownerIsCurrent()) this.scheduler.acquire(); }
    catch { this.issue = 'host-unavailable'; throw new AstraTaskHostError('astra-host-unavailable'); }
  }
  private async startAfterStaleLease(): Promise<void> {
    try { this.start(); return; }
    catch (error) {
      if (!(error instanceof AstraTaskHostError) || error.code !== 'astra-host-unavailable') throw error;
    }
    const waitMs = this.scheduler.ownerLeaseRemainingMs();
    if (waitMs <= 0) throw new AstraTaskHostError('astra-host-unavailable');
    await new Promise(resolve => setTimeout(resolve, waitMs + 25));
    if (this.phase !== 'created') throw new AstraTaskHostError('astra-host-stopped');
    this.acquire(); this.phase = 'running'; this.signal();
  }
  private async pump(): Promise<void> {
    do {
      // Each pass reports its own state: a failure kept past a recovered pass
      // would read as a current fault in `status()`.
      this.requested = false; this.requireOwner();
      // `reportedIssue` survives the pass: it is cleared below only when a pass
      // ends healthy. Clearing it here re-announced the same stall on every
      // deadline wake (live: one unresolvable job, ~1,400 identical lines).
      this.issue = undefined; this.lastFailure = undefined;
      await this.scheduler.withOwnedLease(async () => {
        await this.port.drain();
        if (this.phase !== 'running') return;
        const candidates = this.candidates().filter(item => (this.recoveryAttempts.get(item.jobId) ?? 0) < MAX_RECOVERY_ATTEMPTS)
          .sort((a, b) => (this.recoveryAttempts.get(a.jobId) ?? 0) - (this.recoveryAttempts.get(b.jobId) ?? 0));
        for (const item of candidates.slice(0, 4)) {
          if (this.phase !== 'running') return;
          if (!this.recoveryAttempts.has(item.jobId) && this.recoveryAttempts.size >= 128) throw Error('astra-host-recovery-budget');
          const attempts = (this.recoveryAttempts.get(item.jobId) ?? 0) + 1;
          this.recoveryAttempts.set(item.jobId, attempts);
          // One job that cannot be reconciled must not stop the executor for
          // every other task. Letting the failure escape here set the host's
          // issue, and `scheduleRecovery` then refused to arm again: a single
          // stale job froze every in-flight Turn with no outcome and no way to
          // cancel, for the whole application lifetime.
          try { await this.port.reconcile(item.taskId); }
          catch (error) {
            const failure = describeHostFailure(error);
            this.lastFailure = failure;
            // The stall report only says the budget ran out; this says why each attempt failed.
            console.error(JSON.stringify({ diagnostic: 'astra-task-host-reconcile-failed', taskId: item.taskId, attempt: attempts, code: failure.code, message: failure.message.slice(0, 200) }));
            if (attempts >= MAX_RECOVERY_ATTEMPTS || isUnreconcilable(failure)) await this.retire(item, failure);
          }
        }
        const retiredOverdue = this.phase === 'running' && await this.retireOverdue();
        // A job `retire` settles is a scheduler-level fact only; the task that
        // owned it still projects off its own record, which nothing has told
        // to notice yet. Without a drain right here, that only happens when
        // this exact pass also had ordinary candidates to reconcile - so a
        // task retired on an otherwise-quiet pass (attempts long since spent,
        // nothing else pending) stayed reported as stranded forever: nothing
        // was left in any candidate set to ever reconcile it again.
        if ((candidates.length || retiredOverdue) && this.phase === 'running') await this.port.drain();
      });
    } while (this.requested && this.phase === 'running');
  }
  /** End work that is both unreconcilable and past due.
   *
   * The three exact attempts are spent within seconds, and until now nothing
   * else ever ended the job: the deadline the design calls its way out was
   * only ever applied to work that had not started. One agent job left
   * `indeterminate` therefore held the single model slot for the rest of the
   * process lifetime, which is the agent lane freezing with no outcome and a
   * Stop that does nothing — measured live at 46 minutes past a 30 minute
   * deadline.
   *
   * Retiring settles the job `blocked`, which claims only that this host gave
   * up driving it. Elapsed time is still not evidence that the native worker
   * stopped, and nothing here says it did. */
  private async retireOverdue(): Promise<boolean> {
    const now = Date.now();
    // Only the agent profile names `dueAt`; every other job still carries the
    // scheduler's own deadline. Without it a stuck read or draft job that held
    // the model slot was never retired (live: `indeterminate` days past due).
    const schedulerNow = this.scheduler.clockNow();
    const jobs = new Map(this.scheduler.list().map(job => [job.id, job] as const));
    const due = (item: AstraTaskRecoveryCandidate) => item.dueAt !== undefined ? item.dueAt <= now
      : (jobs.get(item.jobId)?.deadline ?? Infinity) <= schedulerNow;
    // A model call changes nothing outside Monarch. When even three recovery
    // attempts cannot tell how it ended (live: the whole app was killed during
    // one), waiting for its deadline - nine hours away in that run - only
    // freezes the task; retired, the agent repairs the step with a new call.
    // Effectful work keeps waiting for its deadline or the person's Stop.
    const sideEffectFree = (item: AstraTaskRecoveryCandidate) => /-model$/u.test(jobs.get(item.jobId)?.adapterId ?? '');
    const overdue = this.candidates().filter(item => (item.cancelRequested || due(item) || sideEffectFree(item))
      && (this.recoveryAttempts.get(item.jobId) ?? 0) >= MAX_RECOVERY_ATTEMPTS && !this.retired.has(item.jobId));
    let retiredAny = false;
    for (const item of overdue) {
      if (this.phase !== 'running') break;
      await this.retire(item, item.cancelRequested
        ? { at: now, code: 'task-cancel-unreconciled', message: 'Stop was requested and the work could not be reconciled in this host lifetime.' }
        : due(item) ? { at: now, code: 'task-deadline-unreconciled',
          message: 'Work passed its deadline and could not be reconciled in this host lifetime.' }
          : { at: now, code: 'model-outcome-unknown', message: 'A model call could not be reconciled; it has no outside effect.' });
      retiredAny = true;
    }
    return retiredAny;
  }
  private candidates(): AstraTaskRecoveryCandidate[] {
    const items = this.port.recoveryCandidates();
    if (items.length > 128 || new Set(items.map(item => item.jobId)).size !== items.length) throw Error('astra-host-recovery-set');
    return items;
  }
  private scheduleRecovery(): void {
    if (this.phase !== 'running' || this.issue) return; // Store/ownership faults require an explicit new wake.
    try {
      const pending = this.candidates(); if (!pending.length) return;
      const retry = pending.filter(item => (this.recoveryAttempts.get(item.jobId) ?? 0) < MAX_RECOVERY_ATTEMPTS);
      if (!retry.length) {
        this.issue = 'recovery-required';
        this.lastFailure ??= { at: Date.now(), code: 'recovery-budget-exhausted',
          message: `${pending.length} job(s) failed three exact recovery attempts in this host lifetime.` };
        // Still one wake for work that becomes due by the clock. This is a
        // single timer at a known instant, not a heartbeat: without it the
        // deadline that releases an unresolvable job's resources never
        // arrives, and everything behind it waits for a restart.
        this.armDeadlineWake();
        return;
      }
      const attempts = Math.min(...retry.map(item => this.recoveryAttempts.get(item.jobId) ?? 0));
      this.deadlineWake = false;
      this.timer = setTimeout(() => { this.timer = undefined; this.signal(); }, this.delays[Math.max(0, attempts - 1)] ?? 1000);
      this.timer.unref();
    } catch (error) { this.issue = 'progression-failed'; this.lastFailure = describeHostFailure(error); }
  }
  private armLeaseRecovery(): void {
    if (this.phase !== 'running') return;
    const delay = LEASE_RECOVERY_DELAYS_MS[this.leaseRecoveries++]!;
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = undefined; this.signal(); }, delay);
    this.timer.unref();
  }
  /** One timer at the next moment the port says something becomes due. Bounded
   * so a wrong or distant answer cannot turn into a busy loop or a timer that
   * outlives the reason for it. */
  private armDeadlineWake(): void {
    let due: number | undefined;
    try { due = this.port.nextWakeAt?.(); }
    catch { return; }
    if (due === undefined || !Number.isFinite(due)) return;
    const delay = Math.min(MAX_DEADLINE_WAKE_MS, Math.max(MIN_DEADLINE_WAKE_MS, due - Date.now()));
    this.deadlineWake = true;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // The attempts are spent; this wake is for the clock, not for another
      // recovery round, so the issue is cleared only by a pass that succeeds.
      this.signal();
    }, delay);
    this.timer.unref();
  }
  /** Going idle while work is queued is a fault, not a rest.
   *
   * The pump had nothing to do and nothing will wake it, yet a job is waiting
   * to start. That only happens when something else is still holding the
   * resources it declared — with a single model slot, one such job keeps every
   * later task queued indefinitely. It produced no signal at all before this:
   * the host reported a clean idle while the agent lane was dead. */
  private noteQueuedWhileIdle(): void {
    if (this.phase !== 'running' || this.issue || this.timer || this.requested) return;
    try {
      const jobs = this.scheduler.list();
      if (!jobs.some(job => job.state === 'queued')) return;
      this.issue = 'work-queued-while-idle';
      this.lastFailure = { at: Date.now(), code: 'work-queued-while-idle',
        message: `${jobs.filter(job => job.state === 'queued').length} job(s) queued with no owner able to start them.` };
    } catch { /* Reporting must never be what stops the host from settling. */ }
  }
  /** Exactly once per stall: a repeated notice would be the heartbeat this host
   * deliberately does not have. Clearing the issue re-arms it. */
  private reportStall(): void {
    if (this.phase !== 'running' || !this.issue || this.retryScheduled() || this.reportedIssue === this.issue) return;
    this.reportedIssue = this.issue;
    try { this.port.stalled?.(this.issue, this.lastFailure ? { ...this.lastFailure } : undefined); }
    catch { /* A listener must never keep the host from settling into idle. */ }
  }
  /** A retired job is out of the candidate set for this host lifetime, whether
   * or not the port could settle it, so one unreconcilable job cannot come back
   * and stall the executor on the next wake. */
  private async retire(candidate: AstraTaskRecoveryCandidate, failure: AstraTaskHostFailure): Promise<void> {
    this.recoveryAttempts.set(candidate.jobId, MAX_RECOVERY_ATTEMPTS);
    if (this.retired.has(candidate.jobId)) return; // Retiring twice is a second claim about the same work.
    this.retired.add(candidate.jobId);
    try { await this.port.retire?.(candidate, failure); }
    catch (error) { this.lastFailure = describeHostFailure(error); }
  }
  private retryScheduled(): boolean { return this.timer !== undefined && !this.deadlineWake; }
  private clearTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } this.deadlineWake = false; }
}

/** Names the cause without leaking a payload: code and a bounded message only. */
function describeHostFailure(error: unknown): AstraTaskHostFailure {
  const record = error as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const code = typeof record?.code === 'string' && record.code
    ? record.code
    : typeof record?.name === 'string' && record.name ? record.name : 'unknown';
  const message = typeof record?.message === 'string' ? record.message : String(error);
  return { at: Date.now(), code, message: message.slice(0, 400) };
}

/** Only this scheduler's own fenced lease; a live competing owner surfaces as
 * `astra-host-unavailable` from acquisition and is never retried here. */
function isOwnLeaseLoss(failure: AstraTaskHostFailure): boolean {
  return /astra-scheduler:(owner|scheduler)-fenced/u.test(failure.message);
}
/** True when reconciling again provably cannot succeed.
 *
 * The scheduler's per-job control budget only ever counts up, so once a job has
 * spent it every further reconcile throws the same error. Retrying such a job
 * is not patience, it is a loop. */
function isUnreconcilable(failure: AstraTaskHostFailure): boolean {
  return UNRECONCILABLE_MARKERS.some(marker => failure.message.includes(marker));
}
const UNRECONCILABLE_MARKERS = [
  // The per-job control budget only counts up, so every further reconcile
  // throws the same error.
  'astra-scheduler:control-budget',
  // Nothing owns the job any more, so there is nothing left to reconcile it
  // against. It is only still here because it is holding resources.
  'astra-scheduler:orphan-job',
];

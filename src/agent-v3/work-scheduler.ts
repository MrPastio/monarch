import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { AstraJournal, AstraJournalError, astraJournalJson, type AstraJson, type AstraJournalAccess,
  type AstraJournalAllocation, type AstraJournalAtomicCommit, type AstraJournalCommit, type AstraJournalReservation,
  type AstraJournalStreamRetirement } from './journal';

// Resource/ownership primitive, NOT native Execution admission or capability authority.
// Adapters own Goal semantics and evidence. The scheduler never interprets model text
// or upgrades an observation into a certificate. No adapter is enabled by default.
export type AstraWorkState = 'queued' | 'running' | 'pausing' | 'paused' | 'cancelling'
  | 'observed' | 'partial' | 'failed' | 'cancelled' | 'indeterminate' | 'blocked' | 'awaiting-approval';
export interface AstraWorkResources { kernelSlots: number; modelSlots: number; declaredBytes: number; exclusiveKeys: string[] }
export interface AstraWorkStoragePlan { streams: AstraJournalAllocation[]; maxActivations: number }
export interface AstraWorkResult {
  state: Exclude<AstraWorkState, 'running'>; progressDigest: string; checkpointRef: string; checkpointRevision: number; reason?: string;
}
export interface AstraWorkControl {
  signal: AbortSignal; isCurrent: () => boolean; ownerIsCurrent: () => boolean;
  schedulerGeneration: number; activationGeneration: number; controlEpoch: number;
  journal: AstraJournalAccess;
}
export interface AstraWorkAdapter {
  id: string; version: string;
  compile(input: AstraJson, context: { jobId: string; scopeId: string; controlBudget: number }): {
    input: AstraJson; resources: AstraWorkResources; bindingDigest: string; storage: AstraWorkStoragePlan;
    /** Trusted adapter's bounded operation budget, sealed at admission; never extends the job deadline. */
    activationBudgetMs?: number };
  execute(input: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult>;
  control(input: AstraJson, command: 'pause' | 'resume' | 'cancel', ownerIsCurrent: () => boolean, journal: AstraJournalAccess): AstraWorkResult;
  reconcile(input: AstraJson, ownerIsCurrent: () => boolean, journal: AstraJournalAccess, context?: { controlEpoch: number }): AstraWorkResult;
  /** Optional bounded RPC recovery; unknown physical resources stay reserved. */
  reconcileRemote?(input: AstraJson, control: AstraWorkControl): Promise<AstraWorkResult>;
}
export interface AstraWorkJob {
  id: string; requestDigest: string; adapterId: string; adapterVersion: string; input: AstraJson;
  bindingDigest: string; resources: AstraWorkResources; state: AstraWorkState; order: number;
  activationGeneration: number; controlEpoch: number; controlCount: number; createdAt: number; startBy: number; deadline: number;
  storage: AstraWorkStoragePlan; reservationId: string;
  activationBudgetMs?: number;
  result?: AstraWorkResult; reason?: string;
}
interface SchedulerCheckpoint {
  schemaVersion: 'monarch.astra-v3-work-scheduler.internal.v1'; scopeId: string; configDigest: string;
  ownerId: string; generation: number; expiresAt: number; order: number; jobs: AstraWorkJob[];
  /** Rotation count of this generation's own bookkeeping allocation; absent = 0. */
  ownerBudgetEpoch?: number;
}
/** Owner bookkeeping allocation. Lease renewal is owner work: it is charged
 * here and rotated before it runs dry, never to a job's allocation, so no hold
 * of any length (a model waiting out a provider rate limit, progression between
 * jobs) can exhaust a budget and silently fence the live owner. */
const OWNER_BUDGET_COMMITS = 64;
const OWNER_BUDGET_ROTATE_AT = 4;
/** The scheduler stream is owner-local lease/control state and is never
 * replayed; keeping a bounded tail keeps it writable for the store's lifetime
 * instead of dying at the per-stream commit limit after a few hours of work. */
const SCHEDULER_HISTORY_KEEP = 256;
const SCHEDULER_COMPACT_EVERY = 512;
interface SchedulerView { revision: number; checkpoint: SchedulerCheckpoint }
export interface AstraWorkLimits { maxActive: number; maxJobs: number; maxControlsPerJob: number; kernelSlots: number; modelSlots: number; declaredBytes: number; leaseMs: number; activationTimeoutMs: number }
const defaults: AstraWorkLimits = { maxActive: 2, maxJobs: 64, maxControlsPerJob: 16, kernelSlots: 2, modelSlots: 1, declaredBytes: 16 * 1024 * 1024, leaseMs: 5000, activationTimeoutMs: 10000 };
const MAX_FINISH_WITHIN_MS = 24 * 60 * 60 * 1000;
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
export const astraWorkJobId = (requestId: string): string => 'job_' + sha(requestId).slice(7, 39);
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const terminal = new Set<AstraWorkState>(['observed', 'partial', 'failed', 'cancelled', 'blocked']);
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error('astra-scheduler:' + code); }
function id(value: string): void { check(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value), 'identity'); }

export class AstraWorkScheduler {
  private readonly adapters: Map<string, AstraWorkAdapter>;
  private readonly limits: AstraWorkLimits;
  private readonly ownerId = randomUUID();
  private readonly configDigest: string;
  private readonly compatibleConfigDigests: Set<string>;
  private generation = 0;
  private lastNow = 0;
  private closed = false;
  private closing = false;
  private draining: Promise<AstraWorkJob[]> | undefined;
  private readonly active = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private readonly recovering = new Map<string, { promise: Promise<AstraWorkJob>; controller: AbortController }>();
  private heartbeatUsers = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: { deployment: 'isolated-validation'; journal: AstraJournal; scopeId: string;
    adapters: AstraWorkAdapter[]; limits?: Partial<AstraWorkLimits>; now?: () => number;
    /** Explicit additive startup migration. Each prior set is hashed with the
     * current limits and may only omit adapters; retained IDs keep versions. */
    upgradeFromAdapterSets?: ReadonlyArray<ReadonlyArray<Pick<AstraWorkAdapter, 'id' | 'version'>>> }) {
    check(options.deployment === 'isolated-validation', 'deployment'); id(options.scopeId);
    this.limits = { ...defaults, ...options.limits };
    const l = this.limits;
    check(Object.values(l).every(value => Number.isSafeInteger(value) && value >= 0) && l.maxActive >= 1 && l.maxActive <= 8
      && l.maxJobs >= l.maxActive && l.maxJobs <= 128 && l.kernelSlots <= 8 && l.modelSlots <= 4
      && l.maxControlsPerJob <= 32
      && l.declaredBytes >= 1024 && l.declaredBytes <= 1024 * 1024 * 1024 && l.leaseMs >= 250 && l.leaseMs <= 30000
      && l.activationTimeoutMs >= 50 && l.activationTimeoutMs <= 30000, 'limits');
    check(options.adapters.length > 0 && options.adapters.length <= 16, 'adapters');
    this.adapters = new Map(options.adapters.map(adapter => { id(adapter.id); id(adapter.version); return [adapter.id, adapter]; }));
    check(this.adapters.size === options.adapters.length, 'duplicate-adapter');
    this.configDigest = sha(astraJournalJson(json({ limits: l, adapters: options.adapters.map(({ id, version }) => ({ id, version })) })));
    check((options.upgradeFromAdapterSets?.length ?? 0) <= 4, 'adapter-upgrade-budget');
    this.compatibleConfigDigests = new Set((options.upgradeFromAdapterSets ?? []).map(set => {
      check(set.length > 0 && set.length <= options.adapters.length, 'adapter-upgrade-set');
      const seen = new Set<string>();
      const bindings = set.map(binding => {
        id(binding.id); id(binding.version); check(!seen.has(binding.id), 'adapter-upgrade-duplicate'); seen.add(binding.id);
        check(this.adapters.get(binding.id)?.version === binding.version, 'adapter-upgrade-not-additive');
        return { id: binding.id, version: binding.version };
      });
      return sha(astraJournalJson(json({ limits: l, adapters: bindings })));
    }).filter(value => value !== this.configDigest));
  }

  acquire(): void {
    check(!this.closed && !this.closing, 'closed');
    const current = this.snapshot(true), now = this.now();
    if (current && current.checkpoint.ownerId === this.ownerId && current.checkpoint.expiresAt > now) {
      this.generation = current.checkpoint.generation; return;
    }
    check(!current || current.checkpoint.expiresAt <= now, 'owner-live');
    check(this.active.size === 0 && this.recovering.size === 0, 'previous-activation-active');
    const generation = (current?.checkpoint.generation ?? 0) + 1;
    // A lease generation owns its own bounded bookkeeping allocation. Reusing
    // the legacy scope allocation exhausted startup after 64 lifetime writes.
    // Retire only scheduler allocations, atomically with the fenced acquisition;
    // unresolved work reservations and the journal's total limits stay intact.
    const reservationId = this.ownerBudgetId(generation, 0);
    const previousBudgets = [this.ownerBudgetId(current?.checkpoint.generation ?? 0, current?.checkpoint.ownerBudgetEpoch ?? 0),
      'scheduler_budget_' + sha(this.options.scopeId).slice(7, 39)];
    const release = [...new Set(previousBudgets)].filter(id => {
      const reservation = this.options.journal.reservation(id);
      return reservation && !reservation.released;
    });
    const jobs = (current?.checkpoint.jobs ?? []).map(job => ['running', 'pausing', 'cancelling'].includes(job.state)
      ? { ...job, state: 'indeterminate' as const, reason: 'owner-expired' } : job);
    this.write(current?.revision ?? 0, { schemaVersion: 'monarch.astra-v3-work-scheduler.internal.v1', scopeId: this.options.scopeId,
      configDigest: this.configDigest, ownerId: this.ownerId, generation, expiresAt: now + this.limits.leaseMs,
      order: current?.checkpoint.order ?? 0, jobs }, 'scheduler.owner-acquired', { reservationId, release, reserve: [this.ownerBudgetPlan(reservationId)] });
    this.generation = generation;
  }

  submit(request: { requestId: string; adapterId: string; input: AstraJson; startWithinMs?: number; finishWithinMs?: number },
    admission?: { commits: AstraJournalCommit[]; reservations: AstraJournalReservation[]; retireTerminalJobIds?: string[] }): AstraWorkJob {
    check(!this.closing, 'closing');
    id(request.requestId); const current = this.owned(), now = this.now();
    const startWithinMs = request.startWithinMs ?? 60000, finishWithinMs = request.finishWithinMs ?? 300000;
    check(Number.isSafeInteger(startWithinMs) && startWithinMs > 0 && Number.isSafeInteger(finishWithinMs)
      && finishWithinMs >= startWithinMs && finishWithinMs <= MAX_FINISH_WITHIN_MS, 'deadline-budget');
    const encoded = astraJournalJson(request.input); check(Buffer.byteLength(encoded) <= 65536, 'input-budget');
    const requestDigest = sha(astraJournalJson({ adapterId: request.adapterId, input: JSON.parse(encoded) as AstraJson, startWithinMs, finishWithinMs,
      ...(admission ? { admission: json(admission) } : {}) }));
    const jobId = astraWorkJobId(request.requestId);
    const existing = current.checkpoint.jobs.find(job => job.id === jobId);
    if (existing) { check(existing.requestDigest === requestDigest, 'request-conflict'); return existing; }
    const retireIds = admission?.retireTerminalJobIds ?? [];
    check(retireIds.length <= 4 && new Set(retireIds).size === retireIds.length && !retireIds.includes(jobId), 'retirement-set');
    const retiredJobs = retireIds.map(retireId => {
      id(retireId); const retired = this.find(current, retireId);
      check(terminal.has(retired.state) && !this.active.has(retireId) && !this.recovering.has(retireId)
        && this.options.journal.reservation(retired.reservationId) === null, 'retirement-not-terminal');
      return retired;
    });
    const retainedJobs = current.checkpoint.jobs.filter(job => !retireIds.includes(job.id));
    const adapter = this.adapter(request.adapterId), compiled = adapter.compile(JSON.parse(encoded) as AstraJson, this.compileContext(jobId));
    this.resources(compiled.resources); this.storage(compiled.storage); this.activationBudget(compiled.activationBudgetMs);
    const protectedStreams = [...retainedJobs.flatMap(job => job.storage.streams.map(stream => stream.streamId)),
      ...compiled.storage.streams.map(stream => stream.streamId), ...(admission?.commits ?? []).map(commit => commit.streamId)];
    const retire = this.retirementFrontiers(retiredJobs, protectedStreams);
    check(retainedJobs.length < this.limits.maxJobs, 'job-budget');
    const resources = structuredClone(compiled.resources);
    check(resources.kernelSlots <= this.limits.kernelSlots && resources.modelSlots <= this.limits.modelSlots
      && resources.declaredBytes <= this.limits.declaredBytes, 'resource-request-impossible');
    const order = current.checkpoint.order + 1;
    const reservationId = 'work_budget_' + sha(this.options.scopeId + '/' + jobId).slice(7, 39);
    // A job can be admitted for a long parent-task deadline, but the scheduler
    // owns resources only while it is queued for start or inside one bounded
    // adapter activation/recovery window. Reserving a heartbeat for every idle
    // millisecond of the parent lifetime made legitimate long agent tasks
    // consume tens of megabytes before their first model call.
    const activationWindowMs = Math.min(finishWithinMs, startWithinMs
      + (compiled.activationBudgetMs ?? this.limits.activationTimeoutMs) + 2 * this.limits.leaseMs + 10_000);
    const heartbeatBudget = Math.ceil(activationWindowMs / this.heartbeatMs()) + 4;
    const schedulerCommits = 8 + 2 * compiled.storage.maxActivations + 2 * this.limits.maxControlsPerJob + heartbeatBudget;
    const plan: AstraJournalReservation = { id: reservationId, allocations: [
      ...compiled.storage.streams,
      { streamId: this.streamId(), commits: schedulerCommits, eventBytes: schedulerCommits * 4096, checkpointBytes: 1024 * 1024 },
    ] };
    const job: AstraWorkJob = { id: jobId, requestDigest, adapterId: adapter.id, adapterVersion: adapter.version,
      input: compiled.input, bindingDigest: compiled.bindingDigest, resources, state: 'queued', order,
      activationGeneration: 0, controlEpoch: 0, controlCount: 0, createdAt: now, startBy: now + startWithinMs, deadline: now + finishWithinMs,
      storage: structuredClone(compiled.storage), reservationId,
      ...(compiled.activationBudgetMs === undefined ? {} : { activationBudgetMs: compiled.activationBudgetMs }) };
    check(Buffer.byteLength(astraJournalJson(json([...retainedJobs, job]))) <= 524288, 'queue-byte-budget');
    this.write(current.revision, { ...current.checkpoint, order, jobs: [...retainedJobs, job] },
      retireIds.length ? 'job.queued-and-terminal-retired' : 'job.queued', {
      reservationId, reserve: [plan, ...(admission?.reservations ?? [])], ...(admission ? { additional: admission.commits } : {}),
      ...(retire.length ? { retire } : {}),
    });
    if (process.env.MONARCH_AGENT_TIMING === '1') {
      console.error(JSON.stringify({ diagnostic: 'astra-job-queued', adapterId: adapter.id, jobId, at: Date.now() }));
    }
    return this.job(jobId);
  }

  /** Remove one fully settled job and its adapter-owned evidence streams in the
   * same commit as the caller's durable terminal projection. */
  retireTerminal(jobId: string, transition: { commits?: AstraJournalCommit[]; release?: string[]; reservationId?: string } = {}): void {
    const current = this.owned(); id(jobId); const retired = this.find(current, jobId);
    check(terminal.has(retired.state) && !this.active.has(jobId) && !this.recovering.has(jobId)
      && this.options.journal.reservation(retired.reservationId) === null, 'retirement-not-terminal');
    const retainedJobs = current.checkpoint.jobs.filter(job => job.id !== jobId);
    const retire = this.retirementFrontiers([retired], retainedJobs.flatMap(job => job.storage.streams.map(stream => stream.streamId)));
    this.write(current.revision, { ...current.checkpoint, jobs: retainedJobs }, 'job.terminal-retired', {
      ...(transition.commits?.length ? { additional: transition.commits } : {}),
      ...(transition.release?.length ? { release: transition.release } : {}),
      ...(transition.reservationId ? { reservationId: transition.reservationId } : {}),
      ...(retire.length ? { retire } : {}),
    });
  }

  command(jobId: string, command: 'pause' | 'resume' | 'cancel'): AstraWorkJob {
    if (command === 'resume') check(!this.closing, 'closing');
    const current = this.owned(), before = this.find(current, jobId);
    if (terminal.has(before.state)) { check(command !== 'resume', 'terminal-job'); return before; }
    if (command === 'resume') check(before.state === 'paused' || before.state === 'awaiting-approval', 'not-paused');
    if (command === 'pause' && before.state === 'paused') return before;
    if (command === 'cancel' && before.state === 'cancelling') return before;
    check(command === 'cancel' || before.controlCount < this.limits.maxControlsPerJob, 'control-budget');
    const state = command === 'cancel' ? 'cancelling' : command === 'pause' ? 'pausing' : 'queued';
    const next = { ...before, state, controlEpoch: before.controlEpoch + 1, controlCount: before.controlCount + 1 } as AstraWorkJob;
    this.replace(current, next, 'job.' + command + '-requested');
    if (command === 'cancel') this.active.get(jobId)?.controller.abort('user-cancelled');
    const result = this.adapter(before.adapterId).control(before.input, command, () => this.ownerIsCurrent(), this.jobJournal(before));
    return this.finishControl(jobId, next.controlEpoch, result);
  }

  reconcile(jobId: string): AstraWorkJob {
    return this.reconcileCurrent(jobId, true);
  }
  private reconcileCurrent(jobId: string, countControl: boolean): AstraWorkJob {
    const current = this.owned(); let job = this.find(current, jobId);
    if (!['indeterminate', 'pausing', 'cancelling'].includes(job.state)) return job;
    if (countControl) {
      if (job.controlCount >= this.limits.maxControlsPerJob) return this.settleExhaustedControl(current, job);
      job = { ...job, controlCount: job.controlCount + 1 };
      this.replace(current, job, 'job.reconcile-requested');
    }
    const result = this.adapter(job.adapterId).reconcile(job.input, () => this.ownerIsCurrent(), this.jobJournal(job), job);
    return this.finishControl(jobId, job.controlEpoch, result);
  }

  reconcileRemote(jobId: string, timeoutMs = 5000): Promise<AstraWorkJob> {
    check(!this.closing && Number.isSafeInteger(timeoutMs) && timeoutMs >= 20 && timeoutMs <= 10000, 'recovery-budget');
    const previous = this.recovering.get(jobId); if (previous) return previous.promise;
    check(this.recovering.size < 8, 'recovery-capacity');
    const current = this.owned(); let job = this.find(current, jobId);
    if (!['indeterminate', 'pausing', 'cancelling'].includes(job.state)) return Promise.resolve(job);
    const adapter = this.adapter(job.adapterId);
    if (!adapter.reconcileRemote) return Promise.resolve(this.reconcile(jobId));
    if (job.controlCount >= this.limits.maxControlsPerJob) return Promise.resolve(this.settleExhaustedControl(current, job));
    job = { ...job, controlCount: job.controlCount + 1 };
    this.replace(current, job, 'job.remote-reconcile-requested');
    const generation = this.generation, epoch = job.controlEpoch, activationGeneration = job.activationGeneration;
    const controller = new AbortController();
    const owner = (): boolean => this.ownerIsCurrent() && this.generation === generation;
    const valid = (): boolean => {
      if (controller.signal.aborted || !owner()) return false;
      const live = this.job(jobId);
      return live.controlEpoch === epoch && live.activationGeneration === activationGeneration
        && ['indeterminate', 'pausing', 'cancelling'].includes(live.state);
    };
    const releaseHeartbeat = this.keepAlive();
    const promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const control: AstraWorkControl = { signal: controller.signal, isCurrent: valid, ownerIsCurrent: owner,
          schedulerGeneration: generation, activationGeneration, controlEpoch: epoch, journal: this.jobJournal(job) };
        const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          controller.abort('recovery-deadline'); reject(new Error('recovery-deadline'));
        }, timeoutMs); });
        const result = await Promise.race([adapter.reconcileRemote!(job.input, control), expired]);
        return valid() ? this.finishControl(jobId, epoch, result) : this.job(jobId);
      } catch {
        if (owner()) {
          const latest = this.owned(), live = this.find(latest, jobId);
          if (live.controlEpoch === epoch && live.activationGeneration === activationGeneration
            && ['indeterminate', 'pausing', 'cancelling'].includes(live.state)) {
            this.replace(latest, { ...live, reason: controller.signal.aborted ? 'remote-recovery-deadline' : 'adapter-recovery-failed' }, 'job.remote-reconcile-failed');
          }
        }
        return this.job(jobId); // No evidence of quiescence; retain reservations.
      } finally {
        if (timer) clearTimeout(timer);
        this.recovering.delete(jobId); releaseHeartbeat();
      }
    })();
    this.recovering.set(jobId, { promise, controller });
    return promise;
  }

  drain(): Promise<AstraWorkJob[]> {
    check(!this.closing, 'closing');
    this.owned();
    if (this.draining) return this.draining;
    this.draining = this.pump().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  /** Keep the SAME live owner across Application progression between jobs.
   * Not acquisition, execution authority or revival of an expired lease. */
  async withOwnedLease<T>(operation: () => Promise<T>): Promise<T> {
    const release = this.keepAlive();
    try { return await operation(); } finally { release(); }
  }
  /** Cooperative boundary, not new ownership or execution authority. Immediate
   * Promise chains must service timers/control I/O before starting more work.
   * Renew only a still-live lease and fence a takeover during the yield. */
  async yieldOwnedLease(): Promise<void> {
    const { generation, expiresAt } = this.owned().checkpoint;
    check(this.heartbeatUsers > 0, 'progression-lease-required');
    if (expiresAt - this.now() <= this.heartbeatMs()) this.heartbeat();
    await yieldEventLoop();
    check(this.owned().checkpoint.generation === generation, 'owner-fenced');
  }
  list(): AstraWorkJob[] { return this.snapshot()?.checkpoint.jobs ?? []; }
  /** Read-only composition check; does not acquire ownership or grant authority. */
  isHostFor(adapter: AstraWorkAdapter, scopeId: string, journal: AstraJournal): boolean {
    return this.adapters.get(adapter.id) === adapter && this.options.scopeId === scopeId && this.options.journal === journal;
  }
  job(jobId: string): AstraWorkJob { return this.find(this.required(), jobId); }
  ownerIsCurrent(): boolean {
    try { this.owned(); return true; } catch { return false; }
  }
  /** Read-only retry hint for a process restart. The caller may wait through
   * one observed lease window, but acquire() remains the only CAS authority and
   * still rejects a live owner that renewed before the retry. */
  ownerLeaseRemainingMs(): number {
    const current = this.snapshot(true);
    if (!current) return 0;
    return Math.max(0, Math.min(this.limits.leaseMs, current.checkpoint.expiresAt - this.now()));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    for (const { controller } of this.active.values()) controller.abort('scheduler-closing');
    for (const { controller } of this.recovering.values()) controller.abort('scheduler-closing');
    // Adapters are bounded and must observe their control. No generic force-retry.
    if (this.draining) await this.draining;
    await Promise.allSettled([...this.recovering.values()].map(entry => entry.promise));
    if (this.ownerIsCurrent()) { const current = this.owned(); this.write(current.revision,
      { ...current.checkpoint, expiresAt: this.now() }, 'scheduler.owner-released'); }
    this.closed = true;
  }

  private keepAlive(): () => void {
    // An idle owner can still be valid with less time left than the first timer
    // tick. Renew that live lease on demand BEFORE activating work; never revive
    // an expired owner or charge an idle background heartbeat.
    const current = this.owned();
    if (current.checkpoint.expiresAt - this.now() <= this.heartbeatMs()) this.heartbeat();
    this.heartbeatUsers++;
    if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => {
      try { this.heartbeat(); }
      catch { for (const entry of [...this.active.values(), ...this.recovering.values()]) entry.controller.abort('scheduler-fenced'); }
    }, this.heartbeatMs());
    this.heartbeatTimer.unref();
    return () => { if (--this.heartbeatUsers === 0) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; } };
  }
  private heartbeat(): void {
    const current = this.owned();
    this.write(current.revision, { ...current.checkpoint, expiresAt: this.now() + this.limits.leaseMs }, 'scheduler.heartbeat');
  }

  private async pump(): Promise<AstraWorkJob[]> {
    const releaseHeartbeat = this.keepAlive();
    try {
      for (;;) {
        if (this.closing) { await Promise.allSettled([...this.active.values()].map(entry => entry.promise)); return this.list(); }
        if (!this.ownerIsCurrent()) { await Promise.allSettled([...this.active.values()].map(entry => entry.promise)); return this.list(); }
        await this.yieldOwnedLease();
        if (this.closing) continue;
        let current = this.owned();
        for (const job of current.checkpoint.jobs) if (job.state === 'queued' && this.now() >= (job.activationGeneration === 0 ? job.startBy : job.deadline)) {
          current = this.replace(current, { ...job, state: 'blocked', reason: 'queue-deadline' }, 'job.queue-expired');
        }
        // Unresolved old activations keep their declared reservations. Expired
        // ownership is not proof that a model/tool physically stopped using them.
        const running = current.checkpoint.jobs.filter(job => ['running', 'indeterminate', 'pausing', 'cancelling'].includes(job.state) || this.active.has(job.id));
        const next = current.checkpoint.jobs.filter(job => job.state === 'queued' && !this.active.has(job.id)).sort((a, b) => a.order - b.order)
          .find(job => this.fits(job.resources, running.map(active => active.resources)));
        if (next && this.active.size < this.limits.maxActive) {
          if (next.activationGeneration >= next.storage.maxActivations) {
            this.replace(current, { ...next, state: 'blocked', reason: 'activation-budget' }, 'job.activation-budget'); continue;
          }
          const adapter = this.adapter(next.adapterId);
          let compiled: ReturnType<AstraWorkAdapter['compile']>;
          try { compiled = adapter.compile(next.input, this.compileContext(next.id)); this.resources(compiled.resources); this.storage(compiled.storage);
            this.activationBudget(compiled.activationBudgetMs); }
          catch {
            this.replace(current, { ...next, state: 'blocked', reason: 'adapter-readiness-unavailable' }, 'job.readiness-unavailable'); continue;
          }
          if (adapter.version !== next.adapterVersion || compiled.bindingDigest !== next.bindingDigest
            || compiled.activationBudgetMs !== next.activationBudgetMs
            || astraJournalJson(compiled.input) !== astraJournalJson(next.input)
            || astraJournalJson(json(compiled.resources)) !== astraJournalJson(json(next.resources))
            || astraJournalJson(json(compiled.storage)) !== astraJournalJson(json(next.storage))) {
            this.replace(current, { ...next, state: 'blocked', reason: 'adapter-binding-changed' }, 'job.readiness-stale'); continue;
          }
          const activated = { ...next, state: 'running' as const, activationGeneration: next.activationGeneration + 1 };
          const activation = this.replace(current, activated, 'job.activated');
          const controller = new AbortController(), generation = this.generation;
          const control: AstraWorkControl = { signal: controller.signal, schedulerGeneration: generation,
            activationGeneration: activated.activationGeneration, controlEpoch: activated.controlEpoch,
            journal: this.jobJournal(activated),
            ownerIsCurrent: () => this.ownerIsCurrent(), isCurrent: () => {
              if (controller.signal.aborted || !this.ownerIsCurrent() || this.generation !== generation) return false;
              const live = this.job(next.id);
              return live.state === 'running' && live.activationGeneration === activated.activationGeneration
                && live.controlEpoch === activated.controlEpoch && this.now() < live.deadline;
            } };
          let timeout: ReturnType<typeof setTimeout>;
          const deadline = new Promise<AstraWorkResult>(resolve => { timeout = setTimeout(() => {
            controller.abort('activation-deadline');
            resolve({ state: 'indeterminate', progressDigest: sha('deadline:' + next.id + ':' + activated.activationGeneration),
              checkpointRef: 'scheduler_' + this.options.scopeId, checkpointRevision: activation.revision, reason: 'adapter-deadline-indeterminate' });
          }, Math.min(activated.activationBudgetMs ?? this.limits.activationTimeoutMs, Math.max(1, activated.deadline - this.now()))); });
          const activatedAt = Date.now();
          const operation = Promise.resolve().then(() => adapter.execute(next.input, control));
          // A timed-out operation may still own resources. Its late promise is
          // observed by the race, never allowed to overwrite this uncertain result.
          const promise = Promise.race([operation, deadline]).then(result => {
            if (!this.ownerIsCurrent() || this.generation !== generation) return;
            const fresh = this.owned(), live = this.find(fresh, next.id);
            if (live.activationGeneration !== activated.activationGeneration) return;
            if (live.controlEpoch !== activated.controlEpoch) { this.reconcileCurrent(next.id, false); return; }
            this.finishControl(next.id, live.controlEpoch, result);
          }).catch(() => {
            if (!this.ownerIsCurrent() || this.generation !== generation) return;
            const fresh = this.owned(), live = this.find(fresh, next.id);
            if (live.activationGeneration !== activated.activationGeneration) return;
            if (live.controlEpoch !== activated.controlEpoch) {
              // A late failure belongs to the old control epoch. Reconcile is
              // best-effort and must not reject the shared drain promise.
              try { this.reconcileCurrent(next.id, false); } catch { /* bounded by the live job's next explicit recovery */ }
              return;
            }
            this.replace(fresh, { ...live, state: 'indeterminate', reason: 'adapter-or-persistence-failure' }, 'job.interrupted');
          }).finally(() => {
            clearTimeout(timeout); this.active.delete(next.id);
            // Opt-in latency trace for agent speed work: adapter, wall time, outcome only.
            if (process.env.MONARCH_AGENT_TIMING === '1') {
              let state = 'unknown'; try { state = this.job(next.id).state; } catch { /* retired */ }
              console.error(JSON.stringify({ diagnostic: 'astra-activation-timing', adapterId: next.adapterId,
                jobId: next.id, ms: Date.now() - activatedAt, activatedAt, endedAt: Date.now(), state }));
            }
          });
          this.active.set(next.id, { promise, controller }); continue;
        }
        if (this.active.size === 0) return this.list();
        await Promise.race([...this.active.values()].map(entry => entry.promise));
      }
    } catch (error) {
      // A cooperative yield can reveal fencing while other activations still
      // occupy resources. Observe their bounded unwind before exposing failure;
      // never treat a lost lease as physical worker termination.
      for (const entry of this.active.values()) entry.controller.abort('scheduler-progression-failed');
      await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
      throw error;
    } finally { releaseHeartbeat(); }
  }
  /** The control budget bounds control churn; it must never make a job state
   * inescapable. `indeterminate`, `pausing` and `cancelling` leave only through
   * reconcile, so refusing the last reconcile stranded the job permanently —
   * and every task host that kept picking it up as a recovery candidate stalled
   * on it, freezing unrelated work for the rest of the process lifetime.
   *
   * `blocked`, not `failed`: elapsed control attempts are not evidence that the
   * native worker failed, only that this scheduler can no longer drive it. */
  private settleExhaustedControl(current: SchedulerView, job: AstraWorkJob): AstraWorkJob {
    return this.settleUndrivable(current, job, 'control-budget-exhausted');
  }

  /** Settle a job whose owner has given up driving it, so the work above it can
   * reach an outcome.
   *
   * A task host retires a job once its exact recovery attempts are spent. That
   * removed the job from the host's candidate set but left it non-terminal, so
   * the task above it never finished: the person waiting saw a turn that never
   * ended and a Stop that did nothing. Retiring has to settle, not just forget.
   *
   * Callers name the reason and it reaches the person, so it is bounded and
   * kept to a code rather than a message. */
  abandon(jobId: string, reason: string): AstraWorkJob {
    check(/^[a-z0-9][a-z0-9-]{0,63}$/.test(reason), 'abandon-reason');
    const current = this.owned(), job = this.find(current, jobId);
    if (terminal.has(job.state)) return job;
    return this.settleUndrivable(current, job, reason);
  }

  private settleUndrivable(current: SchedulerView, job: AstraWorkJob, reason: string): AstraWorkJob {
    const result: AstraWorkResult = {
      ...(job.result ?? { progressDigest: '', checkpointRef: '', checkpointRevision: 0 }),
      state: 'blocked', reason,
    };
    const next: AstraWorkJob = { ...job, state: 'blocked', result };
    delete next.reason;
    this.replace(current, next, 'job.' + reason);
    return this.job(job.id);
  }
  private finishControl(jobId: string, epoch: number, result: AstraWorkResult): AstraWorkJob {
    const current = this.owned(), job = this.find(current, jobId);
    if (job.controlEpoch !== epoch) return job;
    const copied = JSON.parse(astraJournalJson(result as unknown as AstraJson)) as AstraWorkResult;
    check(['queued', 'pausing', 'paused', 'cancelling', 'observed', 'partial', 'failed', 'cancelled', 'indeterminate', 'blocked', 'awaiting-approval'].includes(copied.state)
      && Number.isSafeInteger(copied.checkpointRevision) && copied.checkpointRevision >= 0
      && typeof copied.checkpointRef === 'string' && copied.checkpointRef.length <= 128
      && typeof copied.progressDigest === 'string' && copied.progressDigest.length <= 128, 'adapter-result');
    // Reconciliation/control may restore the same proven-ready frontier after a
    // fenced activation. That is not an executed adapter spinning without work.
    if (job.state === 'running' && copied.state === 'queued' && job.result?.state === 'queued' && job.result.progressDigest === copied.progressDigest) {
      copied.state = 'blocked'; copied.reason = 'no-progress';
    }
    const order = copied.state === 'queued' ? current.checkpoint.order + 1 : job.order;
    const next: AstraWorkJob = { ...job, state: copied.state, result: copied, order };
    delete next.reason;
    this.replace(current, next, 'job.result', order);
    return this.job(jobId);
  }
  private fits(demand: AstraWorkResources, running: AstraWorkResources[]): boolean {
    return running.length < this.limits.maxActive && ['kernelSlots', 'modelSlots', 'declaredBytes'].every(key =>
      running.reduce((sum, item) => sum + item[key as keyof Omit<AstraWorkResources, 'exclusiveKeys'>], 0)
        + demand[key as keyof Omit<AstraWorkResources, 'exclusiveKeys'>] <= this.limits[key as keyof Pick<AstraWorkLimits, 'kernelSlots' | 'modelSlots' | 'declaredBytes'>])
      && !running.some(item => item.exclusiveKeys.some(key => demand.exclusiveKeys.includes(key)));
  }
  private resources(value: AstraWorkResources): void {
    check(value && [value.kernelSlots, value.modelSlots, value.declaredBytes].every(unit => Number.isSafeInteger(unit) && unit >= 0)
      && Array.isArray(value.exclusiveKeys) && value.exclusiveKeys.length <= 8 && new Set(value.exclusiveKeys).size === value.exclusiveKeys.length, 'resources');
    value.exclusiveKeys.forEach(id);
  }
  private storage(value: AstraWorkStoragePlan): void {
    check(value && Array.isArray(value.streams) && value.streams.length <= 62
      && Number.isSafeInteger(value.maxActivations) && value.maxActivations > 0 && value.maxActivations <= 128
      && value.streams.every(stream => stream.streamId !== this.streamId()), 'storage-plan');
  }
  private activationBudget(value: number | undefined): void {
    check(value === undefined || (Number.isSafeInteger(value) && value >= 1 && value <= 605_000), 'activation-time-budget');
  }
  private retirementFrontiers(jobs: AstraWorkJob[], protectedStreamIds: string[]): AstraJournalStreamRetirement[] {
    const streamIds = jobs.flatMap(job => job.storage.streams.map(stream => stream.streamId));
    check(new Set(streamIds).size === streamIds.length, 'retirement-stream-shared');
    const protectedStreams = new Set(protectedStreamIds);
    check(streamIds.every(streamId => !protectedStreams.has(streamId)), 'retirement-stream-shared');
    return streamIds.flatMap(streamId => {
      const snapshot = this.options.journal.read(streamId);
      return snapshot ? [{ streamId, revision: snapshot.revision, commitHash: snapshot.commitHash }] : [];
    });
  }
  private compileContext(jobId: string): { jobId: string; scopeId: string; controlBudget: number } {
    return { jobId, scopeId: this.options.scopeId, controlBudget: this.limits.maxControlsPerJob };
  }
  private streamId(): string { return 'scheduler_' + this.options.scopeId; }
  private ownerBudgetId(generation: number, epoch: number): string {
    return 'scheduler_budget_' + sha(this.options.scopeId + '/' + generation + (epoch ? '/' + epoch : '')).slice(7, 39);
  }
  private ownerBudgetPlan(id: string): AstraJournalReservation {
    return { id, allocations: [{ streamId: this.streamId(), commits: OWNER_BUDGET_COMMITS,
      eventBytes: OWNER_BUDGET_COMMITS * 4096, checkpointBytes: 1024 * 1024 }] };
  }
  private heartbeatMs(): number { return Math.max(50, Math.floor(this.limits.leaseMs / 3)); }
  private jobJournal(job: AstraWorkJob): AstraJournalAccess {
    return this.options.journal.scoped(job.reservationId, () => this.ownerIsCurrent());
  }
  private adapter(adapterId: string): AstraWorkAdapter { const adapter = this.adapters.get(adapterId); check(adapter, 'adapter-unavailable'); return adapter; }
  private find(view: SchedulerView, jobId: string): AstraWorkJob { const job = view.checkpoint.jobs.find(item => item.id === jobId); check(job, 'missing-job'); return job; }
  private replace(current: SchedulerView, job: AstraWorkJob, type: string, order = current.checkpoint.order): SchedulerView {
    return this.write(current.revision, { ...current.checkpoint, order: Math.max(order, current.checkpoint.order),
      jobs: current.checkpoint.jobs.map(item => item.id === job.id ? job : item) }, type, {
        reservationId: job.reservationId, ...(terminal.has(job.state) ? { release: [job.reservationId] } : {}),
      });
  }
  private snapshot(allowAdditiveUpgrade = false): SchedulerView | null {
    const snapshot = this.options.journal.read('scheduler_' + this.options.scopeId); if (!snapshot) return null;
    const checkpoint = snapshot.checkpoint as unknown as SchedulerCheckpoint;
    const configCurrent = checkpoint.configDigest === this.configDigest;
    check(checkpoint.schemaVersion === 'monarch.astra-v3-work-scheduler.internal.v1' && checkpoint.scopeId === this.options.scopeId
      && (configCurrent || allowAdditiveUpgrade && this.compatibleConfigDigests.has(checkpoint.configDigest))
      && Array.isArray(checkpoint.jobs) && checkpoint.jobs.length <= this.limits.maxJobs, 'checkpoint-binding');
    if (!configCurrent) check(checkpoint.jobs.every(job => this.adapters.get(job.adapterId)?.version === job.adapterVersion),
      'adapter-upgrade-job-binding');
    for (const job of checkpoint.jobs) this.activationBudget(job.activationBudgetMs);
    return { revision: snapshot.revision, checkpoint };
  }
  private required(): SchedulerView { const view = this.snapshot(); check(view, 'not-acquired'); return view; }
  private owned(): SchedulerView {
    check(!this.closed, 'closed'); const current = this.required();
    check(current.checkpoint.ownerId === this.ownerId && current.checkpoint.generation === this.generation
      && current.checkpoint.expiresAt > this.now(), 'owner-fenced'); return current;
  }
  private write(revision: number, checkpoint: SchedulerCheckpoint, type: string,
    options: Omit<AstraJournalAtomicCommit, 'primary'> & { reservationId?: string } = {}): SchedulerView {
    const ownerBudget = this.ownerBudgetId(checkpoint.generation, checkpoint.ownerBudgetEpoch ?? 0);
    const reservationId = options.reservationId ?? ownerBudget;
    let reserve = options.reserve ?? [], release = options.release ?? [];
    if (reservationId === ownerBudget && !release.includes(ownerBudget) && !reserve.some(plan => plan.id === ownerBudget)) {
      const remaining = this.options.journal.reservation(ownerBudget)?.remaining.find(item => item.streamId === this.streamId())?.commits ?? 0;
      if (remaining <= OWNER_BUDGET_ROTATE_AT) {
        // Settle the spent allocation in the same commit that reserves its successor.
        const epoch = (checkpoint.ownerBudgetEpoch ?? 0) + 1;
        checkpoint = { ...checkpoint, ownerBudgetEpoch: epoch };
        reserve = [...reserve, this.ownerBudgetPlan(this.ownerBudgetId(checkpoint.generation, epoch))];
        release = [...release, ownerBudget];
      }
    }
    try { this.options.journal.appendAtomic({ primary: { streamId: this.streamId(), requestId: 'scheduler_' + randomUUID(),
      expectedRevision: revision, checkpoint: json(checkpoint), events: [{ type, generation: checkpoint.generation }], reservationId },
      ...(options.additional ? { additional: options.additional } : {}), ...(reserve.length ? { reserve } : {}),
      ...(release.length ? { release } : {}),
      ...(options.retire ? { retire: options.retire } : {}),
      ...((revision + 1) % SCHEDULER_COMPACT_EVERY === 0 ? { compactHistory: { keepLatest: SCHEDULER_HISTORY_KEEP } } : {}),
    }); }
    catch (error) { if (error instanceof AstraJournalError && error.code === 'revision-conflict') throw new Error('astra-scheduler:concurrent-update'); throw error; }
    return this.required();
  }
  /** The clock job deadlines are measured on; a host retiring overdue work
   * must compare against this, not its own wall clock. */
  clockNow(): number { return this.now(); }
  private now(): number {
    const now = (this.options.now ?? Date.now)(); check(Number.isSafeInteger(now) && now >= this.lastNow, 'clock-regression'); this.lastNow = now; return now;
  }
}

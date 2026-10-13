import { createHash } from 'node:crypto';
import { synchronizeEach, type AstraTaskFaultPolicy } from './task-fault';
import { MonarchKernel } from '../core/kernel';
import { AstraJournal, astraJournalJson, type AstraJson, type AstraJournalReservation } from './journal';
import { AstraReadRuntime, astraReadRunId, type AstraReadCheckpoint } from './read-runtime';
import { AstraReadWorkAdapter } from './read-work-adapter';
import { AstraReadWorkflow, type AstraReadWorkflowRequest } from './read-workflow';
import { prepareAstraTaskSourceAdmission, type AstraTaskSourceAdmission } from './task-source-admission';
import { AstraWorkScheduler, astraWorkJobId, type AstraWorkAdapter, type AstraWorkJob, type AstraWorkLimits } from './work-scheduler';
import { astraReadGoalSteps, astraReadValueDigest, certifyAstraReadTask, compileAstraReadTaskGoal,
  renderAstraReadTaskCertificate, validateAstraReadTaskGoal, type AstraReadCertificationInput, type AstraReadSelection,
  type AstraReadSourceKey, type AstraReadTaskCertificate, type AstraReadTaskGoal } from './read-task-certifier';

/** Host-owned source admission; no model result may implement or impersonate it.
 * A production implementation must bind the existing authenticated interaction,
 * clause/target selection and policy revision. Tests supply an explicit synthetic
 * user selection. This port is not native IntentAdmission or a Kernel permission.
 */
export interface AstraReadAdmissionPort {
  resolve(source: AstraReadSourceKey): AstraReadSelection;
  isCurrent(source: AstraReadTaskGoal['source']): boolean;
}
export interface AstraReadTaskRequest {
  requestId: string; source: AstraReadSourceKey; startWithinMs?: number; finishWithinMs?: number;
}
export interface AstraReadTaskRecord {
  schemaVersion: 'monarch.astra-v3-read-task.internal.v1';
  taskId: string; jobId: string; requestDigest: string; goal: AstraReadTaskGoal; goalDigest: string;
  phase: 'admitted' | 'certified'; reservationId: string;
  certificateRef?: string; certificateDigest?: string; messageRef?: string;
}
export interface AstraReadTaskMessage {
  schemaVersion: 'monarch.astra-v3-read-task-message.internal.v1';
  id: string; taskId: string; predecessorMessageId: string; certificateDigest: string;
  content: string; delivery: 'pending' | 'acknowledged';
}
export interface AstraReadTaskView {
  taskId: string; jobId: string; goalDigest: string; source: AstraReadTaskGoal['source'];
  status: AstraWorkJob['state'] | 'awaiting-certification' | 'completed';
  nativeCompletionCertified: false; certificate?: AstraReadTaskCertificate; message?: AstraReadTaskMessage;
}
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const identity = (value: string): boolean => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value);
const terminal = new Set<AstraWorkJob['state']>(['observed', 'partial', 'failed', 'cancelled', 'blocked']);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-read-task:' + code); }
export const astraReadTaskId = (scopeId: string, requestId: string): string => 'task_' + sha(scopeId + '/' + requestId).slice(0, 32);

export interface AstraReadTaskProfileOptions {
  deployment: 'isolated-validation'; canonicalRoot: string; scopeId: string;
  kernel: MonarchKernel; journal: AstraJournal; admission: AstraReadAdmissionPort;
  restartSafeAdmission?: boolean;
}

/** Joined read-task family on an EXTERNAL common scheduler. Register .adapter
 * with other packs, then .attach(scheduler). No model, second queue/resource owner,
 * automatic delivery, ordinary Oscar wiring or native authority impersonation. */
export class AstraReadTaskProfile {
  readonly adapter: AstraWorkAdapter;
  private attachedScheduler: AstraWorkScheduler | undefined;
  private readonly prepared = new Map<string, AstraReadTaskRecord>();
  private readonly reads: AstraReadRuntime;

  constructor(private readonly options: AstraReadTaskProfileOptions) {
    check(options.deployment === 'isolated-validation' && identity(options.scopeId), 'deployment');
    this.reads = new AstraReadRuntime(options);
    const delegate = new AstraReadWorkAdapter(options);
    const current = (taskId: string): boolean => {
      try { return options.admission.isCurrent(this.record(taskId).goal.source) === true; } catch { return false; }
    };
    const unpack = (input: AstraJson): { taskId: string; read?: AstraReadWorkflowRequest } => {
      check(input && typeof input === 'object' && !Array.isArray(input)
        && Object.keys(input).every(key => key === 'taskId' || key === 'read') && typeof input.taskId === 'string'
        && identity(input.taskId), 'work-input');
      return input as unknown as { taskId: string; read?: AstraReadWorkflowRequest };
    };
    const adapter: AstraWorkAdapter = {
      id: 'admitted-workspace-read', version: delegate.version,
      compile: (input, context) => {
        const accepted = unpack(input), record = this.record(accepted.taskId);
        check(current(accepted.taskId), 'source-admission-stale');
        check(record.goal.capabilityDigest === this.reads.capabilityDigest, 'capability-changed');
        const compiled = delegate.compile({ steps: json(astraReadGoalSteps(record.goal)) }, context);
        if (accepted.read) check(astraJournalJson(json(accepted.read)) === astraJournalJson(compiled.input), 'work-goal-substitution');
        return { ...compiled, input: { taskId: record.taskId, read: compiled.input },
          bindingDigest: astraReadValueDigest({ goalDigest: record.goalDigest, adapterBinding: compiled.bindingDigest }) };
      },
      execute: (input, control) => {
        const accepted = unpack(input); check(accepted.read, 'compiled-work-required');
        return delegate.execute(json(accepted.read), { ...control, isCurrent: () => control.isCurrent() && current(accepted.taskId) });
      },
      control: (input, command, ownerIsCurrent, journal) => {
        const accepted = unpack(input); check(accepted.read, 'compiled-work-required');
        if (command === 'resume') check(current(accepted.taskId), 'source-admission-stale');
        return delegate.control(json(accepted.read), command, ownerIsCurrent, journal);
      },
      reconcile: (input, ownerIsCurrent, journal) => {
        const accepted = unpack(input); check(accepted.read, 'compiled-work-required');
        return delegate.reconcile(json(accepted.read), ownerIsCurrent, journal);
      },
    };
    this.adapter = adapter;
  }

  attach(scheduler: AstraWorkScheduler): this {
    check((!this.attachedScheduler || this.attachedScheduler === scheduler)
      && scheduler.isHostFor(this.adapter, this.options.scopeId, this.options.journal), 'scheduler-binding');
    this.attachedScheduler = scheduler; return this;
  }
  protected get scheduler(): AstraWorkScheduler { check(this.attachedScheduler, 'scheduler-not-attached'); return this.attachedScheduler; }

  submit(request: AstraReadTaskRequest, sourceAdmission?: AstraTaskSourceAdmission): AstraReadTaskView {
    check(this.scheduler.ownerIsCurrent(), 'owner-required');
    check(Object.keys(request).every(key => ['requestId', 'source', 'startWithinMs', 'finishWithinMs'].includes(key))
      && identity(request.requestId) && request.source && Object.keys(request.source).every(key => ['interactionId', 'messageId'].includes(key))
      && identity(request.source.interactionId) && identity(request.source.messageId), 'request');
    const taskId = astraReadTaskId(this.options.scopeId, request.requestId);
    const startWithinMs = request.startWithinMs ?? 60000, finishWithinMs = request.finishWithinMs ?? 300000;
    const requestDigest = astraReadValueDigest(json({ requestId: request.requestId, source: request.source, startWithinMs, finishWithinMs }));
    const previous = this.options.journal.read(taskId);
    if (previous) { check(this.record(taskId).requestDigest === requestDigest, 'request-conflict'); return this.read(taskId); }
    const selection = this.options.admission.resolve(structuredClone(request.source));
    const goal = compileAstraReadTaskGoal({ taskId, requestDigest, schedulerScopeId: this.options.scopeId,
      canonicalRoot: this.options.canonicalRoot, capabilityDigest: this.reads.capabilityDigest, source: request.source, selection,
      ...(this.adapter.version === 'v2' ? { adapterVersion: 'v2' } : {}) });
    const record: AstraReadTaskRecord = { schemaVersion: 'monarch.astra-v3-read-task.internal.v1', taskId,
      jobId: astraWorkJobId(taskId), requestDigest, goal, goalDigest: astraReadValueDigest(json(goal)), phase: 'admitted',
      reservationId: 'task_budget_' + sha(taskId).slice(0, 32) };
    const certificateId = this.certificateId(taskId), messageId = this.messageId(taskId);
    const source = prepareAstraTaskSourceAdmission(sourceAdmission, taskId, record.reservationId, [taskId, certificateId, messageId]);
    const reservation: AstraJournalReservation = { id: record.reservationId, allocations: [
      { streamId: taskId, commits: 2, eventBytes: 8192, checkpointBytes: Buffer.byteLength(astraJournalJson(json(record))) + 2048 },
      { streamId: certificateId, commits: 1, eventBytes: 4096, checkpointBytes: 65536 },
      { streamId: messageId, commits: 2, eventBytes: 4096, checkpointBytes: 4096 },
      ...source.allocations,
    ] };
    // This candidate is visible only during synchronous compilation. Queue, Goal
    // and future capacity then share one transaction; no runnable orphan Execution.
    this.prepared.set(taskId, record);
    try {
      this.scheduler.submit({ requestId: taskId, adapterId: 'admitted-workspace-read', input: { taskId }, startWithinMs, finishWithinMs }, {
        reservations: [reservation], commits: [{ streamId: taskId, requestId: 'admit_' + taskId, expectedRevision: 0,
          reservationId: record.reservationId, checkpoint: json(record),
          events: [{ type: 'task.admitted', goalDigest: record.goalDigest, predecessorMessageId: goal.source.messageId }] }, ...source.commits],
      });
    } finally { this.prepared.delete(taskId); }
    return this.read(taskId);
  }

  async drain(): Promise<AstraReadTaskView[]> {
    const jobs = await this.scheduler.drain();
    for (const job of jobs) if (job.adapterId === this.adapter.id) this.synchronize((job.input as { taskId: string }).taskId);
    return this.list();
  }
  list(): AstraReadTaskView[] {
    return this.scheduler.list().filter(job => job.adapterId === this.adapter.id).map(job => this.read((job.input as { taskId: string }).taskId));
  }
  synchronizeAll(policy?: AstraTaskFaultPolicy): AstraReadTaskView[] {
    return synchronizeEach(this.scheduler.list().filter(job => job.adapterId === this.adapter.id)
      .map(job => (job.input as { taskId: string }).taskId), taskId => this.synchronize(taskId), policy);
  }
  recoveryCandidates(policy?: AstraTaskFaultPolicy): Array<{ taskId: string; jobId: string }> {
    return synchronizeEach(this.scheduler.list().filter(job => job.adapterId === this.adapter.id)
      .map(job => (job.input as { taskId: string }).taskId), taskId => {
        const record = this.record(taskId), job = this.scheduler.job(record.jobId);
        return ['indeterminate', 'pausing', 'cancelling'].includes(job.state) ? [{ taskId, jobId: job.id }] : [];
      }, policy).flat();
  }
  command(taskId: string, command: 'pause' | 'resume' | 'cancel'): AstraReadTaskView {
    this.scheduler.command(this.record(taskId).jobId, command); return this.synchronize(taskId);
  }
  reconcile(taskId: string): AstraReadTaskView {
    this.scheduler.reconcile(this.record(taskId).jobId); return this.synchronize(taskId);
  }

  synchronize(taskId: string): AstraReadTaskView {
    check(this.scheduler.ownerIsCurrent(), 'owner-required');
    const record = this.record(taskId), job = this.scheduler.job(record.jobId);
    if (record.phase === 'certified' || !terminal.has(job.state)) return this.read(taskId);
    const certificate = certifyAstraReadTask(this.certificationInput(record)), certificateDigest = astraReadValueDigest(json(certificate));
    const certificateId = this.certificateId(taskId), messageId = this.messageId(taskId);
    const message: AstraReadTaskMessage = { schemaVersion: 'monarch.astra-v3-read-task-message.internal.v1', id: messageId,
      taskId, predecessorMessageId: record.goal.source.messageId, certificateDigest,
      content: renderAstraReadTaskCertificate(certificate), delivery: 'pending' };
    const snapshot = this.options.journal.read(taskId)!;
    this.options.journal.appendAtomic({ primary: { streamId: taskId, requestId: 'certify_' + taskId, expectedRevision: snapshot.revision,
      reservationId: record.reservationId,
      checkpoint: json({ ...record, phase: 'certified', certificateRef: certificateId, certificateDigest, messageRef: messageId }),
      events: [{ type: 'task.certified-internal-read-profile', certificateDigest, status: certificate.status }] },
      additional: [
        { streamId: certificateId, requestId: 'certificate_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
          checkpoint: json(certificate), events: [{ type: 'certificate.persisted', goalDigest: record.goalDigest, certificateDigest }] },
        { streamId: messageId, requestId: 'message_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
          checkpoint: json(message), events: [{ type: 'message.queued', predecessorMessageId: record.goal.source.messageId, certificateDigest }] },
      ],
    }, () => this.scheduler.ownerIsCurrent());
    return this.read(taskId);
  }

  read(taskId: string): AstraReadTaskView {
    const record = this.record(taskId), job = this.scheduler.job(record.jobId);
    const base = { taskId, jobId: job.id, goalDigest: record.goalDigest, source: structuredClone(record.goal.source), nativeCompletionCertified: false as const };
    if (record.phase !== 'certified') return { ...base, status: terminal.has(job.state) ? 'awaiting-certification' : job.state };
    const certificate = this.options.journal.read(this.certificateId(taskId))?.checkpoint as unknown as AstraReadTaskCertificate;
    check(certificate && record.certificateRef === this.certificateId(taskId)
      && record.certificateDigest === astraReadValueDigest(json(certificate)), 'certificate-integrity');
    // Re-evaluate exactly retained facts; no target re-read and no current model.
    check(astraReadValueDigest(json(certifyAstraReadTask(this.certificationInput(record)))) === record.certificateDigest, 'certificate-frontier');
    const message = this.options.journal.read(this.messageId(taskId))?.checkpoint as unknown as AstraReadTaskMessage;
    check(message && record.messageRef === this.messageId(taskId) && message.id === record.messageRef && message.taskId === taskId
      && message.schemaVersion === 'monarch.astra-v3-read-task-message.internal.v1'
      && message.predecessorMessageId === record.goal.source.messageId && message.certificateDigest === record.certificateDigest
      && message.content === renderAstraReadTaskCertificate(certificate)
      && ['pending', 'acknowledged'].includes(message.delivery), 'message-binding');
    return { ...base, status: certificate.status, certificate, message };
  }

  readContent(taskId: string, requirementId: string): { content: string; sizeBytes: number; contentDigest: string;
    untrusted: true; temporalSemantics: 'snapshot-at-execution' } {
    const view = this.read(taskId), requirement = view.certificate?.requirements.find(item => item.id === requirementId);
    check(requirement?.state === 'satisfied' && requirement.evidence && requirement.observation, 'content-not-certified');
    const snapshot = this.options.journal.read(requirement.evidence.streamId)!;
    check(snapshot.revision === requirement.evidence.revision && snapshot.commitHash === requirement.evidence.commitHash, 'content-frontier');
    const checkpoint = snapshot.checkpoint as unknown as AstraReadCheckpoint;
    return { content: checkpoint.observation!.content, sizeBytes: requirement.observation.sizeBytes,
      contentDigest: requirement.observation.contentDigest, untrusted: true, temporalSemantics: 'snapshot-at-execution' };
  }

  acknowledgeMessage(taskId: string, certificateDigest: string): AstraReadTaskView {
    check(this.scheduler.ownerIsCurrent(), 'owner-required');
    const view = this.read(taskId), record = this.record(taskId), message = view.message;
    check(message && certificateDigest === record.certificateDigest, 'message-ack-binding');
    if (message.delivery === 'acknowledged') return view;
    const snapshot = this.options.journal.read(message.id)!;
    this.options.journal.appendAtomic({ primary: { streamId: message.id, requestId: 'ack_' + taskId,
      expectedRevision: snapshot.revision, reservationId: record.reservationId, checkpoint: json({ ...message, delivery: 'acknowledged' }),
      events: [{ type: 'message.acknowledged', certificateDigest }] }, release: [record.reservationId] }, () => this.scheduler.ownerIsCurrent());
    return this.read(taskId);
  }

  private record(taskId: string): AstraReadTaskRecord {
    check(identity(taskId), 'task-identity');
    const record = this.prepared.get(taskId) ?? this.options.journal.read(taskId)?.checkpoint as unknown as AstraReadTaskRecord | undefined;
    check(record && record.schemaVersion === 'monarch.astra-v3-read-task.internal.v1' && record.taskId === taskId
      && record.jobId === astraWorkJobId(taskId) && record.goal.taskId === taskId && record.goal.schedulerScopeId === this.options.scopeId
      && (record.goal.adapterVersion ?? 'v1') === this.adapter.version
      && record.reservationId === 'task_budget_' + sha(taskId).slice(0, 32)
      && record.goal.scopeDigest === this.reads.scopeDigest && record.goal.requestDigest === record.requestDigest
      && ['admitted', 'certified'].includes(record.phase), 'task-binding');
    validateAstraReadTaskGoal(record.goal, record.goalDigest); return record;
  }
  private certificationInput(record: AstraReadTaskRecord): AstraReadCertificationInput {
    const job = this.scheduler.job(record.jobId), read = (job.input as unknown as { read: AstraReadWorkflowRequest }).read;
    const expected = AstraReadWorkflow.compile(read, record.goal.scopeDigest);
    const workflow = this.options.journal.read(expected.runId);
    // Expected IDs come from the frozen input, never arbitrary refs in a result.
    const children = expected.steps.map(step => this.options.journal.read(astraReadRunId(step.readRequestId)))
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
    return { goal: record.goal, goalDigest: record.goalDigest, job, workflow, children };
  }
  private certificateId(taskId: string): string { return 'certificate_' + taskId; }
  private messageId(taskId: string): string { return 'message_' + taskId; }
}

/** Compatibility convenience for existing isolated single-read-family callers.
 * Composed hosts use AstraReadTaskProfile + AstraCreateTaskProfile on ONE scheduler,
 * never instantiate this convenience host alongside a second family scheduler. */
export class AstraReadTaskRuntime extends AstraReadTaskProfile {
  constructor(options: AstraReadTaskProfileOptions & { limits?: Partial<AstraWorkLimits>; now?: () => number }) {
    super(options);
    this.attach(new AstraWorkScheduler({ deployment: options.deployment, journal: options.journal, scopeId: options.scopeId,
      adapters: [this.adapter], limits: { ...options.limits, modelSlots: 0 }, ...(options.now ? { now: options.now } : {}) }));
  }
  acquire(): void { this.scheduler.acquire(); }
  close(): Promise<void> { return this.scheduler.close(); }
}

import path from 'node:path';
import { synchronizeEach, type AstraTaskFaultPolicy } from './task-fault';
import type { MonarchKernel } from '../core/kernel';
import { AstraJournal, astraJournalJson, type AstraJson, type AstraJournalReservation, type AstraJournalCommit } from './journal';
import { AstraCreateWorkAdapter, astraCreateSelectionDigest, astraCreateWorkId, type AstraCreateWorkInput } from './create-work-adapter';
import { AstraWorkScheduler, astraWorkJobId, type AstraWorkAdapter, type AstraWorkJob } from './work-scheduler';
import { prepareAstraTaskSourceAdmission, type AstraTaskSourceAdmission } from './task-source-admission';
import { createApprovalAnswerId, createApprovalDigest, validateCreateApprovalAnswer, validateCreateApprovalDecision,
  type AstraCreateApproval, type AstraCreateApprovalAnswer, type AstraCreateApprovalCard, type AstraCreateApprovalDecision } from './create-approval';
import { astraCreateSelectedInput, astraCreateValueDigest, certifyAstraCreateTask, compileAstraCreateTaskGoal,
  renderAstraCreateTaskCertificate, validateAstraCreateTaskGoal, type AstraCreateCertificationInput,
  type AstraCreateSelection, type AstraCreateSourceKey, type AstraCreateTaskCertificate, type AstraCreateTaskGoal } from './create-task-certifier';

/** Synchronous, bounded host source port. Not implemented by model text, not a
 * Kernel policy override and not the product/native authentication boundary. */
export interface AstraCreateAdmissionPort {
  resolve(source: AstraCreateSourceKey): AstraCreateSelection;
  isCurrent(source: AstraCreateTaskGoal['source']): boolean;
  /** Deny-only parent control fence, independent of source validity while paused. */
  isDispatchAllowed?(source: AstraCreateTaskGoal['source']): boolean;
}
export interface AstraCreateTaskRequest { requestId: string; source: AstraCreateSourceKey; startWithinMs?: number; finishWithinMs?: number }
export interface AstraCreateTaskRecord {
  schemaVersion: 'monarch.astra-v3-create-task.internal.v1'; taskId: string; jobId: string; requestDigest: string;
  goal: AstraCreateTaskGoal; goalDigest: string; phase: 'admitted' | 'certified'; reservationId: string;
  certificateDigest?: string; certificateRef?: string; messageRef?: string;
}
export interface AstraCreateTaskMessage {
  schemaVersion: 'monarch.astra-v3-create-task-message.internal.v1'; id: string; taskId: string;
  interactionId: string; predecessorMessageId: string; certificateDigest: string; content: string; delivery: 'pending' | 'acknowledged';
}
export interface AstraCreateTaskView {
  taskId: string; jobId: string; source: AstraCreateTaskGoal['source']; goalDigest: string;
  status: AstraWorkJob['state'] | 'awaiting-certification' | 'completed'; nativeCompletionCertified: false;
  certificate?: AstraCreateTaskCertificate; message?: AstraCreateTaskMessage;
  approval?: AstraCreateApprovalCard;
}
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
const terminal = new Set<AstraWorkJob['state']>(['observed', 'cancelled', 'blocked']);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-create-task:' + code); }
export const astraCreateTaskId = (scopeId: string, requestId: string): string => 'task_create_' + astraCreateValueDigest(scopeId + '/' + requestId).slice(7, 39);

/** A family profile attached to ONE externally owned scheduler/Kernel/Store.
 * Register .adapter together with other work packs, construct/acquire the common
 * scheduler, then .attach(scheduler). This class never creates/acquires/closes an
 * executor or owns a second queue. No default/product route or automatic delivery. */
export class AstraCreateTaskProfile {
  readonly adapter: AstraWorkAdapter;
  private scheduler: AstraWorkScheduler | undefined;
  private readonly prepared = new Map<string, AstraCreateTaskRecord>();
  private readonly root: string;
  private readonly delegate: AstraCreateWorkAdapter;

  constructor(private readonly options: { deployment: 'isolated-validation'; canonicalRoot: string; scopeId: string;
    kernel: MonarchKernel; journal: AstraJournal; admission: AstraCreateAdmissionPort; adapterId?: AstraCreateTaskGoal['adapterId']; exactApprovals?: boolean }) {
    check(options.deployment === 'isolated-validation' && id(options.scopeId) && path.isAbsolute(options.canonicalRoot), 'deployment');
    this.root = path.resolve(options.canonicalRoot);
    const findTask = (input: AstraCreateWorkInput) => {
      const job = this.host().list().find(job => job.adapterId === this.adapter.id
        && astraCreateWorkId(options.scopeId, job.id) === input.workId);
      check(job, 'approval-job'); return this.record((job.input as { taskId: string }).taskId);
    };
    const delegate = this.delegate = new AstraCreateWorkAdapter({ ...options, isSourceCurrent: input => this.currentInput(input),
      ...(options.exactApprovals ? { approvalPort: {
        deadline: (input: AstraCreateWorkInput) => this.host().job(findTask(input).jobId).deadline,
        answer: (input: AstraCreateWorkInput, challenge: AstraCreateApproval) => this.answer(findTask(input), challenge),
      } } : {}),
    });
    const unpack = (input: AstraJson): { taskId: string; create: AstraCreateWorkInput } => {
      check(input && typeof input === 'object' && !Array.isArray(input)
        && Object.keys(input).every(key => ['taskId', 'create'].includes(key)) && id(input.taskId)
        && input.create && typeof input.create === 'object' && !Array.isArray(input.create), 'work-input');
      return input as unknown as { taskId: string; create: AstraCreateWorkInput };
    };
    this.adapter = { id: options.adapterId ?? 'admitted-workspace-create', version: delegate.version,
      compile: (raw, context) => {
        const input = unpack(raw), record = this.record(input.taskId);
        check(context.scopeId === options.scopeId && context.jobId === record.jobId && this.currentTask(record), 'source-admission-stale');
        const compiled = delegate.compile(json(input.create), context);
        check(astraCreateSelectionDigest(compiled.input as unknown as AstraCreateWorkInput) === record.goal.selectionDigest, 'work-goal-substitution');
        return { ...compiled, input: { taskId: input.taskId, create: compiled.input },
          bindingDigest: astraCreateValueDigest({ goalDigest: record.goalDigest, adapterBinding: compiled.bindingDigest }) };
      },
      execute: (raw, control) => {
        const input = unpack(raw);
        return delegate.execute(json(input.create), { ...control,
          isCurrent: () => { const record = this.record(input.taskId);
            return control.isCurrent() && this.currentTask(record)
              && (!options.admission.isDispatchAllowed || options.admission.isDispatchAllowed(record.goal.source) === true); } });
      },
      control: (raw, command, owner, journal) => {
        const input = unpack(raw);
        if (command === 'resume') check(this.currentTask(this.record(input.taskId)), 'source-admission-stale');
        return delegate.control(json(input.create), command, owner, journal);
      },
      reconcile: (raw, owner, journal) => delegate.reconcile(json(unpack(raw).create), owner, journal),
    };
  }

  attach(scheduler: AstraWorkScheduler): this {
    check((!this.scheduler || this.scheduler === scheduler)
      && scheduler.isHostFor(this.adapter, this.options.scopeId, this.options.journal), 'scheduler-binding');
    this.scheduler = scheduler; return this;
  }

  submit(request: AstraCreateTaskRequest, parentCommits: AstraJournalCommit[] = [], sourceAdmission?: AstraTaskSourceAdmission): AstraCreateTaskView {
    const scheduler = this.host(); check(scheduler.ownerIsCurrent(), 'owner-required');
    check(request && Object.keys(request).every(key => ['requestId', 'source', 'startWithinMs', 'finishWithinMs'].includes(key))
      && id(request.requestId) && request.source && Object.keys(request.source).every(key => ['interactionId', 'messageId'].includes(key))
      && id(request.source.interactionId) && id(request.source.messageId), 'request');
    const taskId = astraCreateTaskId(this.options.scopeId, request.requestId);
    check(parentCommits.length <= 4 && parentCommits.every(item => item.streamId !== taskId), 'parent-admission');
    const startWithinMs = request.startWithinMs ?? 60000, finishWithinMs = request.finishWithinMs ?? 300000;
    const requestDigest = astraCreateValueDigest({ requestId: request.requestId, source: request.source, startWithinMs, finishWithinMs });
    if (this.options.journal.read(taskId)) {
      check(this.record(taskId).requestDigest === requestDigest, 'request-conflict'); return this.read(taskId);
    }
    const selection = this.options.admission.resolve(structuredClone(request.source));
    const goal = compileAstraCreateTaskGoal({ taskId, requestDigest, schedulerScopeId: this.options.scopeId, canonicalRoot: this.root,
      source: request.source, selection, ...(this.options.adapterId ? { adapterId: this.options.adapterId } : {}),
      ...(this.options.exactApprovals ? { adapterVersion: 'v2' } : {}) });
    const record: AstraCreateTaskRecord = { schemaVersion: 'monarch.astra-v3-create-task.internal.v1', taskId, jobId: astraWorkJobId(taskId),
      requestDigest, goal, goalDigest: astraCreateValueDigest(goal), phase: 'admitted', reservationId: this.budgetId(taskId) };
    const source = prepareAstraTaskSourceAdmission(sourceAdmission, taskId, record.reservationId,
      [taskId, this.certificateId(taskId), this.messageId(taskId)]);
    const reservation: AstraJournalReservation = { id: record.reservationId, allocations: [
      { streamId: taskId, commits: 2, eventBytes: 8192, checkpointBytes: Buffer.byteLength(astraJournalJson(json(record))) + 2048 },
      { streamId: this.certificateId(taskId), commits: 1, eventBytes: 4096, checkpointBytes: 8192 },
      { streamId: this.messageId(taskId), commits: 2, eventBytes: 4096, checkpointBytes: 4096 },
      ...(this.options.exactApprovals ? [{ streamId: createApprovalAnswerId(taskId), commits: 1, eventBytes: 4096, checkpointBytes: 32768 }] : []),
      ...source.allocations,
    ] };
    this.prepared.set(taskId, record);
    try {
      scheduler.submit({ requestId: taskId, adapterId: this.adapter.id,
        input: { taskId, create: json(astraCreateSelectedInput(request.source, selection)) }, startWithinMs, finishWithinMs }, {
        reservations: [reservation], commits: [{ streamId: taskId, requestId: 'admit_' + taskId, expectedRevision: 0,
          reservationId: record.reservationId, checkpoint: json(record),
          events: [{ type: 'task.create-admitted', goalDigest: record.goalDigest, predecessorMessageId: goal.source.messageId }] }, ...parentCommits, ...source.commits],
      });
    } finally { this.prepared.delete(taskId); }
    return this.read(taskId);
  }

  list(): AstraCreateTaskView[] {
    return this.host().list().filter(job => job.adapterId === this.adapter.id).map(job => this.read((job.input as { taskId: string }).taskId));
  }
  synchronizeAll(policy?: AstraTaskFaultPolicy): AstraCreateTaskView[] {
    return synchronizeEach(this.host().list().filter(job => job.adapterId === this.adapter.id)
      .map(job => (job.input as { taskId: string }).taskId), taskId => this.synchronize(taskId), policy);
  }
  recoveryCandidates(policy?: AstraTaskFaultPolicy): Array<{ taskId: string; jobId: string }> {
    return synchronizeEach(this.host().list().filter(job => job.adapterId === this.adapter.id)
      .map(job => (job.input as { taskId: string }).taskId), taskId => {
        const record = this.record(taskId), job = this.host().job(record.jobId);
        return ['indeterminate', 'pausing', 'cancelling'].includes(job.state) ? [{ taskId, jobId: job.id }] : [];
      }, policy).flat();
  }
  command(taskId: string, command: 'pause' | 'resume' | 'cancel'): AstraCreateTaskView {
    this.host().command(this.record(taskId).jobId, command); return this.synchronize(taskId);
  }
  reconcile(taskId: string): AstraCreateTaskView {
    this.host().reconcile(this.record(taskId).jobId); return this.synchronize(taskId);
  }
  decide(taskId: string, decision: AstraCreateApprovalDecision, sourceAdmission?: AstraTaskSourceAdmission): AstraCreateTaskView {
    const scheduler = this.host(); check(scheduler.ownerIsCurrent() && this.options.exactApprovals, 'approval-disabled');
    validateCreateApprovalDecision(decision);
    const record = this.record(taskId), job = scheduler.job(record.jobId), challenge = this.effect(record)?.approval;
    check(challenge, 'approval-unavailable');
    const previous = this.answer(record, challenge);
    if (previous) { check(createApprovalDigest(previous.decision) === createApprovalDigest(decision), 'approval-conflict'); return this.synchronize(taskId); }
    check(record.phase === 'admitted' && ['awaiting-approval', 'paused'].includes(job.state)
      && (decision.decision === 'reject' || this.currentTask(record) && Date.now() < challenge.expiresAt)
      && decision.messageId !== record.goal.source.messageId, 'approval-unavailable');
    const answer: AstraCreateApprovalAnswer = { schemaVersion: 'monarch.astra-v3-create-approval-answer.internal.v1',
      taskId, goalDigest: record.goalDigest, challenge, decision: structuredClone(decision), receivedAt: Date.now() };
    validateCreateApprovalAnswer(answer, taskId, record.goalDigest, challenge);
    const reservationId = 'approval_source_' + taskId;
    const source = prepareAstraTaskSourceAdmission(sourceAdmission, taskId, reservationId,
      [taskId, createApprovalAnswerId(taskId), this.certificateId(taskId), this.messageId(taskId)]);
    // Answer + authenticated global message claim have ONE durable commit point.
    // Waking the job is repeatable; recovery consumes the same retained answer.
    this.options.journal.appendAtomic({ primary: { streamId: createApprovalAnswerId(taskId), requestId: 'answer_' + taskId,
      expectedRevision: 0, reservationId: record.reservationId, checkpoint: json(answer),
      events: [{ type: 'create.approval-answered', digest: createApprovalDigest(answer), decision: decision.decision }] },
      ...(source.allocations.length ? { reserve: [{ id: reservationId, allocations: source.allocations }], additional: source.commits } : {}),
    }, () => scheduler.ownerIsCurrent());
    return this.synchronize(taskId);
  }
  synchronize(taskId: string): AstraCreateTaskView {
    const scheduler = this.host(); check(scheduler.ownerIsCurrent(), 'owner-required');
    const record = this.record(taskId); let job = scheduler.job(record.jobId);
    if (record.phase !== 'certified' && this.options.exactApprovals) {
      const cp = this.effect(record);
      if (cp?.phase === 'awaiting-approval' && ['awaiting-approval', 'paused'].includes(job.state)) {
        if (!this.currentTask(record)) job = scheduler.command(job.id, 'cancel');
        else if (Date.now() >= cp.approval!.expiresAt || cp.desired === 'run' && this.answer(record, cp.approval!))
          job = scheduler.command(job.id, 'resume');
      }
    }
    if (record.phase === 'certified' || !terminal.has(job.state)) return this.read(taskId);
    const certificate = certifyAstraCreateTask(this.certificationInput(record)), certificateDigest = astraCreateValueDigest(certificate);
    const certificateId = this.certificateId(taskId), messageId = this.messageId(taskId);
    const message: AstraCreateTaskMessage = { schemaVersion: 'monarch.astra-v3-create-task-message.internal.v1', id: messageId, taskId,
      interactionId: record.goal.source.interactionId, predecessorMessageId: this.predecessor(record),
      certificateDigest, content: renderAstraCreateTaskCertificate(certificate), delivery: 'pending' };
    const before = this.options.journal.read(taskId)!;
    this.options.journal.appendAtomic({ primary: { streamId: taskId, requestId: 'certify_' + taskId, expectedRevision: before.revision,
      reservationId: record.reservationId,
      checkpoint: json({ ...record, phase: 'certified', certificateDigest, certificateRef: certificateId, messageRef: messageId }),
      events: [{ type: 'task.certified-internal-create-profile', certificateDigest, status: certificate.status, effect: certificate.effect }] },
      additional: [
        { streamId: certificateId, requestId: 'certificate_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
          checkpoint: json(certificate), events: [{ type: 'certificate.persisted', goalDigest: record.goalDigest, certificateDigest }] },
        { streamId: messageId, requestId: 'message_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
          checkpoint: json(message), events: [{ type: 'message.queued', certificateDigest, predecessorMessageId: message.predecessorMessageId }] },
      ], ...(this.options.exactApprovals && this.options.journal.reservation('approval_source_' + taskId)
        ? { release: ['approval_source_' + taskId] } : {}),
    }, () => scheduler.ownerIsCurrent());
    return this.read(taskId);
  }

  read(taskId: string): AstraCreateTaskView {
    const record = this.record(taskId), job = this.host().job(record.jobId);
    const base = { taskId, jobId: job.id, source: structuredClone(record.goal.source), goalDigest: record.goalDigest, nativeCompletionCertified: false as const };
    if (record.phase !== 'certified') {
      const cp = this.options.exactApprovals ? this.effect(record) : undefined;
      const work = (job.input as unknown as { create: AstraCreateWorkInput }).create;
      return { ...base, status: terminal.has(job.state) ? 'awaiting-certification' : job.state,
        ...(cp?.phase === 'awaiting-approval' && cp.approval && !this.answer(record, cp.approval) ? { approval: { ...cp.approval,
          basename: work.basename, content: work.content, bytes: Buffer.byteLength(work.content), contentDigest: record.goal.requirement.contentDigest,
          overwrite: false as const, grantScope: 'once' as const, nativeCompletionCertified: false as const } } : {}) };
    }
    const certificate = this.options.journal.read(this.certificateId(taskId))?.checkpoint as unknown as AstraCreateTaskCertificate;
    check(certificate && record.certificateRef === this.certificateId(taskId) && record.certificateDigest === astraCreateValueDigest(certificate), 'certificate-integrity');
    check(record.certificateDigest === astraCreateValueDigest(certifyAstraCreateTask(this.certificationInput(record))), 'certificate-frontier');
    const message = this.options.journal.read(this.messageId(taskId))?.checkpoint as unknown as AstraCreateTaskMessage;
    check(message && record.messageRef === this.messageId(taskId) && message.id === record.messageRef && message.taskId === taskId
      && message.schemaVersion === 'monarch.astra-v3-create-task-message.internal.v1' && message.predecessorMessageId === this.predecessor(record)
      && message.interactionId === record.goal.source.interactionId
      && message.certificateDigest === record.certificateDigest && message.content === renderAstraCreateTaskCertificate(certificate)
      && ['pending', 'acknowledged'].includes(message.delivery), 'message-binding');
    return { ...base, status: certificate.status, certificate, message };
  }

  acknowledgeMessage(taskId: string, certificateDigest: string): AstraCreateTaskView {
    const scheduler = this.host(); check(scheduler.ownerIsCurrent(), 'owner-required');
    const record = this.record(taskId), view = this.read(taskId), message = view.message;
    check(message && record.certificateDigest === certificateDigest, 'message-ack-binding');
    if (message.delivery === 'acknowledged') return view;
    const before = this.options.journal.read(message.id)!;
    this.options.journal.appendAtomic({ primary: { streamId: message.id, requestId: 'ack_' + taskId, expectedRevision: before.revision,
      reservationId: record.reservationId, checkpoint: json({ ...message, delivery: 'acknowledged' }),
      events: [{ type: 'message.acknowledged', certificateDigest }] }, release: [record.reservationId] }, () => scheduler.ownerIsCurrent());
    return this.read(taskId);
  }

  private currentInput(input: AstraCreateWorkInput): boolean {
    try {
      const source = { interactionId: input.source.interactionId, messageId: input.source.messageId }, selected = this.options.admission.resolve(source);
      return this.options.admission.isCurrent({ ...source, revision: selected.revision, digest: selected.digest }) === true
        && input.source.revision === selected.revision && astraCreateSelectionDigest(input) === astraCreateSelectionDigest(astraCreateSelectedInput(source, selected));
    } catch { return false; }
  }
  private currentTask(record: AstraCreateTaskRecord): boolean {
    try {
      const selected = this.options.admission.resolve({ interactionId: record.goal.source.interactionId, messageId: record.goal.source.messageId });
      return this.options.admission.isCurrent(record.goal.source) === true && selected.digest === record.goal.source.digest
        && selected.revision === record.goal.source.revision
        && astraCreateSelectionDigest(astraCreateSelectedInput(record.goal.source, selected)) === record.goal.selectionDigest;
    } catch { return false; }
  }
  private record(taskId: string): AstraCreateTaskRecord {
    check(id(taskId), 'task-identity');
    const record = this.prepared.get(taskId) ?? this.options.journal.read(taskId)?.checkpoint as unknown as AstraCreateTaskRecord | undefined;
    check(record && record.schemaVersion === 'monarch.astra-v3-create-task.internal.v1' && record.taskId === taskId
      && record.jobId === astraWorkJobId(taskId) && record.goal.taskId === taskId && record.goal.requestDigest === record.requestDigest
      && record.goal.schedulerScopeId === this.options.scopeId && record.goal.canonicalRoot === this.root
      && (record.goal.adapterId ?? 'admitted-workspace-create') === this.adapter.id
      && (record.goal.adapterVersion ?? 'v1') === this.adapter.version
      && record.reservationId === this.budgetId(taskId) && ['admitted', 'certified'].includes(record.phase), 'task-binding');
    validateAstraCreateTaskGoal(record.goal, record.goalDigest); return record;
  }
  private certificationInput(record: AstraCreateTaskRecord): AstraCreateCertificationInput {
    const job = this.host().job(record.jobId);
    return { goal: record.goal, goalDigest: record.goalDigest, job,
      effect: this.options.journal.read(astraCreateWorkId(this.options.scopeId, job.id)),
      ...(this.options.exactApprovals ? { approvalAnswer: this.options.journal.read(createApprovalAnswerId(record.taskId)) } : {}) };
  }
  private effect(record: AstraCreateTaskRecord) {
    if (!this.options.journal.read(astraCreateWorkId(this.options.scopeId, record.jobId))) return undefined;
    return this.delegate.inspect((this.host().job(record.jobId).input as { create: AstraJson }).create).checkpoint;
  }
  private answer(record: AstraCreateTaskRecord, challenge: AstraCreateApproval): AstraCreateApprovalAnswer | undefined {
    const stored = this.options.journal.read(createApprovalAnswerId(record.taskId)); if (!stored) return undefined;
    check(stored.revision === 1, 'approval-answer-revision');
    const answer = stored.checkpoint as unknown as AstraCreateApprovalAnswer;
    validateCreateApprovalAnswer(answer, record.taskId, record.goalDigest, challenge); return answer;
  }
  private predecessor(record: AstraCreateTaskRecord): string {
    const approval = this.options.exactApprovals ? this.effect(record)?.approval : undefined;
    return (approval && this.answer(record, approval)?.decision.messageId) || record.goal.source.messageId;
  }
  private host(): AstraWorkScheduler { check(this.scheduler, 'scheduler-not-attached'); return this.scheduler; }
  private budgetId(taskId: string): string { return 'task_budget_' + astraCreateValueDigest(taskId).slice(7, 39); }
  private certificateId(taskId: string): string { return 'certificate_' + taskId; }
  private messageId(taskId: string): string { return 'message_' + taskId; }
}

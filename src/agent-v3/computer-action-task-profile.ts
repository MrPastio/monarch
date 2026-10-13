import { AstraJournal, astraJournalJson, type AstraJson } from './journal';
import { synchronizeEach, type AstraTaskFaultPolicy } from './task-fault';
import type { MonarchKernel } from '../core/kernel';
import { AstraComputerActionWorkAdapter, type AstraComputerAction, type AstraComputerActionDecision,
  type AstraComputerActionInput } from './computer-action-work-adapter';
import type { AstraComputerObservation, AstraComputerWindowSelection } from './computer-observe-work-adapter';
import { AstraWorkScheduler, astraWorkJobId, type AstraWorkAdapter, type AstraWorkJob } from './work-scheduler';
import { prepareAstraTaskSourceAdmission, type AstraTaskSourceAdmission } from './task-source-admission';
import { modelReadDigest as digest, modelReadIdentity as id, modelReadJson as json } from './model-read-task-state';
import type { AstraReadSourceKey } from './read-task-certifier';
import type { AstraCreateApprovalDecision } from './create-approval';

export interface AstraComputerActionTaskSelection {
  revision: number; digest: string; timeoutMs: number; selection: AstraComputerWindowSelection;
  observation: AstraComputerObservation; action: AstraComputerAction;
}
interface Goal { taskId: string; scopeId: string; requestDigest: string; source: AstraReadSourceKey;
  selected: AstraComputerActionTaskSelection; observationAuthorizesInput: false; requiresExactApproval: true }
interface Proof { schemaVersion: 'monarch.astra-v3-computer-action-task-proof.internal.v1'; taskId: string;
  goalDigest: string; jobDigest: string; status: AstraWorkJob['state']; effect: 'not-applied' | 'unknown' | 'applied';
  evidence: { streamId: string; revision: number; commitHash: string } | null;
  nativeCompletionCertified: false; businessCompletionCertified: false }
interface Record { schemaVersion: 'monarch.astra-v3-computer-action-task.internal.v1'; taskId: string; jobId: string;
  requestDigest: string; goal: Goal; goalDigest: string; reservationId: string; proof?: Proof }
interface Message { id: string; taskId: string; predecessorMessageId: string; certificateDigest: string;
  content: string; delivery: 'pending' | 'acknowledged' }
export interface AstraComputerActionTaskView {
  taskId: string; jobId: string; status: AstraWorkJob['state'] | 'awaiting-certification'; computerJobs: 1;
  nativeCompletionCertified: false; approval?: ReturnType<AstraComputerActionWorkAdapter['approvalCard']>;
  proof?: Proof; message?: Message;
}
const terminal = new Set(['observed', 'failed', 'cancelled', 'blocked']);
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-computer-action-task:' + code); }
export const astraComputerActionTaskId = (scopeId: string, requestId: string): string =>
  'computer_action_task_' + digest([scopeId, requestId]).slice(7, 39);

/** Source-authenticated task owner around one dynamically bound effect adapter.
 * It introduces no executor: all effects still cross the external scheduler,
 * Kernel policy, Action Ledger and Computer module. */
export class AstraComputerActionTaskProfile {
  readonly adapter: AstraWorkAdapter;
  private scheduler: AstraWorkScheduler | undefined;
  private readonly pending = new Map<string, Record>();
  private readonly delegates = new Map<string, { goalDigest: string; adapter: AstraComputerActionWorkAdapter }>();
  constructor(private readonly options: { deployment: 'isolated-validation'; scopeId: string; kernel: MonarchKernel; journal: AstraJournal;
    admission: { resolve(source: AstraReadSourceKey): AstraComputerActionTaskSelection;
      isCurrent(source: AstraReadSourceKey, selected: AstraComputerActionTaskSelection): boolean } }) {
    check(options.deployment === 'isolated-validation' && id(options.scopeId), 'deployment');
    const unpack = (raw: AstraJson) => { check(raw && typeof raw === 'object' && !Array.isArray(raw) && id(raw.taskId as string)
      && Object.keys(raw).every(k => k === 'taskId' || k === 'action'), 'work-input'); return raw as { taskId: string; action?: AstraJson }; };
    const required = (raw: AstraJson) => { const input = unpack(raw); check(input.action, 'compiled-input');
      const record = this.record(input.taskId); return { ...input, action: input.action, delegate: this.delegate(record) }; };
    this.adapter = { id: 'admitted-computer-action', version: 'v1',
      compile: (raw, context) => { const input = unpack(raw), record = this.record(input.taskId), selected = record.goal.selected;
        const compiled = this.delegate(record).compile({ action: selected.action, timeoutMs: selected.timeoutMs }, context);
        if (input.action) check(digest(input.action) === digest(compiled.input), 'work-substitution');
        return { ...compiled, input: { taskId: record.taskId, action: compiled.input },
          bindingDigest: digest([record.goalDigest, compiled.bindingDigest]) }; },
      execute: (raw, control) => { const input = required(raw); return input.delegate.execute(input.action, control); },
      control: (raw, command, owner, journal) => { const input = required(raw); return input.delegate.control(input.action, command, owner, journal); },
      reconcile: (raw, owner, journal) => { const input = required(raw); return input.delegate.reconcile(input.action, owner, journal); },
    };
  }
  attach(scheduler: AstraWorkScheduler): this {
    check((!this.scheduler || this.scheduler === scheduler) && scheduler.isHostFor(this.adapter, this.options.scopeId, this.options.journal), 'scheduler-binding');
    this.scheduler = scheduler; return this;
  }
  private host(): AstraWorkScheduler { check(this.scheduler, 'scheduler-required'); return this.scheduler; }
  submit(request: { requestId: string; source: AstraReadSourceKey }, admission?: AstraTaskSourceAdmission): AstraComputerActionTaskView {
    const scheduler = this.host(); check(scheduler.ownerIsCurrent(), 'owner-required');
    check(request && Object.keys(request).length === 2 && id(request.requestId) && id(request.source?.interactionId)
      && id(request.source?.messageId), 'request');
    const taskId = astraComputerActionTaskId(this.options.scopeId, request.requestId), requestDigest = digest(request);
    if (this.options.journal.read(taskId)) { check(this.record(taskId).requestDigest === requestDigest, 'request-conflict'); return this.read(taskId); }
    const selected = structuredClone(this.options.admission.resolve(structuredClone(request.source)));
    check(Number.isSafeInteger(selected.revision) && selected.revision > 0 && /^sha256:[a-f0-9]{64}$/u.test(selected.digest)
      && Number.isSafeInteger(selected.timeoutMs) && selected.timeoutMs >= 50 && selected.timeoutMs <= 10000
      && selected.selection.source.inputMessageId === request.source.messageId, 'selection');
    const goal: Goal = { taskId, scopeId: this.options.scopeId, requestDigest, source: structuredClone(request.source), selected,
      observationAuthorizesInput: false, requiresExactApproval: true };
    const record: Record = { schemaVersion: 'monarch.astra-v3-computer-action-task.internal.v1', taskId, jobId: astraWorkJobId(taskId),
      requestDigest, goal, goalDigest: digest(goal), reservationId: 'budget_' + taskId };
    const messageId = this.messageId(taskId), source = prepareAstraTaskSourceAdmission(admission, taskId, record.reservationId, [taskId, messageId]);
    this.pending.set(taskId, record);
    try { scheduler.submit({ requestId: taskId, adapterId: this.adapter.id, input: { taskId } }, { reservations: [{ id: record.reservationId,
      allocations: [{ streamId: taskId, commits: 2, eventBytes: 4096, checkpointBytes: Buffer.byteLength(astraJournalJson(json(record))) + 2048 },
        { streamId: messageId, commits: 2, eventBytes: 4096, checkpointBytes: 4096 }, ...source.allocations] }],
      commits: [{ streamId: taskId, requestId: 'admit_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
        checkpoint: json(record), events: [{ type: 'computer-action-task.admitted', goalDigest: record.goalDigest }] }, ...source.commits] });
    } finally { this.pending.delete(taskId); }
    return this.read(taskId);
  }
  list(): AstraComputerActionTaskView[] { return this.host().list().filter(job => job.adapterId === this.adapter.id)
    .map(job => this.read((job.input as { taskId: string }).taskId)); }
  synchronizeAll(policy?: AstraTaskFaultPolicy): AstraComputerActionTaskView[] {
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
  command(taskId: string, command: 'pause' | 'resume' | 'cancel'): AstraComputerActionTaskView {
    this.host().command(this.record(taskId).jobId, command); return this.synchronize(taskId);
  }
  reconcile(taskId: string): AstraComputerActionTaskView { this.host().reconcile(this.record(taskId).jobId); return this.synchronize(taskId); }
  decide(taskId: string, decision: AstraCreateApprovalDecision, admission?: AstraTaskSourceAdmission): AstraComputerActionTaskView {
    const scheduler = this.host(); check(scheduler.ownerIsCurrent(), 'owner-required');
    check(decision && Object.keys(decision).length === 4 && id(decision.approvalId) && /^sha256:[a-f0-9]{64}$/u.test(decision.approvalDigest)
      && id(decision.messageId) && ['approve', 'reject'].includes(decision.decision), 'decision');
    const record = this.record(taskId), messageRef = 'computer_action_answer_' + taskId;
    const fact = { taskId, goalDigest: record.goalDigest, decision: structuredClone(decision) }, existing = this.options.journal.read(messageRef);
    const job = scheduler.job(record.jobId), packed = job.input as { taskId: string; action: AstraJson };
    check(packed.taskId === taskId, 'approval-unavailable'); const delegate = this.delegate(record);
    if (existing) {
      check(digest(existing.checkpoint) === digest(fact), 'approval-conflict');
      const cp = delegate.inspect(packed.action).checkpoint; check(cp.approval, 'approval-unavailable');
      const exact: AstraComputerActionDecision = { ...decision, reviewedInputDigest: cp.inputDigest,
        conversationId: record.goal.selected.selection.source.conversationId, predecessorMessageId: record.goal.source.messageId };
      // Completes a safe crash gap after source binding but before the adapter's
      // answer CAS. If already answered, adapter.answer is an exact no-op.
      delegate.answer(packed.action, exact, () => scheduler.ownerIsCurrent(),
        this.options.journal.scoped(job.reservationId, () => scheduler.ownerIsCurrent()));
      return this.synchronize(taskId);
    }
    check(['awaiting-approval', 'paused'].includes(job.state), 'approval-unavailable');
    const card = delegate.approvalCard(packed.action); check(card, 'approval-unavailable');
    check(decision.approvalId === card.id && decision.approvalDigest === card.digest
      && decision.messageId !== record.goal.source.messageId
      && (decision.decision === 'reject' || this.current(record) && Date.now() < card.expiresAt), 'approval-unavailable');
    const source = prepareAstraTaskSourceAdmission(admission, taskId, 'approval_source_' + taskId, [messageRef]);
    // Authenticated message claim is durable before answer. A crash in-between is
    // safe: retry finds the same claim; no action has been armed yet.
    this.options.journal.appendAtomic({ primary: { streamId: messageRef, requestId: 'answer_' + taskId, expectedRevision: 0,
      reservationId: 'approval_source_' + taskId, checkpoint: json(fact),
      events: [{ type: 'computer-action.approval-source-bound', decision: decision.decision }] },
      ...(source.allocations.length ? { reserve: [{ id: 'approval_source_' + taskId, allocations: [{ streamId: messageRef, commits: 1,
        eventBytes: 4096, checkpointBytes: 32768 }, ...source.allocations] }], additional: source.commits } : {
        reserve: [{ id: 'approval_source_' + taskId, allocations: [{ streamId: messageRef, commits: 1, eventBytes: 4096, checkpointBytes: 32768 }] }] })
    }, () => scheduler.ownerIsCurrent());
    const exact: AstraComputerActionDecision = { ...decision, reviewedInputDigest: card.inputDigest,
      conversationId: record.goal.selected.selection.source.conversationId,
      predecessorMessageId: record.goal.source.messageId };
    delegate.answer(packed.action, exact, () => scheduler.ownerIsCurrent(), this.options.journal.scoped(job.reservationId, () => scheduler.ownerIsCurrent()));
    return this.synchronize(taskId);
  }
  synchronize(taskId: string): AstraComputerActionTaskView {
    const scheduler = this.host(); check(scheduler.ownerIsCurrent(), 'owner-required'); const record = this.record(taskId); let job = scheduler.job(record.jobId);
    if (!record.proof && ['awaiting-approval', 'paused'].includes(job.state)) {
      const packed = job.input as { action: AstraJson }, inspected = this.delegate(record).inspect(packed.action).checkpoint;
      if (!this.current(record)) job = scheduler.command(job.id, 'cancel');
      else if (inspected.phase === 'awaiting-approval' && (Date.now() >= inspected.approval!.expiresAt || inspected.answer))
        job = scheduler.command(job.id, 'resume');
    }
    if (record.proof || !terminal.has(job.state)) return this.read(taskId);
    const proof = this.proof(record), message: Message = { id: this.messageId(taskId), taskId,
      predecessorMessageId: record.goal.source.messageId, certificateDigest: digest(proof), content: this.render(proof), delivery: 'pending' };
    const before = this.options.journal.read(taskId)!;
    this.options.journal.appendAtomic({ primary: { streamId: taskId, requestId: 'settle_' + taskId, expectedRevision: before.revision,
      reservationId: record.reservationId, checkpoint: json({ ...record, proof }), events: [{ type: 'computer-action-task.proof-retained', digest: digest(proof) }] },
      additional: [{ streamId: message.id, requestId: 'deliver_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
        checkpoint: json(message), events: [{ type: 'message.queued', predecessorMessageId: message.predecessorMessageId }] }],
      ...(this.options.journal.reservation('approval_source_' + taskId) ? { release: ['approval_source_' + taskId] } : {}) }, () => scheduler.ownerIsCurrent());
    return this.read(taskId);
  }
  read(taskId: string): AstraComputerActionTaskView {
    const record = this.record(taskId), job = this.host().job(record.jobId), base = { taskId, jobId: job.id, computerJobs: 1 as const,
      nativeCompletionCertified: false as const };
    if (!record.proof) { const packed = job.input as { action: AstraJson };
      return { ...base, status: terminal.has(job.state) ? 'awaiting-certification' : job.state,
        ...(this.delegate(record).approvalCard(packed.action) ? { approval: this.delegate(record).approvalCard(packed.action) } : {}) }; }
    check(digest(this.proof(record)) === digest(record.proof), 'proof-frontier');
    const message = this.options.journal.read(this.messageId(taskId))?.checkpoint as unknown as Message;
    check(message && message.taskId === taskId && message.predecessorMessageId === record.goal.source.messageId
      && message.certificateDigest === digest(record.proof) && message.content === this.render(record.proof)
      && ['pending', 'acknowledged'].includes(message.delivery), 'message-binding');
    return { ...base, status: record.proof.status, proof: record.proof, message };
  }
  acknowledgeMessage(taskId: string, certificateDigest: string): AstraComputerActionTaskView {
    const record = this.record(taskId), view = this.read(taskId), message = view.message;
    check(this.host().ownerIsCurrent() && message?.certificateDigest === certificateDigest, 'message-ack-binding');
    if (message.delivery === 'acknowledged') return view;
    this.options.journal.appendAtomic({ primary: { streamId: message.id, requestId: 'ack_' + taskId,
      expectedRevision: this.options.journal.read(message.id)!.revision, reservationId: record.reservationId,
      checkpoint: json({ ...message, delivery: 'acknowledged' }), events: [{ type: 'message.acknowledged', certificateDigest }] },
      release: [record.reservationId] }, () => this.host().ownerIsCurrent()); return this.read(taskId);
  }
  private record(taskId: string): Record {
    check(id(taskId), 'task-id'); const record = this.pending.get(taskId) ?? this.options.journal.read(taskId)?.checkpoint as unknown as Record;
    check(record?.schemaVersion === 'monarch.astra-v3-computer-action-task.internal.v1' && record.taskId === taskId
      && record.jobId === astraWorkJobId(taskId) && record.reservationId === 'budget_' + taskId && record.goal.taskId === taskId
      && record.goal.scopeId === this.options.scopeId && record.goal.requestDigest === record.requestDigest
      && record.goal.observationAuthorizesInput === false && record.goal.requiresExactApproval === true
      && digest(record.goal) === record.goalDigest, 'task-binding'); return record;
  }
  private delegate(record: Record): AstraComputerActionWorkAdapter {
    const prior = this.delegates.get(record.taskId); if (prior) { check(prior.goalDigest === record.goalDigest, 'delegate-binding'); return prior.adapter; }
    check(this.delegates.size < 128, 'delegate-budget'); const selected = record.goal.selected;
    const adapter = new AstraComputerActionWorkAdapter({ ...this.options, selection: selected.selection, observation: selected.observation,
      isSourceCurrent: input => digest(input.action) === digest(selected.action) && this.current(record) });
    this.delegates.set(record.taskId, { goalDigest: record.goalDigest, adapter }); return adapter;
  }
  private current(record: Record): boolean { try { return this.options.admission.isCurrent(structuredClone(record.goal.source), structuredClone(record.goal.selected)); } catch { return false; } }
  private proof(record: Record): Proof {
    const job = this.host().job(record.jobId), packed = job.input as unknown as { taskId: string; action: AstraComputerActionInput & { workId: string } };
    check(terminal.has(job.state) && job.adapterId === this.adapter.id && packed.taskId === record.taskId, 'job-binding');
    const snapshot = this.options.journal.read(packed.action.workId), cp = snapshot
      ? this.delegate(record).inspect(packed.action as unknown as AstraJson).checkpoint : undefined;
    if (snapshot) check(job.result?.checkpointRef === snapshot.streamId && job.result.checkpointRevision === snapshot.revision && cp?.quiescent, 'job-frontier');
    else check(job.state !== 'observed' && !job.result, 'missing-evidence');
    return { schemaVersion: 'monarch.astra-v3-computer-action-task-proof.internal.v1', taskId: record.taskId, goalDigest: record.goalDigest,
      jobDigest: digest(job), status: job.state, effect: cp?.effect ?? 'not-applied',
      evidence: snapshot ? { streamId: snapshot.streamId, revision: snapshot.revision, commitHash: snapshot.commitHash } : null,
      nativeCompletionCertified: false, businessCompletionCertified: false };
  }
  private render(proof: Proof): string { return proof.status === 'observed'
    ? 'Одно подтверждённое действие отправлено и проверено нативным исполнителем. Выполнение общей задачи этим не сертифицировано.'
    : proof.status === 'cancelled' ? 'Действие отменено. Успешный ввод не заявлен.'
      : 'Действие не подтверждено. Автоматический повтор не выполнялся.'; }
  private messageId(taskId: string): string { return 'message_' + taskId; }
}

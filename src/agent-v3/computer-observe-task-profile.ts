import { AstraJournal, astraJournalJson, type AstraJson } from './journal';
import { synchronizeEach, type AstraTaskFaultPolicy } from './task-fault';
import type { MonarchKernel } from '../core/kernel';
import { AstraComputerObserveWorkAdapter, type AstraComputerWindowSelection, type AstraComputerObservation } from './computer-observe-work-adapter';
import { AstraWorkScheduler, astraWorkJobId, type AstraWorkAdapter, type AstraWorkJob } from './work-scheduler';
import { prepareAstraTaskSourceAdmission, type AstraTaskSourceAdmission } from './task-source-admission';
import { modelReadDigest as digest, modelReadIdentity as id, modelReadJson as json } from './model-read-task-state';
import type { AstraReadSourceKey } from './read-task-certifier';

export interface AstraComputerTaskSelection {
  revision: number; digest: string; selection: AstraComputerWindowSelection; timeoutMs: number;
}
interface Goal {
  taskId: string; scopeId: string; requestDigest: string;
  source: AstraReadSourceKey; selected: AstraComputerTaskSelection;
  authority: 'observe'; authorizesInput: false;
}
interface Proof {
  schemaVersion: 'monarch.astra-v3-computer-task-proof.internal.v1';
  taskId: string; goalDigest: string; jobDigest: string; status: AstraWorkJob['state'];
  evidence: { streamId: string; revision: number; commitHash: string } | null;
  nativeCompletionCertified: false; authorizesInput: false;
}
interface Record {
  schemaVersion: 'monarch.astra-v3-computer-task.internal.v1'; taskId: string; jobId: string;
  requestDigest: string; goal: Goal; goalDigest: string; reservationId: string; proof?: Proof;
}
interface Message {
  id: string; taskId: string; predecessorMessageId: string; certificateDigest: string;
  content: string; delivery: 'pending' | 'acknowledged';
}
export interface AstraComputerTaskView {
  taskId: string; jobId: string; status: AstraWorkJob['state'] | 'awaiting-certification';
  nativeCompletionCertified: false; computerJobs: number; message?: Message; observation?: AstraComputerObservation;
}
export interface AstraComputerTaskProfileOptions {
  deployment: 'isolated-validation'; scopeId: string; kernel: MonarchKernel; journal: AstraJournal;
  admission: { resolve(source: AstraReadSourceKey): AstraComputerTaskSelection;
    isCurrent(source: AstraReadSourceKey, selected: AstraComputerTaskSelection): boolean };
}
const terminal = new Set(['observed', 'failed', 'cancelled', 'blocked']);
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-computer-task:' + code); }
export const astraComputerTaskId = (scopeId: string, requestId: string): string => 'computer_task_' + digest([scopeId, requestId]).slice(7, 39);

/** Source-bound observation family on the existing external scheduler. No second
 * owner, target discovery, model decision, input permission or product bootstrap.
 * Internal proof certifies a retained historical observation, not task prose. */
export class AstraComputerObserveTaskProfile {
  readonly adapter: AstraWorkAdapter;
  private scheduler: AstraWorkScheduler | undefined;
  private readonly pending = new Map<string, Record>();
  private readonly delegates = new Map<string, { goalDigest: string; adapter: AstraComputerObserveWorkAdapter }>();
  constructor(private readonly options: AstraComputerTaskProfileOptions) {
    check(options.deployment === 'isolated-validation' && id(options.scopeId), 'deployment');
    const unpack = (raw: AstraJson) => {
      check(raw && typeof raw === 'object' && !Array.isArray(raw) && id(raw.taskId as string)
        && Object.keys(raw).every(key => key === 'taskId' || key === 'observe'), 'work-input');
      return raw as { taskId: string; observe?: AstraJson };
    };
    const required = (raw: AstraJson) => { const input = unpack(raw); check(input.observe, 'compiled-input');
      return { ...input, observe: input.observe, delegate: this.delegate(this.record(input.taskId)) }; };
    this.adapter = { id: 'admitted-computer-observe', version: 'v1',
      compile: (raw, context) => {
        const input = unpack(raw), record = this.record(input.taskId), selected = record.goal.selected;
        const compiled = this.delegate(record).compile({ selectionId: selected.selection.id, timeoutMs: selected.timeoutMs }, context);
        if (input.observe) check(digest(input.observe) === digest(compiled.input), 'work-substitution');
        return { ...compiled, input: { taskId: record.taskId, observe: compiled.input },
          bindingDigest: digest([record.goalDigest, compiled.bindingDigest]) };
      },
      execute: (raw, control) => { const input = required(raw); return input.delegate.execute(input.observe, control); },
      control: (raw, command, owner, journal) => { const input = required(raw); return input.delegate.control(input.observe, command, owner, journal); },
      reconcile: (raw, owner, journal) => { const input = required(raw); return input.delegate.reconcile(input.observe, owner, journal); },
    };
  }
  attach(scheduler: AstraWorkScheduler): this {
    check((!this.scheduler || this.scheduler === scheduler) && scheduler.isHostFor(this.adapter, this.options.scopeId, this.options.journal), 'scheduler-binding');
    this.scheduler = scheduler; return this;
  }
  private host(): AstraWorkScheduler { check(this.scheduler, 'scheduler-required'); return this.scheduler; }
  submit(request: { requestId: string; source: AstraReadSourceKey }, admission?: AstraTaskSourceAdmission): AstraComputerTaskView {
    check(this.host().ownerIsCurrent(), 'owner-required');
    check(request && Object.keys(request).length === 2 && id(request.requestId) && request.source
      && Object.keys(request.source).length === 2 && id(request.source.interactionId) && id(request.source.messageId), 'request');
    const taskId = astraComputerTaskId(this.options.scopeId, request.requestId), requestDigest = digest(request);
    if (this.options.journal.read(taskId)) { check(this.record(taskId).requestDigest === requestDigest, 'request-conflict'); return this.read(taskId); }
    const selected = structuredClone(this.options.admission.resolve(structuredClone(request.source)));
    check(Number.isSafeInteger(selected.revision) && selected.revision > 0 && /^sha256:[a-f0-9]{64}$/u.test(selected.digest)
      && Number.isSafeInteger(selected.timeoutMs) && selected.timeoutMs >= 50 && selected.timeoutMs <= 10000
      && selected.selection.source.inputMessageId === request.source.messageId, 'selection');
    const goal: Goal = { taskId, scopeId: this.options.scopeId, requestDigest, source: structuredClone(request.source), selected,
      authority: 'observe', authorizesInput: false };
    const record: Record = { schemaVersion: 'monarch.astra-v3-computer-task.internal.v1', taskId, jobId: astraWorkJobId(taskId),
      requestDigest, goal, goalDigest: digest(goal), reservationId: 'budget_' + taskId };
    const messageId = this.messageId(taskId), source = prepareAstraTaskSourceAdmission(admission, taskId, record.reservationId, [taskId, messageId]);
    this.pending.set(taskId, record);
    try {
      this.host().submit({ requestId: taskId, adapterId: this.adapter.id, input: { taskId } }, {
        reservations: [{ id: record.reservationId, allocations: [
          { streamId: taskId, commits: 2, eventBytes: 4096, checkpointBytes: Buffer.byteLength(astraJournalJson(json(record))) + 2048 },
          { streamId: messageId, commits: 2, eventBytes: 4096, checkpointBytes: 4096 }, ...source.allocations] }],
        commits: [{ streamId: taskId, requestId: 'admit_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
          checkpoint: json(record), events: [{ type: 'computer-task.admitted', goalDigest: record.goalDigest }] }, ...source.commits],
      });
    } catch (error) { if (!this.options.journal.read(taskId)) this.delegates.delete(taskId); throw error; }
    finally { this.pending.delete(taskId); }
    return this.read(taskId);
  }
  list(): AstraComputerTaskView[] { return this.host().list().filter(job => job.adapterId === this.adapter.id)
    .map(job => this.read((job.input as { taskId: string }).taskId)); }
  synchronizeAll(policy?: AstraTaskFaultPolicy): AstraComputerTaskView[] {
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
  command(taskId: string, command: 'pause' | 'resume' | 'cancel'): AstraComputerTaskView {
    this.host().command(this.record(taskId).jobId, command); return this.synchronize(taskId);
  }
  reconcile(taskId: string): AstraComputerTaskView { this.host().reconcile(this.record(taskId).jobId); return this.synchronize(taskId); }
  synchronize(taskId: string): AstraComputerTaskView {
    check(this.host().ownerIsCurrent(), 'owner-required');
    const record = this.record(taskId), job = this.host().job(record.jobId);
    if (record.proof || !terminal.has(job.state)) return this.read(taskId);
    const proof = this.proof(record), message: Message = { id: this.messageId(taskId), taskId,
      predecessorMessageId: record.goal.source.messageId, certificateDigest: digest(proof), content: this.render(proof), delivery: 'pending' };
    const before = this.options.journal.read(taskId)!;
    this.options.journal.appendAtomic({ primary: { streamId: taskId, requestId: 'settle_' + taskId, expectedRevision: before.revision,
      reservationId: record.reservationId, checkpoint: json({ ...record, proof }), events: [{ type: 'computer-task.proof-retained', digest: digest(proof) }] },
      additional: [{ streamId: message.id, requestId: 'deliver_' + taskId, expectedRevision: 0, reservationId: record.reservationId,
        checkpoint: json(message), events: [{ type: 'message.queued', predecessorMessageId: message.predecessorMessageId }] }] }, () => this.host().ownerIsCurrent());
    return this.read(taskId);
  }
  read(taskId: string): AstraComputerTaskView {
    const record = this.record(taskId), job = this.host().job(record.jobId);
    const base = { taskId, jobId: job.id, computerJobs: 1, nativeCompletionCertified: false as const };
    if (!record.proof) return { ...base, status: terminal.has(job.state) ? 'awaiting-certification' : job.state };
    check(digest(this.proof(record)) === digest(record.proof), 'proof-frontier');
    const message = this.options.journal.read(this.messageId(taskId))?.checkpoint as unknown as Message;
    check(message && message.id === this.messageId(taskId) && message.taskId === taskId
      && message.predecessorMessageId === record.goal.source.messageId && message.certificateDigest === digest(record.proof)
      && message.content === this.render(record.proof) && ['pending', 'acknowledged'].includes(message.delivery), 'message-binding');
    const observation = record.proof.status === 'observed' ? this.observed(record).checkpoint.observation : undefined;
    return { ...base, status: record.proof.status, message, ...(observation ? { observation } : {}) };
  }
  acknowledgeMessage(taskId: string, certificateDigest: string): AstraComputerTaskView {
    check(this.host().ownerIsCurrent(), 'owner-required'); const record = this.record(taskId), view = this.read(taskId), message = view.message;
    check(message && message.certificateDigest === certificateDigest, 'message-ack-binding');
    if (message.delivery === 'acknowledged') return view;
    this.options.journal.appendAtomic({ primary: { streamId: message.id, requestId: 'ack_' + taskId,
      expectedRevision: this.options.journal.read(message.id)!.revision, reservationId: record.reservationId,
      checkpoint: json({ ...message, delivery: 'acknowledged' }), events: [{ type: 'message.acknowledged', certificateDigest }] },
      release: [record.reservationId] }, () => this.host().ownerIsCurrent()); return this.read(taskId);
  }
  private record(taskId: string): Record {
    check(id(taskId), 'task-id'); const record = this.pending.get(taskId) ?? this.options.journal.read(taskId)?.checkpoint as unknown as Record;
    check(record?.schemaVersion === 'monarch.astra-v3-computer-task.internal.v1' && record.taskId === taskId
      && record.jobId === astraWorkJobId(taskId) && record.reservationId === 'budget_' + taskId
      && record.goal.taskId === taskId && record.goal.scopeId === this.options.scopeId && record.goal.requestDigest === record.requestDigest
      && record.goal.authority === 'observe' && record.goal.authorizesInput === false && digest(record.goal) === record.goalDigest, 'task-binding');
    return record;
  }
  private delegate(record: Record): AstraComputerObserveWorkAdapter {
    const prior = this.delegates.get(record.taskId);
    if (prior) { check(prior.goalDigest === record.goalDigest, 'delegate-binding'); return prior.adapter; }
    check(this.delegates.size < 128, 'delegate-budget');
    const adapter = new AstraComputerObserveWorkAdapter({ ...this.options, selection: record.goal.selected.selection,
      isSourceCurrent: () => this.options.admission.isCurrent(structuredClone(record.goal.source), structuredClone(record.goal.selected)) });
    this.delegates.set(record.taskId, { goalDigest: record.goalDigest, adapter }); return adapter;
  }
  private observed(record: Record) {
    const job = this.host().job(record.jobId); const input = job.input as { taskId: string; observe: AstraJson };
    check(input.taskId === record.taskId, 'job-task-binding'); return this.delegate(record).inspect(input.observe);
  }
  private proof(record: Record): Proof {
    const job = this.host().job(record.jobId), input = job.input as { taskId: string; observe: { workId: string } };
    check(terminal.has(job.state) && job.adapterId === this.adapter.id && job.adapterVersion === this.adapter.version
      && input.taskId === record.taskId && input.observe.workId === 'computer_observe_' + digest([this.options.scopeId, job.id]).slice(7, 39), 'job-binding');
    const snapshot = this.options.journal.read(input.observe.workId);
    if (snapshot) {
      const { checkpoint } = this.observed(record);
      check(checkpoint.quiescent && (job.state !== 'observed' || (checkpoint.phase === 'settled' && checkpoint.desired === 'run' && checkpoint.observation)), 'observation-proof');
      check(job.result?.checkpointRef === snapshot.streamId && job.result.checkpointRevision === snapshot.revision, 'job-frontier');
    } else check(job.state !== 'observed' && !job.result, 'missing-evidence');
    return { schemaVersion: 'monarch.astra-v3-computer-task-proof.internal.v1', taskId: record.taskId, goalDigest: record.goalDigest,
      jobDigest: digest(job), status: job.state, evidence: snapshot ? { streamId: snapshot.streamId, revision: snapshot.revision, commitHash: snapshot.commitHash } : null,
      nativeCompletionCertified: false, authorizesInput: false };
  }
  private render(proof: Proof): string {
    return proof.status === 'observed' ? 'Наблюдение выбранного окна сохранено. Это исторический снимок, не разрешение на ввод и не подтверждение выполнения действий.'
      : proof.status === 'cancelled' ? 'Наблюдение окна отменено. Успешный результат не заявлен.' : 'Наблюдение окна не подтверждено. Успешный результат не заявлен.';
  }
  private messageId(taskId: string): string { return 'message_' + taskId; }
}

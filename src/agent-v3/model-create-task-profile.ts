import path from 'node:path';
import { synchronizeEach, type AstraTaskFaultPolicy } from './task-fault';
import type { MonarchKernel } from '../core/kernel';
import { AstraJournal, type AstraJson, type AstraJournalCommit } from './journal';
import { AstraModelWorkAdapter, type AstraModelWorkInput, type AstraModelWorkCheckpoint } from './model-work-adapter';
import type { AstraPreparedModelClient } from './prepared-model-client';
import { AstraCreateTaskProfile, type AstraCreateTaskRecord } from './create-task-profile';
import { astraCreateWorkId } from './create-work-adapter';
import type { AstraCreateSourceKey, AstraCreateSelection } from './create-task-certifier';
import { AstraWorkScheduler, type AstraWorkAdapter } from './work-scheduler';
import { modelReadCheck as check, modelReadIdentity as id, modelReadDigest as digest, modelReadJson as json,
  modelReadSame as same, modelReadSettled as settled, type AstraModelReadPolicy } from './model-read-task-state';
import { modelReadEvidence } from './model-read-task-certifier';
import { inspectAstraDraftContent } from './draft-content-acceptance';
import { prepareAstraTaskSourceAdmission, type AstraTaskSourceAdmission } from './task-source-admission';
import { createApprovalAnswerId, validateCreateApprovalDecision, type AstraCreateApprovalDecision } from './create-approval';
import { certifyAstraModelCreateTask, inspectDraftModel, inspectRequiredDraftInput, inspectLiteralCreateInput, type AstraModelCreateProof } from './model-create-task-certifier';
import { AstraRequiredInputWorkAdapter, type AstraRequiredInputProof, type AstraRequiredInputQuestion } from './required-input-work';
import { AstraReadWorkAdapter } from './read-work-adapter';
import { AstraReadRuntime, astraReadRunId } from './read-runtime';
import { AstraReadWorkflow } from './read-workflow';
import { compileDraftReferenceGoal, draftReferenceTaskId, draftReferenceJobId, draftReferenceRequest,
  inspectDraftReferences, type AstraDraftReferenceProof } from './draft-reference-read';
import { draftTaskId, draftModelJobId, draftModelRequest, draftEffectTaskId, draftEffectRequest, draftModelInput, validateDraftGoal,
  renderDraftCertificate, type AstraModelCreateSelection, type AstraModelCreateRecord, type AstraModelCreateGoal,
  draftRound, draftPredecessor, draftQuestion, validateDraftReply, ASTRA_DRAFT_MAX_CLARIFICATIONS, type AstraDraftReply,
  draftInputRequest, draftInputJobId, draftRequiredInputWork, draftUsesLiteralInput, draftCreateOrigin, draftCreateSourceDigest,
  type AstraModelCreateView, type AstraModelCreateMessage } from './model-create-task-state';

export interface AstraModelCreateOptions {
  modelClients?: Readonly<Record<string, AstraPreparedModelClient>>;
  deployment: 'isolated-validation'; canonicalRoot: string; scopeId: string; journal: AstraJournal; kernel: MonarchKernel;
  client: AstraPreparedModelClient; policy: Pick<AstraModelReadPolicy, 'expectedModelDigest'> & Partial<Omit<AstraModelReadPolicy, 'expectedModelDigest'>>;
  /** Optional host-owned policy selection. The callback receives only the already
   * admitted source key; the returned policy is normalized and retained in Goal. */
  policyForSource?: (source: AstraCreateSourceKey) => Pick<AstraModelReadPolicy, 'expectedModelDigest'>
    & Partial<Omit<AstraModelReadPolicy, 'expectedModelDigest'>>;
  admission: { resolve(source: AstraCreateSourceKey): AstraModelCreateSelection; isCurrent(source: AstraCreateSourceKey): boolean };
  /** New explicitly assembled host cohort; never silently changes an old scheduler config. */
  requiredInputs?: boolean;
  exactApprovals?: boolean;
  referenceInputs?: boolean;
}

/** One parent Goal: prepared draft proposal OR source-bound literal input -> existing exclusive-create child
 * on the same scheduler. Child admission and parent link have one commit point.
 * Model bytes remain data; host source supplies target/limits/original user text,
 * Kernel supplies policy/approval/dispatch, pure family proofs supply completion.
 * No default runtime, implicit approval, overwrite, model retry loop or second queue. */
export class AstraModelCreateTaskProfile {
  readonly adapters: AstraWorkAdapter[];
  private scheduler: AstraWorkScheduler | undefined;
  private readonly models: AstraModelWorkAdapter;
  private readonly creates: AstraCreateTaskProfile;
  private readonly inputs: AstraRequiredInputWorkAdapter | undefined;
  private readonly references: AstraWorkAdapter | undefined;
  private readonly prepared = new Map<string, AstraModelCreateRecord>();
  private draining: Promise<AstraModelCreateView[]> | undefined;
  private readonly policy: AstraModelReadPolicy;

  constructor(private readonly options: AstraModelCreateOptions) {
    check(options.deployment === 'isolated-validation' && id(options.scopeId) && path.isAbsolute(options.canonicalRoot), 'draft-deployment');
    this.policy = normalizeModelPolicy(options.policy);
    this.models = new AstraModelWorkAdapter({ ...options, decisionFamily: 'create', isSourceCurrent: input => this.modelCurrent(input) });
    this.inputs = options.requiredInputs ? new AstraRequiredInputWorkAdapter({ journal: options.journal, isCurrent: input => {
      try { const record = this.record(input.taskId); return record.phase === 'required-input' && !record.requiredInputAnswer
        && this.current(record) && same(input, draftRequiredInputWork(record)); } catch { return false; }
    } }) : undefined;
    this.creates = new AstraCreateTaskProfile({ ...options, adapterId: 'model-owned-workspace-create', admission: {
      resolve: source => this.childSelection(source), isCurrent: source => {
        try { return this.childSelection(source).digest === source.digest; } catch { return false; }
      },
      isDispatchAllowed: source => { const record = this.record(source.interactionId);
        return record.phase === 'create' && record.desired === 'run' && this.current(record); },
    } });
    const unpack = (raw: AstraJson) => {
      check(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(key => ['taskId', 'model'].includes(key))
        && id(raw.taskId), 'draft-envelope');
      return raw as unknown as { taskId: string; model?: AstraModelWorkInput };
    };
    const adapter: AstraWorkAdapter = { id: 'goal-create-model', version: 'v1',
      compile: (raw, context) => {
        const input = unpack(raw), record = this.record(input.taskId);
        check(context.scopeId === options.scopeId && context.jobId === record.modelJobId && record.phase === 'model'
          && !draftUsesLiteralInput(record) && record.desired === 'run' && this.current(record), 'draft-model-admission');
        check(!record.goal.selection.requiredInput || record.requiredInputAnswer && this.requiredQuestion(record), 'draft-required-input-bypassed');
        const compiled = this.models.compile(json(this.modelInput(record)), context);
        if (input.model) check(same(input.model, compiled.input), 'draft-model-substitution');
        return { ...compiled, input: { taskId: record.taskId, model: compiled.input }, bindingDigest: digest({ goal: record.goalDigest, model: compiled.bindingDigest }) };
      },
      execute: (raw, control) => this.models.execute(json(unpack(raw).model), control),
      control: (raw, command, owner, journal) => this.models.control(json(unpack(raw).model), command, owner, journal),
      reconcile: (raw, owner, journal, context) => this.models.reconcile(json(unpack(raw).model), owner, journal, context),
      reconcileRemote: (raw, control) => this.models.reconcileRemote(json(unpack(raw).model), control),
    };
    if (options.referenceInputs) {
      const reads = new AstraReadWorkAdapter({ ...options, restartSafeAdmission: true });
      const unpackReference = (raw: AstraJson) => {
        check(raw && typeof raw === 'object' && !Array.isArray(raw) && id(raw.parentTaskId)
          && Object.keys(raw).every(key => ['taskId', 'parentTaskId', 'read'].includes(key)), 'draft-reference-envelope');
        const record = this.record(raw.parentTaskId);
        check(record.goal.referenceReadGoal && raw.taskId === record.goal.referenceReadGoal.taskId, 'draft-reference-parent');
        if (raw.read) check(same(raw.read, draftReferenceRequest(record.goal)), 'draft-reference-substitution');
        return record;
      };
      const current = (record: AstraModelCreateRecord) => record.phase === 'reference-read' && record.desired === 'run' && this.current(record);
      this.references = { id: 'goal-create-reference-read', version: 'v2',
        compile: (raw, context) => {
          const record = unpackReference(raw);
          check(current(record) && context.jobId === draftReferenceJobId(record.taskId) && context.scopeId === options.scopeId
            && record.goal.referenceReadGoal!.capabilityDigest === new AstraReadRuntime(options).capabilityDigest, 'draft-reference-admission');
          const compiled = reads.compile(json(draftReferenceRequest(record.goal)), context);
          return { ...compiled, input: { taskId: record.goal.referenceReadGoal!.taskId, parentTaskId: record.taskId, read: compiled.input },
            bindingDigest: digest({ parent: record.goalDigest, read: compiled.bindingDigest }) };
        },
        execute: (raw, control) => { const record = unpackReference(raw);
          return reads.execute(json(draftReferenceRequest(record.goal)), { ...control,
            isCurrent: () => control.isCurrent() && current(this.record(record.taskId)) }); },
        control: (raw, command, owner, journal) => { const record = unpackReference(raw);
          if (command === 'resume') check(current(record), 'draft-reference-stale');
          return reads.control(json(draftReferenceRequest(record.goal)), command, owner, journal); },
        reconcile: (raw, owner, journal) => reads.reconcile(json(draftReferenceRequest(unpackReference(raw).goal)), owner, journal),
      };
    }
    this.adapters = [adapter, this.creates.adapter, ...(this.inputs ? [this.inputs] : []), ...(this.references ? [this.references] : [])];
  }
  attach(scheduler: AstraWorkScheduler): this {
    check((!this.scheduler || this.scheduler === scheduler) && this.adapters.every(adapter => scheduler.isHostFor(adapter, this.options.scopeId, this.options.journal)), 'draft-host-binding');
    this.scheduler = scheduler; this.creates.attach(scheduler); return this;
  }
  private host(): AstraWorkScheduler { check(this.scheduler, 'draft-host-missing'); return this.scheduler; }

  submit(request: { requestId: string; source: AstraCreateSourceKey; finishWithinMs?: number }, sourceAdmission?: AstraTaskSourceAdmission): AstraModelCreateView {
    check(this.host().ownerIsCurrent(), 'draft-owner');
    check(request && Object.keys(request).every(key => ['requestId', 'source', 'finishWithinMs'].includes(key)) && id(request.requestId)
      && request.source && Object.keys(request.source).every(key => ['interactionId', 'messageId'].includes(key))
      && id(request.source.interactionId) && id(request.source.messageId), 'draft-request');
    const duration = request.finishWithinMs ?? 120000; check(Number.isSafeInteger(duration) && duration > 0 && duration <= 600000, 'draft-deadline');
    const taskId = draftTaskId(this.options.scopeId, request.requestId), requestDigest = digest({ ...request, finishWithinMs: duration });
    if (this.options.journal.read(taskId)) { check(this.record(taskId).goal.requestDigest === requestDigest, 'draft-request-conflict'); return this.read(taskId); }
    const selection = structuredClone(this.options.admission.resolve(request.source));
    const policy = this.options.policyForSource ? normalizeModelPolicy(this.options.policyForSource(request.source)) : this.policy;
    const goal: AstraModelCreateGoal = { taskId, requestDigest, scopeId: this.options.scopeId, canonicalRoot: path.resolve(this.options.canonicalRoot),
      source: structuredClone(request.source), selection,
      policy: structuredClone(policy), semanticContentReview: 'not-performed',
      ...(this.options.exactApprovals ? { createAdapterVersion: 'v2' as const } : {}) };
    if (goal.selection.references) {
      check(this.references && this.options.exactApprovals, 'draft-references-disabled');
      goal.referenceReadGoal = compileDraftReferenceGoal(goal, new AstraReadRuntime(this.options).capabilityDigest);
    }
    validateDraftGoal(goal, digest(goal));
    check(!goal.selection.requiredInput || this.inputs, 'draft-required-input-disabled');
    const record: AstraModelCreateRecord = { schemaVersion: 'monarch.astra-v3-model-create-task.internal.v1', taskId, goal, goalDigest: digest(goal),
      modelJobId: draftModelJobId(taskId), phase: goal.selection.requiredInput ? 'required-input' : goal.referenceReadGoal ? 'reference-read' : 'model', desired: 'run', deadline: Date.now() + duration,
      ...(goal.selection.requiredInput ? { requiredInputJobId: draftInputJobId(taskId) } : {}),
      ...(goal.referenceReadGoal && !goal.selection.requiredInput ? { referenceJobId: draftReferenceJobId(taskId) } : {}),
      controlCount: 0, reservationId: 'draft_budget_' + taskId };
    const source = prepareAstraTaskSourceAdmission(sourceAdmission, taskId, record.reservationId,
      [taskId, this.certificateId(taskId), this.messageId(taskId)]);
    this.prepared.set(taskId, record);
    try {
      this.host().submit({ requestId: this.inputs && goal.selection.requiredInput ? draftInputRequest(taskId) : goal.referenceReadGoal ? draftReferenceTaskId(taskId) : draftModelRequest(taskId),
        adapterId: this.inputs && goal.selection.requiredInput ? this.inputs.id : goal.referenceReadGoal ? this.references!.id : this.adapters[0]!.id,
        input: goal.selection.requiredInput ? json(draftRequiredInputWork(record)) : goal.referenceReadGoal
          ? { taskId: goal.referenceReadGoal.taskId, parentTaskId: taskId } : { taskId },
        startWithinMs: Math.min(duration, 30000), finishWithinMs: duration }, {
        commits: [this.commit(record, 'draft.admitted'), ...source.commits], reservations: [{ id: record.reservationId, allocations: [
          { streamId: taskId, commits: 64, eventBytes: 64 * 4096, checkpointBytes: 65536 },
          { streamId: this.certificateId(taskId), commits: 1, eventBytes: 4096, checkpointBytes: 16384 },
          { streamId: this.messageId(taskId), commits: 2, eventBytes: 4096, checkpointBytes: 4096 },
          ...source.allocations,
        ] }],
      });
    } finally { this.prepared.delete(taskId); }
    return this.read(taskId);
  }

  /** Authenticated host reply only, not an approval or a new source selection.
   * Parent answer + next model/create job + source-message claim commit together.
   * One typed prerequisite, then at most two model questions (guidance only).
   * No deadline extension, reopening cancelled work or retrying effects. */
  reply(taskId: string, reply: AstraDraftReply, sourceAdmission?: AstraTaskSourceAdmission): AstraModelCreateView {
    check(this.host().ownerIsCurrent(), 'draft-owner');
    const record = this.record(taskId), literal = draftUsesLiteralInput(record);
    validateDraftReply(reply, literal ? 'literal-content' : 'draft-guidance');
    const replies = record.clarifications ?? [], replyDigest = digest(reply);
    const previous = [...(record.requiredInputAnswer ? [record.requiredInputAnswer] : []), ...replies].find(entry => entry.reply.requestId === reply.requestId);
    if (previous) { check(previous.replyDigest === replyDigest, 'draft-reply-conflict'); return this.read(taskId); }
    const required = record.phase === 'required-input';
    check((required || record.phase === 'awaiting-user') && record.desired === 'run' && this.current(record), 'draft-not-awaiting-reply');
    if (required) check(this.host().job(record.requiredInputJobId!).state === 'observed', 'draft-not-awaiting-reply');
    const question = required ? this.requiredQuestion(record) : record.question; check(question, 'draft-not-awaiting-reply');
    check(reply.questionId === question.id && reply.questionDigest === question.digest
      && reply.messageId !== record.goal.source.messageId && reply.messageId !== record.requiredInputAnswer?.reply.messageId
      && !replies.some(entry => entry.reply.messageId === reply.messageId)
      && (!required || Buffer.byteLength(reply.text) <= record.goal.selection.requiredInput!.maxUtf8Bytes), 'draft-reply-binding');
    check(required || replies.length < ASTRA_DRAFT_MAX_CLARIFICATIONS, 'draft-clarification-budget');
    if (!required) inspectDraftModel(this.proof(record));
    if (literal) {
      check(required && (!record.goal.selection.contentRequirement
        || inspectAstraDraftContent(record.goal.selection.contentRequirement, reply.text).status === 'matched'), 'draft-reply-binding');
      const next: AstraModelCreateRecord = { ...record, phase: 'create', effectTaskId: draftEffectTaskId(record),
        requiredInputAnswer: { question: question as AstraRequiredInputQuestion, reply: structuredClone(reply), replyDigest } };
      check(!this.options.journal.read(next.effectTaskId!), 'draft-effect-already-admitted');
      this.prepared.set(taskId, next);
      try {
        const remaining = record.deadline - Date.now(); check(remaining > 0, 'draft-deadline');
        // Source-message claim is reserved by the existing create child and is
        // atomic with answer, parent link and create queue. No model job exists.
        this.creates.submit({ requestId: draftEffectRequest(taskId), source: { interactionId: taskId, messageId: draftCreateOrigin(next) },
          startWithinMs: Math.min(remaining, 30000), finishWithinMs: remaining }, [this.commit(next, 'draft.literal-reply-admitted')], sourceAdmission);
      } finally { this.prepared.delete(taskId); }
      return this.read(taskId);
    }
    const reservationId = 'draft_reply_' + question.id;
    const source = prepareAstraTaskSourceAdmission(sourceAdmission, taskId, reservationId,
      [taskId, this.certificateId(taskId), this.messageId(taskId)]);
    const answer = { reply: structuredClone(reply), replyDigest, ...(source.allocations.length ? { sourceReservationId: reservationId } : {}) };
    const needsReferences = required && record.goal.referenceReadGoal && !record.referenceEvidence;
    const next: AstraModelCreateRecord = { ...record, phase: needsReferences ? 'reference-read' : 'model', modelJobId: draftModelJobId(taskId, required ? 0 : replies.length + 1),
      ...(needsReferences ? { referenceJobId: draftReferenceJobId(taskId) } : {}),
      ...(required ? { requiredInputAnswer: { ...answer, question: question as AstraRequiredInputQuestion } }
        : { clarifications: [...replies, { ...answer, question: record.question! }] }) };
    delete next.question;
    this.prepared.set(taskId, next);
    try {
      const remaining = record.deadline - Date.now(); check(remaining > 0, 'draft-deadline');
      this.host().submit({ requestId: needsReferences ? draftReferenceTaskId(taskId) : draftModelRequest(taskId, draftRound(next)),
        adapterId: needsReferences ? this.references!.id : this.adapters[0]!.id,
        input: needsReferences ? { taskId: record.goal.referenceReadGoal!.taskId, parentTaskId: taskId } : { taskId },
        startWithinMs: Math.min(remaining, 30000), finishWithinMs: remaining }, {
        commits: [this.commit(next, 'draft.reply-admitted'), ...source.commits],
        reservations: source.allocations.length ? [{ id: reservationId, allocations: source.allocations }] : [],
      });
    } finally { this.prepared.delete(taskId); }
    return this.read(taskId);
  }

  command(taskId: string, command: 'pause' | 'resume' | 'cancel'): AstraModelCreateView {
    check(['pause', 'resume', 'cancel'].includes(command), 'draft-command');
    check(this.host().ownerIsCurrent(), 'draft-owner'); const record = this.record(taskId);
    if (record.phase === 'certified' || record.phase === 'settled') { check(command !== 'resume', 'draft-terminal'); return this.synchronize(taskId); }
    const desired = command === 'resume' ? 'run' : command;
    if (record.desired === desired) return this.synchronize(taskId);
    check(record.desired !== 'cancel' && (command === 'cancel' || record.controlCount < 24), 'draft-control');
    if (command === 'resume') check(record.desired === 'pause' && this.current(record), 'draft-not-resumable');
    this.save({ ...record, desired, controlCount: record.controlCount + 1, ...(command === 'cancel' ? { reason: 'user-cancelled' } : {}) }, 'draft.' + command);
    return this.synchronize(taskId);
  }
  decide(taskId: string, decision: AstraCreateApprovalDecision, sourceAdmission?: AstraTaskSourceAdmission): AstraModelCreateView {
    check(this.host().ownerIsCurrent() && this.options.exactApprovals, 'draft-approval-disabled');
    validateCreateApprovalDecision(decision); const record = this.record(taskId);
    check(record.effectTaskId && ![record.goal.source.messageId, record.requiredInputAnswer?.reply.messageId,
      ...(record.clarifications ?? []).map(entry => entry.reply.messageId)].includes(decision.messageId), 'draft-approval-source');
    const prior = this.options.journal.read(createApprovalAnswerId(record.effectTaskId));
    check(prior || record.phase === 'create' && record.desired !== 'cancel' && this.current(record), 'draft-approval-unavailable');
    this.creates.decide(record.effectTaskId, decision, sourceAdmission); return this.synchronize(taskId);
  }
  synchronize(taskId: string): AstraModelCreateView {
    check(this.host().ownerIsCurrent(), 'draft-owner'); let record = this.record(taskId);
    if (record.phase === 'certified') return this.read(taskId);
    if (record.phase === 'settled') return this.certify(record);
    if (record.desired !== 'cancel' && !this.current(record)) {
      record = { ...record, desired: 'cancel', reason: Date.now() >= record.deadline ? 'deadline' : 'source-stale' }; this.save(record, 'draft.stop-required');
    }
    if (record.phase === 'awaiting-user') return record.desired === 'cancel' ? this.finish(record) : this.read(taskId);
    // Apply parent control FIRST. Then the child can consume a retained approval
    // (including a crash before its wake), without resuming a user-paused parent.
    let job = this.host().job(this.activeJob(record));
    if (!settled(job.state)) {
      const command = record.desired === 'cancel' && job.state !== 'cancelling' ? 'cancel'
        : record.desired === 'pause' && !['paused', 'pausing', 'indeterminate'].includes(job.state) ? 'pause'
          : record.desired === 'run' && job.state === 'paused' ? 'resume' : undefined;
      if (command) {
        if (record.effectTaskId) this.creates.command(record.effectTaskId, command); else this.host().command(job.id, command);
        job = this.host().job(job.id);
      }
    }
    if (record.effectTaskId) { this.creates.synchronize(record.effectTaskId); job = this.host().job(job.id); }
    if (!settled(job.state) || record.desired === 'pause') return this.read(taskId);
    if (record.phase === 'required-input') return record.desired === 'cancel' || job.state !== 'observed'
      ? this.finish({ ...record, ...(record.desired === 'cancel' ? {} : { reason: 'required-input-unavailable' }) }) : this.read(taskId);
    if (record.phase === 'reference-read') {
      const inspected = inspectDraftReferences(record, this.referenceProof(record));
      if (record.desired === 'cancel' || !inspected.context) return this.finish({ ...record,
        ...(record.desired === 'cancel' ? {} : { reason: 'reference-read-incomplete' }) });
      const next: AstraModelCreateRecord = { ...record, phase: 'model', referenceEvidence: inspected.context.binding };
      let inputBudgetRejected = false;
      this.prepared.set(taskId, next);
      try {
        const remaining = record.deadline - Date.now(); check(remaining > 0, 'draft-deadline');
        this.host().submit({ requestId: draftModelRequest(taskId), adapterId: this.adapters[0]!.id, input: { taskId },
          startWithinMs: Math.min(remaining, 30000), finishWithinMs: remaining }, { commits: [this.commit(next, 'draft.references-linked')], reservations: [] });
      } catch (error) {
        // This exact error is thrown by the pure model compile BEFORE queue or
        // parent commit. Encoding can exceed the bound even when read bytes fit.
        // Never truncate required evidence or turn other/ambiguous failures green.
        if (!(error instanceof Error) || error.message !== 'astra-model-work:input-budget') throw error;
        inputBudgetRejected = true;
      } finally { this.prepared.delete(taskId); }
      if (inputBudgetRejected) return this.finish({ ...record, reason: 'reference-model-input-budget' });
      return this.read(taskId);
    }
    if (record.phase === 'create' || record.desired === 'cancel') return this.finish(record);
    const proof = this.proof(record), inspected = inspectDraftModel(proof);
    if (inspected.decision?.kind === 'ask-user') {
      if (draftRound(record) >= ASTRA_DRAFT_MAX_CLARIFICATIONS) return this.finish({ ...record, reason: 'clarification-budget' });
      if (!inspected.decision.question.trim() || Buffer.byteLength(inspected.decision.question) > 4096) return this.finish({ ...record, reason: 'question-budget' });
      this.save({ ...record, phase: 'awaiting-user', question: draftQuestion(record, inspected.decision.question, modelReadEvidence(proof.model!)) }, 'draft.question-pending');
      return this.read(taskId);
    }
    if (inspected.decision?.kind !== 'create') return this.finish({ ...record, reason: 'no-create-proposal' });
    if (record.goal.selection.contentRequirement && inspectAstraDraftContent(record.goal.selection.contentRequirement, inspected.decision.content).status !== 'matched') {
      return this.finish({ ...record, reason: 'content-requirement-mismatch' });
    }
    const next: AstraModelCreateRecord = { ...record, phase: 'create', effectTaskId: draftEffectTaskId(record), modelEvidence: modelReadEvidence(proof.model!) };
    check(!this.options.journal.read(next.effectTaskId!), 'draft-effect-already-admitted');
    this.prepared.set(taskId, next);
    try {
      const remaining = record.deadline - Date.now(); check(remaining > 0, 'draft-deadline');
      this.creates.submit({ requestId: draftEffectRequest(taskId), source: { interactionId: taskId, messageId: 'model_draft' },
        startWithinMs: Math.min(30000, remaining), finishWithinMs: remaining }, [this.commit(next, 'draft.effect-linked')]);
    } finally { this.prepared.delete(taskId); }
    return this.read(taskId);
  }
  synchronizeAll(policy?: AstraTaskFaultPolicy): AstraModelCreateView[] {
    return synchronizeEach(this.ids(), taskId => this.synchronize(taskId), policy);
  }
  list(): AstraModelCreateView[] { return this.ids().map(taskId => this.read(taskId)); }
  recoveryCandidates(policy?: AstraTaskFaultPolicy): Array<{ taskId: string; jobId: string }> {
    return synchronizeEach(this.ids(), taskId => { const record = this.record(taskId), jobId = this.activeJob(record);
      return record.phase !== 'certified' && ['indeterminate', 'pausing', 'cancelling'].includes(this.host().job(jobId).state) ? [{ taskId, jobId }] : []; }, policy).flat();
  }
  async reconcile(taskId: string): Promise<AstraModelCreateView> {
    this.synchronize(taskId); const job = this.host().job(this.activeJob(this.record(taskId)));
    if (['indeterminate', 'pausing', 'cancelling'].includes(job.state)) await this.host().reconcileRemote(job.id);
    return this.synchronize(taskId);
  }
  drain(): Promise<AstraModelCreateView[]> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      for (let pass = 0; pass < 8; pass++) {
        this.synchronizeAll(); const before = digest(this.ids().map(id => this.record(id)));
        await this.host().drain(); this.synchronizeAll();
        if (before === digest(this.ids().map(id => this.record(id)))) return this.list();
      }
      throw Error('astra-draft:progression-budget');
    })().finally(() => { this.draining = undefined; }); return this.draining;
  }
  read(taskId: string): AstraModelCreateView {
    const record = this.record(taskId), job = this.host().job(this.activeJob(record));
    const base = { taskId, phase: record.phase, modelJobs: draftUsesLiteralInput(record) || record.goal.selection.requiredInput && !record.requiredInputAnswer
      || record.goal.referenceReadGoal && !record.referenceEvidence ? 0 : draftRound(record) + 1,
      createJobs: record.effectTaskId ? 1 as const : 0 as const, nativeCompletionCertified: false as const,
      ...(record.goal.referenceReadGoal ? { readJobs: record.referenceJobId ? 1 as const : 0 as const } : {}),
      ...(record.requiredInputJobId ? { inputJobs: 1 as const } : {}) };
    if (record.phase === 'required-input' && job.state === 'observed') {
      const question = this.requiredQuestion(record); check(question, 'draft-required-question-missing');
      return { ...base, status: record.desired === 'pause' ? 'paused' : 'awaiting-user', question };
    }
    if (record.phase === 'awaiting-user') {
      inspectDraftModel(this.proof(record)); check(record.question, 'draft-question-missing');
      return { ...base, status: record.desired === 'pause' ? 'paused' : 'awaiting-user', question: structuredClone(record.question) };
    }
    if (record.phase !== 'certified') {
      const approval = record.effectTaskId ? this.creates.read(record.effectTaskId).approval : undefined;
      return { ...base, status: settled(job.state) ? record.desired === 'pause' ? 'paused' : 'awaiting-progression' : job.state,
        ...(approval ? { approval: { ...approval, predecessorMessageId: draftPredecessor(record) } } : {}) };
    }
    const certificate = certifyAstraModelCreateTask(this.proof(record));
    check(same(certificate, this.options.journal.read(this.certificateId(taskId))?.checkpoint) && record.certificateDigest === digest(certificate), 'draft-certificate');
    const message = this.options.journal.read(this.messageId(taskId))?.checkpoint as unknown as AstraModelCreateMessage;
    check(message && message.id === this.messageId(taskId) && message.taskId === taskId && message.interactionId === record.goal.source.interactionId
      && message.predecessorMessageId === this.predecessor(record) && message.certificateDigest === record.certificateDigest
      && message.content === renderDraftCertificate(certificate) && ['pending', 'acknowledged'].includes(message.delivery), 'draft-message');
    return { ...base, status: certificate.status, certificate, message };
  }
  acknowledgeMessage(taskId: string, certificateDigest: string): AstraModelCreateView {
    check(this.host().ownerIsCurrent(), 'draft-owner'); const record = this.record(taskId), view = this.read(taskId);
    check(view.message && view.message.certificateDigest === certificateDigest, 'draft-ack');
    if (view.message.delivery === 'acknowledged') return view;
    if (record.effectTaskId) {
      const child = this.creates.synchronize(record.effectTaskId);
      this.creates.acknowledgeMessage(record.effectTaskId, child.message!.certificateDigest);
    }
    const snapshot = this.options.journal.read(view.message.id)!;
    this.options.journal.appendAtomic({ primary: { streamId: view.message.id, requestId: 'ack_' + taskId, expectedRevision: snapshot.revision,
      reservationId: record.reservationId, checkpoint: json({ ...view.message, delivery: 'acknowledged' }), events: [{ type: 'draft.message-ack' }] },
      release: [record.reservationId, ...[...(record.requiredInputAnswer ? [record.requiredInputAnswer] : []), ...(record.clarifications ?? [])]
        .flatMap(entry => entry.sourceReservationId ? [entry.sourceReservationId] : [])] },
      () => this.host().ownerIsCurrent()); return this.read(taskId);
  }
  private finish(record: AstraModelCreateRecord): AstraModelCreateView {
    if (record.effectTaskId) this.creates.synchronize(record.effectTaskId);
    return this.certify({ ...record, phase: 'settled' });
  }
  private certify(record: AstraModelCreateRecord): AstraModelCreateView {
    const certificate = certifyAstraModelCreateTask(this.proof(record)), certificateDigest = digest(certificate);
    const message: AstraModelCreateMessage = { id: this.messageId(record.taskId), taskId: record.taskId, interactionId: record.goal.source.interactionId,
      predecessorMessageId: this.predecessor(record), certificateDigest, content: renderDraftCertificate(certificate), delivery: 'pending' };
    this.options.journal.appendAtomic({ primary: this.commit({ ...record, phase: 'certified', certificateDigest }, 'draft.certified'), additional: [
      { streamId: this.certificateId(record.taskId), requestId: 'certificate_' + record.taskId, expectedRevision: 0, reservationId: record.reservationId,
        checkpoint: json(certificate), events: [{ type: 'draft.certificate' }] },
      { streamId: message.id, requestId: 'message_' + record.taskId, expectedRevision: 0, reservationId: record.reservationId,
        checkpoint: json(message), events: [{ type: 'draft.message' }] },
    ] }, () => this.host().ownerIsCurrent()); return this.read(record.taskId);
  }
  private childSelection(source: AstraCreateSourceKey): AstraCreateSelection {
    const record = this.record(source.interactionId);
    check(source.messageId === draftCreateOrigin(record) && record.phase === 'create' && record.desired !== 'cancel' && this.current(record), 'draft-effect-source');
    const input = this.proof(record), model = draftUsesLiteralInput(record) ? undefined : inspectDraftModel(input);
    const content = draftUsesLiteralInput(record) ? inspectLiteralCreateInput(input) : model?.decision?.kind === 'create' ? model.decision.content : undefined;
    check(content !== undefined, 'draft-effect-proposal');
    check(!record.goal.selection.contentRequirement || inspectAstraDraftContent(record.goal.selection.contentRequirement, content).status === 'matched',
      'draft-effect-content-requirement');
    return { authority: 'exclusive-create', revision: record.goal.selection.revision,
      digest: draftCreateSourceDigest(record, content),
      // Existing v2 goals retain their source review. New host-admitted kernel
      // goals use the current permission profile, retaining the exact approval
      // port whenever Kernel requires a card for the concrete proposal.
      ...(record.goal.createAdapterVersion === 'v2' && record.goal.selection.confirmationPolicy !== 'kernel'
        ? { requireExactConfirmation: true as const } : {}),
      userText: record.goal.selection.userText, basename: record.goal.selection.basename, timeoutMs: record.goal.selection.timeoutMs, content };
  }
  private current(record: AstraModelCreateRecord): boolean {
    try { return Date.now() < record.deadline && this.options.admission.isCurrent(record.goal.source)
      && same(this.options.admission.resolve(record.goal.source), record.goal.selection); } catch { return false; }
  }
  private modelCurrent(input: AstraModelWorkInput): boolean {
    try { const taskId = JSON.parse(input.source.mandatory.find(item => item.ref === 'draft_binding')!.text).taskId as string;
      const record = this.record(taskId); return record.phase === 'model' && record.desired === 'run' && this.current(record)
        && input.source.executionId === this.modelInput(record).source.executionId; } catch { return false; }
  }
  private modelInput(record: AstraModelCreateRecord): AstraModelWorkInput {
    return draftModelInput(record, inspectDraftReferences(record, record.referenceJobId ? this.referenceProof(record) : undefined).context);
  }
  private referenceProof(record: AstraModelCreateRecord): AstraDraftReferenceProof {
    const compiled = AstraReadWorkflow.compile(draftReferenceRequest(record.goal), record.goal.referenceReadGoal!.scopeDigest);
    return { job: this.host().job(draftReferenceJobId(record.taskId)), workflow: this.options.journal.read(compiled.runId),
      children: compiled.steps.flatMap(step => { const child = this.options.journal.read(astraReadRunId(step.readRequestId)); return child ? [child] : []; }) };
  }
  private proof(record: AstraModelCreateRecord): AstraModelCreateProof {
    const references = record.referenceJobId ? { references: this.referenceProof(record) } : {};
    if (draftUsesLiteralInput(record) || record.goal.selection.requiredInput && !record.requiredInputAnswer
      || record.goal.referenceReadGoal && !record.referenceEvidence) {
      const input: AstraModelCreateProof = { record, modelJob: null, model: null, context: null, ...references,
        ...(record.goal.selection.requiredInput ? { requiredInput: this.requiredProof(record) } : {}) };
      this.addChildProof(input); return input;
    }
    const modelJob = this.host().job(record.modelJobId), work = (modelJob.input as unknown as { model: AstraModelWorkInput }).model;
    const model = this.options.journal.read(work.workId!), cp = model?.checkpoint as unknown as AstraModelWorkCheckpoint | undefined;
    const input: AstraModelCreateProof = { record, modelJob, model, ...references, context: cp?.contextFrontier ? this.options.journal.read(cp.contextFrontier.streamId) : null };
    if (record.goal.selection.requiredInput) input.requiredInput = this.requiredProof(record);
    if (record.clarifications?.length) input.previousModels = record.clarifications.map((_entry, round) => {
      const modelJob = this.host().job(draftModelJobId(record.taskId, round)), work = (modelJob.input as unknown as { model: AstraModelWorkInput }).model;
      const model = this.options.journal.read(work.workId!), cp = model?.checkpoint as unknown as AstraModelWorkCheckpoint | undefined;
      return { modelJob, model, context: cp?.contextFrontier ? this.options.journal.read(cp.contextFrontier.streamId) : null };
    });
    this.addChildProof(input); return input;
  }
  private addChildProof(input: AstraModelCreateProof): void {
    const record = input.record;
    if (record.effectTaskId && this.options.journal.read(record.effectTaskId)) {
      const child = this.options.journal.read(record.effectTaskId)!.checkpoint as unknown as AstraCreateTaskRecord;
      input.child = { record: child, job: this.host().job(child.jobId), effect: this.options.journal.read(astraCreateWorkId(record.goal.scopeId, child.jobId)),
        ...(record.goal.createAdapterVersion ? { approvalAnswer: this.options.journal.read(createApprovalAnswerId(child.taskId)) } : {}) };
    }
  }
  private requiredProof(record: AstraModelCreateRecord): AstraRequiredInputProof {
    return { job: this.host().job(draftInputJobId(record.taskId)), checkpoint: this.options.journal.read(draftRequiredInputWork(record).workId!) };
  }
  private requiredQuestion(record: AstraModelCreateRecord): AstraRequiredInputQuestion | null {
    return inspectRequiredDraftInput({ record, modelJob: null, model: null, context: null, requiredInput: this.requiredProof(record) });
  }
  private record(taskId: string): AstraModelCreateRecord {
    check(id(taskId), 'draft-identity'); const record = this.prepared.get(taskId) ?? this.options.journal.read(taskId)?.checkpoint as unknown as AstraModelCreateRecord;
    check(record?.schemaVersion === 'monarch.astra-v3-model-create-task.internal.v1' && record.taskId === taskId && record.goal.taskId === taskId
      && record.goal.scopeId === this.options.scopeId && record.goal.canonicalRoot === path.resolve(this.options.canonicalRoot)
      && (record.goal.createAdapterVersion ?? 'v1') === (this.options.exactApprovals ? 'v2' : 'v1')
      && record.modelJobId === draftModelJobId(taskId, draftRound(record)) && ['required-input', 'reference-read', 'model', 'awaiting-user', 'create', 'settled', 'certified'].includes(record.phase)
      && (record.goal.selection.requiredInput ? this.inputs && record.requiredInputJobId === draftInputJobId(taskId)
        && (!['reference-read', 'model', 'awaiting-user', 'create'].includes(record.phase) || record.requiredInputAnswer)
        : !record.requiredInputJobId && !record.requiredInputAnswer)
      && (record.clarifications === undefined || Array.isArray(record.clarifications) && record.clarifications.length <= ASTRA_DRAFT_MAX_CLARIFICATIONS)
      && (record.phase !== 'awaiting-user' || record.question && !record.effectTaskId)
      && (!draftUsesLiteralInput(record) || !record.modelEvidence && !record.clarifications?.length && !record.question
        && !['model', 'awaiting-user'].includes(record.phase))
      && (record.goal.referenceReadGoal ? this.references
        && (record.referenceJobId === draftReferenceJobId(taskId) || record.goal.selection.requiredInput && !record.requiredInputAnswer)
        && (!['model', 'awaiting-user', 'create'].includes(record.phase) || record.referenceEvidence)
        : !record.referenceJobId && !record.referenceEvidence && record.phase !== 'reference-read')
      && ['run', 'pause', 'cancel'].includes(record.desired) && record.reservationId === 'draft_budget_' + taskId
      && Number.isSafeInteger(record.deadline) && record.deadline > 0
      && Number.isSafeInteger(record.controlCount) && record.controlCount >= 0 && record.controlCount <= 25
      && (record.effectTaskId === undefined || record.effectTaskId === draftEffectTaskId(record))
      && (record.phase !== 'create' || (record.effectTaskId && (draftUsesLiteralInput(record) ? record.requiredInputAnswer : record.modelEvidence))), 'draft-record');
    validateDraftGoal(record.goal, record.goalDigest); return record;
  }
  private predecessor(record: AstraModelCreateRecord): string {
    if (record.effectTaskId && record.goal.createAdapterVersion) {
      const child = this.creates.read(record.effectTaskId);
      if (child.certificate?.approvalEvidence) { check(child.message, 'draft-approval-message'); return child.message.predecessorMessageId; }
    }
    return draftPredecessor(record);
  }
  private activeJob(record: AstraModelCreateRecord): string {
    if (record.goal.selection.requiredInput && !record.requiredInputAnswer) return record.requiredInputJobId!;
    if (record.referenceJobId && !record.referenceEvidence) return record.referenceJobId;
    return record.effectTaskId ? (this.options.journal.read(record.effectTaskId)!.checkpoint as unknown as AstraCreateTaskRecord).jobId : record.modelJobId;
  }
  private ids(): string[] { return [...new Set(this.host().list().filter(job => job.adapterId === this.adapters[0]!.id || job.adapterId === this.inputs?.id || job.adapterId === this.references?.id)
    .map(job => { const input = job.input as { taskId: string; parentTaskId?: string }; return input.parentTaskId ?? input.taskId; }))]; }
  private commit(record: AstraModelCreateRecord, type: string): AstraJournalCommit {
    const revision = this.options.journal.read(record.taskId)?.revision ?? 0;
    return { streamId: record.taskId, requestId: 'draft_' + record.taskId + '_' + (revision + 1), expectedRevision: revision,
      reservationId: record.reservationId, checkpoint: json(record), events: [{ type }] };
  }
  private save(record: AstraModelCreateRecord, type: string): void { this.options.journal.appendAtomic({ primary: this.commit(record, type) }, () => this.host().ownerIsCurrent()); }
  private certificateId(taskId: string): string { return 'certificate_' + taskId; }
  private messageId(taskId: string): string { return 'message_' + taskId; }
}

function normalizeModelPolicy(policy: Pick<AstraModelReadPolicy, 'expectedModelDigest'>
  & Partial<Omit<AstraModelReadPolicy, 'expectedModelDigest'>>): AstraModelReadPolicy {
  const normalized = { expectedModelDigest: policy.expectedModelDigest, maxOutputTokens: policy.maxOutputTokens ?? 1024,
    modelTimeoutMs: policy.modelTimeoutMs ?? 15000, maxModelAttempts: policy.maxModelAttempts ?? 2,
    contextLimits: structuredClone(policy.contextLimits ?? {}) };
  check(/^sha256:[a-f0-9]{64}$/u.test(normalized.expectedModelDigest)
    && Number.isSafeInteger(normalized.maxOutputTokens) && normalized.maxOutputTokens >= 1 && normalized.maxOutputTokens <= 65_536
    && Number.isSafeInteger(normalized.modelTimeoutMs) && normalized.modelTimeoutMs >= 20 && normalized.modelTimeoutMs <= 600_000
    && Number.isSafeInteger(normalized.maxModelAttempts) && normalized.maxModelAttempts >= 1 && normalized.maxModelAttempts <= 4,
  'draft-model-policy');
  return normalized;
}

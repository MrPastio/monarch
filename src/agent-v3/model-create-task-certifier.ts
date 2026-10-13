import type { AstraContextPlan } from './context-engine';
import { astraModelDecisionProfile } from './model-decision-profile';
import type { AstraStructuredModelDecision } from './read-model-decision';
import type { AstraJournalSnapshot } from './journal';
import type { AstraModelWorkCheckpoint, AstraModelWorkInput } from './model-work-adapter';
import type { AstraWorkJob } from './work-scheduler';
import { certifyAstraCreateTask, astraCreateValueDigest } from './create-task-certifier';
import type { AstraCreateTaskRecord } from './create-task-profile';
import type { AstraCreateApprovalAnswer } from './create-approval';
import { modelReadCheck as check, modelReadDigest as digest, modelReadSame as same, modelReadSettled as settled } from './model-read-task-state';
import { modelReadEvidence } from './model-read-task-certifier';
import { inspectAstraDraftContent } from './draft-content-acceptance';
import { classifyAstraModelWorkFailure } from './model-failure-presentation';
import { draftEffectTaskId, draftModelInput, draftModelJobId, validateDraftGoal,
  draftRound, draftQuestion, draftRecordAtRound, validateDraftReply, ASTRA_DRAFT_MAX_CLARIFICATIONS,
  draftInputJobId, draftRequiredInputWork, draftUsesLiteralInput, draftCreateOrigin, draftCreateSourceDigest,
  type AstraModelCreateRecord, type AstraModelCreateCertificate } from './model-create-task-state';

import { inspectAstraRequiredInput, type AstraRequiredInputProof, type AstraRequiredInputQuestion } from './required-input-work';
import { inspectDraftReferences, type AstraDraftReferenceProof } from './draft-reference-read';
export interface AstraModelCreateProof { record: AstraModelCreateRecord; modelJob: AstraWorkJob | null;
  model: AstraJournalSnapshot | null; context: AstraJournalSnapshot | null;
  previousModels?: Array<Pick<AstraModelCreateProof, 'modelJob' | 'model' | 'context'>>;
  requiredInput?: AstraRequiredInputProof;
  references?: AstraDraftReferenceProof;
  child?: { record: AstraCreateTaskRecord; job: AstraWorkJob; effect: AstraJournalSnapshot | null; approvalAnswer?: AstraJournalSnapshot | null } }

/** Exact model output is reinterpreted through the closed create schema, NOT a
 * cached model claim. Optional child create uses its existing family certifier. */
export function inspectDraftModel(input: AstraModelCreateProof): { decision?: Extract<AstraStructuredModelDecision, { status: 'accepted' }>['proposal'] } {
  inspectRequiredDraftInput(input);
  const references = inspectDraftReferences(input.record, input.references);
  if (input.record.goal.referenceReadGoal && !input.record.referenceEvidence) {
    check(!input.modelJob && !input.model && !input.context && !input.record.effectTaskId && !input.record.clarifications?.length,
      'draft-reference-read-bypassed'); return {};
  }
  if (input.record.goal.referenceReadGoal) check(references.context, 'draft-reference-context-required');
  const replies = input.record.clarifications ?? [];
  check(replies.length <= ASTRA_DRAFT_MAX_CLARIFICATIONS && (input.previousModels?.length ?? 0) === replies.length, 'draft-clarification-proof-count');
  const messages = new Set([input.record.goal.source.messageId]), requests = new Set<string>();
  if (input.record.requiredInputAnswer) { messages.add(input.record.requiredInputAnswer.reply.messageId); requests.add(input.record.requiredInputAnswer.reply.requestId); }
  replies.forEach((entry, index) => {
    validateDraftReply(entry.reply);
    const prior = input.previousModels![index]!, record = draftRecordAtRound(input.record, index), inspected = inspectSingleDraftModel({ ...prior, record,
      ...(input.references ? { references: input.references } : {}) });
    check(inspected.decision?.kind === 'ask-user' && prior.model, 'draft-clarification-model');
    check(same(entry.question, draftQuestion(record, inspected.decision.question, modelReadEvidence(prior.model)))
      && entry.reply.questionId === entry.question.id && entry.reply.questionDigest === entry.question.digest
      && entry.replyDigest === digest(entry.reply) && !messages.has(entry.reply.messageId) && !requests.has(entry.reply.requestId)
      && (entry.sourceReservationId === undefined || entry.sourceReservationId === 'draft_reply_' + entry.question.id), 'draft-clarification-binding');
    messages.add(entry.reply.messageId); requests.add(entry.reply.requestId);
  });
  const inspected = inspectSingleDraftModel(input);
  if (input.record.question) check(inspected.decision?.kind === 'ask-user' && input.model
    && same(input.record.question, draftQuestion(input.record, inspected.decision.question, modelReadEvidence(input.model))), 'draft-question-binding');
  return inspected;
}
export function inspectRequiredDraftInput(input: AstraModelCreateProof): AstraRequiredInputQuestion | null {
  const record = input.record, requirement = record.goal.selection.requiredInput, answer = record.requiredInputAnswer;
  if (!requirement) { check(!input.requiredInput && !answer && !record.requiredInputJobId, 'draft-unexpected-required-input'); return null; }
  check(record.requiredInputJobId === draftInputJobId(record.taskId) && input.requiredInput?.job.id === record.requiredInputJobId, 'draft-required-input-job');
  const question = inspectAstraRequiredInput(input.requiredInput, draftRequiredInputWork(record));
  if (answer) {
    validateDraftReply(answer.reply, requirement.kind);
    check(question && same(answer.question, question) && answer.reply.questionId === question.id && answer.reply.questionDigest === question.digest
      && answer.reply.messageId !== record.goal.source.messageId && Buffer.byteLength(answer.reply.text) <= requirement.maxUtf8Bytes
      && answer.replyDigest === digest(answer.reply) && (answer.sourceReservationId === undefined || answer.sourceReservationId === 'draft_reply_' + question.id), 'draft-required-input-answer');
  } else check(!input.modelJob && !input.model && !input.context && !record.effectTaskId && !record.clarifications?.length, 'draft-required-input-bypassed');
  return question;
}
/** A separate proof branch, NOT a synthetic model decision. The typed source
 * reply is the exact byte requirement and carries no target/permission authority. */
export function inspectLiteralCreateInput(input: AstraModelCreateProof): string | undefined {
  const { record } = input;
  validateDraftGoal(record.goal, record.goalDigest);
  check(record.taskId === record.goal.taskId && draftUsesLiteralInput(record), 'literal-input-goal');
  check(!input.modelJob && !input.model && !input.context && !input.previousModels?.length && !record.modelEvidence
    && !record.clarifications?.length && !record.question && !['model', 'awaiting-user'].includes(record.phase), 'literal-input-model-forbidden');
  inspectRequiredDraftInput(input);
  return record.requiredInputAnswer?.reply.text;
}
function inspectSingleDraftModel(input: AstraModelCreateProof): { decision?: Extract<AstraStructuredModelDecision, { status: 'accepted' }>['proposal'] } {
  const { record, modelJob: job, model, context } = input;
  validateDraftGoal(record.goal, record.goalDigest);
  check(record.taskId === record.goal.taskId, 'draft-goal-task-binding');
  if (!job) { check(record.goal.selection.requiredInput && !record.requiredInputAnswer && !record.effectTaskId && !model && !context, 'draft-model-proof-missing'); return {}; }
  check(job.id === draftModelJobId(record.taskId, draftRound(record)) && job.id === record.modelJobId && job.adapterId === 'goal-create-model'
    && job.adapterVersion === 'v1' && settled(job.state), 'draft-model-job');
  const envelope = job.input as unknown as { taskId: string; model: AstraModelWorkInput }, work = envelope.model;
  check(envelope.taskId === record.taskId && work?.workId && work.contextExecutionId, 'draft-model-input');
  const { workId: _workId, contextExecutionId: _contextId, ...proposed } = work;
  check(same(proposed, draftModelInput(record, inspectDraftReferences(record, input.references).context)), 'draft-model-input-substitution');
  if (!model) { check(job.state === 'blocked' && job.activationGeneration === 0 && !record.effectTaskId, 'draft-model-proof-missing'); return {}; }
  const cp = model.checkpoint as unknown as AstraModelWorkCheckpoint;
  check(model.streamId === work.workId && cp.schemaVersion === 'monarch.astra-v3-model-work.internal.v1' && cp.workId === work.workId
    && cp.inputDigest === digest(work) && cp.quiescent && job.result?.checkpointRef === model.streamId
    && job.result.checkpointRevision === model.revision, 'draft-model-frontier');
  if (record.modelEvidence) check(same(record.modelEvidence, modelReadEvidence(model)), 'draft-model-linked-frontier');
  if (job.state !== 'observed') { check(!record.effectTaskId, 'draft-effect-without-model'); return {}; }
  check(cp.phase === 'settled' && cp.desired === 'run' && cp.output && cp.seal && cp.contextFrontier && context
    && same(cp.contextFrontier, modelReadEvidence(context)) && cp.decision?.status === 'accepted', 'draft-model-output');
  const output = cp.output, seal = cp.seal, plan = (context.checkpoint as unknown as { active: AstraContextPlan }).active;
  check(output.finishReason === 'stop' && output.authority === 'none' && output.preparedId === seal.preparedId
    && output.turnId === seal.turnId && output.surfaceDigest === seal.surfaceDigest && output.promptDigest === seal.promptDigest
    && output.schemaDigest === seal.schemaDigest && output.inputTokens === seal.tokenCount && same(output.binding, seal.binding)
    && plan.surfaceDigest === seal.surfaceDigest && plan.tokenCount === seal.tokenCount
    && plan.executionId === work.contextExecutionId, 'draft-model-seal');
  const profile = astraModelDecisionProfile(work.candidates, work.createCandidate);
  const surface = JSON.parse(plan.surface) as { mandatory: unknown; data: unknown };
  check(same(surface.mandatory, [...work.source.mandatory, ...profile.mandatory]) && same(surface.data, []), 'draft-source-context');
  const accepted = profile.offer(plan, job.controlEpoch, work.catalogRevision, () => true)(output.text);
  check(accepted.status === 'accepted' && same(accepted.proposal, cp.decision.proposal), 'draft-model-decision');
  return { decision: accepted.proposal };
}

export function certifyAstraModelCreateTask(input: AstraModelCreateProof): AstraModelCreateCertificate {
  const { record, child } = input, literal = draftUsesLiteralInput(record);
  const model = literal ? undefined : inspectDraftModel(input);
  const content = literal ? inspectLiteralCreateInput(input) : model?.decision?.kind === 'create' ? model.decision.content : undefined;
  const requiredQuestion = record.goal.selection.requiredInput ? inspectRequiredDraftInput(input) : null;
  check(['settled', 'certified'].includes(record.phase) && record.desired !== 'pause', 'draft-not-settled');
  const contentAcceptance = record.goal.selection.contentRequirement
    ? inspectAstraDraftContent(record.goal.selection.contentRequirement, content) : undefined;
  const failure = literal || record.effectTaskId ? undefined : classifyAstraModelWorkFailure(input.model);
  const base = { schemaVersion: 'monarch.astra-v3-model-create-certificate.internal.v1' as const,
    taskId: record.taskId, goalDigest: record.goalDigest, nativeCompletionCertified: false as const,
    semanticContentReview: 'not-performed' as const, modelEvidence: input.model ? modelReadEvidence(input.model) : null,
    ...(failure ? { failure } : {}),
    ...(literal ? { contentSource: 'user-literal-input' as const } : {}),
    ...(record.clarifications?.length ? { clarifications: record.clarifications.map(entry => ({ questionId: entry.question.id,
      questionDigest: entry.question.digest, replyDigest: entry.replyDigest, modelEvidence: entry.question.modelEvidence })) } : {}),
    ...(record.goal.selection.requiredInput ? { requiredInput: { requirementId: record.goal.selection.requiredInput.id,
      questionDigest: requiredQuestion?.digest ?? null, replyDigest: record.requiredInputAnswer?.replyDigest ?? null,
      evidence: requiredQuestion?.inputEvidence ?? null } } : {}),
    ...(contentAcceptance ? { contentAcceptance } : {}) };
  const referenceCertificate = inspectDraftReferences(record, input.references).certificate;
  const referencedBase = { ...base, ...(referenceCertificate ? { references: referenceCertificate } : {}) };
  if (!record.effectTaskId) {
    check(!child, 'draft-unexpected-effect');
    return { ...referencedBase, status: record.desired === 'cancel' && record.reason === 'user-cancelled' ? 'cancelled' : 'blocked', effect: 'not-applied' };
  }
  check(child && record.effectTaskId === draftEffectTaskId(record) && child.record.taskId === record.effectTaskId
    && content !== undefined && (literal ? record.requiredInputAnswer : record.modelEvidence), 'draft-child-binding');
  check(!contentAcceptance || contentAcceptance.status === 'matched', 'draft-effect-content-requirement');
  const goal = child.record.goal, createInput = (child.job.input as unknown as { create: { content: string; source: { userText: string }; requireExactConfirmation?: true } }).create;
  check(goal.source.interactionId === record.taskId && goal.source.messageId === draftCreateOrigin(record)
    && goal.source.revision === record.goal.selection.revision
    && goal.source.digest === draftCreateSourceDigest(record, content)
    && goal.canonicalRoot === record.goal.canonicalRoot && goal.schedulerScopeId === record.goal.scopeId
    && goal.adapterId === 'model-owned-workspace-create'
    && (goal.adapterVersion ?? 'v1') === (record.goal.createAdapterVersion ?? 'v1')
    && goal.requirement.basename === record.goal.selection.basename && createInput.content === content
    && createInput.requireExactConfirmation === (record.goal.createAdapterVersion === 'v2'
      && record.goal.selection.confirmationPolicy !== 'kernel' ? true : undefined)
    && createInput.source.userText === record.goal.selection.userText, 'draft-effect-substitution');
  const create = certifyAstraCreateTask({ goal, goalDigest: child.record.goalDigest, job: child.job, effect: child.effect,
    ...(child.approvalAnswer !== undefined ? { approvalAnswer: child.approvalAnswer } : {}) });
  if (child.approvalAnswer) {
    const answer = child.approvalAnswer.checkpoint as unknown as AstraCreateApprovalAnswer;
    check(![record.goal.source.messageId, record.requiredInputAnswer?.reply.messageId,
      ...(record.clarifications ?? []).map(entry => entry.reply.messageId)].includes(answer.decision.messageId), 'draft-approval-message-reused');
  }
  check(!child.record.certificateDigest || child.record.certificateDigest === astraCreateValueDigest(create), 'draft-child-certificate');
  const status = record.desired === 'cancel' ? record.reason === 'user-cancelled' ? 'cancelled' : 'blocked'
    : create.status === 'completed' ? literal || contentAcceptance?.status === 'matched' ? 'completed' : 'partial' : 'blocked';
  return { ...referencedBase, status, effect: create.effect, create };
}

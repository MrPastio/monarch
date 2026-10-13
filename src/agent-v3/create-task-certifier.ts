import { createHash } from 'node:crypto';
import path from 'node:path';
import { astraJournalJson, type AstraJson, type AstraJournalSnapshot } from './journal';
import { astraWorkJobId, type AstraWorkJob } from './work-scheduler';
import { createApprovalAnswerId, createApprovalDigest, validateCreateApproval, validateCreateApprovalAnswer, type AstraCreateApprovalAnswer } from './create-approval';
import { astraCreateInputDigest, astraCreateSelectionDigest, astraCreateWorkId,
  type AstraCreateWorkCheckpoint, type AstraCreateWorkInput } from './create-work-adapter';

export interface AstraCreateSourceKey { interactionId: string; messageId: string }
export interface AstraCreateSelection {
  authority: 'exclusive-create'; revision: number; digest: string;
  userText: string; basename: string; content: string; timeoutMs?: number;
  requireExactConfirmation?: true;
}
export interface AstraCreateTaskGoal {
  schemaVersion: 'monarch.astra-v3-create-task-goal.internal.v1';
  taskId: string; requestDigest: string; schedulerScopeId: string; canonicalRoot: string;
  selectionDigest: string; source: AstraCreateSourceKey & { revision: number; digest: string };
  requirement: { kind: 'exclusive-file-create'; basename: string; bytes: number; contentDigest: string; targetDigest: string };
  temporalSemantics: 'snapshot-after-create';
  adapterId?: 'admitted-workspace-create' | 'model-owned-workspace-create';
  adapterVersion?: 'v2';
}
export interface AstraCreateTaskCertificate {
  schemaVersion: 'monarch.astra-v3-create-task-certificate.internal.v1';
  taskId: string; jobId: string; goalDigest: string; status: 'completed' | 'cancelled' | 'blocked';
  effect: 'applied' | 'not-applied'; temporalSemantics: 'snapshot-after-create'; nativeCompletionCertified: false;
  evidence: { streamId: string; revision: number; commitHash: string } | null;
  observation?: NonNullable<AstraCreateWorkCheckpoint['observation']>;
  approvalEvidence?: { streamId: string; revision: number; commitHash: string; decision: 'approve' | 'reject' };
}
export interface AstraCreateCertificationInput {
  goal: AstraCreateTaskGoal; goalDigest: string; job: AstraWorkJob; effect: AstraJournalSnapshot | null;
  approvalAnswer?: AstraJournalSnapshot | null;
}
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-create-certifier:' + code); }
export const astraCreateValueDigest = (value: unknown): string => sha(astraJournalJson(json(value)));

export function astraCreateSelectedInput(source: AstraCreateSourceKey, selection: AstraCreateSelection): AstraCreateWorkInput {
  check(selection.authority === 'exclusive-create' && Number.isSafeInteger(selection.revision) && selection.revision > 0
    && hash(selection.digest) && (selection.requireExactConfirmation === undefined || selection.requireExactConfirmation === true), 'admission-selection');
  return { basename: selection.basename, content: selection.content, timeoutMs: selection.timeoutMs ?? 5000,
    ...(selection.requireExactConfirmation === true ? { requireExactConfirmation: true as const } : {}),
    source: { interactionId: source.interactionId, messageId: source.messageId, revision: selection.revision, userText: selection.userText } };
}

export function compileAstraCreateTaskGoal(input: { taskId: string; requestDigest: string; schedulerScopeId: string;
  canonicalRoot: string; source: AstraCreateSourceKey; selection: AstraCreateSelection;
  adapterId?: AstraCreateTaskGoal['adapterId']; adapterVersion?: 'v2' }): AstraCreateTaskGoal {
  const work = astraCreateSelectedInput(input.source, input.selection);
  check(typeof work.content === 'string' && Buffer.byteLength(work.content) <= 16384 && typeof work.basename === 'string'
    && work.basename.length <= 255 && path.isAbsolute(input.canonicalRoot), 'selection-budget');
  const goal: AstraCreateTaskGoal = { schemaVersion: 'monarch.astra-v3-create-task-goal.internal.v1',
    taskId: input.taskId, requestDigest: input.requestDigest, schedulerScopeId: input.schedulerScopeId,
    canonicalRoot: path.resolve(input.canonicalRoot), selectionDigest: astraCreateSelectionDigest(work),
    source: { ...input.source, revision: input.selection.revision, digest: input.selection.digest },
    requirement: { kind: 'exclusive-file-create', basename: work.basename, bytes: Buffer.byteLength(work.content),
      contentDigest: sha(work.content), targetDigest: sha(path.join(path.resolve(input.canonicalRoot), work.basename).toLowerCase()) },
    temporalSemantics: 'snapshot-after-create', ...(input.adapterId ? { adapterId: input.adapterId } : {}),
    ...(input.adapterVersion ? { adapterVersion: input.adapterVersion } : {}) };
  validateAstraCreateTaskGoal(goal, astraCreateValueDigest(goal)); return goal;
}

export function validateAstraCreateTaskGoal(goal: AstraCreateTaskGoal, digest: string): void {
  check(goal && goal.schemaVersion === 'monarch.astra-v3-create-task-goal.internal.v1' && astraCreateValueDigest(goal) === digest
    && id(goal.taskId) && id(goal.schedulerScopeId) && hash(goal.requestDigest) && hash(goal.selectionDigest)
    && typeof goal.canonicalRoot === 'string' && path.isAbsolute(goal.canonicalRoot)
    && goal.canonicalRoot === path.resolve(goal.canonicalRoot) && id(goal.source.interactionId) && id(goal.source.messageId)
    && Number.isSafeInteger(goal.source.revision) && goal.source.revision > 0 && hash(goal.source.digest)
    && goal.requirement.kind === 'exclusive-file-create' && typeof goal.requirement.basename === 'string'
    && Number.isSafeInteger(goal.requirement.bytes) && goal.requirement.bytes >= 0 && goal.requirement.bytes <= 16384
    && hash(goal.requirement.contentDigest)
    && goal.requirement.targetDigest === sha(path.join(goal.canonicalRoot, goal.requirement.basename).toLowerCase())
    && goal.temporalSemantics === 'snapshot-after-create'
    && (goal.adapterId === undefined || ['admitted-workspace-create', 'model-owned-workspace-create'].includes(goal.adapterId))
    && (goal.adapterVersion === undefined || goal.adapterVersion === 'v2'), 'goal-binding');
}

/** Pure family certifier over retained Store facts. No Kernel/filesystem/model,
 * no fresh target read, no user authority and no native completion certificate. */
export function certifyAstraCreateTask(input: AstraCreateCertificationInput): AstraCreateTaskCertificate {
  const { goal, goalDigest, job, effect } = input;
  validateAstraCreateTaskGoal(goal, goalDigest);
  check(job.id === astraWorkJobId(goal.taskId) && job.adapterId === (goal.adapterId ?? 'admitted-workspace-create') && job.adapterVersion === (goal.adapterVersion ?? 'v1'), 'job-binding');
  check(['observed', 'cancelled', 'blocked'].includes(job.state), 'execution-not-settled');
  const wrapped = job.input as unknown as { taskId: string; create: AstraCreateWorkInput }, work = wrapped.create;
  check(wrapped.taskId === goal.taskId && work && work.workId === astraCreateWorkId(goal.schedulerScopeId, job.id)
    && astraCreateSelectionDigest(work) === goal.selectionDigest && work.basename === goal.requirement.basename
    && Buffer.byteLength(work.content) === goal.requirement.bytes && sha(work.content) === goal.requirement.contentDigest
    && work.source.interactionId === goal.source.interactionId && work.source.messageId === goal.source.messageId
    && work.source.revision === goal.source.revision, 'execution-goal-substitution');
  const base = { schemaVersion: 'monarch.astra-v3-create-task-certificate.internal.v1' as const, taskId: goal.taskId, jobId: job.id,
    goalDigest, temporalSemantics: 'snapshot-after-create' as const, nativeCompletionCertified: false as const };
  if (!effect) {
    check(job.state === 'blocked' && job.activationGeneration === 0 && !job.result, 'missing-effect-evidence');
    return { ...base, status: 'blocked', effect: 'not-applied', evidence: null };
  }
  const cp = effect.checkpoint as unknown as AstraCreateWorkCheckpoint;
  check(effect.streamId === work.workId && cp.workId === work.workId && Number.isSafeInteger(effect.revision) && effect.revision > 0
    && hash(effect.commitHash) && cp.schemaVersion === 'monarch.astra-v3-create-work.internal.v1'
    && cp.inputDigest === astraCreateInputDigest(goal.canonicalRoot, work), 'effect-binding');
  check(job.result && job.result.checkpointRef === effect.streamId && job.result.checkpointRevision === effect.revision, 'effect-frontier');
  check(cp.quiescent === true && cp.effect !== 'unknown' && ['ready', 'settled'].includes(cp.phase), 'unresolved-effect');
  check((job.state === 'cancelled') === (cp.desired === 'cancel') && cp.desired !== 'pause', 'control-state');
  const evidence = { streamId: effect.streamId, revision: effect.revision, commitHash: effect.commitHash };
  let approvalEvidence: AstraCreateTaskCertificate['approvalEvidence'];
  if (cp.approval) {
    validateCreateApproval(cp.approval);
    check(goal.adapterVersion === 'v2' && cp.approval.inputDigest === cp.inputDigest && cp.approval.workId === cp.workId
      && cp.approval.proposalHash === cp.invocation?.proposalHash && cp.approval.expiresAt === job.deadline, 'approval-challenge-binding');
    if (input.approvalAnswer) {
      const answer = input.approvalAnswer.checkpoint as unknown as AstraCreateApprovalAnswer;
      validateCreateApprovalAnswer(answer, goal.taskId, goalDigest, cp.approval);
      check(input.approvalAnswer.streamId === createApprovalAnswerId(goal.taskId) && input.approvalAnswer.revision === 1
        && hash(input.approvalAnswer.commitHash) && (!cp.approvalAnswerDigest || cp.approvalAnswerDigest === createApprovalDigest(answer)), 'approval-answer-evidence');
      approvalEvidence = { streamId: input.approvalAnswer.streamId, revision: 1, commitHash: input.approvalAnswer.commitHash, decision: answer.decision.decision };
    }
    check(cp.effect !== 'applied' || approvalEvidence?.decision === 'approve' && cp.approvalAnswerDigest, 'approval-required');
    check(!cp.approvalAnswerDigest || approvalEvidence, 'approval-answer-missing');
  } else check(!cp.approvalAnswerDigest && !input.approvalAnswer, 'unexpected-approval');
  const approvalProof = approvalEvidence ? { approvalEvidence } : {};
  if (cp.effect === 'applied') {
    check(work.requireExactConfirmation !== true || cp.approval && approvalEvidence?.decision === 'approve', 'source-approval-required');
    const seen = cp.observation;
    check(cp.phase === 'settled' && seen && seen.bytes === goal.requirement.bytes && seen.contentDigest === goal.requirement.contentDigest
      && seen.targetDigest === goal.requirement.targetDigest && /^[a-f0-9]{64}$/u.test(seen.proposalHash)
      && seen.proposalHash === cp.invocation?.proposalHash && /^action:[a-f0-9]{64}$/u.test(cp.invocation.idempotencyKey)
      && id(seen.ledgerId) && seen.temporalSemantics === 'snapshot-after-create'
      && (job.state === 'observed' || job.state === 'cancelled'), 'effect-value-binding');
    return { ...base, ...approvalProof, status: job.state === 'cancelled' ? 'cancelled' : 'completed', effect: 'applied', evidence, observation: structuredClone(seen) };
  }
  check(cp.effect === 'not-applied' && !cp.observation && job.state !== 'observed'
    && (cp.phase !== 'ready' || !cp.invocation || cp.approval && cp.approvalAnswerDigest), 'completion-state');
  return { ...base, ...approvalProof, status: job.state === 'cancelled' ? 'cancelled' : 'blocked', effect: 'not-applied', evidence };
}

export function renderAstraCreateTaskCertificate(certificate: AstraCreateTaskCertificate): string {
  const label = certificate.status === 'completed' ? 'Готово.' : certificate.status === 'cancelled' ? 'Задача отменена.' : 'Задача заблокирована.';
  return label + (certificate.effect === 'applied'
    ? ` Есть подтверждённый эффект: файл создан, UTF-8 байт: ${certificate.observation!.bytes}. Это факт на момент создания.`
    : ' Это действие не создало файл.');
}

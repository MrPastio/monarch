import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJson } from './journal';
import type { MonarchAuthorityTier, MonarchExecutionResult } from '../core/contracts';

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/u.test(value);
export const createApprovalDigest = (value: unknown): string => 'sha256:' + createHash('sha256')
  .update(astraJournalJson(JSON.parse(JSON.stringify(value)) as AstraJson)).digest('hex');
function check(value: unknown, code: string): asserts value { if (!value) throw Error('astra-create-approval:' + code); }

/** A Kernel policy challenge, NOT a token granting execution or a task lease.
 * One answer only. A changed final policy needs a new action review, never an
 * automatic approval of that changed policy. Exact proposal bytes stay in work. */
export interface AstraCreateApproval {
  id: string; digest: string; workId: string; inputDigest: string; proposalHash: string;
  policyDecisionHash: string; authorityTier: MonarchAuthorityTier; purpose: 'policy';
  expiresAt: number; policySnapshotJson: string;
}
export interface AstraCreateApprovalDecision {
  approvalId: string; approvalDigest: string; messageId: string; decision: 'approve' | 'reject';
}
export interface AstraCreateApprovalAnswer {
  schemaVersion: 'monarch.astra-v3-create-approval-answer.internal.v1';
  taskId: string; goalDigest: string; challenge: AstraCreateApproval; decision: AstraCreateApprovalDecision; receivedAt: number;
}
export interface AstraCreateApprovalCard extends AstraCreateApproval {
  basename: string; content: string; bytes: number; contentDigest: string;
  overwrite: false; grantScope: 'once'; nativeCompletionCertified: false;
}
export const createApprovalAnswerId = (taskId: string): string => 'approval_answer_' + taskId;
export function validateCreateApprovalDecision(value: AstraCreateApprovalDecision): void {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 4 && Object.keys(value).every(key => ['approvalId', 'approvalDigest', 'messageId', 'decision'].includes(key))
    && id(value.approvalId) && /^sha256:[a-f0-9]{64}$/u.test(value.approvalDigest) && id(value.messageId)
    && ['approve', 'reject'].includes(value.decision), 'invalid-decision');
}
export function validateCreateApproval(value: AstraCreateApproval): void {
  check(value && id(value.id) && id(value.workId) && /^sha256:[a-f0-9]{64}$/u.test(value.inputDigest)
    && hash(value.proposalHash) && hash(value.policyDecisionHash) && ['public', 'owner'].includes(value.authorityTier)
    && value.purpose === 'policy' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    && typeof value.policySnapshotJson === 'string' && Buffer.byteLength(value.policySnapshotJson) <= 16384, 'challenge-binding');
  const { digest, ...body } = value;
  check(digest === createApprovalDigest(body), 'challenge-digest');
  const policy = JSON.parse(value.policySnapshotJson);
  check(policy?.outcome === 'confirm' && policy.policyDecisionHash === value.policyDecisionHash
    && policy.canonicalProposalHash === value.proposalHash && policy.authorityTier === value.authorityTier
    && !policy.securityOverride, 'challenge-policy');
}
export function makeCreateApproval(result: MonarchExecutionResult, binding: {
  workId: string; inputDigest: string; proposalHash: string; expiresAt: number;
}): AstraCreateApproval | undefined {
  const policy = result.metadata?.policy as Record<string, unknown> | undefined;
  if (result.ok || result.error !== 'confirmation-required' || policy?.outcome !== 'confirm'
    || policy.canonicalProposalHash !== binding.proposalHash || !hash(policy.policyDecisionHash)
    || !['public', 'owner'].includes(String(policy.authorityTier)) || policy.securityOverride) return undefined;
  const policySnapshotJson = JSON.stringify(policy);
  if (Buffer.byteLength(policySnapshotJson) > 16384) return undefined;
  const body = { id: 'approval_' + createApprovalDigest(binding).slice(7, 39), ...binding,
    policyDecisionHash: policy.policyDecisionHash, authorityTier: policy.authorityTier as MonarchAuthorityTier,
    purpose: 'policy' as const, policySnapshotJson };
  const challenge = { ...body, digest: createApprovalDigest(body) }; validateCreateApproval(challenge); return challenge;
}
export function validateCreateApprovalAnswer(answer: AstraCreateApprovalAnswer, taskId: string, goalDigest: string,
  challenge: AstraCreateApproval): void {
  validateCreateApproval(challenge); validateCreateApprovalDecision(answer.decision);
  check(answer.schemaVersion === 'monarch.astra-v3-create-approval-answer.internal.v1' && answer.taskId === taskId
    && answer.goalDigest === goalDigest && createApprovalDigest(answer.challenge) === createApprovalDigest(challenge)
    && answer.decision.approvalId === challenge.id && answer.decision.approvalDigest === challenge.digest
    && Number.isSafeInteger(answer.receivedAt) && answer.receivedAt > 0
    && (answer.decision.decision === 'reject' || answer.receivedAt < challenge.expiresAt), 'answer-binding');
}

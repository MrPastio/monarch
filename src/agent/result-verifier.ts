import type { MonarchJsonSchema } from '../core/contracts';
import { validateAgentJsonSchema } from './strict-json-schema';
import type {
  AgentExpectedOutput,
  AgentSuccessCriterion,
  AgentVerificationResult,
} from './types';
export type AgentVerificationMethod =
  | 'deterministic'
  | 'follow-up-read'
  | 'kernel-predicate'
  | 'external-receipt'
  | 'model-semantic';

export interface AgentActionVerificationRequirement {
  actionAttemptId: string;
  capabilityId: string;
  mutation: 'none' | 'temporary' | 'persistent';
  executionStatus: 'success' | 'partial' | 'failed' | 'cancelled';
}

export interface AgentVerificationRecord {
  id: string;
  targetType: 'expected-output' | 'success-criterion' | 'action';
  targetId: string;
  status: AgentVerificationResult['status'];
  method: AgentVerificationMethod;
  summary: string;
  evidenceIds: string[];
}

export interface VerifyAgentCompletionInput {
  expectedOutputs: AgentExpectedOutput[];
  successCriteria?: AgentSuccessCriterion[];
  actions?: AgentActionVerificationRequirement[];
  verifications: AgentVerificationRecord[];
}

export interface AgentCompletionVerification {
  complete: boolean;
  status: 'verified' | 'incomplete' | 'failed';
  summary: string;
  missing: string[];
  failed: string[];
  verifiedEvidenceIds: string[];
}

export type AgentVerificationAssertion =
  | { kind: 'exists' }
  | { kind: 'not-exists' }
  | { kind: 'equals'; expected: unknown }
  | { kind: 'contains'; expected: unknown }
  | { kind: 'status'; expected: string | number | boolean }
  | { kind: 'schema'; schema: MonarchJsonSchema };

export interface AgentAssertionResult {
  verified: boolean;
  summary: string;
  observed: unknown;
}

export function verifyAgentCompletion(
  input: VerifyAgentCompletionInput,
): AgentCompletionVerification {
  const requiredOutputs = input.expectedOutputs.filter((entry) => entry.required !== false);
  const requiredCriteria = input.successCriteria || [];
  const actions = input.actions || [];
  const verificationIndex = indexVerifications(input.verifications);
  const missing: string[] = [];
  const failed: string[] = [];
  const evidenceIds = new Set<string>();

  if (requiredOutputs.length === 0 && requiredCriteria.length === 0) {
    missing.push('goal:at-least-one-explicit-completion-criterion');
  }

  for (const output of requiredOutputs) {
    evaluateRequiredTarget(
      'expected-output',
      normalizeId(output.id, 'expected output'),
      verificationIndex,
      missing,
      failed,
      evidenceIds,
      false,
    );
  }

  for (const criterion of requiredCriteria) {
    evaluateRequiredTarget(
      'success-criterion',
      normalizeId(criterion.id, 'success criterion'),
      verificationIndex,
      missing,
      failed,
      evidenceIds,
      false,
    );
  }

  for (const action of actions) {
    if (action.mutation === 'none') continue;
    const actionId = normalizeId(action.actionAttemptId, 'action attempt');
    if (action.executionStatus === 'failed' || action.executionStatus === 'cancelled') {
      failed.push('action:' + actionId + ':execution-' + action.executionStatus);
      continue;
    }
    if (action.executionStatus === 'partial') {
      missing.push('action:' + actionId + ':partial-result-requires-replan');
      continue;
    }
    evaluateRequiredTarget(
      'action',
      actionId,
      verificationIndex,
      missing,
      failed,
      evidenceIds,
      true,
    );
  }

  if (failed.length > 0) {
    return {
      complete: false,
      status: 'failed',
      summary: 'Completion is blocked by failed verification.',
      missing: [...new Set(missing)],
      failed: [...new Set(failed)],
      verifiedEvidenceIds: [...evidenceIds],
    };
  }
  if (missing.length > 0) {
    return {
      complete: false,
      status: 'incomplete',
      summary: 'Completion is blocked until all required outputs and effects are verified.',
      missing: [...new Set(missing)],
      failed: [],
      verifiedEvidenceIds: [...evidenceIds],
    };
  }
  return {
    complete: true,
    status: 'verified',
    summary: 'All required outputs, success criteria, and mutating effects are verified.',
    missing: [],
    failed: [],
    verifiedEvidenceIds: [...evidenceIds],
  };
}

export function assertAgentCompletionVerified(input: VerifyAgentCompletionInput): AgentCompletionVerification {
  const result = verifyAgentCompletion(input);
  if (!result.complete) {
    const details = [...result.failed, ...result.missing].join(', ');
    throw new Error('Agent task cannot complete without verified evidence: ' + details);
  }
  return result;
}

export function evaluateVerificationAssertion(
  assertion: AgentVerificationAssertion,
  observed: unknown,
): AgentAssertionResult {
  switch (assertion.kind) {
  case 'exists': {
    const verified = observed !== null && observed !== undefined && observed !== false;
    return { verified, summary: verified ? 'Target exists.' : 'Target does not exist.', observed };
  }
  case 'not-exists': {
    const verified = observed === null || observed === undefined || observed === false;
    return { verified, summary: verified ? 'Target does not exist.' : 'Target still exists.', observed };
  }
  case 'equals': {
    const verified = deepEqual(observed, assertion.expected);
    return { verified, summary: verified ? 'Observed value matches.' : 'Observed value does not match.', observed };
  }
  case 'contains': {
    const verified = containsValue(observed, assertion.expected);
    return {
      verified,
      summary: verified ? 'Observed value contains the expected value.' : 'Expected value was not observed.',
      observed,
    };
  }
  case 'status': {
    const candidate = statusValue(observed);
    const verified = candidate === assertion.expected;
    return {
      verified,
      summary: verified ? 'Observed status matches.' : 'Observed status does not match.',
      observed,
    };
  }
  case 'schema': {
    const result = validateAgentJsonSchema(observed, assertion.schema, 'observed');
    return {
      verified: result.ok,
      summary: result.ok
        ? 'Observed value matches the required schema.'
        : 'Observed value failed schema validation: ' + result.errors.join(' '),
      observed,
    };
  }
  }
}

function evaluateRequiredTarget(
  targetType: AgentVerificationRecord['targetType'],
  targetId: string,
  index: Map<string, AgentVerificationRecord[]>,
  missing: string[],
  failed: string[],
  evidenceIds: Set<string>,
  requireStrongMethod: boolean,
): void {
  const key = targetType + ':' + targetId;
  const candidates = index.get(key) || [];
  const latest = candidates.at(-1);
  if (latest?.status === 'failed') {
    failed.push(key);
    return;
  }
  if (
    latest?.status !== 'verified'
    || latest.evidenceIds.length === 0
    || (requireStrongMethod && !isStrongMutationVerification(latest.method))
  ) {
    missing.push(key);
    return;
  }
  for (const evidenceId of latest.evidenceIds) {
    const normalized = String(evidenceId || '').trim();
    if (normalized) evidenceIds.add(normalized);
  }
}

function indexVerifications(
  records: AgentVerificationRecord[],
): Map<string, AgentVerificationRecord[]> {
  const index = new Map<string, AgentVerificationRecord[]>();
  for (const record of records) {
    const targetId = String(record.targetId || '').trim();
    if (!targetId) continue;
    const key = record.targetType + ':' + targetId;
    const existing = index.get(key) || [];
    existing.push({
      ...record,
      evidenceIds: [...new Set(record.evidenceIds.map((value) => String(value || '').trim()).filter(Boolean))],
    });
    index.set(key, existing);
  }
  return index;
}

function isStrongMutationVerification(method: AgentVerificationMethod): boolean {
  return method === 'deterministic'
    || method === 'follow-up-read'
    || method === 'kernel-predicate'
    || method === 'external-receipt';
}

function statusValue(observed: unknown): unknown {
  if (observed && typeof observed === 'object' && !Array.isArray(observed)) {
    return (observed as Record<string, unknown>).status;
  }
  return observed;
}

function containsValue(observed: unknown, expected: unknown): boolean {
  if (typeof observed === 'string') return observed.includes(String(expected));
  if (Array.isArray(observed)) return observed.some((entry) => deepEqual(entry, expected));
  if (observed && typeof observed === 'object' && typeof expected === 'string') {
    return expected in (observed as Record<string, unknown>);
  }
  return false;
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    return stableJson(left) === stableJson(right);
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map((key) => (
      JSON.stringify(key) + ':' + stableJson(record[key])
    )).join(',') + '}';
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'undefined' : serialized;
}

function normalizeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('Agent verifier requires a ' + label + ' id.');
  return normalized;
}

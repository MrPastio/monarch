import type {
  MonarchActionPredicate,
  MonarchActionPredicateJsonValue,
  MonarchCapability,
} from '../core/contracts';
import { resolveAgentCapabilityMetadata } from '../core/capability-metadata';
import { actionPredicateValueError } from '../core/action-predicate';
import { validateAgentJsonSchema } from './strict-json-schema';
import { findAgentContextSecretPath } from './context-compiler';

export type AgentExecutableDecisionKind = 'inspect' | 'act';

export interface AgentExecutableDecision {
  kind: AgentExecutableDecisionKind;
  capabilityId: string;
  input: Record<string, unknown>;
  reason: string;
  expectedEffect: string;
  preconditions?: MonarchActionPredicate[];
  verification?: MonarchActionPredicate[];
}

export interface AgentAskUserDecision {
  kind: 'ask-user';
  question: string;
  reason: string;
}

export interface AgentWaitRuntimeDecision {
  kind: 'wait-runtime';
  runtimeId: string;
  reason: string;
}

export interface AgentRevisePlanDecision {
  kind: 'revise-plan';
  summary: string;
  steps: Array<{ title: string; expectedEffect: string }>;
  reason: string;
}

export interface AgentCompleteDecision {
  kind: 'complete';
  summary: string;
  evidenceObservationIds: string[];
  artifactIds: string[];
  evidenceBindings: AgentCompletionEvidenceBinding[];
}

export interface AgentCompletionEvidenceBinding {
  targetType: 'expected-output' | 'success-criterion';
  targetId: string;
  observationIds: string[];
  artifactIds: string[];
}

export interface AgentFailDecision {
  kind: 'fail';
  code: string;
  reason: string;
}

export type AgentDecision =
  | AgentExecutableDecision
  | AgentAskUserDecision
  | AgentWaitRuntimeDecision
  | AgentRevisePlanDecision
  | AgentCompleteDecision
  | AgentFailDecision;

export interface AgentDecisionValidationContext {
  candidates: readonly MonarchCapability[];
}

export class AgentDecisionValidationError extends Error {
  readonly code: string;
  readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'AgentDecisionValidationError';
    this.code = code;
    this.details = details;
  }
}

export function parseAgentDecision(
  raw: string,
  context: AgentDecisionValidationContext,
): AgentDecision {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new AgentDecisionValidationError('invalid-json-envelope', 'Decision must be one complete JSON object.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AgentDecisionValidationError('invalid-json', 'Decision is not valid JSON.');
  }
  if (!isRecord(parsed)) {
    throw new AgentDecisionValidationError('invalid-decision', 'Decision must be an object.');
  }
  const secretPath = findAgentContextSecretPath(parsed, 'decision');
  if (secretPath) {
    throw new AgentDecisionValidationError(
      'secret-bearing-decision',
      `${secretPath} is a forbidden secret-bearing field or contains secret-like material.`,
    );
  }

  const kind = boundedString(parsed.kind, 'kind', 32);
  switch (kind) {
  case 'inspect':
  case 'act':
    return parseExecutable(kind, parsed, context);
  case 'ask-user':
    assertExactKeys(parsed, ['kind', 'question', 'reason']);
    return {
      kind,
      question: boundedString(parsed.question, 'question', 2_000),
      reason: boundedString(parsed.reason, 'reason', 1_000),
    };
  case 'wait-runtime':
    assertExactKeys(parsed, ['kind', 'runtimeId', 'reason']);
    return {
      kind,
      runtimeId: boundedId(parsed.runtimeId, 'runtimeId'),
      reason: boundedString(parsed.reason, 'reason', 1_000),
    };
  case 'revise-plan':
    return parsePlanRevision(parsed);
  case 'complete':
    assertExactKeys(parsed, ['kind', 'summary', 'evidenceObservationIds', 'artifactIds', 'evidenceBindings']);
    return {
      kind,
      summary: boundedString(parsed.summary, 'summary', 4_000),
      evidenceObservationIds: boundedIdArray(parsed.evidenceObservationIds, 'evidenceObservationIds', 50),
      artifactIds: boundedIdArray(parsed.artifactIds, 'artifactIds', 50),
      evidenceBindings: parseCompletionBindings(parsed.evidenceBindings),
    };
  case 'fail':
    assertExactKeys(parsed, ['kind', 'code', 'reason']);
    return {
      kind,
      code: boundedId(parsed.code, 'code'),
      reason: boundedString(parsed.reason, 'reason', 4_000),
    };
  default:
    throw new AgentDecisionValidationError('unknown-decision-kind', `Unsupported decision kind: ${kind}.`);
  }
}

function parseExecutable(
  kind: AgentExecutableDecisionKind,
  value: Record<string, unknown>,
  context: AgentDecisionValidationContext,
): AgentExecutableDecision {
  assertExactKeys(value, [
    'kind', 'capabilityId', 'input', 'reason', 'expectedEffect', 'preconditions', 'verification',
  ]);
  const capabilityId = boundedId(value.capabilityId, 'capabilityId');
  const capability = context.candidates.find((entry) => entry.id === capabilityId);
  if (!capability) {
    throw new AgentDecisionValidationError(
      'capability-not-in-candidate-set',
      `Capability ${capabilityId} is not in the current resolver result.`,
    );
  }
  if (!isRecord(value.input)) {
    throw new AgentDecisionValidationError('invalid-input', 'Executable decision input must be an object.');
  }
  assertNoSecretBearingInput(value.input);
  const schemaResult = validateAgentJsonSchema(value.input, capability.inputSchema, 'input');
  if (!schemaResult.ok) {
    throw new AgentDecisionValidationError('input-schema-invalid', 'Capability input does not match its schema.', schemaResult.errors);
  }

  const verification = value.verification === undefined
    ? undefined
    : parsePredicates(value.verification, 'verification');
  const metadata = resolveAgentCapabilityMetadata(capability);
  const mutating = metadata.effectProfile.mutation !== 'none';
  if (mutating && (!verification || verification.length === 0)) {
    throw new AgentDecisionValidationError(
      'verification-required',
      `Mutating capability ${capabilityId} requires deterministic verification.`,
    );
  }
  assertRequiredCapabilityVerification(capability, value.input, verification || []);
  const preconditions = value.preconditions === undefined
    ? undefined
    : parsePredicates(value.preconditions, 'preconditions');

  return {
    kind,
    capabilityId,
    input: cloneJson(value.input),
    reason: boundedString(value.reason, 'reason', 1_000),
    expectedEffect: boundedString(value.expectedEffect, 'expectedEffect', 1_000),
    ...(preconditions ? { preconditions } : {}),
    ...(verification ? { verification } : {}),
  };
}

function parseCompletionBindings(value: unknown): AgentCompletionEvidenceBinding[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new AgentDecisionValidationError(
      'invalid-completion-bindings',
      'evidenceBindings must contain 1-64 explicit target bindings.',
    );
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new AgentDecisionValidationError('invalid-completion-binding', `evidenceBindings[${index}] must be an object.`);
    }
    assertExactKeys(entry, ['targetType', 'targetId', 'observationIds', 'artifactIds'], `evidenceBindings[${index}]`);
    const targetType = boundedString(entry.targetType, `evidenceBindings[${index}].targetType`, 32);
    if (targetType !== 'expected-output' && targetType !== 'success-criterion') {
      throw new AgentDecisionValidationError(
        'invalid-completion-binding-target',
        `evidenceBindings[${index}].targetType is unsupported.`,
      );
    }
    const observationIds = boundedIdArray(entry.observationIds, `evidenceBindings[${index}].observationIds`, 50);
    const artifactIds = boundedIdArray(entry.artifactIds, `evidenceBindings[${index}].artifactIds`, 50);
    if (observationIds.length === 0) {
      throw new AgentDecisionValidationError(
        'empty-completion-binding',
        `evidenceBindings[${index}] must reference at least one factual observation.`,
      );
    }
    return {
      targetType,
      targetId: boundedId(entry.targetId, `evidenceBindings[${index}].targetId`),
      observationIds,
      artifactIds,
    };
  });
}

function assertRequiredCapabilityVerification(
  capability: MonarchCapability,
  input: Record<string, unknown>,
  predicates: MonarchActionPredicate[],
): void {
  const required = resolveAgentCapabilityMetadata(capability).verification.filter((entry) => entry.required === true);
  if (required.length === 0) return;
  const target = actionTarget(input);
  const targetPredicates = target
    ? predicates.filter((predicate) => normalizeTarget(predicate.target) === normalizeTarget(target))
    : predicates;
  for (const descriptor of required) {
    let satisfied = false;
    switch (descriptor.kind) {
    case 'predicate':
      satisfied = targetPredicates.length > 0;
      break;
    case 'read-after-write':
      satisfied = targetPredicates.some((predicate) => predicate.kind === 'exists')
        && targetPredicates.some((predicate) => predicate.kind === 'contains' || predicate.kind === 'equals');
      break;
    case 'schema':
      satisfied = Boolean(capability.outputSchema);
      break;
    case 'runtime-status':
    case 'external-receipt':
      satisfied = targetPredicates.some((predicate) => predicate.kind === 'status');
      break;
    }
    if (!satisfied) {
      throw new AgentDecisionValidationError(
        'capability-verification-required',
        `Capability ${capability.id} requires ${descriptor.kind} verification bound to its action target.`,
      );
    }
  }
}

function actionTarget(input: Record<string, unknown>): string {
  for (const key of ['path', 'targetPath', 'url', 'resourceId', 'id']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLocaleLowerCase('en-US');
}

function parsePlanRevision(value: Record<string, unknown>): AgentRevisePlanDecision {
  assertExactKeys(value, ['kind', 'summary', 'steps', 'reason']);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 20) {
    throw new AgentDecisionValidationError('invalid-plan-steps', 'Plan revision must contain 1-20 steps.');
  }
  const steps = value.steps.map((step, index) => {
    if (!isRecord(step)) throw new AgentDecisionValidationError('invalid-plan-step', `steps[${index}] must be an object.`);
    assertExactKeys(step, ['title', 'expectedEffect'], `steps[${index}]`);
    return {
      title: boundedString(step.title, `steps[${index}].title`, 500),
      expectedEffect: boundedString(step.expectedEffect, `steps[${index}].expectedEffect`, 1_000),
    };
  });
  return {
    kind: 'revise-plan',
    summary: boundedString(value.summary, 'summary', 2_000),
    steps,
    reason: boundedString(value.reason, 'reason', 1_000),
  };
}

function parsePredicates(value: unknown, field: string): MonarchActionPredicate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new AgentDecisionValidationError('invalid-predicates', `${field} must contain 1-20 predicates.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new AgentDecisionValidationError('invalid-predicate', `${field}[${index}] must be an object.`);
    assertExactKeys(entry, ['kind', 'target', 'value'], `${field}[${index}]`);
    const predicateKind = boundedString(entry.kind, `${field}[${index}].kind`, 32);
    if (!['exists', 'not-exists', 'equals', 'contains', 'status'].includes(predicateKind)) {
      throw new AgentDecisionValidationError('invalid-predicate-kind', `${field}[${index}].kind is unsupported.`);
    }
    const valueError = actionPredicateValueError(entry);
    if (valueError) {
      throw new AgentDecisionValidationError('invalid-predicate-value', `${field}[${index}] ${valueError}`);
    }
    const target = boundedString(entry.target, `${field}[${index}].target`, 2_000);
    switch (predicateKind) {
    case 'exists':
    case 'not-exists':
      return { kind: predicateKind, target };
    case 'equals':
    case 'contains':
      return { kind: predicateKind, target, value: cloneJson(entry.value) as MonarchActionPredicateJsonValue };
    case 'status':
      return { kind: predicateKind, target, value: entry.value as string | number | boolean };
    default:
      throw new AgentDecisionValidationError('invalid-predicate-kind', `${field}[${index}].kind is unsupported.`);
    }
  });
}

function assertNoSecretBearingInput(value: unknown): void {
  const path = findAgentContextSecretPath(value, 'input');
  if (path) {
    throw new AgentDecisionValidationError(
      'secret-bearing-input',
      `${path} is a forbidden secret-bearing field or contains secret-like material.`,
    );
  }
}

function assertExactKeys(value: Record<string, unknown>, allowedKeys: readonly string[], path = 'decision'): void {
  const allowed = new Set(allowedKeys);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    throw new AgentDecisionValidationError('unexpected-decision-field', `${path} contains unexpected fields: ${extras.join(', ')}.`);
  }
}

function boundedId(value: unknown, field: string): string {
  const id = boundedString(value, field, 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(id)) {
    throw new AgentDecisionValidationError('invalid-id', `${field} is not a valid identifier.`);
  }
  return id;
}

function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new AgentDecisionValidationError('invalid-field', `${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AgentDecisionValidationError('invalid-field', `${field} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function boundedIdArray(value: unknown, field: string, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new AgentDecisionValidationError('invalid-field', `${field} must be an array with at most ${maxLength} entries.`);
  }
  return value.map((entry, index) => boundedId(entry, `${field}[${index}]`));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

import type {
  MonarchActionPredicate,
  MonarchActionPredicateJsonValue,
  MonarchCapability,
  MonarchJsonSchema,
} from '../core/contracts';
import { resolveAgentCapabilityMetadata } from '../core/capability-metadata';
import { actionPredicateValueError } from '../core/action-predicate';
import { validateAgentJsonSchema } from './strict-json-schema';
import { findAgentContextSecretPath } from './context-compiler';

export const AGENT_DECISION_SCHEMA_VERSION = 'monarch.agent-decision.v1' as const;

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

export interface AgentDiscoverToolsDecision {
  kind: 'discover-tools';
  query: string;
  reason: string;
}

export interface AgentRespondDecision {
  kind: 'respond';
  answer: string;
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
  | AgentDiscoverToolsDecision
  | AgentRespondDecision
  | AgentRevisePlanDecision
  | AgentCompleteDecision
  | AgentFailDecision;

/**
 * Revalidate a runtime-compiled input and atomically rebuild every
 * capability-owned postcondition from that input. Model preconditions are
 * intentionally discarded because they may refer to the superseded target.
 */
export function rebindAgentExecutableDecisionInput(
  decision: AgentExecutableDecision,
  capability: MonarchCapability,
  input: Record<string, unknown>,
): AgentExecutableDecision {
  assertNoSecretBearingInput(input);
  const canonicalInput = omitSchemaInvalidOptionalNulls(input, capability.inputSchema);
  const schemaResult = validateAgentJsonSchema(canonicalInput, capability.inputSchema, 'input');
  if (!schemaResult.ok) {
    throw new AgentDecisionValidationError(
      'runtime-bound-input-schema-invalid',
      'Runtime-compiled capability input does not match its schema.',
      schemaResult.errors,
    );
  }
  const contractOwned = requiredVerificationIsContractOwned(capability, canonicalInput);
  const verification = contractOwned
    ? deriveRequiredCapabilityVerification(capability, canonicalInput)
    : canonicalizeRequiredCapabilityVerification(capability, canonicalInput, decision.verification || []);
  assertRequiredCapabilityVerification(capability, canonicalInput, verification);
  if (
    resolveAgentCapabilityMetadata(capability).effectProfile.mutation !== 'none'
    && verification.length === 0
  ) {
    throw new AgentDecisionValidationError(
      'verification-required',
      `Mutating capability ${capability.id} requires deterministic verification.`,
    );
  }
  return {
    kind: decision.kind,
    capabilityId: decision.capabilityId,
    input: cloneJson(canonicalInput),
    reason: decision.reason,
    expectedEffect: decision.expectedEffect,
    ...(verification.length > 0 ? { verification } : {}),
  };
}

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

  // The runtime records the parser contract version on every model.completed
  // event. Explicitly versioned envelopes are accepted, while unversioned
  // envelopes remain readable for replay/repair compatibility.
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== AGENT_DECISION_SCHEMA_VERSION) {
    throw new AgentDecisionValidationError(
      'unsupported-decision-schema-version',
      `Unsupported agent decision schemaVersion: ${String(parsed.schemaVersion)}.`,
    );
  }
  const decision = { ...parsed };
  delete decision.schemaVersion;

  const kind = boundedString(decision.kind, 'kind', 32);
  switch (kind) {
  case 'inspect':
  case 'act':
    return parseExecutable(kind, decision, context);
  case 'ask-user':
    assertExactKeys(decision, ['kind', 'question', 'reason']);
    return {
      kind,
      question: boundedString(decision.question, 'question', 2_000),
      reason: boundedString(decision.reason, 'reason', 1_000),
    };
  case 'wait-runtime':
    assertExactKeys(decision, ['kind', 'runtimeId', 'reason']);
    return {
      kind,
      runtimeId: boundedId(decision.runtimeId, 'runtimeId'),
      reason: boundedString(decision.reason, 'reason', 1_000),
    };
  case 'discover-tools':
    assertExactKeys(decision, ['kind', 'query', 'reason']);
    return {
      kind,
      query: boundedString(decision.query, 'query', 1_000),
      reason: boundedString(decision.reason, 'reason', 1_000),
    };
  case 'respond':
    assertExactKeys(decision, ['kind', 'answer']);
    return {
      kind,
      answer: boundedString(decision.answer, 'answer', 16_000),
    };
  case 'revise-plan':
    return parsePlanRevision(decision);
  case 'complete':
    assertExactKeys(decision, ['kind', 'summary', 'evidenceObservationIds', 'artifactIds', 'evidenceBindings']);
    return {
      kind,
      summary: boundedString(decision.summary, 'summary', 4_000),
      evidenceObservationIds: boundedIdArray(decision.evidenceObservationIds, 'evidenceObservationIds', 50),
      artifactIds: boundedIdArray(decision.artifactIds, 'artifactIds', 50),
      evidenceBindings: parseCompletionBindings(decision.evidenceBindings),
    };
  case 'fail':
    assertExactKeys(decision, ['kind', 'code', 'reason']);
    return {
      kind,
      code: boundedId(decision.code, 'code'),
      reason: boundedString(decision.reason, 'reason', 4_000),
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
  const suppliedCapabilityId = boundedId(value.capabilityId, 'capabilityId');
  const capability = resolveCandidateCapability(suppliedCapabilityId, context.candidates);
  if (!capability) {
    throw new AgentDecisionValidationError(
      'capability-not-in-candidate-set',
      `Capability ${suppliedCapabilityId} is not in the current resolver result.`,
    );
  }
  const capabilityId = capability.id;
  if (!isRecord(value.input)) {
    throw new AgentDecisionValidationError('invalid-input', 'Executable decision input must be an object.');
  }
  assertNoSecretBearingInput(value.input);
  if (capability.id === 'models.agent.synthesize') {
    const runtimeOwned = Object.keys(value.input).filter((key) => key !== 'observationIds');
    if (runtimeOwned.length > 0) {
      throw new AgentDecisionValidationError(
        'runtime-owned-synthesis-input',
        `models.agent.synthesize input contains runtime-owned fields: ${runtimeOwned.join(', ')}.`,
      );
    }
  }
  const canonicalInput = omitSchemaInvalidOptionalNulls(value.input, capability.inputSchema);
  const schemaResult = validateAgentJsonSchema(canonicalInput, capability.inputSchema, 'input');
  if (!schemaResult.ok) {
    throw new AgentDecisionValidationError('input-schema-invalid', 'Capability input does not match its schema.', schemaResult.errors);
  }

  const metadata = resolveAgentCapabilityMetadata(capability);
  const contractVerification = deriveRequiredCapabilityVerification(capability, canonicalInput);
  const contractOwnsVerification = requiredVerificationIsContractOwned(capability, canonicalInput);
  const proposedVerification = contractOwnsVerification || value.verification === undefined
    ? []
    : parsePredicates(value.verification, 'verification');
  const verification = contractOwnsVerification
    ? contractVerification
    : canonicalizeRequiredCapabilityVerification(capability, canonicalInput, proposedVerification);
  const mutating = metadata.effectProfile.mutation !== 'none';
  if (kind === 'inspect' && mutating) {
    throw new AgentDecisionValidationError(
      'decision-kind-risk-mismatch',
      `Capability ${capabilityId} mutates state and cannot execute under an inspect decision.`,
    );
  }
  const canonicalKind: AgentExecutableDecisionKind = mutating ? 'act' : 'inspect';
  if (mutating && verification.length === 0) {
    throw new AgentDecisionValidationError(
      'verification-required',
      `Mutating capability ${capabilityId} requires deterministic verification.`,
    );
  }
  assertRequiredCapabilityVerification(capability, canonicalInput, verification || []);
  const preconditions = value.preconditions === undefined
    ? undefined
    : parsePredicates(value.preconditions, 'preconditions');

  return {
    kind: canonicalKind,
    capabilityId,
    input: cloneJson(canonicalInput),
    reason: value.reason === undefined ? 'direct' : boundedString(value.reason, 'reason', 1_000),
    expectedEffect: value.expectedEffect === undefined
      ? 'verified'
      : boundedString(value.expectedEffect, 'expectedEffect', 1_000),
    ...(preconditions ? { preconditions } : {}),
    ...(verification.length > 0 ? { verification } : {}),
  };
}

function resolveCandidateCapability(
  suppliedCapabilityId: string,
  candidates: readonly MonarchCapability[],
): MonarchCapability | undefined {
  const exact = candidates.find((entry) => entry.id === suppliedCapabilityId);
  if (exact) return exact;
  const normalized = normalizeCapabilityIdSeparators(suppliedCapabilityId);
  const matches = candidates.filter(
    (entry) => normalizeCapabilityIdSeparators(entry.id) === normalized,
  );
  // Local models occasionally exchange '-' and '_' inside an otherwise exact
  // supplied ID. Canonicalize only a unique current candidate; collisions and
  // invented IDs remain fail-closed.
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeCapabilityIdSeparators(value: string): string {
  return value.replace(/[-_]/gu, '-');
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
  const contractPredicates = deriveRequiredCapabilityVerification(capability, input);
  const hasCapabilityOwnedPredicate = contractPredicates.some((contractPredicate) => (
    predicates.some((predicate) => samePredicate(predicate, contractPredicate))
  ));
  for (const descriptor of required) {
    let satisfied = descriptor.predicate
      ? predicates.some((predicate) => samePredicate(predicate, descriptor.predicate as MonarchActionPredicate))
      : false;
    if (!descriptor.predicate) {
      switch (descriptor.kind) {
      case 'predicate':
        satisfied = targetPredicates.length > 0 || hasCapabilityOwnedPredicate;
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
        satisfied = predicates.some((predicate) => predicate.kind === 'status');
        break;
      }
    }
    if (!satisfied) {
      throw new AgentDecisionValidationError(
        'capability-verification-required',
        `Capability ${capability.id} requires ${descriptor.kind} verification bound to its action target.`,
      );
    }
  }
}

function canonicalizeRequiredCapabilityVerification(
  capability: MonarchCapability,
  input: Record<string, unknown>,
  predicates: MonarchActionPredicate[],
): MonarchActionPredicate[] {
  const derived = deriveRequiredCapabilityVerification(capability, input);
  const required = resolveAgentCapabilityMetadata(capability).verification.filter((entry) => entry.required === true);
  const target = actionTarget(input);
  if (!target || !required.some((entry) => entry.kind === 'read-after-write')) {
    return [...predicates, ...derived].filter(uniquePredicate);
  }
  const content = input.content;
  if (typeof content !== 'string') return predicates;

  // The capability contract, not model prose, owns the safety-critical
  // postcondition. Replace potentially malformed file predicates with an
  // exact read-after-write check derived from the schema-valid action input.
  const retained = predicates.filter((predicate) => (
    predicate.kind === 'status'
    || predicate.target === 'result'
    || predicate.target.startsWith('result.')
  ));
  return [
    ...retained,
    ...derived,
  ];
}

function deriveRequiredCapabilityVerification(
  capability: MonarchCapability,
  input: Record<string, unknown>,
): MonarchActionPredicate[] {
  const required = resolveAgentCapabilityMetadata(capability).verification.filter((entry) => entry.required === true);
  const target = actionTarget(input);
  const predicates: MonarchActionPredicate[] = [];
  for (const descriptor of required) {
    if (descriptor.predicate) {
      predicates.push(structuredClone(descriptor.predicate));
      continue;
    }
    if (descriptor.kind === 'read-after-write' && target && typeof input.content === 'string') {
      predicates.push(
        { kind: 'exists', target },
        { kind: 'equals', target, value: input.content },
      );
    }
  }
  return predicates.filter(uniquePredicate);
}

function requiredVerificationIsContractOwned(
  capability: MonarchCapability,
  input: Record<string, unknown>,
): boolean {
  const required = resolveAgentCapabilityMetadata(capability).verification.filter((entry) => entry.required === true);
  const target = actionTarget(input);
  const derived = deriveRequiredCapabilityVerification(capability, input);
  return required.length > 0 && required.every((descriptor) => (
    descriptor.kind === 'schema'
    || (descriptor.kind === 'predicate' && derived.length > 0)
    || Boolean(descriptor.predicate)
    || (
      descriptor.kind === 'read-after-write'
      && Boolean(target)
      && typeof input.content === 'string'
    )
  ));
}

function uniquePredicate(
  predicate: MonarchActionPredicate,
  index: number,
  predicates: MonarchActionPredicate[],
): boolean {
  return predicates.findIndex((candidate) => samePredicate(candidate, predicate)) === index;
}

function samePredicate(left: MonarchActionPredicate, right: MonarchActionPredicate): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  if (value.plan !== undefined) {
    // Some local models preserve the decision kind but wrap the non-executable
    // plan payload once. Normalize only this exact benign planning envelope;
    // executable decisions and ambiguous mixed shapes remain strict.
    assertExactKeys(value, ['kind', 'plan', 'reason']);
    if (!isRecord(value.plan)) {
      throw new AgentDecisionValidationError('invalid-plan-wrapper', 'plan must be an object.');
    }
    assertExactKeys(value.plan, ['summary', 'steps'], 'plan');
    return parsePlanRevision({
      kind: 'revise-plan',
      summary: value.plan.summary,
      steps: value.plan.steps,
      reason: value.reason,
    });
  }
  assertExactKeys(value, ['kind', 'summary', 'steps', 'reason']);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 20) {
    throw new AgentDecisionValidationError('invalid-plan-steps', 'Plan revision must contain 1-20 steps.');
  }
  const steps = value.steps.map((step, index) => {
    if (!isRecord(step)) throw new AgentDecisionValidationError('invalid-plan-step', `steps[${index}] must be an object.`);
    // Plan steps are non-executable. Local structured-output models sometimes
    // mirror action-shaped fields into a plan after inspecting live state.
    // Accept only this closed inert set, then discard every mirrored field.
    // Capability execution still requires a separate strict inspect/act
    // decision, so none of these values can become authority or tool input.
    assertExactKeys(step, [
      'id',
      'title',
      'expectedEffect',
      'capabilityId',
      'input',
      'preconditions',
      'verification',
      'status',
      'dependsOn',
      'reason',
    ], `steps[${index}]`);
    if (step.id !== undefined && !(
      (typeof step.id === 'string' && step.id.length <= 160)
      || (typeof step.id === 'number' && Number.isSafeInteger(step.id))
    )) {
      throw new AgentDecisionValidationError(
        'invalid-plan-step-id',
        `steps[${index}].id must be a bounded scalar when supplied.`,
      );
    }
    if (step.reason !== undefined) {
      boundedString(step.reason, `steps[${index}].reason`, 1_000);
    }
    return {
      title: boundedString(step.title, `steps[${index}].title`, 500),
      expectedEffect: boundedString(step.expectedEffect, `steps[${index}].expectedEffect`, 1_000),
    };
  });
  const summary = boundedString(value.summary, 'summary', 2_000);
  return {
    kind: 'revise-plan',
    summary,
    steps,
    // `reason` is audit-only metadata for a non-executable decision. Local
    // structured-output models occasionally omit it while returning a complete
    // schema-valid plan. Canonicalize only that single omission so the runtime
    // does not spend another full model turn repairing text that grants no
    // authority and changes no effect.
    reason: value.reason === undefined
      ? 'Model-authored plan revision.'
      : boundedString(value.reason, 'reason', 1_000),
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

/**
 * Weak local models often serialize absent optional arguments as `null`.
 * A null that the declared schema rejects has no executable meaning, so an
 * optional known property can be omitted without inventing a value. Required,
 * nullable and unknown properties remain untouched and therefore fail closed
 * under the ordinary schema validator when invalid.
 */
function omitSchemaInvalidOptionalNulls(
  input: Record<string, unknown>,
  schema: MonarchJsonSchema | undefined,
): Record<string, unknown> {
  const normalized = normalizeSchemaValue(input, schema);
  return isRecord(normalized) ? normalized : cloneJson(input);
}

function normalizeSchemaValue(value: unknown, schema: MonarchJsonSchema | undefined): unknown {
  if (!schema) return cloneJson(value);
  if (Array.isArray(value)) {
    const itemSchema = isRecord(schema.items) ? schema.items as MonarchJsonSchema : undefined;
    return value.map((entry) => normalizeSchemaValue(entry, itemSchema));
  }
  if (!isRecord(value)) return cloneJson(value);

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === 'string')
    : []);
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = isRecord(properties[key])
      ? properties[key] as MonarchJsonSchema
      : undefined;
    if (
      entry === null
      && propertySchema
      && !required.has(key)
      && !validateAgentJsonSchema(null, propertySchema, 'optional').ok
    ) {
      continue;
    }
    normalized[key] = normalizeSchemaValue(entry, propertySchema);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

import type { MonarchExecutionResult, MonarchJsonSchema } from '../core/contracts';
import { createMonarchId } from '../core/utils';
import { redactAgentContextValue } from './context-compiler';
import {
  AGENT_OBSERVATION_SCHEMA_VERSION,
  type AgentArtifactReference,
  type AgentEvidenceReference,
  type AgentJsonObject,
  type AgentJsonValue,
  type AgentObservation,
  type AgentObservationStatus,
} from './types';
import { validateAgentJsonSchema } from './strict-json-schema';

export interface AgentActualSideEffect {
  kind: string;
  summary: string;
  target?: string;
}

export interface AgentMutationTruth {
  state: 'occurred' | 'rolled-back' | 'no-effect' | 'unknown';
  source: 'reported-side-effect' | 'kernel-journal' | 'kernel-receipt' | 'pre-execution-receipt' | 'missing-receipt';
  summary: string;
}

export interface NormalizeAgentObservationInput {
  observationId?: string;
  taskId: string;
  stepId?: string;
  actionAttemptId: string;
  actionTarget?: string;
  executionId: string;
  capabilityId: string;
  moduleId: string;
  ledgerId?: string;
  startedAt: string;
  completedAt: string;
  result: MonarchExecutionResult;
  outputSchema?: MonarchJsonSchema;
  mutation?: 'none' | 'temporary' | 'persistent';
  actualSideEffects?: AgentActualSideEffect[];
  retryable?: boolean;
}

export function normalizeAgentObservation(
  input: NormalizeAgentObservationInput,
): AgentObservation {
  const observationId = normalizeRequiredId(input.observationId || createMonarchId('observation'), 'observation');
  const taskId = normalizeRequiredId(input.taskId, 'task');
  const actionAttemptId = normalizeRequiredId(input.actionAttemptId, 'action attempt');
  const executionId = normalizeRequiredId(input.executionId, 'execution');
  const capabilityId = normalizeRequiredId(input.capabilityId, 'capability');
  const moduleId = normalizeRequiredId(input.moduleId, 'module');
  const startedAt = normalizeIso(input.startedAt, 'start');
  const completedAt = normalizeIso(input.completedAt, 'completion');
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));

  const schema = input.outputSchema
    ? validateAgentJsonSchema(input.result.output, input.outputSchema, 'output')
    : null;
  const kernelVerification = normalizeKernelVerification(input.result.metadata?.observations);
  const reportedSideEffects = sanitizeSideEffects(input.actualSideEffects || []);
  const derivedMutationTruth = deriveAgentMutationTruth(input, reportedSideEffects);
  const mutationTruth = derivedMutationTruth
    ? { ...derivedMutationTruth, summary: sanitizeString(derivedMutationTruth.summary, 1_000) }
    : undefined;
  const sideEffects = reportedSideEffects.length > 0
    ? reportedSideEffects
    : synthesizeReceiptSideEffect(input, mutationTruth);
  const error = input.result.error
    ? sanitizeString(input.result.error, 1_000)
    : input.result.ok ? '' : 'execution-failed-without-error-code';
  const warnings = sanitizeWarnings(input.result.metadata?.warnings);
  if (input.mutation && input.mutation !== 'none' && mutationTruth?.state === 'unknown') {
    warnings.push('Kernel receipt could not prove whether the mutating capability changed its target.');
  }
  if (schema && !schema.ok) warnings.push('Output cannot be trusted as schema-valid evidence.');

  const evidence = buildEvidence(
    observationId,
    executionId,
    capabilityId,
    schema,
    kernelVerification,
    sideEffects,
    error,
  );
  const status = observationStatus(input.result, schema?.ok, input.mutation, sideEffects.length);
  const structuredData = toAgentJsonObject({
    trust: 'untrusted-tool-output',
    instructionsAllowed: false,
    output: input.result.output === undefined ? null : redactAgentContextValue(input.result.output).value,
    provenance: {
      executionId,
      actionAttemptId,
      ...(input.actionTarget ? { actionTarget: sanitizeString(input.actionTarget, 2_000) } : {}),
      moduleId,
      capabilityId,
      startedAt,
      completedAt,
      durationMs,
      ...(input.ledgerId ? { ledgerId: normalizeRequiredId(input.ledgerId, 'ledger') } : {}),
    },
    outputSchema: {
      declared: Boolean(input.outputSchema),
      valid: schema ? schema.ok : null,
      errors: schema ? schema.errors.slice(0, 20).map((entry) => sanitizeString(entry, 1_000)) : [],
    },
    ...(error ? { error } : {}),
    sideEffects,
    ...(mutationTruth ? { mutationTruth } : {}),
    kernelVerification,
  });

  return {
    schemaVersion: AGENT_OBSERVATION_SCHEMA_VERSION,
    id: observationId,
    taskId,
    ...(input.stepId ? { stepId: normalizeRequiredId(input.stepId, 'step') } : {}),
    capabilityId,
    status,
    summary: sanitizeString(input.result.summary || error || 'Capability returned no summary.', 2_000),
    structuredData,
    evidence,
    artifacts: normalizeArtifacts(input.result.metadata?.artifacts),
    warnings: [...new Set(warnings)],
    retryable: input.retryable ?? inferRetryability(status, error),
    ...(toStateDelta(input.result.metadata?.stateDelta)),
    occurredAt: completedAt,
  };
}

export function deriveAgentMutationTruth(
  input: Pick<NormalizeAgentObservationInput, 'result' | 'mutation' | 'ledgerId'>,
  actualSideEffects: readonly AgentActualSideEffect[] = [],
): AgentMutationTruth | undefined {
  if (!input.mutation || input.mutation === 'none') return undefined;
  if (actualSideEffects.length > 0) {
    return {
      state: 'occurred',
      source: 'reported-side-effect',
      summary: 'The capability reported a concrete side effect.',
    };
  }

  const ledger = readRecord(input.result.metadata?.ledger);
  const rollback = readRecord(ledger?.rollback);
  const rollbackStatus = typeof rollback?.status === 'string' ? rollback.status : '';
  const rollbackReason = typeof rollback?.reason === 'string' ? rollback.reason : '';
  if (rollbackStatus === 'available' || rollbackStatus === 'blocked') {
    return {
      state: 'occurred',
      source: 'kernel-journal',
      summary: rollbackReason || 'Kernel journal proves that the target changed.',
    };
  }
  if (rollbackStatus === 'rolled-back') {
    return {
      state: 'rolled-back',
      source: 'kernel-journal',
      summary: rollbackReason || 'Kernel journal proves that a mutation occurred and was rolled back.',
    };
  }
  if (rollbackStatus === 'unavailable' && provesNoEffect(rollbackReason)) {
    return {
      state: 'no-effect',
      source: 'kernel-journal',
      summary: rollbackReason,
    };
  }
  if (rollbackStatus === 'unavailable') {
    return {
      state: 'unknown',
      source: 'kernel-journal',
      summary: rollbackReason || 'Kernel journal could not establish the post-action target state.',
    };
  }

  const ledgerId = typeof ledger?.ledgerId === 'string' ? ledger.ledgerId : input.ledgerId || '';
  if (input.result.ok && ledgerId) {
    return {
      state: 'occurred',
      source: 'kernel-receipt',
      summary: 'Kernel ledger recorded successful completion of the mutating capability.',
    };
  }
  if (input.result.error === 'verification-failed' && ledgerId) {
    return {
      state: 'occurred',
      source: 'kernel-receipt',
      summary: 'Kernel receipt proves the action completed before its postcondition failed.',
    };
  }
  if (provesPreExecutionFailure(input.result.error)) {
    return {
      state: 'no-effect',
      source: 'pre-execution-receipt',
      summary: 'Kernel rejected the action before capability execution.',
    };
  }
  return {
    state: 'unknown',
    source: 'missing-receipt',
    summary: 'No Kernel receipt proves either a mutation or an unchanged target.',
  };
}

function synthesizeReceiptSideEffect(
  input: NormalizeAgentObservationInput,
  truth: AgentMutationTruth | undefined,
): AgentActualSideEffect[] {
  if (!truth || (truth.state !== 'occurred' && truth.state !== 'rolled-back')) return [];
  return [{
    kind: truth.state === 'rolled-back' ? `${input.mutation || 'mutation'}-rolled-back` : input.mutation || 'mutation',
    summary: sanitizeString(truth.summary, 1_000),
    ...(input.actionTarget ? { target: sanitizeString(input.actionTarget, 1_000) } : {}),
  }];
}

function provesNoEffect(reason: string): boolean {
  return /without changing|was not changed|target does not exist|no changes? (?:were )?(?:made|applied)/i.test(reason);
}

function provesPreExecutionFailure(error: string | undefined): boolean {
  return new Set([
    'action-already-running',
    'confirmation-required',
    'idempotency-conflict',
    'permission-denied',
    'policy-denied',
    'precondition-failed',
    'rollback-snapshot-failed',
    'schema-validation-failed',
  ]).has(String(error || ''));
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function buildEvidence(
  observationId: string,
  executionId: string,
  capabilityId: string,
  schema: ReturnType<typeof validateAgentJsonSchema> | null,
  kernelVerification: Array<{ ok: boolean; code: string; message: string }>,
  sideEffects: AgentActualSideEffect[],
  error: string,
): AgentEvidenceReference[] {
  const evidence: AgentEvidenceReference[] = [{
    kind: 'api',
    reference: 'execution:' + executionId,
    summary: 'Kernel execution provenance for ' + capabilityId + '.',
  }];
  if (schema) {
    evidence.push({
      kind: 'other',
      reference: 'observation:' + observationId + ':output-schema',
      summary: schema.ok
        ? 'Capability output matches its declared schema.'
        : sanitizeString('Capability output schema failed: ' + schema.errors.slice(0, 5).join(' '), 1_000),
    });
  }
  kernelVerification.forEach((entry, index) => evidence.push({
    kind: 'other',
    reference: 'execution:' + executionId + ':verification:' + String(index + 1),
    summary: (entry.ok ? 'Verified: ' : 'Verification failed: ') + entry.message,
  }));
  sideEffects.forEach((entry, index) => evidence.push({
    kind: 'other',
    reference: 'execution:' + executionId + ':side-effect:' + String(index + 1),
    summary: entry.summary,
  }));
  if (error) {
    evidence.push({
      kind: 'other',
      reference: 'execution:' + executionId + ':error',
      summary: error,
    });
  }
  return evidence;
}

function observationStatus(
  result: MonarchExecutionResult,
  schemaOk: boolean | undefined,
  mutation: NormalizeAgentObservationInput['mutation'],
  sideEffectCount: number,
): AgentObservationStatus {
  if (/cancel|abort/i.test(String(result.error || ''))) return 'cancelled';
  if (!result.ok) return 'failed';
  if (schemaOk === false || result.metadata?.partial === true) return 'partial';
  if (mutation && mutation !== 'none' && sideEffectCount === 0) return 'partial';
  return 'success';
}

function normalizeKernelVerification(value: unknown): Array<{ ok: boolean; code: string; message: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.ok !== 'boolean') return [];
    return [{
      ok: record.ok,
      code: sanitizeString(typeof record.code === 'string' ? record.code : 'kernel-verification', 200),
      message: sanitizeString(
        typeof record.message === 'string' ? record.message : 'Kernel verification observation.',
        1_000,
      ),
    }];
  });
}

function sanitizeSideEffects(values: AgentActualSideEffect[]): AgentActualSideEffect[] {
  return values.slice(0, 32).map((value) => ({
    kind: sanitizeString(value.kind, 100),
    summary: sanitizeString(value.summary, 1_000),
    ...(value.target ? { target: sanitizeString(value.target, 1_000) } : {}),
  }));
}

function sanitizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, 32)
    .map((entry) => sanitizeString(entry, 1_000))
    .filter(Boolean);
}

function normalizeArtifacts(value: unknown): AgentArtifactReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.reference !== 'string') return [];
    const kind = isArtifactKind(record.kind) ? record.kind : 'other';
    return [{
      id: sanitizeString(record.id, 300),
      kind,
      label: sanitizeString(typeof record.label === 'string' ? record.label : record.id, 500),
      reference: sanitizeString(record.reference, 2_000),
      ...(typeof record.checksum === 'string' ? { checksum: sanitizeString(record.checksum, 300) } : {}),
      ...(typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
        ? { createdAt: new Date(Date.parse(record.createdAt)).toISOString() }
        : {}),
    }];
  });
}

function isArtifactKind(value: unknown): value is AgentArtifactReference['kind'] {
  return value === 'file'
    || value === 'directory'
    || value === 'url'
    || value === 'report'
    || value === 'image'
    || value === 'other';
}

function toStateDelta(value: unknown): { stateDelta: AgentJsonObject } | Record<string, never> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { stateDelta: toAgentJsonObject(redactAgentContextValue(value).value) };
}

function toAgentJsonObject(value: unknown): AgentJsonObject {
  const converted = toAgentJsonValue(value);
  if (!converted || typeof converted !== 'object' || Array.isArray(converted)) return {};
  return converted;
}

function toAgentJsonValue(value: unknown): AgentJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  return JSON.parse(serialized) as AgentJsonValue;
}

function sanitizeString(value: string, maxChars: number): string {
  const redacted = redactAgentContextValue(String(value || ''), { maxStringChars: maxChars }).value;
  return String(redacted).replace(/\s+/g, ' ').trim();
}

function inferRetryability(status: AgentObservationStatus, error: string): boolean {
  if (status === 'success' || status === 'cancelled') return false;
  return /timeout|temporar|busy|unavailable|connection|rate.?limit|retry/i.test(error);
}

function normalizeRequiredId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('Agent observation requires a ' + label + ' id.');
  return normalized.slice(0, 300);
}

function normalizeIso(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Agent observation ' + label + ' timestamp is invalid.');
  return new Date(timestamp).toISOString();
}

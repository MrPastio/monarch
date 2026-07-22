import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  MonarchActionExternality,
  MonarchActionNovelty,
  MonarchActionPredicate,
  MonarchActionPredicateJsonValue,
  MonarchActionProposalInput,
  MonarchActionProposalProvenance,
  MonarchActionProposalV1,
  MonarchActionReversibility,
  MonarchActionScope,
  MonarchActionScopeLevel,
  MonarchCapability,
  MonarchRisk,
  MonarchRiskVector,
} from './contracts';
import { actionPredicateValueError } from './action-predicate';
import { createMonarchId } from './utils';

const MAX_PROPOSAL_REASON_CHARS = 1_000;
const MAX_EXPECTED_EFFECT_CHARS = 1_000;
const MAX_PREDICATES = 16;
const MAX_SKILL_IDS = 8;

export interface NormalizeActionProposalOptions {
  capability: MonarchCapability;
  workspaceRoot: string;
  intentId?: string;
  originatingUserText?: string;
  requestedBy?: string;
  model?: string;
  skillIds?: string[];
  source?: MonarchActionProposalProvenance['source'];
}

export class MonarchActionProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MonarchActionProtocolError';
  }
}

export function normalizeActionProposal(
  value: MonarchActionProposalInput,
  options: NormalizeActionProposalOptions,
): MonarchActionProposalV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MonarchActionProtocolError('proposal-invalid', 'Action proposal must be an object.');
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new MonarchActionProtocolError('proposal-version-unsupported', 'Only Action Protocol version 1 is supported.');
  }

  const capabilityId = readBoundedString(value.capabilityId, 160);
  if (!capabilityId || capabilityId !== options.capability.id) {
    throw new MonarchActionProtocolError('proposal-capability-mismatch', 'Action proposal capability is unknown or mismatched.');
  }

  const argsValue = value.args ?? value.input ?? value.parameters ?? {};
  if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) {
    throw new MonarchActionProtocolError('proposal-args-invalid', 'Action proposal args must be a JSON object.');
  }
  const args = canonicalizeJsonObject(argsValue as Record<string, unknown>);
  const intentId = readBoundedString(value.intentId, 200)
    || readBoundedString(options.intentId, 200)
    || createMonarchId('intent_proposal');
  const originatingUserText = readBoundedString(options.originatingUserText, 8_000);
  const intentHash = sha256(stableStringify({ intentId, originatingUserText }));
  const proposalId = readBoundedString(value.proposalId, 200) || createMonarchId('proposal');
  const reason = readBoundedString(value.reason, MAX_PROPOSAL_REASON_CHARS)
    || `Use ${capabilityId} for the current user task.`;
  const riskVector = deriveRiskVector(options.capability, args);
  const scope = normalizeScope(value.scope, args, options.workspaceRoot, riskVector.scope);
  const reversibility = normalizeReversibility(value.reversibility, riskVector.reversibility);
  const expectedEffect = readBoundedString(value.expectedEffect, MAX_EXPECTED_EFFECT_CHARS)
    || describeExpectedEffect(options.capability.risk, capabilityId, scope);
  const provenance = normalizeProvenance(value.provenance, options);
  const preconditions = normalizePredicates(value.preconditions, 'preconditions');
  const verification = normalizePredicates(value.verification, 'verification');

  const actionIdentity = {
    version: 1,
    intentId,
    intentHash,
    capabilityId,
    args,
    scope,
    reversibility,
    riskVector,
  };
  const canonicalHash = sha256(stableStringify({
    ...actionIdentity,
    preconditions,
    verification,
  }));
  // The model cannot mint a fresh key to repeat the same exact action. The
  // canonical action itself is the idempotency identity for this user task.
  const idempotencyKey = `action:${sha256(stableStringify(actionIdentity))}`;

  return {
    version: 1,
    proposalId,
    intentId,
    intentHash,
    capabilityId,
    args,
    reason,
    expectedEffect,
    reversibility,
    scope,
    riskVector: { ...riskVector, reversibility },
    idempotencyKey,
    canonicalHash,
    ...(preconditions.length ? { preconditions } : {}),
    ...(verification.length ? { verification } : {}),
    provenance,
  };
}

export function deriveRiskVector(
  capability: Pick<MonarchCapability, 'id' | 'moduleId' | 'risk'>,
  args: Record<string, unknown>,
): MonarchRiskVector {
  const effect = riskEffect(capability.risk);
  const paths = extractActionPaths(args);
  const origins = extractActionOrigins(args);
  const recursive = args.recursive === true || Array.isArray(args.paths) || Array.isArray(args.targets);
  const scope: MonarchActionScopeLevel = origins.length > 0
    ? 'external'
    : recursive || paths.length > 2
      ? 'bounded-set'
      : paths.length > 0
        ? 'single-object'
        : capability.moduleId === 'workspace'
          ? 'workspace'
          : effect === 'device' || effect === 'execute'
            ? 'system'
            : 'single-object';
  const reversibility = inferReversibility(capability.id, capability.risk, args);
  const externality = inferExternality(origins);
  const privilege = capability.risk === 'security-sensitive'
    || capability.moduleId === 'security'
    || /(?:elevat|admin|firewall|defender|service|registry)/i.test(capability.id)
    ? 'security-control'
    : /(?:install|driver|system|process)/i.test(capability.id)
      ? 'elevated'
      : 'user';
  const data = inferDataSensitivity(paths, args);
  const novelty = inferNovelty(capability.id, args);
  return { effect, scope, reversibility, externality, privilege, data, novelty };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

export function canonicalProposalHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function extractActionPaths(args: Record<string, unknown>): string[] {
  const result: string[] = [];
  collectStringValues(args, '', (key, value) => {
    if (/(?:^|_)(?:path|paths|targetpath|destinationpath|sourcepath)$/i.test(key.replace(/[^a-z_]/gi, ''))) {
      result.push(value);
    }
  });
  return uniqueStrings(result).slice(0, 32);
}

export function extractActionOrigins(args: Record<string, unknown>): string[] {
  const origins: string[] = [];
  collectStringValues(args, '', (key, value) => {
    if (!/(?:url|uri|origin|endpoint|destination)/i.test(key)) return;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.push(parsed.origin);
    } catch {
      // Non-URL strings are not treated as network grants.
    }
  });
  return uniqueStrings(origins).slice(0, 16);
}

export function normalizeAutonomyModeFromSandbox(
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access',
): 'guided' | 'workspace-autonomous' | 'full-local' {
  if (sandboxMode === 'read-only') return 'guided';
  if (sandboxMode === 'danger-full-access') return 'full-local';
  return 'workspace-autonomous';
}

function normalizeScope(
  value: Partial<MonarchActionScope> | undefined,
  args: Record<string, unknown>,
  workspaceRoot: string,
  fallbackLevel: MonarchActionScopeLevel,
): MonarchActionScope {
  const paths = uniqueStrings(uniqueStrings([
    ...normalizeStringList(value?.paths, 32),
    ...extractActionPaths(args),
  ]).map((entry) => canonicalizePathHint(entry, workspaceRoot)).filter(Boolean));
  const roots = uniqueStrings(normalizeStringList(value?.roots, 8)
    .map((entry) => canonicalizePathHint(entry, workspaceRoot)));
  if (paths.length > 0 && roots.length === 0) roots.push(path.resolve(workspaceRoot));
  const origins = uniqueStrings([
    ...normalizeStringList(value?.origins, 16),
    ...extractActionOrigins(args),
  ]);
  const level = isScopeLevel(value?.level) ? value.level : fallbackLevel;
  return {
    level,
    ...(roots.length ? { roots } : {}),
    ...(paths.length ? { paths } : {}),
    ...(origins.length ? { origins } : {}),
  };
}

function normalizeProvenance(
  value: Partial<MonarchActionProposalProvenance> | undefined,
  options: NormalizeActionProposalOptions,
): MonarchActionProposalProvenance {
  const source = value?.source === 'model-tool-call'
    || value?.source === 'runtime-grammar'
    || value?.source === 'deterministic-router'
    || value?.source === 'api'
    ? value.source
    : options.source || 'api';
  return {
    model: readBoundedString(value?.model, 200)
      || readBoundedString(options.model, 200)
      || readBoundedString(options.requestedBy, 200)
      || 'unknown',
    skillIds: uniqueStrings([
      ...normalizeStringList(value?.skillIds, MAX_SKILL_IDS),
      ...(options.skillIds || []),
    ]).slice(0, MAX_SKILL_IDS),
    source,
  };
}

function normalizePredicates(value: MonarchActionPredicate[] | undefined, field: string): MonarchActionPredicate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new MonarchActionProtocolError('proposal-predicates-invalid', `${field} must be an array.`);
  }
  if (value.length > MAX_PREDICATES) {
    throw new MonarchActionProtocolError('proposal-predicates-invalid', `${field} exceeds the ${MAX_PREDICATES}-predicate limit.`);
  }
  const result: MonarchActionPredicate[] = [];
  for (const [index, entryValue] of value.entries()) {
    if (!entryValue || typeof entryValue !== 'object' || Array.isArray(entryValue)) {
      throw new MonarchActionProtocolError('proposal-predicate-invalid', `${field}[${index}] must be an object.`);
    }
    const entry = entryValue as unknown as Record<string, unknown>;
    const kind = entry.kind;
    if (kind !== 'exists' && kind !== 'not-exists' && kind !== 'equals' && kind !== 'contains' && kind !== 'status') {
      throw new MonarchActionProtocolError('proposal-predicate-invalid', `${field}[${index}].kind is unsupported.`);
    }
    const target = readBoundedString(entry.target, 1_000);
    if (!target) {
      throw new MonarchActionProtocolError('proposal-predicate-invalid', `${field}[${index}].target is required.`);
    }
    const valueError = actionPredicateValueError(entry);
    if (valueError) {
      throw new MonarchActionProtocolError('proposal-predicate-invalid', `${field}[${index}] ${valueError}`);
    }
    if (kind === 'exists' || kind === 'not-exists') {
      result.push({ kind, target });
    } else if (kind === 'status') {
      result.push({ kind, target, value: entry.value as string | number | boolean });
    } else {
      result.push({ kind, target, value: sortJsonValue(entry.value) as MonarchActionPredicateJsonValue });
    }
  }
  return result;
}

function canonicalizeJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  const sorted = sortJsonValue(value);
  if (!sorted || typeof sorted !== 'object' || Array.isArray(sorted)) {
    throw new MonarchActionProtocolError('proposal-args-invalid', 'Action proposal args must be a JSON object.');
  }
  return sorted as Record<string, unknown>;
}

function sortJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new MonarchActionProtocolError('proposal-too-deep', 'Action proposal exceeds the nesting limit.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MonarchActionProtocolError('proposal-number-invalid', 'Action proposal contains a non-finite number.');
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 1_000).map((entry) => sortJsonValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new MonarchActionProtocolError('proposal-key-forbidden', `Action proposal key is forbidden: ${key}`);
      }
      const next = (value as Record<string, unknown>)[key];
      if (next === undefined || typeof next === 'function' || typeof next === 'symbol' || typeof next === 'bigint') {
        throw new MonarchActionProtocolError('proposal-value-invalid', `Action proposal value is not JSON serializable: ${key}`);
      }
      record[key] = sortJsonValue(next, depth + 1);
    }
    return record;
  }
  throw new MonarchActionProtocolError('proposal-value-invalid', 'Action proposal contains a non-JSON value.');
}

function riskEffect(risk: MonarchRisk): MonarchRiskVector['effect'] {
  if (risk === 'none') return 'none';
  if (risk === 'read') return 'read';
  if (risk === 'write') return 'write';
  if (risk === 'delete') return 'delete';
  if (risk === 'network') return 'network';
  if (risk === 'device-control') return 'device';
  return 'execute';
}

function inferReversibility(capabilityId: string, risk: MonarchRisk, args: Record<string, unknown>): MonarchActionReversibility {
  if (risk === 'none' || risk === 'read') return 'read-only';
  if (/\.write$/.test(capabilityId)) return args.overwrite === true ? 'irreversible' : 'reversible';
  if (/\.append$|\.replace$/.test(capabilityId)) return 'compensatable';
  if (/\.trash$|\.restore$|\.move$|\.rename$|\.mkdir$|\.copy$/.test(capabilityId)) return 'reversible';
  if (risk === 'write' || risk === 'device-control') return 'compensatable';
  return 'irreversible';
}

function normalizeReversibility(
  value: MonarchActionReversibility | undefined,
  fallback: MonarchActionReversibility,
): MonarchActionReversibility {
  if (value !== 'read-only' && value !== 'reversible' && value !== 'compensatable' && value !== 'irreversible') return fallback;
  const rank: Record<MonarchActionReversibility, number> = {
    'read-only': 0,
    reversible: 1,
    compensatable: 2,
    irreversible: 3,
  };
  return rank[value] > rank[fallback] ? value : fallback;
}

function inferExternality(origins: string[]): MonarchActionExternality {
  if (origins.length === 0) return 'local';
  if (origins.every((origin) => /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin))) return 'localhost';
  return 'new-origin';
}

function inferNovelty(capabilityId: string, args: Record<string, unknown>): MonarchActionNovelty {
  const keys = Object.keys(args);
  if (keys.some((key) => /^(?:code|command|script|shell|powershell|python)$/i.test(key))
    || /(?:execute|shell|script|command|terminal)/i.test(capabilityId)) return 'arbitrary-code';
  return keys.length > 0 ? 'new-args' : 'known-capability';
}

function inferDataSensitivity(paths: string[], args: Record<string, unknown>): MonarchRiskVector['data'] {
  const haystack = `${paths.join('\n')} ${Object.keys(args).join(' ')}`;
  if (/(?:^|[\\/.])(?:\.env|secrets?|credentials?|tokens?|id_rsa|safe|vault)(?:$|[\\/.])/i.test(haystack)) return 'secret';
  if (/(?:desktop|downloads|documents|pictures|appdata|users[\\/])/i.test(haystack)) return 'personal';
  return paths.length > 0 ? 'workspace' : 'public';
}

function describeExpectedEffect(risk: MonarchRisk, capabilityId: string, scope: MonarchActionScope): string {
  const target = scope.paths?.[0] || scope.origins?.[0] || scope.level;
  return `${risk} effect through ${capabilityId} on ${target}.`;
}

function canonicalizePathHint(value: string, workspaceRoot: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.resolve(workspaceRoot, trimmed);
}

function collectStringValues(
  value: unknown,
  key: string,
  visitor: (key: string, value: string) => void,
  depth = 0,
): void {
  if (depth > 8) return;
  if (typeof value === 'string') {
    visitor(key, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 100)) collectStringValues(entry, key, visitor, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    collectStringValues(entryValue, entryKey, visitor, depth + 1);
  }
}

function normalizeStringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
      .map((entry) => entry.trim())
      .slice(0, limit)
    : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readBoundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLength)
    : '';
}

function isScopeLevel(value: unknown): value is MonarchActionScopeLevel {
  return value === 'single-object' || value === 'bounded-set' || value === 'workspace' || value === 'system' || value === 'external';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

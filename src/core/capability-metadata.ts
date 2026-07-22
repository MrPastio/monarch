import type {
  MonarchAgentCapabilityIdempotency,
  MonarchAgentCapabilityMetadataInput,
  MonarchAgentCapabilityVerificationDescriptor,
  MonarchCapability,
  MonarchCapabilityEffectProfile,
  MonarchAgentCapabilitySource,
  MonarchResolvedAgentCapabilityMetadata,
  MonarchRisk,
} from './contracts';

const IDEMPOTENCY_VALUES = ['idempotent', 'conditional', 'non-idempotent'] as const;
const REVERSIBILITY_VALUES = ['automatic', 'manual', 'irreversible'] as const;
const CANCELLATION_VALUES = ['supported', 'best-effort', 'unsupported'] as const;
const LATENCY_VALUES = ['instant', 'short', 'long', 'unbounded'] as const;
const COMPUTE_VALUES = ['light', 'medium', 'heavy'] as const;
const MUTATION_VALUES = ['none', 'temporary', 'persistent'] as const;
const TARGET_SCOPE_VALUES = ['agent-state', 'workspace', 'project', 'application', 'device', 'external-service'] as const;
const PRIVILEGE_VALUES = ['normal', 'elevated', 'security-critical'] as const;
const SENSITIVITY_VALUES = ['public', 'private', 'secret'] as const;
const COMMUNICATION_VALUES = ['none', 'loopback', 'lan', 'internet', 'third-party'] as const;
const SOURCE_VALUES: readonly MonarchAgentCapabilitySource[] = ['desktop', 'voice', 'telegram', 'api', 'system', 'smoke', 'coder'];
const VERIFICATION_VALUES: readonly MonarchAgentCapabilityVerificationDescriptor['kind'][] = [
  'predicate',
  'read-after-write',
  'schema',
  'runtime-status',
  'external-receipt',
];

const MAX_METADATA_ITEMS = 64;
const MAX_METADATA_TEXT = 512;

export class MonarchCapabilityMetadataError extends Error {
  constructor(
    message: string,
    readonly capabilityId?: string,
  ) {
    super(capabilityId ? `Capability ${capabilityId}: ${message}` : message);
    this.name = 'MonarchCapabilityMetadataError';
  }
}

export interface MonarchAgentCapabilityMigrationEntry {
  capabilityId: string;
  moduleId: string;
  legacyRisk: MonarchRisk;
  metadataSource: MonarchResolvedAgentCapabilityMetadata['source'];
  reviewPriority: 'normal' | 'high' | 'critical';
  reviewReasons: string[];
}

export interface MonarchAgentCapabilityMigrationInventory {
  representation: 'monarch.agent-capability-migration-inventory';
  version: 1;
  total: number;
  explicit: number;
  legacyDefaults: number;
  entries: MonarchAgentCapabilityMigrationEntry[];
}

/** Generates a deterministic inventory; callers decide where/if to persist it. */
export function createAgentCapabilityMigrationInventory(
  capabilities: readonly MonarchCapability[],
): MonarchAgentCapabilityMigrationInventory {
  const entries = capabilities.map((capability): MonarchAgentCapabilityMigrationEntry => {
    const metadata = resolveAgentCapabilityMetadata(capability);
    const reviewReasons: string[] = [];
    if (metadata.source === 'legacy-default') reviewReasons.push('metadata-not-explicit');
    if (capability.risk !== 'none' && capability.risk !== 'read') reviewReasons.push(`legacy-risk:${capability.risk}`);
    if (/(?:models\.chat\.complete|studio\.(?:edit|history)|oscar\.(?:conversations|memory)|voice\.mode\.execute-scripted|telegram\.api|security\.(?:pin|response)|custom-tools\.|device)/i.test(capability.id)) {
      reviewReasons.push('priority-contract-family');
    }
    const critical = capability.risk === 'money'
      || capability.risk === 'identity'
      || capability.risk === 'security-sensitive';
    return {
      capabilityId: capability.id,
      moduleId: capability.moduleId,
      legacyRisk: capability.risk,
      metadataSource: metadata.source,
      reviewPriority: critical ? 'critical' : reviewReasons.length > 1 ? 'high' : 'normal',
      reviewReasons,
    };
  }).sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
  return {
    representation: 'monarch.agent-capability-migration-inventory',
    version: 1,
    total: entries.length,
    explicit: entries.filter((entry) => entry.metadataSource === 'explicit').length,
    legacyDefaults: entries.filter((entry) => entry.metadataSource === 'legacy-default').length,
    entries,
  };
}

/**
 * Produces a deliberately cautious profile for capabilities that have not yet
 * migrated to explicit Agent Runtime metadata.
 */
export function legacyAgentCapabilityDefaults(risk: MonarchRisk): MonarchResolvedAgentCapabilityMetadata {
  const profile = legacyEffectProfile(risk);
  const mutates = profile.mutation !== 'none';

  return {
    tags: [],
    preconditions: [],
    effects: [{
      kind: mutates ? 'legacy-mutation' : 'legacy-observation',
      description: `Conservative effect inferred from legacy risk '${risk}'.`,
      targetScope: profile.targetScope,
    }],
    idempotency: legacyIdempotency(risk),
    reversibility: profile.reversibility,
    effectProfile: profile,
    requiredRuntime: [],
    requiredCredentials: [],
    supportedSources: [...SOURCE_VALUES],
    estimatedLatency: 'unbounded',
    computeClass: 'heavy',
    cancellation: 'unsupported',
    verification: mutates
      ? [{
          kind: 'predicate',
          description: 'A deterministic postcondition is required for a legacy mutating capability.',
          required: true,
        }]
      : [],
    examples: [],
    source: 'legacy-default',
  };
}

export function validateAgentCapabilityMetadata(
  capability: MonarchCapability,
): MonarchResolvedAgentCapabilityMetadata {
  return resolveAgentCapabilityMetadata(capability);
}

export function resolveAgentCapabilityMetadata(
  capability: MonarchCapability,
): MonarchResolvedAgentCapabilityMetadata {
  const defaults = legacyAgentCapabilityDefaults(capability.risk);
  const input = capability.agent;
  if (input === undefined) {
    return defaults;
  }

  assertPlainObject(input, 'agent', capability.id);
  assertKnownKeys(input, [
    'tags',
    'preconditions',
    'effects',
    'idempotency',
    'reversibility',
    'effectProfile',
    'requiredRuntime',
    'requiredCredentials',
    'supportedSources',
    'estimatedLatency',
    'computeClass',
    'cancellation',
    'verification',
    'examples',
  ], 'agent', capability.id);

  const explicitProfile = input.effectProfile;
  if (explicitProfile !== undefined) {
    assertPlainObject(explicitProfile, 'agent.effectProfile', capability.id);
    assertKnownKeys(explicitProfile, [
      'mutation',
      'targetScope',
      'reversibility',
      'privilege',
      'dataSensitivity',
      'communication',
      'financialImpact',
      'identityImpact',
      'securityImpact',
    ], 'agent.effectProfile', capability.id);
  }

  validateOptionalEnum(input.idempotency, IDEMPOTENCY_VALUES, 'agent.idempotency', capability.id);
  validateOptionalEnum(input.reversibility, REVERSIBILITY_VALUES, 'agent.reversibility', capability.id);
  validateOptionalEnum(input.estimatedLatency, LATENCY_VALUES, 'agent.estimatedLatency', capability.id);
  validateOptionalEnum(input.computeClass, COMPUTE_VALUES, 'agent.computeClass', capability.id);
  validateOptionalEnum(input.cancellation, CANCELLATION_VALUES, 'agent.cancellation', capability.id);
  validateOptionalEnum(explicitProfile?.mutation, MUTATION_VALUES, 'agent.effectProfile.mutation', capability.id);
  validateOptionalEnum(explicitProfile?.targetScope, TARGET_SCOPE_VALUES, 'agent.effectProfile.targetScope', capability.id);
  validateOptionalEnum(explicitProfile?.reversibility, REVERSIBILITY_VALUES, 'agent.effectProfile.reversibility', capability.id);
  validateOptionalEnum(explicitProfile?.privilege, PRIVILEGE_VALUES, 'agent.effectProfile.privilege', capability.id);
  validateOptionalEnum(explicitProfile?.dataSensitivity, SENSITIVITY_VALUES, 'agent.effectProfile.dataSensitivity', capability.id);
  validateOptionalEnum(explicitProfile?.communication, COMMUNICATION_VALUES, 'agent.effectProfile.communication', capability.id);
  validateOptionalBoolean(explicitProfile?.financialImpact, 'agent.effectProfile.financialImpact', capability.id);
  validateOptionalBoolean(explicitProfile?.identityImpact, 'agent.effectProfile.identityImpact', capability.id);
  validateOptionalBoolean(explicitProfile?.securityImpact, 'agent.effectProfile.securityImpact', capability.id);

  const explicitReversibility = input.reversibility ?? explicitProfile?.reversibility;
  if (
    input.reversibility !== undefined
    && explicitProfile?.reversibility !== undefined
    && input.reversibility !== explicitProfile.reversibility
  ) {
    fail('agent.reversibility must match agent.effectProfile.reversibility.', capability.id);
  }

  const effectProfile: MonarchCapabilityEffectProfile = {
    ...defaults.effectProfile,
    ...explicitProfile,
    ...(explicitReversibility === undefined ? {} : { reversibility: explicitReversibility }),
  };
  assertRiskFloor(capability.risk, input.idempotency ?? defaults.idempotency, effectProfile, capability.id);

  const tags = validateStringArray(input.tags, 'agent.tags', capability.id);
  const requiredRuntime = validateStringArray(input.requiredRuntime, 'agent.requiredRuntime', capability.id);
  const requiredCredentials = validateStringArray(input.requiredCredentials, 'agent.requiredCredentials', capability.id);
  const supportedSources = validateSourceArray(input.supportedSources, capability.id);
  const preconditions = validateDescriptors(input.preconditions, 'agent.preconditions', capability.id);
  const effects = validateEffects(input.effects, capability.id);
  const verification = validateVerification(input.verification, capability.id);
  const examples = validateExamples(input.examples, capability.id);

  return {
    tags,
    preconditions,
    effects: effects.length > 0 ? effects : defaults.effects,
    idempotency: input.idempotency ?? defaults.idempotency,
    reversibility: effectProfile.reversibility,
    effectProfile,
    requiredRuntime,
    requiredCredentials,
    supportedSources,
    estimatedLatency: input.estimatedLatency ?? defaults.estimatedLatency,
    computeClass: input.computeClass ?? defaults.computeClass,
    cancellation: input.cancellation ?? defaults.cancellation,
    verification: mergeVerification(defaults.verification, verification),
    examples,
    source: 'explicit',
  };
}

/**
 * Effectful Agent actions must have a cooperative cancellation contract.
 * Pure local observations may be detached by the orchestration layer after
 * abort because they cannot commit a mutation or an external communication.
 */
export function supportsBoundedAgentExecution(
  metadata: MonarchResolvedAgentCapabilityMetadata,
): boolean {
  const profile = metadata.effectProfile;
  const effectful = profile.mutation !== 'none'
    || profile.communication !== 'none'
    || profile.financialImpact
    || profile.identityImpact
    || profile.securityImpact;
  return !effectful || metadata.cancellation === 'supported';
}

function legacyIdempotency(risk: MonarchRisk): MonarchAgentCapabilityIdempotency {
  if (risk === 'none' || risk === 'read') return 'idempotent';
  if (risk === 'write') return 'conditional';
  return 'non-idempotent';
}

function legacyEffectProfile(risk: MonarchRisk): MonarchCapabilityEffectProfile {
  const base: MonarchCapabilityEffectProfile = {
    mutation: 'none',
    targetScope: 'agent-state',
    reversibility: 'automatic',
    privilege: 'normal',
    dataSensitivity: 'public',
    communication: 'none',
    financialImpact: false,
    identityImpact: false,
    securityImpact: false,
  };

  switch (risk) {
    case 'none':
      return base;
    case 'read':
      return { ...base, targetScope: 'workspace', dataSensitivity: 'private' };
    case 'write':
      return {
        ...base,
        mutation: 'persistent',
        targetScope: 'workspace',
        reversibility: 'manual',
        dataSensitivity: 'private',
      };
    case 'delete':
      return {
        ...base,
        mutation: 'persistent',
        targetScope: 'workspace',
        reversibility: 'irreversible',
        dataSensitivity: 'private',
      };
    case 'execute':
      return {
        ...base,
        mutation: 'temporary',
        targetScope: 'device',
        reversibility: 'manual',
        privilege: 'elevated',
        dataSensitivity: 'private',
        securityImpact: true,
      };
    case 'network':
      return {
        ...base,
        targetScope: 'external-service',
        reversibility: 'manual',
        dataSensitivity: 'private',
        communication: 'third-party',
      };
    case 'device-control':
      return {
        ...base,
        mutation: 'temporary',
        targetScope: 'device',
        reversibility: 'manual',
        privilege: 'elevated',
        dataSensitivity: 'private',
        securityImpact: true,
      };
    case 'money':
      return {
        ...base,
        mutation: 'persistent',
        targetScope: 'external-service',
        reversibility: 'irreversible',
        privilege: 'security-critical',
        dataSensitivity: 'secret',
        communication: 'third-party',
        financialImpact: true,
        identityImpact: true,
        securityImpact: true,
      };
    case 'identity':
      return {
        ...base,
        mutation: 'persistent',
        targetScope: 'external-service',
        reversibility: 'irreversible',
        privilege: 'security-critical',
        dataSensitivity: 'secret',
        communication: 'third-party',
        identityImpact: true,
        securityImpact: true,
      };
    case 'security-sensitive':
      return {
        ...base,
        mutation: 'persistent',
        targetScope: 'device',
        reversibility: 'irreversible',
        privilege: 'security-critical',
        dataSensitivity: 'secret',
        securityImpact: true,
      };
  }
}

function assertRiskFloor(
  risk: MonarchRisk,
  idempotency: MonarchAgentCapabilityIdempotency,
  profile: MonarchCapabilityEffectProfile,
  capabilityId: string,
): void {
  const floor = legacyAgentCapabilityDefaults(risk);
  assertRankAtLeast(idempotency, floor.idempotency, IDEMPOTENCY_VALUES, 'agent.idempotency', capabilityId);
  assertRankAtLeast(profile.mutation, floor.effectProfile.mutation, MUTATION_VALUES, 'agent.effectProfile.mutation', capabilityId);
  assertRankAtLeast(profile.reversibility, floor.effectProfile.reversibility, REVERSIBILITY_VALUES, 'agent.reversibility', capabilityId);
  assertRankAtLeast(profile.privilege, floor.effectProfile.privilege, PRIVILEGE_VALUES, 'agent.effectProfile.privilege', capabilityId);
  assertRankAtLeast(profile.dataSensitivity, floor.effectProfile.dataSensitivity, SENSITIVITY_VALUES, 'agent.effectProfile.dataSensitivity', capabilityId);
  assertRankAtLeast(profile.communication, floor.effectProfile.communication, COMMUNICATION_VALUES, 'agent.effectProfile.communication', capabilityId);

  for (const field of ['financialImpact', 'identityImpact', 'securityImpact'] as const) {
    if (floor.effectProfile[field] && !profile[field]) {
      fail(`agent.effectProfile.${field} cannot weaken legacy risk '${risk}'.`, capabilityId);
    }
  }
}

function assertRankAtLeast<T extends string>(
  value: T,
  floor: T,
  orderedValues: readonly T[],
  path: string,
  capabilityId: string,
): void {
  if (orderedValues.indexOf(value) < orderedValues.indexOf(floor)) {
    fail(`${path} cannot weaken legacy risk metadata (${value} < ${floor}).`, capabilityId);
  }
}

function validateStringArray(value: unknown, path: string, capabilityId: string): string[] {
  if (value === undefined) return [];
  assertBoundedArray(value, path, capabilityId);
  const normalized = value.map((item, index) => {
    if (typeof item !== 'string') fail(`${path}[${index}] must be a string.`, capabilityId);
    const text = item.trim();
    if (!text || text.length > MAX_METADATA_TEXT) {
      fail(`${path}[${index}] must contain 1-${MAX_METADATA_TEXT} characters.`, capabilityId);
    }
    return text;
  });
  return [...new Set(normalized)];
}

function validateSourceArray(value: unknown, capabilityId: string): MonarchAgentCapabilitySource[] {
  if (value === undefined) return [...SOURCE_VALUES];
  assertBoundedArray(value, 'agent.supportedSources', capabilityId);
  if (value.length === 0) fail('agent.supportedSources must not be empty.', capabilityId);
  return [...new Set(value.map((item, index) => {
    if (typeof item !== 'string' || !SOURCE_VALUES.includes(item as MonarchAgentCapabilitySource)) {
      fail(`agent.supportedSources[${index}] is invalid.`, capabilityId);
    }
    return item as MonarchAgentCapabilitySource;
  }))];
}

function validateDescriptors(
  value: unknown,
  path: string,
  capabilityId: string,
): NonNullable<MonarchAgentCapabilityMetadataInput['preconditions']> {
  if (value === undefined) return [];
  assertBoundedArray(value, path, capabilityId);
  return value.map((entry, index) => {
    assertPlainObject(entry, `${path}[${index}]`, capabilityId);
    assertKnownKeys(entry, ['kind', 'description'], `${path}[${index}]`, capabilityId);
    return {
      kind: validateText(entry.kind, `${path}[${index}].kind`, capabilityId),
      description: validateText(entry.description, `${path}[${index}].description`, capabilityId),
    };
  });
}

function validateEffects(
  value: unknown,
  capabilityId: string,
): NonNullable<MonarchAgentCapabilityMetadataInput['effects']> {
  if (value === undefined) return [];
  assertBoundedArray(value, 'agent.effects', capabilityId);
  return value.map((entry, index) => {
    const path = `agent.effects[${index}]`;
    assertPlainObject(entry, path, capabilityId);
    assertKnownKeys(entry, ['kind', 'description', 'targetScope'], path, capabilityId);
    validateOptionalEnum(entry.targetScope, TARGET_SCOPE_VALUES, `${path}.targetScope`, capabilityId);
    return {
      kind: validateText(entry.kind, `${path}.kind`, capabilityId),
      description: validateText(entry.description, `${path}.description`, capabilityId),
      ...(entry.targetScope === undefined ? {} : { targetScope: entry.targetScope }),
    };
  });
}

function validateVerification(
  value: unknown,
  capabilityId: string,
): MonarchAgentCapabilityVerificationDescriptor[] {
  if (value === undefined) return [];
  assertBoundedArray(value, 'agent.verification', capabilityId);
  return value.map((entry, index) => {
    const path = `agent.verification[${index}]`;
    assertPlainObject(entry, path, capabilityId);
    assertKnownKeys(entry, ['kind', 'description', 'required'], path, capabilityId);
    const kind = entry.kind;
    validateOptionalEnum(kind, VERIFICATION_VALUES, `${path}.kind`, capabilityId);
    if (kind === undefined) fail(`${path}.kind is required.`, capabilityId);
    const required = entry.required;
    validateOptionalBoolean(required, `${path}.required`, capabilityId);
    return {
      kind,
      description: validateText(entry.description, `${path}.description`, capabilityId),
      ...(required === undefined ? {} : { required: required as boolean }),
    };
  });
}

function validateExamples(value: unknown, capabilityId: string): unknown[] {
  if (value === undefined) return [];
  assertBoundedArray(value, 'agent.examples', capabilityId);
  try {
    return structuredClone(value);
  } catch {
    fail('agent.examples must be structured-cloneable.', capabilityId);
  }
}

function mergeVerification(
  defaults: MonarchAgentCapabilityVerificationDescriptor[],
  explicit: MonarchAgentCapabilityVerificationDescriptor[],
): MonarchAgentCapabilityVerificationDescriptor[] {
  const merged = [...defaults, ...explicit];
  return merged.filter((entry, index) => merged.findIndex((candidate) => (
    candidate.kind === entry.kind && candidate.description === entry.description
  )) === index);
}

function validateText(value: unknown, path: string, capabilityId: string): string {
  if (typeof value !== 'string') fail(`${path} must be a string.`, capabilityId);
  const text = value.trim();
  if (!text || text.length > MAX_METADATA_TEXT) {
    fail(`${path} must contain 1-${MAX_METADATA_TEXT} characters.`, capabilityId);
  }
  return text;
}

function validateOptionalBoolean(value: unknown, path: string, capabilityId: string): void {
  if (value !== undefined && typeof value !== 'boolean') fail(`${path} must be a boolean.`, capabilityId);
}

function validateOptionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  capabilityId: string,
): asserts value is T | undefined {
  if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value as T))) {
    fail(`${path} must be one of: ${allowed.join(', ')}.`, capabilityId);
  }
}

function assertBoundedArray(value: unknown, path: string, capabilityId: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array.`, capabilityId);
  if (value.length > MAX_METADATA_ITEMS) fail(`${path} exceeds ${MAX_METADATA_ITEMS} items.`, capabilityId);
}

function assertPlainObject(value: unknown, path: string, capabilityId: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${path} must be an object.`, capabilityId);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${path} must be a plain object.`, capabilityId);
  }
}

function assertKnownKeys(
  value: object,
  allowed: readonly string[],
  path: string,
  capabilityId: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not supported.`, capabilityId);
  }
}

function fail(message: string, capabilityId: string): never {
  throw new MonarchCapabilityMetadataError(message, capabilityId);
}

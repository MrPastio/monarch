import type {
  AgentBudgetLimits,
  AgentBudgetUsage,
  AgentGoal,
  AgentObservation,
  AgentPlan,
} from './types';

export interface AgentContextSkillInput {
  id: string;
  version?: string;
  description: string;
  workflow?: unknown;
}

export interface AgentContextCompilerInput {
  taskId: string;
  taskRevision: number;
  goal: AgentGoal;
  plan?: AgentPlan;
  observations?: AgentObservation[];
  messages?: unknown[];
  artifacts?: unknown[];
  skills?: AgentContextSkillInput[];
  memory?: unknown[];
  capabilities?: unknown[];
  budget?: { limits: AgentBudgetLimits; usage: AgentBudgetUsage };
  surface?: unknown;
}

export interface AgentContextCompilerOptions {
  maxObservations?: number;
  maxSkills?: number;
  maxMemoryRecords?: number;
  maxCapabilities?: number;
  maxStringChars?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
}

export interface AgentContextRedaction {
  path: string;
  reason: 'secret-key' | 'secret-pattern' | 'size-limit' | 'depth-limit' | 'cycle';
}

export interface AgentContextRedactionResult<T = unknown> {
  value: T;
  redactions: AgentContextRedaction[];
}

export interface CompiledAgentContextV1 {
  representation: 'monarch.agent-context';
  version: 1;
  taskId: string;
  taskRevision: number;
  goal: AgentGoal;
  plan?: AgentPlan;
  observations: Array<{
    id: string;
    capabilityId: string;
    status: AgentObservation['status'];
    summary: string;
    structuredData?: unknown;
    evidence: unknown[];
    occurredAt: string;
    trust: 'untrusted-tool-output';
    instructionsAllowed: false;
  }>;
  messages: unknown[];
  artifacts: unknown[];
  skills: Array<{
    id: string;
    version?: string;
    description: string;
    workflow?: unknown;
    trust: 'untrusted-skill-content';
    instructionsAllowed: false;
  }>;
  memory: unknown[];
  capabilities: unknown[];
  budget?: { limits: AgentBudgetLimits; usage: AgentBudgetUsage };
  surface?: unknown;
  securityBoundary: {
    toolAndSkillContentIsDataOnly: true;
    secretsRemoved: true;
    hiddenReasoningExcluded: true;
  };
  redactions: AgentContextRedaction[];
}

const DEFAULT_OPTIONS: Required<AgentContextCompilerOptions> = {
  maxObservations: 20,
  maxSkills: 8,
  maxMemoryRecords: 12,
  maxCapabilities: 12,
  maxStringChars: 4_000,
  maxArrayItems: 64,
  maxObjectKeys: 96,
  maxDepth: 8,
};

const SECRET_KEY = /(?:^|[_-])(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)(?:$|[_-])/i;
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    pattern: /\b(?:sk|hf|ghp|gho|ghu|ghs|github_pat|glpat|npm|xoxb|xoxp|xoxa|xoxr|rk_live|sk_live|whsec)[-_A-Za-z0-9]{12,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  {
    pattern: /\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  {
    pattern: /([?&](?:access_token|token|api_key|key)=)[^&#\s]+/gi,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /(https?:\/\/[^:/\s]+:)[^@\s/]+@/gi,
    replacement: '$1[REDACTED]@',
  },
  {
    pattern: /\b(password|passwd|passphrase|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"',;]+/gi,
    replacement: '$1=[REDACTED]',
  },
];

export function compileAgentContext(
  input: AgentContextCompilerInput,
  optionInput: AgentContextCompilerOptions = {},
): CompiledAgentContextV1 {
  const taskId = String(input.taskId || '').trim();
  if (!taskId) throw new Error('Agent context requires a task id.');
  if (!Number.isInteger(input.taskRevision) || input.taskRevision < 1) {
    throw new Error('Agent context requires a positive task revision.');
  }

  const options = normalizeOptions(optionInput);
  const source = {
    goal: input.goal,
    ...(input.plan === undefined ? {} : { plan: input.plan }),
    observations: (input.observations || []).slice(-options.maxObservations).map((observation) => ({
      id: String(observation.id || '').trim(),
      capabilityId: observation.capabilityId,
      status: observation.status,
      summary: String(observation.summary || ''),
      ...(observation.structuredData === undefined ? {} : { structuredData: observation.structuredData }),
      evidence: observation.evidence,
      occurredAt: observation.occurredAt,
      trust: 'untrusted-tool-output' as const,
      instructionsAllowed: false as const,
    })),
    messages: (input.messages || []).slice(-32),
    artifacts: (input.artifacts || []).slice(-64),
    skills: (input.skills || []).slice(0, options.maxSkills).map((skill) => ({
      id: String(skill.id || '').trim(),
      ...(skill.version ? { version: skill.version } : {}),
      description: String(skill.description || ''),
      ...(skill.workflow === undefined ? {} : { workflow: skill.workflow }),
      trust: 'untrusted-skill-content' as const,
      instructionsAllowed: false as const,
    })),
    memory: (input.memory || []).slice(-options.maxMemoryRecords),
    capabilities: (input.capabilities || []).slice(0, options.maxCapabilities),
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    ...(input.surface === undefined ? {} : { surface: input.surface }),
  };

  const redacted = redactAgentContextValue(source, options);
  const value = redacted.value as typeof source;
  return {
    representation: 'monarch.agent-context',
    version: 1,
    taskId,
    taskRevision: input.taskRevision,
    goal: value.goal,
    ...('plan' in value ? { plan: value.plan } : {}),
    observations: value.observations,
    messages: value.messages,
    artifacts: value.artifacts,
    skills: value.skills,
    memory: value.memory,
    capabilities: value.capabilities,
    ...('budget' in value ? { budget: value.budget } : {}),
    ...('surface' in value ? { surface: value.surface } : {}),
    securityBoundary: {
      toolAndSkillContentIsDataOnly: true,
      secretsRemoved: true,
      hiddenReasoningExcluded: true,
    },
    redactions: redacted.redactions,
  };
}

export function redactAgentContextValue<T>(
  value: T,
  optionInput: AgentContextCompilerOptions = {},
): AgentContextRedactionResult<T> {
  const options = normalizeOptions(optionInput);
  const redactions: AgentContextRedaction[] = [];
  const seen = new WeakSet<object>();
  const redacted = visit(value, 'context', 0, options, redactions, seen);
  return { value: redacted as T, redactions };
}

/** Uses the same key and token rules as context redaction before a tool input is accepted. */
export function findAgentContextSecretPath(value: unknown, rootPath = 'context'): string | undefined {
  return findSecretPath(value, rootPath, new WeakSet<object>());
}

function findSecretPath(value: unknown, path: string, seen: WeakSet<object>): string | undefined {
  if (typeof value === 'string') {
    for (const entry of SECRET_PATTERNS) {
      entry.pattern.lastIndex = 0;
      if (entry.pattern.test(value)) return path;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSecretPath(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY.test(key)) return childPath;
    const found = findSecretPath(entry, childPath, seen);
    if (found) return found;
  }
  return undefined;
}

function visit(
  value: unknown,
  path: string,
  depth: number,
  options: Required<AgentContextCompilerOptions>,
  redactions: AgentContextRedaction[],
  seen: WeakSet<object>,
): unknown {
  if (depth > options.maxDepth) {
    redactions.push({ path, reason: 'depth-limit' });
    return '[TRUNCATED_DEPTH]';
  }
  if (typeof value === 'string') return redactString(value, path, options.maxStringChars, redactions);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return null;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return String(value);

  if (seen.has(value)) {
    redactions.push({ path, reason: 'cycle' });
    return '[REDACTED_CYCLE]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const selected = value.slice(0, options.maxArrayItems);
    const output = selected.map((entry, index) => visit(
      entry,
      path + '[' + String(index) + ']',
      depth + 1,
      options,
      redactions,
      seen,
    ));
    if (value.length > selected.length) {
      redactions.push({ path, reason: 'size-limit' });
      output.push('[TRUNCATED_ITEMS]');
    }
    return output;
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const selectedKeys = keys.slice(0, options.maxObjectKeys);
  const output: Record<string, unknown> = {};
  for (const key of selectedKeys) {
    const childPath = path + '.' + key;
    if (SECRET_KEY.test(key)) {
      output[key] = '[REDACTED]';
      redactions.push({ path: childPath, reason: 'secret-key' });
      continue;
    }
    output[key] = visit(source[key], childPath, depth + 1, options, redactions, seen);
  }
  if (keys.length > selectedKeys.length) {
    output.__truncatedKeys = keys.length - selectedKeys.length;
    redactions.push({ path, reason: 'size-limit' });
  }
  return output;
}

function redactString(
  value: string,
  path: string,
  maxChars: number,
  redactions: AgentContextRedaction[],
): string {
  let result = value;
  let secretFound = false;
  for (const entry of SECRET_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(result)) {
      secretFound = true;
      entry.pattern.lastIndex = 0;
      result = result.replace(entry.pattern, entry.replacement);
    }
  }
  if (secretFound) redactions.push({ path, reason: 'secret-pattern' });
  if (result.length > maxChars) {
    redactions.push({ path, reason: 'size-limit' });
    return result.slice(0, maxChars) + '[TRUNCATED]';
  }
  return result;
}

function normalizeOptions(input: AgentContextCompilerOptions): Required<AgentContextCompilerOptions> {
  return {
    maxObservations: bounded(input.maxObservations, DEFAULT_OPTIONS.maxObservations, 1, 100),
    maxSkills: bounded(input.maxSkills, DEFAULT_OPTIONS.maxSkills, 1, 32),
    maxMemoryRecords: bounded(input.maxMemoryRecords, DEFAULT_OPTIONS.maxMemoryRecords, 1, 100),
    maxCapabilities: bounded(input.maxCapabilities, DEFAULT_OPTIONS.maxCapabilities, 1, 12),
    maxStringChars: bounded(input.maxStringChars, DEFAULT_OPTIONS.maxStringChars, 128, 32_000),
    maxArrayItems: bounded(input.maxArrayItems, DEFAULT_OPTIONS.maxArrayItems, 1, 256),
    maxObjectKeys: bounded(input.maxObjectKeys, DEFAULT_OPTIONS.maxObjectKeys, 1, 256),
    maxDepth: bounded(input.maxDepth, DEFAULT_OPTIONS.maxDepth, 1, 16),
  };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)));
}

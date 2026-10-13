/** Runtime-neutral redaction shared by V3 transports, skills and archived records. */
export interface AgentContextSafetyOptions {
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

const DEFAULT_OPTIONS: Required<AgentContextSafetyOptions> = {
  maxStringChars: 4_000,
  maxArrayItems: 64,
  maxObjectKeys: 96,
  maxDepth: 8,
};

const SECRET_KEY = /(?:^|[_-])(password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|credentials|private[_-]?key)(?:$|[_-])/i;
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
  {
    pattern: /\b(accessToken|refreshToken|idToken|apiKey|clientSecret|privateKey|authorizationHeader|cookieValue|credentials)\b["']?\s*[:=]\s*["']?[^\s"',;}\]]+/gi,
    replacement: '$1=[REDACTED]',
  },
];

export function redactAgentContextValue<T>(
  value: T,
  optionInput: AgentContextSafetyOptions = {},
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
    if (isSecretKey(key)) return childPath;
    const found = findSecretPath(entry, childPath, seen);
    if (found) return found;
  }
  return undefined;
}

function visit(
  value: unknown,
  path: string,
  depth: number,
  options: Required<AgentContextSafetyOptions>,
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
      `${path}[${index}]`,
      depth + 1,
      options,
      redactions,
      seen,
    ));
    if (value.length > selected.length) redactions.push({ path, reason: 'size-limit' });
    return output;
  }

  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const selectedKeys = keys.slice(0, options.maxObjectKeys);
  const output: Record<string, unknown> = {};
  for (const key of selectedKeys) {
    const childPath = `${path}.${key}`;
    if (isSecretKey(key)) {
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
    return `${result.slice(0, maxChars)}[TRUNCATED]`;
  }
  return result;
}

function isSecretKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return SECRET_KEY.test(normalized);
}

function normalizeOptions(input: AgentContextSafetyOptions): Required<AgentContextSafetyOptions> {
  return {
    maxStringChars: bounded(input.maxStringChars, DEFAULT_OPTIONS.maxStringChars, 128, 32_000),
    maxArrayItems: bounded(input.maxArrayItems, DEFAULT_OPTIONS.maxArrayItems, 1, 500),
    maxObjectKeys: bounded(input.maxObjectKeys, DEFAULT_OPTIONS.maxObjectKeys, 1, 256),
    maxDepth: bounded(input.maxDepth, DEFAULT_OPTIONS.maxDepth, 1, 16),
  };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value as number)));
}

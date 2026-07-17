const DEFAULT_PREVIEW_MAX_CHARS = 500;
const MAX_PREVIEW_DEPTH = 6;

export function safePreview(value: unknown, maxChars = DEFAULT_PREVIEW_MAX_CHARS): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const redacted = redactAndEscape(value);
  const serialized = typeof redacted === 'string'
    ? redacted
    : JSON.stringify(redacted);
  if (!serialized) {
    return undefined;
  }

  return truncateText(serialized, maxChars);
}

export function getSafeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) {
    return normalizeErrorCode(error.name);
  }
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) {
      return normalizeErrorCode(code);
    }
  }
  return 'unknown';
}

function redactAndEscape(value: unknown, depth = 0, key = ''): unknown {
  if (isSensitiveKey(key)) {
    return '[redacted]';
  }

  if (depth > MAX_PREVIEW_DEPTH) {
    return '[depth-limit]';
  }

  if (typeof value === 'string') {
    return escapePromptStructure(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactAndEscape(item, depth + 1));
  }

  if (typeof value !== 'object') {
    return escapePromptStructure(String(value));
  }

  const result: Record<string, unknown> = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    result[nestedKey] = redactAndEscape(nestedValue, depth + 1, nestedKey);
  }
  return result;
}

function escapePromptStructure(value: string): string {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

function truncateText(value: string, maxChars: number): string {
  const normalizedLimit = Math.max(32, Math.floor(maxChars));
  if (value.length <= normalizedLimit) {
    return value;
  }
  return `${value.slice(0, normalizedLimit - 3)}...`;
}

function isSensitiveKey(key: string): boolean {
  return /^(?:.*(?:token|api[_-]?key|secret|password|credential|passkey|authorization).*)$/i.test(key);
}

function normalizeErrorCode(value: string): string {
  const code = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
  return code.slice(0, 80) || 'unknown';
}

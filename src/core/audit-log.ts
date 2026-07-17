import type { MonarchAuditEntry, MonarchAuditSeverity } from './contracts';
import { createMonarchId, nowIso } from './utils';

export class MonarchAuditLog {
  private readonly entries: MonarchAuditEntry[] = [];

  append(
    category: string,
    message: string,
    data?: unknown,
    severity: MonarchAuditSeverity = 'info'
  ): MonarchAuditEntry {
    const entry: MonarchAuditEntry = {
      id: createMonarchId('audit'),
      createdAt: nowIso(),
      severity,
      category: category.trim() || 'general',
      message: message.trim() || 'Audit entry',
      data: redactAuditData(data),
    };

    this.entries.push(entry);
    return entry;
  }

  list(): MonarchAuditEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

function redactAuditData(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[depth-limit]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactAuditData(item, depth + 1));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/(api[_-]?key|token|secret|password|credential)/i.test(key)
      || /^(?:pin|new[_-]?pin|current[_-]?pin|confirmation|recovery[_-]?code)$/i.test(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactAuditData(nested, depth + 1);
    }
  }
  return result;
}

import type { MonarchActionPredicateJsonValue } from './contracts';

export function actionPredicateValueError(predicate: Record<string, unknown>): string | undefined {
  const hasValue = Object.prototype.hasOwnProperty.call(predicate, 'value');
  switch (predicate.kind) {
  case 'exists':
  case 'not-exists':
    return hasValue ? `${predicate.kind} predicates must not include value.` : undefined;
  case 'equals':
    if (!hasValue || !isActionPredicateJsonValue(predicate.value)) {
      return 'equals predicates require a JSON value.';
    }
    return undefined;
  case 'contains':
    if (!hasValue || !isActionPredicateJsonValue(predicate.value)) {
      return 'contains predicates require a JSON value.';
    }
    return typeof predicate.value === 'string' && predicate.value.length === 0
      ? 'contains predicates require a non-empty string value.'
      : undefined;
  case 'status':
    if (!hasValue || !isStatusValue(predicate.value)) {
      return 'status predicates require a string, number, or boolean value.';
    }
    return typeof predicate.value === 'string' && predicate.value.length === 0
      ? 'status predicates require a non-empty string value.'
      : undefined;
  default:
    return 'Predicate kind is unsupported.';
  }
}

export function isActionPredicateJsonValue(value: unknown): value is MonarchActionPredicateJsonValue {
  return isJsonValue(value, new Set<object>(), 0);
}

function isStatusValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isJsonValue(value: unknown, ancestors: Set<object>, depth: number): value is MonarchActionPredicateJsonValue {
  if (depth > 24) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors, depth + 1))
    : Object.keys(value).every((key) => isJsonValue((value as Record<string, unknown>)[key], ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

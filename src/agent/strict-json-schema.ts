import type { MonarchJsonSchema } from '../core/contracts';

export interface StrictJsonSchemaValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Agent-facing JSON schema validation. Unlike the legacy route validator this
 * validates the collection and union keywords used by tool-call contracts.
 */
export function validateAgentJsonSchema(
  value: unknown,
  schema: MonarchJsonSchema | undefined,
  rootPath = 'value',
): StrictJsonSchemaValidationResult {
  if (!schema) return { ok: true, errors: [] };
  const errors: string[] = [];
  validateNode(value, schema, rootPath, errors);
  return { ok: errors.length === 0, errors };
}

function validateNode(value: unknown, schema: MonarchJsonSchema, path: string, errors: string[]): void {
  if (Array.isArray(schema.allOf)) {
    for (const candidate of schema.allOf) {
      if (isSchema(candidate)) validateNode(value, candidate, path, errors);
    }
  }

  validateUnion(value, schema, path, errors, 'oneOf');
  validateUnion(value, schema, path, errors, 'anyOf');

  if ('const' in schema && !jsonEquals(value, schema.const)) {
    errors.push(`${path} must equal the declared constant.`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEquals(value, candidate))) {
    errors.push(`${path} must be one of the declared enum values.`);
    return;
  }

  const allowedTypes = Array.isArray(schema.type)
    ? schema.type.filter((entry): entry is string => typeof entry === 'string')
    : typeof schema.type === 'string' ? [schema.type] : [];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesType(value, type))) {
    errors.push(`${path} must be ${allowedTypes.join(' or ')}.`);
    return;
  }

  if (typeof value === 'string') validateString(value, schema, path, errors);
  if (typeof value === 'number') validateNumber(value, schema, path, errors);
  if (Array.isArray(value)) validateArray(value, schema, path, errors);
  if (isRecord(value)) validateObject(value, schema, path, errors);
}

function validateUnion(
  value: unknown,
  schema: MonarchJsonSchema,
  path: string,
  errors: string[],
  keyword: 'oneOf' | 'anyOf',
): void {
  const raw = schema[keyword];
  if (!Array.isArray(raw)) return;
  const candidates = raw.filter(isSchema);
  if (candidates.length === 0) return;
  const matches = candidates.filter((candidate) => {
    const candidateErrors: string[] = [];
    validateNode(value, candidate, path, candidateErrors);
    return candidateErrors.length === 0;
  }).length;
  if ((keyword === 'oneOf' && matches !== 1) || (keyword === 'anyOf' && matches === 0)) {
    errors.push(`${path} does not satisfy ${keyword}.`);
  }
}

function validateString(value: string, schema: MonarchJsonSchema, path: string, errors: string[]): void {
  const minLength = readFinite(schema.minLength);
  const maxLength = readFinite(schema.maxLength);
  if (minLength !== null && value.length < minLength) errors.push(`${path} is shorter than ${minLength}.`);
  if (maxLength !== null && value.length > maxLength) errors.push(`${path} is longer than ${maxLength}.`);
  if (typeof schema.pattern === 'string') {
    try {
      if (!new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path} does not match the required pattern.`);
    } catch {
      errors.push(`${path} declares an invalid pattern.`);
    }
  }
}

function validateNumber(value: number, schema: MonarchJsonSchema, path: string, errors: string[]): void {
  if (!Number.isFinite(value)) {
    errors.push(`${path} must be finite.`);
    return;
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} must be integer.`);
  const minimum = readFinite(schema.minimum);
  const maximum = readFinite(schema.maximum);
  if (minimum !== null && value < minimum) errors.push(`${path} must be at least ${minimum}.`);
  if (maximum !== null && value > maximum) errors.push(`${path} must be at most ${maximum}.`);
}

function validateArray(value: unknown[], schema: MonarchJsonSchema, path: string, errors: string[]): void {
  const minItems = readFinite(schema.minItems);
  const maxItems = readFinite(schema.maxItems);
  if (minItems !== null && value.length < minItems) errors.push(`${path} must contain at least ${minItems} items.`);
  if (maxItems !== null && value.length > maxItems) errors.push(`${path} must contain at most ${maxItems} items.`);
  if (isSchema(schema.items)) {
    value.forEach((item, index) => validateNode(item, schema.items as MonarchJsonSchema, `${path}[${index}]`, errors));
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: MonarchJsonSchema,
  path: string,
  errors: string[],
): void {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required.`);
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key) && isSchema(propertySchema)) {
      validateNode(value[key], propertySchema, `${path}.${key}`, errors);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${path}.${key} is not allowed.`);
    }
  } else if (isSchema(schema.additionalProperties)) {
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(entry, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
  case 'object': return isRecord(value);
  case 'array': return Array.isArray(value);
  case 'string': return typeof value === 'string';
  case 'number': return typeof value === 'number' && Number.isFinite(value);
  case 'integer': return typeof value === 'number' && Number.isInteger(value);
  case 'boolean': return typeof value === 'boolean';
  case 'null': return value === null;
  default: return false;
  }
}

function isSchema(value: unknown): value is MonarchJsonSchema {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

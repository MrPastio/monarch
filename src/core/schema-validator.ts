import type { MonarchJsonSchema } from './contracts';

export interface MonarchSchemaValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateAgainstSchema(
  value: unknown,
  schema: MonarchJsonSchema | undefined,
  path = 'input'
): MonarchSchemaValidationResult {
  if (!schema) {
    return { ok: true, errors: [] };
  }

  const errors: string[] = [];
  validateValue(value, schema, path, errors);

  return {
    ok: errors.length === 0,
    errors,
  };
}

function validateValue(
  value: unknown,
  schema: MonarchJsonSchema,
  path: string,
  errors: string[]
): void {
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}.`);
    return;
  }

  if (schema.type === 'object' || schema.properties || schema.required) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be object.`);
      return;
    }

    const record = value as Record<string, unknown>;
    for (const requiredKey of schema.required || []) {
      if (!(requiredKey in record)) {
        errors.push(`${path}.${requiredKey} is required.`);
      }
    }

    const properties = schema.properties || {};
    for (const [key, nestedSchema] of Object.entries(properties)) {
      if (key in record) {
        validateValue(record[key], nestedSchema as MonarchJsonSchema, `${path}.${key}`, errors);
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          errors.push(`${path}.${key} is not allowed.`);
        }
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
  case 'object':
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  case 'array':
    return Array.isArray(value);
  case 'string':
    return typeof value === 'string';
  case 'number':
    return typeof value === 'number' && Number.isFinite(value);
  case 'boolean':
    return typeof value === 'boolean';
  case 'null':
    return value === null;
  default:
    return true;
  }
}


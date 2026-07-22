import { describe, expect, it } from 'vitest';
import { validateAgentJsonSchema } from '../../src/agent/strict-json-schema';

describe('agent strict JSON schema', () => {
  it('validates nested arrays, enums and closed objects', () => {
    const schema = {
      type: 'object',
      required: ['mode', 'items'],
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['read', 'write'] },
        items: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
      },
    };
    expect(validateAgentJsonSchema({ mode: 'read', items: [1, 2] }, schema)).toEqual({ ok: true, errors: [] });
    const invalid = validateAgentJsonSchema({ mode: 'delete', items: [0], extra: true }, schema);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      'value.mode must be one of the declared enum values.',
      'value.items[0] must be at least 1.',
      'value.extra is not allowed.',
    ]));
  });

  it('requires exactly one oneOf branch', () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    expect(validateAgentJsonSchema('ok', schema).ok).toBe(true);
    expect(validateAgentJsonSchema(true, schema).ok).toBe(false);
  });
});

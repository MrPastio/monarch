import { describe, expect, it } from 'vitest';
import {
  filterSelectableOscarModelScale,
  resolveSelectableOscarModelAvailability,
} from '../../src/ui/public/modules/oscar-model-availability.js';

const ROLES = ['gemma4-fast', 'gemma4-balanced', 'qwen3.8-27b-pro'];

describe('Oscar selectable model availability', () => {
  it('keeps a runnable legacy E2B visible when provisioning has a newer download pin', () => {
    const availability = resolveSelectableOscarModelAvailability({
      components: {
        schemaVersion: 2,
        models: [
          { role: 'gemma4-fast', installed: false },
          { role: 'gemma4-balanced', installed: true },
          { role: 'qwen3.8-27b-pro', installed: true },
        ],
      },
      modelRuntime: {
        entries: [
          { role: 'gemma4-fast', runnerStatus: 'present', canInfer: true },
          { role: 'gemma4-balanced', runnerStatus: 'present', canInfer: true },
          { role: 'qwen3.8-27b-pro', runnerStatus: 'ready', canInfer: true },
        ],
      },
      models: { models: [] },
    }, ROLES);

    expect(availability).toEqual({
      'gemma4-fast': true,
      'gemma4-balanced': true,
      'qwen3.8-27b-pro': true,
    });
    expect(filterSelectableOscarModelScale(ROLES, availability)).toEqual(ROLES);
  });

  it('still hides a model missing from provisioning, catalog, and runtime', () => {
    const availability = resolveSelectableOscarModelAvailability({
      components: { models: [{ role: 'gemma4-fast', installed: false }] },
      modelRuntime: { entries: [{ role: 'gemma4-fast', runnerStatus: 'missing', canInfer: false }] },
      models: { models: [{ role: 'gemma4-fast', status: 'missing' }] },
    }, ROLES);

    expect(availability?.['gemma4-fast']).toBe(false);
    expect(filterSelectableOscarModelScale(ROLES, availability)).not.toContain('gemma4-fast');
  });

  it('falls back to a discovered compatible catalog model before runtime starts', () => {
    const availability = resolveSelectableOscarModelAvailability({
      components: { models: [{ role: 'gemma4-fast', installed: false }] },
      modelRuntime: { entries: [] },
      models: { models: [{ role: 'gemma4-fast', status: 'available' }] },
    }, ROLES);

    expect(availability?.['gemma4-fast']).toBe(true);
  });
});

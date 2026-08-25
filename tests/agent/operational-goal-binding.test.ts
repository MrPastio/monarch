import { describe, expect, it } from 'vitest';
import {
  operationalRequirementInputMatches,
  operationalRequirementMatches,
  resolveAgentOperationalRequirements,
} from '../../src/agent/operational-goal-binding';

describe('runtime-owned operational goal bindings', () => {
  it('binds volume completion to the exact requested value', () => {
    const [requirement] = resolveAgentOperationalRequirements('Установи громкость на 20 процентов');
    expect(requirement).toMatchObject({
      capabilityId: 'device.volume.set',
      input: { action: 'set', value: 20 },
      effectful: true,
    });
    expect(operationalRequirementMatches(requirement!, 'device.volume.set', {
      verified: true,
      operation: 'set',
      requestedValue: 20,
      before: 50,
      level: 20,
      muted: false,
    })).toBe(true);
    expect(operationalRequirementMatches(requirement!, 'device.volume.set', {
      verified: true,
      operation: 'set',
      requestedValue: 80,
      before: 50,
      level: 80,
      muted: false,
    })).toBe(false);
    expect(operationalRequirementInputMatches(requirement!, 'device.volume.set', {
      action: 'set', value: 80,
    })).toBe(false);
  });

  it('binds app launch to the requested normalized app identity', () => {
    const [requirement] = resolveAgentOperationalRequirements('Открой калькулятор');
    expect(requirement).toMatchObject({ capabilityId: 'device.app.open', input: { app: 'calculator' } });
    expect(operationalRequirementMatches(requirement!, 'device.app.open', {
      opened: true,
      verified: true,
      app: 'notepad',
    })).toBe(false);
    expect(operationalRequirementMatches(requirement!, 'device.app.open', {
      opened: true,
      verified: true,
      app: 'calculator',
    })).toBe(true);
    expect(resolveAgentOperationalRequirements('Открой Telegram.')).toEqual([
      expect.objectContaining({ capabilityId: 'device.app.open', input: { app: 'telegram' } }),
    ]);
  });

  it('preserves a trusted app query for generic resolution but leaves explicit @Computer Use on the visible cursor path', () => {
    expect(resolveAgentOperationalRequirements('открой фигму')).toEqual([
      expect.objectContaining({ capabilityId: 'device.app.open', input: { app: 'фигму' }, effectful: true }),
    ]);
    expect(resolveAgentOperationalRequirements('@Computer Use открой фигму')).toEqual([]);
  });

  it('requires every deterministic clause in a multi-effect request', () => {
    expect(resolveAgentOperationalRequirements(
      'Установи громкость на 20 процентов и яркость на 30 процентов',
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capabilityId: 'device.volume.set',
        input: { action: 'set', value: 20 },
      }),
      expect.objectContaining({
        capabilityId: 'device.brightness.set',
        input: { operation: 'set', value: 30 },
      }),
    ]));
  });

  it('does not leak an affirmative numeric slot into a separately negated device domain', () => {
    expect(resolveAgentOperationalRequirements(
      'Установи яркость экрана ровно на 37 процентов. Громкость не меняй.',
    )).toEqual([
      expect.objectContaining({
        capabilityId: 'device.brightness.set',
        input: { operation: 'set', value: 37 },
      }),
    ]);
    expect(resolveAgentOperationalRequirements(
      'Set brightness to 41 percent, do not change volume.',
    )).toEqual([
      expect.objectContaining({
        capabilityId: 'device.brightness.set',
        input: { operation: 'set', value: 41 },
      }),
    ]);
  });

  it('binds every exact workspace write to its path, bytes, and overwrite intent', () => {
    const requirements = resolveAgentOperationalRequirements(
      'Create runtime/one.txt with exact text ONE and create runtime/two.txt with exact text TWO.',
    ).filter((entry) => entry.capabilityId === 'workspace.files.write');
    expect(requirements).toEqual([
      expect.objectContaining({ input: { path: 'runtime/one.txt', content: 'ONE', overwrite: false } }),
      expect.objectContaining({ input: { path: 'runtime/two.txt', content: 'TWO', overwrite: false } }),
    ]);
    expect(operationalRequirementInputMatches(requirements[0]!, 'workspace.files.write', {
      path: 'runtime/one.txt', content: 'ONE.', overwrite: true,
    })).toBe(false);
    expect(operationalRequirementInputMatches(requirements[0]!, 'workspace.files.write', {
      path: 'runtime/one.txt', content: 'ONE', overwrite: false,
    })).toBe(true);
  });

  it('binds browser search and storage audit to the exact normalized target', () => {
    const browser = resolveAgentOperationalRequirements('Открой в браузере сайт example.com')[0]!;
    expect(operationalRequirementMatches(browser, 'device.browser.open', {
      opened: true,
      verified: true,
      target: 'https://example.com/',
      browser: 'default',
      provider: 'google',
    })).toBe(true);
    expect(operationalRequirementMatches(browser, 'device.browser.open', {
      opened: true,
      verified: true,
      target: 'https://example.org/',
      browser: 'default',
      provider: 'google',
    })).toBe(false);

    const audit = resolveAgentOperationalRequirements('Проведи аудит диска E:')[0]!;
    expect(operationalRequirementMatches(audit, 'workspace.storage.audit', {
      observationVerified: true,
      audit: { root: 'E:\\' },
    })).toBe(true);
    expect(operationalRequirementMatches(audit, 'workspace.root.get', {
      workspaceRoot: 'E:\\Monarch',
    })).toBe(false);

    const usageCheck = resolveAgentOperationalRequirements(
      'Проверь использование хранилища E: и сообщи точное logicalBytes.',
    )[0]!;
    expect(usageCheck).toEqual(expect.objectContaining({
      capabilityId: 'workspace.storage.audit',
      input: expect.objectContaining({ root: 'E:\\' }),
      effectful: false,
    }));
    expect(operationalRequirementInputMatches(usageCheck, 'workspace.storage.audit', {
      root: 'E:',
    })).toBe(true);
  });
});

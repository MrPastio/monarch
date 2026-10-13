import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchKernel, type MonarchModule } from '../../src/core';

afterEach(() => vi.restoreAllMocks());

function module(id: string, options: { fail?: boolean; dependencies?: string[]; activated?: string[] } = {}): MonarchModule {
  return {
    manifest: {
      id, name: id, version: '0.1.0', kind: 'system', description: 'Test-only module.', owns: [id],
      permissions: ['read'], ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      capabilities: [{ id: `${id}.ping`, moduleId: id, title: 'Ping', risk: 'read' }],
    },
    async activate(): Promise<void> {
      if (options.fail) throw Object.assign(new Error('damaged settings'), { code: 'invalid-json' });
      options.activated?.push(id);
    },
    async executeCapability() { return { ok: true, summary: 'pong' }; },
  };
}

describe('Kernel start with a module that cannot start', () => {
  it('starts every other module, skips dependants and refuses the failed module capabilities', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const activated: string[] = [];
    const kernel = new MonarchKernel();
    kernel.registerModule(module('test-broken', { fail: true }));
    kernel.registerModule(module('test-dependant', { dependencies: ['test-broken'], activated }));
    kernel.registerModule(module('test-healthy', { activated }));
    await expect(kernel.start()).resolves.toBeUndefined();
    expect(activated).toEqual(['test-healthy']);
    const request = (id: string) => ({ id: `exec_${id}`, intentId: `intent_${id}`, moduleId: id, capabilityId: `${id}.ping`,
      input: {}, requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString() });
    await expect(kernel.execute(request('test-broken'))).resolves.toMatchObject({ ok: false, error: 'module-unavailable' });
    await expect(kernel.execute(request('test-dependant'))).resolves.toMatchObject({ ok: false, error: 'module-unavailable' });
    await expect(kernel.execute(request('test-healthy'))).resolves.toMatchObject({ ok: true });
    const logged = errors.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('"moduleId":"test-broken","code":"invalid-json"');
    expect(logged).toContain('"moduleId":"test-dependant","code":"dependency-unavailable"');
    await kernel.stop();
  });
});

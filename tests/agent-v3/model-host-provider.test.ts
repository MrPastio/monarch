import { describe, expect, it } from 'vitest';
import { AstraModelHostProvider, astraModelHostIdentity, type AstraModelHostBinding } from '../../src/agent-v3/model-host-provider';
import { AstraPreparedModelClient } from '../../src/agent-v3/prepared-model-client';

const initial: AstraModelHostBinding = { endpoint: 'http://127.0.0.1:17861', bearerToken: 'fixture-only',
  hostGeneration: 'first', hostPid: 101, modelDigest: 'sha256:' + 'a'.repeat(64) };

describe('model host binding fencing', () => {
  it('pins each attempt and recovers the original descriptor after refresh', async () => {
    let binding = initial;
    const provider = new AstraModelHostProvider(initial, { discover: async () => binding, exited: () => false });
    const client = new AstraPreparedModelClient({ deployment: 'isolated-validation', ...initial, hostProvider: provider });
    const first = await client.forNewAttempt();
    binding = { ...initial, hostGeneration: 'second', hostPid: 102 };
    const second = await client.forNewAttempt();
    expect(first.descriptor()).toEqual(astraModelHostIdentity(initial));
    expect(second.descriptor()).toEqual(astraModelHostIdentity(binding));
    expect(client.forDescriptor(first.descriptor())?.descriptor()).toEqual(first.descriptor());
    expect(client.forDescriptor({ ...first.descriptor(), hostGeneration: 'unknown' })).toBeUndefined();
  });
  it('shares ten simultaneous refreshes and keeps old bindings immutable', async () => {
    let calls = 0;
    const provider = new AstraModelHostProvider(initial, {
      discover: async () => { calls++; return { ...initial, hostGeneration: 'second', hostPid: 102 }; },
      exited: () => false,
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => provider.ensureFresh('test')));
    expect(calls).toBe(1);
    expect(results.every(result => result.hostGeneration === 'second')).toBe(true);
    results[0]!.bearerToken = 'changed';
    expect(provider.current().bearerToken).toBe('fixture-only');
    expect(provider.lookup(astraModelHostIdentity(initial))).toEqual(initial);
    expect(provider.isQuiescent(astraModelHostIdentity(initial))).toBe(false);
  });

  it('requires exact exit evidence, not a newer generation', async () => {
    const exited = new Set<number>();
    const provider = new AstraModelHostProvider(initial, {
      discover: async () => ({ ...initial, hostGeneration: 'second', hostPid: 102 }),
      exited: binding => exited.has(binding.hostPid!),
    });
    await provider.ensureFresh('restart');
    const old = astraModelHostIdentity(initial);
    expect(provider.isQuiescent(old)).toBe(false);
    exited.add(102);
    expect(provider.isQuiescent(old)).toBe(false);
    exited.add(101);
    expect(provider.isQuiescent(old)).toBe(true);
    expect(provider.isQuiescent({ ...old, hostGeneration: 'unknown' })).toBe(false);
  });

  it('cancels one waiter without cancelling shared discovery', async () => {
    let resolve!: (binding: AstraModelHostBinding) => void;
    const provider = new AstraModelHostProvider(initial, {
      discover: () => new Promise(done => { resolve = done; }), exited: () => false,
    });
    const controller = new AbortController();
    const cancelled = provider.ensureFresh('cancel', controller.signal);
    const continuing = provider.ensureFresh('continue');
    await Promise.resolve();
    controller.abort(new Error('fixture-abort'));
    await expect(cancelled).rejects.toThrow('fixture-abort');
    resolve(initial);
    await expect(continuing).resolves.toEqual(initial);
  });

  it('rejects reused identity with a different process and preserves current binding', async () => {
    const provider = new AstraModelHostProvider(initial, {
      discover: async () => ({ ...initial, hostPid: 202 }), exited: () => false,
    });
    await expect(provider.ensureFresh('conflict')).rejects.toThrow('identity-conflict');
    expect(provider.current()).toEqual(initial);
  });
});

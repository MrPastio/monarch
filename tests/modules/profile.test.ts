import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { MonarchKernel } from '../../src/core';
import { ProfileModule } from '../../src/modules/profile';
import { MonarchProfileStore } from '../../src/modules/profile/store';

describe('Profile Module', () => {
  it('should persist profile across module restarts', async () => {
    const filePath = path.join(
      process.cwd(),
      'runtime',
      `smoke-profile-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    let firstKernel: MonarchKernel | undefined;
    let secondKernel: MonarchKernel | undefined;

    try {
      firstKernel = new MonarchKernel();
      firstKernel.registerModule(new ProfileModule({ storePath: filePath }));
      await firstKernel.start();

      const updated = await firstKernel.execute({
        id: 'exec_smoke_profile_update',
        intentId: 'intent_smoke_profile_update',
        moduleId: 'profile',
        capabilityId: 'profile.update',
        input: {
          displayName: 'Monarch Smoke',
          styleRules: ['be concise'],
          preferences: {
            tone: 'direct',
          },
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
        confirmed: true,
      });
      await firstKernel.stop();
      firstKernel = undefined;

      if (!updated.ok) throw new Error(updated.summary);
      expect(updated.ok).toBe(true);

      secondKernel = new MonarchKernel();
      secondKernel.registerModule(new ProfileModule({ storePath: filePath }));
      await secondKernel.start();

      const read = await secondKernel.submitIntent('show profile', 'smoke');
      await secondKernel.stop();
      secondKernel = undefined;

      const profile = (
        read.execution?.output as { profile?: { displayName?: unknown; styleRules?: unknown[]; preferences?: { tone?: unknown } } } | undefined
      )?.profile;
      
      if (!read.execution?.ok) throw new Error(read.summary);
      expect(read.execution?.ok).toBe(true);
      expect(profile?.displayName).toBe('Monarch Smoke');
      expect(profile?.styleRules?.includes('be concise')).toBe(true);
      expect(profile?.preferences?.tone).toBe('direct');
    } finally {
      await firstKernel?.stop().catch(() => undefined);
      await secondKernel?.stop().catch(() => undefined);
      await rm(filePath, { force: true });
    }
  });

  it('allows the settings UI to clear optional text and rule lists', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new ProfileModule({ storePath: false }));
    await kernel.start();
    try {
      await kernel.execute({
        id: 'exec_profile_seed', intentId: 'intent_profile_seed', moduleId: 'profile', capabilityId: 'profile.update',
        input: { adaptiveSummary: 'контекст', traits: ['живой'], styleRules: ['кратко'] },
        requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      const cleared = await kernel.execute({
        id: 'exec_profile_clear', intentId: 'intent_profile_clear', moduleId: 'profile', capabilityId: 'profile.update',
        input: { adaptiveSummary: '', traits: [], styleRules: [] },
        requestedBy: 'smoke', confirmed: true, createdAt: new Date(0).toISOString(),
      });
      expect((cleared.output as { profile: { adaptiveSummary: string; traits: string[]; styleRules: string[] } }).profile)
        .toMatchObject({ adaptiveSummary: '', traits: [], styleRules: [] });
    } finally {
      await kernel.stop();
    }
  });

  it('serializes concurrent stores without losing independent profile fields', async () => {
    const runtimeRoot = path.join(process.cwd(), 'runtime');
    await mkdir(runtimeRoot, { recursive: true });
    const root = await mkdtemp(path.join(runtimeRoot, 'profile-concurrent-'));
    const filePath = path.join(root, 'profile.json');
    try {
      const first = new MonarchProfileStore({ filePath });
      const second = new MonarchProfileStore({ filePath });
      await Promise.all([first.load(), second.load()]);

      await Promise.all([
        first.update({ displayName: 'Concurrent Monarch' }),
        second.update({ preferences: { tone: 'direct' } }),
      ]);
      await Promise.all(Array.from({ length: 24 }, (_, index) => (
        first.update({ preferences: { [`preference_${index}`]: `value_${index}` } })
      )));

      const recovered = new MonarchProfileStore({ filePath });
      await recovered.load();
      expect(recovered.read()).toMatchObject({
        displayName: 'Concurrent Monarch',
        preferences: { tone: 'direct', preference_0: 'value_0', preference_23: 'value_23' },
      });
      expect(Object.keys(recovered.read().preferences)).toHaveLength(25);
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ displayName: 'Concurrent Monarch' });
      expect(await readFile(`${filePath}.lock`, 'utf8').catch(() => '')).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not publish an update in memory when durable state is corrupt', async () => {
    const runtimeRoot = path.join(process.cwd(), 'runtime');
    await mkdir(runtimeRoot, { recursive: true });
    const root = await mkdtemp(path.join(runtimeRoot, 'profile-rollback-'));
    const filePath = path.join(root, 'profile.json');
    try {
      const store = new MonarchProfileStore({ filePath });
      await store.load();
      await store.update({ displayName: 'Persisted Monarch' });
      await writeFile(filePath, '{ broken profile json', 'utf8');

      await expect(store.update({ displayName: 'Must Not Leak' })).rejects.toThrow('invalid JSON');
      expect(store.read().displayName).toBe('Persisted Monarch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can retry load after malformed input is repaired and normalizes preference values', async () => {
    const runtimeRoot = path.join(process.cwd(), 'runtime');
    await mkdir(runtimeRoot, { recursive: true });
    const root = await mkdtemp(path.join(runtimeRoot, 'profile-load-retry-'));
    const filePath = path.join(root, 'profile.json');
    try {
      await writeFile(filePath, '[]', 'utf8');
      const store = new MonarchProfileStore({ filePath });
      await expect(store.load()).rejects.toThrow('failed schema validation');

      await writeFile(filePath, JSON.stringify({ displayName: 'Recovered Monarch' }), 'utf8');
      await store.load();
      const updated = await store.update({ preferences: { tone: '  direct  ', blank: '   ' } });

      expect(updated.displayName).toBe('Recovered Monarch');
      expect(updated.preferences).toEqual({ tone: 'direct' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

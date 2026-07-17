import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { MonarchKernel } from '../../src/core';
import { ProfileModule } from '../../src/modules/profile';

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
});

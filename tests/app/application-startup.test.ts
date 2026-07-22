import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentTaskStoreCorruptionError } from '../../src/agent';
import { MonarchApplication } from '../../src/app/application';

describe('MonarchApplication startup rollback', () => {
  it('stops the kernel when the agent runtime task store is corrupt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-app-startup-'));
    const storePath = path.join(root, 'runtime', 'agent', 'tasks.v2.json');
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, '{"broken":', 'utf8');
    const app = new MonarchApplication({
      workspaceRoot: root,
      enableAgentRuntimeV2: true,
    });

    try {
      let startupError: unknown;
      try {
        await app.start();
      } catch (error) {
        startupError = error;
      }

      expect(startupError).toBeInstanceOf(AgentTaskStoreCorruptionError);
      expect(startupError).toMatchObject({ filePath: path.resolve(storePath) });
      expect(app.isStarted).toBe(false);
      const modules = app.runtime.kernel.getSnapshot().modules;
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.filter((module) => module.status === 'active')).toEqual([]);
    } finally {
      if (app.runtime.kernel.getSnapshot().modules.some((module) => module.status === 'active')) {
        await app.runtime.kernel.stop();
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

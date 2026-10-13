import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app/application';

describe('MonarchApplication startup rollback', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('cannot resurrect Agent Runtime V2 through the product environment', () => {
    vi.stubEnv('MONARCH_AGENT_RUNTIME_V2', '1');
    const app = new MonarchApplication({ workspaceRoot: os.tmpdir() });
    expect('agentRuntime' in app).toBe(false);
    expect('incognitoAgentRuntime' in app).toBe(false);
    expect('createAgentTask' in app).toBe(false);
  });

  it('does not read or execute corrupt retired V2 task state during startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-app-startup-'));
    const storePath = path.join(root, 'runtime', 'agent', 'tasks.v2.json');
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, '{"broken":', 'utf8');
    const app = new MonarchApplication({ workspaceRoot: root });

    try {
      await expect(app.start()).resolves.toBeUndefined();
      expect(app.isStarted).toBe(true);
      expect('agentRuntime' in app).toBe(false);
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases every owner on stop even when an earlier one throws', async () => {
    // A throwing coordinator stop used to skip the Astra pilot, so its journal
    // stayed open (EBUSY on cleanup) for the rest of the process.
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-app-stop-'));
    const app = new MonarchApplication({ workspaceRoot: root });
    try {
      await app.start();
      const internals = app as unknown as { oscarTurnCoordinator: { stop: () => Promise<void> };
        astraProductPilot: { stop: () => Promise<void> } | null; runtime: { kernel: { stop: () => Promise<void> } } };
      const failure = new Error('synthetic-coordinator-stop');
      internals.oscarTurnCoordinator.stop = async () => { throw failure; };
      const pilotStop = vi.fn(async () => undefined);
      internals.astraProductPilot = { stop: pilotStop };
      const kernelStop = vi.spyOn(internals.runtime.kernel, 'stop');
      await expect(app.stop()).rejects.toBe(failure);
      expect(pilotStop).toHaveBeenCalledOnce();
      expect(kernelStop).toHaveBeenCalledOnce();
      expect(app.isStarted).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

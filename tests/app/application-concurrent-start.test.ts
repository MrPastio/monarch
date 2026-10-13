import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MonarchApplication } from '../../src/app/application';
import { InMemoryOscarTurnStore, OscarTurnCoordinator } from '../../src/oscar-turn';

it('starts once when a module asks for the application while it is still starting', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-concurrent-start-'));
  const turns = new OscarTurnCoordinator({ persistentStore: new InMemoryOscarTurnStore(), volatileStore: new InMemoryOscarTurnStore(),
    answerExecutor: async () => (async function* () { yield { type: 'done' as const }; })(),
    persistMessage: async () => undefined,
  });
  const app = new MonarchApplication({ workspaceRoot: root, enabledModules: ['security'], oscarTurnCoordinator: turns });
  const kernel = app.runtime.kernel;
  const kernelStart = kernel.start.bind(kernel);
  let kernelStarts = 0;
  kernel.start = async () => { kernelStarts += 1; return kernelStart(); };
  try {
    await Promise.all([app.start(), app.start(), (app as any).ensureStarted()]);
    expect(kernelStarts).toBe(1);
    await app.start();
    expect(kernelStarts).toBe(1);
  } finally { await app.stop(); await turns.stop(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

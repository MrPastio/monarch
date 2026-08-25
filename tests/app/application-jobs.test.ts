import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import {
  InMemoryOscarTurnStore,
  OscarTurnCoordinator,
  type OscarAnswerExecutorEvent,
} from '../../src/oscar-turn';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MonarchApplication legacy intent-job adapter', () => {
  it('uses a durable Oscar Turn and owns no in-memory job or confirmation authority maps', async () => {
    const { app } = await createApp();
    try {
      const job = await app.submitIntentJob({
        text: 'Расскажи коротко о Monarch',
        source: 'desktop',
        context: { clientConversationId: 'legacy-job-conversation', clientRequestId: 'legacy-job-request' },
      });

      expect(job.id).toMatch(/^oscar_turn_/);
      expect(job.status).toBe('completed');
      expect(job.result?.execution).toMatchObject({ ok: true, output: { outcome: 'answered' } });
      expect(Object.prototype.hasOwnProperty.call(app, 'intentJobs')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(app, 'pendingConfirmations')).toBe(false);
      expect(app.listIntentJobs()).toEqual([]);
      expect(app.getIntentJob(job.id)).toBeNull();
      expect(app.listRecentIntentJobs({
        source: 'desktop',
        clientConversationId: 'legacy-job-conversation',
        clientSessionId: 'legacy-job-session',
      })).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it('rejects legacy job text confirmation before a Turn can be created', async () => {
    const { app, persistentStore } = await createApp();
    try {
      await expect(app.submitIntentJob({
        text: 'подтверждаю',
        source: 'desktop',
        confirmed: true,
        confirmationToken: 'text-token',
      })).rejects.toMatchObject({ statusCode: 410, code: 'legacy-text-confirmation-disabled' });
      await expect(persistentStore.listTurns()).resolves.toEqual([]);
    } finally {
      await app.stop();
    }
  });
});

async function createApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-turn-job-adapter-'));
  roots.push(root);
  const persistentStore = new InMemoryOscarTurnStore();
  const coordinator = new OscarTurnCoordinator({
    persistentStore,
    volatileStore: new InMemoryOscarTurnStore(),
    agentRuntime: null,
    answerExecutor: async () => answerStream(),
    persistMessage: async () => undefined,
  });
  const app = new MonarchApplication({
    workspaceRoot: root,
    enabledModules: [],
    enableLocalSystemRouter: false,
    enableAgentRuntimeV2: false,
    oscarTurnCoordinator: coordinator,
  });
  await app.start();
  return { app, persistentStore };
}

async function* answerStream(): AsyncIterable<OscarAnswerExecutorEvent> {
  yield { type: 'token', token: 'Monarch — локальный агент.' };
  yield { type: 'done' };
}

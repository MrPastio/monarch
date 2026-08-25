import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app';
import { InMemoryOscarTurnStore, OSCAR_TURN_SCHEMA_VERSION, OscarTurnCoordinator, type OscarAnswerExecutorEvent } from '../../src/oscar-turn';

describe('MonarchApplication Turn continuation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('continues only the exact waiting Turn and keeps no mutable operational-context authority map', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-turn-continuation-'));
    roots.push(root);
    const persistentStore = new InMemoryOscarTurnStore();
    const classify = vi.fn()
      .mockResolvedValue({ lane: 'answer', kind: 'chat', confidence: 0.9, reason: 'Clarification received.' });
    const coordinator = new OscarTurnCoordinator({
      persistentStore,
      volatileStore: new InMemoryOscarTurnStore(),
      agentRuntime: null,
      dispositionProvider: { classify },
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
    const context = {
      clientSessionId: 'session-a',
      clientConversationId: 'conversation-a',
      clientRequestId: 'request-a',
      clientMessageId: 'message-a',
    };
    const now = new Date(0).toISOString();
    await persistentStore.createTurn({
      schemaVersion: OSCAR_TURN_SCHEMA_VERSION,
      id: 'oscar_turn_waiting_exact',
      clientRequestId: 'request-a',
      conversationId: 'conversation-a',
      source: 'desktop',
      privacyMode: 'persistent',
      mode: 'answer',
      status: 'waiting-for-user',
      request: { text: 'Нужна дополнительная информация.', attachmentIds: [], modifiers: {} },
      inputMessageId: 'message-a',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }, { events: [{ type: 'user.input.required', payload: { question: 'Что именно?' } }] });

    try {
      const completed = await app.submitIntent({
        text: 'Как это работает?',
        replyToTurnId: 'oscar_turn_waiting_exact',
        context: { ...context, clientRequestId: 'request-b', clientMessageId: 'message-b' },
      });
      expect(completed.execution, JSON.stringify(completed, null, 2)).toMatchObject({ ok: true, output: { turnId: 'oscar_turn_waiting_exact' } });
      await expect(persistentStore.listTurns()).resolves.toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(app, 'operationalContexts')).toBe(false);
      expect(classify).not.toHaveBeenCalled();
    } finally {
      await app.stop();
    }
  });
});

async function* answerStream(): AsyncIterable<OscarAnswerExecutorEvent> {
  yield { type: 'token', token: 'Спасибо, уточнение принято.' };
  yield { type: 'done' };
}

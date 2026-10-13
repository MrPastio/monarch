import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryOscarTurnStore,
  OscarTurnCoordinator,
  type OscarAnswerExecutorEvent,
  type OscarPersistedMessage,
  type OscarTurnCheckpoint,
  type OscarTurnV1,
} from '../../src/oscar-turn';

const MAX_ROLE = 'max-gpt-oss-120b';

describe('MAX → local answer (owner switch, 2026-09-26)', () => {
  it('answers with the local model when MAX fails and labels the answer as local', async () => {
    const maxCall = vi.fn(async () => failing('astra-max-native:rate-limit'));
    const maxLocalFallback = vi.fn(async () => stream([{ type: 'token', token: 'Локальный ответ.' }, { type: 'done', usage: { model_tier: 'gemma4-fast' } }]));
    const { coordinator, persisted } = create({ answerExecutor: maxCall, maxLocalFallback });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(maxSubmission('Расскажи про котов', 'fallback_ok'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn.status).toBe('succeeded');
      expect(maxCall).toHaveBeenCalledTimes(1);
      expect(maxLocalFallback).toHaveBeenCalledTimes(1);
      expect(reconstructAnswer(terminal)).toBe('Локальный ответ.');
      expect(terminal.events).toContainEqual(expect.objectContaining({
        type: 'agent.progress',
        payload: expect.objectContaining({ phase: 'max-local-answer', label: 'MAX не ответил · отвечает локальная модель' }),
      }));
      const answer = persisted.find((message) => message.role === 'assistant');
      expect(answer?.usage).toMatchObject({ max_fallback: 'local', max_failure_code: 'astra-max-native:rate-limit', model_tier: 'gemma4-fast' });
    } finally {
      await coordinator.stop();
    }
  });

  it.each([true, false])('routes with the local model when MAX fails at routing (switch on: %s)', async (allowed) => {
    // Live chaos run: with MAX rate-limited the Turn ended at routing with the
    // MAX error, never reaching the local answer the owner's switch promises.
    const classify = vi.fn(async ({ requestedModel }: { requestedModel?: string }) => {
      if (requestedModel) throw Object.assign(new Error('astra-max-native:rate-limit'), { code: 'astra-max-native:rate-limit' });
      return { lane: 'answer', kind: 'conversation', confidence: 0.9, reason: 'local routing', requiresExternalResearch: false };
    });
    const maxCall = vi.fn(async () => failing('astra-max-native:rate-limit'));
    const maxLocalFallback = vi.fn(async () => stream([{ type: 'token', token: 'Локальный ответ.' }, { type: 'done' }]));
    const { coordinator } = create({ answerExecutor: maxCall, maxLocalFallback, maxLocalFallbackAllowed: () => allowed,
      dispositionProvider: { classify } });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(maxSubmission('Напиши стихотворение про осень', `route_${allowed}`));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      if (allowed) {
        expect(terminal.turn.status).toBe('succeeded');
        expect(reconstructAnswer(terminal)).toBe('Локальный ответ.');
        expect(classify.mock.calls.map(([call]) => call.requestedModel)).toEqual([MAX_ROLE, undefined]);
      } else {
        expect(terminal.turn.status).toBe('failed');
        expect(terminal.turn.outcome?.diagnostic?.code).toBe('astra-max-native:rate-limit');
        expect(classify).toHaveBeenCalledTimes(1);
        expect(maxCall).not.toHaveBeenCalled();
      }
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps the MAX failure when the switch is off or no local model is ready', async () => {
    const maxLocalFallback = vi.fn(async () => null);
    const { coordinator } = create({ answerExecutor: async () => failing('astra-max-native:rate-limit'), maxLocalFallback });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(maxSubmission('Расскажи про котов', 'fallback_off'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn.status).toBe('failed');
      expect(terminal.turn.outcome?.diagnostic?.code).toBe('astra-max-native:rate-limit');
    } finally {
      await coordinator.stop();
    }
  });

  it('replaces text MAX already showed instead of appending a second answer', async () => {
    const { coordinator } = create({
      answerExecutor: async () => (async function* () {
        yield { type: 'token', token: 'Начало ответа MAX' } as OscarAnswerExecutorEvent;
        throw Object.assign(new Error('astra-max-native:response-interrupted'), { code: 'astra-max-native:response-interrupted' });
      })(),
      maxLocalFallback: async () => stream([{ type: 'token', token: 'Целый локальный ответ.' }, { type: 'done' }]),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(maxSubmission('Объясни налоги', 'fallback_replace'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn.status).toBe('succeeded');
      expect(reconstructAnswer(terminal)).toBe('Целый локальный ответ.');
    } finally {
      await coordinator.stop();
    }
  });

  it('reports the MAX failure when the local answer also fails', async () => {
    const { coordinator } = create({
      answerExecutor: async () => failing('astra-max-native:provider-timeout'),
      maxLocalFallback: async () => failing('local-model-missing'),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(maxSubmission('Привет, как дела у проекта', 'fallback_both'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn.status).toBe('failed');
      expect(terminal.turn.outcome?.diagnostic?.code).toBe('astra-max-native:provider-timeout');
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps an owner-added model in the chat without asking it to route', async () => {
    const classify = vi.fn(async () => ({ lane: 'agent' as const, kind: 'tool_use', confidence: 1, reason: 'test' }));
    const answerExecutor = vi.fn(async () => stream([{ type: 'token', token: 'Ответ своей модели.' }, { type: 'done' }]));
    const { coordinator } = create({ answerExecutor, dispositionProvider: { classify } });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...maxSubmission('Создай файл на рабочем столе', 'custom_chat'),
        modifiers: { requestedModel: 'custom-a1b2c3d4e5f6' },
      });
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(classify).not.toHaveBeenCalled();
      expect(terminal.turn.status).toBe('succeeded');
      expect(reconstructAnswer(terminal)).toBe('Ответ своей модели.');
      expect(await coordinator.requestNeedsWeb('курс доллара', [], 'custom-a1b2c3d4e5f6')).toBe(true);
    } finally {
      await coordinator.stop();
    }
  });
});

function create(options: {
  answerExecutor: (...args: any[]) => Promise<AsyncIterable<OscarAnswerExecutorEvent>>;
  maxLocalFallback?: (...args: any[]) => Promise<AsyncIterable<OscarAnswerExecutorEvent> | null>;
  dispositionProvider?: any;
  maxLocalFallbackAllowed?: () => boolean;
}) {
  const persisted: OscarPersistedMessage[] = [];
  const coordinator = new OscarTurnCoordinator({
    persistentStore: new InMemoryOscarTurnStore(),
    volatileStore: new InMemoryOscarTurnStore(),
    answerExecutor: options.answerExecutor,
    ...(options.maxLocalFallback ? { maxLocalFallback: options.maxLocalFallback } : {}),
    ...(options.dispositionProvider ? { dispositionProvider: options.dispositionProvider } : {}),
    ...(options.maxLocalFallbackAllowed ? { maxLocalFallbackAllowed: options.maxLocalFallbackAllowed } : {}),
    persistMessage: async (message) => { persisted.push(message); },
  });
  return { coordinator, persisted };
}

function maxSubmission(text: string, clientRequestId: string) {
  return {
    clientRequestId,
    conversationId: 'conversation_fallback',
    text,
    privacyMode: 'persistent' as const,
    source: 'desktop' as const,
    modifiers: { requestedModel: MAX_ROLE },
  };
}

async function* stream(events: OscarAnswerExecutorEvent[]): AsyncIterable<OscarAnswerExecutorEvent> {
  for (const event of events) yield event;
}

async function failing(code: string): Promise<AsyncIterable<OscarAnswerExecutorEvent>> {
  throw Object.assign(new Error(code), { code });
}

async function waitForTerminal(coordinator: OscarTurnCoordinator, turnId: string): Promise<OscarTurnCheckpoint> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const current = await coordinator.getTurn(turnId);
    if (current && ['succeeded', 'blocked', 'failed', 'cancelled'].includes(current.turn.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for Oscar Turn state.');
}

function reconstructAnswer(checkpoint: OscarTurnCheckpoint): string {
  let content = '';
  for (const event of checkpoint.events) {
    if (event.type === 'answer.delta') content += String(event.payload.content || '');
    if (event.type === 'answer.replace') content = String(event.payload.content || '');
  }
  return content;
}

export type { OscarTurnV1 };

describe('maxLocalFallbackAllowed', () => {
  it('needs the switch, local work allowed and an installed model', async () => {
    const { maxLocalFallbackAllowed } = await import('../../src/app/oscar-turn-runtime');
    const base = { schemaVersion: 1 as const, maxLocalFallback: true, updatedAt: '' };
    expect(maxLocalFallbackAllowed({ ...base, work: 'hybrid' }, true)).toBe(true);
    expect(maxLocalFallbackAllowed({ ...base, work: null }, true)).toBe(true);
    expect(maxLocalFallbackAllowed({ ...base, work: 'local' }, true)).toBe(true);
    expect(maxLocalFallbackAllowed({ ...base, work: 'max' }, true)).toBe(false);
    expect(maxLocalFallbackAllowed({ ...base, work: 'hybrid', maxLocalFallback: false }, true)).toBe(false);
    expect(maxLocalFallbackAllowed({ ...base, work: 'hybrid' }, false)).toBe(false);
    expect(maxLocalFallbackAllowed(undefined, true)).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AgentTaskCheckpoint, AgentTaskStoreListener, MonarchAgentRuntime } from '../../src/agent';
import {
  InMemoryOscarTurnStore,
  MESSAGE_PROVENANCE_SCHEMA_VERSION,
  OSCAR_INCIDENT_FAKE_STORAGE_AUDIT,
  OSCAR_TURN_CANCELLED_SUMMARY,
  OSCAR_TURN_SCHEMA_VERSION,
  OscarTurnCoordinator,
  turnFailureDiagnostic,
  userFacingTurnFailure,
  type OscarAnswerExecutorEvent,
  type OscarPersistedMessage,
  type OscarTurnCheckpoint,
  type OscarTurnV1,
} from '../../src/oscar-turn';
import { exactMonarch025Changelog, materialReviewHistory } from '../fixtures/oscar/material-handoff';

describe('OscarTurnCoordinator', () => {
  it('keeps internal schema diagnostics out of the user-facing failure copy', () => {
    const summary = userFacingTurnFailure(new Error('steps[0] contains unexpected fields: id.'));
    expect(summary).toBe('План задачи не прошёл проверку. Oscar остановился до новых действий; выполнение не подтверждено.');
    expect(summary).not.toContain('steps[0]');
  });

  it('explains a bounded decision timeout without exposing the internal error code', () => {
    const summary = userFacingTurnFailure(new Error('Agent decision cycle exceeded its bounded time budget.'));
    expect(summary).toBe(
      'Oscar остановил слишком долгий выбор следующего действия по лимиту времени. Ранее подтверждённые результаты сохранены; новых действий не было.',
    );
    expect(summary).not.toContain('agent-decision');
  });

  it('stores a bounded secret-redacted failure diagnostic with a stable fingerprint', () => {
    const error = Object.assign(new Error(
      'provider failed with Bearer abcdefghijklmnop and token=super-secret-value\nwhile parsing plan',
    ), { code: 'provider-failed' });
    const first = turnFailureDiagnostic(error);
    const second = turnFailureDiagnostic(error);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ code: 'provider-failed' });
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.detail).toContain('Bearer [REDACTED]');
    expect(first.detail).toContain('token=[REDACTED]');
    expect(first.detail).not.toContain('abcdefghijklmnop');
    expect(first.detail).not.toContain('super-secret-value');
    expect(first.detail).not.toContain('\n');
    expect(turnFailureDiagnostic(new Error('x'.repeat(3_000))).detail).toHaveLength(2_000);
  });

  it('persists an internal failure diagnostic without exposing it in events or chat history', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const failure = Object.assign(new Error('synthetic parser detail token=do-not-persist-in-chat'), {
      code: 'synthetic-parser-failure',
    });
    const coordinator = createCoordinator({
      persisted,
      answerExecutor: async () => { throw failure; },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        'Объясни локальный текст без внешних действий',
        'client_failure_diagnostic',
      ));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({
        status: 'failed',
        outcome: {
          kind: 'failed',
          diagnostic: {
            code: 'synthetic-parser-failure',
            detail: 'synthetic parser detail token=[REDACTED]',
          },
        },
      });
      expect(terminal.events.at(-1)).toMatchObject({
        type: 'turn.failed',
        payload: { summary: terminal.turn.outcome?.summary },
      });
      expect(terminal.events.at(-1)?.payload).not.toHaveProperty('diagnostic');
      await waitFor(
        () => persisted.some((message) => message.turnId === accepted.turn.id && message.role === 'assistant'),
        250,
      );
      const historyMessage = persisted.find((message) => message.turnId === accepted.turn.id && message.role === 'assistant');
      expect(historyMessage?.content).toBe(terminal.turn.outcome?.summary);
      expect(historyMessage).not.toHaveProperty('integrityWarning');
      expect(JSON.stringify(historyMessage)).not.toContain('synthetic parser detail');
    } finally {
      await coordinator.stop();
    }
  });

  it('finishes an ordinary answer exactly once with replayable answered provenance', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Моё любимое блюдо — хороший вопрос.' },
      { type: 'done', usage: { outputTokens: 9 } },
    ]));
    const coordinator = createCoordinator({ answerExecutor, persisted });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Какое твоё любимое блюдо?'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(terminal.turn).toMatchObject({ status: 'succeeded', outcome: { kind: 'answered' } });
      expect(terminal.events.at(-1)?.type).toBe('turn.outcome');
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')).toMatchObject({
        outcome: 'answered',
        provenance: {
          schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
          origin: 'model',
          verification: 'unverified-model',
        },
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('joins concurrent idempotent submissions to one routing flight', async () => {
    let enterRouting = () => undefined;
    let releaseRouting = () => undefined;
    const routingEntered = new Promise<void>((resolve) => { enterRouting = resolve; });
    const routingGate = new Promise<void>((resolve) => { releaseRouting = resolve; });
    const classify = vi.fn(async () => {
      enterRouting();
      await routingGate;
      return { lane: 'answer' as const, kind: 'general', confidence: 1, reason: 'single-flight fixture' };
    });
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({
      answerExecutor,
      dispositionProvider: { classify },
    });
    await coordinator.start();
    try {
      const input = submission('Проверь', 'client_concurrent_routing_replay');
      const first = coordinator.submit(input);
      await routingEntered;
      const replay = coordinator.submit(input);
      await waitFor(async () => (await coordinator.persistentStore.listTurns()).length === 1);

      releaseRouting();
      const [firstResult, replayResult] = await Promise.all([first, replay]);
      const terminal = await waitForTerminal(coordinator, firstResult.turn.id);

      expect(replayResult.turn.id).toBe(firstResult.turn.id);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(terminal.events.filter((event) => event.type === 'turn.routed')).toHaveLength(1);
    } finally {
      releaseRouting();
      await coordinator.stop();
    }
  });

  it('keeps routing flights independent for different Turns', async () => {
    let releaseRouting = () => undefined;
    const routingGate = new Promise<void>((resolve) => { releaseRouting = resolve; });
    const classify = vi.fn(async () => {
      await routingGate;
      return { lane: 'answer' as const, kind: 'general', confidence: 1, reason: 'parallel fixture' };
    });
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({
      answerExecutor,
      dispositionProvider: { classify },
    });
    await coordinator.start();
    try {
      const first = coordinator.submit(submission('Проверь', 'client_parallel_route_first'));
      const second = coordinator.submit(submission('Проверь', 'client_parallel_route_second'));
      await waitFor(() => classify.mock.calls.length === 2);

      releaseRouting();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await Promise.all([
        waitForTerminal(coordinator, firstResult.turn.id),
        waitForTerminal(coordinator, secondResult.turn.id),
      ]);

      expect(secondResult.turn.id).not.toBe(firstResult.turn.id);
      expect(classify).toHaveBeenCalledTimes(2);
      expect(answerExecutor).toHaveBeenCalledTimes(2);
    } finally {
      releaseRouting();
      await coordinator.stop();
    }
  });

  it('clears a failed routing flight so the durable accepted Turn can retry', async () => {
    const store = new FailFirstRoutingSaveOscarTurnStore();
    const classify = vi.fn(async () => (
      { lane: 'answer' as const, kind: 'general', confidence: 1, reason: 'retry fixture' }
    ));
    const coordinator = createCoordinator({
      persistentStore: store,
      dispositionProvider: { classify },
    });
    await coordinator.start();
    try {
      const input = submission('Проверь', 'client_failed_route_retry');
      await expect(coordinator.submit(input)).rejects.toThrow('synthetic routing save failure');

      const recovered = await coordinator.submit(input);
      const terminal = await waitForTerminal(coordinator, recovered.turn.id);

      expect((await store.listTurns())).toHaveLength(1);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(terminal.turn.status).toBe('succeeded');
    } finally {
      await coordinator.stop();
    }
  });

  it('reserves Stop before durable Turn creation and cancels it before routing', async () => {
    let enterPersonality = () => undefined;
    let releasePersonality = () => undefined;
    const personalityEntered = new Promise<void>((resolve) => { enterPersonality = resolve; });
    const personalityGate = new Promise<void>((resolve) => { releasePersonality = resolve; });
    const classify = vi.fn(async () => (
      { lane: 'answer' as const, kind: 'general', confidence: 1, reason: 'must not route' }
    ));
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const persisted: OscarPersistedMessage[] = [];
    const coordinator = createCoordinator({
      persisted,
      answerExecutor,
      dispositionProvider: { classify },
      resolvePersonality: async () => {
        enterPersonality();
        await personalityGate;
        return null;
      },
    });
    await coordinator.start();
    try {
      const input = submission('Проверь', 'client_cancel_before_accept');
      const submitting = coordinator.submit(input);
      await personalityEntered;

      const reserved = await coordinator.cancelByClientRequestId({
        clientRequestId: input.clientRequestId,
        source: input.source,
        privacyMode: input.privacyMode,
      });
      expect(reserved).toMatchObject({ reserved: true, checkpoint: null });

      releasePersonality();
      const cancelled = await submitting;
      expect(cancelled.turn.status).toBe('cancelled');
      expect(cancelled.turn.outcome?.summary).toBe(OSCAR_TURN_CANCELLED_SUMMARY);
      await waitFor(() => persisted.some((message) => message.role === 'assistant' && message.outcome === 'cancelled'));
      expect(persisted.find((message) => message.role === 'assistant' && message.outcome === 'cancelled')?.content)
        .toBe(OSCAR_TURN_CANCELLED_SUMMARY);
      expect(classify).not.toHaveBeenCalled();
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      releasePersonality();
      await coordinator.stop();
    }
  });

  it('cancels a Turn while disposition is blocked and suppresses every later effect', async () => {
    let enterRouting = () => undefined;
    let releaseRouting = () => undefined;
    const routingEntered = new Promise<void>((resolve) => { enterRouting = resolve; });
    const routingGate = new Promise<void>((resolve) => { releaseRouting = resolve; });
    const classify = vi.fn(async () => {
      enterRouting();
      await routingGate;
      return { lane: 'answer' as const, kind: 'general', confidence: 1, reason: 'late disposition' };
    });
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const store = new BlockingCancellationSaveOscarTurnStore();
    const coordinator = createCoordinator({
      persistentStore: store,
      answerExecutor,
      dispositionProvider: { classify },
    });
    let releaseCancellation = () => undefined;
    await coordinator.start();
    try {
      const input = submission('Проверь', 'client_cancel_during_route');
      const submitting = coordinator.submit(input);
      await routingEntered;

      const cancellationGate = store.blockNextCancellationSave();
      releaseCancellation = cancellationGate.release;
      const cancelling = coordinator.cancelByClientRequestId({
        clientRequestId: input.clientRequestId,
        source: input.source,
        privacyMode: input.privacyMode,
      });
      await cancellationGate.entered;
      releaseRouting();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(answerExecutor).not.toHaveBeenCalled();

      cancellationGate.release();
      const cancellation = await cancelling;
      expect(cancellation).toMatchObject({
        reserved: false,
        checkpoint: { turn: { status: 'cancelled' } },
      });

      const cancelled = await submitting;
      expect(cancelled.turn.status).toBe('cancelled');
      expect(classify).toHaveBeenCalledTimes(1);
      expect(answerExecutor).not.toHaveBeenCalled();
      expect(cancelled.events.some((event) => event.type === 'turn.routed')).toBe(false);
    } finally {
      releaseRouting();
      releaseCancellation();
      await coordinator.stop();
    }
  });

  it('scopes a pending client cancellation by privacy mode and surface', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Ответ.' },
      { type: 'done' },
    ]));
    const coordinator = createCoordinator({ answerExecutor });
    await coordinator.start();
    try {
      const clientRequestId = 'client_scoped_cancel_intent';
      await expect(coordinator.cancelByClientRequestId({
        clientRequestId,
        source: 'desktop',
        privacyMode: 'incognito',
      })).resolves.toMatchObject({ reserved: true, checkpoint: null });

      const persistent = await coordinator.submit(submission('Обычный вопрос', clientRequestId));
      expect((await waitForTerminal(coordinator, persistent.turn.id)).turn.status).toBe('succeeded');

      const incognito = await coordinator.submit({
        ...submission('Обычный вопрос', clientRequestId),
        privacyMode: 'incognito',
      });
      expect(incognito.turn.status).toBe('cancelled');
      expect(answerExecutor).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator.stop();
    }
  });

  it('honours a durable cancellation reservation during startup recovery', async () => {
    const store = new InMemoryOscarTurnStore();
    const clientRequestId = 'client_durable_cancel_restart';
    const accepted = acceptedTurnForClient(clientRequestId);
    await store.createTurn(accepted, {
      events: [{ type: 'turn.accepted', payload: { source: accepted.source } }],
    });
    await store.reserveClientCancellation({
      clientRequestId,
      source: accepted.source,
      privacyMode: accepted.privacyMode,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const classify = vi.fn(async () => (
      { lane: 'answer' as const, kind: 'general', confidence: 1, reason: 'must not restart' }
    ));
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({
      persistentStore: store,
      dispositionProvider: { classify },
      answerExecutor,
    });

    await coordinator.start();
    try {
      const recovered = await coordinator.getTurn(accepted.id);
      expect(recovered?.turn.status).toBe('cancelled');
      expect(classify).not.toHaveBeenCalled();
      expect(answerExecutor).not.toHaveBeenCalled();
      await expect(store.hasClientCancellation({
        clientRequestId,
        source: accepted.source,
        privacyMode: accepted.privacyMode,
      })).resolves.toBe(false);
    } finally {
      await coordinator.stop();
    }
  });

  it('pins the selected Personality V2 revision per persistent Desktop Turn and skips Incognito', async () => {
    let activeRevision = 4;
    const resolvePersonality = vi.fn(async () => personalityContext(activeRevision));
    const coordinator = createCoordinator({ resolvePersonality });
    await coordinator.start();
    try {
      const firstAccepted = await coordinator.submit(submission('Первый ход', 'client_personality_first'));
      const first = await waitForTerminal(coordinator, firstAccepted.turn.id);
      activeRevision = 5;
      const secondAccepted = await coordinator.submit(submission('Второй ход', 'client_personality_second'));
      const second = await waitForTerminal(coordinator, secondAccepted.turn.id);
      const incognitoAccepted = await coordinator.submit({
        ...submission('Инкогнито', 'client_personality_incognito'),
        privacyMode: 'incognito',
      });
      const incognito = await waitForTerminal(coordinator, incognitoAccepted.turn.id);

      expect(first.turn.request.personality).toMatchObject({
        profileId: 'personality-direct',
        profileRevision: 4,
      });
      expect(second.turn.request.personality).toMatchObject({
        profileId: 'personality-direct',
        profileRevision: 5,
      });
      expect(first.events.find((event) => event.type === 'turn.accepted')?.payload).toMatchObject({
        profileId: 'personality-direct',
        profileRevision: 4,
      });
      expect(incognito.turn.request.personality).toBeUndefined();
      expect(resolvePersonality).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps Memory V4 provenance distinct from public web sources', async () => {
    const coordinator = createCoordinator({
      answerExecutor: async () => stream([
        {
          type: 'sources',
          sources: [{
            id: 1,
            title: 'Из памяти · прошлый чат · 2026-08-03 · semantic+fts',
            url: 'memory://chat/conversation-old?item=episode-1',
            excerpt: 'Ранее выбрали оранжевую палитру.',
          }],
        },
        { type: 'token', token: 'Мы выбрали оранжевую палитру.' },
        { type: 'done' },
      ]),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Какую палитру мы выбрали?', 'client_memory_source'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn.outcome).toMatchObject({
        kind: 'answered:source-grounded',
        evidenceRefs: [{
          evidenceClass: 'external-source',
          reference: 'memory://chat/conversation-old?item=episode-1',
          summary: 'Из памяти · прошлый чат · 2026-08-03 · semantic+fts',
        }],
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('fails a non-egress Turn when the answer runtime returns an unexpected public source', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const coordinator = createCoordinator({
      persisted,
      answerExecutor: async () => stream([
        {
          type: 'sources',
          sources: [{
            id: 1,
            title: 'Unexpected public source',
            url: 'https://example.invalid/unexpected',
            excerpt: 'This source must not cross the consent boundary.',
          }],
        },
        { type: 'token', token: 'Этот ответ не должен считаться разрешённым.' },
        { type: 'done' },
      ]),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        'Что ты думаешь об этом локальном тексте?',
        'client_unexpected_external_source',
      ));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ status: 'failed', outcome: { kind: 'failed' } });
      expect(terminal.events.some((event) => event.type === 'answer.delta')).toBe(false);
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')).toMatchObject({
        outcome: 'failed',
        provenance: { origin: 'system', verification: 'system-state' },
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('rejects unexpected public sources returned by the recovery answer path', async () => {
    const answerFallback = vi.fn(async () => ({
      answer: 'Recovery must not smuggle an external answer across the consent boundary.',
      sources: [{
        id: 1,
        title: 'Unexpected recovery source',
        url: 'https://example.invalid/recovery',
        excerpt: 'No exact egress consent exists.',
      }],
    }));
    const coordinator = createCoordinator({
      answerExecutor: async () => stream([{ type: 'error', message: 'primary-runtime-failed' }]),
      answerFallback,
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        'Объясни локальную настройку кратко',
        'client_unexpected_recovery_source',
      ));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(answerFallback).toHaveBeenCalledTimes(1);
      expect(terminal.turn).toMatchObject({ status: 'failed', outcome: { kind: 'failed' } });
      expect(terminal.turn.outcome?.evidenceRefs).toEqual([]);
    } finally {
      await coordinator.stop();
    }
  });

  it('publishes an exact integrity-checked delta before done and replays the same bytes', async () => {
    const persisted: OscarPersistedMessage[] = [];
    let releaseDone = () => undefined;
    const doneGate = new Promise<void>((resolve) => { releaseDone = resolve; });
    const exact = 'Первая фраза.  \n\n```html\n<!doctype html>\n```';
    const coordinator = createCoordinator({
      persisted,
      answerExecutor: async () => (async function* () {
        yield { type: 'token' as const, token: 'Первая фраза.  ' };
        await doneGate;
        yield { type: 'token' as const, token: '\n\n```html\n<!doctype html>\n```' };
        yield { type: 'done' as const };
      })(),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Покажи пример', 'client_incremental_stream'));
      const streaming = await waitForTurn(coordinator, accepted.turn.id, (turn) => turn.status === 'answering');
      await waitFor(async () => Boolean((await coordinator.getTurn(accepted.turn.id))?.events.some((event) => event.type === 'answer.delta')));
      const beforeDone = await coordinator.getTurn(accepted.turn.id);
      expect(beforeDone?.turn.status).toBe('answering');
      expect(beforeDone?.events.some((event) => event.type === 'turn.outcome')).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseDone();

      const terminal = await waitForTerminal(coordinator, streaming.turn.id);
      const reconstructed = reconstructAnswer(terminal);
      expect(reconstructed).toBe(exact);
      expect(terminal.turn.outcome?.summary).toBe(exact);
      const firstDelta = terminal.events.find((event) => event.type === 'answer.delta');
      const outcome = terminal.events.find((event) => event.type === 'turn.outcome');
      expect(Date.parse(firstDelta!.createdAt)).toBeLessThan(Date.parse(outcome!.createdAt));
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')?.content).toBe(exact);
    } finally {
      releaseDone();
      await coordinator.stop();
    }
  });

  it('keeps answer-content generation on the answer lane when the decision model is unavailable', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: '<!doctype html><title>Tetris</title>' },
      { type: 'done' },
    ]));
    const createTask = vi.fn();
    const coordinator = createCoordinator({
      answerExecutor,
      runtime: mockRuntime({ createTask }),
      dispositionProvider: {
        classify: async () => { throw new Error('decision-model-unavailable'); },
      },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('напиши тетрис на html', 'client_answer_content'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ mode: 'answer', status: 'succeeded' });
      expect(terminal.turn.outcome?.summary).toContain('Tetris');
      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('answers the exact requested Monarch changelog without creating or planning an Agent task', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Список получил. Это материал для просмотра, действий не запускал.' },
      { type: 'done' },
    ]));
    const createTask = vi.fn();
    const coordinator = createCoordinator({
      answerExecutor,
      runtime: mockRuntime({ createTask }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission(exactMonarch025Changelog, 'client_exact_025_changelog'),
        history: materialReviewHistory,
      });
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ mode: 'answer', status: 'succeeded' });
      expect(terminal.events.find((event) => event.type === 'turn.routed')?.payload).toMatchObject({
        disposition: 'answer',
        kind: 'material_review',
      });
      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(createTask).not.toHaveBeenCalled();
      expect(terminal.events.some((event) => event.type === 'task.linked')).toBe(false);
      expect(terminal.events.some((event) => event.type === 'agent.progress')).toBe(false);
    } finally {
      await coordinator.stop();
    }
  });

  it('does not let a trailing descriptive list hide a leading operational command after an invitation', async () => {
    const checkpoint = runningAgentCheckpoint('agent_task_leading_command_before_list');
    const createTask = vi.fn(async () => checkpoint);
    const runtime = mockRuntime({ createTask, getTask: async () => checkpoint });
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({ runtime, answerExecutor });
    await coordinator.start();
    try {
      const request = 'Запусти backend. 1. Исправлена маршрутизация. 2. Добавлена история.';
      const accepted = await coordinator.submit({
        ...submission(request, 'client_leading_command_before_list'),
        history: materialReviewHistory,
      });
      const linked = await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(linked.turn).toMatchObject({ mode: 'agent', status: 'running', taskId: checkpoint.task.id });
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ request }));
      expect(answerExecutor).not.toHaveBeenCalled();
      expect(linked.events.some((event) => event.type === 'task.linked')).toBe(true);
    } finally {
      await coordinator.stop();
    }
  });

  it.each([
    {
      request: 'создай на рабочем столе текстовый файл с именем ромашка',
      clientRequestId: 'client_typed_file_effect',
      expectedKind: 'artifact',
      expectedId: 'requested_artifact',
    },
    {
      request: 'запусти калькулятор',
      clientRequestId: 'client_typed_system_effect',
      expectedKind: 'state-change',
      expectedId: 'requested_state_change',
    },
    {
      request: 'поставь громкость на 20%',
      clientRequestId: 'client_typed_volume_effect',
      expectedKind: 'state-change',
      expectedId: 'requested_state_change',
    },
    {
      request: 'закрой браузер',
      clientRequestId: 'client_typed_browser_effect',
      expectedKind: 'state-change',
      expectedId: 'requested_state_change',
    },
    {
      request: 'создай папку на рабочем столе тест',
      clientRequestId: 'client_typed_folder_effect',
      expectedKind: 'state-change',
      expectedId: 'requested_state_change',
    },
  ])('compiles the operational goal into a required verified effect: $request', async ({
    request,
    clientRequestId,
    expectedKind,
    expectedId,
  }) => {
    const checkpoint = runningAgentCheckpoint(`agent_task_${clientRequestId}`);
    const createTask = vi.fn(async () => checkpoint);
    const coordinator = createCoordinator({
      runtime: mockRuntime({ createTask, getTask: async () => checkpoint }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(request, clientRequestId));
      await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        request,
        expectedOutputs: [expect.objectContaining({
          id: expectedId,
          kind: expectedKind,
          required: true,
          description: expect.stringContaining(request),
        })],
        successCriteria: [expect.objectContaining({
          verificationHint: expect.stringMatching(/mutation truth|postcondition|read-after-write/i),
        })],
      }));
    } finally {
      await coordinator.stop();
    }
  });

  it('removes an explicit skill composer prefix before creating an operational Agent task', async () => {
    const checkpoint = runningAgentCheckpoint('agent_task_explicit_file_skill');
    const createTask = vi.fn(async () => checkpoint);
    const coordinator = createCoordinator({
      runtime: mockRuntime({ createTask, getTask: async () => checkpoint }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        '$monarch-file-guardian создай на рабочем столе новую папку',
        'client_explicit_file_skill',
      ));
      await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        request: 'создай на рабочем столе новую папку',
        expectedOutputs: [expect.objectContaining({
          description: expect.stringContaining('создай на рабочем столе новую папку'),
        })],
      }));
      expect(JSON.stringify(createTask.mock.calls[0]?.[0])).not.toContain('$monarch-file-guardian');
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps a Desktop file-summary request in adaptive Agent Runtime', async () => {
    const checkpoint = runningAgentCheckpoint('agent_task_desktop_summary_regression');
    const createTask = vi.fn(async () => checkpoint);
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'У меня нет прямого доступа к рабочему столу.' },
      { type: 'done' },
    ]));
    const coordinator = createCoordinator({
      agentFirst: true,
      runtime: mockRuntime({ createTask, getTask: async () => checkpoint }),
      answerExecutor,
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        '$monarch-file-guardian Перескажи все мои файлы на рабочем столе',
        'client_desktop_summary_regression',
      ));
      const linked = await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(linked.turn).toMatchObject({
        mode: 'agent',
        status: 'running',
        taskId: checkpoint.task.id,
      });
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        request: 'Перескажи все мои файлы на рабочем столе',
        planningMode: 'adaptive',
        expectedOutputs: [expect.objectContaining({
          id: 'operational_observation',
          kind: 'verification',
          required: true,
        })],
      }));
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('answers an ordinary question directly without creating an AgentTask', async () => {
    const createTask = vi.fn();
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Готов.' },
      { type: 'done' },
    ]));
    const coordinator = createCoordinator({
      agentFirst: true,
      runtime: mockRuntime({ createTask }),
      answerExecutor,
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        'Ответь одним словом: готов',
        'client_plain_answer_regression',
      ));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ mode: 'answer', status: 'succeeded' });
      expect(terminal.turn.taskId).toBeUndefined();
      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it.each([
    ['Создай змейку на HTML с уклонам на дизайн', 'client_snake_short'],
    [
      'Сделай полностью рабочую игру Змейка одним HTML-файлом. Формат ответа: выдай полный HTML-код одним блоком.',
      'client_snake_full',
    ],
  ])('keeps response-only HTML creation out of Agent Runtime: %s', async (request, clientRequestId) => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: '<!doctype html><title>Snake</title>' },
      { type: 'done' },
    ]));
    const createTask = vi.fn();
    const coordinator = createCoordinator({
      answerExecutor,
      runtime: mockRuntime({ createTask }),
      dispositionProvider: {
        classify: async () => ({ lane: 'agent', kind: 'wrong-fallback', confidence: 1, reason: 'fixture' }),
      },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(request, clientRequestId));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ mode: 'answer', status: 'succeeded' });
      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('routes a request to inspect the Monarch codebase into the verified Agent lane', async () => {
    const checkpoint = runningAgentCheckpoint('agent_task_monarch_code_review');
    const createTask = vi.fn(async () => checkpoint);
    const runtime = mockRuntime({ createTask, getTask: async () => checkpoint });
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({ runtime, answerExecutor });
    await coordinator.start();
    try {
      const request = 'Интересно более детально, можешь самостоятельно изучить код Monarch и сказать в чем разница?';
      const accepted = await coordinator.submit({
        ...submission(request, 'client_monarch_code_review'),
        modifiers: { requestedModel: 'qwen3.8-27b-pro', reasoningEffort: 'high' },
      });
      const linked = await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(linked.turn).toMatchObject({ mode: 'agent', status: 'running', taskId: checkpoint.task.id });
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        request,
        decisionModelPolicy: {
          requestedRole: 'qwen3.8-27b-pro',
          selectionSource: 'user-explicit',
          fallback: 'exact',
        },
      }));
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('stores an exact remember command through the typed settings receipt without Agent routing', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const rememberMemory = vi.fn(async () => ({
      receiptId: 'settings_receipt_memory_turn',
      revision: 4,
      contentHash: 'a'.repeat(64),
    }));
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const createTask = vi.fn();
    const coordinator = createCoordinator({
      persisted,
      rememberMemory,
      answerExecutor,
      runtime: mockRuntime({ createTask }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        'запомни: 1. Monarch 0.2.5 ещё не опубликован. 2. Stable остаётся 0.2.4.',
        'client_memory_command',
      ));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(rememberMemory).toHaveBeenCalledWith(expect.objectContaining({
        text: '1. Monarch 0.2.5 ещё не опубликован. 2. Stable остаётся 0.2.4.',
        turn: expect.objectContaining({ source: 'desktop', privacyMode: 'persistent' }),
      }));
      expect(answerExecutor).not.toHaveBeenCalled();
      expect(createTask).not.toHaveBeenCalled();
      expect(terminal.turn).toMatchObject({
        mode: 'answer',
        status: 'succeeded',
        outcome: {
          kind: 'verified',
          summary: 'Запомнил. Запись сохранена в постоянной памяти.',
          evidenceRefs: [{
            evidenceClass: 'kernel-verification',
            reference: 'settings-receipt:settings_receipt_memory_turn',
            checksum: 'a'.repeat(64),
          }],
        },
      });
      expect(terminal.events.some((event) => event.type === 'approval.required')).toBe(false);
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')?.provenance.verification).toBe('kernel-verified');
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps Incognito clean when asked to remember something', async () => {
    const rememberMemory = vi.fn();
    const coordinator = createCoordinator({ rememberMemory });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('запомни, что я люблю оранжевый', 'client_incognito_memory'),
        privacyMode: 'incognito',
      });
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(terminal.turn.outcome?.summary).toContain('Incognito не читает и не сохраняет');
      expect(rememberMemory).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('recovers once when the local stream closes without a terminal event', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Оборванный черновик' },
    ]));
    const answerFallback = vi.fn(async () => ({ answer: 'Восстановленный окончательный ответ.' }));
    const coordinator = createCoordinator({ answerExecutor, answerFallback });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Расскажи короткий факт'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(answerFallback).toHaveBeenCalledTimes(1);
      expect(terminal.turn.outcome).toMatchObject({
        kind: 'answered',
        summary: 'Восстановленный окончательный ответ.',
      });
      expect(terminal.events.some((event) => event.type === 'turn.outcome')).toBe(true);
      expect(terminal.events.some((event) => event.type === 'turn.failed')).toBe(false);
    } finally {
      await coordinator.stop();
    }
  });

  it('settles on the first successful terminal event and ignores poisoned late events', async () => {
    const answerFallback = vi.fn(async () => ({ answer: 'Fallback must not run.' }));
    const coordinator = createCoordinator({
      answerExecutor: async () => stream([
        { type: 'token', token: 'Первый завершённый ответ.' },
        { type: 'done', usage: { generation_stop_reason: 'stop' } },
        { type: 'token', token: ' poisoned-late-token' },
        { type: 'error', message: 'poisoned-late-error' },
      ]),
      answerFallback,
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Расскажи короткий факт о Луне', 'client_first_terminal'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({
        status: 'succeeded',
        outcome: { kind: 'answered', summary: 'Первый завершённый ответ.' },
      });
      expect(JSON.stringify(terminal)).not.toContain('poisoned-late');
      expect(answerFallback).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('recovers once when the backend rejects a done event after emitting partial text', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Частичный ответ, который нельзя считать готовым.  ' },
      { type: 'done', ok: false, failure: 'model-output-truncated' },
    ]));
    const answerFallback = vi.fn(async () => ({ answer: 'Полный восстановленный ответ.' }));
    const coordinator = createCoordinator({ answerExecutor, answerFallback });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Дай полный ответ', 'client_rejected_done_recovery'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(answerFallback).toHaveBeenCalledTimes(1);
      expect(terminal.turn).toMatchObject({
        status: 'succeeded',
        outcome: { kind: 'answered', summary: 'Полный восстановленный ответ.' },
      });
      expect(terminal.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'answer.replace',
          payload: { content: 'Полный восстановленный ответ.' },
        }),
      ]));
      expect(terminal.events.some((event) => event.type === 'turn.failed')).toBe(false);
    } finally {
      await coordinator.stop();
    }
  });

  it('durably fails instead of accepting partial text when rejected done has no recovery path', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const coordinator = createCoordinator({
      persisted,
      answerExecutor: async () => stream([
        { type: 'token', token: 'Незавершённый фрагмент.  ' },
        { type: 'done', ok: false, failure: 'oscar-answer-runtime-failed' },
      ]),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Расскажи о причине тестового сбоя', 'client_rejected_done_failure'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ status: 'failed', outcome: { kind: 'failed' } });
      expect(terminal.turn.outcome).toMatchObject({
        diagnostic: {
          code: 'oscar-answer-runtime-failed',
          detail: 'oscar-answer-runtime-failed',
        },
      });
      expect(terminal.turn.outcome?.summary).not.toContain('oscar-answer-runtime-failed');
      expect(terminal.events.some((event) => event.type === 'turn.failed')).toBe(true);
      expect(terminal.events.some((event) => event.type === 'turn.outcome')).toBe(false);
      expect(terminal.events.some((event) => (
        event.type === 'answer.delta'
        && (event.payload as any)?.content === 'Незавершённый фрагмент.  '
      ))).toBe(true);
      await waitFor(() => persisted.some((message) => message.turnId === accepted.turn.id && message.role === 'assistant'));
      const failureMessage = persisted.find((message) => message.turnId === accepted.turn.id && message.role === 'assistant');
      expect(failureMessage?.content).toBe(terminal.turn.outcome?.summary);
      expect(JSON.stringify(failureMessage)).not.toContain('oscar-answer-runtime-failed');
    } finally {
      await coordinator.stop();
    }
  });

  it('redacts an untrusted rejected-terminal failure before durable diagnostics', async () => {
    const secretFailure = 'provider failed with api_key=must-not-persist';
    const coordinator = createCoordinator({
      answerExecutor: async () => stream([
        { type: 'token', token: 'Незавершённый фрагмент.  ' },
        { type: 'done', ok: false, failure: secretFailure },
      ]),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Расскажи короткий факт о Марсе', 'client_untrusted_terminal_failure'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({
        status: 'failed',
        outcome: {
          kind: 'failed',
          diagnostic: {
            code: 'oscar-answer-runtime-failed',
            detail: 'oscar-answer-runtime-failed',
          },
        },
      });
      expect(JSON.stringify(terminal)).not.toContain(secretFailure);
      expect(JSON.stringify(terminal)).not.toContain('must-not-persist');
    } finally {
      await coordinator.stop();
    }
  });

  it('recovers the screenshot runtime-disconnected event instead of exposing it as the final answer', async () => {
    const answerFallback = vi.fn(async () => ({ answer: 'Надёжно восстановленный ответ.' }));
    const coordinator = createCoordinator({
      answerExecutor: async () => stream([{
        type: 'error',
        message: 'Локальный runtime завершился до финального события. Попробуй повторить запрос.',
      }]),
      answerFallback,
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('какое моё любимое блюдо?'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(answerFallback).toHaveBeenCalledTimes(1);
      expect(terminal.turn.outcome).toMatchObject({ kind: 'answered', summary: 'Надёжно восстановленный ответ.' });
      expect(JSON.stringify(terminal)).not.toContain('Попробуй повторить запрос');
    } finally {
      await coordinator.stop();
    }
  });

  it('persists only the integrity replacement when the answer model fabricates the incident audit', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const coordinator = createCoordinator({
      persisted,
      answerExecutor: async () => stream([
        { type: 'token', token: OSCAR_INCIDENT_FAKE_STORAGE_AUDIT },
        { type: 'done' },
      ]),
      dispositionProvider: {
        classify: async () => ({ lane: 'answer', kind: 'general', confidence: 1, reason: 'adversarial fixture' }),
      },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Ответь тестовой строкой'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));

      expect(terminal.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(terminal.events.filter((event) => event.type === 'answer.replace'))
        .toEqual([expect.objectContaining({ payload: expect.objectContaining({ content: expect.stringContaining('ничего не было выполнено') }) })]);
      expect(JSON.stringify(terminal.events)).not.toContain('D:\\Projects\\Archive');
      expect(persisted.filter((message) => message.role === 'assistant')).toEqual([
        expect.objectContaining({
          content: expect.stringContaining('ничего не было выполнено'),
          integrityWarning: expect.stringContaining('unverified-local-operation-claim'),
        }),
      ]);
    } finally {
      await coordinator.stop();
    }
  });

  it('routes the exact D drive audit to AgentTask and never calls the answer model', async () => {
    const checkpoint = runningAgentCheckpoint('agent_task_storage_audit');
    const createTask = vi.fn(async () => checkpoint);
    const runtime = mockRuntime({ createTask, getTask: async () => checkpoint });
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({ runtime, answerExecutor });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('проведи аудит папок на диске D'));
      const linked = await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(linked.turn).toMatchObject({ mode: 'agent', status: 'running', taskId: checkpoint.task.id });
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask.mock.calls[0]?.[0]).toMatchObject({
        request: 'проведи аудит папок на диске D',
        clientRequestId: `oscar_turn_task_${accepted.turn.id}`,
      });
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('routes the exact wrapped Downloads cleanup request to AgentTask and never calls the answer model', async () => {
    const checkpoint = runningAgentCheckpoint('agent_task_downloads_cleanup');
    const createTask = vi.fn(async () => checkpoint);
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({
      runtime: mockRuntime({ createTask, getTask: async () => checkpoint }),
      answerExecutor,
    });
    const request = '// задача: «Наведи порядок в „Загрузках“: разложи файлы по типам, устаревшее — в архив, дубликаты удали»';
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(request, 'client_downloads_cleanup'));
      const linked = await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(linked.turn).toMatchObject({ mode: 'agent', status: 'running', taskId: checkpoint.task.id });
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        request,
        planningMode: 'adaptive',
      }));
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('waits for an in-flight Agent reconciliation before stop resolves', async () => {
    const store = new BlockingReadOscarTurnStore();
    const running = runningAgentCheckpoint('agent_task_shutdown_reconcile');
    let listener: AgentTaskStoreListener | null = null;
    const runtime = mockRuntime({
      subscribe: (_taskId: string, next: AgentTaskStoreListener) => {
        listener = next;
        return () => { listener = null; };
      },
      createTask: async () => running,
      getTask: async () => running,
    });
    const coordinator = createCoordinator({ persistentStore: store, runtime });
    await coordinator.start();

    const accepted = await coordinator.submit(submission('проведи аудит папок на диске D', 'client_shutdown_reconcile'));
    await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));
    const gate = store.blockNextRead();
    const failed = structuredClone(running);
    failed.task.status = 'failed';
    failed.task.terminalReason = { code: 'unrecoverable-error', summary: 'Synthetic terminal failure.' };
    listener!({ task: failed.task, checkpoint: failed, appendedEvents: [], replayed: false });
    await gate.entered;

    let stopped = false;
    const stopping = coordinator.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.release();
    await stopping;

    expect((await store.getTurn(accepted.turn.id))?.turn.status).toBe('failed');
  });

  it('turns operational attachments into model-generated evidence and forces exact action-card policy', async () => {
    const checkpoint = runningAgentCheckpoint('agent_task_attachment_effect');
    const createTask = vi.fn(async () => checkpoint);
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'На изображении виден путь D:\\Temp\\candidate.txt.' },
      { type: 'done' },
    ]));
    const attachment = {
      id: 'oscar_attachment_fixture',
      name: 'target.png',
      mimeType: 'image/png',
      sizeBytes: 128,
      digest: 'sha256:attachment-fixture',
      dataBase64: 'iVBORw0KGgo=',
    };
    const coordinator = createCoordinator({
      runtime: mockRuntime({ createTask, getTask: async () => checkpoint }),
      answerExecutor,
      resolveAttachments: async () => [attachment],
      dispositionProvider: {
        classify: async () => ({ lane: 'agent', kind: 'operation', confidence: 1, reason: 'explicit effect' }),
      },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('Удали файл, который указан на изображении.', 'client_attachment_effect'),
        attachmentIds: [attachment.id],
      });
      await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
        actionApprovalPolicy: 'all-effects',
        initialObservations: [expect.objectContaining({
          capabilityId: 'models.vision.observe',
          summary: expect.stringContaining('D:\\Temp\\candidate.txt'),
          structuredData: expect.objectContaining({
            trust: 'untrusted-model-generated',
            instructionsAllowed: false,
          }),
          evidence: [expect.objectContaining({
            evidenceClass: 'model-generated',
            reference: `oscar-attachment:${attachment.id}`,
            checksum: attachment.digest,
          })],
        })],
      }));
    } finally {
      await coordinator.stop();
    }
  });

  it('blocks an operational attachment instead of falling back when vision observation is incomplete', async () => {
    const createTask = vi.fn();
    const coordinator = createCoordinator({
      runtime: mockRuntime({ createTask }),
      answerExecutor: async () => stream([{ type: 'token', token: 'Оборванное наблюдение.' }]),
      resolveAttachments: async () => [{
        id: 'oscar_attachment_incomplete',
        name: 'target.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        digest: 'sha256:attachment-incomplete',
        dataBase64: 'iVBORw0KGgo=',
      }],
      dispositionProvider: {
        classify: async () => ({ lane: 'agent', kind: 'operation', confidence: 1, reason: 'explicit effect' }),
      },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('Удали указанный на изображении файл.', 'client_attachment_incomplete'),
        attachmentIds: ['oscar_attachment_incomplete'],
      });
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn).toMatchObject({
        status: 'blocked',
        outcome: { kind: 'blocked', warning: 'attachment-observation-unavailable' },
      });
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('blocks an operational request when Agent Runtime is unavailable without chat fallback', async () => {
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({ answerExecutor, runtime: null });
    await coordinator.start();
    try {
      const terminal = await coordinator.submit(submission('проведи аудит папок на диске D'));

      expect(terminal.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(terminal.turn.outcome?.summary).toContain('не был отправлен в обычный чат');
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('persists a terminal Agent failure instead of leaving a user-only conversation', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const failed = runningAgentCheckpoint('agent_task_failed_model_plan');
    failed.task.status = 'failed';
    failed.task.terminalReason = {
      code: 'unrecoverable-error',
      summary: 'Agent decision did not pass the strict plan schema.',
    };
    const coordinator = createCoordinator({
      persisted,
      runtime: mockRuntime({
        createTask: async () => failed,
        getTask: async () => failed,
      }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        'проведи аудит папок на диске D',
        'client_failed_agent_persistence',
      ));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ status: 'failed', outcome: { kind: 'failed' } });
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')).toMatchObject({
        outcome: 'failed',
        provenance: { origin: 'system', verification: 'system-state' },
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('blocks web and deep research before model execution without exact data-egress consent', async () => {
    const answerExecutor = vi.fn(async () => stream([{ type: 'token', token: 'не должен появиться' }, { type: 'done' }]));
    const coordinator = createCoordinator({ answerExecutor });
    await coordinator.start();
    try {
      const terminal = await coordinator.submit({
        ...submission('Найди актуальные источники'),
        modifiers: { webSearch: true, researchMode: 'deep' },
      });
      expect(terminal.turn).toMatchObject({
        status: 'blocked',
        outcome: { kind: 'blocked', summary: expect.stringContaining('data-egress consent') },
      });
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it.each([
    ['Найди мне последние новости OpenAI', 'client_implicit_fresh_news'],
    [
      'мне нужен какой то сайт который позволит эффективно учить пайтон,найди такой сайт',
      'client_implicit_learning_site',
    ],
  ])('blocks an implicit external lookup before local inference: %s', async (request, clientRequestId) => {
    const persisted: OscarPersistedMessage[] = [];
    const answerExecutor = vi.fn(async () => stream([{ type: 'token', token: 'stale answer' }, { type: 'done' }]));
    const createTask = vi.fn();
    const coordinator = createCoordinator({
      persisted,
      answerExecutor,
      runtime: mockRuntime({ createTask }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(
        request,
        clientRequestId,
      ));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({
        mode: 'answer',
        status: 'blocked',
        outcome: { kind: 'blocked', summary: expect.stringContaining('актуальные публичные источники') },
      });
      expect(answerExecutor).not.toHaveBeenCalled();
      expect(createTask).not.toHaveBeenCalled();
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')).toMatchObject({
        content: expect.stringContaining('актуальные публичные источники'),
        outcome: 'blocked',
        provenance: { origin: 'system', verification: 'system-state' },
      });
      expect(persisted.find((message) => message.role === 'assistant')?.messageId.length).toBeLessThanOrEqual(64);
      expect(terminal.turn.outputMessageId).toMatch(/^oscar_message_terminal_[a-f0-9]{32}$/);
    } finally {
      await coordinator.stop();
    }
  });

  it('consumes exact data-egress consent once before an answer-only model call', async () => {
    const consumeDataEgressConsent = vi.fn(async () => undefined);
    const answerExecutor = vi.fn(async () => stream([
      {
        type: 'sources',
        sources: [{
          id: 1,
          title: 'Разрешённый публичный источник',
          url: 'https://example.com/allowed',
          excerpt: 'Bound to the exact consented Turn.',
        }],
      },
      { type: 'token', token: 'Ответ с источником.' },
      { type: 'done' },
    ]));
    const coordinator = createCoordinator({ answerExecutor, consumeDataEgressConsent });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('Найди актуальные источники', 'client_egress_turn'),
        modifiers: { webSearch: true, researchMode: 'auto', dataEgressConsentId: 'egress_exact_1' },
      });
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(consumeDataEgressConsent).toHaveBeenCalledTimes(1);
      expect(consumeDataEgressConsent).toHaveBeenCalledWith('egress_exact_1', expect.objectContaining({ id: accepted.turn.id }));
      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(terminal.turn.outcome?.kind).toBe('answered:source-grounded');
      expect(terminal.events).toContainEqual(expect.objectContaining({
        type: 'agent.progress',
        payload: expect.objectContaining({
          label: 'Поиск · Интернет',
          detail: 'Найди актуальные источники',
          activity: expect.objectContaining({ domain: 'internet', motion: 'breathing' }),
        }),
      }));
    } finally {
      await coordinator.stop();
    }
  });

  it('reroutes an exact router clarification on the same durable Turn and persists the continuation', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const checkpoint = runningAgentCheckpoint('agent_task_after_clarification');
    const createTask = vi.fn(async () => checkpoint);
    const classify = vi.fn(async ({ text }: { text: string }) => (
      text.includes('Уточнение пользователя')
        ? { lane: 'agent' as const, kind: 'operation', confidence: 1, reason: 'exact target supplied' }
        : { lane: 'clarify' as const, kind: 'ambiguous', confidence: 1, reason: 'missing target' }
    ));
    const coordinator = createCoordinator({
      persisted,
      runtime: mockRuntime({ createTask, getTask: async () => checkpoint }),
      dispositionProvider: { classify },
    });
    await coordinator.start();
    try {
      const waiting = await coordinator.submit(submission('Проверь', 'client_clarify_1'));
      expect(waiting.turn.status).toBe('waiting-for-user');
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')).toMatchObject({
        content: 'Укажи точную цель операции, чтобы Monarch мог проверить её policy.',
        provenance: { origin: 'system', verification: 'system-state' },
      });
      expect(persisted.find((message) => message.role === 'assistant')?.messageId).toMatch(
        /^oscar_message_clarification_[a-f0-9]{32}$/,
      );
      expect(persisted.find((message) => message.role === 'assistant')?.messageId.length).toBeLessThanOrEqual(64);
      const continued = await coordinator.sendMessage(waiting.turn.id, {
        content: 'Точная цель D:\\',
        messageId: 'clarification_message_1',
        source: 'desktop',
      });
      expect(continued.turn.id).toBe(waiting.turn.id);
      const linked = await waitForTurn(coordinator, waiting.turn.id, (turn) => Boolean(turn.taskId));
      expect(linked.turn).toMatchObject({ status: 'running', taskId: checkpoint.task.id });
      expect(createTask.mock.calls[0]?.[0]?.request).toContain('Уточнение пользователя 1: Точная цель D:\\');
      await waitFor(() => persisted.some((message) => message.messageId === 'clarification_message_1'));
      expect(persisted.find((message) => message.messageId === 'clarification_message_1')).toMatchObject({
        role: 'user',
        turnId: waiting.turn.id,
        provenance: { verification: 'user-assertion' },
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('starts a fresh Agent Turn when a complete new operation arrives during an old clarification', async () => {
    const oldCheckpoint = runningAgentCheckpoint('agent_task_old_ambiguous');
    oldCheckpoint.task.status = 'waiting-for-user';
    oldCheckpoint.task.messages.push({
      id: 'agent_old_clarification',
      role: 'assistant',
      kind: 'clarification',
      content: 'Какое именно приложение открыть?',
      createdAt: oldCheckpoint.task.createdAt,
    });
    const newCheckpoint = runningAgentCheckpoint('agent_task_new_exact');
    const createTask = vi.fn(async (input: { request: string }) => (
      input.request.includes('qwxzvbnmjk') ? newCheckpoint : oldCheckpoint
    ));
    const cancel = vi.fn(async () => oldCheckpoint);
    const getTask = vi.fn(async (taskId: string) => (
      taskId === newCheckpoint.task.id ? newCheckpoint : oldCheckpoint
    ));
    const coordinator = createCoordinator({
      runtime: mockRuntime({ createTask, cancel, getTask }),
    });
    await coordinator.start();
    try {
      const oldAccepted = await coordinator.submit(submission(
        'открой zzqvmonarchfixture',
        'client_stale_operation_old',
      ));
      const oldWaiting = await waitForTurn(
        coordinator,
        oldAccepted.turn.id,
        (turn) => turn.status === 'waiting-for-user',
      );

      const fresh = await coordinator.submit({
        ...submission('открой qwxzvbnmjk', 'client_stale_operation_new'),
        replyToTurnId: oldWaiting.turn.id,
      });
      const freshLinked = await waitForTurn(
        coordinator,
        fresh.turn.id,
        (turn) => Boolean(turn.taskId),
      );
      const oldTerminal = await coordinator.getTurn(oldWaiting.turn.id);

      expect(fresh.turn.id).not.toBe(oldWaiting.turn.id);
      expect(fresh.turn.supersedesTurnId).toBe(oldWaiting.turn.id);
      expect(freshLinked.turn.taskId).toBe(newCheckpoint.task.id);
      expect(oldTerminal?.turn.status).toBe('cancelled');
      expect(cancel).toHaveBeenCalledWith(oldCheckpoint.task.id);
      expect(createTask).toHaveBeenCalledTimes(2);
      expect(createTask.mock.calls[1]?.[0]?.request).toBe('открой qwxzvbnmjk');
    } finally {
      await coordinator.stop();
    }
  });

  it('runs Incognito operational Turns in a disposable adaptive Agent runtime', async () => {
    const persistentStore = new InMemoryOscarTurnStore();
    const volatileStore = new InMemoryOscarTurnStore();
    const persisted: OscarPersistedMessage[] = [];
    const persistentCreateTask = vi.fn();
    const discardTask = vi.fn(async () => true);
    const checkpoint = runningAgentCheckpoint('agent_task_incognito');
    checkpoint.task.eventSequence = 4;
    checkpoint.events = [
      {
        schemaVersion: 'monarch.agent-task-event.v1',
        id: 'event_incognito_model',
        taskId: checkpoint.task.id,
        traceId: checkpoint.task.traceId,
        sequence: 1,
        type: 'model.started',
        createdAt: checkpoint.task.createdAt,
        payload: { phase: 'planning', repair: false },
      },
      {
        schemaVersion: 'monarch.agent-task-event.v1',
        id: 'event_incognito_plan',
        taskId: checkpoint.task.id,
        traceId: checkpoint.task.traceId,
        sequence: 3,
        type: 'plan.revised',
        createdAt: checkpoint.task.createdAt,
        payload: {
          revision: 2,
          summary: 'Определить точную рабочую область и затем создать скрипты.',
          steps: [{ title: 'Проверить рабочую область', expectedEffect: 'Путь подтверждён' }],
        },
      },
      {
        schemaVersion: 'monarch.agent-task-event.v1',
        id: 'event_incognito_tool',
        taskId: checkpoint.task.id,
        traceId: checkpoint.task.traceId,
        sequence: 4,
        type: 'tool.started',
        createdAt: checkpoint.task.createdAt,
        payload: {
          capabilityId: 'workspace.files.search',
          activity: {
            operation: 'search',
            domain: 'files',
            subject: 'release manifest',
            target: 'src',
            motion: 'breathing',
          },
        },
      },
    ];
    const incognitoCreateTask = vi.fn(async () => checkpoint);
    const incognitoRuntime = mockRuntime({
      createTask: incognitoCreateTask,
      getTask: async (taskId: string) => taskId === checkpoint.task.id ? checkpoint : null,
      discardTask,
    });
    const coordinator = createCoordinator({
      persistentStore,
      volatileStore,
      persisted,
      runtime: mockRuntime({ createTask: persistentCreateTask }),
      incognitoRuntime,
      dispositionProvider: {
        classify: async () => ({ lane: 'agent', kind: 'local-effect', confidence: 1, reason: 'explicit-operational-request' }),
      },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('ты можешь создать нужные мне скрипты по указанному пути?', 'client_incognito_agent'),
        privacyMode: 'incognito',
      });
      const linked = await waitForTurn(coordinator, accepted.turn.id, (turn) => Boolean(turn.taskId));

      expect(linked.turn).toMatchObject({ status: 'running', privacyMode: 'incognito', taskId: checkpoint.task.id });
      expect(await persistentStore.listTurns()).toEqual([]);
      expect(await volatileStore.listTurns()).toHaveLength(1);
      expect(persistentCreateTask).not.toHaveBeenCalled();
      expect(incognitoCreateTask).toHaveBeenCalledWith(expect.objectContaining({
        request: 'ты можешь создать нужные мне скрипты по указанному пути?',
        planningMode: 'adaptive',
      }));
      expect(linked.events.filter((event) => event.type === 'agent.progress').map((event) => event.payload.label))
        .toEqual(['План · Задача', 'План · Готов', 'Поиск · Файлы']);
      expect(linked.events.filter((event) => event.type === 'agent.progress').at(-1)?.payload).toMatchObject({
        detail: 'release manifest · в src',
        activity: {
          operation: 'search',
          domain: 'files',
          motion: 'breathing',
        },
      });
      expect(persisted).toEqual([]);
      await expect(coordinator.discardIncognitoConversation('conversation_1', 'desktop')).resolves.toBe(1);
      expect(discardTask).toHaveBeenCalledWith(checkpoint.task.id);
      expect(await volatileStore.listTurns()).toEqual([]);
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps encrypted Safe operational Turns answer-only and fail-closed', async () => {
    const persistentStore = new InMemoryOscarTurnStore();
    const volatileStore = new InMemoryOscarTurnStore();
    const createTask = vi.fn();
    const coordinator = createCoordinator({
      persistentStore,
      volatileStore,
      runtime: mockRuntime({ createTask }),
    });
    await coordinator.start();
    try {
      const terminal = await coordinator.submit({
        ...submission('проведи аудит папок на диске D'),
        privacyMode: 'encrypted',
      });

      expect(terminal.turn).toMatchObject({ status: 'blocked', privacyMode: 'encrypted' });
      expect(await persistentStore.listTurns()).toEqual([]);
      expect(await volatileStore.listTurns()).toHaveLength(1);
      expect(createTask).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('treats typed confirmation as non-authoritative and replays the exact pending action-card', async () => {
    const store = new InMemoryOscarTurnStore();
    const approvalCheckpoint = pendingApprovalCheckpoint('agent_task_pending', 'approval_pending');
    await store.createTurn(waitingApprovalTurn(approvalCheckpoint));
    const resolveApproval = vi.fn();
    const coordinator = createCoordinator({
      persistentStore: store,
      runtime: mockRuntime({
        getTask: async () => approvalCheckpoint,
        resolveApproval,
      }),
    });
    await coordinator.start();
    try {
      const terminal = await coordinator.submit(submission('подтверждаю', 'client_confirm_1'));

      expect(terminal.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(terminal.events.map((event) => event.type)).toEqual(expect.arrayContaining([
        'non-authoritative-confirmation',
        'approval.required',
        'turn.outcome',
      ]));
      const presentation = terminal.events.find((event) => event.type === 'approval.required');
      expect(presentation?.payload).toMatchObject({
        taskId: 'agent_task_pending',
        approvalId: 'approval_pending',
        capabilityId: 'workspace.files.delete',
        canonicalProposalHash: 'sha256:pending',
      });
      expect(resolveApproval).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('blocks standalone typed confirmation when no exact action-card exists', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Начинаю сканирование папки "Загрузки".' },
      { type: 'done' },
    ]));
    const coordinator = createCoordinator({ answerExecutor });
    await coordinator.start();
    try {
      const terminal = await coordinator.submit(submission('подтверждаю', 'client_confirm_without_card'));

      expect(terminal.turn).toMatchObject({
        status: 'blocked',
        outcome: {
          kind: 'blocked',
          summary: expect.stringContaining('активной action-card нет'),
        },
      });
      expect(terminal.events).toContainEqual(expect.objectContaining({
        type: 'non-authoritative-confirmation',
        payload: expect.objectContaining({ activeApproval: false }),
      }));
      expect(answerExecutor).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('never creates a verified Turn without a successful Agent completion verifier record', async () => {
    const store = new InMemoryOscarTurnStore();
    const checkpoint = completedAgentCheckpoint('agent_task_missing_verifier', {
      capabilityId: 'workspace.storage.audit',
      evidenceClass: 'kernel-observation',
      includeCompletionVerifier: false,
    });
    await store.createTurn(linkedAgentTurn(checkpoint.task.id));
    const coordinator = createCoordinator({
      persistentStore: store,
      runtime: mockRuntime({ getTask: async () => checkpoint }),
    });
    await coordinator.start();
    try {
      const terminal = await waitForTerminal(coordinator, 'oscar_turn_linked');
      expect(terminal.turn).toMatchObject({ status: 'failed', outcome: { kind: 'failed' } });
      expect(terminal.turn.outcome?.summary).toBe(
        'Не удалось завершить задачу. Технические детали сохранены локально; неподтверждённые действия не считаются выполненными.',
      );
      expect(terminal.turn.outcome?.summary).not.toContain('Kernel verifier');
    } finally {
      await coordinator.stop();
    }
  });

  it.each([
    { stepStatus: 'ready' as const, reason: 'unfinished plan work' },
    { stepStatus: 'completed' as const, reason: 'missing mutation evidence' },
  ])('rejects a root-only completed file task with $reason', async ({ stepStatus }) => {
    const store = new InMemoryOscarTurnStore();
    const checkpoint = completedAgentCheckpoint(`agent_task_root_only_${stepStatus}`, {
      capabilityId: 'workspace.root.get',
      evidenceClass: 'kernel-observation',
      summary: 'Workspace root observed.',
    });
    checkpoint.task.goal.expectedOutputs = [{
      id: 'requested_artifact',
      kind: 'artifact',
      required: true,
      description: 'The requested Desktop text file named ромашка exists.',
    }];
    checkpoint.task.goal.successCriteria = [{
      id: 'requested_artifact_verified',
      description: 'The requested file write is verified by a Kernel postcondition.',
    }];
    checkpoint.task.plan = {
      id: `plan_root_only_${stepStatus}`,
      revision: 2,
      goalSummary: 'Create the requested Desktop file.',
      createdAt: checkpoint.task.createdAt,
      steps: [{
        id: `step_root_only_${stepStatus}`,
        title: 'Create File',
        status: stepStatus,
        dependsOn: [],
        expectedEffects: [{ kind: 'artifact', description: 'The requested file exists.' }],
        verification: [{ kind: 'exists', description: 'The requested file exists.' }],
      }],
    };
    if (stepStatus === 'ready') checkpoint.task.currentStepId = checkpoint.task.plan.steps[0]!.id;
    await store.createTurn(linkedAgentTurn(checkpoint.task.id));
    const coordinator = createCoordinator({
      persistentStore: store,
      runtime: mockRuntime({ getTask: async () => checkpoint }),
    });
    await coordinator.start();
    try {
      const terminal = await waitForTerminal(coordinator, 'oscar_turn_linked');
      expect(terminal.turn).toMatchObject({ status: 'failed', outcome: { kind: 'failed' } });
      expect(terminal.turn.outcome?.summary).not.toContain('Workspace root observed');
    } finally {
      await coordinator.stop();
    }
  });

  it('marks a mutating result partial when receipt-bound predicate verification is absent', async () => {
    const store = new InMemoryOscarTurnStore();
    const persisted: OscarPersistedMessage[] = [];
    const checkpoint = completedAgentCheckpoint('agent_task_weak_mutation', {
      capabilityId: 'workspace.files.write',
      evidenceClass: 'kernel-observation',
      mutation: true,
    });
    await store.createTurn(linkedAgentTurn(checkpoint.task.id));
    const coordinator = createCoordinator({
      persistentStore: store,
      persisted,
      runtime: mockRuntime({ getTask: async () => checkpoint }),
    });
    await coordinator.start();
    try {
      const terminal = await waitForTerminal(coordinator, 'oscar_turn_linked');
      expect(terminal.turn).toMatchObject({ status: 'succeeded', outcome: { kind: 'partial' } });
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')?.provenance.verification).toBe('kernel-partial');
    } finally {
      await coordinator.stop();
    }
  });

  it('finishes models.agent.respond as answered and never as verified', async () => {
    const store = new InMemoryOscarTurnStore();
    const persisted: OscarPersistedMessage[] = [];
    const checkpoint = completedAgentCheckpoint('agent_task_model_answer', {
      capabilityId: 'models.agent.respond',
      evidenceClass: 'model-generated',
      summary: 'Это обычный ответ модели.',
    });
    await store.createTurn(linkedAgentTurn(checkpoint.task.id, 'Ответь на вопрос'));
    const coordinator = createCoordinator({
      persistentStore: store,
      persisted,
      runtime: mockRuntime({ getTask: async () => checkpoint }),
    });
    await coordinator.start();
    try {
      const terminal = await waitForTerminal(coordinator, 'oscar_turn_linked');
      expect(terminal.turn).toMatchObject({ status: 'succeeded', outcome: { kind: 'answered' } });
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')?.provenance).toMatchObject({
        origin: 'model',
        verification: 'unverified-model',
        taskId: checkpoint.task.id,
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('reconciles a durable Turn-to-Task crash gap after restart', async () => {
    const store = new InMemoryOscarTurnStore();
    const first = createCoordinator({ persistentStore: store, runtime: mockRuntime() });
    const accepted = await first.submit(submission('проведи аудит папок на диске D', 'client_restart_1'));
    expect(accepted.turn.taskId).toBeUndefined();
    expect(await store.listPendingOutbox()).toEqual([
      expect.objectContaining({ kind: 'persist-message' }),
      expect.objectContaining({ kind: 'create-agent-task' }),
    ]);

    const checkpoint = runningAgentCheckpoint('agent_task_after_restart');
    const createTask = vi.fn(async () => checkpoint);
    const persistMessage = vi.fn(async () => ({ disposition: 'created' as const }));
    const restarted = createCoordinator({
      persistentStore: store,
      runtime: mockRuntime({ createTask, getTask: async () => checkpoint }),
      persistMessage,
    });
    await restarted.start();
    try {
      const linked = await waitForTurn(restarted, accepted.turn.id, (turn) => Boolean(turn.taskId));
      expect(linked.turn.taskId).toBe('agent_task_after_restart');
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask.mock.invocationCallOrder[0]).toBeLessThan(persistMessage.mock.invocationCallOrder[0]!);
    } finally {
      await restarted.stop();
    }
  });

  it('relinks an already-created idempotent AgentTask after a task-to-Turn crash gap', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = linkedAgentTurn('placeholder_task');
    delete turn.taskId;
    await store.createTurn({ ...turn, status: 'running' }, {
      outbox: [{ id: 'outbox_create_existing_task', turnId: turn.id, kind: 'create-agent-task', payload: {} }],
    });
    const existing = runningAgentCheckpoint('agent_task_created_before_crash');
    const createTask = vi.fn(async (input) => {
      expect(input.clientRequestId).toBe(`oscar_turn_task_${turn.id}`);
      return existing;
    });
    const restarted = createCoordinator({
      persistentStore: store,
      runtime: mockRuntime({ createTask, getTask: async () => existing }),
    });
    await restarted.start();
    try {
      const linked = await waitForTurn(restarted, turn.id, (candidate) => Boolean(candidate.taskId));
      expect(linked.turn.taskId).toBe(existing.task.id);
      expect(createTask).toHaveBeenCalledTimes(1);
    } finally {
      await restarted.stop();
    }
  });

  it('retries the terminal message outbox after restart without changing the verified Turn', async () => {
    const store = new InMemoryOscarTurnStore();
    const checkpoint = completedAgentCheckpoint('agent_task_message_gap', {
      capabilityId: 'workspace.storage.audit',
      evidenceClass: 'kernel-observation',
    });
    await store.createTurn(linkedAgentTurn(checkpoint.task.id));
    const firstPersist = vi.fn(async () => { throw new Error('simulated-message-store-gap'); });
    const first = createCoordinator({
      persistentStore: store,
      runtime: mockRuntime({ getTask: async () => checkpoint }),
      persistMessage: firstPersist,
    });
    await first.start();
    const terminalBeforeRestart = await waitForTerminal(first, 'oscar_turn_linked');
    expect(terminalBeforeRestart.turn.outcome?.kind).toBe('verified');
    await waitFor(() => firstPersist.mock.calls.length > 0);
    await first.stop();

    const persisted: OscarPersistedMessage[] = [];
    const restarted = createCoordinator({
      persistentStore: store,
      persisted,
      runtime: mockRuntime({ getTask: async () => checkpoint }),
    });
    await restarted.start();
    try {
      await waitFor(() => persisted.some((message) => message.turnId === 'oscar_turn_linked'), 4_000);
      const terminalAfterRestart = await restarted.getTurn('oscar_turn_linked');
      expect(terminalAfterRestart?.turn).toMatchObject({ status: 'succeeded', outcome: { kind: 'verified' } });
      expect(persisted.filter((message) => message.turnId === 'oscar_turn_linked')).toHaveLength(1);
    } finally {
      await restarted.stop();
    }
  });

  it('keeps both messages retryable when only the user append fails before a terminal append', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('partial-append');
    await store.createTurn(turn, {
      outbox: [
        persistedMessageOutbox(turn, {
          messageId: turn.inputMessageId,
          role: 'user',
          content: 'Проверь частичный сбой.',
        }),
        persistedMessageOutbox(turn, {
          messageId: turn.outputMessageId!,
          role: 'assistant',
          content: turn.outcome!.summary,
          requiredPreviousMessageId: turn.inputMessageId,
        }),
      ],
    });
    const persisted = new Map<string, OscarPersistedMessage>();
    let failFirstUserAppend = true;
    const persistMessage = vi.fn(async (message: OscarPersistedMessage) => {
      if (message.role === 'user' && failFirstUserAppend) {
        failFirstUserAppend = false;
        throw new Error('simulated isolated user append outage');
      }
      if (message.role === 'assistant' && !persisted.has(message.requiredPreviousMessageId || '')) {
        throw new Error('required previous user message has not been persisted yet');
      }
      if (persisted.has(message.messageId)) return { disposition: 'duplicate' as const };
      persisted.set(message.messageId, message);
      return { disposition: 'created' as const };
    });
    const first = createCoordinator({ persistentStore: store, persistMessage });

    await first.start();
    await first.stop();
    expect(persisted.size).toBe(0);
    expect(persistMessage.mock.calls.map(([message]) => message.role)).toEqual(['user', 'assistant']);

    for (const item of await store.listPendingOutbox(new Date('2030-01-01T00:00:00.000Z'))) {
      await store.markOutboxFailed(item.id, 'force immediate restart retry', new Date(0).toISOString());
    }
    const restarted = createCoordinator({ persistentStore: store, persistMessage });
    await restarted.start();
    await restarted.stop();

    expect([...persisted.values()].map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(persistMessage.mock.calls.map(([message]) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(await store.listPendingOutbox(new Date('2030-01-01T00:00:00.000Z'))).toEqual([]);
  });

  it('settles an exact duplicate after a crash between remote append and local acknowledgement', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('remote-append-crash');
    const userOutbox = persistedMessageOutbox(turn, {
      messageId: turn.inputMessageId,
      role: 'user',
      content: 'Сохрани ровно один раз.',
    });
    await store.createTurn(turn, { outbox: [userOutbox] });
    const remoteMessages = new Set<string>();
    let crashAfterFirstAppend = true;
    const persistMessage = vi.fn(async (message: OscarPersistedMessage) => {
      if (remoteMessages.has(message.messageId)) return { disposition: 'duplicate' as const };
      remoteMessages.add(message.messageId);
      if (crashAfterFirstAppend) {
        crashAfterFirstAppend = false;
        throw new Error('simulated crash after remote commit');
      }
      return { disposition: 'created' as const };
    });
    const first = createCoordinator({ persistentStore: store, persistMessage });
    await first.start();
    await first.stop();
    await store.markOutboxFailed(userOutbox.id, 'force immediate replay', new Date(0).toISOString());

    const restarted = createCoordinator({ persistentStore: store, persistMessage });
    await restarted.start();
    await restarted.stop();

    expect(remoteMessages).toEqual(new Set([turn.inputMessageId]));
    expect(persistMessage).toHaveBeenCalledTimes(2);
    expect(await store.listPendingOutbox(new Date('2030-01-01T00:00:00.000Z'))).toEqual([]);
  });

  it('retires a stale terminal append when the backend reports it as superseded', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('superseded-terminal');
    await store.createTurn(turn, {
      outbox: [persistedMessageOutbox(turn, {
        messageId: turn.outputMessageId!,
        role: 'assistant',
        content: turn.outcome!.summary,
        requiredPreviousMessageId: turn.inputMessageId,
      })],
    });
    const persistMessage = vi.fn(async () => ({ disposition: 'superseded' as const }));
    const first = createCoordinator({ persistentStore: store, persistMessage });
    await first.start();
    await first.stop();

    const replay = vi.fn(async () => { throw new Error('superseded outbox replayed'); });
    const restarted = createCoordinator({ persistentStore: store, persistMessage: replay });
    await restarted.start();
    await restarted.stop();

    expect(persistMessage).toHaveBeenCalledTimes(1);
    expect(replay).not.toHaveBeenCalled();
    expect(await store.listPendingOutbox(new Date('2030-01-01T00:00:00.000Z'))).toEqual([]);
  });

  it('does not accept a superseded receipt for a user message', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('invalid-user-supersession');
    await store.createTurn(turn, {
      outbox: [persistedMessageOutbox(turn, {
        messageId: turn.inputMessageId,
        role: 'user',
        content: 'Этот вопрос нельзя молча потерять.',
      })],
    });
    const coordinator = createCoordinator({
      persistentStore: store,
      persistMessage: async () => ({ disposition: 'superseded' }),
    });

    await coordinator.start();
    await coordinator.stop();

    await expect(store.listPendingOutbox(new Date('2030-01-01T00:00:00.000Z'))).resolves.toEqual([
      expect.objectContaining({
        kind: 'persist-message',
        status: 'retrying',
        lastError: 'Only a prerequisite-bound assistant message may be superseded.',
      }),
    ]);
  });

  it('recovers a historical terminal Turn message after restart without replaying the task', async () => {
    const store = new InMemoryOscarTurnStore();
    const created = await store.createTurn(linkedAgentTurn('agent_task_legacy_terminal'));
    await store.saveTurn({
      ...created.turn,
      status: 'failed',
      outcome: {
        kind: 'failed',
        summary: 'Не удалось завершить задачу. Технические детали сохранены локально.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, {
      expectedRevision: created.turn.revision,
      events: [{ type: 'turn.failed', payload: { outcome: 'failed' } }],
    });
    const persisted: OscarPersistedMessage[] = [];
    const getTask = vi.fn();
    const restarted = createCoordinator({
      persistentStore: store,
      persisted,
      runtime: mockRuntime({ getTask }),
    });

    await restarted.start();
    try {
      await waitFor(() => persisted.some((message) => message.turnId === created.turn.id));
      const recovered = await restarted.getTurn(created.turn.id);
      expect(recovered?.turn.outputMessageId).toMatch(/^oscar_message_terminal_[a-f0-9]{32}$/);
      expect(persisted).toEqual([
        expect.objectContaining({
          role: 'assistant',
          content: 'Не удалось завершить задачу. Технические детали сохранены локально.',
          turnId: created.turn.id,
          taskId: 'agent_task_legacy_terminal',
          outcome: 'failed',
          createConversationIfMissing: false,
          requiredPreviousMessageId: created.turn.inputMessageId,
          provenance: expect.objectContaining({ origin: 'system', verification: 'system-state' }),
        }),
      ]);
      expect(getTask).not.toHaveBeenCalled();
    } finally {
      await restarted.stop();
    }

    const secondGetTask = vi.fn();
    const secondRestart = createCoordinator({
      persistentStore: store,
      persisted,
      runtime: mockRuntime({ getTask: secondGetTask }),
    });
    await secondRestart.start();
    await secondRestart.stop();
    expect(persisted).toHaveLength(1);
    expect(secondGetTask).not.toHaveBeenCalled();
  });

  it('does not recover synthetic legacy API terminal Turns into chat history', async () => {
    const store = new InMemoryOscarTurnStore();
    const legacy = {
      ...linkedAgentTurn('agent_task_legacy_api'),
      id: 'oscar_turn_legacy_api_terminal',
      clientRequestId: 'client_legacy_api_terminal',
      conversationId: 'legacy:api:smoke-terminal',
      inputMessageId: 'message_legacy_api_terminal',
      source: 'api' as const,
    };
    const created = await store.createTurn(legacy);
    await store.saveTurn({
      ...created.turn,
      status: 'blocked',
      outcome: {
        kind: 'blocked',
        summary: 'Agent Runtime недоступен.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, { expectedRevision: created.turn.revision });
    const persisted: OscarPersistedMessage[] = [];
    const getTask = vi.fn();
    const restarted = createCoordinator({
      persistentStore: store,
      persisted,
      runtime: mockRuntime({ getTask }),
    });

    await restarted.start();
    await restarted.stop();

    expect((await store.getTurn(legacy.id))?.turn.outputMessageId).toBeUndefined();
    expect(await store.listPendingOutbox()).toEqual([]);
    expect(persisted).toEqual([]);
    expect(getTask).not.toHaveBeenCalled();
  });

  it('rebinds an oversized historical terminal message id and retires its HTTP 422 retry loop', async () => {
    const store = new InMemoryOscarTurnStore();
    const historical = {
      ...linkedAgentTurn('agent_task_oversized_terminal'),
      id: 'oscar_turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      clientRequestId: 'client_oversized_terminal_restart',
      conversationId: 'conversation_oversized_terminal',
      inputMessageId: 'message_user_oversized_terminal',
    };
    const created = await store.createTurn(historical);
    const historicalMessageId = `oscar_message_terminal_${historical.id}`;
    const terminal = await store.saveTurn({
      ...created.turn,
      status: 'blocked',
      outputMessageId: historicalMessageId,
      outcome: {
        kind: 'blocked',
        summary: 'Для запроса требуется явное разрешение пользователя.',
        evidenceRefs: [],
        completedAt: '2026-08-01T00:00:01.000Z',
      },
    }, {
      expectedRevision: created.turn.revision,
      outbox: [{
        id: `outbox_message_${historicalMessageId}`,
        turnId: historical.id,
        kind: 'persist-message',
        payload: {
          conversationId: historical.conversationId,
          messageId: historicalMessageId,
          role: 'assistant',
          content: 'Для запроса требуется явное разрешение пользователя.',
          turnId: historical.id,
          taskId: historical.taskId,
          provenance: {
            origin: 'system',
            verification: 'system-state',
            turnId: historical.id,
            taskId: historical.taskId,
          },
          outcome: 'blocked',
        },
      }],
    });
    await store.markOutboxFailed(
      `outbox_message_${historicalMessageId}`,
      'Oscar backend returned HTTP 422.',
      new Date(0).toISOString(),
    );
    const persisted: OscarPersistedMessage[] = [];
    const getTask = vi.fn();
    const restarted = createCoordinator({
      persistentStore: store,
      persisted,
      runtime: mockRuntime({ getTask }),
    });

    await restarted.start();
    await restarted.stop();

    const recovered = await store.getTurn(terminal.turn.id);
    expect(recovered?.turn.outputMessageId).toMatch(/^oscar_message_terminal_[a-f0-9]{32}$/);
    expect(recovered?.turn.outputMessageId).not.toBe(historicalMessageId);
    expect(recovered?.turn.outputMessageId?.length).toBeLessThanOrEqual(64);
    expect(persisted).toEqual([
      expect.objectContaining({
        messageId: recovered?.turn.outputMessageId,
        content: 'Для запроса требуется явное разрешение пользователя.',
        createConversationIfMissing: false,
        requiredPreviousMessageId: historical.inputMessageId,
      }),
    ]);
    expect(await store.listPendingOutbox()).toEqual([]);
    expect(getTask).not.toHaveBeenCalled();
  });
});

function createCoordinator(options: {
  persistentStore?: InMemoryOscarTurnStore;
  volatileStore?: InMemoryOscarTurnStore;
  runtime?: MonarchAgentRuntime | null;
  incognitoRuntime?: MonarchAgentRuntime | null;
  answerExecutor?: (...args: any[]) => Promise<AsyncIterable<OscarAnswerExecutorEvent>>;
  answerFallback?: () => Promise<{ answer: string; sources?: unknown[] }>;
  persisted?: OscarPersistedMessage[];
  dispositionProvider?: { classify(input: { text: string }): Promise<{ lane: 'answer' | 'agent' | 'clarify'; kind: string; confidence: number; reason: string }> };
  consumeDataEgressConsent?: (consentId: string, turn: OscarTurnV1) => Promise<void>;
  persistMessage?: (message: OscarPersistedMessage) => Promise<
    void | { disposition: 'created' | 'duplicate' | 'superseded' }
  >;
  resolveAttachments?: (...args: any[]) => Promise<any[]>;
  rememberMemory?: (input: { turn: OscarTurnV1; text: string }) => Promise<{
    receiptId: string;
    revision: number;
    contentHash: string;
  }>;
  resolvePersonality?: () => Promise<OscarTurnV1['request']['personality'] | null>;
  agentFirst?: boolean;
} = {}) {
  const persisted = options.persisted || [];
  return new OscarTurnCoordinator({
    persistentStore: options.persistentStore || new InMemoryOscarTurnStore(),
    volatileStore: options.volatileStore || new InMemoryOscarTurnStore(),
    agentRuntime: options.runtime === undefined ? null : options.runtime,
    incognitoAgentRuntime: options.incognitoRuntime === undefined ? null : options.incognitoRuntime,
    ...(options.agentFirst === undefined ? {} : { agentFirst: options.agentFirst }),
    answerExecutor: options.answerExecutor || (async () => stream([
      { type: 'token', token: 'Обычный ответ.' },
      { type: 'done' },
    ])),
    ...(options.answerFallback ? { answerFallback: options.answerFallback } : {}),
    persistMessage: options.persistMessage || (async (message) => { persisted.push(message); }),
    ...(options.resolveAttachments ? { resolveAttachments: options.resolveAttachments } : {}),
    ...(options.dispositionProvider ? { dispositionProvider: options.dispositionProvider } : {}),
    ...(options.consumeDataEgressConsent ? { consumeDataEgressConsent: options.consumeDataEgressConsent } : {}),
    ...(options.rememberMemory ? { rememberMemory: options.rememberMemory } : {}),
    ...(options.resolvePersonality ? { resolvePersonality: options.resolvePersonality } : {}),
  });
}

class BlockingReadOscarTurnStore extends InMemoryOscarTurnStore {
  private pendingGate: {
    entered: () => void;
    wait: Promise<void>;
  } | null = null;

  blockNextRead(): { entered: Promise<void>; release: () => void } {
    let markEntered = () => undefined;
    let release = () => undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.pendingGate = { entered: markEntered, wait };
    return { entered, release };
  }

  override async getTurn(turnId: string): Promise<OscarTurnCheckpoint | null> {
    const gate = this.pendingGate;
    if (gate) {
      this.pendingGate = null;
      gate.entered();
      await gate.wait;
    }
    return super.getTurn(turnId);
  }
}

class FailFirstRoutingSaveOscarTurnStore extends InMemoryOscarTurnStore {
  private failRoutingSave = true;

  override async saveTurn(
    turn: OscarTurnV1,
    options: Parameters<InMemoryOscarTurnStore['saveTurn']>[1],
  ) {
    if (this.failRoutingSave && turn.status === 'routing') {
      this.failRoutingSave = false;
      throw new Error('synthetic routing save failure');
    }
    return super.saveTurn(turn, options);
  }
}

class BlockingCancellationSaveOscarTurnStore extends InMemoryOscarTurnStore {
  private cancellationGate: {
    entered: () => void;
    wait: Promise<void>;
  } | null = null;

  blockNextCancellationSave(): { entered: Promise<void>; release: () => void } {
    let markEntered = () => undefined;
    let release = () => undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.cancellationGate = { entered: markEntered, wait };
    return { entered, release };
  }

  override async saveTurn(
    turn: OscarTurnV1,
    options: Parameters<InMemoryOscarTurnStore['saveTurn']>[1],
  ) {
    const gate = turn.status === 'cancelled' ? this.cancellationGate : null;
    if (gate) {
      this.cancellationGate = null;
      gate.entered();
      await gate.wait;
    }
    return super.saveTurn(turn, options);
  }
}

function terminalPersistenceTurn(suffix: string): OscarTurnV1 {
  const now = '2026-08-01T00:00:00.000Z';
  return {
    schemaVersion: OSCAR_TURN_SCHEMA_VERSION,
    id: `turn_persistence_${suffix}`,
    clientRequestId: `client_persistence_${suffix}`,
    conversationId: `conversation_persistence_${suffix}`,
    source: 'desktop',
    privacyMode: 'persistent',
    mode: 'answer',
    status: 'failed',
    request: {
      text: 'Проверь устойчивость истории.',
      attachmentIds: [],
      modifiers: {},
    },
    inputMessageId: `message_user_${suffix}`,
    outputMessageId: `message_terminal_${suffix}`,
    outcome: {
      kind: 'failed',
      summary: 'Не удалось завершить задачу.',
      evidenceRefs: [],
      completedAt: now,
    },
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function persistedMessageOutbox(
  turn: OscarTurnV1,
  input: {
    messageId: string;
    role: 'user' | 'assistant';
    content: string;
    requiredPreviousMessageId?: string;
  },
) {
  const message: OscarPersistedMessage = {
    conversationId: turn.conversationId,
    messageId: input.messageId,
    role: input.role,
    content: input.content,
    turnId: turn.id,
    provenance: {
      schemaVersion: MESSAGE_PROVENANCE_SCHEMA_VERSION,
      origin: input.role === 'user' ? 'user' : 'system',
      verification: input.role === 'user' ? 'user-assertion' : 'system-state',
      turnId: turn.id,
    },
    ...(input.role === 'assistant' ? { outcome: turn.outcome?.kind } : {}),
    ...(input.requiredPreviousMessageId ? {
      createConversationIfMissing: false,
      requiredPreviousMessageId: input.requiredPreviousMessageId,
    } : {}),
  };
  return {
    id: `outbox_message_${input.messageId}`,
    turnId: turn.id,
    kind: 'persist-message' as const,
    payload: message as unknown as Record<string, unknown>,
  };
}

function submission(text: string, clientRequestId = 'client_request_1') {
  return {
    clientRequestId,
    conversationId: 'conversation_1',
    text,
    privacyMode: 'persistent' as const,
    source: 'desktop' as const,
  };
}

function acceptedTurnForClient(clientRequestId: string): OscarTurnV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: OSCAR_TURN_SCHEMA_VERSION,
    id: `oscar_turn_${clientRequestId}`,
    clientRequestId,
    conversationId: 'conversation_durable_cancel_restart',
    source: 'desktop',
    privacyMode: 'persistent',
    mode: 'answer',
    status: 'accepted',
    request: {
      text: 'Проверь',
      attachmentIds: [],
      modifiers: {},
    },
    inputMessageId: 'message_durable_cancel_restart',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function* stream(events: OscarAnswerExecutorEvent[]): AsyncIterable<OscarAnswerExecutorEvent> {
  for (const event of events) yield event;
}

async function waitForTerminal(coordinator: OscarTurnCoordinator, turnId: string): Promise<OscarTurnCheckpoint> {
  return waitForTurn(coordinator, turnId, (turn) => ['succeeded', 'blocked', 'failed', 'cancelled'].includes(turn.status));
}

async function waitForTurn(
  coordinator: OscarTurnCoordinator,
  turnId: string,
  predicate: (turn: OscarTurnV1) => boolean,
): Promise<OscarTurnCheckpoint> {
  let last: OscarTurnCheckpoint | null = null;
  await waitFor(async () => {
    last = await coordinator.getTurn(turnId);
    return Boolean(last && predicate(last.turn));
  });
  return last!;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
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

function personalityContext(revision: number): NonNullable<OscarTurnV1['request']['personality']> {
  return {
    schemaVersion: 2,
    profileId: 'personality-direct',
    profileRevision: revision,
    profileHash: `${revision}`.padStart(64, 'a').slice(-64),
    variant: 'direct',
    name: 'Прямой',
    dimensions: {
      brevity: 80,
      warmth: 40,
      directness: 90,
      initiative: 55,
      humor: 20,
      skepticism: 75,
      technicalDepth: 90,
      structure: 80,
    },
    addressForm: 'ты',
    language: 'ru',
    customRules: ['Сначала результат.'],
  };
}

function mockRuntime(overrides: Record<string, unknown> = {}): MonarchAgentRuntime {
  return {
    subscribe: () => () => undefined,
    createTask: async () => runningAgentCheckpoint('agent_task_default'),
    getTask: async () => null,
    cancel: async () => null,
    sendMessage: async () => null,
    discardTask: async () => false,
    resolveApproval: async () => null,
    ...overrides,
  } as unknown as MonarchAgentRuntime;
}

function runningAgentCheckpoint(taskId: string): AgentTaskCheckpoint {
  const now = '2026-08-01T00:00:00.000Z';
  return {
    schemaVersion: 'monarch.agent-checkpoint.v1',
    task: {
      schemaVersion: 'monarch.agent-task.v1',
      id: taskId,
      traceId: `trace_${taskId}`,
      source: { surface: 'desktop', remote: false },
      goal: { originalRequest: 'audit', normalizedObjective: 'audit', expectedOutputs: [], constraints: [], successCriteria: [] },
      status: 'running',
      messages: [],
      observations: [],
      artifacts: [],
      approvals: [],
      budgets: {
        maxSteps: 16,
        maxModelTurns: 12,
        maxToolCalls: 10,
        maxWallTimeMs: 300_000,
        maxFailures: 4,
        maxConsecutiveNoProgress: 3,
      },
      usage: { steps: 0, modelTurns: 0, toolCalls: 0, failures: 0, consecutiveNoProgress: 0, startedAt: now, updatedAt: now },
      checkpointVersion: 1,
      eventSequence: 0,
      createdAt: now,
      updatedAt: now,
    },
    events: [],
    observations: [],
    approvals: [],
    savedAt: now,
  } as AgentTaskCheckpoint;
}

function pendingApprovalCheckpoint(taskId: string, approvalId: string): AgentTaskCheckpoint {
  const checkpoint = runningAgentCheckpoint(taskId);
  checkpoint.task.status = 'waiting-for-approval';
  checkpoint.task.activeApprovalId = approvalId;
  checkpoint.approvals = [{
    schemaVersion: 'monarch.agent-approval.v1',
    id: approvalId,
    taskId,
    capabilityId: 'workspace.files.delete',
    canonicalProposalHash: 'sha256:pending',
    proposal: {
      capabilityId: 'workspace.files.delete',
      args: { path: 'D:\\Temp\\candidate' },
      riskVector: { effect: 'delete' },
    },
    status: 'pending',
    requestedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:05:00.000Z',
  }];
  return checkpoint;
}

function waitingApprovalTurn(checkpoint: AgentTaskCheckpoint): OscarTurnV1 {
  const now = '2026-08-01T00:00:00.000Z';
  return {
    schemaVersion: OSCAR_TURN_SCHEMA_VERSION,
    id: 'oscar_turn_pending',
    clientRequestId: 'client_pending',
    conversationId: 'conversation_1',
    source: 'desktop',
    privacyMode: 'persistent',
    mode: 'agent',
    status: 'waiting-for-approval',
    request: { text: 'удали D:\\Temp\\candidate', attachmentIds: [], modifiers: {} },
    inputMessageId: 'message_pending',
    taskId: checkpoint.task.id,
    activeApprovalId: checkpoint.approvals[0]!.id,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function linkedAgentTurn(taskId: string, text = 'выполни операцию'): OscarTurnV1 {
  const now = '2026-08-01T00:00:00.000Z';
  return {
    schemaVersion: OSCAR_TURN_SCHEMA_VERSION,
    id: 'oscar_turn_linked',
    clientRequestId: 'client_linked',
    conversationId: 'conversation_1',
    source: 'desktop',
    privacyMode: 'persistent',
    mode: 'agent',
    status: 'running',
    request: { text, attachmentIds: [], modifiers: {} },
    inputMessageId: 'message_linked',
    taskId,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function completedAgentCheckpoint(
  taskId: string,
  options: {
    capabilityId: string;
    evidenceClass: 'model-generated' | 'kernel-observation';
    includeCompletionVerifier?: boolean;
    mutation?: boolean;
    summary?: string;
  },
): AgentTaskCheckpoint {
  const checkpoint = runningAgentCheckpoint(taskId);
  const now = '2026-08-01T00:00:01.000Z';
  const summary = options.summary || 'Capability returned an observed result.';
  const observation = {
    schemaVersion: 'monarch.agent-observation.v1',
    id: `observation_${taskId}`,
    taskId,
    capabilityId: options.capabilityId,
    status: 'success',
    summary,
    structuredData: options.mutation ? {
      provenance: { executionId: `execution_${taskId}`, ledgerId: `ledger_${taskId}` },
      mutationTruth: { state: 'occurred', source: 'kernel-journal' },
      sideEffects: [{ kind: 'persistent', summary: 'Target changed.' }],
    } : { provenance: { executionId: `execution_${taskId}` } },
    evidence: [{
      kind: 'api',
      evidenceClass: options.evidenceClass,
      reference: `execution:${taskId}`,
      summary,
    }],
    artifacts: [],
    warnings: [],
    retryable: false,
    occurredAt: now,
  } as AgentTaskCheckpoint['observations'][number];
  checkpoint.task.status = 'completed';
  checkpoint.task.completedAt = now;
  checkpoint.task.updatedAt = now;
  checkpoint.task.terminalReason = { code: 'completed', summary };
  checkpoint.task.observations = [{
    id: observation.id,
    taskId,
    status: observation.status,
    summary,
    occurredAt: now,
  }];
  checkpoint.observations = [observation];
  checkpoint.events = options.includeCompletionVerifier === false ? [] : [{
    schemaVersion: 'monarch.agent-task-event.v1',
    id: `event_${taskId}`,
    taskId,
    traceId: checkpoint.task.traceId,
    sequence: 1,
    type: 'verification.completed',
    createdAt: now,
    payload: { status: 'verified' },
  }];
  return checkpoint;
}

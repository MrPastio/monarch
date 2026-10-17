import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryOscarTurnStore,
  MESSAGE_PROVENANCE_SCHEMA_VERSION,
  OSCAR_INCIDENT_FAKE_STORAGE_AUDIT,
  OSCAR_TURN_CANCELLED_SUMMARY,
  OSCAR_TURN_SCHEMA_VERSION,
  OscarTurnCoordinator,
  astraStepTitle,
  turnFailureDiagnostic,
  userFacingTurnFailure,
  researchTraceSteps,
  type OscarAnswerExecutorEvent,
  type OscarPersistedMessage,
  type OscarTurnCheckpoint,
  type OscarTurnV1,
} from '../../src/oscar-turn';
import { exactMonarch025Changelog, materialReviewHistory } from '../fixtures/oscar/material-handoff';

describe('OscarTurnCoordinator', () => {
  it('keeps a custom-file refusal in the answer lane without retry or agent work', async () => {
    const answerFallback = vi.fn(async () => ({ answer: 'Must not retry.' }));
    const answerExecutor = vi.fn(async () => stream([{ type: 'error', message: 'custom-model-draft-only' }]));
    const coordinator = createCoordinator({ answerExecutor, answerFallback });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({ ...submission('Привет', 'client_custom_draft'), modifiers: { requestedModel: 'custom-a1b2c3d4e5f6' } });
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn).toMatchObject({ mode: 'answer', status: 'failed' });
      expect(terminal.turn.outcome?.summary).toContain('MTP draft');
      expect(terminal.turn.outcome?.summary).not.toContain('Технические детали');
      expect(terminal.turn.taskId).toBeUndefined();
      expect(answerExecutor).toHaveBeenCalledTimes(1);
      expect(answerFallback).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); }
  });
  it('keeps the process alive when a background outbox write fails', async () => {
    // Live: Windows refused the rename of turns.v1.json and the rejected
    // background drain ended the server with an unhandled rejection.
    const persistentStore = new InMemoryOscarTurnStore();
    const coordinator = createCoordinator({ persistentStore });
    await coordinator.start();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const list = vi.spyOn(persistentStore, 'listPendingOutbox')
      .mockRejectedValue(Object.assign(new Error('rename failed'), { code: 'EPERM' }));
    try {
      const accepted = await coordinator.submit(submission('Привет', 'client_outbox_eperm'));
      await waitForTerminal(coordinator, accepted.turn.id);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(errorLog.mock.calls.map(call => String(call[0])).join('\n'))
        .toContain('"diagnostic":"oscar-turn-background-failure","work":"outbox","code":"EPERM"');
    } finally {
      list.mockRestore(); errorLog.mockRestore();
      process.off('unhandledRejection', onUnhandled);
      await coordinator.stop();
    }
  });
  it.each(['question-budget', 'model-turn-budget', 'capability-call-budget', 'failed-action-repeated', 'rejected-action-repeated',
    'task-deadline', 'transport-deadline', 'Oscar recovery finished without a trustworthy final answer.'])(
    'names the agent stop reason %s instead of the generic line', reason => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const summary = userFacingTurnFailure(Object.assign(new Error(reason), { code: reason }));
        expect(summary).not.toContain('Не удалось завершить задачу');
        expect(summary).toContain('Подтверждённые результаты сохранены');
        expect(errors).not.toHaveBeenCalled();
      } finally { errors.mockRestore(); }
    });
  it.each(['astra-restore-held', 'Bound Astra host is unavailable; no legacy fallback.'])(
    'says plainly that agent work is paused while chat works (%s)', reason => {
      const summary = userFacingTurnFailure(new Error(reason));
      expect(summary).toContain('Обычный чат работает');
      expect(summary).not.toContain('Bound Astra');
    });
  it('reads the research steps of a Turn from its progress events, in order and once each', () => {
    const progress = (phase: string, detail: string) => ({ type: 'agent.progress', payload: { phase, detail } });
    expect(researchTraceSteps([
      progress('search-plan', 'Подбираю, что искать'),
      progress('research-plan', 'Вопрос требует разбора — исследую глубже'),
      progress('search', 'a · b'),
      progress('search', 'a · b'),
      { type: 'answer.delta', payload: { content: 'x' } },
      progress('thinking', 'Думаю'),
      progress('research-read', 'Изучаю 3 источника'),
      progress('research-verify', 'Не хватает: цены'),
      progress('research-write', 'Пишу вывод'),
    ])).toEqual([
      { kind: 'plan', detail: 'Подбираю, что искать' },
      { kind: 'plan', detail: 'Вопрос требует разбора — исследую глубже' },
      { kind: 'search', detail: 'a · b' },
      { kind: 'read', detail: 'Изучаю 3 источника' },
      { kind: 'verify', detail: 'Не хватает: цены' },
      { kind: 'write', detail: 'Пишу вывод' },
    ]);
  });
  it.each(['model-unavailable', 'safety-input-model-unavailable'])(
    'tells the person the selected MAX model is gone (%s)', reason => {
      // Live 2026-10-09: OpenRouter withdrew a free model (404) and the turn
      // ended as "Не удалось завершить задачу" with no hint what to change.
      const summary = userFacingTurnFailure(Object.assign(new Error(reason), { code: reason }));
      expect(summary).toContain('настройках MAX');
      expect(summary).not.toContain('Не удалось завершить задачу');
    });
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

  it.each(['agent-runtime-host-retired', 'control-budget-exhausted'])(
    'tells the person the executor gave up rather than reporting a generic failure (%s)', reason => {
      // Before this, the executor abandoning a task produced no outcome at all:
      // the turn stayed on "Набираю…" forever and Stop did nothing.
      const summary = userFacingTurnFailure(new Error(`astra-agent-task-${reason}`));
      expect(summary).toContain('перестал вести эту задачу');
      expect(summary).toContain('Подтверждённые результаты сохранены');
      expect(summary).not.toContain(reason);
    });

  it.each(['task-fault:astra-agent-decision:evidence-shape', 'task-fault:astra-agent-task:capability-args-binding'])(
    'says one task was stopped by an internal check without naming it (%s)', reason => {
      const summary = userFacingTurnFailure(Object.assign(new Error(reason), { code: reason }));
      expect(summary).toContain('внутренней ошибки проверки');
      expect(summary).toContain('Другие задачи это не затронуло');
      expect(summary).not.toContain('astra-');
    });

  it.each([
    ['primary-json-validation-failed', 'MAX не смог оформить ответ правильно. Попробуй отправить запрос ещё раз.'],
    ['provider-context-too-large', 'Материалов слишком много для одного запроса. Сократи сообщение или выбери меньше материалов.'],
    ['credential-unavailable', 'Открой Настройки → MAX: проверь ключ выбранного сервиса и согласие на отправку данных.'],
    // The provider's real codes, which the former grammar missed.
    ['provider-rate-limited', 'У выбранного сервиса закончился лимит или баланс. Подожди или проверь свой кабинет, затем повтори запрос.'],
    ['provider-timeout', 'Сервис не ответил вовремя. Запрос MAX завершён без результата; можно повторить.'],
    ['credential-rejected', 'Открой Настройки → MAX: проверь ключ выбранного сервиса и согласие на отправку данных.'],
    // A stage prefix is dropped by the host; the service refusing the request is named, not blamed on the connection.
    ['primary-provider-request-rejected', 'Сервис MAX не принял этот запрос. Попробуй повторить или переформулировать его.'],
    ['safety-blocked-model', 'MAX остановился на проверке безопасности. Результаты предыдущих шагов остаются в истории задачи.'],
    ['provider-response-rejected', 'Сервис MAX отказался отвечать на этот запрос (сработал его фильтр). Ответ не принят; можно переформулировать.'],
    ['provider-unexpected-tool-call', 'Модель MAX попыталась вызвать свой встроенный инструмент вместо ответа. Ответ не принят; повтори запрос или выбери другую модель.'],
    ['provider-finish', 'Ответ MAX пришёл не полностью или повреждён. Он не принят как результат. Проверь связь и повтори запрос.'],
    ['provider-output-truncated', 'MAX заметил, что ответ оборвался на лимите, и не выдал его за завершённый. Сузь задачу или попроси ответ частями.'],
  ])('names the actionable MAX provider failure instead of the generic line (%s)', (reason, expected) => {
    // The generic line spoke about unconfirmed actions for a request that asked for none,
    // and hid the only thing the person could act on.
    const summary = userFacingTurnFailure(Object.assign(new Error(reason), { code: reason }));
    expect(summary).toBe(expected);
    expect(summary).not.toContain('неподтверждённые действия');
  });

  it.each([
    ['model-output-limit', 'оборвался на лимите длины'],
    ['proposal-schema', 'в неправильном формате'],
  ])('names a model step that could not be accepted (%s)', (reason, expected) => {
    const summary = userFacingTurnFailure(Object.assign(new Error(reason), { code: reason }));
    expect(summary).toContain(expected);
    expect(summary).not.toContain('Технические детали');
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

  it.each([
    ['memory.list', 'Посмотрел в памяти'],
    ['memory.remember', 'Записал в память'],
    ['gmail.messages.list', 'Поработал с почтой'],
    ['workspace.files.list', 'Посмотрел папку'],
    ['workspace.files.read', 'Прочитал файл'],
  ])('names the step %s by what it touched', (capabilityId, title) => {
    expect(astraStepTitle(capabilityId, undefined, 'done')).toBe(title);
  });

  it('keeps the lines of the request and of the history the model is given', async () => {
    const answerExecutor = vi.fn(async (_execution: { turn: OscarTurnV1 }) => stream([{ type: 'token', token: 'Ок.' }, { type: 'done' }]));
    const coordinator = createCoordinator({ answerExecutor });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('Почини функцию:\r\n```ts\nconst a = 1;\u0007\n```\n\n\n\nСпасибо'),
        history: [{ role: 'assistant', content: '1. Первый шаг\n2. Второй шаг  \n' }],
      });
      await waitForTerminal(coordinator, accepted.turn.id);
      const turn = answerExecutor.mock.calls[0]![0].turn;
      expect(turn.request.text).toBe('Почини функцию:\n```ts\nconst a = 1;\n```\n\nСпасибо');
      expect(turn.request.history).toEqual([{ role: 'assistant', content: '1. Первый шаг\n2. Второй шаг' }]);
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
    const coordinator = createCoordinator({
      answerExecutor,
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
    } finally {
      await coordinator.stop();
    }
  });

  it('answers the exact requested Monarch changelog without creating or planning an Agent task', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Список получил. Это материал для просмотра, действий не запускал.' },
      { type: 'done' },
    ]));
    const coordinator = createCoordinator({
      answerExecutor,
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
      expect(terminal.events.some((event) => event.type === 'task.linked')).toBe(false);
      expect(terminal.events.some((event) => event.type === 'agent.progress')).toBe(false);
    } finally {
      await coordinator.stop();
    }
  });

  it('answers an ordinary question directly without creating an AgentTask', async () => {
    const answerExecutor = vi.fn(async () => stream([
      { type: 'token', token: 'Готов.' },
      { type: 'done' },
    ]));
    const coordinator = createCoordinator({
      agentFirst: true,
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
    const coordinator = createCoordinator({
      answerExecutor,
      dispositionProvider: {
        classify: async () => ({ lane: 'answer', kind: 'semantic-request', confidence: 1, reason: 'fixture' }),
      },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(request, clientRequestId));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn).toMatchObject({ mode: 'answer', status: 'succeeded' });
      expect(answerExecutor).toHaveBeenCalledTimes(1);
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
    const coordinator = createCoordinator({
      persisted,
      rememberMemory,
      answerExecutor,
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
      expect(terminal.turn).toMatchObject({
        mode: 'answer',
        status: 'succeeded',
        outcome: {
          kind: 'verified',
          summary: 'Запомнил: «1. Monarch 0.2.5 ещё не опубликован. 2. Stable остаётся 0.2.4».',
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

  it('writes «запомни» next to a question and still answers the question', async () => {
    const rememberMemory = vi.fn(async () => ({
      receiptId: 'settings_receipt_mixed', revision: 2, contentHash: 'b'.repeat(64), action: 'created', text: 'Я живу в Варне',
    }));
    const answerExecutor = vi.fn(async () => stream([{ type: 'token', token: 'В Варне завтра солнечно.' }, { type: 'done' }]));
    const coordinator = createCoordinator({ rememberMemory, answerExecutor });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Сколько будет два плюс два? И запомни, что я живу в Варне', 'client_mixed_memory'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(rememberMemory).toHaveBeenCalledWith(expect.objectContaining({ text: 'что я живу в Варне' }));
      expect(answerExecutor).toHaveBeenCalled();
      expect(terminal.turn.status).toBe('succeeded');
      expect(terminal.events.find((event) => event.type === 'memory.changed')?.payload).toMatchObject({
        action: 'created', text: 'Я живу в Варне',
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('says what was replaced when a new statement supersedes an old one', async () => {
    const rememberMemory = vi.fn(async () => ({
      receiptId: 'r', revision: 3, contentHash: 'c'.repeat(64), action: 'replaced', text: 'Я живу в Софии', replacedText: 'Я живу в Варне',
    }));
    const coordinator = createCoordinator({ rememberMemory });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('запомни, что я живу в Софии', 'client_replace_memory'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn.outcome?.summary).toBe('Запомнил: «Я живу в Софии». Прежнее «Я живу в Варне» больше не учитываю.');
    } finally {
      await coordinator.stop();
    }
  });

  it('writes «запомни» under Direct Access instead of routing it to an agent', async () => {
    const rememberMemory = vi.fn(async () => ({ receiptId: 'r', revision: 1, contentHash: 'd'.repeat(64), action: 'created' }));
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({
      rememberMemory,
      answerExecutor,
      getOwnerUnrestrictedOverride: () => ({ enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('запомни, что я люблю тёмный шоколад', 'client_direct_memory'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(rememberMemory).toHaveBeenCalledTimes(1);
      expect(answerExecutor).not.toHaveBeenCalled();
      expect(terminal.turn.outcome?.kind).toBe('verified');
    } finally {
      await coordinator.stop();
    }
  });

  it('shows what it learned from the person under the answer, and only that', async () => {
    const learnFromMessage = vi.fn(async ({ text }: { text: string }) => text.includes('Бургас')
      ? [{ id: 'record_9', text: 'Я живу в Бургасе', action: 'created', origin: 'learned' as const }] : []);
    const answerExecutor = vi.fn(async () => stream([{ type: 'token', token: 'Четыре.' }, { type: 'done' }]));
    const coordinator = createCoordinator({ learnFromMessage, answerExecutor });
    await coordinator.start();
    try {
      const learned = await waitForTerminal(coordinator,
        (await coordinator.submit(submission('Я живу в Бургасе. Сколько будет 2+2?', 'client_learn'))).turn.id);
      expect(learned.events.find((event) => event.type === 'memory.changed')?.payload).toEqual({
        action: 'learned', recordId: 'record_9', text: 'Я живу в Бургасе',
      });
      const plain = await waitForTerminal(coordinator,
        (await coordinator.submit(submission('Сколько будет 3+3?', 'client_plain'))).turn.id);
      expect(plain.events.some((event) => event.type === 'memory.changed')).toBe(false);
      await waitForTerminal(coordinator,
        (await coordinator.submit(submission('запомни, что я живу в Бургасе', 'client_explicit'))).turn.id);
      expect(learnFromMessage).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.stop();
    }
  });

  it('forgets the record a «забудь» command points at', async () => {
    const forgetMemory = vi.fn(async () => ({
      receiptId: 'f', revision: 5, contentHash: 'e'.repeat(64), forgotten: { id: 'record_1', text: 'Я живу в Варне' },
    }));
    const coordinator = createCoordinator({ forgetMemory });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Забудь, где я живу', 'client_forget'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(forgetMemory).toHaveBeenCalledWith(expect.objectContaining({ query: 'где я живу' }));
      expect(terminal.turn.outcome?.summary).toBe('Забыл: «Я живу в Варне». Вернуть можно в Настройках → Память.');
      expect(terminal.events.find((event) => event.type === 'memory.changed')?.payload).toMatchObject({
        action: 'forgotten', recordId: 'record_1',
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('treats a conversational «забудь» as an ordinary message', async () => {
    const forgetMemory = vi.fn();
    const answerExecutor = vi.fn(async () => stream([{ type: 'token', token: 'Хорошо.' }, { type: 'done' }]));
    const coordinator = createCoordinator({ forgetMemory, answerExecutor });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('забудь предыдущее сообщение', 'client_forget_chat'));
      await waitForTerminal(coordinator, accepted.turn.id);
      expect(forgetMemory).not.toHaveBeenCalled();
      expect(answerExecutor).toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('answers «что ты обо мне знаешь» from the records themselves', async () => {
    const listMemory = vi.fn(async () => [
      { id: '1', text: 'Я живу в Варне', category: 'about', origin: 'learned' },
      { id: '2', text: 'Отвечай кратко', category: 'rule', origin: 'owner' },
      { id: '3', text: 'Я люблю оливки', category: 'preference', origin: 'suggested' },
    ]);
    const answerExecutor = vi.fn();
    const coordinator = createCoordinator({ listMemory, answerExecutor });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Что ты обо мне знаешь?', 'client_overview'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(answerExecutor).not.toHaveBeenCalled();
      const summary = terminal.turn.outcome?.summary || '';
      expect(summary).toContain('**Обо мне**\n- Я живу в Варне');
      expect(summary).toContain('**Правила**\n- Отвечай кратко');
      expect(summary).not.toContain('оливки');
      expect(summary.indexOf('Обо мне')).toBeLessThan(summary.indexOf('Правила'));
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

  it('blocks an operational attachment instead of falling back when vision observation is incomplete', async () => {
    const coordinator = createCoordinator({
      astra: { bindAgent: () => ordinaryAgentBinding(), find: () => null },
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
      await coordinator.flushOutbox();
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn).toMatchObject({
        status: 'blocked',
        outcome: { kind: 'blocked', warning: 'attachment-observation-unavailable' },
      });
    } finally {
      await coordinator.stop();
    }
  });

  it('searches first and hands the results to the agent when a consented search must end in an action', async () => {
    const bound: OscarTurnV1[] = [];
    const submitted: unknown[] = [];
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const researchEvidence = vi.fn(async () => JSON.stringify({ kind: 'untrusted-public-search', sources: [{ url: 'https://example.test', snippet: 'Новость' }] }));
    const coordinator = createCoordinator({
      answerExecutor,
      researchEvidence,
      consumeDataEgressConsent: async () => undefined,
      astra: {
        bindAgent: (turn: OscarTurnV1) => { bound.push(turn); return ordinaryAgentBinding(); },
        find: () => null,
        submit: (_turn: OscarTurnV1, prepared: unknown) => { submitted.push(prepared); throw new Error('fixture-stops-after-submit'); },
      },
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'operation', confidence: 0.9, reason: 'send the news' }) },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('Найди последние новости и отправь их мне в Telegram', 'client_research_then_act'),
        modifiers: { webSearch: true, researchMode: 'auto', dataEgressConsentId: 'oscar_egress_research_then_act' },
      });
      await coordinator.flushOutbox();
      await waitFor(() => submitted.length === 1);
      expect(answerExecutor).not.toHaveBeenCalled();
      expect(bound[0]!.request.modifiers).not.toHaveProperty('webSearch');
      expect(bound[0]!.request.modifiers).not.toHaveProperty('dataEgressConsentId');
      expect(researchEvidence).toHaveBeenCalledWith(expect.objectContaining({ query: 'Найди последние новости и отправь их мне в Telegram', deep: false }));
      expect(submitted[0]).toMatchObject({ kind: 'agent-attachments-v1', initialEvidence: [
        { ref: 'agent_research_0', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u), text: expect.stringContaining('untrusted-public-search') },
      ] });
      const routed = (await coordinator.getTurn(accepted.turn.id))!;
      expect(routed.events.find((event) => event.type === 'turn.routed')?.payload).toMatchObject({ disposition: 'agent', kind: 'research_then_act' });
    } finally {
      await coordinator.stop();
    }
  });

  it('asks the model about the action under Direct Access too instead of answering every search', async () => {
    const submitted: unknown[] = [];
    const classify = vi.fn(async () => ({ lane: 'agent' as const, kind: 'operation', confidence: 0.9, reason: 'save the findings' }));
    const coordinator = createCoordinator({
      researchEvidence: async () => JSON.stringify({ kind: 'untrusted-public-search', sources: [{ url: 'https://example.test', snippet: 'Данные' }] }),
      consumeDataEgressConsent: async () => undefined,
      getOwnerUnrestrictedOverride: () => ({ enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' }),
      astra: {
        bindAgent: () => ordinaryAgentBinding(),
        find: () => null,
        submit: (_turn: OscarTurnV1, prepared: unknown) => { submitted.push(prepared); throw new Error('fixture-stops-after-submit'); },
      },
      dispositionProvider: { classify },
    });
    await coordinator.start();
    try {
      await coordinator.submit({
        ...submission('Найди в интернете прогноз погоды и сохрани его в новый файл', 'client_research_direct'),
        modifiers: { webSearch: true, researchMode: 'auto', dataEgressConsentId: 'oscar_egress_research_direct' },
      });
      await coordinator.flushOutbox();
      await waitFor(() => submitted.length === 1);
      expect(classify).toHaveBeenCalledTimes(1);
      expect(submitted[0]).toMatchObject({ kind: 'agent-attachments-v1', initialEvidence: [{ ref: 'agent_research_0' }] });
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps a consented search that only needs an answer in the sourced answer lane', async () => {
    const answerExecutor = vi.fn(async () => stream([{ type: 'token', token: 'Вот новости.' }, { type: 'done' }]));
    const bindAgent = vi.fn(() => ordinaryAgentBinding());
    const coordinator = createCoordinator({
      answerExecutor,
      researchEvidence: async () => 'unused',
      consumeDataEgressConsent: async () => undefined,
      astra: { bindAgent, find: () => null },
      dispositionProvider: { classify: async () => ({ lane: 'answer', kind: 'external_research', confidence: 0.9, reason: 'just news' }) },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({
        ...submission('Какие последние новости о SpaceX?', 'client_research_answer'),
        modifiers: { webSearch: true, researchMode: 'auto', dataEgressConsentId: 'oscar_egress_research_answer' },
      });
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn).toMatchObject({ status: 'succeeded', mode: 'answer' });
      expect(bindAgent).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
  });

  it('blocks an operational request when Astra V3 is unavailable without chat or V2 fallback', async () => {
    const answerExecutor = vi.fn(async () => stream([{ type: 'done' }]));
    const coordinator = createCoordinator({
      answerExecutor,
      astra: { bindAgent: () => null },
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'operation', confidence: 1, reason: 'explicit effect' }) },
    });
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
    const coordinator = createCoordinator({
      persisted,
      answerExecutor,
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
        outcome: { kind: 'blocked', summary: expect.stringContaining('Включи «Интернет»') },
      });
      expect(answerExecutor).not.toHaveBeenCalled();
      await waitFor(() => persisted.some((message) => message.role === 'assistant'));
      expect(persisted.find((message) => message.role === 'assistant')).toMatchObject({
        content: expect.stringContaining('Включи «Интернет»'),
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
      { type: 'search', queries: ['актуальные источники', 'official sources'] },
      {
        type: 'sources',
        sources: [{
          id: 1,
          title: 'Разрешённый публичный источник',
          url: 'https://example.com/allowed',
          excerpt: 'Bound to the exact consented Turn.',
          published: '2026-09-28T08:00:00Z',
          origin: 'engine',
        }, {
          title: 'Not a page', url: 'javascript:alert(1)', excerpt: 'x', origin: 'evil', published: 'yesterday',
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
          detail: 'Подбираю, что искать',
          activity: expect.objectContaining({ domain: 'internet', motion: 'breathing' }),
        }),
      }));
      // The cards get title, link, date and origin; provenance keeps references only.
      expect(terminal.events).toContainEqual(expect.objectContaining({
        type: 'turn.outcome',
        payload: expect.objectContaining({ sources: [{ id: 1, title: 'Разрешённый публичный источник',
          url: 'https://example.com/allowed', published: '2026-09-28', origin: 'engine' }] }),
      }));
      // The planned queries, not the raw request, are what the search line shows.
      expect(terminal.events).toContainEqual(expect.objectContaining({
        type: 'agent.progress',
        payload: expect.objectContaining({ detail: 'актуальные источники · official sources' }),
      }));
    } finally {
      await coordinator.stop();
    }
  });

  it('settles a Turn whose routing model failed instead of leaving it in routing forever', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const classify = vi.fn(async () => {
      throw Object.assign(new Error('astra-max-native:not-configured'), { code: 'astra-max-native:not-configured' });
    });
    const coordinator = createCoordinator({ persisted, dispositionProvider: { classify } });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('max test', 'client_routing_provider_failed'));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);

      expect(terminal.turn.status).toBe('failed');
      expect(terminal.turn.outcome?.summary).toContain('Настройки → MAX');
      expect(terminal.turn.outcome?.diagnostic?.code).toBe('astra-max-native:not-configured');
      expect(persisted.some((message) => message.role === 'assistant'
        && message.content.includes('Настройки → MAX'))).toBe(true);
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps Direct Access on Astra V3 when the model is unsure, without a V2 fallback', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const classify = vi.fn(async () => ({
      lane: 'clarify' as const,
      kind: 'ambiguous',
      confidence: 1,
      reason: 'missing target',
    }));
    const coordinator = createCoordinator({
      persisted,
      astra: { bindAgent: () => null },
      dispositionProvider: { classify },
      getOwnerUnrestrictedOverride: () => ({ enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Проверь', 'client_direct_tools'));
      expect(accepted.turn.status).toBe('blocked');
      expect(accepted.turn.outcome?.summary).toContain('Astra V3 Agent Runtime недоступен');
      // Direct Access asks the model, and its doubt keeps the agent default.
      expect(classify).toHaveBeenCalledOnce();
      expect(accepted.turn.taskId).toBeUndefined();
    } finally {
      await coordinator.stop();
    }
  });

  it('routes Direct Access locally when MAX fails, so a plain question is still answered', async () => {
    const classify = vi.fn(async ({ requestedModel }: { requestedModel?: string }) => {
      if (requestedModel) throw Object.assign(new Error('astra-max-native:rate-limit'), { code: 'astra-max-native:rate-limit' });
      return { lane: 'answer' as const, kind: 'semantic-request', confidence: 0.9, reason: 'arithmetic' };
    });
    const coordinator = createCoordinator({
      astra: { bindAgent: () => null },
      dispositionProvider: { classify } as never,
      maxLocalFallbackAllowed: () => true,
      getOwnerUnrestrictedOverride: () => ({ enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({ ...submission('сколько будет 17 умножить на 23?', 'client_direct_max_down'),
        modifiers: { requestedModel: 'max-gpt-oss-120b' } });
      await vi.waitFor(async () => expect((await coordinator.getTurn(accepted.turn.id))?.turn.status).not.toBe('routing'));
      const turn = (await coordinator.getTurn(accepted.turn.id))!.turn;
      expect(classify.mock.calls.map(([call]) => call.requestedModel)).toEqual(['max-gpt-oss-120b', undefined]);
      expect(turn.taskId).toBeUndefined();
      expect(turn.outcome?.summary ?? '').not.toContain('Agent Runtime');
    } finally {
      await coordinator.stop();
    }
  });

  it('answers a plain question under Direct Access when the model says it is not work', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const classify = vi.fn(async () => ({ lane: 'answer' as const, kind: 'semantic-request', confidence: 0.9, reason: 'arithmetic' }));
    const coordinator = createCoordinator({
      persisted,
      astra: { bindAgent: () => null },
      dispositionProvider: { classify },
      getOwnerUnrestrictedOverride: () => ({ enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('сколько будет 17 умножить на 23?', 'client_direct_math'));
      await vi.waitFor(async () => expect((await coordinator.getTurn(accepted.turn.id))?.turn.status).not.toBe('routing'));
      const turn = (await coordinator.getTurn(accepted.turn.id))!.turn;
      expect(classify).toHaveBeenCalledOnce();
      expect(turn.outcome?.summary ?? '').not.toContain('Agent Runtime');
      expect(turn.taskId).toBeUndefined();
    } finally {
      await coordinator.stop();
    }
  });

  it.each([
    ['росскажи что ты умеешь и какая ты модель', 'client_direct_cap_typo'],
    ['расскажи что ты умеешь и какая ты модель', 'client_direct_cap_tell'],
    ['что ты умеешь', 'client_direct_cap_can'],
    ['who are you', 'client_direct_cap_who'],
  ])('keeps Direct Access from turning a capability question into an Agent task: %s', async (text, clientRequestId) => {
    const persisted: OscarPersistedMessage[] = [];
    const classify = vi.fn(async () => ({
      lane: 'agent' as const,
      kind: 'semantic-request',
      confidence: 1,
      reason: 'biased execution classifier',
    }));
    const coordinator = createCoordinator({
      persisted,
      astra: { bindAgent: () => ({ schemaVersion: 'monarch.oscar-astra-binding.v1' }) },
      dispositionProvider: { classify },
      getOwnerUnrestrictedOverride: () => ({ enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' }),
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(text, clientRequestId));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn.status).toBe('succeeded');
      expect(terminal.turn.mode).toBe('answer');
      expect(terminal.turn.outcome?.kind).toBe('answered');
      expect(terminal.turn.taskId).toBeUndefined();
      expect(classify).not.toHaveBeenCalled();
      expect(persisted.find((message) => message.role === 'assistant')?.content).toContain('Обычный ответ.');
    } finally {
      await coordinator.stop();
    }
  });

  it('projects an exact critical Security verdict into a generic Astra V3 approval card', async () => {
    let view: any = null;
    const policySnapshotJson = JSON.stringify({
      outcome: 'confirm',
      reason: 'Monarch Security приостановил массовое удаление 120 целей.',
      riskVector: { effect: 'delete', reversibility: 'irreversible', privilege: 'user' },
      evidence: [{ source: 'security', code: 'delete.large-scope', severity: 'warn', message: 'review' }],
    });
    const astra = {
      bindAgent: () => ordinaryAgentBinding(),
      find: () => view,
      submit: () => {
        view = {
          id: 'astra_agent_critical_card',
          status: 'waiting-for-approval',
          nativeCompletionCertified: false,
          approval: {
            id: 'approval_critical_card',
            digest: `sha256:${'b'.repeat(64)}`,
            expiresAt: Date.now() + 60_000,
            policySnapshotJson,
            source: { taskId: 'astra_agent_critical_card' },
            capability: {
              id: 'workspace.files.delete',
              moduleId: 'workspace',
              title: 'Удалить файлы',
              description: 'Удаляет точный список файлов.',
              risk: 'delete',
            },
            args: { paths: Array.from({ length: 120 }, (_, index) => `cache/${index}.tmp`) },
            reason: 'Очистить устаревший кэш.',
          },
        };
        return view;
      },
      command: vi.fn(),
    };
    const coordinator = createCoordinator({
      astra,
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'operation', confidence: 1, reason: 'fixture' }) },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission('Очисти устаревший кэш', 'client_critical_card'));
      await coordinator.flushOutbox();
      const pending = await waitForTurn(coordinator, accepted.turn.id, turn => turn.status === 'waiting-for-approval');
      const approval = pending.events.filter(event => event.type === 'approval.required').at(-1)?.payload;
      expect(approval).toMatchObject({
        runtime: 'astra-v3',
        approvalKind: 'capability-action',
        critical: true,
        warningReason: 'Monarch Security приостановил массовое удаление 120 целей.',
        decisionReason: 'security',
        warningCodes: ['delete.large-scope'],
        capability: { id: 'workspace.files.delete', risk: 'delete' },
        args: { paths: expect.arrayContaining(['cache/0.tmp', 'cache/119.tmp']) },
      });
      expect(approval).not.toHaveProperty('policySnapshotJson');
      expect(approval).not.toHaveProperty('source');
    } finally {
      await coordinator.stop();
    }
  });

  it('never falls back from an enabled V3 host to the V2 runtime for an unsupported persistent Agent Turn', async () => {
    const coordinator = createCoordinator({
      astra: { bindAgent: () => null },
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'semantic-request', confidence: 1,
        reason: 'fixture agent request' }) },
    });
    await coordinator.start();
    try {
      const result = await coordinator.submit(submission('Выполни неподдерживаемую V3 задачу', 'no_v2_fallback'));
      expect(result.turn).toMatchObject({ status: 'blocked', outcome: { kind: 'blocked' } });
      expect(result.turn.outcome?.summary).toContain('не был отправлен в обычный чат или другой исполнитель');
    } finally { await coordinator.stop(); }
  });

  it.each([
    ['мне грустно', 'client_leftover_feeling'],
    ['сегодня странный день', 'client_leftover_day'],
    ['давай просто поговорим', 'client_leftover_talk'],
    ['хм', 'client_leftover_hmm'],
  ])('answers leftover chat instead of asking for an operation goal: %s', async (text, clientRequestId) => {
    const persisted: OscarPersistedMessage[] = [];
    const classify = vi.fn(async () => ({
      lane: 'answer' as const,
      kind: 'semantic-request',
      confidence: 1,
      reason: 'ordinary chat',
    }));
    const coordinator = createCoordinator({
      persisted,
      dispositionProvider: { classify },
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit(submission(text, clientRequestId));
      const terminal = await waitForTerminal(coordinator, accepted.turn.id);
      expect(terminal.turn.status).toBe('succeeded');
      expect(terminal.turn.mode).toBe('answer');
      expect(terminal.turn.outcome?.kind).toBe('answered');
      expect(classify).toHaveBeenCalledOnce();
      expect(persisted.some((message) => message.content.includes('Укажи точную цель операции'))).toBe(false);
      expect(persisted.find((message) => message.role === 'assistant')?.content).toContain('Обычный ответ.');
    } finally {
      await coordinator.stop();
    }
  });

  it('keeps encrypted Safe operational Turns answer-only and fail-closed', async () => {
    const persistentStore = new InMemoryOscarTurnStore();
    const volatileStore = new InMemoryOscarTurnStore();
    const coordinator = createCoordinator({
      persistentStore,
      volatileStore,
      dispositionProvider: { classify: async () => ({ lane: 'agent', kind: 'operation', confidence: 1, reason: 'explicit effect' }) },
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

  it('abandons a persistent message at once when nothing will ever deliver its prerequisite', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('deleted-conversation');
    const assistantOutbox = persistedMessageOutbox(turn, {
      messageId: turn.outputMessageId!,
      role: 'assistant',
      content: turn.outcome!.summary,
      requiredPreviousMessageId: turn.inputMessageId,
    });
    // Only the assistant message is queued: its conversation, and the user
    // message it must follow, are gone for good.
    await store.createTurn(turn, { outbox: [assistantOutbox] });
    const persistMessage = vi.fn(async () => {
      throw Object.assign(new Error('required previous user message has not been persisted yet'), {
        code: 'conversation-message-prerequisite-pending',
        statusCode: 409,
      });
    });

    const coordinator = createCoordinator({ persistentStore: store, persistMessage });
    await coordinator.start();
    await coordinator.stop();

    expect(persistMessage).toHaveBeenCalledOnce();
    expect(await store.listPendingOutbox(new Date('2030-01-01T00:00:00.000Z'))).toEqual([]);
    const settled = await store.readOutboxItem(assistantOutbox.id);
    expect(settled?.status).toBe('superseded');
    expect(settled?.attempts).toBe(0);
    expect(settled?.lastError).toContain('required previous user message');
  });

  it('keeps a message queued while the user message it follows is still waiting to be delivered', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('prerequisite-race');
    const userOutbox = persistedMessageOutbox(turn, {
      messageId: turn.inputMessageId,
      role: 'user',
      content: 'Сохрани по порядку.',
    });
    const assistantOutbox = persistedMessageOutbox(turn, {
      messageId: turn.outputMessageId!,
      role: 'assistant',
      content: turn.outcome!.summary,
      requiredPreviousMessageId: turn.inputMessageId,
    });
    await store.createTurn(turn, { outbox: [userOutbox, assistantOutbox] });
    const persistMessage = vi.fn(async (message: OscarPersistedMessage) => {
      if (message.role === 'user') throw new Error('simulated isolated user append outage');
      throw Object.assign(new Error('required previous user message has not been persisted yet'), {
        code: 'conversation-message-prerequisite-pending',
        statusCode: 409,
      });
    });

    const coordinator = createCoordinator({ persistentStore: store, persistMessage });
    await coordinator.start();
    await coordinator.stop();

    const assistant = await store.readOutboxItem(assistantOutbox.id);
    expect(assistant?.status).toBe('retrying');
    expect(await store.readOutboxItem(userOutbox.id)).toMatchObject({ status: 'retrying' });
  });

  it('gives up on a queued prerequisite that never lands, after the bounded backstop', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('prerequisite-backstop');
    const userOutbox = persistedMessageOutbox(turn, {
      messageId: turn.inputMessageId,
      role: 'user',
      content: 'Никогда не сохранится.',
    });
    const assistantOutbox = persistedMessageOutbox(turn, {
      messageId: turn.outputMessageId!,
      role: 'assistant',
      content: turn.outcome!.summary,
      requiredPreviousMessageId: turn.inputMessageId,
    });
    await store.createTurn(turn, { outbox: [userOutbox, assistantOutbox] });
    const persistMessage = vi.fn(async (message: OscarPersistedMessage) => {
      if (message.role === 'user') throw new Error('simulated permanent user append outage');
      throw Object.assign(new Error('required previous user message has not been persisted yet'), {
        code: 'conversation-message-prerequisite-pending',
        statusCode: 409,
      });
    });
    for (let attempt = 0; attempt < 239; attempt += 1) {
      await store.markOutboxFailed(assistantOutbox.id, 'still waiting', new Date(0).toISOString());
    }

    const coordinator = createCoordinator({ persistentStore: store, persistMessage });
    await coordinator.start();
    await coordinator.stop();

    expect(await store.readOutboxItem(assistantOutbox.id)).toMatchObject({ status: 'superseded' });
  });

  it('keeps retrying a delivery failure that is not a missing prerequisite', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn = terminalPersistenceTurn('backend-outage');
    const assistantOutbox = persistedMessageOutbox(turn, {
      messageId: turn.outputMessageId!,
      role: 'assistant',
      content: turn.outcome!.summary,
      requiredPreviousMessageId: turn.inputMessageId,
    });
    await store.createTurn(turn, { outbox: [assistantOutbox] });
    const persistMessage = vi.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:7861'); });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      await store.markOutboxFailed(assistantOutbox.id, 'outage', new Date(0).toISOString());
    }

    const coordinator = createCoordinator({ persistentStore: store, persistMessage });
    await coordinator.start();
    await coordinator.stop();

    const settled = await store.readOutboxItem(assistantOutbox.id);
    expect(settled?.status).toBe('retrying');
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
    const restarted = createCoordinator({
      persistentStore: store,
      persisted,
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
    } finally {
      await restarted.stop();
    }

    const secondRestart = createCoordinator({
      persistentStore: store,
      persisted,
    });
    await secondRestart.start();
    await secondRestart.stop();
    expect(persisted).toHaveLength(1);
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
    const restarted = createCoordinator({
      persistentStore: store,
      persisted,
    });

    await restarted.start();
    await restarted.stop();

    expect((await store.getTurn(legacy.id))?.turn.outputMessageId).toBeUndefined();
    expect(await store.listPendingOutbox()).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it('reconciles every other Turn before an unrecoverable Astra Turn closes the barrier', async () => {
    // Throwing from inside the reconciliation loop meant one task that could
    // not be restored stopped reconciliation for every Turn after it: no
    // privacy mode, no terminal message repair, no re-routing, for the whole
    // process lifetime. The failure still has to reach the caller, because a
    // Turn that cannot be restored must hold the source-restore barrier closed.
    const store = new InMemoryOscarTurnStore();
    const broken: OscarTurnV1 = {
      ...linkedAgentTurn('agent_task_unrestorable'),
      id: 'oscar_turn_a_unrestorable',
      clientRequestId: 'client_a_unrestorable',
      inputMessageId: 'message_a_unrestorable',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      request: {
        text: 'Задача, которую не удастся восстановить.', attachmentIds: [], modifiers: {},
        astra: ordinaryAgentBinding(),
      },
    };
    await store.createTurn(broken);

    const later: OscarTurnV1 = {
      ...linkedAgentTurn('agent_task_later'),
      id: 'oscar_turn_b_later',
      clientRequestId: 'client_b_later',
      inputMessageId: 'message_b_later',
      createdAt: '2026-08-01T00:00:05.000Z',
      updatedAt: '2026-08-01T00:00:05.000Z',
      conversationId: 'conversation_later',
      request: { text: 'Обычный ход после неё.', attachmentIds: [], modifiers: {} },
    };
    const createdLater = await store.createTurn(later);
    await store.saveTurn({
      ...createdLater.turn,
      status: 'succeeded',
      outputMessageId: undefined,
      outcome: { kind: 'verified', summary: 'Готово.', evidenceRefs: [],
        completedAt: '2026-08-01T00:00:06.000Z' },
    }, { expectedRevision: createdLater.turn.revision });

    const persisted: OscarPersistedMessage[] = [];
    const coordinator = createCoordinator({ persistentStore: store, persisted,
      astra: { find: () => { throw new Error('astra-oscar-source-unavailable'); } } });

    await expect(coordinator.start()).rejects.toThrow('astra-oscar-source-unavailable');
    // The Turn that comes after it was still reconciled: its terminal message
    // was repaired rather than skipped, and the coordinator kept running, so
    // the repair was delivered.
    expect(persisted).toContainEqual(expect.objectContaining({ turnId: later.id }));
    expect(coordinator.isAstraRestoreHeld()).toBe(true);
    await coordinator.stop();
  });

  it('blocks an unrecoverable pre-stable-identity Astra Turn without aborting application startup', async () => {
    const store = new InMemoryOscarTurnStore();
    const turn: OscarTurnV1 = {
      ...linkedAgentTurn('agent_task_old_ephemeral_actor'),
      id: 'oscar_turn_old_ephemeral_actor',
      clientRequestId: 'client_old_ephemeral_actor',
      inputMessageId: 'message_old_ephemeral_actor',
      request: {
        text: 'Продолжи задачу после перезапуска.', attachmentIds: [], modifiers: {},
        astra: ordinaryAgentBinding(),
      },
    };
    await store.createTurn(turn);
    const persisted: OscarPersistedMessage[] = [];
    const coordinator = createCoordinator({ persistentStore: store, persisted,
      astra: { find: () => { throw new Error('astra-oscar-actor-changed'); } } });

    await coordinator.start();
    const blocked = await coordinator.getTurn(turn.id);
    expect(blocked?.turn).toMatchObject({ status: 'blocked', outcome: {
      kind: 'blocked', warning: 'astra-persistent-actor-migration-required',
    } });
    expect(blocked?.events).toContainEqual(expect.objectContaining({ type: 'turn.outcome',
      payload: expect.objectContaining({ outcome: 'blocked' }) }));
    expect(persisted).toContainEqual(expect.objectContaining({
      turnId: turn.id, outcome: 'blocked',
      content: expect.stringContaining('новая задача сохранит личность между запусками'),
    }));
    await coordinator.stop();
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
    const restarted = createCoordinator({
      persistentStore: store,
      persisted,
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
  });
});

function createCoordinator(options: {
  persistentStore?: InMemoryOscarTurnStore;
  volatileStore?: InMemoryOscarTurnStore;
  astra?: any;
  answerExecutor?: (...args: any[]) => Promise<AsyncIterable<OscarAnswerExecutorEvent>>;
  answerFallback?: () => Promise<{ answer: string; sources?: unknown[] }>;
  persisted?: OscarPersistedMessage[];
  dispositionProvider?: { classify(input: { text: string }): Promise<{ lane: 'answer' | 'agent' | 'clarify'; kind: string; confidence: number; reason: string }> };
  getOwnerUnrestrictedOverride?: () => { enabled: boolean; lifetime: 'session' | 'task' | 'persistent'; shellApprovalPolicy: 'always' | 'risk-based' | 'never' };
  consumeDataEgressConsent?: (consentId: string, turn: OscarTurnV1) => Promise<void>;
  persistMessage?: (message: OscarPersistedMessage) => Promise<
    void | { disposition: 'created' | 'duplicate' | 'superseded' }
  >;
  resolveAttachments?: (...args: any[]) => Promise<any[]>;
  learnFromMessage?: (input: { turn: OscarTurnV1; text: string }) => Promise<any[]>;
  rememberMemory?: (input: { turn: OscarTurnV1; text: string }) => Promise<{
    receiptId: string;
    revision: number;
    contentHash: string;
    action?: string;
    text?: string;
    replacedText?: string;
  }>;
  forgetMemory?: (input: { turn: OscarTurnV1; query: string }) => Promise<{
    receiptId: string; revision: number; contentHash: string; forgotten: { id: string; text: string } | null;
  }>;
  listMemory?: (input: { turn: OscarTurnV1 }) => Promise<Array<{ id: string; text: string; category: string; origin: string }>>;
  resolvePersonality?: () => Promise<OscarTurnV1['request']['personality'] | null>;
  researchEvidence?: (input: { query: string; deep: boolean; signal: AbortSignal }) => Promise<string>;
  agentFirst?: boolean;
  maxLocalFallbackAllowed?: () => boolean;
} = {}) {
  const persisted = options.persisted || [];
  return new OscarTurnCoordinator({
    persistentStore: options.persistentStore || new InMemoryOscarTurnStore(),
    volatileStore: options.volatileStore || new InMemoryOscarTurnStore(),
    ...(options.astra ? { astra: options.astra } : {}),
    ...(options.agentFirst === undefined ? {} : { agentFirst: options.agentFirst }),
    answerExecutor: options.answerExecutor || (async () => stream([
      { type: 'token', token: 'Обычный ответ.' },
      { type: 'done' },
    ])),
    ...(options.answerFallback ? { answerFallback: options.answerFallback } : {}),
    persistMessage: options.persistMessage || (async (message) => { persisted.push(message); }),
    ...(options.resolveAttachments ? { resolveAttachments: options.resolveAttachments } : {}),
    ...(options.dispositionProvider ? { dispositionProvider: options.dispositionProvider } : {}),
    ...(options.maxLocalFallbackAllowed ? { maxLocalFallbackAllowed: options.maxLocalFallbackAllowed } : {}),
    ...(options.getOwnerUnrestrictedOverride
      ? { getOwnerUnrestrictedOverride: options.getOwnerUnrestrictedOverride }
      : {}),
    ...(options.consumeDataEgressConsent ? { consumeDataEgressConsent: options.consumeDataEgressConsent } : {}),
    ...(options.rememberMemory ? { rememberMemory: options.rememberMemory } : {}),
    ...(options.learnFromMessage ? { learnFromMessage: options.learnFromMessage } : {}),
    ...(options.forgetMemory ? { forgetMemory: options.forgetMemory } : {}),
    ...(options.listMemory ? { listMemory: options.listMemory } : {}),
    ...(options.resolvePersonality ? { resolvePersonality: options.resolvePersonality } : {}),
    ...(options.researchEvidence ? { researchEvidence: options.researchEvidence } : {}),
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

function ordinaryAgentBinding() {
  return {
    version: 'astra-oscar-isolated-v1' as const,
    actor: { id: `sha256:${'a'.repeat(64)}`, source: 'desktop' as const },
    selectionId: 'ordinary_agent_test_selection',
    goal: { kind: 'agent' as const, modelMode: 'local' as const },
    admission: 'ordinary-agent-v1' as const,
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


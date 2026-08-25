import { describe, expect, it } from 'vitest';
import {
  appendUnhydratedLocalAssistant,
  formatOscarModelLabel,
  isHydratedOscarFailure,
  OSCAR_CANCELLED_SUMMARY,
  presentOscarHistoryContent,
  resolveHydratedOscarMessageLabel,
  resolveOscarHistoryListState,
} from '../../src/ui/public/modules/oscar-history-reconciliation.js';
import { OSCAR_TURN_CANCELLED_SUMMARY } from '../../src/oscar-turn';

describe('Oscar history reconciliation', () => {
  const user = { id: 'user-local', role: 'user', content: 'Проверь список', turnId: 'turn-1' };
  const failure = {
    id: 'assistant-local',
    role: 'assistant',
    content: 'Не удалось завершить задачу.',
    turnId: 'turn-1',
    outcome: 'failed',
    error: true,
    pending: false,
  };

  it('keeps the local terminal failure while durable message persistence is still catching up', () => {
    expect(appendUnhydratedLocalAssistant([user, failure], [user])).toEqual([user, failure]);
  });

  it('keeps the complete local turn when neither message has reached an empty durable history yet', () => {
    expect(appendUnhydratedLocalAssistant([user, failure], [])).toEqual([user, failure]);
  });

  it('keeps a locally settled cancellation until its durable terminal message arrives', () => {
    const cancelled = {
      ...failure,
      id: 'assistant-cancelled',
      content: 'Задача остановлена.',
      outcome: 'cancelled',
      error: false,
    };
    expect(appendUnhydratedLocalAssistant([user, cancelled], [])).toEqual([user, cancelled]);
  });

  it('uses one cancellation copy for local UI, live Turn and legacy hydrated history', () => {
    expect(OSCAR_CANCELLED_SUMMARY).toBe(OSCAR_TURN_CANCELLED_SUMMARY);
    expect(presentOscarHistoryContent('Turn отменён пользователем.', 'cancelled'))
      .toBe(OSCAR_CANCELLED_SUMMARY);
    expect(presentOscarHistoryContent('Answer Turn отменён.', 'CANCELLED'))
      .toBe(OSCAR_CANCELLED_SUMMARY);
    expect(presentOscarHistoryContent('Обычный ответ.', 'answered')).toBe('Обычный ответ.');
  });

  it('does not erase older local history when an empty hydration races the terminal outbox', () => {
    const oldUser = { id: 'old-user', role: 'user', content: 'Старый запрос', turnId: 'turn-0' };
    const oldAssistant = { id: 'old-assistant', role: 'assistant', content: 'Старый ответ', turnId: 'turn-0' };
    const existing = [oldUser, oldAssistant, user, failure];
    expect(appendUnhydratedLocalAssistant(existing, [])).toEqual(existing);
  });

  it('keeps the complete local turn behind an overlapping durable history prefix', () => {
    const oldUser = { id: 'old-user', role: 'user', content: 'Старый запрос', turnId: 'turn-0' };
    const oldAssistant = { id: 'old-assistant', role: 'assistant', content: 'Старый ответ', turnId: 'turn-0' };
    expect(appendUnhydratedLocalAssistant(
      [oldUser, oldAssistant, user, failure],
      [{ ...oldUser }, { ...oldAssistant }],
    )).toEqual([oldUser, oldAssistant, user, failure]);
  });

  it('matches a hydrated user by its coordinator client message id', () => {
    const hydratedUser = {
      ...user,
      id: 'sqlite-user-id',
      clientMessageId: user.id,
    };
    expect(appendUnhydratedLocalAssistant([user, failure], [hydratedUser]))
      .toEqual([hydratedUser, failure]);
  });

  it('uses the hydrated terminal exactly once after persistence catches up', () => {
    const hydratedFailure = { ...failure, id: 'assistant-durable', error: false };
    expect(appendUnhydratedLocalAssistant([user, failure], [user, hydratedFailure]))
      .toEqual([user, hydratedFailure]);
  });

  it('does not append a stale local terminal to an unrelated hydrated turn', () => {
    const unrelatedUser = { ...user, id: 'user-2', turnId: 'turn-2', content: 'Другой запрос' };
    expect(appendUnhydratedLocalAssistant([user, failure], [unrelatedUser])).toEqual([unrelatedUser]);
  });

  it('preserves a local transport error without a turn id only for the matching user request', () => {
    const transportFailure = { ...failure, id: 'transport-error', turnId: '' };
    expect(appendUnhydratedLocalAssistant([user, transportFailure], [{ ...user, turnId: '' }]))
      .toEqual([{ ...user, turnId: '' }, transportFailure]);
  });

  it.each([
    ['failed', true],
    ['FAILED', true],
    ['blocked', false],
    ['cancelled', false],
    ['', false],
  ])('reconstructs durable error styling for outcome %s', (outcome, expected) => {
    expect(isHydratedOscarFailure(outcome)).toBe(expected);
  });

  it('does not label a hydrated Kernel result as generic history when no model tier was persisted', () => {
    const kernelMessage = {
      role: 'assistant',
      task_id: 'task-kernel-1',
      outcome: 'verified',
      provenance: { origin: 'kernel', verification: 'kernel-verified' },
    };

    expect(resolveHydratedOscarMessageLabel(kernelMessage)).toBe('');
    expect(resolveHydratedOscarMessageLabel({ ...kernelMessage, model_tier: 'gemma4-balanced' })).toBe('Medium');
    expect(resolveHydratedOscarMessageLabel({ role: 'user' })).toBe('ты');
    expect(formatOscarModelLabel('gemma4-deepthinking')).toBe('Pro');
  });

  it.each([
    [{ busy: true, error: 'stale', conversationCount: 0 }, 'loading', ''],
    [{ busy: false, error: 'backend offline', conversationCount: 0 }, 'unavailable', 'backend offline'],
    [{ busy: false, error: '', conversationCount: 0 }, 'empty', ''],
    [{ busy: false, error: 'backend offline', conversationCount: 3, visibleCount: 3 }, 'ready', 'backend offline'],
    [{ busy: false, error: 'backend offline', conversationCount: 3, visibleCount: 0, queryActive: true }, 'no-results', 'backend offline'],
  ])('distinguishes unavailable history from an empty or stale list %#', (input, kind, historyError) => {
    expect(resolveOscarHistoryListState(input)).toEqual({ kind, historyError });
  });
});

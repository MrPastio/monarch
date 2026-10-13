import { describe, expect, it, vi } from 'vitest';
import {
  classifyIntentText,
  classifyOscarRequestDisposition,
  isOscarCapabilitiesOrIdentityRequest,
  isOscarDirectAccessAnswerOnlyRequest,
  isOscarResponseOnlyRequest,
  selectModelRouteForText,
} from '../../src/core';
import { classifyOscarServerDisposition } from '../../src/oscar-turn/disposition';
import { oscarDirectToolAccessActive } from '../../src/oscar-turn/direct-tool-access';

describe('intent metadata without phrase authority', () => {
  it('keeps deterministic classification as bounded metadata', () => {
    const fileWrite = classifyIntentText('создай markdown отчет в файл');
    expect(fileWrite).toMatchObject({
      kind: 'file_generation',
      fileIntentMode: 'authoring',
      routingPreference: 'model',
    });

    const explanation = classifyIntentText('Объясни как удалить файл в Node.js');
    expect(explanation).toMatchObject({ kind: 'explanation', riskHint: 'none' });
    expect(selectModelRouteForText('Объясни подробно', explanation).selectedRole).not.toBe('gemma4-31b');
  });

  it('lets the structured model own ordinary answer versus Agent selection', async () => {
    const provider = {
      classify: vi.fn()
        .mockResolvedValueOnce({
          lane: 'agent',
          kind: 'tool_use',
          confidence: 0.98,
          reason: 'The model selected a typed Agent task from the full request.',
        })
        .mockResolvedValueOnce({
          lane: 'answer',
          kind: 'explanation',
          confidence: 0.99,
          reason: 'The model selected an answer without local effects.',
        }),
    };

    const unusualAgentRequest = await classifyOscarServerDisposition(
      'Сопоставь локальные артефакты и доведи результат до готового состояния',
      provider,
    );
    const operationalWordsButAnswer = await classifyOscarServerDisposition(
      'Запусти объяснение того, как устроен backend, без действий на компьютере',
      provider,
    );

    expect(unusualAgentRequest.lane).toBe('agent');
    expect(operationalWordsButAnswer.lane).toBe('answer');
    expect(provider.classify).toHaveBeenCalledTimes(2);
  });

  it('never upgrades failed semantic disposition into execution from wording alone', async () => {
    const hints = classifyOscarRequestDisposition('удали файл C:\\Temp\\state.json');
    expect(hints.mode).toBe('agent');

    const result = await classifyOscarServerDisposition(
      'удали файл C:\\Temp\\state.json',
      { classify: vi.fn().mockRejectedValue(new Error('model unavailable')) },
    );

    expect(result.lane).toBe('clarify');
    expect(result.reason).toMatch(/no executor|failed|unavailable/i);
  });

  it.each([
    'росскажи что ты умеешь и какая ты модель',
    'расскажи что ты умеешь и какая ты модель',
    'что ты умеешь',
    'who are you',
    'какая у тебя модель',
  ])('keeps capability and identity questions off the Agent surface: %s', (text) => {
    expect(isOscarCapabilitiesOrIdentityRequest(text)).toBe(true);
    expect(classifyOscarRequestDisposition(text).mode).toBe('chat');
  });
});

describe('Direct Access answer-only exclusions', () => {
  it.each([
    'Напиши рассказ о себе и твоей системе на 10 000 строк',
    'Напиши россказ о себеи и твоей системе на 10 000 строк Додумывай если нужно',
    'придумай сказку про дракона',
    'write a short story about a lighthouse',
  ])('keeps pure content generation off the Agent lane (%s)', request => {
    // Direct Access skips semantic routing, so a request whose whole result is the
    // answer text used to enter the Agent runtime and fail there instead of being written.
    expect(isOscarDirectAccessAnswerOnlyRequest(request)).toBe(true);
    // Ordinary routing keeps no such phrase rule: there the selected model decides.
    expect(isOscarResponseOnlyRequest(request)).toBe(false);
  });

  it.each(['привет', 'Привет!', 'привет, Оскар', 'спасибо', 'как дела?', 'ок', 'Hello', 'thanks', 'добрый вечер'])(
    'answers greetings and small talk without the Agent lane (%s)',
    request => {
      // A routing model reading an agent-heavy history sent "привет" to the agent.
      expect(isOscarResponseOnlyRequest(request)).toBe(true);
    },
  );

  it.each(['привет, создай файл notes.md', 'спасибо, теперь запусти тесты', 'ok run npm test'])(
    'keeps a task after a greeting off the small-talk rule (%s)',
    request => {
      expect(isOscarResponseOnlyRequest(request)).toBe(false);
    },
  );

  it.each([
    'напиши отчёт в файл E:\Monarch\report.md',
    'создай проект на typescript в workspace',
  ])('still admits content requests that name a local target (%s)', request => {
    expect(isOscarDirectAccessAnswerOnlyRequest(request)).toBe(false);
  });
});

describe('Direct Access routing preset', () => {
  it.each([
    'напиши скрипт и запусти его',
    'составь список процессов через терминал',
    'напиши команду для очистки кэша и выполни её',
    'write a script and run it',
  ])('keeps a content request with a follow-through clause on the Agent lane (%s)', request => {
    // Producing the text and stopping there answers only half of the request.
    expect(isOscarDirectAccessAnswerOnlyRequest(request)).toBe(false);
  });

  it('treats a named project as local work only when the request names something inside it', () => {
    expect(isOscarDirectAccessAnswerOnlyRequest('придумай имя для проекта')).toBe(true);
    expect(isOscarDirectAccessAnswerOnlyRequest('напиши тесты для проекта')).toBe(false);
  });

  it('does not route a task-scoped Owner grant into the Agent lane', () => {
    // A task grant belongs to one running task; Kernel gates everything else as usual,
    // so routing new Turns on the strength of it would send work into the Agent lane
    // with ordinary approval still in force.
    expect(oscarDirectToolAccessActive(
      { enabled: true, lifetime: 'task', taskId: 'agent_task_1', shellApprovalPolicy: 'never' }, 'desktop',
    )).toBe(false);
    expect(oscarDirectToolAccessActive(
      { enabled: true, lifetime: 'persistent', shellApprovalPolicy: 'never' }, 'desktop',
    )).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  classifyVoiceModeCommand,
  normalizeVoiceCommandText,
  shouldUseVoiceModeFastLlm,
  shouldUseVoiceModeLlm,
  voiceModeLocalProfile,
} from '../../src/modules/voice/voice-mode';

describe('voice mode scaffold', () => {
  it('normalizes Oscar wake words and filler before command matching', () => {
    expect(normalizeVoiceCommandText('Оскар, ну скажи пожалуйста сколько времени')).toBe('сколько времени');

    const candidate = classifyVoiceModeCommand('Оскар, ну скажи пожалуйста сколько времени');

    expect(candidate).toMatchObject({
      actionId: 'time.query',
      lane: 'scripted',
      modelRoute: 'none',
      risk: 'read',
      requiresConfirmation: false,
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Ну Оскар, который сейчас час?')).toMatchObject({
      actionId: 'time.query',
      lane: 'scripted',
    });
    expect(classifyVoiceModeCommand('Слушай, Оскар, премьер России')).toMatchObject({
      actionId: 'web.search',
      lane: 'voice-realtime',
      slots: { query: 'премьер россии' },
    });
    expect(classifyVoiceModeCommand('Ну кто такой Оскар?')).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'fast-llm',
      normalizedText: 'кто такой оскар',
    });
  });

  it.each([
    'время',
    'Сколько сейчас времени?',
    'Время сейчас сколько',
    'Назови мне точное время',
    'Оскар, какое у нас сейчас время?',
    'Оскар, узнай время',
    'Оскар, которое сейчас время?',
    'Точного времени',
    'Что там по времени?',
    'what time is it',
  ])('recognizes the order-independent local clock intent: %s', (text) => {
    expect(classifyVoiceModeCommand(text)).toMatchObject({
      actionId: 'time.query',
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
      requiresRealtime: false,
      slots: { query: 'local-clock', timeZone: 'system' },
    });
  });

  it.each([
    'Сколько времени займет загрузка?',
    'Через сколько времени закончится установка?',
    'Покажи время выполнения задачи',
    'Сколько времени прошло после запуска?',
    'Покажи временный файл',
    'Сколько временных файлов создано?',
  ])('does not confuse a duration with the wall clock: %s', (text) => {
    const candidate = classifyVoiceModeCommand(text);
    expect(candidate.actionId).not.toBe('time.query');
    expect(candidate.lane).toBe('fast-llm');
  });

  it.each([
    ['Оскар', 'Слушаю.'],
    ['Оскар?', 'Слушаю.'],
    ['Оскар, Оскар?', 'Слушаю.'],
    ['Оскар, ты тут?', 'Я тут.'],
    ['Оскар, ты меня слышишь?', 'Слушаю.'],
    ['Оскар, ну эй', 'Я тут.'],
  ])('routes the minimal vocative %s to a local acknowledgement', (text, acknowledgement) => {
    expect(classifyVoiceModeCommand(text)).toMatchObject({
      actionId: 'listen.continue',
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
      requiresRealtime: false,
      slots: { acknowledgement },
    });
  });

  it.each([
    'кто такой Оскар',
    'фильмы Оскар 2026',
    'Оскар, кто ты?',
    'Оскар, кто получил премию Оскар?',
    'Оскар, ты тут и что ты умеешь?',
  ])('does not swallow the meaningful question %s as a vocative', (text) => {
    const candidate = classifyVoiceModeCommand(text);

    expect(candidate.actionId).not.toBe('listen.continue');
    expect(candidate.usesLlm).toBe(true);
  });

  it('routes bounded weather and web lookups to the isolated realtime voice lane', () => {
    const weather = classifyVoiceModeCommand('монарх пожалуйста погода в Киеве сегодня');
    const search = classifyVoiceModeCommand('монарх найди локальные модели распознавания речи');
    const missingLocation = classifyVoiceModeCommand('Подскажи погоду прямо сейчас');

    expect(weather).toMatchObject({
      actionId: 'weather.query',
      lane: 'voice-realtime',
      modelRoute: 'none',
      slots: { location: 'киеве' },
      usesLlm: false,
      requiresRealtime: true,
      maxNewTokens: 0,
    });
    expect(search).toMatchObject({
      actionId: 'web.search',
      lane: 'voice-realtime',
      modelRoute: 'gemma4-fast',
      slots: { query: 'локальные модели распознавания речи' },
      usesLlm: true,
      requiresRealtime: true,
    });
    expect(missingLocation).toMatchObject({
      actionId: 'weather.query',
      lane: 'scripted',
      modelRoute: 'none',
      slots: {},
      usesLlm: false,
      requiresRealtime: false,
    });
  });

  it('never routes volume status questions into the mutating device lane', () => {
    expect(classifyVoiceModeCommand('У меня громкость на максимум?')).toMatchObject({
      actionId: 'device.volume.status',
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Громкость сейчас 50 процентов?')).toMatchObject({
      actionId: 'device.volume.status',
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Поставь громкость на максимум')).toMatchObject({
      actionId: 'device.volume',
      lane: 'scripted',
      usesLlm: false,
    });
  });

  it('extracts order-independent volume intent and safely repairs the observed STT homophone', () => {
    expect(classifyVoiceModeCommand('Громкость установи обратно на стол')).toMatchObject({
      actionId: 'device.volume',
      normalizedText: 'громкость установи обратно на сто процентов',
      lane: 'scripted',
      risk: 'write',
      requiresConfirmation: true,
      usesLlm: false,
      slots: {
        domain: 'volume',
        operation: 'set',
        value: '100',
        sttNormalization: 'numeric-homophone',
      },
    });
    expect(classifyVoiceModeCommand('На 35 процентов громкость установи')).toMatchObject({
      actionId: 'device.volume',
      slots: { operation: 'set', value: '35' },
    });
    expect(classifyVoiceModeCommand('Звук выключи')).toMatchObject({
      actionId: 'device.volume',
      slots: { operation: 'mute' },
    });
  });

  it.each([
    'Установи громкость обратно',
    'Громкость 50 процентов',
    'Включи и выключи звук',
  ])('keeps an ambiguous volume request in a read-only scripted clarification: %s', (text) => {
    expect(classifyVoiceModeCommand(text)).toMatchObject({
      actionId: 'device.volume.clarification',
      lane: 'scripted',
      risk: 'read',
      requiresConfirmation: false,
      usesLlm: false,
      slots: { domain: 'volume', intent: 'clarification' },
    });
  });

  it('does not hijack a factual question merely because it mentions volume', () => {
    expect(classifyVoiceModeCommand('Почему громкость записи такая низкая?')).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'fast-llm',
      modelRoute: 'gemma4-fast',
    });
    expect(classifyVoiceModeCommand('Сколько времени займет установить громкость на 50 процентов?')).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'fast-llm',
      risk: 'read',
    });
  });

  it.each([
    'премьер России',
    'кто сейчас премьер России',
    'Кто генеральный директор OpenAI?',
    'Какой сегодня курс доллара?',
    'Последние новости Украины',
  ])('routes volatile factual knowledge through current source lookup: %s', (text) => {
    expect(classifyVoiceModeCommand(text)).toMatchObject({
      actionId: 'web.search',
      lane: 'voice-realtime',
      modelRoute: 'gemma4-fast',
      usesLlm: true,
      requiresRealtime: true,
      slots: { freshness: 'current' },
    });
  });

  it('removes the vocative and question shell from the realtime search query', () => {
    expect(classifyVoiceModeCommand('Слушай, Оскар, кто сейчас премьер России?')).toMatchObject({
      actionId: 'web.search',
      lane: 'voice-realtime',
      slots: { query: 'премьер россии', freshness: 'current' },
    });
  });

  it.each([
    'Кто был премьером России в 1999 году?',
    'Почему небо голубое?',
    'Столица Франции',
    'Кто написал Войну и мир?',
  ])('keeps stable knowledge off tiny voice models: %s', (text) => {
    expect(classifyVoiceModeCommand(text)).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'fast-llm',
      modelRoute: 'gemma4-fast',
    });
  });

  it('keeps a bounded non-factual rewrite on the fixed Fast voice model', () => {
    expect(classifyVoiceModeCommand('Перефразируй: проверка завершена')).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'fast-llm',
      modelRoute: 'gemma4-fast',
    });
  });

  it.each([
    ['Открой калькулятор', 'device.app.open'],
    ['Запусти блокнот', 'device.app.open'],
    ['Открой хром', 'device.app.open'],
    ['Вруби ролик на ютубе', 'device.media.open'],
    ['Сделай экран ярче', 'device.brightness'],
    ['Выключи вайфай', 'device.control.unsupported'],
    ['Создай документ test.txt', 'workspace.create'],
  ])('keeps the deterministic action %s out of every LLM lane', (text, actionId) => {
    expect(classifyVoiceModeCommand(text)).toMatchObject({
      actionId,
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
    });
  });

  it('keeps arithmetic and device actions out of every language model lane', () => {
    expect(classifyVoiceModeCommand('Оскар, 17 плюс 25')).toMatchObject({
      actionId: 'math.calculate',
      lane: 'scripted',
      modelRoute: 'none',
      slots: { result: '42' },
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Сделай громкость тише')).toMatchObject({
      actionId: 'device.volume',
      lane: 'scripted',
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Поставь громкость на максимум')).toMatchObject({
      actionId: 'device.volume',
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Какая сейчас яркость экрана?')).toMatchObject({
      actionId: 'device.brightness.status',
      risk: 'read',
      lane: 'scripted',
      requiresConfirmation: false,
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Поставь яркость на 60 процентов')).toMatchObject({
      actionId: 'device.brightness',
      risk: 'write',
      lane: 'scripted',
      requiresConfirmation: true,
      slots: { operation: 'set', value: '60' },
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Открой браузер Chrome')).toMatchObject({
      actionId: 'device.browser.open',
      lane: 'scripted',
      usesLlm: false,
    });
    expect(classifyVoiceModeCommand('Включи видео на YouTube')).toMatchObject({
      actionId: 'device.media.open',
      lane: 'scripted',
      usesLlm: false,
    });
  });

  it('requires confirmation for workspace writes and destructive commands', () => {
    const create = classifyVoiceModeCommand('монарх создай файл заметка.txt');
    const remove = classifyVoiceModeCommand('монарх удали файл temp.txt');

    expect(create).toMatchObject({
      actionId: 'workspace.create',
      risk: 'write',
      requiresConfirmation: true,
      usesLlm: false,
    });
    expect(remove).toMatchObject({
      actionId: 'workspace.delete',
      risk: 'write',
      requiresConfirmation: true,
      usesLlm: false,
    });
  });

  it('keeps primitive replies model-free and every substantive fallback in Fast', () => {
    const socialReply = classifyVoiceModeCommand('Оскар, привет, как дела?');
    const shortFallback = classifyVoiceModeCommand('монарх объясни это коротко');
    const simpleKnowledge = classifyVoiceModeCommand('Почему небо голубое?');
    const complexFallback = classifyVoiceModeCommand('Оскар, проанализируй эту архитектуру и сравни варианты');
    const oversizedFallback = classifyVoiceModeCommand(`Оскар ${'объясни '.repeat(100)}`);

    expect(socialReply).toMatchObject({
      actionId: 'listen.continue',
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
      slots: { acknowledgement: 'Привет. Всё нормально.' },
    });
    expect(voiceModeLocalProfile(socialReply)).toBeNull();

    expect(shortFallback).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'fast-llm',
      modelRoute: 'gemma4-fast',
      maxNewTokens: 192,
      usesLlm: true,
    });
    expect(shouldUseVoiceModeLlm(shortFallback)).toBe(true);
    expect(shouldUseVoiceModeFastLlm(shortFallback)).toBe(true);
    expect(voiceModeLocalProfile(shortFallback)).toBeNull();
    expect(simpleKnowledge).toMatchObject({ lane: 'fast-llm', modelRoute: 'gemma4-fast' });

    expect(complexFallback).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'fast-llm',
      modelRoute: 'gemma4-fast',
      usesLlm: true,
    });
    expect(shouldUseVoiceModeFastLlm(complexFallback)).toBe(true);
    expect(voiceModeLocalProfile(complexFallback)).toBeNull();

    expect(oversizedFallback).toMatchObject({
      actionId: 'assistant.fallback',
      lane: 'blocked',
      modelRoute: 'none',
      usesLlm: false,
    });
    expect(shouldUseVoiceModeLlm(oversizedFallback)).toBe(false);
  });

  it.each([
    ['да', 'Да.'],
    ['угу', 'Да.'],
    ['нет', 'Нет.'],
    ['окей', 'Хорошо.'],
    ['пока', 'До встречи.'],
  ])('answers the primitive phrase %s without allocating any model', (text, acknowledgement) => {
    expect(classifyVoiceModeCommand(text)).toMatchObject({
      actionId: 'listen.continue',
      lane: 'scripted',
      modelRoute: 'none',
      usesLlm: false,
      slots: { acknowledgement },
    });
  });
});

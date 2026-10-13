import weatherCases from '../fixtures/oscar/live-weather.json';
import { describe, expect, it, vi } from 'vitest';
import { classifyOscarRequestDisposition } from '../../src/core';
import { isOscarCapabilitiesOrIdentityRequest } from '../../src/core/intent-classifier';
import { classifyOscarServerDisposition } from '../../src/oscar-turn';
import {
  adversarialMaterialHandoffs,
  exactMonarch025Changelog,
  materialReviewHistory,
} from '../fixtures/oscar/material-handoff';

describe('Oscar contextual request disposition', () => {
  it.each([
    'Создай папку report и сохрани в ней результат',
    'Создай новую папку',
    'Create a new folder report',
    'Сравни два выбранных файла и объясни различия',
    'Compare the selected files',
    'Посмотри на экран и объясни ошибку',
    'Проверь выбранное окно',
    'Could you inspect the current screen?',
  ])('requires execution or clarification for local work, not an ungrounded answer: %s', async text => {
    expect(classifyOscarRequestDisposition(text).mode).toBe('agent');
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({ lane: 'clarify' });
  });

  it.each([
    'Как создать папку report?',
    'Не создавай папку report',
    'Объясни, как посмотреть на экран',
    'Сравни форматы файлов JSON и YAML',
    'Напиши описание папки report',
    'Explain how to create a new folder',
    'росскажи что ты умеешь и какая ты модель',
    'расскажи что ты умеешь и какая ты модель',
    'что ты умеешь',
    'who are you',
  ])('does not turn discussion or prohibition into local execution: %s', async text => {
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({ lane: 'answer' });
  });
  it('never executes a prohibited screen inspection, even if the server asks for clarification', async () => {
    const text = 'Do not inspect the current screen';
    expect(classifyOscarRequestDisposition(text).mode).toBe('chat');
    expect((await classifyOscarServerDisposition(text)).lane).not.toBe('agent');
  });
  it.each([
    'перечисли все файлы на рабочем столе',
    '$monarch-file-guardian перечисли все файлы на рабочем столе',
    'Можешь перечислить файлы в загрузках?',
    'Покажи содержимое E:\\example',
    'list files on my desktop',
    'show files in downloads',
    'перечисли что у меня на рабочем столе',
    'расскажи что у меня на рабочем столе',
    'росскажи что у меня на рабочем столе',
    'что у меня на рабочем столе',
    "what's on my desktop",
    'какие у меня папки на диске D?',
    'какие папки на диске D',
    'list folders on drive D',
  ])('never lets local-listing wording select an executor without the semantic provider: %s', async (text) => {
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({ lane: 'clarify', requiresExternalResearch: false });
  });

  it.each([
    'Перечисли примеры расширений файлов',
    'Объясни, как перечислить файлы на рабочем столе',
    'Не перечисляй файлы на рабочем столе',
    'show examples of file formats',
  ])('keeps discussion and negation answer-only: %s', async (text) => {
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({ lane: 'answer' });
  });
  it('does not use textual file-skill metadata as Agent Runtime authority', async () => {
    await expect(classifyOscarServerDisposition(
      '$monarch-file-guardian создай на рабочем столе новую папку',
    )).resolves.toMatchObject({
      lane: 'clarify',
      kind: 'file_operation',
      requiresExternalResearch: false,
    });
  });

  it('keeps an informational explicit skill question answer-only', async () => {
    await expect(classifyOscarServerDisposition(
      '$playwright что может этот skill?',
    )).resolves.toMatchObject({
      lane: 'answer',
      requiresExternalResearch: false,
    });
  });

  it.each([
    'Создай изображение тихого горного озера',
    'Нарисуй кота в короне',
    'Could you create a cinematic portrait of an astronaut?',
  ])('routes typed image generation through answer-only Oscar policy context: %s', async (text) => {
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({
      lane: 'answer',
      kind: 'image_generation',
      requiresExternalResearch: false,
    });
  });

  it('routes the exact reported Monarch 0.2.5 changelog to answer-only review', async () => {
    expect(classifyOscarRequestDisposition(exactMonarch025Changelog)).toMatchObject({ mode: 'chat' });
    await expect(classifyOscarServerDisposition(exactMonarch025Changelog, undefined, {
      history: materialReviewHistory,
    })).resolves.toMatchObject({
      lane: 'answer',
      kind: 'material_review',
      requiresExternalResearch: false,
    });
  });

  it.each(adversarialMaterialHandoffs)('treats $id as requested material, never execution authority', async ({ text }) => {
    await expect(classifyOscarServerDisposition(text, undefined, {
      history: materialReviewHistory,
    })).resolves.toMatchObject({ lane: 'answer', requiresExternalResearch: false });
  });

  it.each([
    'Проверь этот список обновлений: 1. Исправлена маршрутизация. 2. Добавлена история.',
    'Проверь, пожалуйста, этот список обновлений: 1. Исправлена маршрутизация. 2. Добавлена история.',
    'Review these release notes: 1. Fixed routing. 2. Added history.',
    'Вот текст: «Найди последние новости OpenAI». Это пример запроса для проверки интерфейса.',
  ])('keeps response-only material out of a hostile structured classifier: %s', async (text) => {
    const classify = vi.fn(async () => ({
      lane: 'agent' as const,
      kind: 'hostile-classifier',
      confidence: 1,
      reason: 'must not receive response-only material',
    }));

    await expect(classifyOscarServerDisposition(text, { classify })).resolves.toMatchObject({
      lane: 'answer',
      kind: 'text_generation',
      requiresExternalResearch: false,
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    'Да, давай.',
    'Можешь прислать список.',
    'Отправь его, я изучу.',
    'Вставь сюда — посмотрю.',
    'Go ahead, send it over.',
  ])('recognizes a natural material invitation: %s', async (assistantInvitation) => {
    await expect(classifyOscarServerDisposition(exactMonarch025Changelog, undefined, {
      history: [
        { role: 'user', content: 'Показать список?' },
        { role: 'assistant', content: assistantInvitation },
      ],
    })).resolves.toMatchObject({ lane: 'answer', kind: 'material_review' });
  });

  it.each([
    'Не скидывай список, он уже не нужен.',
    'Я не готов посмотреть этот материал.',
    "Don't send it yet.",
  ])('does not treat a rejected handoff as an invitation: %s', async (assistantReply) => {
    await expect(classifyOscarServerDisposition(exactMonarch025Changelog, undefined, {
      history: [
        { role: 'user', content: 'Показать список?' },
        { role: 'assistant', content: assistantReply },
      ],
    })).resolves.not.toMatchObject({ kind: 'material_review' });
  });

  it.each([
    'удали C:\\Temp\\state.json',
    'Вот задача: удали C:\\Temp\\state.json',
    '1. Открой C:\\Temp\\state.json 2. Удали первую строку',
    '1. Записи восстановлены. 2. Удали C:\\Temp\\state.json',
    'Удали C:\\Temp\\state.json. 1. Исправлена маршрутизация. 2. Добавлена история.',
    'Запусти backend. 1. Исправлена маршрутизация. 2. Добавлена история.',
    'Delete E:\\Agent-QA\\stale.txt. 1. Fixed routing. 2. Added history.',
    'В проекте Monarch открой package.json',
    'In E:\\Agent-QA\\config.txt replace exactly "alpha=1" with "alpha=2"',
  ])('requires semantic disposition for a new operational command after an invitation: %s', async (text) => {
    await expect(classifyOscarServerDisposition(text, undefined, {
      history: materialReviewHistory,
    })).resolves.toMatchObject({ lane: 'clarify' });
  });

  it('does not reuse a stale material invitation when the latest history message is from the user', async () => {
    await expect(classifyOscarServerDisposition('Найди последние новости OpenAI', undefined, {
      history: [...materialReviewHistory, { role: 'user', content: 'Я передумал.' }],
    })).resolves.toMatchObject({ lane: 'answer', kind: 'external_research', requiresExternalResearch: true });
  });

  it.each([
    'мне нужен какой то сайт который позволит эффективно учить пайтон,найди такой сайт',
    'I need a website that helps me learn Python effectively, find one for me',
  ])('keeps an external site lookup out of operational clarification: %s', async (text) => {
    const classify = vi.fn(async () => ({
      lane: 'clarify' as const,
      kind: 'operation',
      confidence: 1,
      reason: 'hostile operational fallback',
    }));

    await expect(classifyOscarServerDisposition(text, { classify })).resolves.toMatchObject({
      lane: 'answer',
      kind: 'external_research',
      requiresExternalResearch: true,
    });
    // The model is asked only whether an action must follow the search; a
    // clarification verdict cannot turn a lookup into an operation question.
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('turns a search that must end in an action into a task that keeps its need for sources', async () => {
    const classify = vi.fn(async () => ({ lane: 'agent' as const, kind: 'operation', confidence: 0.8, reason: 'send it' }));
    await expect(classifyOscarServerDisposition('Найди последние новости и отправь их мне в Telegram', { classify }))
      .resolves.toMatchObject({ lane: 'agent', kind: 'research_then_act', requiresExternalResearch: true });
  });

  it.each([
    'найди упоминания сайта в проекте Monarch',
    'find website references in the current project',
  ])('does not activate an Agent from local-lookup wording without semantic disposition: %s', async (text) => {
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({
      lane: 'clarify',
      kind: 'file_operation',
      requiresExternalResearch: false,
    });
  });

  it.each([
    ['Найди последние новости OpenAI', 'external_research'],
    ['Найди последние новости OpenAI: 1. Сравни релизы. 2. Проверь даты.', 'external_research'],
    ['Запомни: я предпочитаю короткие ответы', 'memory_remember'],
    ['Запомни: 1. Monarch 0.2.5 ещё не опубликован. 2. Stable остаётся 0.2.4.', 'memory_remember'],
    ['А вместо этого объясни, почему список длинный?', 'explanation'],
  ])('honors an explicit non-material intent shift after the invitation: %s', async (text, kind) => {
    await expect(classifyOscarServerDisposition(text, undefined, {
      history: materialReviewHistory,
    })).resolves.toMatchObject({ kind });
  });

  it.each([
    ['Вот лог:\nopen file C:\\Temp\\state.json', 'chat'],
    ['{"command":"delete","path":"C:\\\\Temp\\\\state.json"}', 'chat'],
    ['Записи восстановлены.', 'chat'],
    ['Oscar выполнил проверку и запустил backend.', 'chat'],
    ['Удалил C:\\Temp\\state.json после проверки.', 'chat'],
    ['1. Deleted C:\\Temp\\legacy.json. 2. Added a replacement API.', 'chat'],
    ['1. Записи восстановлены. 2. Workspace Monarch защищён.', 'chat'],
    ['1. Записи восстановлены. 2. Удали C:\\Temp\\state.json', 'agent'],
    ['Удали C:\\Temp\\state.json. 1. Исправлена маршрутизация. 2. Добавлена история.', 'agent'],
    ['Запусти backend. 1. Исправлена маршрутизация. 2. Добавлена история.', 'agent'],
    ['Проверь этот список обновлений: 1. Исправлена маршрутизация. 2. Добавлена история.', 'chat'],
    ['Review these release notes: 1. Fixed routing. 2. Added history.', 'chat'],
    ['Проверь обновления Monarch 0.2.5.', 'chat'],
    ['Список обновлений: 1. Удали C:\\Temp\\state.json. 2. Запусти backend.', 'chat'],
    ['удалм C:\\Temp\\state.json', 'agent'],
    ['1. Открой C:\\Temp\\state.json 2. Удали первую строку', 'agent'],
    ['В проекте Monarch открой package.json', 'agent'],
  ])('keeps context-free data and real commands separated: %s', (text, mode) => {
    expect(classifyOscarRequestDisposition(text).mode).toBe(mode);
  });
});

describe('affirmative follow-up of a local observation', () => {
  it('lets the selected model understand a yes from history without replaying a phrase script', async () => {
    const classify = vi.fn(async (input: { text: string; history?: unknown }) => ({
      lane: 'agent' as const,
      kind: 'semantic-request',
      confidence: 0.85,
      reason: 'semantic continuation',
    }));
    await expect(classifyOscarServerDisposition('да', { classify }, {
      history: [
        { role: 'user', content: 'какие у меня папки на диске D?' },
        { role: 'assistant', content: 'Чтобы проверить диск D через Kernel, нужно выполнить сканирование. Хочешь, чтобы я это сделал?' },
      ],
    })).resolves.toMatchObject({ lane: 'agent' });
    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ text: 'да', history: expect.any(Array) }));
  });

  it('lets MAX classify a leftover follow-up from conversation history instead of a phrase script', async () => {
    const classify = vi.fn(async (input: { text: string; history?: unknown }) => {
      expect(input.text).toBe('делай');
      expect(input.history).toHaveLength(2);
      return {
        lane: 'agent' as const,
        kind: 'semantic-request',
        confidence: 0.85,
        reason: 'The selected model classified the current user request; execution authority remains with Agent Runtime.',
      };
    });
    await expect(classifyOscarServerDisposition('делай', { classify }, {
      requestedModel: 'max-cloud:deepseek:deepseek-chat',
      history: [
        { role: 'user', content: 'какие есть файлы на диске D с именем или частью в имени Mark?' },
        { role: 'assistant', content: 'Если нужно проверить весь диск D, следующий шаг — выполнить рекурсивный поиск по имени.' },
      ],
    })).resolves.toMatchObject({ lane: 'agent', kind: 'semantic-request' });
    expect(classify).toHaveBeenCalledOnce();
  });

  it('preserves a semantic clarify result without phrase-specific host rewriting', async () => {
    const classify = vi.fn(async () => ({
      lane: 'clarify' as const,
      kind: 'semantic-request',
      confidence: 0.85,
      reason: 'unclear',
    }));
    await expect(classifyOscarServerDisposition('делай', { classify }, {
      requestedModel: 'max-cloud:deepseek:deepseek-chat',
      history: [
        { role: 'user', content: 'какие есть файлы на диске D с именем или частью в имени Mark?' },
        { role: 'assistant', content: 'Если нужно проверить весь диск D, следующий шаг — выполнить рекурсивный поиск по имени.' },
      ],
    })).resolves.toMatchObject({ lane: 'clarify' });
    expect(classify).toHaveBeenCalledOnce();
  });

  it.each([
    ['локал тест', 'a short ambiguous local smoke message'],
    ['max test', 'a short ambiguous MAX smoke message'],
    ['кря', 'nonsense chatter'],
    ['у меня завтра экзамен по C#, помоги подготовиться', 'an ordinary help request'],
  ])('answers instead of stalling when the model asks to clarify an operation the request never names: %s', async (text) => {
    const classify = vi.fn(async () => ({
      lane: 'clarify' as const,
      kind: 'semantic-request',
      confidence: 0.85,
      reason: 'unclear',
    }));
    await expect(classifyOscarServerDisposition(text, { classify }, { history: [] }))
      .resolves.toMatchObject({ lane: 'answer' });
    expect(classify).toHaveBeenCalledOnce();
  });

  it('does not let an old operational message keep clarification alive across later chat', async () => {
    const classify = vi.fn(async () => ({
      lane: 'clarify' as const,
      kind: 'semantic-request',
      confidence: 0.85,
      reason: 'unclear',
    }));
    await expect(classifyOscarServerDisposition('ага', { classify }, {
      history: [
        { role: 'user', content: 'какие есть файлы на диске D?' },
        { role: 'assistant', content: 'Вот список файлов.' },
        { role: 'user', content: 'спасибо' },
        { role: 'assistant', content: 'Пожалуйста!' },
        { role: 'user', content: 'а ты какую музыку любишь' },
        { role: 'assistant', content: 'Люблю всё, что тебе нравится.' },
      ],
    })).resolves.toMatchObject({ lane: 'answer' });
  });
});

describe('ordinary chat uses semantic disposition without activation phrases', () => {
  it('requires the semantic provider even when prose looks like exact file creation', async () => {
    const classify = vi.fn(async () => ({
      lane: 'agent' as const,
      kind: 'semantic-request',
      confidence: 0.91,
      reason: 'The selected model understood an operational request.',
    }));

    await expect(classifyOscarServerDisposition(
      'Создай файл "Новый отчёт.txt" с текстом: "Готово"',
      { classify },
    )).resolves.toMatchObject({ lane: 'agent', kind: 'semantic-request' });
    expect(classify).toHaveBeenCalledOnce();
  });

  it('respects a semantic answer for exact-looking file prose instead of activating an executor', async () => {
    const classify = vi.fn(async () => ({
      lane: 'answer' as const,
      kind: 'semantic-request',
      confidence: 0.94,
      reason: 'The text is quoted material for discussion.',
    }));

    await expect(classifyOscarServerDisposition(
      'Создай файл "Новый отчёт.txt" с текстом: "Готово"',
      { classify },
    )).resolves.toMatchObject({ lane: 'answer', kind: 'semantic-request' });
    expect(classify).toHaveBeenCalledOnce();
  });

  it.each([
    'мне грустно',
    'я устал',
    "I'm sad",
    'скучно',
    'сегодня странный день',
    'давай просто поговорим',
    'ну такое себе настроение сегодня',
    'просто сижу',
    'хм',
    'ахаха',
    'не знаю что сказать',
    'today feels off',
    'I do not know what to say',
  ])('lets the selected model classify ordinary chat: %s', async (text) => {
    const classify = vi.fn(async () => ({
      lane: 'answer' as const,
      kind: 'semantic-request',
      confidence: 0.85,
      reason: 'ordinary chat',
    }));

    await expect(classifyOscarServerDisposition(text, { classify })).resolves.toMatchObject({
      lane: 'answer',
      requiresExternalResearch: false,
    });
    expect(classify).toHaveBeenCalledOnce();
  });

  it.each(['привет', 'ок', 'спасибо', 'пока', 'hello'])('answers small talk without asking the routing model: %s', async (text) => {
    // With an agent-heavy history the routing model sent "привет" to the agent,
    // which then started a task. Small talk only ever excludes execution.
    const classify = vi.fn(async () => ({
      lane: 'agent' as const,
      kind: 'semantic-request',
      confidence: 0.9,
      reason: 'misrouted',
    }));
    await expect(classifyOscarServerDisposition(text, { classify })).resolves.toMatchObject({ lane: 'answer' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('keeps a model failure answer-only when the host has no concrete local target', async () => {
    const classify = vi.fn(async () => {
      throw new Error('oscar-disposition-invalid');
    });

    await expect(classifyOscarServerDisposition('Переложи эти вещи туда, где мы договорились', { classify }))
      .resolves.toMatchObject({ lane: 'answer' });
    expect(classify).toHaveBeenCalledOnce();
  });

  it('still fail-closes a failed classifier when the request already has a local operational target', async () => {
    const classify = vi.fn(async () => {
      throw new Error('oscar-disposition-invalid');
    });

    await expect(classifyOscarServerDisposition('Мне нужен на рабочем столе новый файл', { classify })).resolves.toMatchObject({
      lane: 'clarify',
      reason: 'Structured disposition runtime failed; unresolved intent requires clarification before execution.',
    });
    expect(classify).toHaveBeenCalledOnce();
  });
});

describe('current weather in everyday language', () => {
  it.each(weatherCases.live)('requests public evidence for %s', async text => {
    expect(classifyOscarRequestDisposition(text).requiresExternalResearch).toBe(true);
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({ lane: 'answer', requiresExternalResearch: true });
  });
  it.each(weatherCases.local)('does not send unrelated temperature questions to search: %s', text => {
    expect(classifyOscarRequestDisposition(text).requiresExternalResearch).toBe(false);
  });
});

describe('capability questions stay conversation', () => {
  it.each([
    'ты умеешь создавать файлы?',
    'умеешь ли ты создавать файлы',
    'умеешь читать документы?',
    'are you able to delete files',
  ])('does not spend a model call asking whether Oscar can do something: %s', async text => {
    // "ты умеешь создавать файлы?" asks what Oscar is. Sending it to the
    // classifier cost a model load and came back as an escalation.
    // Asserting the lane alone proves nothing here, because a turn with no
    // provider falls back to answer anyway — the host predicate is the claim.
    expect(isOscarCapabilitiesOrIdentityRequest(text)).toBe(true);
    const provider = { classify: vi.fn(async () => ({ lane: 'agent' as const, kind: 'semantic-request',
      confidence: 0.85, reason: 'fixture', requiresExternalResearch: false })) };
    await expect(classifyOscarServerDisposition(text, provider)).resolves.toMatchObject({ lane: 'answer' });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it.each([
    'умеешь удалить мои файлы на рабочем столе?',
    'создай файл на рабочем столе',
  ])('still treats a named target as something to route: %s', async text => {
    const provider = { classify: vi.fn(async () => ({ lane: 'agent' as const, kind: 'semantic-request',
      confidence: 0.85, reason: 'fixture', requiresExternalResearch: false })) };
    await expect(classifyOscarServerDisposition(text, provider)).resolves.toMatchObject({ lane: 'agent' });
  });
});

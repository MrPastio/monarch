import { describe, expect, it, vi } from 'vitest';
import { classifyOscarRequestDisposition } from '../../src/core';
import { classifyOscarServerDisposition } from '../../src/oscar-turn';
import {
  adversarialMaterialHandoffs,
  exactMonarch025Changelog,
  materialReviewHistory,
} from '../fixtures/oscar/material-handoff';

describe('Oscar contextual request disposition', () => {
  it('routes an explicit file skill operation to Agent Runtime after removing composer metadata', async () => {
    await expect(classifyOscarServerDisposition(
      '$monarch-file-guardian создай на рабочем столе новую папку',
    )).resolves.toMatchObject({
      lane: 'agent',
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
  ])('honors an explicit new operational command after an invitation: %s', async (text) => {
    await expect(classifyOscarServerDisposition(text, undefined, {
      history: materialReviewHistory,
    })).resolves.toMatchObject({ lane: 'agent' });
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
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    'найди упоминания сайта в проекте Monarch',
    'find website references in the current project',
  ])('preserves an explicit local website lookup as an Agent task: %s', async (text) => {
    await expect(classifyOscarServerDisposition(text)).resolves.toMatchObject({
      lane: 'agent',
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

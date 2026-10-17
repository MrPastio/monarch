import { describe, expect, it } from 'vitest';
import { isMemoryOverviewRequest, parseExplicitMemoryCommand, parseForgetMemoryCommand } from '../../src/oscar-turn/disposition';
import { memoryOverviewText, memoryWriteSummary } from '../../src/oscar-turn/coordinator';

describe('Memory 4.1 chat commands', () => {
  it.each([
    ['запомни, что я живу в Варне', 'что я живу в Варне', ''],
    ['Запомни: 1. Monarch 0.2.5 ещё не опубликован. 2. Stable остаётся 0.2.4.', '1. Monarch 0.2.5 ещё не опубликован. 2. Stable остаётся 0.2.4.', ''],
    ['запомни, что я живу в Варне. Какая там погода?', 'что я живу в Варне', 'Какая там погода?'],
    ['Какая завтра погода? И запомни, что я живу в Варне', 'что я живу в Варне', 'Какая завтра погода?'],
    ['я живу в Варне, запомни', 'я живу в Варне', ''],
    ['Я люблю тёмный шоколад — запомни это.', 'Я люблю тёмный шоколад', ''],
    ['remember that I prefer short answers', 'I prefer short answers', ''],
  ])('%s', (text, memory, rest) => {
    expect(parseExplicitMemoryCommand(text)).toEqual({ memory, rest });
  });

  it.each(['ты помнишь, что я говорил?', 'напомни мне завтра позвонить', 'мне запомнилось это место', 'запомнилось, как мы гуляли', 'запомни это'])(
    'is not a memory command: %s', (text) => {
      expect(parseExplicitMemoryCommand(text)).toBeNull();
    });

  it('parses forget commands and leaves conversational ones alone', () => {
    expect(parseForgetMemoryCommand('Забудь, где я живу')).toBe('где я живу');
    expect(parseForgetMemoryCommand('удали из памяти про кота')).toBe('кота');
    expect(parseForgetMemoryCommand('забудь, что я люблю оливки.')).toBe('я люблю оливки');
    for (const text of ['забудь предыдущее сообщение', 'забудь всё', 'забудь, что я сказал', 'забудь']) {
      expect(parseForgetMemoryCommand(text)).toBeNull();
    }
  });

  it('recognises «что ты обо мне знаешь»', () => {
    expect(isMemoryOverviewRequest('Что ты обо мне знаешь?')).toBe(true);
    expect(isMemoryOverviewRequest('а что ты помнишь про меня')).toBe(true);
    expect(isMemoryOverviewRequest('What do you know about me?')).toBe(true);
    expect(isMemoryOverviewRequest('что ты знаешь о Варне?')).toBe(false);
  });

  it('words the receipts plainly', () => {
    expect(memoryWriteSummary({ receiptId: 'r', revision: 1, contentHash: 'x', action: 'unchanged', text: 'Я живу в Варне' }, ''))
      .toBe('Это я уже помню: «Я живу в Варне».');
    expect(memoryWriteSummary({ receiptId: 'r', revision: 1, contentHash: 'x' }, 'что-то важное.')).toBe('Запомнил: «что-то важное».');
    expect(memoryOverviewText([])).toContain('Пока я ничего о тебе не запомнил');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectUiLanguage, normalizeUiLanguage, translateText, UI_LANGUAGES } from '../../src/ui/public/modules/ui-i18n.js';
import { normalizeUiPreferences } from '../../src/ui/public/modules/ui-preferences.js';

const dictionaries = Object.fromEntries(['en', 'uk', 'bg'].map(id =>
  [id, JSON.parse(readFileSync(`src/ui/public/i18n/${id}.json`, 'utf8')) as Record<string, string>]));

describe('interface language', () => {
  it('offers the site languages and follows the system on first launch', () => {
    expect(UI_LANGUAGES.map(item => item.id)).toEqual(['ru', 'uk', 'en', 'bg']);
    expect(detectUiLanguage(['bg-BG', 'en'])).toBe('bg');
    expect(detectUiLanguage(['de-DE'])).toBe('ru');
    expect(normalizeUiLanguage('fr')).toBe('ru');
    expect(normalizeUiPreferences({}).language).toBeNull();
    expect(normalizeUiPreferences({ language: 'uk' }).language).toBe('uk');
  });
  it('translates whole strings only and keeps surrounding whitespace', () => {
    expect(translateText('  Настройки \n', dictionaries.en)).toBe('  Settings \n');
    expect(translateText('Настройки проекта X', dictionaries.en)).toBe('Настройки проекта X');
    expect(translateText('Привет! Я Оскар.', dictionaries.bg)).toBe('Здравей! Аз съм Оскар.');
  });
  it('keeps every dictionary keyed by Russian with the first-setup path covered', () => {
    for (const [id, dictionary] of Object.entries(dictionaries)) {
      for (const [source, target] of Object.entries(dictionary)) {
        expect(source, id).toMatch(/[А-Яа-яЁё]/u);
        expect(target.trim(), `${id}: ${source}`).not.toBe('');
      }
      for (const source of ['Привет! Я Оскар.', 'Поехали', 'Как тебе удобнее?', 'Где будет думать Оскар?', 'Подключим MAX',
        'Всё готово!', 'Начать общение', 'История чатов', 'Новый чат', 'Язык интерфейса']) expect(dictionary[source], `${id}: ${source}`).toBeTruthy();
    }
  });
});

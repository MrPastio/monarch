import { describe, expect, it } from 'vitest';
import { classifyVoiceBrightnessIntent } from '../../src/modules/voice/voice-device-brightness';

describe('voice device brightness', () => {
  it.each([
    ['Поставь яркость на 50 процентов', { operation: 'set', value: '50' }],
    ['Яркость на максимум', { operation: 'set', value: '100' }],
    ['Сделай экран ярче', { operation: 'change', delta: '10' }],
    ['Уменьши яркость на двадцать процентов', { operation: 'change', delta: '-20' }],
  ])('parses the high-confidence action %s', (text, slots) => {
    expect(classifyVoiceBrightnessIntent(text)).toMatchObject({
      kind: 'action',
      slots: { domain: 'brightness', ...slots },
    });
  });

  it.each([
    'Какая сейчас яркость экрана?',
    'Покажи яркость',
    'Яркость?',
  ])('keeps the status query %s read-only', (text) => {
    expect(classifyVoiceBrightnessIntent(text)).toMatchObject({
      kind: 'status',
      slots: { domain: 'brightness', operation: 'get' },
    });
  });

  it.each([
    'Как изменить яркость экрана?',
    'Почему яркость экрана низкая?',
    'Что будет если поставить яркость на максимум?',
  ])('does not mutate for the informational phrase %s', (text) => {
    expect(classifyVoiceBrightnessIntent(text).kind).toBe('none');
  });

  it.each([
    'Установи яркость',
    'Яркость 50 процентов',
    'Не поставь яркость на 50 процентов',
  ])('fails closed for the ambiguous phrase %s', (text) => {
    expect(classifyVoiceBrightnessIntent(text)).toMatchObject({
      kind: 'clarification',
      slots: { domain: 'brightness', intent: 'clarification' },
    });
  });
});

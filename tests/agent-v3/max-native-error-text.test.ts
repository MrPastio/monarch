import { describe, expect, it } from 'vitest';
import { maxNativeErrorText } from '../../src/agent-v3/max-native-contract';

describe('MAX failure text', () => {
  it('does not claim the provider truncated an answer when local budget validation failed', () => {
    expect(maxNativeErrorText('astra-max-native:output-budget')).toContain('Длину ответа');
    expect(maxNativeErrorText('astra-max-native:output-budget')).not.toContain('оборвался');
    expect(maxNativeErrorText('astra-max-native:truncated')).toContain('оборвался');
  });
  it('names an unsupported attached image instead of blaming the key', () => {
    // Live 2026-09-18: a screenshot sent to DeepSeek read as a key problem.
    const text = maxNativeErrorText('astra-max-native:image-model-unavailable');
    expect(text).toContain('Изображения');
    expect(text).not.toContain('ключа');
  });

  it('still reports a model the key cannot use as a key problem', () => {
    expect(maxNativeErrorText('astra-max-native:model-unavailable')).toContain('ключа');
  });

  it('names a lost network instead of sending the person to the MAX settings', () => {
    // Live chaos run: OpenRouter unreachable mid-task read as a settings problem.
    for (const code of ['astra-max-native:unavailable', 'astra-max-native:provider-unavailable', 'provider-unavailable']) {
      expect(maxNativeErrorText(code)).toContain('Нет связи');
      expect(maxNativeErrorText(code)).not.toContain('Настройки');
    }
    expect(maxNativeErrorText('astra-max-native:model-unavailable')).toContain('ключа');
    expect(maxNativeErrorText('astra-max-native:settings-unavailable')).not.toContain('Нет связи');
  });

  it('names a rejected request instead of blaming the connection', () => {
    expect(maxNativeErrorText('astra-max-native:provider-rejected')).toContain('лимита');
    expect(maxNativeErrorText('astra-max-native:provider-request-rejected')).toContain('не принял');
    expect(maxNativeErrorText('astra-max-native:provider-request-rejected')).not.toContain('Настройки');
  });
});

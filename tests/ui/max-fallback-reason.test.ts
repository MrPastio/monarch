import { describe, expect, it } from 'vitest';
import { maxFallbackReason } from '../../src/ui/public/modules/utils.js';

describe('MAX local-fallback note', () => {
  it.each([
    ['astra-max-native:rate-limit', ': у сервиса закончился лимит или баланс'],
    ['astra-max-native:credential-rejected', ': сервис не принял ключ'],
    ['astra-max-native:timeout', ': сервис не ответил вовремя'],
    ['astra-max-native:output-budget', ': запрос или ответ слишком большой'],
    ['astra-max-native:unavailable', ': сервис недоступен'],
    ['astra-max-native:something-new', ''],
    [undefined, ''],
  ])('says why MAX did not answer (%s)', (code, reason) => {
    expect(maxFallbackReason(code)).toBe(reason);
  });
});

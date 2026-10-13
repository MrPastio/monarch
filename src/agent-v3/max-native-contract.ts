import { parseCloudRole, type MaxCloudRole } from './max-cloud-catalog';
import { maxCloudOutputTokens } from './max-cloud-limits';
import { astraMaxModelLimits } from './max-model-limits';

/** Public, credential-free identity shared by the native Turn and main host. */
export const MAX_NATIVE_ROLES = ['max-gpt-oss-120b', 'max-qwen-3.8-27b'] as const;
export type MaxNativeRole = typeof MAX_NATIVE_ROLES[number] | MaxCloudRole;
export function isMaxNativeRole(value: unknown): value is MaxNativeRole {
  return typeof value === 'string' && ((MAX_NATIVE_ROLES as readonly string[]).includes(value) || Boolean(parseCloudRole(value)));
}
export function maxNativeModel(role: MaxNativeRole): string {
  const cloud = parseCloudRole(role); if (cloud) return cloud.model;
  if (!isMaxNativeRole(role)) throw Error('astra-max-native:model');
  return role === 'max-gpt-oss-120b' ? 'openai/gpt-oss-120b' : 'qwen/qwen3.8-27b';
}
/** Exact provider ceiling, including hidden reasoning tokens. */
export function maxNativeChatOutputTokens(role: MaxNativeRole): number {
  if (parseCloudRole(role)) return maxCloudOutputTokens(role);
  if (!isMaxNativeRole(role)) throw Error('astra-max-native:model');
  return astraMaxModelLimits(maxNativeModel(role) as 'openai/gpt-oss-120b' | 'qwen/qwen3.8-27b').maxOutputTokens;
}
export function maxNativeErrorText(code: string): string {
  if (/(?:^|:)busy$/u.test(code)) return 'MAX ещё завершает предыдущие запросы. Подожди немного и попробуй снова.';
  if (/unexpected-tool-call/u.test(code)) return 'Модель MAX попыталась вызвать свой встроенный инструмент вместо ответа. Ответ не принят; повтори запрос или выбери другую модель.';
  if (/response-rejected/u.test(code)) return 'Сервис MAX отказался отвечать на этот запрос (сработал его фильтр). Ответ не принят; можно переформулировать.';
  if (/response-interrupted|response-invalid|provider-finish|provider-response/u.test(code)) return 'Ответ MAX пришёл не полностью или повреждён. Он не принят как результат. Проверь связь и повтори запрос.';
  if (/connection-changed/u.test(code)) return 'Подключение изменилось. Отправь новый запрос с выбранной сейчас моделью.';
  if (/model-retired/u.test(code)) return 'Эта модель больше не поддерживается. Выбери другую в настройках MAX и отправь новый запрос.';
  if (/json-validation-failed|proposal-schema|proposal-json/u.test(code))
    return 'MAX не смог оформить ответ правильно. Попробуй отправить запрос ещё раз.';
  if (/credential|authentication|unauthorized|not-configured|consent-required/u.test(code))
    return 'Открой Настройки → MAX: проверь ключ выбранного сервиса и согласие на отправку данных.';
  if (/rate-limit|quota/u.test(code)) return 'У выбранного сервиса закончился лимит или баланс. Подожди или проверь свой кабинет, затем повтори запрос.';
  // Before the generic model rule: `image-model-unavailable` also contains
  // `model-unavailable`, and an attached screenshot is not a key problem.
  if (/image-model-unavailable/u.test(code)) return 'Изображения в MAX пока не поддерживаются. Выбери локальную модель, которая умеет их читать.';
  if (/model-not|model-unavailable|permission|forbidden/u.test(code)) return 'Эта модель недоступна для твоего ключа. Проверь её в настройках MAX.';
  if (/safety-blocked/u.test(code)) return 'MAX остановился на проверке безопасности. Результаты предыдущих шагов остаются в истории задачи.';
  if (/input-budget|context-too-large/u.test(code)) return 'Материалов слишком много для одного запроса. Сократи сообщение или выбери меньше материалов.';
  if (/vision|image/u.test(code)) return 'MAX не смог безопасно передать изображение. Проверь формат и размер файла, затем повтори запрос.';
  if (/output-budget/u.test(code)) return 'Размер запроса или ответа MAX превысил допустимый предел. Проверь «Длину ответа» в Настройки → MAX.';
  if (/truncated/u.test(code)) return 'MAX заметил, что ответ оборвался на лимите, и не выдал его за завершённый. Сузь задачу или попроси ответ частями.';
  // Groq answers an oversized request (over the key's per-minute token limit) with 413.
  if (/provider-request-rejected/u.test(code)) return 'Сервис MAX не принял этот запрос. Попробуй повторить или переформулировать его.';
  if (/provider-rejected/u.test(code))
    return 'Сервис MAX отклонил запрос — чаще всего он слишком большой для лимита твоего ключа. Сократи запрос или выключи «Интернет» для него и попробуй снова.';
  if (/cancelled|aborted/u.test(code)) return 'Запрос MAX остановлен.';
  if (/timeout/u.test(code)) return 'Сервис не ответил вовремя. Запрос MAX завершён без результата; можно повторить.';
  // A lost network sent people to the MAX settings, which were fine (live
  // chaos run: OpenRouter unreachable mid-task).
  if (/(?:^|:)(?:provider-|transport-)?unavailable$/u.test(code)) return 'Нет связи с сервисом MAX. Проверь интернет и повтори запрос.';
  return 'MAX не смог получить ответ. Проверь подключение в Настройки → MAX и попробуй снова.';
}

export function isExecutableMaxRole(value: unknown): boolean { return value === 'max-gpt-oss-120b' || Boolean(parseCloudRole(value)); }

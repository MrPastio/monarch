export interface TelegramApiValidationFailure {
  ok: false;
  summary: string;
  error: string;
}

export interface TelegramApiCapabilityInput {
  ok: true;
  method: string;
  parameters: Record<string, unknown>;
}

export type TelegramApiCapabilityInputResult = TelegramApiCapabilityInput | TelegramApiValidationFailure;

export interface TelegramApiChatReferenceViolation {
  key: 'chat_id' | 'from_chat_id';
  path: string;
  value: unknown;
}

const TELEGRAM_BOT_API_METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED_TELEGRAM_BOT_API_METHODS = /^(?:getUpdates|setWebhook|deleteWebhook|close|logOut|getManagedBotToken|replaceManagedBotToken)$/i;
const MAX_CHAT_REFERENCE_SCAN_DEPTH = 24;
const MAX_CHAT_REFERENCE_SCAN_NODES = 4_096;
const MAX_TELEGRAM_API_PARAMETERS_CHARS = 12_000;

export function assertTelegramBotApiMethodName(method: string): void {
  if (!TELEGRAM_BOT_API_METHOD_PATTERN.test(method.trim())) {
    throw new Error('Telegram Bot API method name is invalid.');
  }
}

export function assertTelegramBotApiMethodAllowed(method: string): void {
  const result = validateTelegramBotApiMethod(method);
  if (!result.ok) throw new Error(result.summary);
}

export function validateTelegramBotApiMethod(method: string): { ok: true; method: string } | TelegramApiValidationFailure {
  const trimmed = method.trim();
  if (!TELEGRAM_BOT_API_METHOD_PATTERN.test(trimmed)) {
    return {
      ok: false,
      summary: 'Telegram Bot API method name is invalid.',
      error: 'telegram-api-method-invalid',
    };
  }
  if (RESERVED_TELEGRAM_BOT_API_METHODS.test(trimmed)) {
    return {
      ok: false,
      summary: `Telegram Bot API method ${trimmed} is reserved by the local bridge.`,
      error: 'telegram-api-method-reserved',
    };
  }
  return { ok: true, method: trimmed };
}

export function parseTelegramApiCommandParameters(raw: string | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('параметры должны быть валидным JSON-объектом.');
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('параметры должны быть JSON-объектом, не массивом или строкой.');
  }
  const parameterResult = validateTelegramApiParameters(parsed);
  if (!parameterResult.ok) {
    throw new Error(telegramApiCommandParameterError(parameterResult));
  }
  return parsed;
}

export function readTelegramApiCapabilityInput(input: unknown): TelegramApiCapabilityInputResult {
  const record = isPlainRecord(input) ? input : {};
  const method = typeof record.method === 'string' ? record.method.trim() : '';
  const methodResult = validateTelegramBotApiMethod(method);
  if (!methodResult.ok) return methodResult;

  const parameters = record.parameters;
  if (parameters === undefined) return { ok: true, method: methodResult.method, parameters: {} };
  if (!isPlainRecord(parameters)) {
    return {
      ok: false,
      summary: 'Telegram Bot API parameters must be an object.',
      error: 'telegram-api-parameters-invalid',
    };
  }
  const parameterResult = validateTelegramApiParameters(parameters);
  if (!parameterResult.ok) return parameterResult;
  return { ok: true, method: methodResult.method, parameters };
}

function validateTelegramApiParameters(parameters: Record<string, unknown>): { ok: true } | TelegramApiValidationFailure {
  let serialized = '';
  try {
    serialized = JSON.stringify(parameters) || '{}';
  } catch {
    return {
      ok: false,
      summary: 'Telegram Bot API parameters must be JSON-serializable.',
      error: 'telegram-api-parameters-invalid',
    };
  }
  if (serialized.length > MAX_TELEGRAM_API_PARAMETERS_CHARS) {
    return {
      ok: false,
      summary: `Telegram Bot API parameters are too large; maximum ${MAX_TELEGRAM_API_PARAMETERS_CHARS} serialized characters.`,
      error: 'telegram-api-parameters-too-large',
    };
  }
  return { ok: true };
}

function telegramApiCommandParameterError(result: TelegramApiValidationFailure): string {
  if (result.error === 'telegram-api-parameters-too-large') {
    return `параметры слишком большие: максимум ${MAX_TELEGRAM_API_PARAMETERS_CHARS} сериализованных символов.`;
  }
  return result.summary;
}

export function findTelegramApiChatReferenceViolation(
  parameters: Record<string, unknown>,
  allowed: (chatId: number) => boolean
): TelegramApiChatReferenceViolation | null {
  const seen = new WeakSet<object>();
  let scanned = 0;

  const visit = (value: unknown, path: string, depth: number): TelegramApiChatReferenceViolation | null => {
    if (!value || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    scanned += 1;
    if (scanned > MAX_CHAT_REFERENCE_SCAN_NODES || depth > MAX_CHAT_REFERENCE_SCAN_DEPTH) {
      return { key: 'chat_id', path, value: '[too-complex]' };
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const violation = visit(value[index], `${path}[${index}]`, depth + 1);
        if (violation) return violation;
      }
      return null;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (key === 'chat_id' || key === 'from_chat_id') {
        const chatId = readTelegramChatId(child);
        if (chatId === null || !allowed(chatId)) return { key, path: childPath, value: child };
      }
      const violation = visit(child, childPath, depth + 1);
      if (violation) return violation;
    }
    return null;
  };

  return visit(parameters, '', 0);
}

export function telegramApiInputHelp(reason: string): string {
  return [
    `Не понял /api: ${reason}`,
    'Формат: /api METHOD {"parameter":"value"}',
    'Пример: /api getMe',
    'Для методов текущего чата можно не указывать chat_id: Monarch подставит его сам.',
  ].join('\n');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readTelegramChatId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

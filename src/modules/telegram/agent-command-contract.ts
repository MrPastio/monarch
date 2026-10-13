import {
  findTelegramApiChatReferenceViolation,
  readTelegramApiCapabilityInput,
} from './api-guard';

const COMMAND_PREFIX = 'MONARCH_TELEGRAM_COMMAND_V1 ';
const COMMAND_PREAMBLE = 'Выполни точную runtime-owned Telegram-команду через AgentTask и PolicyKernel.';
const MAX_COMMAND_CHARS = 16_000;
const MAX_REMINDER_TEXT_CHARS = 2_000;
const MAX_POLL_QUESTION_CHARS = 300;
const MAX_POLL_OPTIONS = 12;
const MAX_POLL_OPTION_CHARS = 100;

export const TELEGRAM_AGENT_COMMAND_CAPABILITIES = [
  'telegram.capabilities.describe',
  'telegram.reminder.create',
  'telegram.reminder.list',
  'telegram.reminder.cancel',
  'telegram.poll.send',
  'telegram.api.call',
] as const;

export type TelegramAgentCommandCapabilityId = typeof TELEGRAM_AGENT_COMMAND_CAPABILITIES[number];

export interface TelegramAgentCommandV1 {
  version: 1;
  chatId: number;
  capabilityId: TelegramAgentCommandCapabilityId;
  input: Record<string, unknown>;
}

export function telegramAgentCommandIsEffectful(command: TelegramAgentCommandV1): boolean {
  return !['telegram.capabilities.describe', 'telegram.reminder.list'].includes(command.capabilityId);
}

/**
 * Serializes a validated surface-owned command into the immutable user request.
 * The Agent runtime parses and validates the same envelope again before it may
 * classify the action as runtime-owned. Kernel policy and approval still apply.
 */
export function serializeTelegramAgentCommand(
  capabilityId: TelegramAgentCommandCapabilityId,
  input: Record<string, unknown>,
  chatId: number,
): string {
  const command = validateTelegramAgentCommand({ version: 1, chatId, capabilityId, input });
  return `${COMMAND_PREAMBLE}\n${COMMAND_PREFIX}${JSON.stringify(command)}`;
}

export function parseTelegramAgentCommand(value: string): TelegramAgentCommandV1 | null {
  const text = String(value || '');
  if (text.length > MAX_COMMAND_CHARS) return null;
  const marker = text.lastIndexOf(COMMAND_PREFIX);
  if (marker < 0 || text.slice(0, marker).trim() !== COMMAND_PREAMBLE) return null;
  try {
    return validateTelegramAgentCommand(JSON.parse(text.slice(marker + COMMAND_PREFIX.length)));
  } catch {
    return null;
  }
}

function validateTelegramAgentCommand(value: unknown): TelegramAgentCommandV1 {
  const record = plainRecord(value);
  if (!record || !exactKeys(record, ['version', 'chatId', 'capabilityId', 'input']) || record.version !== 1) {
    throw new Error('Invalid Telegram Agent command envelope.');
  }
  const capabilityId = String(record.capabilityId || '') as TelegramAgentCommandCapabilityId;
  if (!(TELEGRAM_AGENT_COMMAND_CAPABILITIES as readonly string[]).includes(capabilityId)) {
    throw new Error('Unsupported Telegram Agent command capability.');
  }
  const rawInput = plainRecord(record.input);
  if (!rawInput) throw new Error('Telegram Agent command input must be an object.');
  const input = structuredClone(rawInput);
  const chatId = readChatId(record.chatId);
  if (chatId === null) throw new Error('Telegram Agent command has no exact chat binding.');
  validateCapabilityInput(capabilityId, input, chatId);
  const command = { version: 1 as const, chatId, capabilityId, input };
  if (JSON.stringify(command).length > MAX_COMMAND_CHARS - COMMAND_PREFIX.length - COMMAND_PREAMBLE.length) {
    throw new Error('Telegram Agent command is too large.');
  }
  return command;
}

function validateCapabilityInput(
  capabilityId: TelegramAgentCommandCapabilityId,
  input: Record<string, unknown>,
  bindingChatId: number,
): void {
  if (capabilityId === 'telegram.capabilities.describe') {
    if (!exactKeys(input, ['topic']) || !['security', 'capabilities'].includes(String(input.topic || ''))) {
      throw new Error('Invalid Telegram capability topic.');
    }
    return;
  }
  const chatId = readChatId(input.chatId);
  if (capabilityId === 'telegram.reminder.list') {
    if (!exactKeys(input, ['chatId']) || chatId !== bindingChatId) throw new Error('Invalid Telegram reminder-list command.');
    return;
  }
  if (capabilityId === 'telegram.reminder.create') {
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const dueAt = typeof input.dueAt === 'string' ? input.dueAt : '';
    if (!exactKeys(input, ['chatId', 'text', 'dueAt']) || chatId !== bindingChatId || !text
      || text.length > MAX_REMINDER_TEXT_CHARS || !Number.isFinite(Date.parse(dueAt))) {
      throw new Error('Invalid Telegram reminder-create command.');
    }
    input.text = text;
    input.dueAt = new Date(dueAt).toISOString();
    return;
  }
  if (capabilityId === 'telegram.reminder.cancel') {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!exactKeys(input, ['id', 'chatId']) || chatId !== bindingChatId || !id || id.length > 128) {
      throw new Error('Invalid Telegram reminder-cancel command.');
    }
    input.id = id;
    return;
  }
  if (capabilityId === 'telegram.poll.send') {
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    const options = Array.isArray(input.options)
      ? input.options.map((entry) => typeof entry === 'string' ? entry.trim() : '')
      : [];
    if (!exactKeys(input, ['chatId', 'question', 'options', 'multiple']) || chatId !== bindingChatId
      || !question || question.length > MAX_POLL_QUESTION_CHARS || options.length < 1
      || options.length > MAX_POLL_OPTIONS || options.some((entry) => !entry || entry.length > MAX_POLL_OPTION_CHARS)
      || typeof input.multiple !== 'boolean') {
      throw new Error('Invalid Telegram poll command.');
    }
    input.question = question;
    input.options = options;
    return;
  }
  const api = readTelegramApiCapabilityInput(input);
  if (!api.ok || !exactKeys(input, ['method', 'parameters'])) throw new Error(api.ok ? 'Invalid Telegram API command.' : api.summary);
  const violation = findTelegramApiChatReferenceViolation(api.parameters, (candidate) => candidate === bindingChatId);
  if (violation) throw new Error('Telegram API command references another chat.');
  input.method = api.method;
  input.parameters = structuredClone(api.parameters);
}

function readChatId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0 ? value : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

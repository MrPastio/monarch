import { describe, expect, it } from 'vitest';
import {
  parseTelegramAgentCommand,
  serializeTelegramAgentCommand,
} from '../../src/modules/telegram/agent-command-contract';

describe('Telegram Agent command contract', () => {
  it('round-trips one exact paired-chat command', () => {
    const encoded = serializeTelegramAgentCommand('telegram.reminder.list', { chatId: -10042 }, -10042);
    expect(parseTelegramAgentCommand(encoded)).toEqual({
      version: 1,
      chatId: -10042,
      capabilityId: 'telegram.reminder.list',
      input: { chatId: -10042 },
    });
  });

  it('rejects a tampered input chat binding', () => {
    const encoded = serializeTelegramAgentCommand('telegram.reminder.list', { chatId: 42 }, 42);
    expect(parseTelegramAgentCommand(encoded.replace('"input":{"chatId":42}', '"input":{"chatId":7}'))).toBeNull();
  });

  it('rejects cross-chat Bot API parameters and reserved polling methods', () => {
    expect(() => serializeTelegramAgentCommand('telegram.api.call', {
      method: 'sendMessage',
      parameters: { chat_id: 7, text: 'wrong target' },
    }, 42)).toThrow('another chat');
    expect(() => serializeTelegramAgentCommand('telegram.api.call', {
      method: 'getUpdates',
      parameters: {},
    }, 42)).toThrow('reserved');
  });

  it('rejects poll option objects instead of silently coercing them', () => {
    expect(() => serializeTelegramAgentCommand('telegram.poll.send', {
      chatId: 42,
      question: 'Ready?',
      options: [{ text: 'yes' }],
      multiple: false,
    }, 42)).toThrow('Invalid Telegram poll command');
  });
});

import { describe, expect, it } from 'vitest';
import { parseWakeInvocation } from '../../src/ui/public/modules/voice-wake-service.js';

describe('background Voice wake phrase parser', () => {
  it.each(['Оскар', 'Oscar!', 'эй, Оскар', 'Ооскаар'])('accepts bounded wake-only variant %s', (text) => {
    expect(parseWakeInvocation(text)).toMatchObject({ matched: true, wakeOnly: true, command: '' });
  });

  it('preserves a command spoken in the same utterance', () => {
    expect(parseWakeInvocation('Оскар, открой музыку')).toEqual({
      matched: true,
      wakeOnly: false,
      command: 'открой музыку',
    });
  });

  it('does not activate on ordinary speech containing a similar name later', () => {
    expect(parseWakeInvocation('расскажи про Оскара')).toEqual({ matched: false, wakeOnly: false, command: '' });
  });
});

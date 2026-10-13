import { describe, expect, it } from 'vitest';
import { resolvePendingVoiceChoiceText } from '../../src/ui/public/modules/oscar-voice-mode.js';

const choices = ['Apple Music', 'YouTube Music', 'Медиаплеер'];

describe('Simplified Voice ambiguous target follow-up', () => {
  it('maps a spoken ordinal to the exact bounded candidate', () => {
    expect(resolvePendingVoiceChoiceText('второй', choices)).toBe('открой YouTube Music');
  });

  it('lets the adaptive Windows resolver interpret a phonetic product reply', () => {
    expect(resolvePendingVoiceChoiceText('ютуб мьюзик', choices)).toBe('открой ютуб мьюзик');
  });

  it('preserves a new complete command instead of forcing the stale choice', () => {
    expect(resolvePendingVoiceChoiceText('открой калькулятор', choices)).toBe('открой калькулятор');
  });

  it('allows the user to cancel the choice without executing anything', () => {
    expect(resolvePendingVoiceChoiceText('не надо', choices)).toBe('');
  });
});

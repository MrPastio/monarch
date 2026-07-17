import { describe, expect, it } from 'vitest';
import {
  createVoiceThinkingPhrasePicker,
  VOICE_THINKING_PHRASES,
} from '../../src/ui/public/modules/voice-mode-phrases.js';

describe('voice thinking phrases', () => {
  it('provides one hundred unique short spoken phrases', () => {
    expect(VOICE_THINKING_PHRASES).toHaveLength(100);
    expect(new Set(VOICE_THINKING_PHRASES).size).toBe(100);
    expect(Math.max(...VOICE_THINKING_PHRASES.map((phrase) => phrase.length))).toBeLessThan(80);
  });

  it('does not repeat a recent phrase', () => {
    const pick = createVoiceThinkingPhrasePicker({ random: () => 0, historySize: 18 });
    const sample = Array.from({ length: 19 }, () => pick());

    expect(new Set(sample).size).toBe(19);
  });
});

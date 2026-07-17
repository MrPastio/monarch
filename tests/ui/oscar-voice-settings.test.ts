import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OSCAR_VOICE_PREFERENCES,
  OSCAR_VOICE_STORAGE_KEY,
  normalizeOscarVoicePreferences,
  readOscarVoicePreferences,
  saveOscarVoicePreferences,
} from '../../src/ui/public/modules/oscar-voice-settings.js';

describe('Oscar voice preferences', () => {
  it('normalizes supported voice controls and bounds the custom instruction', () => {
    expect(normalizeOscarVoicePreferences({
      voice: 'aurora',
      style: 'warm',
      speed: 117.7,
      pitch: -7,
      expressiveness: 88,
      pauseMs: 999,
      volume: 72,
      instruction: `  мягко\u0000 ${'x'.repeat(400)}  `,
    })).toEqual({
      voice: 'aurora',
      style: 'warm',
      speed: 118,
      pitch: -2,
      expressiveness: 88,
      pauseMs: 400,
      volume: 72,
      instruction: expect.stringMatching(/^мягко /),
    });
    expect(normalizeOscarVoicePreferences({ voice: '../other.wav', style: 'unknown', pace: 'warp' }))
      .toEqual(DEFAULT_OSCAR_VOICE_PREFERENCES);
  });

  it('persists settings as one local-only JSON record', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => store.get(key) || null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    };

    saveOscarVoicePreferences({
      voice: 'oscar-clear',
      style: 'focused',
      speed: 91,
      pitch: 1,
      expressiveness: 34,
      pauseMs: 140,
      volume: 82,
    }, storage);

    expect(storage.setItem).toHaveBeenCalledWith(OSCAR_VOICE_STORAGE_KEY, expect.any(String));
    expect(readOscarVoicePreferences(storage)).toEqual({
      voice: 'oscar-clear',
      style: 'focused',
      speed: 91,
      pitch: 1,
      expressiveness: 34,
      pauseMs: 140,
      volume: 82,
      instruction: '',
    });
  });
});

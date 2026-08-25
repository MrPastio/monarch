import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OSCAR_VOICE_PREFERENCES,
  OSCAR_VOICE_STORAGE_KEY,
  applyVoiceRuntimeCapabilities,
  applyVoiceSettingsSnapshot,
  isVoicePronunciationControlAvailable,
  normalizeOscarVoicePreferences,
  readOscarVoicePreferences,
  readVoiceInputPreferences,
  readVoiceSettingsSnapshot,
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
      activePresetId: null,
    });
    expect(normalizeOscarVoicePreferences({ voice: '../other.wav', style: 'unknown', pace: 'warp' }))
      .toEqual(DEFAULT_OSCAR_VOICE_PREFERENCES);
  });

  it('keeps a one-release read-only localStorage migration adapter', () => {
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
      activePresetId: null,
    });
  });

  it('uses the durable read-back snapshot and hides unsupported free-form instruction', () => {
    applyVoiceSettingsSnapshot({
      revision: 4,
      value: {
        schemaVersion: 2,
        preferences: { ...DEFAULT_OSCAR_VOICE_PREFERENCES, instruction: 'говори шёпотом' },
        presets: [],
        pronunciations: [{
          schemaVersion: 1,
          id: 'pronunciation-1',
          word: 'замок',
          pronunciation: 'за́мок',
          context: 'старый замок',
          enabled: true,
        }],
        input: { schemaVersion: 1, autoSendAfterDictation: true },
      },
    });
    applyVoiceRuntimeCapabilities({
      schemaVersion: 1,
      platform: 'win32',
      primaryEngine: 'qwen3-tts-0.6b-base',
      neuralInstalled: true,
      modelVariant: 'base',
      instructionControlled: false,
      stressAnalyzer: 'silero-stress-1.4',
      stressAccentor: 'unavailable',
      pronunciationControl: 'unavailable',
      pronunciationDiagnostic: 'qwen-base-stress-markup-unsupported',
      controls: {
        speed: 'dsp', pitch: 'dsp', volume: 'audio-gain', pause: 'audio-pipeline',
        expressiveness: 'generation-parameters', freeFormInstruction: false,
      },
    });

    expect(readVoiceSettingsSnapshot()).toMatchObject({
      revision: 4,
      ready: true,
      value: { pronunciations: [expect.objectContaining({ pronunciation: 'за́мок' })] },
    });
    expect(readVoiceInputPreferences().autoSendAfterDictation).toBe(true);
    expect(isVoicePronunciationControlAvailable()).toBe(false);
    expect(readOscarVoicePreferences()).toMatchObject({
      voice: 'oscar',
      instruction: '',
      pronunciations: [],
    });
  });
});

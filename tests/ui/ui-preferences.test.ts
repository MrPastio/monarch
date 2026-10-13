import { describe, expect, it } from 'vitest';
import {
  MASCOT_PREFERENCE_VERSION,
  normalizeUiPreferences,
  serializeUiPreferences,
} from '../../src/ui/public/modules/ui-preferences.js';

describe('Monarch UI preferences', () => {
  it('restores the mascot for profiles written by the former default-hidden build', () => {
    expect(normalizeUiPreferences({ inspector: 'closed', mascotVisible: false })).toEqual({
      design: 'pp',
      theme: 'light',
      autoTheme: 'system',
      density: 'comfortable',
      inspector: 'open',
      reasoningEffort: 'auto',
      motion: 'system',
      language: null,
    });
  });

  it('keeps an explicit hide after the visibility migration has been applied', () => {
    expect(normalizeUiPreferences({
      mascotPreferenceVersion: MASCOT_PREFERENCE_VERSION,
      mascotVisible: false,
      density: 'compact',
    })).toEqual({ design: 'pp', theme: 'light', autoTheme: 'system', density: 'compact', inspector: 'closed', reasoningEffort: 'auto', motion: 'system', language: null });
  });

  it('persists the migration marker with the current user choice', () => {
    expect(serializeUiPreferences({ density: 'comfortable', inspector: 'open' })).toEqual({
      density: 'comfortable',
      inspector: 'open',
      mascotVisible: true,
      mascotPreferenceVersion: MASCOT_PREFERENCE_VERSION,
    });
  });

  it('keeps a valid reasoning depth and drops an unknown one', () => {
    expect(normalizeUiPreferences({ reasoningEffort: 'high' })).toMatchObject({ reasoningEffort: 'high' });
    expect(normalizeUiPreferences({ reasoningEffort: 'extreme' })).toMatchObject({ reasoningEffort: 'auto' });
  });

  it('defaults to the PaperPixel design and keeps an explicit return to the classic one', () => {
    expect(normalizeUiPreferences({})).toMatchObject({ design: 'pp' });
    expect(normalizeUiPreferences({ design: 'classic' })).toMatchObject({ design: 'classic' });
    expect(normalizeUiPreferences({ design: 'neon' })).toMatchObject({ design: 'pp' });
    expect(serializeUiPreferences(normalizeUiPreferences({ design: 'classic' }))).toMatchObject({ design: 'classic' });
  });
});

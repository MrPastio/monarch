import { describe, expect, it } from 'vitest';
import {
  MASCOT_PREFERENCE_VERSION,
  normalizeUiPreferences,
  serializeUiPreferences,
} from '../../src/ui/public/modules/ui-preferences.js';

describe('Monarch UI preferences', () => {
  it('restores the mascot for profiles written by the former default-hidden build', () => {
    expect(normalizeUiPreferences({ inspector: 'closed', mascotVisible: false })).toEqual({
      density: 'comfortable',
      inspector: 'open',
      contextMeterVisible: true,
    });
  });

  it('keeps an explicit hide after the visibility migration has been applied', () => {
    expect(normalizeUiPreferences({
      mascotPreferenceVersion: MASCOT_PREFERENCE_VERSION,
      mascotVisible: false,
      density: 'compact',
    })).toEqual({ density: 'compact', inspector: 'closed', contextMeterVisible: true });
  });

  it('persists the migration marker with the current user choice', () => {
    expect(serializeUiPreferences({ density: 'comfortable', inspector: 'open' })).toEqual({
      density: 'comfortable',
      inspector: 'open',
      mascotVisible: true,
      mascotPreferenceVersion: MASCOT_PREFERENCE_VERSION,
      contextMeterVisible: true,
    });
  });

  it('keeps an explicit context meter visibility choice', () => {
    expect(normalizeUiPreferences({ contextMeterVisible: false })).toMatchObject({
      contextMeterVisible: false,
    });
    expect(serializeUiPreferences({ density: 'comfortable', inspector: 'open', contextMeterVisible: false }))
      .toMatchObject({ contextMeterVisible: false });
  });
});

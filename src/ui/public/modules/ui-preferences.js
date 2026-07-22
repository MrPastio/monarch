export const MASCOT_PREFERENCE_VERSION = 1;

export function normalizeUiPreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasCurrentMascotPreference = Number(source.mascotPreferenceVersion) >= MASCOT_PREFERENCE_VERSION
    && typeof source.mascotVisible === 'boolean';
  const mascotVisible = hasCurrentMascotPreference ? source.mascotVisible : true;
  return {
    density: ['comfortable', 'compact'].includes(source.density) ? source.density : 'comfortable',
    inspector: mascotVisible ? 'open' : 'closed',
  };
}

export function serializeUiPreferences(preferences) {
  return {
    ...preferences,
    mascotVisible: preferences?.inspector !== 'closed',
    mascotPreferenceVersion: MASCOT_PREFERENCE_VERSION,
  };
}

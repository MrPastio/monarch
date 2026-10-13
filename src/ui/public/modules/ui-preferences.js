export const MASCOT_PREFERENCE_VERSION = 1;

export function normalizeUiPreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasCurrentMascotPreference = Number(source.mascotPreferenceVersion) >= MASCOT_PREFERENCE_VERSION
    && typeof source.mascotVisible === 'boolean';
  const mascotVisible = hasCurrentMascotPreference ? source.mascotVisible : true;
  return {
    // PaperPixel is the default design; "classic" is the earlier warm glass one.
    design: source.design === 'classic' ? 'classic' : 'pp',
    theme: ['dark', 'light', 'auto'].includes(source.theme) ? source.theme : 'light',
    autoTheme: source.autoTheme === 'time' ? 'time' : 'system',
    density: ['comfortable', 'compact'].includes(source.density) ? source.density : 'comfortable',
    inspector: mascotVisible ? 'open' : 'closed',
    reasoningEffort: ['auto', 'low', 'medium', 'high'].includes(source.reasoningEffort) ? source.reasoningEffort : 'auto',
    motion: source.motion === 'reduced' ? 'reduced' : 'system',
    // null until chosen: first launch follows the system language.
    language: ['ru', 'uk', 'en', 'bg'].includes(source.language) ? source.language : null,
  };
}

export function serializeUiPreferences(preferences) {
  return {
    ...preferences,
    mascotVisible: preferences?.inspector !== 'closed',
    mascotPreferenceVersion: MASCOT_PREFERENCE_VERSION,
  };
}

/** Daytime for the "by time of day" auto theme: light from 07:00, dark from 20:00. */
export const AUTO_THEME_DAY = Object.freeze({ start: 7, end: 20 });

/** The theme actually painted. "auto" follows Windows (system) or the clock. */
export function resolveTheme(preferences, { now = new Date(), systemDark = false } = {}) {
  if (preferences?.theme === 'dark' || preferences?.theme === 'light') return preferences.theme;
  if (preferences?.autoTheme === 'time') {
    const hour = now.getHours();
    return hour >= AUTO_THEME_DAY.start && hour < AUTO_THEME_DAY.end ? 'light' : 'dark';
  }
  return systemDark ? 'dark' : 'light';
}

/** Milliseconds until the clock theme next flips (07:00 or 20:00). */
export function msUntilThemeBoundary(now = new Date()) {
  const next = new Date(now);
  const hour = now.getHours();
  if (hour < AUTO_THEME_DAY.start) next.setHours(AUTO_THEME_DAY.start, 0, 0, 0);
  else if (hour < AUTO_THEME_DAY.end) next.setHours(AUTO_THEME_DAY.end, 0, 0, 0);
  else { next.setDate(next.getDate() + 1); next.setHours(AUTO_THEME_DAY.start, 0, 0, 0); }
  return Math.max(1_000, next.getTime() - now.getTime());
}

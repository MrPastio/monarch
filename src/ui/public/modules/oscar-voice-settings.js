export const OSCAR_VOICE_STORAGE_KEY = 'monarch.oscar.voice.preferences';

export const OSCAR_VOICE_PRESETS = Object.freeze({
  oscar: Object.freeze({ label: 'Оскар · баритон', description: 'Низкий, спокойный и уверенный' }),
  'oscar-clear': Object.freeze({ label: 'Оскар · ясный', description: 'Моложе, легче и отчётливее' }),
  aurora: Object.freeze({ label: 'Аврора · тёплый', description: 'Мягкий женский тембр' }),
});

export const OSCAR_VOICE_STYLES = Object.freeze({
  natural: 'Естественно',
  calm: 'Спокойно',
  warm: 'Теплее',
  focused: 'Собранно',
  energetic: 'Энергично',
});

export const DEFAULT_OSCAR_VOICE_PREFERENCES = Object.freeze({
  voice: 'oscar',
  style: 'natural',
  speed: 100,
  pitch: 0,
  expressiveness: 55,
  pauseMs: 80,
  volume: 100,
  instruction: '',
});

export function normalizeOscarVoicePreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legacySpeed = input.pace === 'slow' ? 90 : input.pace === 'fast' ? 112 : 100;
  return {
    voice: Object.hasOwn(OSCAR_VOICE_PRESETS, input.voice) ? input.voice : DEFAULT_OSCAR_VOICE_PREFERENCES.voice,
    style: Object.hasOwn(OSCAR_VOICE_STYLES, input.style) ? input.style : DEFAULT_OSCAR_VOICE_PREFERENCES.style,
    speed: boundedInteger(input.speed, 80, 120, legacySpeed),
    pitch: boundedInteger(input.pitch, -2, 2, DEFAULT_OSCAR_VOICE_PREFERENCES.pitch),
    expressiveness: boundedInteger(input.expressiveness, 0, 100, DEFAULT_OSCAR_VOICE_PREFERENCES.expressiveness),
    pauseMs: boundedInteger(input.pauseMs, 40, 400, DEFAULT_OSCAR_VOICE_PREFERENCES.pauseMs),
    volume: boundedInteger(input.volume, 20, 100, DEFAULT_OSCAR_VOICE_PREFERENCES.volume),
    instruction: String(input.instruction || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, 300),
  };
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

export function readOscarVoicePreferences(storage = globalThis.localStorage) {
  try {
    return normalizeOscarVoicePreferences(JSON.parse(storage?.getItem?.(OSCAR_VOICE_STORAGE_KEY) || '{}'));
  } catch {
    return { ...DEFAULT_OSCAR_VOICE_PREFERENCES };
  }
}

export function saveOscarVoicePreferences(value, storage = globalThis.localStorage) {
  const normalized = normalizeOscarVoicePreferences(value);
  try {
    storage?.setItem?.(OSCAR_VOICE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Voice preferences are optional; local storage must never prevent Monarch from booting.
  }
  return normalized;
}

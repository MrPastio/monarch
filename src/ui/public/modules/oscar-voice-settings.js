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
  activePresetId: null,
});

export const DEFAULT_VOICE_INPUT_PREFERENCES = Object.freeze({
  schemaVersion: 1,
  autoSendAfterDictation: false,
});

export const DEFAULT_VOICE_RUNTIME_CAPABILITIES = Object.freeze({
  schemaVersion: 1,
  platform: 'browser',
  primaryEngine: 'unavailable',
  neuralInstalled: false,
  modelVariant: 'none',
  instructionControlled: false,
  stressAnalyzer: 'unavailable',
  stressAccentor: 'unavailable',
  pronunciationControl: 'unavailable',
  pronunciationDiagnostic: 'voice-engine-unavailable',
  controls: Object.freeze({
    speed: 'unavailable',
    pitch: 'unavailable',
    volume: 'system',
    pause: 'unavailable',
    expressiveness: 'unavailable',
    freeFormInstruction: false,
  }),
});

let voiceSettingsRevision = 0;
let voiceSettingsReady = false;
let voiceSettingsDocument = normalizeVoicePreferencesDocument(null);
let voiceRuntimeCapabilities = { ...DEFAULT_VOICE_RUNTIME_CAPABILITIES, controls: { ...DEFAULT_VOICE_RUNTIME_CAPABILITIES.controls } };

export function normalizeOscarVoicePreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const legacySpeed = input.pace === 'slow' ? 90 : input.pace === 'fast' ? 112 : 100;
  const activePresetId = cleanString(input.activePresetId, 256) || null;
  return {
    voice: Object.hasOwn(OSCAR_VOICE_PRESETS, input.voice) ? input.voice : DEFAULT_OSCAR_VOICE_PREFERENCES.voice,
    style: Object.hasOwn(OSCAR_VOICE_STYLES, input.style) ? input.style : DEFAULT_OSCAR_VOICE_PREFERENCES.style,
    speed: boundedInteger(input.speed, 80, 120, legacySpeed),
    pitch: boundedInteger(input.pitch, -2, 2, DEFAULT_OSCAR_VOICE_PREFERENCES.pitch),
    expressiveness: boundedInteger(input.expressiveness, 0, 100, DEFAULT_OSCAR_VOICE_PREFERENCES.expressiveness),
    pauseMs: boundedInteger(input.pauseMs, 40, 400, DEFAULT_OSCAR_VOICE_PREFERENCES.pauseMs),
    volume: boundedInteger(input.volume, 20, 100, DEFAULT_OSCAR_VOICE_PREFERENCES.volume),
    instruction: cleanString(input.instruction, 300),
    activePresetId,
  };
}

export function normalizeVoicePreferencesDocument(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const presets = (Array.isArray(input.presets) ? input.presets : []).map(normalizeVoicePreset).filter(Boolean).slice(0, 24);
  const presetIds = new Set(presets.map((preset) => preset.id));
  const preferences = normalizeOscarVoicePreferences(input.preferences);
  if (!presetIds.has(preferences.activePresetId)) preferences.activePresetId = null;
  return {
    schemaVersion: 2,
    preferences,
    presets,
    pronunciations: (Array.isArray(input.pronunciations) ? input.pronunciations : [])
      .map(normalizePronunciationRule).filter(Boolean).slice(0, 128),
    input: normalizeVoiceInputPreferences(input.input),
    createdAt: cleanString(input.createdAt, 80),
    updatedAt: cleanString(input.updatedAt, 80),
  };
}

export function normalizeVoiceRuntimeCapabilities(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const controls = input.controls && typeof input.controls === 'object' && !Array.isArray(input.controls)
    ? input.controls
    : {};
  return {
    schemaVersion: 1,
    platform: cleanString(input.platform, 40) || DEFAULT_VOICE_RUNTIME_CAPABILITIES.platform,
    primaryEngine: ['qwen3-tts-0.6b-base', 'windows-sapi', 'unavailable'].includes(input.primaryEngine)
      ? input.primaryEngine
      : 'unavailable',
    neuralInstalled: input.neuralInstalled === true,
    modelVariant: ['base', 'custom-voice', 'voice-design', 'none'].includes(input.modelVariant)
      ? input.modelVariant
      : 'none',
    instructionControlled: input.instructionControlled === true,
    stressAnalyzer: input.stressAnalyzer === 'silero-stress-1.4' ? input.stressAnalyzer : 'unavailable',
    stressAccentor: input.stressAccentor === 'silero-stress-1.4' ? input.stressAccentor : 'unavailable',
    pronunciationControl: input.pronunciationControl === 'engine-native' ? 'engine-native' : 'unavailable',
    pronunciationDiagnostic: input.pronunciationDiagnostic === 'qwen-base-stress-markup-unsupported'
      ? input.pronunciationDiagnostic
      : 'voice-engine-unavailable',
    controls: {
      speed: controls.speed === 'dsp' ? 'dsp' : 'unavailable',
      pitch: controls.pitch === 'dsp' ? 'dsp' : 'unavailable',
      volume: controls.volume === 'audio-gain' || controls.volume === 'system' ? controls.volume : 'unavailable',
      pause: controls.pause === 'audio-pipeline' ? controls.pause : 'unavailable',
      expressiveness: controls.expressiveness === 'generation-parameters' ? controls.expressiveness : 'unavailable',
      freeFormInstruction: input.instructionControlled === true && controls.freeFormInstruction === true,
    },
  };
}

export function applyVoiceSettingsSnapshot(context) {
  voiceSettingsRevision = Math.max(0, Number(context?.revision) || 0);
  voiceSettingsDocument = normalizeVoicePreferencesDocument(context?.value);
  voiceSettingsReady = true;
  return readVoiceSettingsSnapshot();
}

export function applyVoiceRuntimeCapabilities(value) {
  voiceRuntimeCapabilities = normalizeVoiceRuntimeCapabilities(value);
  return readVoiceRuntimeCapabilities();
}

export function readVoiceSettingsSnapshot() {
  return {
    revision: voiceSettingsRevision,
    ready: voiceSettingsReady,
    value: structuredCloneSafe(voiceSettingsDocument),
  };
}

export function readVoiceRuntimeCapabilities() {
  return structuredCloneSafe(voiceRuntimeCapabilities);
}

export function isVoicePronunciationControlAvailable(value = voiceRuntimeCapabilities) {
  return normalizeVoiceRuntimeCapabilities(value).pronunciationControl === 'engine-native';
}

export function readVoiceInputPreferences() {
  return { ...voiceSettingsDocument.input };
}

export function readOscarVoicePreferences(storage) {
  if (storage) return readLegacyOscarVoicePreferences(storage);
  const tuning = normalizeOscarVoicePreferences(voiceSettingsDocument.preferences);
  return {
    ...tuning,
    instruction: voiceRuntimeCapabilities.controls.freeFormInstruction ? tuning.instruction : '',
    pronunciations: isVoicePronunciationControlAvailable()
      ? voiceSettingsDocument.pronunciations.map((rule) => ({ ...rule }))
      : [],
  };
}

export function readLegacyOscarVoicePreferences(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(OSCAR_VOICE_STORAGE_KEY) || '';
    return raw ? normalizeOscarVoicePreferences(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

// Compatibility adapter for tests and one-release migration tooling only.
// Production settings never call this function and never write localStorage.
export function saveOscarVoicePreferences(value, storage) {
  const normalized = normalizeOscarVoicePreferences(value);
  if (storage) storage.setItem?.(OSCAR_VOICE_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

function normalizeVoicePreset(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = cleanString(input.id, 256);
  const name = cleanString(input.name, 80);
  if (!id || !name) return null;
  const preferences = normalizeOscarVoicePreferences(input.preferences);
  delete preferences.activePresetId;
  return {
    schemaVersion: 2,
    id,
    name,
    preferences,
    createdAt: cleanString(input.createdAt, 80),
    updatedAt: cleanString(input.updatedAt, 80),
  };
}

function normalizePronunciationRule(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = cleanString(input.id, 256);
  const word = cleanString(input.word, 80);
  const pronunciation = cleanString(input.pronunciation, 100);
  if (!id || !word || !pronunciation) return null;
  return {
    schemaVersion: 1,
    id,
    word,
    pronunciation,
    context: cleanString(input.context, 240),
    enabled: input.enabled !== false,
    createdAt: cleanString(input.createdAt, 80),
    updatedAt: cleanString(input.updatedAt, 80),
  };
}

function normalizeVoiceInputPreferences(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { schemaVersion: 1, autoSendAfterDictation: input.autoSendAfterDictation === true };
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function cleanString(value, maximum) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim().slice(0, maximum);
}

function structuredCloneSafe(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

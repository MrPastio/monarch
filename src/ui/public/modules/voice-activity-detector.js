export const VOICE_ACTIVITY_DEFAULTS = Object.freeze({
  initialNoiseFloor: 0.006,
  calibrationMs: 420,
  startupGuardMs: 160,
  onsetFrames: 3,
  startThresholdMultiplier: 2.7,
  startThresholdMargin: 0.008,
  minimumStartLevel: 0.022,
  releaseThresholdMultiplier: 1.65,
  releaseThresholdMargin: 0.004,
  minimumReleaseLevel: 0.012,
  minSpeechMs: 320,
  endSilenceMs: 650,
  minimumEndSilenceMs: 500,
  noSpeechMs: 8_000,
  maxSpeechMs: 15_000,
});

const EVENT_TYPES = new Set(['none', 'speech-start', 'speech-end', 'no-speech', 'max-duration']);

export function createAdaptiveVoiceActivityDetector(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : () => performance.now();
  const config = normalizeConfig(options);
  let state;

  reset(options.startedAtMs);

  return Object.freeze({
    push,
    reset,
    snapshot,
  });

  function reset(atMs = clock()) {
    const startedAtMs = normalizeTime(atMs, 0);
    state = {
      phase: 'waiting',
      startedAtMs,
      lastAtMs: startedAtMs,
      noiseFloor: config.initialNoiseFloor,
      onsetFrames: 0,
      firstOnsetAtMs: null,
      speechStartedAtMs: null,
      lastVoiceAtMs: null,
      terminalEvent: '',
    };
    return snapshot();
  }

  function push(sample = {}) {
    const atMs = Math.max(state.lastAtMs, normalizeTime(sample.atMs, clock()));
    state.lastAtMs = atMs;
    const rms = normalizeLevel(sample.rms);
    const peak = normalizeLevel(sample.peak);
    const level = Math.max(rms, peak * 0.34);
    const startThreshold = resolveStartThreshold(state.noiseFloor, config);
    const releaseThreshold = resolveReleaseThreshold(state.noiseFloor, config);

    if (state.terminalEvent) {
      return createEvent('none', atMs, level, startThreshold, releaseThreshold);
    }

    if (state.phase === 'speaking') {
      if (level >= releaseThreshold) state.lastVoiceAtMs = atMs;
      const speechMs = Math.max(0, atMs - (state.speechStartedAtMs ?? atMs));
      const silenceMs = Math.max(0, atMs - (state.lastVoiceAtMs ?? atMs));
      const requiredSilenceMs = resolveEndSilenceMs(speechMs, config);
      if (speechMs >= config.maxSpeechMs) {
        state.terminalEvent = 'max-duration';
        return createEvent('max-duration', atMs, level, startThreshold, releaseThreshold);
      }
      if (speechMs >= config.minSpeechMs && silenceMs >= requiredSilenceMs) {
        state.terminalEvent = 'speech-end';
        return createEvent('speech-end', atMs, level, startThreshold, releaseThreshold);
      }
      return createEvent('none', atMs, level, startThreshold, releaseThreshold);
    }

    const elapsedMs = Math.max(0, atMs - state.startedAtMs);
    const isCalibration = elapsedMs <= config.calibrationMs;
    const guardedStartThreshold = Math.max(0.06, startThreshold * 2.1);
    if (elapsedMs < config.startupGuardMs && level < guardedStartThreshold) {
      state.onsetFrames = 0;
      state.firstOnsetAtMs = null;
      updateNoiseFloor(level, 0.16);
      return createEvent('none', atMs, level, startThreshold, releaseThreshold);
    }
    if (level < startThreshold) {
      state.onsetFrames = 0;
      state.firstOnsetAtMs = null;
      updateNoiseFloor(level, isCalibration ? 0.16 : 0.035);
    } else {
      if (state.onsetFrames === 0) state.firstOnsetAtMs = atMs;
      state.onsetFrames += 1;
    }

    if (state.onsetFrames >= config.onsetFrames) {
      state.phase = 'speaking';
      state.speechStartedAtMs = state.firstOnsetAtMs ?? atMs;
      state.lastVoiceAtMs = atMs;
      return createEvent('speech-start', atMs, level, startThreshold, releaseThreshold);
    }

    if (elapsedMs >= config.noSpeechMs) {
      state.terminalEvent = 'no-speech';
      return createEvent('no-speech', atMs, level, startThreshold, releaseThreshold);
    }
    return createEvent('none', atMs, level, startThreshold, releaseThreshold);
  }

  function updateNoiseFloor(level, alpha) {
    const boundedSample = Math.min(level, state.noiseFloor * 1.8 + 0.006);
    state.noiseFloor = normalizeLevel(state.noiseFloor * (1 - alpha) + boundedSample * alpha);
  }

  function createEvent(type, atMs, level, startThreshold, releaseThreshold) {
    const safeType = EVENT_TYPES.has(type) ? type : 'none';
    return Object.freeze({
      type: safeType,
      atMs,
      level,
      noiseFloor: state.noiseFloor,
      startThreshold,
      releaseThreshold,
      speechMs: state.speechStartedAtMs === null ? 0 : Math.max(0, atMs - state.speechStartedAtMs),
      silenceMs: state.lastVoiceAtMs === null ? 0 : Math.max(0, atMs - state.lastVoiceAtMs),
      requiredSilenceMs: resolveEndSilenceMs(
        state.speechStartedAtMs === null ? 0 : Math.max(0, atMs - state.speechStartedAtMs),
        config,
      ),
    });
  }

  function snapshot() {
    return Object.freeze({
      phase: state.phase,
      startedAtMs: state.startedAtMs,
      lastAtMs: state.lastAtMs,
      noiseFloor: state.noiseFloor,
      onsetFrames: state.onsetFrames,
      speechStartedAtMs: state.speechStartedAtMs ?? 0,
      lastVoiceAtMs: state.lastVoiceAtMs ?? 0,
      terminalEvent: state.terminalEvent,
      config,
    });
  }
}

export function measureVoicePcmFrame(samples) {
  const length = Number(samples?.length) || 0;
  if (!length) return Object.freeze({ rms: 0, peak: 0 });
  let energy = 0;
  let peak = 0;
  for (let index = 0; index < length; index += 1) {
    const rawSample = Number(samples[index]);
    const byteSample = Number.isFinite(rawSample) ? rawSample : 128;
    const sample = Math.max(-1, Math.min(1, (byteSample - 128) / 128));
    const absolute = Math.abs(sample);
    energy += sample * sample;
    if (absolute > peak) peak = absolute;
  }
  return Object.freeze({
    rms: normalizeLevel(Math.sqrt(energy / length)),
    peak: normalizeLevel(peak),
  });
}

function normalizeConfig(options) {
  const hasExplicitEndSilence = Object.prototype.hasOwnProperty.call(options, 'endSilenceMs')
    && Number.isFinite(Number(options.endSilenceMs));
  return Object.freeze({
    initialNoiseFloor: boundedNumber(options.initialNoiseFloor, 0.001, 0.08, VOICE_ACTIVITY_DEFAULTS.initialNoiseFloor),
    calibrationMs: boundedNumber(options.calibrationMs, 0, 2_000, VOICE_ACTIVITY_DEFAULTS.calibrationMs),
    startupGuardMs: boundedNumber(options.startupGuardMs, 0, 800, VOICE_ACTIVITY_DEFAULTS.startupGuardMs),
    onsetFrames: Math.round(boundedNumber(options.onsetFrames, 1, 12, VOICE_ACTIVITY_DEFAULTS.onsetFrames)),
    startThresholdMultiplier: boundedNumber(options.startThresholdMultiplier, 1.2, 8, VOICE_ACTIVITY_DEFAULTS.startThresholdMultiplier),
    startThresholdMargin: boundedNumber(options.startThresholdMargin, 0, 0.1, VOICE_ACTIVITY_DEFAULTS.startThresholdMargin),
    minimumStartLevel: boundedNumber(options.minimumStartLevel, 0.005, 0.3, VOICE_ACTIVITY_DEFAULTS.minimumStartLevel),
    releaseThresholdMultiplier: boundedNumber(options.releaseThresholdMultiplier, 1, 6, VOICE_ACTIVITY_DEFAULTS.releaseThresholdMultiplier),
    releaseThresholdMargin: boundedNumber(options.releaseThresholdMargin, 0, 0.08, VOICE_ACTIVITY_DEFAULTS.releaseThresholdMargin),
    minimumReleaseLevel: boundedNumber(options.minimumReleaseLevel, 0.003, 0.2, VOICE_ACTIVITY_DEFAULTS.minimumReleaseLevel),
    minSpeechMs: boundedNumber(options.minSpeechMs, 120, 3_000, VOICE_ACTIVITY_DEFAULTS.minSpeechMs),
    endSilenceMs: boundedNumber(options.endSilenceMs, 350, 2_500, VOICE_ACTIVITY_DEFAULTS.endSilenceMs),
    minimumEndSilenceMs: hasExplicitEndSilence
      ? boundedNumber(options.endSilenceMs, 350, 2_500, VOICE_ACTIVITY_DEFAULTS.endSilenceMs)
      : boundedNumber(
        options.minimumEndSilenceMs,
        350,
        VOICE_ACTIVITY_DEFAULTS.endSilenceMs,
        VOICE_ACTIVITY_DEFAULTS.minimumEndSilenceMs,
      ),
    adaptiveEndSilence: !hasExplicitEndSilence,
    noSpeechMs: boundedNumber(options.noSpeechMs, 2_000, 60_000, VOICE_ACTIVITY_DEFAULTS.noSpeechMs),
    maxSpeechMs: boundedNumber(options.maxSpeechMs, 2_000, 60_000, VOICE_ACTIVITY_DEFAULTS.maxSpeechMs),
  });
}

function resolveEndSilenceMs(speechMs, config) {
  if (!config.adaptiveEndSilence) return config.endSilenceMs;
  const progress = Math.max(0, Math.min(1, (speechMs - 600) / 1_400));
  return Math.round(
    config.endSilenceMs - (config.endSilenceMs - config.minimumEndSilenceMs) * progress,
  );
}

function resolveStartThreshold(noiseFloor, config) {
  return Math.max(
    config.minimumStartLevel,
    noiseFloor * config.startThresholdMultiplier + config.startThresholdMargin,
  );
}

function resolveReleaseThreshold(noiseFloor, config) {
  return Math.max(
    config.minimumReleaseLevel,
    noiseFloor * config.releaseThresholdMultiplier + config.releaseThresholdMargin,
  );
}

function boundedNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

function normalizeLevel(value) {
  return boundedNumber(value, 0, 1, 0);
}

function normalizeTime(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.max(0, Number(fallback) || 0);
  return Math.max(0, numeric);
}

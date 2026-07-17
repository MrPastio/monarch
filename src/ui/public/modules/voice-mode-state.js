export const VOICE_MODE_PHASES = Object.freeze([
  'closed',
  'idle',
  'entering',
  'listening',
  'recognizing',
  'routing',
  'thinking',
  'speaking',
  'error',
]);

export const VOICE_MODE_VISUAL_STATES = Object.freeze([
  'idle',
  'listening',
  'thinking',
  'speaking',
  'paused',
]);

const SPEECH_ENVELOPE_FRAME_MS = 72;
const VOICE_ORB_TAU = Math.PI * 2;
const VOICE_ORB_DEFAULT_POINT_COUNT = 112;
export const VOICE_ORB_MAX_FRAME_DELTA_MS = 40;
export const VOICE_ORB_STATE_TRANSITION_MS = 720;

const VOICE_ORB_PROFILES = Object.freeze({
  // This is the live contract from the approved Visualize state lab. Keep the
  // five profiles together so the product UI cannot drift back to the legacy
  // CSS pixel sphere while the reference evolves independently.
  idle: Object.freeze({ radius: 0.226, speed: 0.32, deform: 0.035, rings: 1, particles: 0, bands: 0, glow: 0.42, luminance: 0.62 }),
  listening: Object.freeze({ radius: 0.202, speed: 0.28, deform: 0.075, rings: 3, particles: 2, bands: 3, glow: 0.34, luminance: 0.48 }),
  thinking: Object.freeze({ radius: 0.238, speed: 0.26, deform: 0.2, rings: 2, particles: 6, bands: 0, glow: 0.58, luminance: 0.72 }),
  speaking: Object.freeze({ radius: 0.248, speed: 0.36, deform: 0.14, rings: 4, particles: 3, bands: 4, glow: 0.72, luminance: 0.9 }),
  paused: Object.freeze({ radius: 0.21, speed: 0, deform: 0.018, rings: 1, particles: 0, bands: 0, glow: 0.25, luminance: 0.38 }),
});

export function resolveOscarComposerPrimaryAction({ busy, hasPayload }) {
  if (busy) return 'stop';
  return hasPayload ? 'send' : 'voice';
}

export function normalizeVoiceModePhase(value) {
  return VOICE_MODE_PHASES.includes(value) ? value : 'error';
}

export function resolveVoiceModeVisualState(value, { micMuted = false } = {}) {
  const phase = normalizeVoiceModePhase(value);
  if (phase === 'speaking') return 'speaking';
  if (micMuted || phase === 'closed' || phase === 'error') return 'paused';
  if (phase === 'listening') return 'listening';
  if (phase === 'recognizing' || phase === 'routing' || phase === 'thinking') return 'thinking';
  return 'idle';
}

export function normalizeVoiceAmplitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

export function normalizeVoiceOrbFrameDelta(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(VOICE_ORB_MAX_FRAME_DELTA_MS, numeric);
}

export function advanceVoiceOrbMotion({
  phase = 0,
  deltaMs = 0,
  visualState = 'idle',
  level = 0,
  reducedMotion = false,
} = {}) {
  const state = VOICE_MODE_VISUAL_STATES.includes(visualState) ? visualState : 'paused';
  const currentPhase = Math.max(0, Number(phase) || 0);
  if (reducedMotion || state === 'paused') return currentPhase;
  const deltaSeconds = normalizeVoiceOrbFrameDelta(deltaMs) / 1000;
  const speed = VOICE_ORB_PROFILES[state].speed * (0.82 + normalizeVoiceAmplitude(level) * 0.28);
  return currentPhase + deltaSeconds * speed;
}

export function smoothVoiceOrbSignal(current = {}, target = {}, deltaMs = 0) {
  const delta = normalizeVoiceOrbFrameDelta(deltaMs);
  return {
    level: smoothVoiceOrbChannel(current.level, target.level, delta, 145, 260, normalizeVoiceAmplitude),
    inputLevel: smoothVoiceOrbChannel(current.inputLevel, target.inputLevel, delta, 145, 260, normalizeVoiceAmplitude),
    outputLevel: smoothVoiceOrbChannel(current.outputLevel, target.outputLevel, delta, 125, 300, normalizeVoiceAmplitude),
    balance: smoothVoiceOrbChannel(current.balance, target.balance, delta, 190, 230, clampSigned),
  };
}

/**
 * Produces a deterministic, normalized Canvas frame for the live voice orb.
 * Coordinates are relative to the shortest canvas side, keeping the renderer
 * DPR- and layout-independent while tests can verify the motion contract.
 */
export function createVoiceOrbFrame({
  visualState = 'idle',
  elapsedMs = 0,
  motionPhase,
  level = 0,
  inputLevel = 0,
  outputLevel = 0,
  balance = 0,
  pointCount = VOICE_ORB_DEFAULT_POINT_COUNT,
  reducedMotion = false,
} = {}) {
  const state = VOICE_MODE_VISUAL_STATES.includes(visualState) ? visualState : 'paused';
  const profile = VOICE_ORB_PROFILES[state];
  const safeLevel = normalizeVoiceAmplitude(level);
  const safeInput = normalizeVoiceAmplitude(inputLevel);
  const safeOutput = normalizeVoiceAmplitude(outputLevel);
  const safeBalance = clampSigned(balance);
  const reactiveLevel = state === 'listening'
    ? safeInput
    : state === 'speaking'
      ? safeOutput
      : safeLevel;
  const seconds = Math.max(0, Number(elapsedMs) || 0) / 1000;
  const suppliedPhase = Number(motionPhase);
  const phase = reducedMotion
    ? 0
    : Number.isFinite(suppliedPhase)
      ? Math.max(0, suppliedPhase)
      : seconds * profile.speed * (0.82 + reactiveLevel * 0.28);
  const count = Math.max(24, Math.min(128, Math.round(Number(pointCount) || VOICE_ORB_DEFAULT_POINT_COUNT)));
  const radius = profile.radius + reactiveLevel * 0.025;
  const points = Array.from({ length: count }, (_, index) => {
    const angle = (index / count) * VOICE_ORB_TAU;
    const deformation = resolveVoiceOrbDeformation(state, angle, phase, reactiveLevel, profile.deform);
    const radial = radius * Math.max(0.72, 1 + deformation);
    const horizontalBias = safeBalance * (state === 'speaking' ? 0.012 : 0.006);
    return {
      x: Math.cos(angle) * radial + horizontalBias,
      y: Math.sin(angle) * radial,
    };
  });

  return {
    state,
    level: reactiveLevel,
    energy: reactiveLevel * reactiveLevel,
    balance: safeBalance,
    glow: profile.glow + reactiveLevel * (state === 'speaking' ? 0.24 : 0.12),
    luminance: profile.luminance + reactiveLevel * (state === 'speaking' ? 0.1 : 0.05),
    phase,
    radius,
    points,
    rings: createVoiceOrbRings(state, phase, radius, reactiveLevel, profile.rings),
    bands: createVoiceOrbBands(state, phase, radius, reactiveLevel, profile.bands),
    particles: createVoiceOrbParticles(phase, radius, reactiveLevel, profile.particles),
  };
}

export function blendVoiceOrbFrames(fromFrame, toFrame, progress) {
  const rawProgress = normalizeVoiceAmplitude(progress);
  if (rawProgress <= 0) return fromFrame;
  if (rawProgress >= 1 || !fromFrame || fromFrame.state === toFrame.state) return toFrame;
  const eased = rawProgress * rawProgress * (3 - 2 * rawProgress);
  const inverse = 1 - eased;
  const fromPoints = fromFrame.points || [];
  const toPoints = toFrame.points || [];
  const points = toPoints.map((point, index) => {
    const previous = fromPoints[index % Math.max(1, fromPoints.length)] || point;
    return {
      x: lerp(previous.x, point.x, eased),
      y: lerp(previous.y, point.y, eased),
    };
  });

  return {
    ...toFrame,
    level: lerp(fromFrame.level, toFrame.level, eased),
    energy: lerp(fromFrame.energy, toFrame.energy, eased),
    balance: lerp(fromFrame.balance, toFrame.balance, eased),
    glow: lerp(fromFrame.glow, toFrame.glow, eased),
    luminance: lerp(fromFrame.luminance, toFrame.luminance, eased),
    radius: lerp(fromFrame.radius, toFrame.radius, eased),
    points,
    rings: [
      ...fadeVoiceOrbEffects(fromFrame.rings, inverse),
      ...fadeVoiceOrbEffects(toFrame.rings, eased),
    ],
    bands: [
      ...fadeVoiceOrbEffects(fromFrame.bands, inverse),
      ...fadeVoiceOrbEffects(toFrame.bands, eased),
    ],
    particles: [
      ...fadeVoiceOrbEffects(fromFrame.particles, inverse),
      ...fadeVoiceOrbEffects(toFrame.particles, eased),
    ],
    paletteMix: {
      from: fromFrame.state,
      to: toFrame.state,
      progress: eased,
    },
  };
}

function resolveVoiceOrbDeformation(state, angle, phase, level, deform) {
  const listeningBeat = state === 'listening'
    ? Math.sin(phase * 5.2 + angle * 2) * level * 0.035
    : 0;
  const speakingBeat = state === 'speaking'
    ? Math.sin(phase * 7.4 + angle * 4) * level * 0.065
    : 0;
  const thinkingFold = state === 'thinking'
    ? Math.sin(angle * 3 - phase * 1.7) * Math.cos(angle * 2 + phase) * 0.55
    : 0;
  const organic = (
    Math.sin(angle * 3 + phase * 0.9) * 0.46
    + Math.sin(angle * 5 - phase * 0.64) * 0.32
    + Math.cos(angle * 2 + phase * 0.48) * 0.22
    + thinkingFold
  );
  const breathing = Math.sin(phase * 1.45) * (0.025 + level * 0.018);
  return breathing + organic * deform + listeningBeat + speakingBeat;
}

function createVoiceOrbRings(state, phase, radius, level, count) {
  return Array.from({ length: count }, (_, index) => {
    const drift = state === 'paused' ? 0 : ((phase * 0.26 + index / Math.max(1, count)) % 1);
    const ringRadius = Math.min(0.485, radius * (1.18 + drift * (0.46 + level * 0.28)));
    return {
      radiusX: ringRadius * (1 + Math.sin(phase + index) * 0.025),
      radiusY: ringRadius * (0.94 + Math.cos(phase * 0.8 + index) * 0.035),
      rotation: Math.sin(phase * 0.35 + index) * 0.08,
      alpha: state === 'paused' ? 0.12 : Math.max(0.025, (1 - drift) * (0.13 + level * 0.13)),
      accent: index % 2 === 1,
    };
  });
}

function createVoiceOrbBands(state, phase, radius, level, count) {
  if (!count) return [];
  const speed = state === 'speaking' ? 0.58 : 0.34;
  return Array.from({ length: count }, (_, index) => {
    const travel = ((phase * speed) + index / count) % 1;
    return {
      reach: radius * (1.28 + travel * 1.08),
      lift: radius * (0.52 + level * 0.22),
      alpha: (1 - travel) * (0.08 + level * 0.18),
    };
  });
}

function createVoiceOrbParticles(phase, radius, level, count) {
  if (!count) return [];
  return Array.from({ length: count }, (_, index) => {
    const angle = phase * (0.55 + index * 0.035) + (index / count) * VOICE_ORB_TAU;
    const orbit = radius * (1.55 + (index % 3) * 0.25 + level * 0.15);
    return {
      x: Math.cos(angle) * orbit,
      y: Math.sin(angle * 1.14) * orbit * 0.68,
      radius: radius * (0.028 + level * 0.018 + (index % 2) * 0.012),
      alpha: 0.42 + level * 0.42,
    };
  });
}

function smoothVoiceOrbChannel(current, target, deltaMs, attackMs, releaseMs, normalize) {
  const from = normalize(current);
  const to = normalize(target);
  if (deltaMs <= 0 || Math.abs(to - from) < 0.0001) return from;
  const timeConstant = to > from ? attackMs : releaseMs;
  const alpha = 1 - Math.exp(-deltaMs / timeConstant);
  return normalize(from + (to - from) * alpha);
}

function fadeVoiceOrbEffects(items, opacity) {
  if (!Array.isArray(items) || opacity <= 0.0001) return [];
  return items.map((item) => ({
    ...item,
    alpha: normalizeVoiceAmplitude(item.alpha * opacity),
  }));
}

function lerp(from, to, progress) {
  return (Number(from) || 0) + ((Number(to) || 0) - (Number(from) || 0)) * progress;
}

function clampSigned(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(-1, Math.min(1, numeric));
}

export function createVoiceSpeechEnvelope(value) {
  const characters = Array.from(String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim())
    .slice(0, 360);
  if (!characters.length) return Object.freeze([0]);

  return Object.freeze(characters.map((character, index) => {
    if (/\s/u.test(character)) return 0.08;
    if (/[.,!?;:…—-]/u.test(character)) return 0.04;
    const code = character.codePointAt(0) || 0;
    const voiced = /[aeiouyаеёиоуыэюяіїєґ0-9]/u.test(character);
    const consonant = /[a-zа-яёіїєґ]/u.test(character);
    const texture = ((code * 17 + index * 29) % 23) / 100;
    return normalizeVoiceAmplitude((voiced ? 0.7 : consonant ? 0.48 : 0.2) + texture);
  }));
}

export function sampleVoiceSpeechEnvelope(envelope, elapsedMs) {
  const values = Array.isArray(envelope) && envelope.length ? envelope : [0];
  const position = Math.max(0, Number(elapsedMs) || 0) / SPEECH_ENVELOPE_FRAME_MS;
  const index = Math.floor(position) % values.length;
  const nextIndex = (index + 1) % values.length;
  const progress = position - Math.floor(position);
  const eased = progress * progress * (3 - 2 * progress);
  const current = normalizeVoiceAmplitude(values[index]);
  const next = normalizeVoiceAmplitude(values[nextIndex]);
  const cadence = 0.94 + Math.sin(position * 1.37) * 0.06;
  return normalizeVoiceAmplitude((current + (next - current) * eased) * cadence);
}

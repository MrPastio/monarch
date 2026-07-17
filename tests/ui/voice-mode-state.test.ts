import { describe, expect, it } from 'vitest';
import {
  advanceVoiceOrbMotion,
  blendVoiceOrbFrames,
  createVoiceOrbFrame,
  createVoiceSpeechEnvelope,
  normalizeVoiceAmplitude,
  normalizeVoiceOrbFrameDelta,
  normalizeVoiceModePhase,
  resolveOscarComposerPrimaryAction,
  resolveVoiceModeVisualState,
  sampleVoiceSpeechEnvelope,
  smoothVoiceOrbSignal,
  VOICE_MODE_PHASES,
  VOICE_MODE_VISUAL_STATES,
  VOICE_ORB_MAX_FRAME_DELTA_MS,
} from '../../src/ui/public/modules/voice-mode-state.js';

describe('voice mode UI state', () => {
  it('gives busy, payload, and empty drafts one deterministic primary action', () => {
    expect(resolveOscarComposerPrimaryAction({ busy: true, hasPayload: false })).toBe('stop');
    expect(resolveOscarComposerPrimaryAction({ busy: true, hasPayload: true })).toBe('stop');
    expect(resolveOscarComposerPrimaryAction({ busy: false, hasPayload: true })).toBe('send');
    expect(resolveOscarComposerPrimaryAction({ busy: false, hasPayload: false })).toBe('voice');
  });

  it('keeps the phase contract finite', () => {
    expect(VOICE_MODE_PHASES).toContain('speaking');
    expect(normalizeVoiceModePhase('listening')).toBe('listening');
    expect(normalizeVoiceModePhase('unknown')).toBe('error');
  });

  it('maps runtime phases onto exactly five visual states', () => {
    expect(VOICE_MODE_VISUAL_STATES).toEqual([
      'idle',
      'listening',
      'thinking',
      'speaking',
      'paused',
    ]);
    expect(resolveVoiceModeVisualState('idle')).toBe('idle');
    expect(resolveVoiceModeVisualState('entering')).toBe('idle');
    expect(resolveVoiceModeVisualState('listening')).toBe('listening');
    expect(resolveVoiceModeVisualState('recognizing')).toBe('thinking');
    expect(resolveVoiceModeVisualState('routing')).toBe('thinking');
    expect(resolveVoiceModeVisualState('thinking')).toBe('thinking');
    expect(resolveVoiceModeVisualState('speaking')).toBe('speaking');
    expect(resolveVoiceModeVisualState('closed')).toBe('paused');
    expect(resolveVoiceModeVisualState('error')).toBe('paused');
  });

  it('uses paused for a muted turn without hiding active speech', () => {
    expect(resolveVoiceModeVisualState('thinking', { micMuted: true })).toBe('paused');
    expect(resolveVoiceModeVisualState('speaking', { micMuted: true })).toBe('speaking');
  });

  it('clamps visual amplitude and creates a deterministic speech envelope', () => {
    expect(normalizeVoiceAmplitude(Number.NaN)).toBe(0);
    expect(normalizeVoiceAmplitude(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeVoiceAmplitude(-0.4)).toBe(0);
    expect(normalizeVoiceAmplitude(1.4)).toBe(1);

    const first = createVoiceSpeechEnvelope('Oscar, говори.');
    const second = createVoiceSpeechEnvelope('Oscar, говори.');
    expect(first).toEqual(second);
    expect(first.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(createVoiceSpeechEnvelope(' ')[0]).toBe(0);
    expect(createVoiceSpeechEnvelope('.')[0]).toBeLessThan(createVoiceSpeechEnvelope('о')[0]);

    for (const elapsed of [0, 72, 144, 900, 4_000]) {
      expect(sampleVoiceSpeechEnvelope(first, elapsed)).toBeGreaterThanOrEqual(0);
      expect(sampleVoiceSpeechEnvelope(first, elapsed)).toBeLessThanOrEqual(1);
    }
  });

  it('builds deterministic organic geometry for all five visual states', () => {
    const frames = VOICE_MODE_VISUAL_STATES.map((visualState) => createVoiceOrbFrame({
      visualState,
      elapsedMs: 1_750,
      level: 0.45,
      inputLevel: 0.45,
      outputLevel: 0.45,
      balance: 0.2,
    }));

    expect(frames.map((frame) => frame.state)).toEqual(VOICE_MODE_VISUAL_STATES);
    for (const frame of frames) {
      expect(frame.points).toHaveLength(112);
      expect(frame.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
      expect(frame.points.every((point) => Math.abs(point.x) < 0.5 && Math.abs(point.y) < 0.5)).toBe(true);
    }
    expect(frames[1].radius).toBeLessThan(frames[0].radius);
    expect(frames[3].radius).toBeGreaterThan(frames[0].radius);
    expect(frames.map((frame) => frame.rings.length)).toEqual([1, 3, 2, 4, 1]);
    expect(frames.map((frame) => frame.bands.length)).toEqual([0, 3, 0, 4, 0]);
    expect(frames[1].particles).toHaveLength(2);
    expect(frames[2].particles).toHaveLength(6);
    expect(frames[3].particles).toHaveLength(3);
    expect(frames[0].particles).toHaveLength(0);
  });

  it('freezes time for reduced motion while preserving state and audio response', () => {
    const early = createVoiceOrbFrame({
      visualState: 'listening',
      elapsedMs: 100,
      inputLevel: 0.72,
      balance: -0.4,
      reducedMotion: true,
    });
    const late = createVoiceOrbFrame({
      visualState: 'listening',
      elapsedMs: 80_000,
      inputLevel: 0.72,
      balance: -0.4,
      reducedMotion: true,
    });
    expect(late).toEqual(early);

    const quiet = createVoiceOrbFrame({ visualState: 'listening', inputLevel: 0, reducedMotion: true });
    const loud = createVoiceOrbFrame({ visualState: 'listening', inputLevel: 1, reducedMotion: true });
    expect(loud.radius).toBeGreaterThan(quiet.radius);
    expect(loud.points).not.toEqual(quiet.points);
  });

  it('clamps organic-frame inputs and keeps balance directional', () => {
    const left = createVoiceOrbFrame({ visualState: 'speaking', outputLevel: 4, balance: -5, pointCount: 4 });
    const right = createVoiceOrbFrame({ visualState: 'speaking', outputLevel: 4, balance: 5, pointCount: 500 });
    const centroid = (frame: ReturnType<typeof createVoiceOrbFrame>) => (
      frame.points.reduce((sum, point) => sum + point.x, 0) / frame.points.length
    );

    expect(left.level).toBe(1);
    expect(right.level).toBe(1);
    expect(left.points).toHaveLength(24);
    expect(right.points).toHaveLength(128);
    expect(centroid(left)).toBeLessThan(0);
    expect(centroid(right)).toBeGreaterThan(0);
  });

  it('bounds stalled-frame deltas and integrates phase without level-dependent jumps', () => {
    expect(normalizeVoiceOrbFrameDelta(-1)).toBe(0);
    expect(normalizeVoiceOrbFrameDelta(Number.NaN)).toBe(0);
    expect(normalizeVoiceOrbFrameDelta(5_000)).toBe(VOICE_ORB_MAX_FRAME_DELTA_MS);

    const normal = advanceVoiceOrbMotion({
      phase: 2,
      deltaMs: VOICE_ORB_MAX_FRAME_DELTA_MS,
      visualState: 'speaking',
      level: 1,
    });
    const afterStall = advanceVoiceOrbMotion({
      phase: 2,
      deltaMs: 5_000,
      visualState: 'speaking',
      level: 1,
    });
    expect(afterStall).toBe(normal);

    const quiet = createVoiceOrbFrame({ visualState: 'listening', motionPhase: 3, inputLevel: 0 });
    const loud = createVoiceOrbFrame({ visualState: 'listening', motionPhase: 3, inputLevel: 1 });
    expect(quiet.phase).toBe(3);
    expect(loud.phase).toBe(3);
  });

  it('smooths abrupt telemetry and morphs state geometry instead of snapping', () => {
    const zero = { level: 0, inputLevel: 0, outputLevel: 0, balance: 0 };
    const loud = { level: 1, inputLevel: 1, outputLevel: 1, balance: 1 };
    const first = smoothVoiceOrbSignal(zero, loud, 16);
    const stalled = smoothVoiceOrbSignal(zero, loud, 5_000);
    expect(first.level).toBeGreaterThan(0);
    expect(first.level).toBeLessThan(0.2);
    expect(stalled.level).toBeLessThan(1);
    expect(stalled.level).toBeGreaterThan(first.level);

    const from = createVoiceOrbFrame({ visualState: 'idle', motionPhase: 1.25, level: 0.4 });
    const to = createVoiceOrbFrame({ visualState: 'thinking', motionPhase: 1.25, level: 0.4 });
    const middle = blendVoiceOrbFrames(from, to, 0.5);
    expect(middle.state).toBe('thinking');
    expect(middle.paletteMix).toMatchObject({ from: 'idle', to: 'thinking', progress: 0.5 });
    expect(middle.points[0].x).toBeGreaterThan(Math.min(from.points[0].x, to.points[0].x));
    expect(middle.points[0].x).toBeLessThan(Math.max(from.points[0].x, to.points[0].x));
    expect(middle.rings).toHaveLength(from.rings.length + to.rings.length);
    expect(blendVoiceOrbFrames(from, to, 1)).toBe(to);
  });
});

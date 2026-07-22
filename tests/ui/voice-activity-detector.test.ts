import { describe, expect, it } from 'vitest';
import {
  VOICE_ACTIVITY_DEFAULTS,
  createAdaptiveVoiceActivityDetector,
  measureVoicePcmFrame,
} from '../../src/ui/public/modules/voice-activity-detector.js';

function pushFrames(detector, { from = 0, count, every = 20, rms, peak = rms }) {
  let event;
  for (let index = 0; index < count; index += 1) {
    event = detector.push({ atMs: from + index * every, rms, peak });
  }
  return event;
}

describe('adaptive voice activity detector', () => {
  it('adapts to stable background noise without declaring speech', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    pushFrames(detector, { count: 50, rms: 0.008 });
    const result = pushFrames(detector, { from: 1_000, count: 30, rms: 0.012 });

    expect(result.type).toBe('none');
    expect(detector.snapshot().noiseFloor).toBeGreaterThan(0.006);
    expect(detector.snapshot().phase).toBe('waiting');
  });

  it('rejects a single transient spike', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    pushFrames(detector, { count: 20, rms: 0.006 });
    expect(detector.push({ atMs: 420, rms: 0.2, peak: 0.8 }).type).toBe('none');
    expect(detector.push({ atMs: 440, rms: 0.006 }).type).toBe('none');
    expect(detector.snapshot().phase).toBe('waiting');
  });

  it('uses the first frames to absorb moderate room noise without clipping strong speech', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    const startupNoise = pushFrames(detector, { count: 8, every: 20, rms: 0.03, peak: 0.05 });

    expect(startupNoise.type).toBe('none');
    expect(detector.snapshot().phase).toBe('waiting');
    expect(detector.snapshot().noiseFloor).toBeGreaterThan(0.006);
    expect(detector.push({ atMs: 180, rms: 0.09 }).type).toBe('none');
    expect(detector.push({ atMs: 200, rms: 0.09 }).type).toBe('none');
    expect(detector.push({ atMs: 220, rms: 0.09 }).type).toBe('speech-start');
  });

  it('starts after sustained speech onset frames', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    pushFrames(detector, { count: 20, rms: 0.006 });
    expect(detector.push({ atMs: 420, rms: 0.08 }).type).toBe('none');
    expect(detector.push({ atMs: 440, rms: 0.08 }).type).toBe('none');
    const event = detector.push({ atMs: 460, rms: 0.08 });

    expect(event.type).toBe('speech-start');
    expect(detector.snapshot().phase).toBe('speaking');
    expect(detector.snapshot().speechStartedAtMs).toBe(420);
  });

  it('keeps a natural short pause inside the same utterance', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    pushFrames(detector, { from: 0, count: 3, rms: 0.09 });
    pushFrames(detector, { from: 80, count: 25, rms: 0.07 });
    const pause = detector.push({ atMs: 720, rms: 0.002 });

    expect(pause.type).toBe('none');
    expect(detector.snapshot().phase).toBe('speaking');
  });

  it('ends only after sustained trailing silence and minimum speech duration', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0, endSilenceMs: 780 });
    pushFrames(detector, { from: 0, count: 3, rms: 0.09 });
    pushFrames(detector, { from: 80, count: 20, rms: 0.07 });
    expect(detector.push({ atMs: 1_220, rms: 0.001 }).type).toBe('none');
    const ended = detector.push({ atMs: 1_260, rms: 0.001 });

    expect(ended.type).toBe('speech-end');
    expect(ended.silenceMs).toBeGreaterThanOrEqual(780);
  });

  it('adapts trailing silence from 560ms for short speech toward 420ms for a stable phrase', () => {
    const short = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    pushFrames(short, { from: 0, count: 3, rms: 0.09 });
    pushFrames(short, { from: 80, count: 10, rms: 0.07 });
    const shortPause = short.push({ atMs: 760, rms: 0.001 });
    expect(shortPause.type).toBe('none');
    expect(shortPause.requiredSilenceMs).toBeGreaterThanOrEqual(520);

    const stable = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    pushFrames(stable, { from: 0, count: 3, rms: 0.09 });
    pushFrames(stable, { from: 80, count: 100, rms: 0.07 });
    const ended = stable.push({ atMs: 2_560, rms: 0.001 });
    expect(ended.requiredSilenceMs).toBe(420);
    expect(ended.type).toBe('speech-end');
  });

  it('requests a silent recorder recycle when nobody speaks', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0, noSpeechMs: 2_000 });
    const event = detector.push({ atMs: 2_001, rms: 0.004 });

    expect(event.type).toBe('no-speech');
    expect(detector.snapshot().terminalEvent).toBe('no-speech');
    expect(detector.push({ atMs: 2_100, rms: 0.2 }).type).toBe('none');
  });

  it('caps a long utterance', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0, maxSpeechMs: 2_000 });
    pushFrames(detector, { from: 0, count: 3, rms: 0.09 });
    const event = detector.push({ atMs: 2_001, rms: 0.08 });

    expect(event.type).toBe('max-duration');
  });

  it('sanitizes invalid samples and reset returns to waiting', () => {
    const detector = createAdaptiveVoiceActivityDetector({ startedAtMs: 0 });
    expect(detector.push({ atMs: Number.NaN, rms: Number.NaN, peak: -2 }).level).toBe(0);
    pushFrames(detector, { from: 20, count: 3, rms: 0.1 });
    detector.reset(500);

    expect(detector.snapshot()).toMatchObject({
      phase: 'waiting',
      startedAtMs: 500,
      speechStartedAtMs: 0,
      terminalEvent: '',
    });
  });

  it('keeps bounded defaults suitable for conversational turns', () => {
    expect(VOICE_ACTIVITY_DEFAULTS.onsetFrames).toBeGreaterThanOrEqual(2);
    expect(VOICE_ACTIVITY_DEFAULTS.endSilenceMs).toBeGreaterThanOrEqual(520);
    expect(VOICE_ACTIVITY_DEFAULTS.endSilenceMs).toBeLessThanOrEqual(650);
    expect(VOICE_ACTIVITY_DEFAULTS.minimumEndSilenceMs).toBeGreaterThanOrEqual(400);
    expect(VOICE_ACTIVITY_DEFAULTS.minimumEndSilenceMs).toBeLessThanOrEqual(480);
    expect(VOICE_ACTIVITY_DEFAULTS.noSpeechMs).toBeLessThanOrEqual(10_000);
  });

  it('measures browser PCM frames without exceeding normalized bounds', () => {
    expect(measureVoicePcmFrame(new Uint8Array([128, 160, 96, 128]))).toEqual({
      rms: 0.1767766952966369,
      peak: 0.25,
    });
    expect(measureVoicePcmFrame(new Uint8Array())).toEqual({ rms: 0, peak: 0 });
    expect(measureVoicePcmFrame(new Uint8Array([0, 255])).peak).toBe(1);
  });
});

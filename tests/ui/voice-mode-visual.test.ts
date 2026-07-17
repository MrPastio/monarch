import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  describeVoiceSpeechFallback,
  warmVoiceModeSpeech,
} from '../../src/ui/public/modules/oscar-voice-mode.js';

const visualStates = ['idle', 'listening', 'thinking', 'speaking', 'paused'];

describe('voice mode visual contract', () => {
  it('retries one failed Qwen warmup exactly once before voice preparation', async () => {
    const speech = {
      awaitWarmup: vi.fn(async () => ({ status: 'failed', ok: false, error: 'os-1455' })),
      retryWarmup: vi.fn(async () => ({ status: 'ready', ok: true, engine: 'qwen3-tts-cuda-graph' })),
    };

    await expect(warmVoiceModeSpeech(speech)).resolves.toMatchObject({
      retried: true,
      warmup: { status: 'ready', ok: true },
    });
    expect(speech.awaitWarmup).toHaveBeenCalledOnce();
    expect(speech.retryWarmup).toHaveBeenCalledOnce();

    const readySpeech = {
      awaitWarmup: vi.fn(async () => ({ status: 'ready', ok: true })),
      retryWarmup: vi.fn(),
    };
    await warmVoiceModeSpeech(readySpeech);
    expect(readySpeech.retryWarmup).not.toHaveBeenCalled();
  });

  it('turns a successful SAPI fallback into a bounded honest Voice Mode notice', () => {
    expect(describeVoiceSpeechFallback({
      fallback: true,
      fallbackFrom: 'neural-tts-start-timeout',
      engine: 'windows-sapi',
    })).toEqual({
      lastError: 'neural-tts-start-timeout',
      kicker: 'Аварийная озвучка',
      title: 'Ответ озвучен через Windows',
      detail: 'Qwen TTS не начал воспроизведение вовремя · использован локальный SAPI (neural-tts-start-timeout)',
    });
    expect(describeVoiceSpeechFallback({ fallback: false })).toBeNull();
  });

  it('styles all five states and consumes separate mic and TTS amplitude channels', () => {
    const css = readFileSync(
      new URL('../../src/ui/public/styles-v2.css', import.meta.url),
      'utf8',
    );

    for (const state of visualStates) {
      expect(css).toContain(`[data-visual-state='${state}']`);
    }
    expect(css).toContain('var(--voice-input-level)');
    expect(css).toContain('var(--voice-output-level)');
    expect(css).toContain('var(--voice-energy)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.voice-orb-canvas');
    expect(css).toContain('.voice-mode-orb.has-organic-canvas .voice-orb-core');
    expect(css).toContain('aspect-ratio: 1.75');
  });

  it('mounts the organic canvas inside the existing accessible capture button', () => {
    const html = readFileSync(
      new URL('../../src/ui/public/index.html', import.meta.url),
      'utf8',
    );

    expect(html).toContain('id="oscar-voice-mode-orb"');
    expect(html).toContain('id="oscar-voice-mode-canvas"');
    expect(html).toContain('class="voice-orb-canvas"');
    expect(html).toContain('width="520" height="297"');
    expect(html).toContain('data-visual-state="paused"');
    expect(html).toContain('aria-hidden="true"></canvas>');
    expect(html).not.toContain('id="oscar-voice-mode-pixels"');
    expect(html).not.toContain('class="voice-orb-halo');
  });

  it('keeps mute and visualizer behavior inside the real fullscreen controller', () => {
    const source = readFileSync(
      new URL('../../src/ui/public/modules/oscar-voice-mode.js', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const visualState = resolveVoiceModeVisualState');
    expect(source).toContain('surface.dataset.visualState = visualState');
    expect(source).toContain('orb.dataset.visualState = visualState');
    expect(source).toContain('VISUAL_STATE_ACCESSIBLE_LABELS[visualState]');
    expect(source).toContain('Оскар отвечает. Нажми, чтобы остановить ответ и говорить дальше');
    expect(source).toContain("writeVoiceLevel(smoothedLevel, 'mic'");
    expect(source).toContain("writeVoiceLevel(level, 'tts'");
    expect(source).toContain("surface.dataset.outputTelemetry = 'live'");
    expect(source).toContain("surface.dataset.outputTelemetry = 'synthetic-fallback'");
    expect(source).toContain('onAudioFrame: (frame) =>');
    expect(source).toContain('createOrganicVoiceOrbRenderer');
    expect(source).toContain('createVoiceOrbFrame');
    expect(source).toContain('drawVoiceOrbRings');
    expect(source).toContain('drawVoiceOrbBands');
    expect(source).toContain('warmVoiceModeSpeech(speech).then(continueAfterSpeechWarmup');
    expect(source).toContain('if (!isOpen || openingTurn !== turnId) return;');
    expect(source).toContain('void prepareVoiceModeModels().catch(() =>');
    expect(source).toContain('void releaseVoiceModeModels().catch(() =>');
    expect(source).toContain("surface.dataset.speechWarmup = ready ? 'ready' : 'failed'");
    expect(source).toContain('describeVoiceSpeechFallback(speechState.playback)');
    expect(source).toContain("surface.dataset.speechLastError = fallbackNotice.lastError");
    expect(source).toContain("setPhase('idle', fallbackNotice || {})");
    expect(source).toContain("canvas.getContext('2d', { alpha: true })");
    expect(source).not.toContain('desynchronized: true');
    expect(source).not.toContain('buildPixelOrb');
    expect(source).toContain('createAdaptiveVoiceActivityDetector');
    expect(source).toContain('measureVoicePcmFrame');
    expect(source).toContain("activity.type === 'speech-start'");
    expect(source).toContain("activity.type === 'speech-end'");
    expect(source).toContain("activity.type === 'no-speech'");
    expect(source).toContain('capture?.cancelSilently()');
    expect(source).toContain('capture?.stop()');
    expect(source).toContain('Оскар говорит');
    expect(source).not.toContain('Oscar говорит');
    expect(source).toContain("result.action === 'listen.continue' && !result.text");
    expect(source).toContain("surface.dataset.voiceActivity = 'speech'");
    expect(source).toContain('Закончу запись автоматически после короткой паузы');
    expect(source).toContain('windowObject.devicePixelRatio');
    expect(source).toContain('windowObject.requestAnimationFrame');
    expect(source).toContain('windowObject.cancelAnimationFrame');
    expect(source).toContain('resizeObserver?.disconnect()');
    expect(source).toContain("removeEventListener?.('visibilitychange', handleVisibility)");
    expect(source).toContain('orbRenderer?.stop()');
    expect(source).toContain("orb.addEventListener('click', guardMutedCapture, { capture: true })");
    expect(source).toContain("['recognizing', 'routing', 'thinking'].includes(currentPhase)");
    expect(source).toContain('Микрофон включен. Текущая задача продолжает выполняться.');
    expect(source).toContain('if (reducedMotion?.matches)');
    expect(source).not.toContain('getUserMedia(');
  });
});

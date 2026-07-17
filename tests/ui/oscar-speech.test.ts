import { describe, expect, it, vi } from 'vitest';
import {
  chunkSpeechText,
  createOscarSpeechController,
  detectSpeechLanguage,
  normalizeTextForSpeech,
  normalizeSpeechAudioFrame,
  normalizeSpeechWarmupResult,
  selectBestSpeechVoice,
} from '../../src/ui/public/modules/oscar-speech.js';

describe('Oscar speech output', () => {
  it('turns markdown into natural complete speech text', () => {
    const result = normalizeTextForSpeech(`## Итог

- **Первый** пункт со [ссылкой](https://example.com/docs).
- Код: \`npm test\`.

\`\`\`ts
const ready = true;
\`\`\``);

    expect(result).toContain('Итог.');
    expect(result).toContain('Первый пункт со ссылкой.');
    expect(result).toContain('Код: npm test.');
    expect(result).toContain('const ready = true;');
    expect(result).not.toMatch(/\*\*|```|\]\(/);
  });

  it('splits long answers into bounded semantic chunks without dropping text', () => {
    const source = Array.from({ length: 30 }, (_, index) => `Предложение номер ${index + 1} содержит важную часть ответа.`).join(' ');
    const chunks = chunkSpeechText(source, 120);

    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
    expect(chunks.join(' ')).toBe(source);
  });

  it('detects the supported response languages', () => {
    expect(detectSpeechLanguage('Привет, это русский ответ.')).toBe('ru-RU');
    expect(detectSpeechLanguage('Привіт, це українська відповідь.')).toBe('uk-UA');
    expect(detectSpeechLanguage('Това е отговор и благодаря.')).toBe('bg-BG');
    expect(detectSpeechLanguage('This is an English answer.')).toBe('en-US');
  });

  it('prefers an exact-language natural voice', () => {
    const voice = selectBestSpeechVoice([
      { name: 'Generic', lang: 'en-US', localService: true },
      { name: 'Microsoft Pavel', lang: 'ru-RU', localService: true },
      { name: 'Microsoft Irina Natural', lang: 'ru-RU', localService: false },
    ], 'ru-RU');

    expect(voice?.name).toBe('Microsoft Irina Natural');
  });

  it('maps trusted desktop RMS and brightness into bounded visual levels', () => {
    expect(normalizeSpeechAudioFrame({
      id: 'speech-1',
      sequence: 3,
      rms: 0.0625,
      peak: 0.8,
      brightness: 0.45,
    })).toEqual({
      level: 0.8,
      peak: 0.8,
      brightness: 0.45,
      rms: 0.0625,
      sequence: 3,
      source: 'tts',
    });
    expect(normalizeSpeechAudioFrame({ rms: 0.5 })).toBeNull();
  });

  it('awaits the exact shared desktop warmup and exposes its diagnostics', async () => {
    let finishWarmup: (value: unknown) => void = () => undefined;
    const desktop = {
      warmSpeechOutput: vi.fn(() => new Promise((resolve) => { finishWarmup = resolve; })),
    };
    const controller = createOscarSpeechController({
      desktop,
      speechSynthesis: undefined,
      Utterance: undefined,
    });

    const first = controller.prewarm();
    const second = controller.awaitWarmup();

    expect(first).toBe(second);
    expect(desktop.warmSpeechOutput).toHaveBeenCalledTimes(1);
    expect(desktop.warmSpeechOutput).toHaveBeenCalledWith({ retry: false });
    expect(controller.getState().warmup).toMatchObject({ status: 'loading' });

    finishWarmup({
      status: 'ready',
      ok: true,
      engine: 'qwen3-tts-cuda-graph',
      device: 'NVIDIA RTX 4060',
      elapsedMs: 20_052,
      attempt: 1,
    });

    await expect(first).resolves.toMatchObject({
      status: 'ready',
      engine: 'qwen3-tts-cuda-graph',
      elapsedMs: 20_052,
      attempt: 1,
    });
    expect(controller.getState().warmup).toMatchObject({ status: 'ready', engine: 'qwen3-tts-cuda-graph' });
  });

  it('turns warmup IPC rejection into a resolved failure and can explicitly retry once', async () => {
    const desktop = {
      warmSpeechOutput: vi.fn()
        .mockRejectedValueOnce(new Error('Файл подкачки слишком мал (os error 1455)'))
        .mockResolvedValueOnce({ status: 'ready', ok: true, engine: 'qwen3-tts-cuda-graph', attempt: 2 }),
    };
    const controller = createOscarSpeechController({
      desktop,
      speechSynthesis: undefined,
      Utterance: undefined,
    });

    await expect(controller.prewarm()).resolves.toMatchObject({
      status: 'failed',
      ok: false,
      error: 'speech-warmup-ipc-failed',
      summary: expect.stringContaining('1455'),
    });
    await expect(controller.retryWarmup()).resolves.toMatchObject({
      status: 'ready',
      ok: true,
      attempt: 2,
    });
    expect(desktop.warmSpeechOutput).toHaveBeenNthCalledWith(2, { retry: true });
  });

  it('normalizes failed warmup diagnostics without leaking unbounded fields', () => {
    expect(normalizeSpeechWarmupResult({
      status: 'failed',
      ok: false,
      error: 'neural-tts-startup-failed',
      summary: `${'x'.repeat(900)} secret-tail`,
      text: 'must-not-leak',
    })).toEqual({
      status: 'failed',
      ok: false,
      engine: '',
      error: 'neural-tts-startup-failed',
      summary: 'x'.repeat(800),
      elapsedMs: 0,
    });
  });

  it('uses the trusted desktop engine and toggles the same answer to stop', async () => {
    let finishSpeech: (value: unknown) => void = () => undefined;
    let publishTelemetry: (value: unknown) => void = () => undefined;
    const desktop = {
      speakText: vi.fn(() => new Promise((resolve) => { finishSpeech = resolve; })),
      stopSpeaking: vi.fn(() => Promise.resolve({ ok: true })),
      onSpeechTelemetry: vi.fn((listener: (value: unknown) => void) => {
        publishTelemetry = listener;
        return vi.fn();
      }),
    };
    const states: Array<{ status: string; messageId: string }> = [];
    const audioFrames: Array<{ level: number }> = [];
    const controller = createOscarSpeechController({
      desktop,
      speechSynthesis: undefined,
      Utterance: undefined,
      getPreferences: () => ({
        voice: 'aurora',
        style: 'warm',
        speed: 92,
        pitch: -1,
        expressiveness: 72,
        pauseMs: 150,
        volume: 78,
        instruction: 'Мягко.',
      }),
      onStateChange: (value) => states.push(value),
      onAudioFrame: (value) => audioFrames.push(value),
    });

    expect(controller.toggle({ messageId: 'answer-1', text: 'Полный ответ Oscar.' })).toMatchObject({
      ok: true,
      engine: 'neural',
    });
    expect(controller.getState()).toMatchObject({ status: 'speaking', messageId: 'answer-1' });
    expect(desktop.speakText).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Полный ответ Oscar.',
      language: 'ru-RU',
      voice: 'aurora',
      style: 'warm',
      speed: 92,
      pitch: -1,
      expressiveness: 72,
      pauseMs: 150,
      volume: 78,
      instruction: 'Мягко.',
    }));
    publishTelemetry({ id: 'speech-1', sequence: 1, rms: 0.0625, peak: 0.7, brightness: 0.4 });
    expect(audioFrames.at(-1)).toMatchObject({ level: 0.8, peak: 0.7, brightness: 0.4, source: 'tts' });

    expect(controller.toggle({ messageId: 'answer-1', text: 'Полный ответ Oscar.' })).toEqual({ ok: true, stopped: true });
    expect(desktop.stopSpeaking).toHaveBeenCalled();
    expect(controller.getState().status).toBe('idle');
    expect(audioFrames.at(-1)).toMatchObject({ level: 0, peak: 0, brightness: 0 });

    finishSpeech({ ok: true });
    await Promise.resolve();
    expect(states.at(-1)?.status).toBe('idle');
  });

  it('preserves a late partial Qwen failure without relabeling it as a fresh playback', async () => {
    const desktop = {
      speakText: vi.fn().mockResolvedValue({
        ok: false,
        engine: 'qwen3-tts-cuda-graph',
        error: 'neural-tts-completion-timeout',
        summary: 'Нейросетевой голос остановился после начала воспроизведения.',
        playbackStarted: true,
        partial: true,
      }),
    };
    const controller = createOscarSpeechController({
      desktop,
      speechSynthesis: undefined,
      Utterance: undefined,
      getPreferences: () => ({ voice: 'oscar' }),
    });

    controller.toggle({ messageId: 'answer-partial', text: 'Длинный ответ Oscar.' });
    await Promise.resolve();
    await Promise.resolve();

    expect(controller.getState()).toMatchObject({
      status: 'error',
      messageId: 'answer-partial',
      engine: 'qwen3-tts-cuda-graph',
      playback: {
        status: 'failed',
        playbackStarted: true,
        partial: true,
        fallback: false,
      },
    });
  });

  it('reads every browser chunk in order when desktop IPC is unavailable', async () => {
    const spoken: string[] = [];
    class FakeUtterance {
      text: string;
      lang = '';
      rate = 1;
      pitch = 1;
      voice = null;
      onend: null | (() => void) = null;
      onerror: null | ((event: unknown) => void) = null;
      constructor(text: string) { this.text = text; }
    }
    const speechSynthesis = {
      getVoices: () => [{ name: 'Microsoft Pavel', lang: 'ru-RU', localService: true }],
      cancel: vi.fn(),
      speak: vi.fn((utterance: FakeUtterance) => {
        spoken.push(utterance.text);
        queueMicrotask(() => utterance.onend?.());
      }),
    };
    const controller = createOscarSpeechController({
      desktop: undefined,
      speechSynthesis,
      Utterance: FakeUtterance,
    });
    const text = Array.from({ length: 20 }, (_, index) => `Это часть ${index + 1} полного ответа.`).join(' ');

    const started = controller.toggle({ messageId: 'answer-2', text });
    expect(started).toMatchObject({ ok: true, engine: 'browser' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spoken.length).toBeGreaterThan(1);
    expect(spoken.join(' ')).toBe(normalizeTextForSpeech(text));
    expect(controller.getState().status).toBe('idle');
  });
});

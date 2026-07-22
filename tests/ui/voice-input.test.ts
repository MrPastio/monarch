import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendVoiceText,
  attachVoiceInput,
  canUseAudioRecorder,
  composeVoiceDraft,
  formatVoiceTranscript,
  formatVoiceInputError,
  initVoiceInput,
  normalizeSpeechLanguage,
  normalizeTranscript,
  preferredRecordingMimeType,
  readSpeechLanguage,
  selectVoiceInputMode,
  VOICE_RECORDING_LIMITS,
} from '../../src/ui/public/modules/voice-input.js';

class FakeElement {
  disabled = false;
  hidden = false;
  tabIndex = 0;
  title = '';
  textContent = '';
  value = '';
  dataset: Record<string, string> = {};
  private attributes = new Map<string, string>();
  private listeners = new Map<string, Array<(event: Event) => void>>();
  private classes = new Set<string>();

  classList = {
    add: (...names: string[]) => {
      names.forEach((name) => this.classes.add(name));
    },
    remove: (...names: string[]) => {
      names.forEach((name) => this.classes.delete(name));
    },
    contains: (name: string) => this.classes.has(name),
  };

  addEventListener(type: string, listener: (event: Event) => void) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: Event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
    }
    return true;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) || null;
  }
}

class CompletingMediaRecorderMock {
  static instances: CompletingMediaRecorderMock[] = [];

  static isTypeSupported(type: string) {
    return type === 'audio/webm';
  }

  state = 'inactive';
  stopCalls = 0;
  ondataavailable: ((event: { data?: Blob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor() {
    CompletingMediaRecorderMock.instances.push(this);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.stopCalls += 1;
    this.ondataavailable?.({ data: new Blob(['voice-data'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createCompletingHarness(
  transcribeAudio: (input: Record<string, unknown>) => Promise<string>,
  callbacks: Record<string, unknown> = {},
) {
  CompletingMediaRecorderMock.instances = [];
  const form = new FakeElement();
  const input = new FakeElement();
  const button = new FakeElement();
  const status = new FakeElement();
  const statusTitle = new FakeElement();
  const statusPreview = new FakeElement();
  const cancelButton = new FakeElement();
  const track = { stop: vi.fn() };
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  const win = {
    MediaRecorder: CompletingMediaRecorderMock,
    navigator: {
      language: 'ru-RU',
      languages: ['ru-RU'],
      mediaDevices: { getUserMedia },
    },
  };
  const controller = attachVoiceInput({
    form,
    input,
    button,
    status,
    statusTitle,
    statusPreview,
    cancelButton,
    windowObject: win,
    transcribeAudio,
    encodeAudio: vi.fn(async () => 'dm9pY2UtZGF0YQ=='),
    ...callbacks,
  });
  return {
    form,
    input,
    button,
    status,
    statusTitle,
    statusPreview,
    cancelButton,
    track,
    getUserMedia,
    controller,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('voice input helpers', () => {
  it('binds the same local-first dictation controller to command and Oscar composers', () => {
    const selectors = new Map<string, FakeElement>();
    [
      '#composer',
      '#intent-input',
      '#intent-voice-input',
      '#intent-voice-status',
      '#intent-voice-status [data-voice-title]',
      '#intent-voice-status [data-voice-preview]',
      '#intent-voice-cancel',
      '#oscar-composer',
      '#oscar-input',
      '#oscar-voice-input',
      '#oscar-voice-status',
      '#oscar-voice-status [data-voice-title]',
      '#oscar-voice-status [data-voice-preview]',
      '#oscar-voice-cancel',
    ].forEach((selector) => selectors.set(selector, new FakeElement()));
    const root = {
      querySelector: (selector: string) => selectors.get(selector) || null,
    };

    const controllers = initVoiceInput(root);

    expect(controllers).toHaveLength(2);
    expect(selectors.get('#oscar-voice-input')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('normalizes speech fragments before inserting them', () => {
    expect(normalizeTranscript('  привет   Monarch \n  как дела  ')).toBe('привет Monarch как дела');
    expect(normalizeTranscript('����')).toBe('');
    expect(normalizeTranscript('при\u0000вет')).toBe('при вет');
  });

  it('normalizes speech locale from the first browser language without using document language', () => {
    vi.stubGlobal('document', { documentElement: { lang: 'ru' } });

    expect(readSpeechLanguage({
      navigator: { languages: ['uk-UA', 'ru-RU'], language: 'ru-RU' },
    })).toBe('uk-UA');
    expect(readSpeechLanguage({
      navigator: { languages: ['bg-BG'], language: 'en-US' },
    })).toBe('bg-BG');
    expect(readSpeechLanguage({
      navigator: { languages: ['en-GB'], language: 'ru-RU' },
    })).toBe('en-US');
    expect(normalizeSpeechLanguage('de-DE')).toBe('ru-RU');
    expect(normalizeSpeechLanguage('ua-UA')).toBe('uk-UA');
  });

  it.each([
    ['ru-RU', 'привет запятая как дела вопросительный знак', 'Привет, как дела?'],
    ['uk-UA', 'привіт кома як справи знак питання', 'Привіт, як справи?'],
    ['bg-BG', 'здравей запетая как си въпросителен знак', 'Здравей, как си?'],
    ['en-US', 'hello comma how are you question mark', 'Hello, how are you?'],
  ])('formats spoken punctuation for %s', (language, transcript, expected) => {
    expect(formatVoiceTranscript(transcript, language)).toBe(expected);
  });

  it('capitalizes sentence starts, infers conservative questions, and preserves explicit exclamation', () => {
    expect(formatVoiceTranscript('сколько времени', 'ru-RU')).toBe('Сколько времени?');
    expect(formatVoiceTranscript('де ти зараз', 'uk-UA')).toBe('Де ти зараз?');
    expect(formatVoiceTranscript('къде си', 'bg-BG')).toBe('Къде си?');
    expect(formatVoiceTranscript('where are you', 'en-US')).toBe('Where are you?');
    expect(formatVoiceTranscript('это важно восклицательный знак', 'ru-RU')).toBe('Это важно!');
    expect(formatVoiceTranscript('привет точка как дела вопросительный знак', 'ru-RU')).toBe('Привет. Как дела?');
    expect(formatVoiceTranscript('это готовое предложение', 'ru-RU')).toBe('Это готовое предложение.');
  });

  it('does not alter URLs, file names, or decimal numbers', () => {
    expect(formatVoiceTranscript(
      'открой https://example.com/README.md версия 1.2',
      'ru-RU',
    )).toBe('Открой https://example.com/README.md версия 1.2');
    expect(formatVoiceTranscript('где README.md', 'ru-RU')).toBe('Где README.md?');
  });

  it('appends recognized speech to an existing draft like a chat composer', () => {
    expect(composeVoiceDraft('Проверь', 'локальный backend', 'и память')).toBe('Проверь локальный backend и память');
    expect(composeVoiceDraft('', 'создай файл', '')).toBe('создай файл');
  });

  it('does not add a space before spoken punctuation', () => {
    expect(appendVoiceText('Готово', ', продолжай')).toBe('Готово, продолжай');
    expect(appendVoiceText('Открой ', 'проект')).toBe('Открой проект');
  });

  it('detects the local recording fallback', () => {
    class MediaRecorderMock {
      static isTypeSupported(type: string) {
        return type === 'audio/webm';
      }
    }

    const win = {
      MediaRecorder: MediaRecorderMock,
      navigator: {
        mediaDevices: {
          getUserMedia: () => Promise.resolve({}),
        },
      },
    };

    expect(canUseAudioRecorder(win)).toBe(true);
    expect(preferredRecordingMimeType(win)).toBe('audio/webm');
    expect(canUseAudioRecorder({ MediaRecorder: MediaRecorderMock })).toBe(false);
  });

  it('prefers local recording over browser speech recognition for local-first voice input', () => {
    class SpeechRecognitionMock {}
    class MediaRecorderMock {
      static isTypeSupported(type: string) {
        return type === 'audio/webm';
      }
    }

    expect(selectVoiceInputMode({
      SpeechRecognition: SpeechRecognitionMock,
      MediaRecorder: MediaRecorderMock,
      navigator: {
        mediaDevices: {
          getUserMedia: () => Promise.resolve({}),
        },
      },
    })).toBe('local-recorder');
    expect(selectVoiceInputMode({ SpeechRecognition: SpeechRecognitionMock })).toBeNull();
  });

  it('allows long-form local dictation while retaining a resource safety envelope', () => {
    expect(VOICE_RECORDING_LIMITS.minMs).toBeGreaterThanOrEqual(400);
    expect(VOICE_RECORDING_LIMITS.maxMs).toBe(10 * 60_000);
    expect(VOICE_RECORDING_LIMITS.maxBytes).toBe(32 * 1024 * 1024);
  });

  it('does not stop composer dictation at the former 12-second boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createCompletingHarness(vi.fn(async () => 'длинная диктовка'));

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(12_500);

    expect(CompletingMediaRecorderMock.instances[0]?.stopCalls).toBe(0);
    expect(harness.controller?.isListening()).toBe(true);
    expect(harness.statusPreview.textContent).toContain('нажми микрофон');

    await vi.advanceTimersByTimeAsync(VOICE_RECORDING_LIMITS.maxMs - 12_500);
    await flushPromises();
    expect(CompletingMediaRecorderMock.instances[0]?.stopCalls).toBe(1);
  });

  it('maps technical local STT failures to short visible messages', () => {
    const timeoutError = Object.assign(new Error('Локальная STT-команда не успела завершиться за 45 секунд.'), {
      code: 'voice-stt-timeout',
    });
    const emptyError = Object.assign(new Error('Локальный STT завершился без текста.'), {
      result: { error: 'voice-stt-empty-transcript' },
    });

    expect(formatVoiceInputError(timeoutError)).toBe('Распознавание заняло слишком долго. Скажи короче.');
    expect(formatVoiceInputError(emptyError)).toBe('Речь не распознана');
  });

  it('uses one starting session and stops a late permission stream after cancel', async () => {
    vi.useFakeTimers();
    const permission = deferred<{ getTracks: () => Array<{ stop: ReturnType<typeof vi.fn> }> }>();
    const track = { stop: vi.fn() };
    class MediaRecorderMock {
      static instances: MediaRecorderMock[] = [];
      static isTypeSupported() { return true; }
      constructor() { MediaRecorderMock.instances.push(this); }
    }
    const form = new FakeElement();
    const input = new FakeElement();
    const button = new FakeElement();
    const status = new FakeElement();
    const cancelButton = new FakeElement();
    const getUserMedia = vi.fn(() => permission.promise);
    const controller = attachVoiceInput({
      form,
      input,
      button,
      status,
      cancelButton,
      windowObject: {
        MediaRecorder: MediaRecorderMock,
        navigator: { mediaDevices: { getUserMedia } },
      },
    });

    button.dispatchEvent(new Event('click'));
    button.dispatchEvent(new Event('click'));

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(controller?.isListening()).toBe(true);
    expect(button.disabled).toBe(true);
    expect(cancelButton.hidden).toBe(false);

    cancelButton.dispatchEvent(new Event('click'));
    expect(controller?.isListening()).toBe(false);
    expect(cancelButton.hidden).toBe(true);

    permission.resolve({ getTracks: () => [track] });
    await flushPromises();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(MediaRecorderMock.instances).toHaveLength(0);
  });

  it('does not request the microphone while the host mode is muted', async () => {
    let canStart = false;
    const harness = createCompletingHarness(vi.fn(async () => ''), {
      canStart: () => canStart,
    });

    expect(harness.button.disabled).toBe(true);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    expect(harness.getUserMedia).not.toHaveBeenCalled();

    canStart = true;
    harness.controller?.refreshAvailability();
    expect(harness.button.disabled).toBe(false);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    harness.controller?.cancel();
  });

  it('uses the voice orb as a busy-state interrupt without opening the microphone', async () => {
    let interruptible = true;
    const onBusyActivate = vi.fn();
    const harness = createCompletingHarness(vi.fn(async () => ''), {
      canActivateWhileBusy: () => interruptible,
      onBusyActivate,
    });
    harness.form.setAttribute('aria-busy', 'true');
    harness.controller?.refreshAvailability();

    expect(harness.button.disabled).toBe(false);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(onBusyActivate).toHaveBeenCalledTimes(1);
    expect(harness.getUserMedia).not.toHaveBeenCalled();

    interruptible = false;
    harness.controller?.refreshAvailability();
    expect(harness.button.disabled).toBe(true);
  });

  it('can recycle an armed voice-mode recorder without showing cancellation feedback', async () => {
    const onStateChange = vi.fn();
    const harness = createCompletingHarness(vi.fn(async () => ''), { onStateChange });

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    expect(harness.controller?.isListening()).toBe(true);

    harness.controller?.cancelSilently();

    expect(harness.controller?.isListening()).toBe(false);
    expect(harness.track.stop).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ hidden: true }));
    expect(harness.statusTitle.textContent).not.toBe('Отменено');
  });

  it('merges a final transcript into the current draft and hides cancel in done state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transcript = deferred<string>();
    const transcribeAudio = vi.fn(() => transcript.promise);
    const harness = createCompletingHarness(transcribeAudio);
    harness.input.value = 'Старый draft';

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    harness.input.value = 'Текущий draft';
    transcript.resolve('где файл');
    await flushPromises();

    expect(harness.input.value).toBe('Текущий draft где файл?');
    expect(harness.input.value).not.toContain('Старый draft');
    expect(harness.status.dataset.state).toBe('done');
    expect(harness.cancelButton.hidden).toBe(true);
    expect(harness.cancelButton.disabled).toBe(true);
    expect(harness.cancelButton.getAttribute('aria-hidden')).toBe('true');
    expect(harness.controller?.isListening()).toBe(false);
  });

  it('uses direct PCM final text and keeps MediaRecorder only as a parallel failsafe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transcribeAudio = vi.fn(async () => 'старый fallback');
    const stopPcm = vi.fn(async () => ({
      transcript: 'быстрый прямой текст',
      enginePath: 'direct-pcm/sherpa-onnx-t-one',
      captureStopToFinalMs: 42,
    }));
    const harness = createCompletingHarness(transcribeAudio, {
      createPcmStream: vi.fn(async () => ({ stop: stopPcm, cancel: vi.fn(async () => undefined) })),
    });

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    await flushPromises();

    expect(stopPcm).toHaveBeenCalledWith(1_700);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(harness.input.value).toBe('Быстрый прямой текст.');
    expect(harness.status.dataset.state).toBe('done');
  });

  it('falls back to the parallel MediaRecorder clip when direct PCM fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transcribeAudio = vi.fn(async () => 'надёжный fallback');
    const harness = createCompletingHarness(transcribeAudio, {
      createPcmStream: vi.fn(async () => ({
        stop: vi.fn(async () => { throw new Error('stream worker gone'); }),
        cancel: vi.fn(async () => undefined),
      })),
    });

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    await flushPromises();
    await flushPromises();

    expect(transcribeAudio).toHaveBeenCalledOnce();
    expect(harness.input.value).toBe('Надёжный fallback.');
  });

  it('publishes capture state, stream ownership, and the final transcript to voice mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onStateChange = vi.fn();
    const onStream = vi.fn();
    const onTranscript = vi.fn();
    const harness = createCompletingHarness(vi.fn(async () => 'готовый ответ'), {
      insertTranscript: false,
      onStateChange,
      onStream,
      onTranscript,
    });

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(harness.input.value).toBe('');
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'listening' }));
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ state: 'recognizing' }));
    expect(onStream.mock.calls[0]?.[0]).toBeTruthy();
    expect(onStream).toHaveBeenLastCalledWith(null);
    expect(onTranscript).toHaveBeenCalledWith({ transcript: 'Готовый ответ.', language: 'ru-RU' });
  });

  it('keeps a stopped clip alive when voice mode marks itself busy for recognition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transcribeAudio = vi.fn(async () => 'ответ после распознавания');
    const onTranscript = vi.fn();
    let harness: ReturnType<typeof createCompletingHarness>;
    const onStateChange = vi.fn((captureState: { state?: string }) => {
      if (captureState.state !== 'recognizing') return;
      harness.form.setAttribute('aria-busy', 'true');
      harness.controller?.refreshAvailability();
    });
    harness = createCompletingHarness(transcribeAudio, {
      insertTranscript: false,
      onStateChange,
      onTranscript,
    });

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(harness.form.getAttribute('aria-busy')).toBe('true');
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith({
      transcript: 'Ответ после распознавания.',
      language: 'ru-RU',
    });
  });

  it('cancels recognition and ignores its late transcript', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transcript = deferred<string>();
    const transcribeAudio = vi.fn(() => transcript.promise);
    const harness = createCompletingHarness(transcribeAudio);
    harness.input.value = 'Черновик';

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    expect(harness.cancelButton.hidden).toBe(false);

    harness.input.value = 'Черновик пользователя';
    harness.cancelButton.dispatchEvent(new Event('click'));
    transcript.resolve('где старый файл');
    await flushPromises();

    expect(harness.input.value).toBe('Черновик пользователя');
    expect(harness.controller?.isListening()).toBe(false);
    expect(harness.cancelButton.hidden).toBe(true);
    const request = transcribeAudio.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(request.signal?.aborted).toBe(true);
  });

  it('cancels recognition on submit and never restores the submitted draft', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const transcript = deferred<string>();
    const harness = createCompletingHarness(vi.fn(() => transcript.promise));
    harness.input.value = 'Отправляемый draft';

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    harness.form.addEventListener('submit', () => {
      harness.input.value = '';
    });
    harness.form.dispatchEvent(new Event('submit'));

    expect(harness.controller?.isListening()).toBe(false);
    expect(harness.input.value).toBe('');
    transcript.resolve('поздний результат');
    await flushPromises();

    expect(harness.input.value).toBe('');
    expect(harness.cancelButton.hidden).toBe(true);
  });

  it('keeps the current draft and hides cancel after recognition error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createCompletingHarness(vi.fn(async () => {
      throw new Error('decoder failed');
    }));
    harness.input.value = 'Текущий текст';

    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();
    vi.setSystemTime(1_700);
    harness.button.dispatchEvent(new Event('click'));
    await flushPromises();

    expect(harness.input.value).toBe('Текущий текст');
    expect(harness.status.dataset.state).toBe('error');
    expect(harness.cancelButton.hidden).toBe(true);
    expect(harness.cancelButton.disabled).toBe(true);
  });

  it('does not reopen the recorder while a stopped clip is being recognized', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    class MediaRecorderMock {
      static instances: MediaRecorderMock[] = [];
      static isTypeSupported(type: string) {
        return type === 'audio/webm';
      }

      state = 'inactive';
      stopCalls = 0;
      ondataavailable: ((event: { data?: Blob }) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onstop: (() => void) | null = null;

      constructor() {
        MediaRecorderMock.instances.push(this);
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.stopCalls += 1;
      }
    }

    const form = new FakeElement();
    const input = new FakeElement();
    const button = new FakeElement();
    const status = new FakeElement();
    const statusTitle = new FakeElement();
    const statusPreview = new FakeElement();
    const track = { stop: vi.fn() };
    const win = {
      MediaRecorder: MediaRecorderMock,
      navigator: {
        language: 'ru-RU',
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })),
        },
      },
    };

    try {
      const controller = attachVoiceInput({
        form,
        input,
        button,
        status,
        statusTitle,
        statusPreview,
        windowObject: win,
      });

      button.dispatchEvent(new Event('click'));
      await Promise.resolve();
      expect(MediaRecorderMock.instances).toHaveLength(1);
      expect(controller?.isListening()).toBe(true);
      expect(button.getAttribute('aria-pressed')).toBe('true');

      vi.setSystemTime(1_700);
      button.dispatchEvent(new Event('click'));
      expect(MediaRecorderMock.instances[0].stopCalls).toBe(1);
      expect(controller?.isListening()).toBe(true);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe('true');

      button.dispatchEvent(new Event('click'));
      await Promise.resolve();
      expect(MediaRecorderMock.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { VoiceStreamingSttRuntime } from '../../src/modules/voice/voice-streaming-stt-runtime';

function prepare(engine: 'vosk' | 'sherpa-onnx-t-one') {
  return {
    status: 'ready' as const,
    engine,
    model: `fake-${engine}`,
    loadMs: 0,
    warm: true,
    pid: 123,
  };
}

function streamStart(engine: 'vosk' | 'sherpa-onnx-t-one') {
  return {
    engine,
    model: `fake-${engine}`,
    loadMs: 0,
    warm: true,
    sampleRate: 16_000,
    pid: 123,
  };
}

function createPrimary(overrides: Record<string, unknown> = {}) {
  return {
    prepare: vi.fn(async () => prepare('sherpa-onnx-t-one')),
    startStream: vi.fn(async () => streamStart('sherpa-onnx-t-one')),
    pushStream: vi.fn(async () => ({
      engine: 'sherpa-onnx-t-one' as const,
      partial: 'тест',
      sequence: 0,
      processingMs: 10,
      audioMs: 120,
      pid: 123,
    })),
    finishStream: vi.fn(async () => ({
      text: 'готово',
      engine: 'sherpa-onnx-t-one' as const,
      model: 'fake-sherpa',
      recognitionMs: 10,
      finalizeMs: 5,
      audioMs: 120,
      bytes: 3840,
      partialAgeMs: 5,
      pid: 123,
    })),
    cancelStream: vi.fn(async () => ({ cancelled: true, pid: 123 })),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => ({ state: 'ready' as const, engine: 'sherpa-onnx-t-one' as const }),
    ...overrides,
  };
}

function createFallback() {
  return {
    prepare: vi.fn(async () => prepare('vosk')),
    transcribe: vi.fn(),
    startStream: vi.fn(async () => streamStart('vosk')),
    pushStream: vi.fn(),
    finishStream: vi.fn(),
    cancelStream: vi.fn(async () => ({ cancelled: true })),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => ({ state: 'idle' as const, engine: 'vosk' as const }),
  };
}

describe('VoiceStreamingSttRuntime', () => {
  it('retires a failed T-one prepare before allocating the Vosk fallback', async () => {
    const order: string[] = [];
    const primary = createPrimary({
      prepare: vi.fn(async () => {
        order.push('sherpa:prepare');
        throw new Error('native prepare failed');
      }),
      shutdown: vi.fn(async () => {
        order.push('sherpa:shutdown');
      }),
    });
    const fallback = createFallback();
    fallback.prepare.mockImplementation(async () => {
      order.push('vosk:prepare');
      return prepare('vosk');
    });
    const runtime = new VoiceStreamingSttRuntime({ primary, fallback });

    await expect(runtime.prepare('ru-RU')).resolves.toMatchObject({ engine: 'vosk' });
    expect(order).toEqual(['sherpa:prepare', 'sherpa:shutdown', 'vosk:prepare']);
  });

  it('uses resident T-one for Russian direct PCM and keeps one-shot on Vosk', async () => {
    const primary = createPrimary();
    const fallback = createFallback();
    const runtime = new VoiceStreamingSttRuntime({ primary, fallback });

    const started = await runtime.startStream({
      streamId: 'stream_primary_123',
      language: 'ru-RU',
      sampleRate: 16_000,
    });
    const final = await runtime.finishStream('stream_primary_123');

    expect(started.engine).toBe('sherpa-onnx-t-one');
    expect(final.text).toBe('готово');
    expect(primary.startStream).toHaveBeenCalledOnce();
    expect(fallback.startStream).not.toHaveBeenCalled();
    expect(runtime.snapshot().activeStreams).toBe(0);
  });

  it('best-effort cancels a failed finish and always forgets its engine mapping', async () => {
    const finishError = new Error('native finish crashed');
    const primary = createPrimary({ finishStream: vi.fn(async () => { throw finishError; }) });
    const runtime = new VoiceStreamingSttRuntime({ primary, fallback: createFallback() });
    await runtime.startStream({ streamId: 'stream_finish_fail', language: 'ru-RU', sampleRate: 16_000 });

    await expect(runtime.finishStream('stream_finish_fail')).rejects.toBe(finishError);

    expect(primary.cancelStream).toHaveBeenCalledWith('stream_finish_fail');
    expect(runtime.snapshot().activeStreams).toBe(0);
    await expect(runtime.cancelStream('stream_finish_fail')).resolves.toEqual({ cancelled: false });
  });

  it('forgets a stream even when remote cancellation fails', async () => {
    const primary = createPrimary({
      cancelStream: vi.fn(async () => { throw new Error('worker gone'); }),
    });
    const runtime = new VoiceStreamingSttRuntime({ primary, fallback: createFallback() });
    await runtime.startStream({ streamId: 'stream_cancel_fail', language: 'ru-RU', sampleRate: 16_000 });

    await expect(runtime.cancelStream('stream_cancel_fail')).rejects.toThrow('worker gone');
    expect(runtime.snapshot().activeStreams).toBe(0);
    await expect(runtime.cancelStream('stream_cancel_fail')).resolves.toEqual({ cancelled: false });
  });

  it('falls back to streaming Vosk when optional T-one cannot start', async () => {
    const primary = createPrimary({
      startStream: vi.fn(async () => { throw new Error('model absent'); }),
    });
    const fallback = createFallback();
    const runtime = new VoiceStreamingSttRuntime({ primary, fallback, primaryRetryMs: 60_000 });

    const result = await runtime.startStream({
      streamId: 'stream_fallback_123',
      language: 'ru-RU',
      sampleRate: 16_000,
    });

    expect(result.engine).toBe('vosk');
    expect(fallback.startStream).toHaveBeenCalledOnce();
  });
});

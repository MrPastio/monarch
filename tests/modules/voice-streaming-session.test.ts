import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceModule } from '../../src/modules/voice';

const previousCommand = process.env.MONARCH_STT_TRANSCRIBE_COMMAND;
const previousDisabled = process.env.MONARCH_DISABLE_DEFAULT_STT;

beforeEach(() => {
  delete process.env.MONARCH_STT_TRANSCRIBE_COMMAND;
  delete process.env.MONARCH_DISABLE_DEFAULT_STT;
});

afterEach(() => {
  vi.useRealTimers();
  restoreEnv('MONARCH_STT_TRANSCRIBE_COMMAND', previousCommand);
  restoreEnv('MONARCH_DISABLE_DEFAULT_STT', previousDisabled);
});

describe('VoiceModule direct PCM sessions', () => {
  it('binds crypto sessions to one client and enforces exact sequence without persisting PCM', async () => {
    const runtime = createStreamingRuntime();
    const voice = new VoiceModule(createVoiceModels() as any, runtime as any);
    const context = createContext();

    const first = await execute(voice, context, 'voice.transcribe.stream.start', {
      language: 'ru-RU', sampleRate: 16_000,
    }, 'ui:voice:client-a');
    const firstId = (first.output as any).sessionId as string;
    expect(firstId).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const denied = await execute(voice, context, 'voice.transcribe.stream.push', {
      sessionId: firstId,
      sequence: 0,
      pcmBase64: Buffer.alloc(320).toString('base64'),
    }, 'ui:voice:client-b');
    expect(denied).toMatchObject({ ok: false, error: 'voice-stt-stream-not-found' });

    const pushed = await execute(voice, context, 'voice.transcribe.stream.push', {
      sessionId: firstId,
      sequence: 0,
      pcmBase64: Buffer.alloc(320).toString('base64'),
    }, 'ui:voice:client-a');
    expect(pushed).toMatchObject({
      ok: true,
      output: { sequence: 0, enginePath: 'direct-pcm/sherpa-onnx-t-one' },
    });

    const replay = await execute(voice, context, 'voice.transcribe.stream.push', {
      sessionId: firstId,
      sequence: 0,
      pcmBase64: Buffer.alloc(320).toString('base64'),
    }, 'ui:voice:client-a');
    expect(replay).toMatchObject({
      ok: false,
      error: 'voice-stt-stream-sequence',
      output: { expectedSequence: 1 },
    });

    const second = await execute(voice, context, 'voice.transcribe.stream.start', {
      language: 'ru-RU', sampleRate: 16_000,
    }, 'ui:voice:client-a');
    expect((second.output as any).sessionId).not.toBe(firstId);
    expect(runtime.cancelStream).toHaveBeenCalledWith(firstId);
    await voice.deactivate(context as any);
  });

  it('returns final-tail latency telemetry and emits no raw or partial audio event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const runtime = createStreamingRuntime();
    const voice = new VoiceModule(createVoiceModels() as any, runtime as any);
    const context = createContext();
    const start = await execute(voice, context, 'voice.transcribe.stream.start', {
      language: 'ru-RU', sampleRate: 16_000,
    }, 'ui:voice:client-a');
    const sessionId = (start.output as any).sessionId;
    await execute(voice, context, 'voice.transcribe.stream.push', {
      sessionId,
      sequence: 0,
      pcmBase64: Buffer.alloc(320).toString('base64'),
    }, 'ui:voice:client-a');
    vi.setSystemTime(10_040);

    const final = await execute(voice, context, 'voice.transcribe.stream.finish', {
      sessionId,
      captureStoppedAtEpochMs: 10_000,
    }, 'ui:voice:client-a');

    expect(final).toMatchObject({
      ok: true,
      output: {
        transcript: 'готово',
        enginePath: 'direct-pcm/sherpa-onnx-t-one',
        captureStopToFinalMs: 40,
        finalizeMs: 12,
      },
    });
    const emitted = context.emit.mock.calls.map((call) => call[2]);
    expect(JSON.stringify(emitted)).not.toContain('pcmBase64');
    expect(JSON.stringify(emitted)).not.toContain('частичный');
    await voice.deactivate(context as any);
  });

  it('expires the server session and cancels its resident worker stream', async () => {
    vi.useFakeTimers();
    const runtime = createStreamingRuntime();
    const voice = new VoiceModule(createVoiceModels() as any, runtime as any);
    const context = createContext();
    const start = await execute(voice, context, 'voice.transcribe.stream.start', {
      language: 'ru-RU', sampleRate: 16_000,
    }, 'ui:voice:ttl-client');
    const sessionId = (start.output as any).sessionId;

    await vi.advanceTimersByTimeAsync(45_001);

    expect(runtime.cancelStream).toHaveBeenCalledWith(sessionId);
    const push = await execute(voice, context, 'voice.transcribe.stream.push', {
      sessionId,
      sequence: 0,
      pcmBase64: Buffer.alloc(320).toString('base64'),
    }, 'ui:voice:ttl-client');
    expect(push).toMatchObject({ ok: false, error: 'voice-stt-stream-not-found' });
    await voice.deactivate(context as any);
  });

  it('treats the server TTL as inactivity and accepts PCM beyond 30 seconds', async () => {
    vi.useFakeTimers();
    const runtime = createStreamingRuntime();
    const voice = new VoiceModule(createVoiceModels() as any, runtime as any);
    const context = createContext();
    const start = await execute(voice, context, 'voice.transcribe.stream.start', {
      language: 'ru-RU', sampleRate: 16_000,
    }, 'ui:voice:long-form');
    const sessionId = (start.output as any).sessionId;

    for (let sequence = 0; sequence < 16; sequence += 1) {
      const pushed = await execute(voice, context, 'voice.transcribe.stream.push', {
        sessionId,
        sequence,
        pcmBase64: Buffer.alloc(62_000).toString('base64'),
      }, 'ui:voice:long-form');
      expect(pushed.ok).toBe(true);
      await vi.advanceTimersByTimeAsync(3_000);
    }

    expect(runtime.pushStream).toHaveBeenCalledTimes(16);
    expect(runtime.cancelStream).not.toHaveBeenCalledWith(sessionId);
    await vi.advanceTimersByTimeAsync(45_001);
    expect(runtime.cancelStream).toHaveBeenCalledWith(sessionId);
    await voice.deactivate(context as any);
  });

  it('best-effort cancels and forgets a session when remote finalization fails', async () => {
    const runtime = createStreamingRuntime();
    runtime.finishStream.mockRejectedValueOnce(new Error('worker crashed'));
    const voice = new VoiceModule(createVoiceModels() as any, runtime as any);
    const context = createContext();
    const start = await execute(voice, context, 'voice.transcribe.stream.start', {
      language: 'ru-RU', sampleRate: 16_000,
    }, 'ui:voice:finish-failure');
    const sessionId = (start.output as any).sessionId;

    const final = await execute(voice, context, 'voice.transcribe.stream.finish', {
      sessionId,
      captureStoppedAtEpochMs: Date.now(),
    }, 'ui:voice:finish-failure');

    expect(final).toMatchObject({ ok: false, error: 'voice-stt-stream-failed' });
    expect(runtime.cancelStream).toHaveBeenCalledWith(sessionId);
    const retry = await execute(voice, context, 'voice.transcribe.stream.cancel', {
      sessionId,
    }, 'ui:voice:finish-failure');
    expect(retry).toMatchObject({ ok: false, error: 'voice-stt-stream-not-found' });
  });

  it('keeps an explicit custom transcribe command on the MediaRecorder-only contract', async () => {
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = 'node runtime/custom-stt.cjs {audio} {language}';
    const runtime = createStreamingRuntime();
    const voice = new VoiceModule(createVoiceModels() as any, runtime as any);
    const result = await execute(voice, createContext(), 'voice.transcribe.stream.start', {
      language: 'ru-RU', sampleRate: 16_000,
    }, 'ui:voice:custom');

    expect(result).toMatchObject({ ok: false, error: 'voice-stt-stream-unavailable' });
    expect(runtime.startStream).not.toHaveBeenCalled();
  });
});

function createStreamingRuntime() {
  return {
    prepare: vi.fn(),
    transcribe: vi.fn(),
    startStream: vi.fn(async ({ sampleRate }: { sampleRate: number }) => ({
      engine: 'sherpa-onnx-t-one', model: 'fake-t-one', loadMs: 0, warm: true, sampleRate, pid: 321,
    })),
    pushStream: vi.fn(async ({ sequence }: { sequence: number }) => ({
      engine: 'sherpa-onnx-t-one', partial: 'частичный', sequence,
      processingMs: 9, audioMs: 120, pid: 321,
    })),
    finishStream: vi.fn(async () => ({
      text: 'готово', engine: 'sherpa-onnx-t-one', model: 'fake-t-one',
      recognitionMs: 9, finalizeMs: 12, audioMs: 120, bytes: 320, partialAgeMs: 25, pid: 321,
    })),
    cancelStream: vi.fn(async () => ({ cancelled: true })),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => ({ state: 'ready', engine: 'hybrid' }),
  };
}

function createVoiceModels() {
  return {
    prepare: vi.fn(),
    respond: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => ({ state: 'idle' }),
  };
}

function createContext() {
  return { emit: vi.fn(async () => undefined) };
}

function execute(
  voice: VoiceModule,
  context: ReturnType<typeof createContext>,
  capabilityId: string,
  input: unknown,
  requestedBy: string,
) {
  return voice.executeCapability({
    id: `exec_${Math.random().toString(36).slice(2)}`,
    intentId: 'intent_voice_stream',
    moduleId: 'voice',
    capabilityId,
    input,
    createdAt: new Date(0).toISOString(),
    requestedBy,
  }, context as any);
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

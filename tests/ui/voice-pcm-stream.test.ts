import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createVoicePcmStream } from '../../src/ui/public/modules/voice-pcm-stream.js';

describe('direct browser PCM transport', () => {
  it('keeps the AudioWorklet PCM-only, transferable, and free of persistence/network code', async () => {
    const source = await readFile(path.join(
      process.cwd(), 'src', 'ui', 'public', 'modules', 'voice-pcm-processor.js',
    ), 'utf8');

    expect(source).toContain("registerProcessor('monarch-voice-pcm'");
    expect(source).toContain('new Int16Array');
    expect(source).toContain('[pcm.buffer]');
    expect(source).not.toMatch(/fetch\s*\(|localStorage|sessionStorage|indexedDB|MediaRecorder/);
  });

  it('sends ordered PCM16 batches and finalizes with post-stop telemetry', async () => {
    const harness = createAudioWorkletHarness();
    const start = vi.fn(async () => ({ sessionId: 'session_123456789012345678901234', enginePath: 'direct-pcm/test' }));
    const push = vi.fn(async ({ sequence }: { sequence: number }) => ({
      sequence,
      partial: 'частичный текст',
      processingMs: 8,
      audioMs: 120,
      enginePath: 'direct-pcm/test',
    }));
    const finish = vi.fn(async () => ({
      transcript: 'готово',
      enginePath: 'direct-pcm/test',
      captureStopToFinalMs: 41,
      finalizeMs: 12,
      partialAgeMs: 20,
    }));
    const telemetry = vi.fn();
    const stream = await createVoicePcmStream({
      windowObject: harness.win,
      mediaStream: {},
      language: 'ru-RU',
      startSession: start,
      pushSession: push,
      finishSession: finish,
      cancelSession: vi.fn(),
      onTelemetry: telemetry,
    });
    harness.node.port.emitPcm(new ArrayBuffer(320));
    await flushPromises();

    const result = await stream.stop(5_000);

    expect(start).toHaveBeenCalledWith({ language: 'ru-RU', sampleRate: 16_000 });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session_123456789012345678901234',
      sequence: 0,
      pcmBase64: expect.any(String),
    }));
    expect(finish).toHaveBeenCalledWith({
      sessionId: 'session_123456789012345678901234',
      captureStoppedAtEpochMs: 5_000,
    });
    expect(result.transcript).toBe('готово');
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      type: 'partial',
      partialLength: 'частичный текст'.length,
    }));
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      type: 'final',
      captureStopToFinalMs: 41,
    }));
    expect(harness.context.close).toHaveBeenCalledOnce();
  });

  it('fails boundedly on an oversized queued batch and cancels the remote session', async () => {
    const harness = createAudioWorkletHarness();
    const cancel = vi.fn(async () => undefined);
    const stream = await createVoicePcmStream({
      windowObject: harness.win,
      mediaStream: {},
      startSession: vi.fn(async () => ({ sessionId: 'session_123456789012345678901234' })),
      pushSession: vi.fn(),
      finishSession: vi.fn(),
      cancelSession: cancel,
    });
    harness.node.port.emitPcm(new ArrayBuffer(64 * 1024 + 2));
    await flushPromises();

    await expect(stream.stop(5_000)).rejects.toMatchObject({ code: 'voice-stt-queue-overflow' });
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'session_123456789012345678901234' });
  });
});

function createAudioWorkletHarness() {
  class FakePort {
    onmessage: ((event: { data: any }) => void) | null = null;
    listeners = new Set<(event: { data: any }) => void>();
    postMessage = vi.fn((message: { type?: string }) => {
      if (message.type !== 'flush') return;
      queueMicrotask(() => {
        const event = { data: { type: 'flushed' } };
        for (const listener of this.listeners) listener(event);
      });
    });
    addEventListener(_type: string, listener: (event: { data: any }) => void) { this.listeners.add(listener); }
    removeEventListener(_type: string, listener: (event: { data: any }) => void) { this.listeners.delete(listener); }
    start() {}
    emitPcm(pcm: ArrayBuffer) { this.onmessage?.({ data: { type: 'pcm', pcm } }); }
  }
  class FakeAudioWorkletNode {
    static last: FakeAudioWorkletNode;
    port = new FakePort();
    connect = vi.fn();
    disconnect = vi.fn();
    constructor() { FakeAudioWorkletNode.last = this; }
  }
  const graphNode = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const gain = { ...graphNode(), gain: { value: 1 } };
  const context = {
    sampleRate: 16_000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(graphNode),
    createGain: vi.fn(() => gain),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  class FakeAudioContext {
    constructor() { return context; }
  }
  const win = {
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    navigator: { mediaDevices: { getUserMedia: vi.fn() } },
  };
  return {
    win,
    context,
    get node() { return FakeAudioWorkletNode.last; },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

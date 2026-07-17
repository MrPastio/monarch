import {
  VoiceSttRuntime,
  VoiceSttRuntimeError,
  type VoiceSttPrepareResult,
  type VoiceSttRuntimePort,
  type VoiceSttRuntimeSnapshot,
  type VoiceSttStreamCancelResult,
  type VoiceSttStreamFinalResult,
  type VoiceSttStreamPushInput,
  type VoiceSttStreamPushResult,
  type VoiceSttStreamStartInput,
  type VoiceSttStreamStartResult,
  type VoiceSttTranscribeInput,
  type VoiceSttTranscribeResult,
} from './voice-stt-runtime';
import { SherpaVoiceSttRuntime } from './voice-sherpa-runtime';

type StreamingEngine = 'sherpa' | 'vosk';

interface StreamingRuntimePort {
  prepare(language?: string): Promise<VoiceSttPrepareResult>;
  startStream(input: VoiceSttStreamStartInput): Promise<VoiceSttStreamStartResult>;
  pushStream(input: VoiceSttStreamPushInput): Promise<VoiceSttStreamPushResult>;
  finishStream(streamId: string): Promise<VoiceSttStreamFinalResult>;
  cancelStream(streamId: string): Promise<VoiceSttStreamCancelResult>;
  shutdown(): Promise<void>;
  snapshot(): VoiceSttRuntimeSnapshot;
}

export interface VoiceStreamingSttRuntimeOptions {
  primary?: StreamingRuntimePort;
  fallback?: VoiceSttRuntimePort;
  primaryRetryMs?: number;
}

/**
 * Routes Russian live PCM to resident T-one in an isolated child process.
 * Vosk remains a truthful live fallback and the only MediaRecorder one-shot path.
 */
export class VoiceStreamingSttRuntime implements VoiceSttRuntimePort {
  private readonly primary: StreamingRuntimePort;
  private readonly fallback: VoiceSttRuntimePort;
  private readonly primaryRetryMs: number;
  private readonly streams = new Map<string, StreamingEngine>();
  private primaryRetryAt = 0;
  private lastPrimaryError: string | undefined;

  constructor(options: VoiceStreamingSttRuntimeOptions = {}) {
    this.primary = options.primary || new SherpaVoiceSttRuntime();
    this.fallback = options.fallback || new VoiceSttRuntime();
    this.primaryRetryMs = Number.isFinite(options.primaryRetryMs)
      ? Math.min(300_000, Math.max(0, Math.floor(options.primaryRetryMs!)))
      : 30_000;
  }

  async prepare(language = 'ru-RU'): Promise<VoiceSttPrepareResult> {
    if (isRussian(language) && Date.now() >= this.primaryRetryAt) {
      try {
        const result = await this.primary.prepare(language);
        this.primaryRetryAt = 0;
        this.lastPrimaryError = undefined;
        return result;
      } catch (error) {
        // A failed native prepare can leave a half-initialized Node child alive.
        // Retire it completely before allocating the Vosk fallback so both
        // recognizers never overlap under memory pressure.
        try {
          await this.primary.shutdown();
        } catch (retirementError) {
          this.markPrimaryUnavailable(error);
          throw retirementError;
        }
        this.markPrimaryUnavailable(error);
      }
    }
    return this.fallback.prepare(language);
  }

  transcribe(input: VoiceSttTranscribeInput): Promise<VoiceSttTranscribeResult> {
    return this.fallback.transcribe(input);
  }

  async startStream(input: VoiceSttStreamStartInput): Promise<VoiceSttStreamStartResult> {
    if (this.streams.has(input.streamId)) {
      throw new VoiceSttRuntimeError('voice-stt-stream-conflict', 'STT stream уже существует.');
    }
    if (isRussian(input.language) && Date.now() >= this.primaryRetryAt) {
      try {
        const result = await this.primary.startStream(input);
        this.streams.set(input.streamId, 'sherpa');
        this.primaryRetryAt = 0;
        this.lastPrimaryError = undefined;
        return result;
      } catch (error) {
        await this.primary.cancelStream(input.streamId).catch(() => undefined);
        this.markPrimaryUnavailable(error);
      }
    }
    if (!this.fallback.startStream) {
      throw new VoiceSttRuntimeError(
        'voice-stt-stream-unavailable',
        'Streaming STT недоступен; используй MediaRecorder fallback.',
        this.lastPrimaryError ? { primaryError: this.lastPrimaryError } : {},
      );
    }
    const result = await this.fallback.startStream(input);
    this.streams.set(input.streamId, 'vosk');
    return result;
  }

  pushStream(input: VoiceSttStreamPushInput): Promise<VoiceSttStreamPushResult> {
    const engine = this.requireStream(input.streamId);
    if (engine === 'sherpa') return this.primary.pushStream(input);
    if (!this.fallback.pushStream) return Promise.reject(streamUnavailable());
    return this.fallback.pushStream(input);
  }

  async finishStream(streamId: string): Promise<VoiceSttStreamFinalResult> {
    const engine = this.requireStream(streamId);
    try {
      if (engine === 'sherpa') return await this.primary.finishStream(streamId);
      if (!this.fallback.finishStream) throw streamUnavailable();
      return await this.fallback.finishStream(streamId);
    } catch (error) {
      const cancel = engine === 'sherpa'
        ? this.primary.cancelStream(streamId)
        : this.fallback.cancelStream?.(streamId);
      await Promise.resolve(cancel).catch(() => undefined);
      throw error;
    } finally {
      this.streams.delete(streamId);
    }
  }

  async cancelStream(streamId: string): Promise<VoiceSttStreamCancelResult> {
    const engine = this.streams.get(streamId);
    if (!engine) return { cancelled: false };
    try {
      if (engine === 'sherpa') return await this.primary.cancelStream(streamId);
      return this.fallback.cancelStream ? await this.fallback.cancelStream(streamId) : { cancelled: false };
    } finally {
      this.streams.delete(streamId);
    }
  }

  snapshot(): VoiceSttRuntimeSnapshot & {
    primary: VoiceSttRuntimeSnapshot;
    fallback: VoiceSttRuntimeSnapshot;
    activeStreams: number;
    lastPrimaryError?: string;
  } {
    const primary = this.primary.snapshot();
    const fallback = this.fallback.snapshot();
    const state = primary.state === 'ready' || fallback.state === 'ready'
      ? 'ready'
      : primary.state === 'starting' || fallback.state === 'starting'
        ? 'starting'
        : primary.state === 'failed' && fallback.state === 'failed'
          ? 'failed'
          : 'idle';
    return {
      state,
      engine: 'hybrid',
      primary,
      fallback,
      activeStreams: this.streams.size,
      ...(this.lastPrimaryError ? { lastPrimaryError: this.lastPrimaryError } : {}),
    };
  }

  async shutdown(): Promise<void> {
    this.streams.clear();
    await Promise.allSettled([this.primary.shutdown(), this.fallback.shutdown()]);
  }

  private requireStream(streamId: string): StreamingEngine {
    const engine = this.streams.get(streamId);
    if (!engine) throw new VoiceSttRuntimeError('voice-stt-stream-not-found', 'STT stream не найден.');
    return engine;
  }

  private markPrimaryUnavailable(error: unknown): void {
    this.lastPrimaryError = error instanceof VoiceSttRuntimeError
      ? error.code
      : 'voice-stt-runtime-failed';
    this.primaryRetryAt = Date.now() + this.primaryRetryMs;
  }
}

function isRussian(language: string): boolean {
  return /^ru(?:-|$)/i.test(String(language || '').trim());
}

function streamUnavailable(): VoiceSttRuntimeError {
  return new VoiceSttRuntimeError(
    'voice-stt-stream-unavailable',
    'Streaming Vosk недоступен; используй MediaRecorder fallback.',
  );
}

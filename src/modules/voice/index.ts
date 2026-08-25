import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import readline from 'node:readline';
import path from 'node:path';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { permissionModeForRisk } from '../../core';
import { voiceManifest } from './manifest';
import {
  VoiceSttRuntimeError,
  type VoiceSttRuntimePort,
} from './voice-stt-runtime';
import { VoiceStreamingSttRuntime } from './voice-streaming-stt-runtime';

type VoiceBridgeKind = 'stt' | 'tts';
const MAX_TRANSCRIBE_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_TRANSCRIBE_AUDIO_MS = 10 * 60_000;
const TRANSCRIBE_BASE_TIMEOUT_MS = 45_000;
const MAX_TRANSCRIBE_TIMEOUT_MS = MAX_TRANSCRIBE_AUDIO_MS + 30_000;
const MAX_STREAMING_PCM_BYTES = 64 * 1024 * 1024;
const MAX_STREAMING_BATCH_BYTES = 64 * 1024;
const MAX_STREAMING_DURATION_MS = 10 * 60_000;
const MAX_STREAMING_SESSIONS = 4;
const STREAMING_SESSION_TTL_MS = 45_000;

interface VoiceBridgeRecord {
  bridge: VoiceBridgeKind;
  command: string;
  process: ChildProcessWithoutNullStreams;
  startedAt: string;
  running: boolean;
  stopRequested: boolean;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}

interface VoiceSttSession {
  id: string;
  clientKey: string;
  language: string;
  sampleRate: number;
  nextSequence: number;
  bytes: number;
  frames: number;
  createdAt: number;
  lastPartialAt: number | null;
  timer: NodeJS.Timeout | null;
}

export class VoiceModule implements MonarchModule {
  readonly manifest = voiceManifest;
  private readonly bridges = new Map<VoiceBridgeKind, VoiceBridgeRecord>();
  private readonly sttRuntime: VoiceSttRuntimePort;
  private readonly sttSessions = new Map<string, VoiceSttSession>();
  private readonly sttSessionByClient = new Map<string, string>();

  constructor(sttRuntime: VoiceSttRuntimePort = new VoiceStreamingSttRuntime()) {
    this.sttRuntime = sttRuntime;
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('voice.activated', this.manifest.id, this.statusPayload());
    if (usesDefaultVoskWorker() && shouldPrewarmDefaultSttOnActivate()) {
      void this.sttRuntime.prepare(defaultSttLanguage()).then(
        (result) => context.emit('voice.stt.ready', this.manifest.id, result),
        (error) => context.emit('voice.stt.warmup-failed', this.manifest.id, {
          error: error instanceof VoiceSttRuntimeError ? error.code : 'voice-stt-runtime-failed',
        }),
      );
    }
  }

  async deactivate(context: MonarchKernelContext): Promise<void> {
    for (const bridge of Array.from(this.bridges.keys())) {
      this.stopBridge(bridge, context);
    }
    await Promise.allSettled(Array.from(this.sttSessions.values(), (session) => (
      this.closeSttSession(session, true)
    )));
    await this.sttRuntime.shutdown();
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: 'Voice module ready.',
      output: this.statusPayload(),
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.toLowerCase();
    if (!mentionsVoiceSubsystem(text)) {
      return null;
    }

    if (/(start|launch)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'voice.bridge.start',
        confidence: 0.82,
        reason: 'User asks to start a voice bridge.',
        permissionMode: permissionModeForRisk('execute'),
        input: { bridge: inferBridge(text) },
      };
    }
    if (/(stop|shutdown)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'voice.bridge.stop',
        confidence: 0.82,
        reason: 'User asks to stop a voice bridge.',
        permissionMode: permissionModeForRisk('execute'),
        input: { bridge: inferBridge(text) },
      };
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'voice.status',
      confidence: 0.84,
      reason: 'User asks to inspect voice bridge status.',
      permissionMode: permissionModeForRisk('read'),
      input: {},
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'voice.status':
      return {
        ok: true,
        summary: 'Voice bridge status loaded.',
        output: this.statusPayload(),
      };
    case 'voice.transcribe.audio':
      return this.transcribeAudio(request.input, context);
    case 'voice.transcribe.stream.start':
      return this.startSttStream(request, context);
    case 'voice.transcribe.stream.push':
      return this.pushSttStream(request, context);
    case 'voice.transcribe.stream.finish':
      return this.finishSttStream(request, context);
    case 'voice.transcribe.stream.cancel':
      return this.cancelSttStream(request);
    case 'voice.transcribe.prepare':
      return this.prepareTranscription(context);
    case 'voice.bridge.start':
      return this.startBridge(readBridge(request.input), context);
    case 'voice.bridge.stop':
      return this.stopBridge(readBridge(request.input), context);
    default:
      return {
        ok: false,
        summary: `Unsupported voice capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async prepareTranscription(context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const stt = await this.sttRuntime.prepare(defaultSttLanguage()).catch((error) => ({
      status: 'failed' as const,
      error: error instanceof VoiceSttRuntimeError ? error.code : 'voice-stt-runtime-failed',
    }));
    await context.emit('voice.transcribe.ready', this.manifest.id, stt);
    return {
      ok: true,
      summary: stt.status === 'ready'
        ? `Voice STT ready via ${stt.engine}.`
        : 'Voice STT warmup failed; recorded-audio fallback remains available.',
      output: { stt },
    };
  }

  private async startBridge(
    bridge: VoiceBridgeKind,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const existing = this.bridges.get(bridge);
    if (existing?.running) {
      return {
        ok: true,
        summary: `${bridge} bridge is already running.`,
        output: this.bridgeSummary(existing),
      };
    }

    const command = commandForBridge(bridge);
    if (!command) {
      return {
        ok: false,
        summary: `${bridge} bridge command is not configured.`,
        error: 'voice-bridge-command-missing',
        output: this.statusPayload(),
      };
    }

    try {
      const parsed = parseAndValidateCommand(command, process.cwd());
      const child = spawn(parsed.executable, parsed.args, {
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
        env: process.env,
      });
      await waitForBridgeSpawn(child);

      const record: VoiceBridgeRecord = {
        bridge,
        command,
        process: child,
        startedAt: new Date().toISOString(),
        running: true,
        stopRequested: false,
      };
      this.bridges.set(bridge, record);
      attachBridgeOutput(record, context);
      attachBridgeLifecycle(record, context, () => {
        if (this.bridges.get(bridge) === record) {
          this.bridges.delete(bridge);
        }
      });
      void context.emit('voice.bridge.started', this.manifest.id, this.bridgeSummary(record));

      const activeEngine = bridge === 'stt' ? (process.env.MONARCH_STT_ENGINE || 'vosk') : (process.env.MONARCH_TTS_ENGINE || 'piper');
      return {
        ok: true,
        summary: `${bridge} bridge started safely using engine: ${activeEngine}.`,
        output: this.bridgeSummary(record),
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Failed to start ${bridge} bridge safely: ${error instanceof Error ? error.message : String(error)}`,
        error: 'voice-bridge-command-invalid',
        output: this.statusPayload(),
      };
    }
  }

  private async startSttStream(
    request: MonarchExecutionRequest,
    _context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    if (!usesDefaultVoskWorker()
      || !this.sttRuntime.startStream
      || !this.sttRuntime.pushStream
      || !this.sttRuntime.finishStream
      || !this.sttRuntime.cancelStream) {
      return {
        ok: false,
        summary: 'Direct PCM STT недоступен для custom transcribe command; используется MediaRecorder fallback.',
        error: 'voice-stt-stream-unavailable',
      };
    }
    const input = readSttStreamStartInput(request.input);
    if (!input.ok) return input.result;
    const clientKey = readSttClientKey(request.requestedBy);
    const previousId = this.sttSessionByClient.get(clientKey);
    if (previousId) {
      const previous = this.sttSessions.get(previousId);
      if (previous) await this.closeSttSession(previous, true);
    }
    if (this.sttSessions.size >= MAX_STREAMING_SESSIONS) {
      return {
        ok: false,
        summary: 'Слишком много одновременных голосовых записей.',
        error: 'voice-stt-stream-limit',
      };
    }

    const sessionId = randomBytes(24).toString('base64url');
    const session: VoiceSttSession = {
      id: sessionId,
      clientKey,
      language: input.language,
      sampleRate: input.sampleRate,
      nextSequence: 0,
      bytes: 0,
      frames: 0,
      createdAt: Date.now(),
      lastPartialAt: null,
      timer: null,
    };
    this.refreshSttSessionExpiry(session);
    // Reserve before loading the model so concurrent starts cannot bypass the
    // one-session-per-client/global limits.
    this.sttSessions.set(sessionId, session);
    this.sttSessionByClient.set(clientKey, sessionId);
    try {
      const result = await this.sttRuntime.startStream({
        streamId: sessionId,
        language: input.language,
        sampleRate: input.sampleRate,
      });
      return {
        ok: true,
        summary: `Direct PCM STT started via ${result.engine}.`,
        output: {
          sessionId,
          enginePath: `direct-pcm/${result.engine}`,
          model: result.model,
          sampleRate: result.sampleRate,
          loadMs: result.loadMs,
          warm: result.warm,
        },
      };
    } catch (error) {
      await this.closeSttSession(session, true);
      return sttStreamFailure(error);
    }
  }

  private async pushSttStream(
    request: MonarchExecutionRequest,
    _context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    const input = readSttStreamPushInput(request.input);
    if (!input.ok) return input.result;
    const session = this.findOwnedSttSession(input.sessionId, request.requestedBy);
    if (!session || !this.sttRuntime.pushStream) return sttSessionNotFound();
    if (input.sequence !== session.nextSequence) {
      return {
        ok: false,
        summary: 'PCM batch пришёл вне очереди.',
        error: 'voice-stt-stream-sequence',
        output: { expectedSequence: session.nextSequence },
      };
    }
    const nextBytes = session.bytes + input.bytes;
    const nextFrames = session.frames + input.bytes / 2;
    if (nextBytes > MAX_STREAMING_PCM_BYTES) {
      await this.closeSttSession(session, true);
      return {
        ok: false,
        summary: 'PCM stream превысил лимит размера.',
        error: 'voice-stt-stream-too-large',
      };
    }
    if (nextFrames * 1000 / session.sampleRate > MAX_STREAMING_DURATION_MS) {
      await this.closeSttSession(session, true);
      return {
        ok: false,
        summary: 'PCM stream превысил 10-минутный защитный предел.',
        error: 'voice-stt-stream-too-long',
      };
    }
    session.nextSequence += 1;
    session.bytes = nextBytes;
    session.frames = nextFrames;
    this.refreshSttSessionExpiry(session);
    try {
      const result = await this.sttRuntime.pushStream({
        streamId: session.id,
        sequence: input.sequence,
        pcmBase64: input.pcmBase64,
      });
      if (result.partial) session.lastPartialAt = Date.now();
      return {
        ok: true,
        summary: 'PCM batch processed locally.',
        output: {
          sequence: result.sequence,
          partial: result.partial,
          processingMs: result.processingMs,
          audioMs: result.audioMs,
          enginePath: `direct-pcm/${result.engine}`,
          partialAgeMs: session.lastPartialAt === null ? null : Date.now() - session.lastPartialAt,
        },
      };
    } catch (error) {
      await this.closeSttSession(session, true);
      return sttStreamFailure(error);
    }
  }

  private async finishSttStream(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    const input = readSttStreamFinishInput(request.input);
    if (!input.ok) return input.result;
    const session = this.findOwnedSttSession(input.sessionId, request.requestedBy);
    if (!session || !this.sttRuntime.finishStream) return sttSessionNotFound();
    this.detachSttSession(session);
    try {
      const result = await this.sttRuntime.finishStream(session.id);
      const now = Date.now();
      const captureStopToFinalMs = input.captureStoppedAtEpochMs === null
        ? null
        : Math.max(0, now - input.captureStoppedAtEpochMs);
      const partialAgeMs = result.partialAgeMs
        ?? (session.lastPartialAt === null ? null : now - session.lastPartialAt);
      await context.emit('voice.transcribe.completed', this.manifest.id, {
        transcriptLength: result.text.length,
        durationMs: result.audioMs,
        engine: result.engine,
        enginePath: `direct-pcm/${result.engine}`,
        recognitionMs: result.recognitionMs,
        finalizeMs: result.finalizeMs,
        captureStopToFinalMs,
        partialAgeMs,
      });
      if (!result.text) {
        return {
          ok: false,
          summary: 'Streaming STT завершился без текста.',
          error: 'voice-stt-empty-transcript',
          output: {
            enginePath: `direct-pcm/${result.engine}`,
            finalizeMs: result.finalizeMs,
            captureStopToFinalMs,
            partialAgeMs,
          },
        };
      }
      return {
        ok: true,
        summary: 'Voice input transcribed from direct PCM locally.',
        output: {
          transcript: result.text,
          bytes: result.bytes,
          durationMs: result.audioMs,
          enginePath: `direct-pcm/${result.engine}`,
          model: result.model,
          recognitionMs: result.recognitionMs,
          finalizeMs: result.finalizeMs,
          captureStopToFinalMs,
          partialAgeMs,
          workerPid: result.pid,
        },
      };
    } catch (error) {
      await this.sttRuntime.cancelStream?.(session.id).catch(() => undefined);
      return sttStreamFailure(error);
    }
  }

  private async cancelSttStream(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
    const sessionId = readSttSessionId(request.input);
    if (!sessionId) {
      return {
        ok: false,
        summary: 'STT session id некорректен.',
        error: 'voice-stt-stream-invalid',
      };
    }
    const session = this.findOwnedSttSession(sessionId, request.requestedBy);
    if (!session) return sttSessionNotFound();
    await this.closeSttSession(session, true);
    return {
      ok: true,
      summary: 'Direct PCM STT cancelled.',
      output: { cancelled: true },
    };
  }

  private findOwnedSttSession(sessionId: string, requestedBy: string): VoiceSttSession | undefined {
    const session = this.sttSessions.get(sessionId);
    return session?.clientKey === readSttClientKey(requestedBy) ? session : undefined;
  }

  private detachSttSession(session: VoiceSttSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (this.sttSessions.get(session.id) === session) this.sttSessions.delete(session.id);
    if (this.sttSessionByClient.get(session.clientKey) === session.id) {
      this.sttSessionByClient.delete(session.clientKey);
    }
  }

  private refreshSttSessionExpiry(session: VoiceSttSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (this.sttSessions.get(session.id) === session) {
        void this.closeSttSession(session, true);
      }
    }, STREAMING_SESSION_TTL_MS);
    session.timer.unref?.();
  }

  private async closeSttSession(session: VoiceSttSession, cancelRuntime: boolean): Promise<void> {
    this.detachSttSession(session);
    if (cancelRuntime && this.sttRuntime.cancelStream) {
      await this.sttRuntime.cancelStream(session.id).catch(() => undefined);
    }
  }

  private async transcribeAudio(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const command = transcribeCommand();
    if (!command) {
      return {
        ok: false,
        summary: 'Локальный STT не настроен. Укажи MONARCH_STT_TRANSCRIBE_COMMAND для диктовки с микрофона.',
        error: 'voice-stt-command-missing',
        output: this.statusPayload(),
      };
    }

    const audio = readTranscribeAudioInput(input);
    if (!audio.ok) {
      return {
        ok: false,
        summary: audio.summary,
        error: audio.error,
      };
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'monarch-voice-'));
    const audioPath = path.join(tempDir, `voice-input${extensionForMimeType(audio.mimeType)}`);
    try {
      await writeFile(audioPath, audio.buffer);
      const result = usesDefaultVoskWorker()
        ? await this.sttRuntime.transcribe({
          audioPath,
          language: audio.language,
          ...(audio.durationMs === null ? {} : { durationMs: audio.durationMs }),
        })
        : await runConfiguredTranscriber(
          command,
          audioPath,
          audio.language,
          transcribeTimeoutMs(audio.durationMs),
        );
      const transcript = 'text' in result
        ? result.text
        : readTranscriptFromOutput(result.stdout);
      if (!transcript) {
        return {
          ok: false,
          summary: 'Локальный STT завершился без текста.',
          error: 'voice-stt-empty-transcript',
          output: {
            ...('stderr' in result && result.stderr ? { stderr: result.stderr.slice(0, 1000) } : {}),
            ...('exitCode' in result ? { exitCode: result.exitCode } : {}),
            ...('totalMs' in result ? {
              engine: result.engine,
              model: result.model,
              warm: result.warm,
              loadMs: result.loadMs,
              conversionMs: result.conversionMs,
              recognitionMs: result.recognitionMs,
              totalMs: result.totalMs,
            } : {}),
          },
        };
      }
      await context.emit('voice.transcribe.completed', this.manifest.id, {
        transcriptLength: transcript.length,
        mimeType: audio.mimeType,
        durationMs: audio.durationMs,
        ...('totalMs' in result ? {
          engine: result.engine,
          model: result.model,
          warm: result.warm,
          loadMs: result.loadMs,
          conversionMs: result.conversionMs,
          recognitionMs: result.recognitionMs,
          totalMs: result.totalMs,
        } : {}),
      });
      return {
        ok: true,
        summary: 'Voice input transcribed locally.',
        output: {
          transcript,
          mimeType: audio.mimeType,
          bytes: audio.buffer.byteLength,
          durationMs: audio.durationMs,
          ...('totalMs' in result ? {
            engine: result.engine,
            model: result.model,
            warm: result.warm,
            loadMs: result.loadMs,
            conversionMs: result.conversionMs,
            recognitionMs: result.recognitionMs,
            totalMs: result.totalMs,
            workerPid: result.pid,
          } : {}),
        },
      };
    } catch (error) {
      const failure = normalizeTranscribeFailure(error);
      return {
        ok: false,
        summary: failure.summary,
        error: failure.error,
        output: failure.output,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private stopBridge(
    bridge: VoiceBridgeKind,
    context: MonarchKernelContext
  ): MonarchExecutionResult {
    const record = this.bridges.get(bridge);
    if (!record?.running) {
      if (record) this.bridges.delete(bridge);
      return {
        ok: true,
        summary: `${bridge} bridge is not running.`,
        output: { bridge, running: false },
      };
    }

    record.stopRequested = true;
    record.running = false;
    record.process.kill();
    this.bridges.delete(bridge);
    void context.emit('voice.bridge.stopped', this.manifest.id, this.bridgeSummary(record));
    return {
      ok: true,
      summary: `${bridge} bridge stopped.`,
      output: { ...this.bridgeSummary(record), running: false },
    };
  }

  private statusPayload(): Record<string, unknown> {
    return {
      configured: {
        stt: Boolean(commandForBridge('stt')),
        tts: Boolean(commandForBridge('tts')),
        transcribe: Boolean(transcribeCommand()),
      },
      running: {
        stt: Boolean(this.bridges.get('stt')?.running),
        tts: Boolean(this.bridges.get('tts')?.running),
      },
      engines: {
        stt: process.env.MONARCH_STT_ENGINE
          || (usesDefaultVoskWorker() ? 'sherpa-onnx-t-one+vosk-fallback' : 'custom'),
        tts: process.env.MONARCH_TTS_ENGINE || 'piper',
      },
      sttRuntime: this.sttRuntime.snapshot(),
    };
  }

  private bridgeSummary(record: VoiceBridgeRecord): Record<string, unknown> {
    const summary: Record<string, unknown> = {
      bridge: record.bridge,
      running: record.running,
      startedAt: record.startedAt,
      commandConfigured: Boolean(record.command),
    };
    if (record.process.pid !== undefined) {
      summary.pid = record.process.pid;
    }
    if (record.exitCode !== undefined) {
      summary.exitCode = record.exitCode;
    }
    if (record.exitSignal) {
      summary.exitSignal = record.exitSignal;
    }
    return summary;
  }
}

function mentionsVoiceSubsystem(text: string): boolean {
  return /\b(?:monarch voice|voice (?:mode|bridge|assistant|status|settings)|speech (?:recognition|synthesis)|stt|tts|microphone)\b/i.test(text)
    || /\bvoice\b.{0,32}\b(?:start|stop|launch|status|settings|microphone|stt|tts)\b|\b(?:start|stop|launch|status|settings|microphone|stt|tts)\b.{0,32}\bvoice\b/i.test(text);
}

type ValidSttInput<T> = { ok: true } & T;
type InvalidSttInput = { ok: false; result: MonarchExecutionResult };

function readSttStreamStartInput(
  input: unknown,
): ValidSttInput<{ language: string; sampleRate: number }> | InvalidSttInput {
  const record = readObject(input);
  const language = normalizeSpeechLanguage(record.language || 'ru-RU');
  const sampleRate = record.sampleRate;
  if (!language) {
    return invalidSttInput('Язык PCM stream не поддерживается.', 'voice-stt-language-unsupported');
  }
  if (!Number.isInteger(sampleRate) || (sampleRate as number) < 8_000 || (sampleRate as number) > 48_000) {
    return invalidSttInput('PCM sample rate должен быть 8000-48000 Hz.', 'voice-stt-stream-rate-invalid');
  }
  return { ok: true, language, sampleRate: sampleRate as number };
}

function readSttStreamPushInput(
  input: unknown,
): ValidSttInput<{ sessionId: string; sequence: number; pcmBase64: string; bytes: number }> | InvalidSttInput {
  const record = readObject(input);
  const sessionId = normalizeSttSessionId(record.sessionId);
  const sequence = record.sequence;
  const pcmBase64 = typeof record.pcmBase64 === 'string' ? record.pcmBase64 : '';
  if (!sessionId) return invalidSttInput('STT session id некорректен.', 'voice-stt-stream-invalid');
  if (!Number.isInteger(sequence) || (sequence as number) < 0) {
    return invalidSttInput('PCM sequence некорректен.', 'voice-stt-stream-sequence');
  }
  if (!pcmBase64 || pcmBase64.length > 96 * 1024) {
    return invalidSttInput('PCM batch некорректен.', 'voice-stt-stream-pcm-invalid');
  }
  const pcm = Buffer.from(pcmBase64, 'base64');
  if (!pcm.byteLength || pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_STREAMING_BATCH_BYTES
    || pcm.toString('base64').replace(/=+$/, '') !== pcmBase64.replace(/=+$/, '')) {
    return invalidSttInput('PCM batch некорректен.', 'voice-stt-stream-pcm-invalid');
  }
  return { ok: true, sessionId, sequence: sequence as number, pcmBase64, bytes: pcm.byteLength };
}

function readSttStreamFinishInput(
  input: unknown,
): ValidSttInput<{ sessionId: string; captureStoppedAtEpochMs: number | null }> | InvalidSttInput {
  const record = readObject(input);
  const sessionId = normalizeSttSessionId(record.sessionId);
  if (!sessionId) return invalidSttInput('STT session id некорректен.', 'voice-stt-stream-invalid');
  const candidate = record.captureStoppedAtEpochMs;
  const now = Date.now();
  const captureStoppedAtEpochMs = typeof candidate === 'number'
    && Number.isFinite(candidate)
    && candidate >= now - 60_000
    && candidate <= now + 1_000
    ? Math.floor(candidate)
    : null;
  return { ok: true, sessionId, captureStoppedAtEpochMs };
}

function readSttSessionId(input: unknown): string {
  return normalizeSttSessionId(readObject(input).sessionId);
}

function normalizeSttSessionId(value: unknown): string {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{24,160}$/.test(sessionId) ? sessionId : '';
}

function readSttClientKey(value: string): string {
  const client = typeof value === 'string' ? value.trim().slice(0, 160) : '';
  return client || 'api';
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function invalidSttInput(summary: string, error: string): InvalidSttInput {
  return { ok: false, result: { ok: false, summary, error } };
}

function sttSessionNotFound(): MonarchExecutionResult {
  return {
    ok: false,
    summary: 'STT session не найдена или принадлежит другому клиенту.',
    error: 'voice-stt-stream-not-found',
  };
}

function sttStreamFailure(error: unknown): MonarchExecutionResult {
  if (error instanceof VoiceSttRuntimeError) {
    return {
      ok: false,
      summary: error.message,
      error: error.code,
      ...(Object.keys(error.details).length ? { output: error.details } : {}),
    };
  }
  return {
    ok: false,
    summary: `Streaming STT failed: ${error instanceof Error ? error.message : String(error)}`,
    error: 'voice-stt-stream-failed',
  };
}

function waitForBridgeSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function attachBridgeLifecycle(
  record: VoiceBridgeRecord,
  context: MonarchKernelContext,
  onSettled: () => void,
): void {
  let settled = false;
  const settle = (
    reason: 'error' | 'close',
    error?: Error,
    exitCode?: number | null,
    exitSignal?: NodeJS.Signals | null,
  ) => {
    if (settled) return;
    settled = true;
    record.running = false;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (exitSignal !== undefined) record.exitSignal = exitSignal;
    onSettled();
    if (!record.stopRequested) {
      void context.emit('voice.bridge.exited', 'voice', {
        ...bridgeLifecycleSummary(record),
        reason,
        ...(error ? { error: error.message.slice(0, 500) } : {}),
      });
    }
  };
  record.process.once('error', (error) => settle('error', error));
  record.process.once('close', (exitCode, exitSignal) => settle('close', undefined, exitCode, exitSignal));
}

function bridgeLifecycleSummary(record: VoiceBridgeRecord): Record<string, unknown> {
  return {
    bridge: record.bridge,
    running: record.running,
    startedAt: record.startedAt,
    ...(record.process.pid !== undefined ? { pid: record.process.pid } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.exitSignal ? { exitSignal: record.exitSignal } : {}),
  };
}

function attachBridgeOutput(
  record: VoiceBridgeRecord,
  context: MonarchKernelContext
): void {
  const stdout = readline.createInterface({ input: record.process.stdout });
  stdout.on('line', (line) => {
    const event = parseBridgeLine(line);
    void context.emit('voice.bridge.event', 'voice', {
      bridge: record.bridge,
      stream: 'stdout',
      event,
    });
  });

  const stderr = readline.createInterface({ input: record.process.stderr });
  stderr.on('line', (line) => {
    void context.emit('voice.bridge.event', 'voice', {
      bridge: record.bridge,
      stream: 'stderr',
      event: { text: line.slice(0, 500) },
    });
  });
}

function parseBridgeLine(line: string): unknown {
  const text = line.trim();
  if (!text) {
    return { text: '' };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text: text.slice(0, 500) };
  }
}

function commandForBridge(bridge: VoiceBridgeKind): string {
  return bridge === 'stt'
    ? String(process.env.MONARCH_STT_COMMAND || '').trim()
    : String(process.env.MONARCH_TTS_COMMAND || '').trim();
}

function transcribeCommand(): string {
  const explicit = String(process.env.MONARCH_STT_TRANSCRIBE_COMMAND || '').trim();
  if (explicit) {
    return explicit;
  }
  if (/^(1|true|yes)$/i.test(String(process.env.MONARCH_DISABLE_DEFAULT_STT || ''))) {
    return '';
  }
  const defaultScript = path.join(process.cwd(), 'tools', 'local-vosk-transcribe.py');
  return existsSync(defaultScript)
    ? 'python tools/local-vosk-transcribe.py {audio} {language}'
    : '';
}

function usesDefaultVoskWorker(): boolean {
  if (String(process.env.MONARCH_STT_TRANSCRIBE_COMMAND || '').trim()) return false;
  if (/^(1|true|yes)$/i.test(String(process.env.MONARCH_DISABLE_DEFAULT_STT || ''))) return false;
  return existsSync(path.join(process.cwd(), 'tools', 'local-vosk-transcribe.py'));
}

function defaultSttLanguage(): string {
  return normalizeSpeechLanguage(process.env.MONARCH_STT_LANGUAGE || 'ru-RU') || 'ru-RU';
}

export function shouldPrewarmDefaultSttOnActivate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.MONARCH_STT_PREWARM_ON_ACTIVATE || '').trim());
}

interface TranscribeAudioInput {
  ok: true;
  buffer: Buffer;
  mimeType: string;
  language: string;
  durationMs: number | null;
}

interface InvalidTranscribeAudioInput {
  ok: false;
  summary: string;
  error: string;
}

function readTranscribeAudioInput(input: unknown): TranscribeAudioInput | InvalidTranscribeAudioInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, summary: 'Нужен аудиофрагмент для распознавания.', error: 'voice-audio-missing' };
  }
  const record = input as Record<string, unknown>;
  const audioBase64 = typeof record.audioBase64 === 'string' ? record.audioBase64.trim() : '';
  if (!audioBase64) {
    return { ok: false, summary: 'Аудиофрагмент пустой.', error: 'voice-audio-empty' };
  }
  const mimeType = normalizeAudioMimeType(record.mimeType);
  if (!mimeType) {
    return { ok: false, summary: 'Формат аудио не поддерживается для локального распознавания.', error: 'voice-audio-format-unsupported' };
  }
  const buffer = Buffer.from(audioBase64, 'base64');
  if (!buffer.byteLength || buffer.toString('base64').replace(/=+$/, '') !== audioBase64.replace(/=+$/, '')) {
    return { ok: false, summary: 'Аудиофрагмент поврежден или не является base64.', error: 'voice-audio-invalid-base64' };
  }
  if (buffer.byteLength > MAX_TRANSCRIBE_AUDIO_BYTES) {
    return { ok: false, summary: 'Аудиофрагмент слишком большой для локального распознавания.', error: 'voice-audio-too-large' };
  }
  const durationMs = readOptionalPositiveNumber(record.durationMs);
  if (durationMs !== null && durationMs > MAX_TRANSCRIBE_AUDIO_MS) {
    return { ok: false, summary: 'Запись превысила 10-минутный защитный предел локального распознавания.', error: 'voice-audio-too-long' };
  }
  const language = normalizeSpeechLanguage(record.language);
  if (!language) {
    return {
      ok: false,
      summary: 'Язык голосового ввода не поддерживается. Доступны RU, UK, BG и EN.',
      error: 'voice-stt-language-unsupported',
    };
  }
  return {
    ok: true,
    buffer,
    mimeType,
    language,
    durationMs,
  };
}

export function normalizeSpeechLanguage(value: unknown): string | null {
  const raw = typeof value === 'string' && value.trim() ? value.trim().slice(0, 32) : 'ru-RU';
  const prefix = raw.toLowerCase().split(/[-_]/, 1)[0];
  switch (prefix) {
  case 'ru': return 'ru-RU';
  case 'uk': return 'uk-UA';
  case 'bg': return 'bg-BG';
  case 'en': return 'en-US';
  default: return null;
  }
}

function readOptionalPositiveNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeAudioMimeType(value: unknown): string | null {
  const mimeType = String(value || 'audio/webm').toLowerCase().split(';', 1)[0]!.trim();
  if (['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/mp4'].includes(mimeType)) {
    return mimeType;
  }
  return null;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
  case 'audio/wav':
  case 'audio/x-wav':
    return '.wav';
  case 'audio/mpeg':
  case 'audio/mp3':
    return '.mp3';
  case 'audio/ogg':
    return '.ogg';
  case 'audio/mp4':
    return '.m4a';
  default:
    return '.webm';
  }
}

function withAudioCommandArgs(args: string[], audioPath: string, language: string): string[] {
  const replaced = args.map((arg) => arg
    .replaceAll('{audio}', audioPath)
    .replaceAll('{language}', language));
  if (replaced.some((arg) => arg.includes(audioPath))) {
    return replaced;
  }
  return [...replaced, audioPath];
}

function runTranscribeCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = TRANSCRIBE_BASE_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: transcribeProcessEnv(env),
    });
    let stdout = '';
    let stderr = '';
    let timer: NodeJS.Timeout;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const finish = (result: { stdout: string; stderr: string; exitCode: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill();
      fail(new TranscribeCommandError(
        'voice-stt-timeout',
        'Локальная STT-команда не успела завершить распознавание за отведённое время.',
        { stderr }
      ));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 64_000) stdout = stdout.slice(-64_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on('error', (error) => {
      fail(error);
    });
    child.on('close', (exitCode) => {
      if (exitCode && exitCode !== 0) {
        const classified = classifyTranscribeProcessFailure(stderr);
        fail(new TranscribeCommandError(
          classified?.code || 'voice-stt-command-exit',
          classified?.summary || `Локальная STT-команда завершилась с кодом ${exitCode}.`,
          { stderr, exitCode }
        ));
        return;
      }
      finish({ stdout, stderr, exitCode });
    });
  });
}

async function runConfiguredTranscriber(
  command: string,
  audioPath: string,
  language: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const parsed = parseAndValidateCommand(command, process.cwd());
  const args = withAudioCommandArgs(parsed.args, audioPath, language);
  return runTranscribeCommand(parsed.executable, args, process.env, timeoutMs);
}

function transcribeTimeoutMs(durationMs: number | null): number {
  if (durationMs === null) return TRANSCRIBE_BASE_TIMEOUT_MS;
  return Math.min(
    MAX_TRANSCRIBE_TIMEOUT_MS,
    Math.max(TRANSCRIBE_BASE_TIMEOUT_MS, durationMs + 30_000),
  );
}

function classifyTranscribeProcessFailure(stderr: string): { code: string; summary: string } | null {
  const marker = stderr.match(/MONARCH_VOICE_ERROR=(voice-stt-[a-z0-9-]+)/i)?.[1]?.toLowerCase();
  if (marker === 'voice-stt-language-unavailable') {
    return {
      code: marker,
      summary: 'Для выбранного языка нет локальной Vosk-модели.',
    };
  }
  if (marker === 'voice-stt-language-unsupported') {
    return {
      code: marker,
      summary: 'Язык голосового ввода не поддерживается.',
    };
  }
  return null;
}

class TranscribeCommandError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TranscribeCommandError';
    this.code = code;
    this.details = details;
  }
}

function normalizeTranscribeFailure(error: unknown): {
  summary: string;
  error: string;
  output?: Record<string, unknown>;
} {
  if (error instanceof VoiceSttRuntimeError) {
    const stderr = typeof error.details.stderr === 'string' ? error.details.stderr.slice(0, 1000) : '';
    return {
      summary: error.message,
      error: error.code,
      ...(stderr ? { output: { stderr } } : {}),
    };
  }
  if (error instanceof TranscribeCommandError) {
    const stderr = typeof error.details.stderr === 'string' ? error.details.stderr.slice(0, 1000) : '';
    return {
      summary: error.message,
      error: error.code,
      output: {
        ...(stderr ? { stderr } : {}),
        ...(typeof error.details.exitCode === 'number' ? { exitCode: error.details.exitCode } : {}),
      },
    };
  }
  return {
    summary: `Локальный STT не сработал: ${error instanceof Error ? error.message : String(error)}`,
    error: 'voice-stt-failed',
  };
}

function transcribeProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

function readTranscriptFromOutput(stdout: string): string {
  const text = stdout.trim();
  if (!text) return '';

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const transcript = readTranscriptJson(lines[index]!);
    if (transcript) {
      return transcript;
    }
  }

  const transcript = readTranscriptJson(text);
  if (transcript) {
    return transcript;
  }

  const plain = sanitizeTranscriptValue(lines.join(' '));
  if (!plain || looksLikeServiceOutput(text)) {
    return '';
  }
  return plain;
}

function readTranscriptJson(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['text', 'transcript', 'result']) {
        if (typeof record[key] === 'string') {
          const transcript = sanitizeTranscriptValue(record[key]);
          if (transcript) {
            return transcript;
          }
        }
      }
    }
  } catch {
    return '';
  }
  return '';
}

function sanitizeTranscriptValue(value: string): string {
  return String(value || '')
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeServiceOutput(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^[{\[]/.test(value) || /[{}\[\]]/.test(value)) return true;
  return /\b(LOG|DEBUG|INFO|WARN|ERROR|TRACEBACK|EXCEPTION|STDOUT|STDERR|VoskAPI|ffmpeg|model\.cc|lattice|beam|max-active|voice-stt|base64)\b/i.test(value);
}

function inferBridge(text: string): VoiceBridgeKind {
  return /\btts|speak|speech out|voice out\b/i.test(text) ? 'tts' : 'stt';
}

function readBridge(input: unknown): VoiceBridgeKind {
  if (!input || typeof input !== 'object') {
    return 'stt';
  }
  const bridge = (input as Record<string, unknown>).bridge;
  return bridge === 'tts' ? 'tts' : 'stt';
}

const ALLOWED_EXECUTABLES = new Set([
  'python',
  'python.exe',
  'python3',
  'py',
  'node',
  'node.exe',
  'piper',
  'piper.exe',
  'vosk',
  'vosk-stt',
  'vosk-stt.exe',
]);

const SHELL_FILE_EXECUTABLES = new Set([
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

const INLINE_INTERPRETER_FLAGS = new Set([
  '-c',
  '-e',
  '-m',
  '-p',
  '--eval',
  '--input-type',
  '--print',
]);

const SAFE_INTERPRETER_FLAGS = new Set([
  '--',
  '--enable-source-maps',
  '--no-warnings',
  '--trace-warnings',
  '-b',
  '-i',
  '-s',
  '-u',
  '-x',
]);

interface ParsedCommand {
  executable: string;
  args: string[];
}

export interface CommandValidationOptions {
  allowShellFile?: boolean;
}

export function parseAndValidateCommand(
  rawCommand: string,
  workspaceRoot: string,
  options: CommandValidationOptions = {},
): ParsedCommand {
  const trimmed = rawCommand.trim();
  if (!trimmed) {
    throw new Error('Command is empty');
  }

  const forbiddenChars = /[|&;><`$()\n\r]/;
  if (forbiddenChars.test(trimmed)) {
    throw new Error(`Command contains forbidden shell characters: ${rawCommand}`);
  }

  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens.length === 0) {
    throw new Error('Command parsing resulted in 0 tokens');
  }

  const rawExecutable = tokens[0]!;
  const executable = rawExecutable.replace(/^["']|["']$/g, '');
  const args = tokens.slice(1).map(token => token.replace(/^["']|["']$/g, ''));

  const exeBase = path.basename(executable).toLowerCase();
  const isPath = executable.includes('/') || executable.includes('\\');
  const workspacePath = path.resolve(workspaceRoot);

  let isAllowed = false;

  if (SHELL_FILE_EXECUTABLES.has(exeBase)) {
    if (exeBase === 'cmd' || exeBase === 'cmd.exe') {
      throw new Error(`Shell host "${executable}" is not allowed for project runners.`);
    }
    if (!options.allowShellFile) {
      throw new Error(`Shell host "${executable}" is not allowed for this command.`);
    }
    validateShellFileCommand(args, workspacePath);
    isAllowed = true;
  } else if (ALLOWED_EXECUTABLES.has(exeBase)) {
    isAllowed = true;
  } else if (isPath) {
    const resolvedExe = path.resolve(workspacePath, executable);
    if (isPathInside(workspacePath, resolvedExe)) {
      isAllowed = true;
    }
  }

  if (!isAllowed) {
    throw new Error(`Executable "${executable}" is not in the allowed catalog or workspace.`);
  }

  if (exeBase.startsWith('python') || exeBase.startsWith('node') || exeBase === 'py') {
    const scriptPath = readInterpreterScriptPath(args);
    const resolvedScript = path.resolve(workspacePath, scriptPath);
    if (!isPathInside(workspacePath, resolvedScript)) {
      throw new Error(`Script path "${scriptPath}" is outside the authorized workspace.`);
    }
  }

  return { executable, args };
}

function readInterpreterScriptPath(args: string[]): string {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) {
    const flag = args[index]!.toLowerCase();
    if (INLINE_INTERPRETER_FLAGS.has(flag)) {
      throw new Error(`Inline interpreter mode "${args[index]}" is not allowed; use a project-owned script file.`);
    }
    if (/^-\d(?:\.\d+)?$/.test(flag) || SAFE_INTERPRETER_FLAGS.has(flag)) {
      index += 1;
      continue;
    }
    throw new Error(`Interpreter flag "${args[index]}" is not allowed before the project-owned script file.`);
  }
  const scriptPath = args[index];
  if (!scriptPath || scriptPath === '--') {
    throw new Error('Interpreter command must name a project-owned script file.');
  }
  return scriptPath;
}

function validateShellFileCommand(args: string[], workspaceRoot: string): void {
  const lowered = args.map((arg) => arg.toLowerCase());
  if (lowered.some((arg) => ['/c', '/k', '-c', '-command', '-encodedcommand', '-enc'].includes(arg))) {
    throw new Error('Inline shell commands are not allowed; use -File with a project-owned PowerShell script.');
  }
  const fileIndex = lowered.indexOf('-file');
  const scriptPath = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
  if (!scriptPath || !/\.ps1$/i.test(scriptPath)) {
    throw new Error('PowerShell runner must use -File with a project-owned .ps1 script.');
  }
  const resolvedScript = path.resolve(workspaceRoot, scriptPath);
  if (!isPathInside(workspaceRoot, resolvedScript)) {
    throw new Error(`Script path "${scriptPath}" is outside the authorized workspace.`);
  }
}

function isPathInside(workspaceRoot: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(candidatePath));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function createVoiceModule(): MonarchModule {
  return new VoiceModule();
}

export const voiceModulePackage: MonarchModulePackage = {
  id: voiceManifest.id,
  moduleId: voiceManifest.id,
  version: voiceManifest.version,
  description: voiceManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createVoiceModule,
};

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
const MAX_STDERR_LENGTH = 16_000;

export type VoiceSttEngine = 'vosk' | 'sherpa-onnx-t-one';

export interface VoiceSttPrepareResult {
  status: 'ready';
  engine: VoiceSttEngine;
  model: string;
  loadMs: number;
  warm: boolean;
  pid: number;
}

export interface VoiceSttTranscribeInput {
  audioPath: string;
  language: string;
}

export interface VoiceSttTranscribeResult {
  text: string;
  engine: 'vosk';
  model: string;
  loadMs: number;
  warm: boolean;
  conversionMs: number;
  recognitionMs: number;
  totalMs: number;
  pid: number;
}

export interface VoiceSttStreamStartInput {
  streamId: string;
  language: string;
  sampleRate: number;
}

export interface VoiceSttStreamStartResult {
  engine: VoiceSttEngine;
  model: string;
  loadMs: number;
  warm: boolean;
  sampleRate: number;
  pid: number;
}

export interface VoiceSttStreamPushInput {
  streamId: string;
  sequence: number;
  pcmBase64: string;
}

export interface VoiceSttStreamPushResult {
  engine: VoiceSttEngine;
  partial: string;
  sequence: number;
  processingMs: number;
  audioMs: number;
  pid: number;
}

export interface VoiceSttStreamFinalResult {
  text: string;
  engine: VoiceSttEngine;
  model: string;
  recognitionMs: number;
  finalizeMs: number;
  audioMs: number;
  bytes: number;
  partialAgeMs: number | null;
  pid: number;
}

export interface VoiceSttStreamCancelResult {
  cancelled: boolean;
  pid?: number;
}

export interface VoiceSttRuntimeSnapshot {
  state: 'idle' | 'starting' | 'ready' | 'failed';
  engine: VoiceSttEngine | 'hybrid';
  model?: string;
  pid?: number;
  loadMs?: number;
  lastError?: string;
}

export interface VoiceSttRuntimePort {
  prepare(language?: string): Promise<VoiceSttPrepareResult>;
  transcribe(input: VoiceSttTranscribeInput): Promise<VoiceSttTranscribeResult>;
  startStream?(input: VoiceSttStreamStartInput): Promise<VoiceSttStreamStartResult>;
  pushStream?(input: VoiceSttStreamPushInput): Promise<VoiceSttStreamPushResult>;
  finishStream?(streamId: string): Promise<VoiceSttStreamFinalResult>;
  cancelStream?(streamId: string): Promise<VoiceSttStreamCancelResult>;
  shutdown(): Promise<void>;
  snapshot(): VoiceSttRuntimeSnapshot;
}

export interface VoiceSttRuntimeOptions {
  workspaceRoot?: string;
  executable?: string;
  workerScriptPath?: string;
  requestTimeoutMs?: number;
  audioRoot?: string;
}

interface PendingRequest {
  expectedType: 'ready' | 'transcript' | 'stream-started' | 'stream-partial' | 'stream-final' | 'stream-cancelled';
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class VoiceSttRuntimeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'VoiceSttRuntimeError';
    this.code = code;
    this.details = details;
  }
}

/** Persistent local Vosk process. Audio decoding stays per clip; model loading does not. */
export class VoiceSttRuntime implements VoiceSttRuntimePort {
  private readonly workspaceRoot: string;
  private readonly options: VoiceSttRuntimeOptions;
  private readonly requestTimeoutMs: number;
  private readonly audioRoot: string;
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: readline.Interface | null = null;
  private startPromise: Promise<ChildProcessWithoutNullStreams> | null = null;
  private requestTail: Promise<void> = Promise.resolve();
  private requestSequence = 0;
  private state: VoiceSttRuntimeSnapshot['state'] = 'idle';
  private model: string | undefined;
  private workerPid: number | undefined;
  private loadMs: number | undefined;
  private lastError: string | undefined;
  private stderr = '';
  private intentionalShutdown = false;

  constructor(options: VoiceSttRuntimeOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.options = options;
    this.requestTimeoutMs = readTimeout(options.requestTimeoutMs);
    this.audioRoot = path.resolve(options.audioRoot || os.tmpdir());
  }

  prepare(language = 'ru-RU'): Promise<VoiceSttPrepareResult> {
    return this.enqueue(async () => {
      try {
        const envelope = await this.sendRequest('prepare', { language }, 'ready');
        const result = readPrepareResult(envelope);
        this.markReady(result);
        return result;
      } catch (error) {
        this.markFailed(readFailureCode(error));
        throw error;
      }
    });
  }

  transcribe(input: VoiceSttTranscribeInput): Promise<VoiceSttTranscribeResult> {
    const normalized = normalizeTranscribeInput(input, this.audioRoot);
    return this.enqueue(async () => {
      try {
        const envelope = await this.sendRequest('transcribe', normalized, 'transcript');
        const result = readTranscribeResult(envelope);
        this.markReady(result);
        return result;
      } catch (error) {
        this.markFailed(readFailureCode(error));
        throw error;
      }
    });
  }

  startStream(input: VoiceSttStreamStartInput): Promise<VoiceSttStreamStartResult> {
    const normalized = normalizeStreamStartInput(input);
    return this.enqueue(async () => {
      const envelope = await this.sendRequest('stream-start', normalized, 'stream-started');
      const result = readStreamStartResult(envelope, 'vosk');
      this.markReady({ status: 'ready', ...result });
      return result;
    });
  }

  pushStream(input: VoiceSttStreamPushInput): Promise<VoiceSttStreamPushResult> {
    const normalized = normalizeStreamPushInput(input);
    return this.enqueue(async () => readStreamPushResult(
      await this.sendRequest('stream-push', normalized, 'stream-partial'),
      'vosk',
    ));
  }

  finishStream(streamId: string): Promise<VoiceSttStreamFinalResult> {
    const normalizedStreamId = normalizeStreamId(streamId);
    return this.enqueue(async () => readStreamFinalResult(
      await this.sendRequest('stream-finish', { streamId: normalizedStreamId }, 'stream-final'),
      'vosk',
    ));
  }

  cancelStream(streamId: string): Promise<VoiceSttStreamCancelResult> {
    const normalizedStreamId = normalizeStreamId(streamId);
    return this.enqueue(async () => {
      if (!this.child || this.child.exitCode !== null || this.child.killed) return { cancelled: false };
      const envelope = await this.sendRequest(
        'stream-cancel',
        { streamId: normalizedStreamId },
        'stream-cancelled',
      );
      return {
        cancelled: envelope.cancelled === true,
        ...(typeof envelope.pid === 'number' ? { pid: readPositiveInteger(envelope.pid, 'pid') } : {}),
      };
    });
  }

  snapshot(): VoiceSttRuntimeSnapshot {
    return {
      state: this.state,
      engine: 'vosk',
      ...(this.model ? { model: this.model } : {}),
      ...(this.workerPid !== undefined ? { pid: this.workerPid } : {}),
      ...(this.loadMs !== undefined ? { loadMs: this.loadMs } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  shutdown(): Promise<void> {
    const current = this.requestTail.then(
      () => this.shutdownNow(),
      () => this.shutdownNow(),
    );
    this.requestTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async shutdownNow(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = 'idle';
      return;
    }

    this.intentionalShutdown = true;
    const closed = waitForClose(child, 1_500);
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({
        id: this.nextRequestId(),
        type: 'shutdown',
      })}\n`);
      child.stdin.end();
    }
    const exited = await closed;
    if (!exited && child.exitCode === null) {
      child.kill();
      await waitForClose(child, 500);
    }
    if (this.child === child) this.child = null;
    this.stdout?.close();
    this.stdout = null;
    this.rejectPending(new VoiceSttRuntimeError(
      'voice-stt-stopped',
      'Local STT worker was stopped.',
    ));
    this.state = 'idle';
    this.workerPid = undefined;
    this.intentionalShutdown = false;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.requestTail.then(operation, operation);
    this.requestTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async sendRequest(
    type: 'prepare' | 'transcribe' | 'stream-start' | 'stream-push' | 'stream-finish' | 'stream-cancel',
    payload: Record<string, unknown>,
    expectedType: PendingRequest['expectedType'],
  ): Promise<Record<string, unknown>> {
    const child = await this.ensureProcess();
    const id = this.nextRequestId();
    const message = `${JSON.stringify({ id, type, ...payload })}\n`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new VoiceSttRuntimeError(
          'voice-stt-timeout',
          `Локальный STT не завершил ${type} за отведённое время.`,
          this.stderrDetails(),
        );
        this.markFailed(error.code);
        child.kill();
        reject(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { expectedType, resolve, reject, timer });
      if (!child.stdin.writable || child.stdin.writableEnded || child.stdin.destroyed) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new VoiceSttRuntimeError(
          'voice-stt-runtime-unavailable',
          'Локальный STT worker уже остановлен.',
          this.stderrDetails(),
        ));
        return;
      }
      child.stdin.write(message, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const failure = new VoiceSttRuntimeError(
          'voice-stt-runtime-unavailable',
          `Не удалось передать запись локальному STT worker: ${error.message}`,
          this.stderrDetails(),
        );
        this.markFailed(failure.code);
        pending.reject(failure);
      });
    });
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    if (this.startPromise) return this.startPromise;

    const startPromise = this.startProcess().finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  private async startProcess(): Promise<ChildProcessWithoutNullStreams> {
    const workerScriptPath = this.workerScriptPath();
    if (!existsSync(workerScriptPath)) {
      throw new VoiceSttRuntimeError(
        'voice-stt-runtime-missing',
        'Локальный Vosk worker не найден.',
      );
    }

    this.state = 'starting';
    this.lastError = undefined;
    this.stderr = '';
    this.intentionalShutdown = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executablePath(), [workerScriptPath, '--worker'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      });
    } catch (error) {
      throw runtimeMissingError(error);
    }

    this.child = child;
    this.attachProcess(child);
    try {
      await waitForSpawn(child);
      return child;
    } catch (error) {
      if (this.child === child) this.child = null;
      throw runtimeMissingError(error);
    }
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    const stdout = readline.createInterface({ input: child.stdout });
    this.stdout = stdout;
    stdout.on('line', (line) => this.handleWorkerLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_LENGTH);
    });
    child.once('error', (error) => {
      const failure = runtimeMissingError(error);
      this.markFailed(failure.code);
      this.rejectPending(failure);
    });
    child.once('close', (exitCode) => {
      if (this.child === child) this.child = null;
      this.workerPid = undefined;
      if (this.stdout === stdout) {
        stdout.close();
        this.stdout = null;
      }
      if (this.intentionalShutdown) return;
      const failure = new VoiceSttRuntimeError(
        'voice-stt-runtime-exited',
        `Локальный STT worker завершился${exitCode === null ? '' : ` с кодом ${exitCode}`}.`,
        this.stderrDetails(),
      );
      this.markFailed(failure.code);
      this.rejectPending(failure);
    });
  }

  private handleWorkerLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let envelope: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSONL entry is not an object');
      }
      envelope = parsed as Record<string, unknown>;
    } catch {
      const failure = new VoiceSttRuntimeError(
        'voice-stt-protocol-error',
        'Локальный STT worker вернул повреждённый JSONL.',
        this.stderrDetails(),
      );
      this.markFailed(failure.code);
      this.rejectPending(failure);
      return;
    }

    const id = typeof envelope.id === 'string' ? envelope.id : '';
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    const responseType = typeof envelope.type === 'string' ? envelope.type : '';
    if (responseType === 'error') {
      const failure = new VoiceSttRuntimeError(
        readWorkerErrorCode(envelope.code),
        readWorkerErrorMessage(envelope.message),
        this.stderrDetails(),
      );
      this.markFailed(failure.code);
      pending.reject(failure);
      return;
    }
    if (responseType !== pending.expectedType) {
      const failure = new VoiceSttRuntimeError(
        'voice-stt-protocol-error',
        `Локальный STT worker вернул неожиданный ответ: ${responseType || 'missing'}.`,
      );
      this.markFailed(failure.code);
      pending.reject(failure);
      return;
    }
    pending.resolve(envelope);
  }

  private markReady(result: VoiceSttPrepareResult | VoiceSttTranscribeResult): void {
    this.state = 'ready';
    this.model = result.model;
    this.workerPid = result.pid;
    if (result.loadMs > 0 || this.loadMs === undefined) this.loadMs = result.loadMs;
    this.lastError = undefined;
  }

  private markFailed(code: string): void {
    this.state = 'failed';
    this.lastError = code;
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `voice-stt-${process.pid}-${this.requestSequence}`;
  }

  private workerScriptPath(): string {
    const candidate = path.resolve(
      this.workspaceRoot,
      this.options.workerScriptPath || path.join('tools', 'local-vosk-transcribe.py'),
    );
    if (!isPathInside(this.workspaceRoot, candidate)) {
      throw new VoiceSttRuntimeError(
        'voice-stt-runtime-path-denied',
        'Локальный STT worker должен находиться внутри workspace Monarch.',
      );
    }
    return candidate;
  }

  private executablePath(): string {
    return this.options.executable || process.env.MONARCH_STT_PYTHON || 'python';
  }

  private stderrDetails(): Record<string, unknown> {
    const diagnostic = this.stderr.trim().slice(-1_000);
    return diagnostic ? { stderr: diagnostic } : {};
  }
}

function normalizeTranscribeInput(
  input: VoiceSttTranscribeInput,
  audioRoot: string,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw new VoiceSttRuntimeError('voice-stt-audio-invalid', 'Нужен путь к локальной аудиозаписи.');
  }
  const audioPath = typeof input.audioPath === 'string' ? path.resolve(input.audioPath) : '';
  if (!audioPath || !isPathInside(audioRoot, audioPath)) {
    throw new VoiceSttRuntimeError(
      'voice-stt-audio-path-denied',
      'STT worker принимает только временные аудиофайлы Monarch.',
    );
  }
  const language = typeof input.language === 'string' ? input.language.trim() : '';
  if (!/^(ru-RU|uk-UA|bg-BG|en-US)$/.test(language)) {
    throw new VoiceSttRuntimeError(
      'voice-stt-language-unsupported',
      'Язык голосового ввода не поддерживается.',
    );
  }
  return { audioPath, language };
}

function normalizeStreamStartInput(input: VoiceSttStreamStartInput): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw new VoiceSttRuntimeError('voice-stt-stream-invalid', 'Нужны параметры PCM stream.');
  }
  const language = typeof input.language === 'string' ? input.language.trim() : '';
  if (!/^(ru-RU|uk-UA|bg-BG|en-US)$/.test(language)) {
    throw new VoiceSttRuntimeError('voice-stt-language-unsupported', 'Язык голосового ввода не поддерживается.');
  }
  const sampleRate = input.sampleRate;
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 48_000) {
    throw new VoiceSttRuntimeError('voice-stt-stream-rate-invalid', 'PCM sample rate должен быть 8000-48000 Hz.');
  }
  return { streamId: normalizeStreamId(input.streamId), language, sampleRate };
}

function normalizeStreamPushInput(input: VoiceSttStreamPushInput): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    throw new VoiceSttRuntimeError('voice-stt-stream-invalid', 'Нужен PCM batch.');
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 0) {
    throw new VoiceSttRuntimeError('voice-stt-stream-sequence', 'PCM batch sequence некорректен.');
  }
  const pcmBase64 = typeof input.pcmBase64 === 'string' ? input.pcmBase64 : '';
  if (!pcmBase64 || pcmBase64.length > 96 * 1024) {
    throw new VoiceSttRuntimeError('voice-stt-stream-pcm-invalid', 'PCM batch некорректен.');
  }
  const bytes = Buffer.from(pcmBase64, 'base64');
  if (!bytes.byteLength || bytes.byteLength % 2 !== 0 || bytes.byteLength > 64 * 1024
    || bytes.toString('base64').replace(/=+$/, '') !== pcmBase64.replace(/=+$/, '')) {
    throw new VoiceSttRuntimeError('voice-stt-stream-pcm-invalid', 'PCM batch некорректен.');
  }
  return { streamId: normalizeStreamId(input.streamId), sequence: input.sequence, pcmBase64 };
}

function normalizeStreamId(value: string): string {
  const streamId = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(streamId)) {
    throw new VoiceSttRuntimeError('voice-stt-stream-invalid', 'STT stream id некорректен.');
  }
  return streamId;
}

function readPrepareResult(envelope: Record<string, unknown>): VoiceSttPrepareResult {
  return {
    status: 'ready',
    engine: readEngine(envelope.engine),
    model: readRequiredString(envelope.model, 'model'),
    loadMs: readNonNegativeNumber(envelope.loadMs, 'loadMs'),
    warm: envelope.warm === true,
    pid: readPositiveInteger(envelope.pid, 'pid'),
  };
}

function readTranscribeResult(envelope: Record<string, unknown>): VoiceSttTranscribeResult {
  return {
    text: readOptionalString(envelope.text),
    engine: readEngine(envelope.engine),
    model: readRequiredString(envelope.model, 'model'),
    loadMs: readNonNegativeNumber(envelope.loadMs, 'loadMs'),
    warm: envelope.warm === true,
    conversionMs: readNonNegativeNumber(envelope.conversionMs, 'conversionMs'),
    recognitionMs: readNonNegativeNumber(envelope.recognitionMs, 'recognitionMs'),
    totalMs: readNonNegativeNumber(envelope.totalMs, 'totalMs'),
    pid: readPositiveInteger(envelope.pid, 'pid'),
  };
}

export function readStreamStartResult(
  envelope: Record<string, unknown>,
  expectedEngine: VoiceSttEngine,
): VoiceSttStreamStartResult {
  return {
    engine: readExpectedEngine(envelope.engine, expectedEngine),
    model: readRequiredString(envelope.model, 'model'),
    loadMs: readNonNegativeNumber(envelope.loadMs, 'loadMs'),
    warm: envelope.warm === true,
    sampleRate: readPositiveInteger(envelope.sampleRate, 'sampleRate'),
    pid: readPositiveInteger(envelope.pid, 'pid'),
  };
}

export function readStreamPushResult(
  envelope: Record<string, unknown>,
  expectedEngine: VoiceSttEngine,
): VoiceSttStreamPushResult {
  return {
    engine: readExpectedEngine(envelope.engine, expectedEngine),
    partial: readOptionalString(envelope.partial),
    sequence: readNonNegativeInteger(envelope.sequence, 'sequence'),
    processingMs: readNonNegativeNumber(envelope.processingMs, 'processingMs'),
    audioMs: readNonNegativeNumber(envelope.audioMs, 'audioMs'),
    pid: readPositiveInteger(envelope.pid, 'pid'),
  };
}

export function readStreamFinalResult(
  envelope: Record<string, unknown>,
  expectedEngine: VoiceSttEngine,
): VoiceSttStreamFinalResult {
  return {
    text: readOptionalString(envelope.text),
    engine: readExpectedEngine(envelope.engine, expectedEngine),
    model: readRequiredString(envelope.model, 'model'),
    recognitionMs: readNonNegativeNumber(envelope.recognitionMs, 'recognitionMs'),
    finalizeMs: readNonNegativeNumber(envelope.finalizeMs, 'finalizeMs'),
    audioMs: readNonNegativeNumber(envelope.audioMs, 'audioMs'),
    bytes: readNonNegativeInteger(envelope.bytes, 'bytes'),
    partialAgeMs: envelope.partialAgeMs === null || envelope.partialAgeMs === undefined
      ? null
      : readNonNegativeNumber(envelope.partialAgeMs, 'partialAgeMs'),
    pid: readPositiveInteger(envelope.pid, 'pid'),
  };
}

function readEngine(value: unknown): 'vosk' {
  if (value !== 'vosk') {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', 'STT worker did not confirm Vosk.');
  }
  return value;
}

function readExpectedEngine(value: unknown, expected: VoiceSttEngine): VoiceSttEngine {
  if (value !== expected) {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', `STT worker did not confirm ${expected}.`);
  }
  return expected;
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function readRequiredString(value: unknown, field: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', `STT worker response is missing ${field}.`);
  }
  return text;
}

function readNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', `STT worker response has invalid ${field}.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', `STT worker response has invalid ${field}.`);
  }
  return value;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', `STT worker response has invalid ${field}.`);
  }
  return value;
}

function readWorkerErrorCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^voice-(?:stt|audio)-[a-z0-9-]+$/.test(code) ? code : 'voice-stt-worker-error';
}

function readWorkerErrorMessage(value: unknown): string {
  const message = typeof value === 'string' ? value.trim() : '';
  return message ? message.slice(0, 500) : 'Локальный STT worker завершил запрос с ошибкой.';
}

function readFailureCode(error: unknown): string {
  return error instanceof VoiceSttRuntimeError ? error.code : 'voice-stt-runtime-failed';
}

function runtimeMissingError(error: unknown): VoiceSttRuntimeError {
  return new VoiceSttRuntimeError(
    'voice-stt-runtime-missing',
    `Python runtime для локального STT недоступен: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function readTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Number.isFinite(value) ? Math.max(250, Math.floor(value)) : DEFAULT_REQUEST_TIMEOUT_MS;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
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

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('close', onClose);
  });
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

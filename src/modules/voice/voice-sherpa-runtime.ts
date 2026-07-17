import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  VoiceSttRuntimeError,
  readStreamFinalResult,
  readStreamPushResult,
  readStreamStartResult,
  type VoiceSttPrepareResult,
  type VoiceSttRuntimeSnapshot,
  type VoiceSttStreamCancelResult,
  type VoiceSttStreamFinalResult,
  type VoiceSttStreamPushInput,
  type VoiceSttStreamPushResult,
  type VoiceSttStreamStartInput,
  type VoiceSttStreamStartResult,
} from './voice-stt-runtime';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PENDING = 8;
const MAX_STDERR_LENGTH = 16_000;

interface PendingRequest {
  expectedType: 'ready' | 'stream-started' | 'stream-partial' | 'stream-final' | 'stream-cancelled';
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SherpaVoiceSttRuntimeOptions {
  workspaceRoot?: string;
  executable?: string;
  workerScriptPath?: string;
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
}

export class SherpaVoiceSttRuntime {
  private readonly workspaceRoot: string;
  private readonly options: SherpaVoiceSttRuntimeOptions;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly pending = new Map<string, PendingRequest>();
  private pendingReservations = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: readline.Interface | null = null;
  private startPromise: Promise<ChildProcessWithoutNullStreams> | null = null;
  private sequence = 0;
  private state: VoiceSttRuntimeSnapshot['state'] = 'idle';
  private model: string | undefined;
  private pid: number | undefined;
  private loadMs: number | undefined;
  private lastError: string | undefined;
  private stderr = '';
  private intentionalShutdown = false;

  constructor(options: SherpaVoiceSttRuntimeOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.options = options;
    this.timeoutMs = readBoundedInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS, 250, 120_000);
    this.maxPending = readBoundedInteger(options.maxPendingRequests, DEFAULT_MAX_PENDING, 1, 32);
  }

  async prepare(language = 'ru-RU'): Promise<VoiceSttPrepareResult> {
    try {
      const envelope = await this.send('prepare', { language }, 'ready');
      const result = readPrepare(envelope);
      this.markReady(result);
      return result;
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  async startStream(input: VoiceSttStreamStartInput): Promise<VoiceSttStreamStartResult> {
    try {
      const envelope = await this.send('stream-start', { ...input }, 'stream-started');
      const result = readStreamStartResult(envelope, 'sherpa-onnx-t-one');
      this.markReady({ status: 'ready', ...result });
      return result;
    } catch (error) {
      this.markFailed(error);
      throw error;
    }
  }

  async pushStream(input: VoiceSttStreamPushInput): Promise<VoiceSttStreamPushResult> {
    return readStreamPushResult(
      await this.send('stream-push', { ...input }, 'stream-partial'),
      'sherpa-onnx-t-one',
    );
  }

  async finishStream(streamId: string): Promise<VoiceSttStreamFinalResult> {
    return readStreamFinalResult(
      await this.send('stream-finish', { streamId }, 'stream-final'),
      'sherpa-onnx-t-one',
    );
  }

  async cancelStream(streamId: string): Promise<VoiceSttStreamCancelResult> {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return { cancelled: false };
    const envelope = await this.send('stream-cancel', { streamId }, 'stream-cancelled');
    return {
      cancelled: envelope.cancelled === true,
      ...(typeof envelope.pid === 'number' ? { pid: envelope.pid } : {}),
    };
  }

  snapshot(): VoiceSttRuntimeSnapshot {
    return {
      state: this.state,
      engine: 'sherpa-onnx-t-one',
      ...(this.model ? { model: this.model } : {}),
      ...(this.pid ? { pid: this.pid } : {}),
      ...(this.loadMs !== undefined ? { loadMs: this.loadMs } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.state = 'idle';
      return;
    }
    this.intentionalShutdown = true;
    const closed = waitForClose(child, 1_500);
    if (child.stdin.writable && !child.stdin.writableEnded) {
      child.stdin.write(`${JSON.stringify({ id: this.nextId(), type: 'shutdown' })}\n`);
      child.stdin.end();
    }
    let exited = await closed;
    if (!exited && child.exitCode === null) {
      child.kill();
      exited = await waitForClose(child, 500);
    }
    if (!exited && child.exitCode === null) {
      this.intentionalShutdown = false;
      const failure = new VoiceSttRuntimeError(
        'voice-stt-retirement-timeout',
        'T-one worker не завершился; Vosk не будет загружен параллельно.',
        this.stderrDetails(),
      );
      this.markFailed(failure);
      throw failure;
    }
    if (this.child === child) this.child = null;
    this.stdout?.close();
    this.stdout = null;
    this.rejectPending(new VoiceSttRuntimeError('voice-stt-stopped', 'T-one worker остановлен.'));
    this.state = 'idle';
    this.pid = undefined;
    this.intentionalShutdown = false;
  }

  private async send(
    type: 'prepare' | 'stream-start' | 'stream-push' | 'stream-finish' | 'stream-cancel',
    payload: Record<string, unknown>,
    expectedType: PendingRequest['expectedType'],
  ): Promise<Record<string, unknown>> {
    if (this.pending.size + this.pendingReservations >= this.maxPending) {
      throw new VoiceSttRuntimeError(
        'voice-stt-queue-overflow',
        'Очередь T-one worker переполнена; запись будет обработана fallback-путём.',
      );
    }
    this.pendingReservations += 1;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = await this.ensureProcess();
    } finally {
      this.pendingReservations -= 1;
    }
    if (this.pending.size >= this.maxPending) {
      throw new VoiceSttRuntimeError(
        'voice-stt-queue-overflow',
        'Очередь T-one worker переполнена; запись будет обработана fallback-путём.',
      );
    }
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new VoiceSttRuntimeError(
          'voice-stt-timeout',
          `T-one worker не завершил ${type} вовремя.`,
          this.stderrDetails(),
        );
        child.kill();
        reject(error);
      }, this.timeoutMs);
      this.pending.set(id, { expectedType, resolve, reject, timer });
      if (!child.stdin.writable || child.stdin.writableEnded || child.stdin.destroyed) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new VoiceSttRuntimeError('voice-stt-runtime-unavailable', 'T-one worker уже остановлен.'));
        return;
      }
      child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new VoiceSttRuntimeError(
          'voice-stt-runtime-unavailable',
          `Не удалось передать PCM T-one worker: ${error.message}`,
          this.stderrDetails(),
        ));
      });
    });
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    if (this.startPromise) return this.startPromise;
    const startPromise = this.startProcess().finally(() => {
      if (this.startPromise === startPromise) this.startPromise = null;
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  private async startProcess(): Promise<ChildProcessWithoutNullStreams> {
    const workerPath = path.resolve(
      this.workspaceRoot,
      this.options.workerScriptPath || path.join('src', 'modules', 'voice', 'workers', 'voice-sherpa-worker.cjs'),
    );
    if (!isPathInside(this.workspaceRoot, workerPath) || !existsSync(workerPath)) {
      throw new VoiceSttRuntimeError('voice-stt-runtime-missing', 'T-one worker не найден внутри Monarch workspace.');
    }
    this.state = 'starting';
    this.lastError = undefined;
    this.stderr = '';
    this.intentionalShutdown = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.executable || process.execPath, [workerPath], {
        cwd: this.workspaceRoot,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      throw runtimeMissing(error);
    }
    this.child = child;
    this.attach(child);
    try {
      await waitForSpawn(child);
      return child;
    } catch (error) {
      if (this.child === child) this.child = null;
      throw runtimeMissing(error);
    }
  }

  private attach(child: ChildProcessWithoutNullStreams): void {
    const stdout = readline.createInterface({ input: child.stdout });
    this.stdout = stdout;
    stdout.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_LENGTH);
    });
    child.once('error', (error) => {
      const failure = runtimeMissing(error);
      this.markFailed(failure);
      this.rejectPending(failure);
    });
    child.once('close', (exitCode) => {
      if (this.child === child) this.child = null;
      this.pid = undefined;
      if (this.stdout === stdout) {
        stdout.close();
        this.stdout = null;
      }
      if (this.intentionalShutdown) return;
      const failure = new VoiceSttRuntimeError(
        'voice-stt-runtime-exited',
        `T-one worker завершился${exitCode === null ? '' : ` с кодом ${exitCode}`}.`,
        this.stderrDetails(),
      );
      this.markFailed(failure);
      this.rejectPending(failure);
    });
  }

  private handleLine(line: string): void {
    let envelope: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not-object');
      envelope = parsed as Record<string, unknown>;
    } catch {
      const failure = new VoiceSttRuntimeError('voice-stt-protocol-error', 'T-one worker вернул повреждённый JSONL.');
      this.markFailed(failure);
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
        readErrorCode(envelope.code),
        typeof envelope.message === 'string' ? envelope.message.slice(0, 500) : 'T-one worker error.',
        this.stderrDetails(),
      );
      pending.reject(failure);
      return;
    }
    if (responseType !== pending.expectedType) {
      pending.reject(new VoiceSttRuntimeError(
        'voice-stt-protocol-error',
        `T-one worker вернул неожиданный ответ: ${responseType || 'missing'}.`,
      ));
      return;
    }
    pending.resolve(envelope);
  }

  private markReady(result: VoiceSttPrepareResult): void {
    this.state = 'ready';
    this.model = result.model;
    this.pid = result.pid;
    if (result.loadMs > 0 || this.loadMs === undefined) this.loadMs = result.loadMs;
    this.lastError = undefined;
  }

  private markFailed(error: unknown): void {
    this.state = 'failed';
    this.lastError = error instanceof VoiceSttRuntimeError ? error.code : 'voice-stt-runtime-failed';
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private nextId(): string {
    this.sequence += 1;
    return `voice-sherpa-${process.pid}-${this.sequence}`;
  }

  private stderrDetails(): Record<string, unknown> {
    const stderr = this.stderr.trim().slice(-1_000);
    return stderr ? { stderr } : {};
  }
}

function readPrepare(envelope: Record<string, unknown>): VoiceSttPrepareResult {
  if (envelope.engine !== 'sherpa-onnx-t-one') {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', 'Worker did not confirm T-one.');
  }
  const model = typeof envelope.model === 'string' ? envelope.model.trim() : '';
  const loadMs = envelope.loadMs;
  const pid = envelope.pid;
  if (!model || typeof loadMs !== 'number' || !Number.isFinite(loadMs) || loadMs < 0
    || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new VoiceSttRuntimeError('voice-stt-protocol-error', 'T-one prepare response некорректен.');
  }
  return { status: 'ready', engine: 'sherpa-onnx-t-one', model, loadMs, warm: envelope.warm === true, pid };
}

function readErrorCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^voice-stt-[a-z0-9-]+$/.test(code) ? code : 'voice-stt-worker-error';
}

function runtimeMissing(error: unknown): VoiceSttRuntimeError {
  return new VoiceSttRuntimeError(
    'voice-stt-runtime-missing',
    `Node runtime для T-one недоступен: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function readBoundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.min(max, Math.max(min, Math.floor(value)));
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
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
    const onClose = () => { clearTimeout(timer); resolve(true); };
    child.once('close', onClose);
  });
}

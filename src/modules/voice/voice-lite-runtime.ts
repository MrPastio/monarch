import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const WORKER_RETIRE_TIMEOUT_MS = 1_500;
const MAX_TEXT_LENGTH = 1_200;
const MAX_STDERR_LENGTH = 16_000;

export type VoiceModeProfile = 'micro' | 'lite';

export interface VoiceModeProfileMetadata {
  modelName: string;
  repository: string;
  license: 'Apache-2.0';
  sha256: string;
}

export const VOICE_MODE_PROFILE_METADATA: Readonly<Record<VoiceModeProfile, VoiceModeProfileMetadata>> = {
  micro: {
    modelName: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    repository: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    license: 'Apache-2.0',
    sha256: '74A4DA8C9FDBCD15BD1F6D01D621410D31C6FC00986F5EB687824E7B93D7A9DB',
  },
  lite: {
    modelName: 'qwen3-1.7b-q4_k_m.gguf',
    repository: 'unsloth/Qwen3-1.7B-GGUF',
    license: 'Apache-2.0',
    sha256: 'B139949C5BD74937AD8ED8C8CF3D9FFB1E99C866C823204DC42C0D91FA181897',
  },
};

export const VOICE_MODE_PROFILE_MODEL_NAMES: Readonly<Record<VoiceModeProfile, string>> = {
  micro: VOICE_MODE_PROFILE_METADATA.micro.modelName,
  lite: VOICE_MODE_PROFILE_METADATA.lite.modelName,
};

export interface VoiceProfileRespondInput {
  text: string;
}

export interface VoiceProfilePrepareResult {
  status: 'ready';
  profile: VoiceModeProfile;
  backend: 'llama-cpp-cpu';
  model: string;
  repository: string;
  license: 'Apache-2.0';
  sha256: string;
  loadMs: number;
  pid: number;
}

export interface VoiceProfileRespondResult {
  text: string;
  profile: VoiceModeProfile;
  backend: 'llama-cpp-cpu';
  model: string;
  loadMs: number;
  generationMs: number;
  ttftMs: number;
  pid: number;
}

export interface VoiceProfileRuntimeSnapshot {
  state: 'idle' | 'starting' | 'ready' | 'failed';
  profile: VoiceModeProfile;
  backend: 'llama-cpp-cpu';
  model: string;
  repository: string;
  license: 'Apache-2.0';
  sha256: string;
  pid?: number;
  loadMs?: number;
  lastError?: string;
}

export interface VoiceProfileRuntimePort {
  prepare(): Promise<VoiceProfilePrepareResult>;
  respond(input: VoiceProfileRespondInput): Promise<VoiceProfileRespondResult>;
  shutdown(): Promise<void>;
  snapshot(): VoiceProfileRuntimeSnapshot;
}

export interface VoiceProfileRuntimeOptions {
  profile: VoiceModeProfile;
  workspaceRoot?: string;
  executable?: string;
  workerScriptPath?: string;
  modelPath?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  expectedType: 'ready' | 'response';
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface NormalizedRespondInput {
  text: string;
}

export class VoiceModeRuntimeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'VoiceModeRuntimeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Persistent, CPU-only local inference worker for the latency-first voice lane.
 * It intentionally accepts only one user turn and never receives Oscar memory,
 * tools, the normal system prompt, or caller-provided chat messages.
 */
export class VoiceProfileRuntime implements VoiceProfileRuntimePort {
  readonly profile: VoiceModeProfile;
  private readonly workspaceRoot: string;
  private readonly options: VoiceProfileRuntimeOptions;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout: readline.Interface | null = null;
  private startPromise: Promise<ChildProcessWithoutNullStreams> | null = null;
  private requestTail: Promise<void> = Promise.resolve();
  private requestSequence = 0;
  private state: VoiceProfileRuntimeSnapshot['state'] = 'idle';
  private loadMs: number | undefined;
  private workerPid: number | undefined;
  private lastError: string | undefined;
  private stderr = '';
  private readonly intentionalChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly quarantinedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private retirement: {
    child: ChildProcessWithoutNullStreams;
    closed: Promise<void>;
  } | null = null;

  constructor(options: VoiceProfileRuntimeOptions) {
    this.profile = options.profile;
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.options = options;
    this.requestTimeoutMs = readTimeout(options.requestTimeoutMs);
  }

  async prepare(): Promise<VoiceProfilePrepareResult> {
    return this.enqueue(async () => {
      try {
        const envelope = await this.sendRequest('prepare', {}, 'ready');
        const result = readPrepareResult(envelope, this.profile);
        this.markReady(result.loadMs, result.pid);
        return result;
      } catch (error) {
        this.handleOperationFailure(error);
        throw error;
      }
    });
  }

  async respond(input: VoiceProfileRespondInput): Promise<VoiceProfileRespondResult> {
    const normalized = normalizeRespondInput(input);
    return this.enqueue(async () => {
      try {
        const envelope = await this.sendRequest('respond', { ...normalized }, 'response');
        const result = readRespondResult(envelope, this.profile);
        this.markReady(result.loadMs, result.pid);
        return result;
      } catch (error) {
        this.handleOperationFailure(error);
        throw error;
      }
    });
  }

  snapshot(): VoiceProfileRuntimeSnapshot {
    const pid = this.workerPid;
    const metadata = VOICE_MODE_PROFILE_METADATA[this.profile];
    return {
      state: this.state,
      profile: this.profile,
      backend: 'llama-cpp-cpu',
      model: this.configuredModelName(),
      repository: metadata.repository,
      license: metadata.license,
      sha256: metadata.sha256,
      ...(pid !== undefined ? { pid } : {}),
      ...(this.loadMs !== undefined ? { loadMs: this.loadMs } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.awaitRetirement();
      this.state = 'idle';
      return;
    }

    this.intentionalChildren.add(child);
    const closed = waitForClose(child, 1_500);
    if (child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({
        id: this.nextRequestId(),
        type: 'shutdown',
      })}\n`);
      child.stdin.end();
    }
    let exited = await closed;
    if (!exited && child.exitCode === null) {
      child.kill();
      exited = await waitForClose(child, 500);
    }
    if (!exited && child.exitCode === null) {
      this.intentionalChildren.delete(child);
      const failure = new VoiceModeRuntimeError(
        'voice-lite-retirement-timeout',
        'Voice-lite worker did not exit; a replacement will not be started.',
        this.stderrDetails(),
      );
      this.markFailed(failure.code);
      throw failure;
    }
    if (this.child === child) {
      this.child = null;
    }
    this.stdout?.close();
    this.stdout = null;
    this.rejectPending(new VoiceModeRuntimeError(
      'voice-lite-stopped',
      'Voice-lite runtime was stopped.',
    ));
    this.state = 'idle';
    this.workerPid = undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.requestTail.then(operation, operation);
    this.requestTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async sendRequest(
    type: 'prepare' | 'respond',
    payload: Record<string, unknown>,
    expectedType: PendingRequest['expectedType'],
  ): Promise<Record<string, unknown>> {
    const child = await this.ensureProcess();
    const id = this.nextRequestId();
    const message = `${JSON.stringify({ id, type, ...payload })}\n`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new VoiceModeRuntimeError(
          'voice-lite-timeout',
          `Voice-lite ${type} request timed out.`,
          this.stderrDetails(),
        );
        this.quarantineChild(child, error);
        reject(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { expectedType, resolve, reject, timer });
      child.stdin.write(message, 'utf8', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        const failure = new VoiceModeRuntimeError(
          'voice-lite-runtime-unavailable',
          `Could not write to voice-lite worker: ${error.message}`,
          this.stderrDetails(),
        );
        this.quarantineChild(child, failure);
        pending.reject(failure);
      });
    });
  }

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    await this.awaitRetirement();
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const startPromise = this.startProcess().finally(() => {
      if (this.startPromise === startPromise) {
        this.startPromise = null;
      }
    });
    this.startPromise = startPromise;
    return startPromise;
  }

  private async startProcess(): Promise<ChildProcessWithoutNullStreams> {
    const workerScriptPath = this.workerScriptPath();
    const modelPath = this.modelPath();
    if (!existsSync(workerScriptPath)) {
      throw new VoiceModeRuntimeError(
        'voice-lite-runtime-missing',
        'Voice-lite worker script is missing.',
      );
    }
    if (!existsSync(modelPath)) {
      throw new VoiceModeRuntimeError(
        'voice-lite-model-missing',
        `Voice-lite model is not installed: ${path.basename(modelPath)}.`,
      );
    }

    this.state = 'starting';
    this.lastError = undefined;
    this.stderr = '';

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.executablePath(), [
        workerScriptPath,
        '--profile',
        this.profile,
        '--model',
        modelPath,
      ], {
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
      const failure = runtimeMissingError(error);
      this.markFailed(failure.code);
      throw failure;
    }

    this.child = child;
    this.attachProcess(child);
    try {
      await waitForSpawn(child);
      return child;
    } catch (error) {
      const failure = runtimeMissingError(error);
      this.markFailed(failure.code);
      if (this.child === child) this.child = null;
      throw failure;
    }
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    const stdout = readline.createInterface({ input: child.stdout });
    this.stdout = stdout;
    stdout.on('line', (line) => this.handleWorkerLine(child, line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_LENGTH);
    });
    child.once('error', (error) => {
      const failure = runtimeMissingError(error);
      this.quarantineChild(child, failure);
    });
    child.once('close', (exitCode) => {
      if (this.child === child) {
        this.child = null;
      }
      this.workerPid = undefined;
      if (this.stdout === stdout) {
        stdout.close();
        this.stdout = null;
      }
      if (this.intentionalChildren.delete(child) || this.quarantinedChildren.has(child)) return;
      const failure = new VoiceModeRuntimeError(
        'voice-lite-runtime-exited',
        `Voice-lite worker exited${exitCode === null ? '' : ` with code ${exitCode}`}.`,
        this.stderrDetails(),
      );
      this.markFailed(failure.code);
      this.rejectPending(failure);
    });
  }

  private handleWorkerLine(child: ChildProcessWithoutNullStreams, line: string): void {
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
      const failure = new VoiceModeRuntimeError(
        'voice-lite-protocol-error',
        'Voice-lite worker emitted invalid JSONL output.',
        this.stderrDetails(),
      );
      this.quarantineChild(child, failure);
      return;
    }

    const id = typeof envelope.id === 'string' ? envelope.id : '';
    const pending = id ? this.pending.get(id) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);

    const responseType = typeof envelope.type === 'string' ? envelope.type : '';
    if (responseType === 'error') {
      const code = readWorkerErrorCode(envelope.code);
      const message = readWorkerErrorMessage(envelope.message);
      const failure = new VoiceModeRuntimeError(code, message, this.stderrDetails());
      if (isFatalWorkerError(code)) this.quarantineChild(child, failure);
      else this.markFailed(failure.code);
      pending.reject(failure);
      return;
    }
    if (responseType !== pending.expectedType) {
      const failure = new VoiceModeRuntimeError(
        'voice-lite-protocol-error',
        `Voice-lite worker returned unexpected response type: ${responseType || 'missing'}.`,
      );
      this.quarantineChild(child, failure);
      pending.reject(failure);
      return;
    }
    pending.resolve(envelope);
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private handleOperationFailure(error: unknown): void {
    const code = error instanceof VoiceModeRuntimeError ? error.code : 'voice-lite-runtime-failed';
    this.markFailed(code);
    if (code === 'voice-lite-protocol-error' && this.child) {
      this.quarantineChild(this.child, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private quarantineChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    this.markFailed(error instanceof VoiceModeRuntimeError ? error.code : 'voice-lite-runtime-failed');
    this.workerPid = undefined;
    this.quarantinedChildren.add(child);
    if (this.child === child) this.child = null;
    this.rejectPending(error);
    if (this.retirement?.child === child) return;
    const closed = child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('close', () => resolve()));
    const retirement = { child, closed };
    this.retirement = retirement;
    void closed.finally(() => {
      if (this.retirement === retirement) this.retirement = null;
    });
    if (child.exitCode === null && !child.killed) child.kill();
  }

  private async awaitRetirement(): Promise<void> {
    const retirement = this.retirement;
    if (!retirement) return;
    const closed = await Promise.race([
      retirement.closed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), WORKER_RETIRE_TIMEOUT_MS)),
    ]);
    if (!closed) {
      const failure = new VoiceModeRuntimeError(
        'voice-lite-retirement-timeout',
        'Previous Voice-lite worker is still alive; refusing to overlap a replacement.',
      );
      this.markFailed(failure.code);
      throw failure;
    }
  }

  private markReady(loadMs: number, pid: number): void {
    this.state = 'ready';
    this.loadMs = loadMs;
    this.workerPid = pid;
    this.lastError = undefined;
  }

  private markFailed(code: string): void {
    this.state = 'failed';
    this.lastError = code;
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `voice-lite-${process.pid}-${this.requestSequence}`;
  }

  private configuredModelName(): string {
    const configured = this.options.modelPath || VOICE_MODE_PROFILE_MODEL_NAMES[this.profile];
    return path.basename(configured);
  }

  private modelPath(): string {
    const allowedRoot = path.resolve(this.workspaceRoot, 'runtime', 'voice', 'models', 'voice-lite');
    const configured = this.options.modelPath;
    const candidate = configured
      ? path.resolve(this.workspaceRoot, configured)
      : path.join(allowedRoot, VOICE_MODE_PROFILE_MODEL_NAMES[this.profile]);
    if (!isPathInside(allowedRoot, candidate) || path.extname(candidate).toLowerCase() !== '.gguf') {
      throw new VoiceModeRuntimeError(
        'voice-lite-model-path-denied',
        'Voice-lite model must be a GGUF file inside runtime/voice/models/voice-lite.',
      );
    }
    return candidate;
  }

  private workerScriptPath(): string {
    const candidate = path.resolve(
      this.workspaceRoot,
      this.options.workerScriptPath || path.join('src', 'modules', 'voice', 'workers', 'voice-lite-worker.py'),
    );
    if (!isPathInside(this.workspaceRoot, candidate)) {
      throw new VoiceModeRuntimeError(
        'voice-lite-runtime-path-denied',
        'Voice-lite worker must be inside the Monarch workspace.',
      );
    }
    return candidate;
  }

  private executablePath(): string {
    const explicit = this.options.executable || process.env.MONARCH_VOICE_LITE_PYTHON;
    if (explicit) return explicit;
    const bundled = path.join(this.workspaceRoot, 'oscar', '.venv', 'Scripts', 'python.exe');
    return existsSync(bundled) ? bundled : 'python';
  }

  private stderrDetails(): Record<string, unknown> {
    const diagnostic = this.stderr.trim().slice(-1_000);
    return diagnostic ? { stderr: diagnostic } : {};
  }
}

function normalizeRespondInput(input: VoiceProfileRespondInput): NormalizedRespondInput {
  if (!input || typeof input !== 'object') {
    throw new VoiceModeRuntimeError('voice-lite-input-invalid', 'Voice profile input must be an object.');
  }
  const text = typeof input.text === 'string'
    ? input.text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!text) {
    throw new VoiceModeRuntimeError('voice-lite-text-empty', 'Voice profile needs a non-empty transcript.');
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new VoiceModeRuntimeError(
      'voice-lite-text-too-long',
      `Voice-lite transcript exceeds ${MAX_TEXT_LENGTH} characters.`,
    );
  }

  return {
    text,
  };
}

function readPrepareResult(
  envelope: Record<string, unknown>,
  expectedProfile: VoiceModeProfile,
): VoiceProfilePrepareResult {
  const metadata = VOICE_MODE_PROFILE_METADATA[expectedProfile];
  return {
    status: 'ready',
    profile: readProfile(envelope.profile, expectedProfile),
    backend: readCpuBackend(envelope.backend),
    model: readRequiredString(envelope.model, 'model'),
    repository: metadata.repository,
    license: metadata.license,
    sha256: metadata.sha256,
    loadMs: readNonNegativeNumber(envelope.loadMs, 'loadMs'),
    pid: readPositiveInteger(envelope.pid, 'pid'),
  };
}

function readRespondResult(
  envelope: Record<string, unknown>,
  expectedProfile: VoiceModeProfile,
): VoiceProfileRespondResult {
  return {
    text: readRequiredString(envelope.text, 'text'),
    profile: readProfile(envelope.profile, expectedProfile),
    backend: readCpuBackend(envelope.backend),
    model: readRequiredString(envelope.model, 'model'),
    loadMs: readNonNegativeNumber(envelope.loadMs, 'loadMs'),
    generationMs: readNonNegativeNumber(envelope.generationMs, 'generationMs'),
    ttftMs: readNonNegativeNumber(envelope.ttftMs, 'ttftMs'),
    pid: readPositiveInteger(envelope.pid, 'pid'),
  };
}

function readCpuBackend(value: unknown): 'llama-cpp-cpu' {
  if (value !== 'llama-cpp-cpu') {
    throw new VoiceModeRuntimeError(
      'voice-lite-protocol-error',
      'Voice-lite worker did not confirm the CPU-only backend.',
    );
  }
  return value;
}

function readProfile(value: unknown, expected: VoiceModeProfile): VoiceModeProfile {
  if (value !== expected) {
    throw new VoiceModeRuntimeError(
      'voice-lite-protocol-error',
      `Voice worker returned an unexpected profile: ${String(value || 'missing')}.`,
    );
  }
  return expected;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VoiceModeRuntimeError(
      'voice-lite-protocol-error',
      `Voice-lite worker response is missing ${field}.`,
    );
  }
  return value.trim();
}

function readNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new VoiceModeRuntimeError(
      'voice-lite-protocol-error',
      `Voice-lite worker response has invalid ${field}.`,
    );
  }
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new VoiceModeRuntimeError(
      'voice-lite-protocol-error',
      `Voice-lite worker response has invalid ${field}.`,
    );
  }
  return value;
}

function readTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Number.isFinite(value) ? Math.max(250, Math.floor(value)) : DEFAULT_REQUEST_TIMEOUT_MS;
}

function readWorkerErrorCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^voice-lite-[a-z0-9-]+$/.test(code) ? code : 'voice-lite-worker-error';
}

function isFatalWorkerError(code: string): boolean {
  return ![
    'voice-lite-input-invalid',
    'voice-lite-text-empty',
    'voice-lite-text-too-long',
    'voice-lite-policy-override-denied',
  ].includes(code);
}

function readWorkerErrorMessage(value: unknown): string {
  const message = typeof value === 'string' ? value.trim() : '';
  return message ? message.slice(0, 500) : 'Voice-lite worker failed.';
}

function runtimeMissingError(error: unknown): VoiceModeRuntimeError {
  return new VoiceModeRuntimeError(
    'voice-lite-runtime-missing',
    `Voice-lite Python runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
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

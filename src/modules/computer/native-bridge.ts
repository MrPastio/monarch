import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_NATIVE_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_NATIVE_TIMEOUT_MS = 30_000;
const CURSOR_SIZE_POLICY = 'entire-sprite-max-1.5x-system-cursor' as const;

const OSCAR_CURSOR_ASSETS = [
  ['idle', 'Idle'],
  ['hover', 'Hover'],
  ['pressed', 'Pressed'],
  ['moving', 'Moving'],
  ['busy', 'Busy'],
  ['text', 'Text'],
  ['disabled', 'Disabled'],
] as const;

export interface ComputerWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerWindowSummary {
  windowRef: string;
  processId: number;
  processName: string;
  title: string;
  bounds: ComputerWindowBounds;
  minimized: boolean;
  foreground: boolean;
}

export interface ComputerElementSnapshot {
  elementId: string;
  name: string;
  value?: string;
  automationId: string;
  className: string;
  controlType: string;
  bounds: ComputerWindowBounds;
  enabled: boolean;
  offscreen: boolean;
  focusable: boolean;
  focused: boolean;
  password: boolean;
  patterns: string[];
}

export interface ComputerScreenshotReceipt {
  path: string;
  sha256: string;
  perceptualHash: string;
  width: number;
  height: number;
  captureMethod: string;
  occlusionSafe: boolean;
}

export interface ComputerNativeObservation {
  observedAt: string;
  window: ComputerWindowSummary;
  screenshot: ComputerScreenshotReceipt;
  stateFingerprint: string;
  focusedElementId: string | null;
  elements: ComputerElementSnapshot[];
  truncated: boolean;
}

export interface ComputerNativeActionTarget {
  elementId: string;
  name: string;
  automationId: string;
  className: string;
  controlType: string;
  bounds: ComputerWindowBounds;
  password: boolean;
}

export type ComputerNativeAction =
  | { kind: 'click'; target?: ComputerNativeActionTarget; x?: number; y?: number; button: 'left' | 'right' | 'middle'; clicks: 1 | 2 }
  | { kind: 'close' }
  | { kind: 'type'; target: ComputerNativeActionTarget; text: string }
  | { kind: 'key'; key: string; modifiers: string[] }
  | { kind: 'scroll'; target?: ComputerNativeActionTarget; x?: number; y?: number; deltaY: number };

export interface ComputerNativeActionRequest {
  windowRef: string;
  expectedProcessId: number;
  expectedTitle: string;
  expectedBounds: ComputerWindowBounds;
  expectedStateFingerprint: string;
  expectedPerceptualHash: string;
  action: ComputerNativeAction;
  afterScreenshotPath: string;
  controlStatePath: string;
  controlEpoch: number;
  inputLeaseId: string;
  cursorOrigin: { x: number; y: number };
}

export interface ComputerNativeActionReceipt {
  dispatchedAt: string;
  actionKind: string;
  foregroundVerified: boolean;
  exactTargetVerified?: boolean;
  dispatchMode?: 'windows-input' | 'uia-semantic' | 'windows-message';
  inputLeaseId: string;
  controlEpoch: number;
  cursor?: {
    x: number;
    y: number;
    style?: string;
    nativeOverlay?: boolean;
    systemCursorRestored?: boolean;
    userTakeoverDetected?: boolean;
    dispatchMode?: 'windows-input' | 'uia-semantic' | 'windows-message';
    exactTargetVerifiedAtDispatch?: boolean;
    animation?: {
      engine: string;
      targetFrameRate: number;
      frameCount: number;
      maxFrameGapMs: number;
      p95FrameGapMs: number;
      framesOver33Ms: number;
      framesOver50Ms: number;
      motionDurationMs: number;
      preClickLeadMs: number;
      transitionCount: number;
      directionModel: 'continuous-vector-360';
      directionFrameCount: number;
      lastDirectionDegrees: number;
      maxDirectionStepDegrees: number;
      systemCursorWidthPx: number;
      maxVisibleCursorExtentPx: number;
      sizePolicy: 'entire-sprite-max-1.5x-system-cursor';
      states: string[];
    };
  };
  closed?: boolean;
  closedWindowRef?: string;
  after?: ComputerNativeObservation;
}

export interface ComputerNativeProvider {
  status(): Promise<Record<string, unknown>>;
  listWindows(limit: number, signal?: AbortSignal): Promise<ComputerWindowSummary[]>;
  observe(windowRef: string, screenshotPath: string, signal?: AbortSignal): Promise<ComputerNativeObservation>;
  act(request: ComputerNativeActionRequest, signal?: AbortSignal): Promise<ComputerNativeActionReceipt>;
  startCursorSession?(controlStatePath: string): Promise<Record<string, unknown>>;
  stopCursorSession?(): Promise<void>;
}

export interface ComputerUseNativeBridgeOptions {
  monarchRoot: string;
  runtimeRoot: string;
  sourcePath?: string;
  cursorAssetRoot?: string;
  binaryPath?: string;
  prebuiltBinaryPath?: string;
  timeoutMs?: number;
}

interface NativeEnvelope<T> {
  ok?: boolean;
  error?: string;
  message?: string;
  result?: T;
}

export class ComputerUseNativeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ComputerUseNativeError';
  }
}

export class ComputerUseNativeBridge implements ComputerNativeProvider {
  readonly monarchRoot: string;
  readonly runtimeRoot: string;
  readonly sourcePath: string;
  readonly cursorAnimationSourcePath: string;
  readonly cursorAssetRoot: string;
  readonly cursorAssetPaths: readonly string[];
  readonly binaryPath: string;
  readonly prebuiltBinaryPath: string;
  readonly jobsRoot: string;
  readonly cursorSessionRoot: string;
  readonly cursorVisualLeasePath: string;
  readonly cursorTakeoverSignalPath: string;
  private readonly timeoutMs: number;
  private compilation: Promise<void> | null = null;
  private cursorSession: ChildProcess | null = null;
  private cursorSessionStopping: Promise<void> | null = null;
  private cursorSessionHeartbeat: NodeJS.Timeout | null = null;
  private cursorSessionHeartbeatPath: string | null = null;

  constructor(options: ComputerUseNativeBridgeOptions) {
    this.monarchRoot = path.resolve(options.monarchRoot);
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    const rootedSource = path.join(this.monarchRoot, 'tools', 'computer-use', 'MonarchComputerUse.cs');
    const developmentSource = path.join(process.cwd(), 'tools', 'computer-use', 'MonarchComputerUse.cs');
    this.sourcePath = path.resolve(options.sourcePath || (existsSync(rootedSource) ? rootedSource : developmentSource));
    this.cursorAnimationSourcePath = path.resolve(
      path.join(path.dirname(this.sourcePath), 'OscarCursorAnimation.cs'),
    );
    const rootedCursorAssets = path.join(this.monarchRoot, 'tools', 'computer-use', 'assets');
    const developmentCursorAssets = path.join(process.cwd(), 'tools', 'computer-use', 'assets');
    this.cursorAssetRoot = path.resolve(options.cursorAssetRoot || (
      existsSync(rootedCursorAssets) ? rootedCursorAssets : developmentCursorAssets
    ));
    this.cursorAssetPaths = OSCAR_CURSOR_ASSETS.map(([state]) => (
      path.join(this.cursorAssetRoot, `oscar-cursor-${state}.png`)
    ));
    this.binaryPath = path.resolve(options.binaryPath || path.join(this.runtimeRoot, 'bin', 'monarch-computer-use.exe'));
    const packagedPrebuilt = path.join(this.monarchRoot, 'tools', 'computer-use', 'bin', 'monarch-computer-use.exe');
    const developmentPrebuilt = path.join(this.monarchRoot, 'dist', 'native', 'monarch-computer-use.exe');
    this.prebuiltBinaryPath = path.resolve(options.prebuiltBinaryPath || (
      existsSync(packagedPrebuilt) ? packagedPrebuilt : developmentPrebuilt
    ));
    this.jobsRoot = path.join(this.runtimeRoot, 'jobs');
    this.cursorSessionRoot = path.join(this.runtimeRoot, 'cursor-session');
    this.cursorVisualLeasePath = path.join(this.cursorSessionRoot, 'active-visual-lease.json');
    this.cursorTakeoverSignalPath = path.join(this.cursorSessionRoot, 'user-takeover.requested');
    this.timeoutMs = clamp(options.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS, 5_000, 120_000);
  }

  async status(): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32') {
      return { available: false, enforced: true, reason: 'Computer Use requires the interactive Windows desktop.' };
    }
    try {
      await this.ensureBinary();
      return {
        available: true,
        enforced: true,
        provider: 'windows-native-uia-sendinput',
        binary: this.binaryPath,
        policy: 'exact-window-fresh-observation-one-action',
        cursorSession: {
          persistent: true,
          running: this.cursorSession?.exitCode === null,
          pid: this.cursorSession?.exitCode === null ? this.cursorSession.pid || null : null,
          sizePolicy: CURSOR_SIZE_POLICY,
          preClickWarningMs: 500,
          directionModel: 'continuous-vector-360',
        },
      };
    } catch (error) {
      return {
        available: false,
        enforced: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listWindows(limit: number, signal?: AbortSignal): Promise<ComputerWindowSummary[]> {
    return this.invoke<ComputerWindowSummary[]>({ command: 'list-windows', limit: clamp(limit, 1, 100) }, signal);
  }

  async observe(
    windowRef: string,
    screenshotPath: string,
    signal?: AbortSignal,
  ): Promise<ComputerNativeObservation> {
    return this.invoke<ComputerNativeObservation>({
      command: 'observe',
      windowRef,
      screenshotPath: path.resolve(screenshotPath),
    }, signal);
  }

  async act(request: ComputerNativeActionRequest, signal?: AbortSignal): Promise<ComputerNativeActionReceipt> {
    await mkdir(this.cursorSessionRoot, { recursive: true });
    await rm(this.cursorTakeoverSignalPath, { force: true }).catch(() => undefined);
    return this.invoke<ComputerNativeActionReceipt>({
      command: 'act',
      ...request,
      cursorVisualLeasePath: this.cursorVisualLeasePath,
      cursorTakeoverSignalPath: this.cursorTakeoverSignalPath,
      afterScreenshotPath: path.resolve(request.afterScreenshotPath),
      controlStatePath: path.resolve(request.controlStatePath),
    }, signal);
  }

  async startCursorSession(controlStatePath: string): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32') {
      return { started: false, reason: 'Computer Use cursor sessions require Windows.' };
    }
    if (this.cursorSessionStopping) await this.cursorSessionStopping;
    if (this.cursorSession && this.cursorSession.exitCode === null) {
      return {
        started: true,
        persistent: true,
        pid: this.cursorSession.pid || null,
        sizePolicy: CURSOR_SIZE_POLICY,
        preClickWarningMs: 500,
      };
    }
    await this.ensureBinary();
    await mkdir(this.cursorSessionRoot, { recursive: true });
    const requestPath = path.join(this.cursorSessionRoot, 'request.json');
    const resultPath = path.join(this.cursorSessionRoot, 'result.json');
    const readyPath = path.join(this.cursorSessionRoot, 'ready.json');
    const stopPath = path.join(this.cursorSessionRoot, 'stop.requested');
    const ownerHeartbeatPath = path.join(
      this.cursorSessionRoot,
      `owner-${process.pid}-${randomUUID()}.heartbeat`,
    );
    await Promise.all([requestPath, resultPath, readyPath, stopPath, this.cursorVisualLeasePath, this.cursorTakeoverSignalPath].map((entry) => (
      rm(entry, { force: true }).catch(() => undefined)
    )));
    await writeFile(ownerHeartbeatPath, `${new Date().toISOString()}\n`, { encoding: 'utf8', flag: 'wx' });
    await writeFile(requestPath, JSON.stringify({
      command: 'cursor-host',
      controlStatePath: path.resolve(controlStatePath),
      cursorVisualLeasePath: this.cursorVisualLeasePath,
      readyPath,
      stopPath,
      ownerProcessId: process.pid,
      ownerHeartbeatPath,
    }), { encoding: 'utf8', flag: 'wx' });
    const child = spawn(this.binaryPath, [requestPath, resultPath], {
      cwd: this.runtimeRoot,
      env: nativeEnvironment(this.cursorSessionRoot),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.cursorSession = child;
    this.cursorSessionHeartbeatPath = ownerHeartbeatPath;
    this.cursorSessionHeartbeat = setInterval(() => {
      void writeFile(ownerHeartbeatPath, `${new Date().toISOString()}\n`, 'utf8').catch(() => undefined);
    }, 500);
    this.cursorSessionHeartbeat.unref();
    child.once('close', () => {
      if (this.cursorSession === child) {
        this.cursorSession = null;
        this.clearCursorSessionHeartbeat();
      }
    });
    try {
      await waitForCursorSessionReady(child, readyPath, 5_000);
    } catch (error) {
      this.clearCursorSessionHeartbeat();
      throw error;
    }
    return {
      started: true,
      persistent: true,
      pid: child.pid || null,
      sizePolicy: CURSOR_SIZE_POLICY,
      preClickWarningMs: 500,
    };
  }

  async stopCursorSession(): Promise<void> {
    if (this.cursorSessionStopping) return this.cursorSessionStopping;
    const operation = this.stopCursorSessionProcess();
    const tracked = operation.finally(() => {
      if (this.cursorSessionStopping === tracked) this.cursorSessionStopping = null;
    });
    this.cursorSessionStopping = tracked;
    return tracked;
  }

  private async stopCursorSessionProcess(): Promise<void> {
    const child = this.cursorSession;
    if (!child || child.exitCode !== null) {
      this.cursorSession = null;
      this.clearCursorSessionHeartbeat();
      return;
    }
    const stopPath = path.join(this.cursorSessionRoot, 'stop.requested');
    await writeFile(stopPath, `${new Date().toISOString()}\n`, 'utf8').catch(() => undefined);
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 450)),
    ]);
    if (child.exitCode === null && !child.killed) child.kill();
    if (this.cursorSession === child) this.cursorSession = null;
    this.clearCursorSessionHeartbeat();
  }

  private clearCursorSessionHeartbeat(): void {
    if (this.cursorSessionHeartbeat) clearInterval(this.cursorSessionHeartbeat);
    this.cursorSessionHeartbeat = null;
    const heartbeatPath = this.cursorSessionHeartbeatPath;
    this.cursorSessionHeartbeatPath = null;
    if (heartbeatPath) void rm(heartbeatPath, { force: true }).catch(() => undefined);
  }

  async renderCursorShowcase(outputPath: string): Promise<Record<string, unknown>> {
    return this.invoke<Record<string, unknown>>({
      command: 'render-cursor-showcase',
      outputPath: path.resolve(outputPath),
    });
  }

  async renderCursorDirectionShowcase(outputPath: string): Promise<Record<string, unknown>> {
    return this.invoke<Record<string, unknown>>({
      command: 'render-cursor-directions',
      outputPath: path.resolve(outputPath),
    });
  }

  private async invoke<T>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (process.platform !== 'win32') {
      throw new ComputerUseNativeError('platform-not-supported', 'Computer Use requires Windows.');
    }
    if (signal?.aborted) throw abortError();
    await this.ensureBinary();
    const jobRoot = path.join(this.jobsRoot, `job-${randomUUID()}`);
    const requestPath = path.join(jobRoot, 'request.json');
    const resultPath = path.join(jobRoot, 'result.json');
    await mkdir(this.jobsRoot, { recursive: true });
    await mkdir(jobRoot, { recursive: false });
    await writeFile(requestPath, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
    try {
      const execution = await runProcess(
        this.binaryPath,
        [requestPath, resultPath],
        this.runtimeRoot,
        this.timeoutMs,
        nativeEnvironment(jobRoot),
        signal,
        payload.command === 'act' ? 320 : 0,
      );
      if (execution.aborted) throw abortError();
      if (!existsSync(resultPath)) {
        throw new ComputerUseNativeError(
          'native-receipt-missing',
          `Computer Use provider returned no receipt (${compactProcessFailure(execution)}).`,
        );
      }
      const resultBytes = await readFile(resultPath);
      if (resultBytes.byteLength > MAX_NATIVE_OUTPUT_BYTES) {
        throw new ComputerUseNativeError('native-receipt-too-large', 'Computer Use provider returned an oversized receipt.');
      }
      let envelope: NativeEnvelope<T>;
      try {
        envelope = JSON.parse(resultBytes.toString('utf8')) as NativeEnvelope<T>;
      } catch {
        throw new ComputerUseNativeError('native-receipt-invalid', 'Computer Use provider returned invalid JSON.');
      }
      if (envelope.ok !== true || envelope.result === undefined) {
        throw new ComputerUseNativeError(
          safeNativeCode(envelope.error),
          String(envelope.message || envelope.error || 'Computer Use provider rejected the request.').slice(0, 1_000),
        );
      }
      return envelope.result;
    } finally {
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ensureBinary(): Promise<void> {
    if (this.compilation) return this.compilation;
    this.compilation = this.compileIfNeeded().finally(() => { this.compilation = null; });
    return this.compilation;
  }

  private async compileIfNeeded(): Promise<void> {
    if (!existsSync(this.sourcePath)) {
      throw new Error(`Computer Use native source is missing: ${this.sourcePath}`);
    }
    const missingCursorAsset = this.cursorAssetPaths.find((assetPath) => !existsSync(assetPath));
    if (missingCursorAsset) {
      throw new Error(`Oscar cursor state asset is missing: ${missingCursorAsset}`);
    }
    if (!existsSync(this.cursorAnimationSourcePath)) {
      throw new Error(`Oscar cursor animation source is missing: ${this.cursorAnimationSourcePath}`);
    }
    const source = await readBuildInput(this.sourcePath);
    const cursorAnimationSource = await readBuildInput(this.cursorAnimationSourcePath);
    const cursorAssets = await Promise.all(this.cursorAssetPaths.map((assetPath) => readBuildInput(assetPath)));
    const sourceHash = createHash('sha256')
      .update(source)
      .update('\0oscar-cursor-animation\0')
      .update(cursorAnimationSource);
    for (let index = 0; index < cursorAssets.length; index += 1) {
      sourceHash
        .update(`\0oscar-cursor-${OSCAR_CURSOR_ASSETS[index]![0]}\0`)
        .update(cursorAssets[index]!);
    }
    const compiledSourceHash = sourceHash.digest('hex');
    const sourceMarkerPath = `${this.binaryPath}.source.sha256`;
    const binaryMarkerPath = `${this.binaryPath}.binary.sha256`;
    const sourceMarker = await readFile(sourceMarkerPath, 'utf8').catch(() => '');
    const binaryMarker = await readFile(binaryMarkerPath, 'utf8').catch(() => '');
    if (
      existsSync(this.binaryPath)
      && sourceMarker.trim() === compiledSourceHash
      && binaryMarker.trim() === await fileSha256(this.binaryPath)
    ) return;

    const prebuiltSourceMarker = await readFile(`${this.prebuiltBinaryPath}.source.sha256`, 'utf8').catch(() => '');
    const prebuiltBinaryMarker = await readFile(`${this.prebuiltBinaryPath}.binary.sha256`, 'utf8').catch(() => '');
    if (
      existsSync(this.prebuiltBinaryPath)
      && prebuiltSourceMarker.trim() === compiledSourceHash
      && prebuiltBinaryMarker.trim() === await fileSha256(this.prebuiltBinaryPath)
    ) {
      const binaryRoot = path.dirname(this.binaryPath);
      await mkdir(binaryRoot, { recursive: true });
      const temporaryBinary = path.join(binaryRoot, `.monarch-computer-use-${randomUUID()}.exe`);
      try {
        await copyFile(this.prebuiltBinaryPath, temporaryBinary);
        await rm(this.binaryPath, { force: true }).catch(() => undefined);
        await rename(temporaryBinary, this.binaryPath);
        await writeFile(sourceMarkerPath, `${compiledSourceHash}\n`, 'utf8');
        await writeFile(binaryMarkerPath, `${prebuiltBinaryMarker.trim()}\n`, 'utf8');
      } finally {
        await rm(temporaryBinary, { force: true }).catch(() => undefined);
      }
      return;
    }

    const compiler = findFrameworkCompiler();
    if (!compiler) throw new Error('Windows .NET Framework C# compiler is unavailable.');
    const automationClient = findFrameworkReference('UIAutomationClient');
    const automationTypes = findFrameworkReference('UIAutomationTypes');
    const windowsBase = findFrameworkReference('WindowsBase');
    if (!automationClient || !automationTypes || !windowsBase) {
      throw new Error('Windows UI Automation reference assemblies are unavailable.');
    }
    const binaryRoot = path.dirname(this.binaryPath);
    const buildRoot = path.join(this.runtimeRoot, 'build');
    await mkdir(binaryRoot, { recursive: true });
    await mkdir(buildRoot, { recursive: true });
    const temporaryBinary = path.join(binaryRoot, `.monarch-computer-use-${randomUUID()}.exe`);
    const compilationRoot = path.join(buildRoot, `compile-${randomUUID()}`);
    const compiledSourcePath = path.join(compilationRoot, 'MonarchComputerUse.cs');
    const compiledAnimationPath = path.join(compilationRoot, 'OscarCursorAnimation.cs');
    const compiledCursorAssetPaths = OSCAR_CURSOR_ASSETS.map(([state]) => (
      path.join(compilationRoot, `oscar-cursor-${state}.png`)
    ));
    await mkdir(compilationRoot, { recursive: true });
    try {
      await Promise.all([
        writeFile(compiledSourcePath, source),
        writeFile(compiledAnimationPath, cursorAnimationSource),
        ...compiledCursorAssetPaths.map((assetPath, index) => writeFile(assetPath, cursorAssets[index]!)),
      ]);
      const cursorResourceArguments = compiledCursorAssetPaths.map((assetPath, index) => (
        `/resource:${assetPath},MonarchComputerUse.OscarCursor.${OSCAR_CURSOR_ASSETS[index]![1]}.png`
      ));
      const result = await runProcess(compiler, [
        '/nologo',
        '/optimize+',
        '/target:exe',
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Web.Extensions.dll',
        '/reference:System.Windows.Forms.dll',
        `/reference:${windowsBase}`,
        `/reference:${automationClient}`,
        `/reference:${automationTypes}`,
        ...cursorResourceArguments,
        `/out:${temporaryBinary}`,
        compiledSourcePath,
        compiledAnimationPath,
      ], this.monarchRoot, 90_000, nativeEnvironment(compilationRoot));
      if (result.exitCode !== 0 || !existsSync(temporaryBinary)) {
        await rm(temporaryBinary, { force: true }).catch(() => undefined);
        throw new Error(`Computer Use provider compilation failed: ${compactProcessFailure(result)}`);
      }
    } finally {
      await rm(compilationRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(this.binaryPath, { force: true }).catch(() => undefined);
    await rename(temporaryBinary, this.binaryPath);
    await writeFile(sourceMarkerPath, `${compiledSourceHash}\n`, 'utf8');
    await writeFile(binaryMarkerPath, `${await fileSha256(this.binaryPath)}\n`, 'utf8');
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const bytes = await readBuildInput(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBuildInput(filePath: string): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await readFile(filePath);
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(40 * (2 ** attempt), 640)));
    }
  }
  throw lastError;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  abortGraceMs = 0,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let abortTermination: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString('utf8')}`.slice(-64 * 1024);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const terminate = () => {
      if (!child.killed) child.kill();
    };
    const onAbort = () => {
      if (abortGraceMs <= 0) terminate();
      else abortTermination = setTimeout(terminate, abortGraceMs);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortTermination) clearTimeout(abortTermination);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (abortTermination) clearTimeout(abortTermination);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout,
        stderr: timedOut ? `${stderr}\nprovider-timeout` : stderr,
        aborted: signal?.aborted === true,
      });
    });
  });
}

async function waitForCursorSessionReady(
  child: ChildProcess,
  readyPath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(readyPath)) return;
    if (child.exitCode !== null) {
      throw new ComputerUseNativeError(
        'cursor-session-exited',
        `Persistent Oscar cursor host exited before readiness (${child.exitCode}).`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  if (child.exitCode === null && !child.killed) child.kill();
  throw new ComputerUseNativeError('cursor-session-timeout', 'Persistent Oscar cursor host did not become ready.');
}

function nativeEnvironment(tempRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'ComSpec',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'Path',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'PROCESSOR_IDENTIFIER',
    'SystemDrive',
    'SystemRoot',
    'USERDOMAIN',
    'USERNAME',
    'WINDIR',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.TEMP = tempRoot;
  env.TMP = tempRoot;
  return env;
}

function findFrameworkCompiler(): string | null {
  const windowsRoot = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function findFrameworkReference(name: 'UIAutomationClient' | 'UIAutomationTypes' | 'WindowsBase'): string | null {
  const windowsRoot = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(programFilesX86, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', 'v4.8', `${name}.dll`),
    path.join(programFilesX86, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', 'v4.7.2', `${name}.dll`),
    path.join(windowsRoot, 'Microsoft.NET', 'assembly', 'GAC_MSIL', name, 'v4.0_4.0.0.0__31bf3856ad364e35', `${name}.dll`),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function compactProcessFailure(result: Pick<ProcessResult, 'exitCode' | 'stdout' | 'stderr'>): string {
  return String(result.stderr || result.stdout || `exit ${result.exitCode}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000);
}

function safeNativeCode(value: unknown): string {
  const code = String(value || 'computer-native-rejected').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(code) ? code : 'computer-native-rejected';
}

function abortError(): Error {
  const error = new Error('Computer Use action was cancelled.');
  error.name = 'AbortError';
  return error;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

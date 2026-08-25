import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type {
  MonarchExecutionControl,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
} from '../../core';
import { evaluateFilesystemAccess, isPathWithinRoot } from '../../core';
import { sanitizedProcessEnvironment } from '../coder/sandbox-runner';
import { systemShellManifest } from './manifest';

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export class SystemShellModule implements MonarchModule {
  readonly manifest = systemShellManifest;
  private readonly sourceRoot: string;
  private readonly tempRoot: string;

  constructor(sourceRoot = process.cwd(), tempRoot?: string) {
    this.sourceRoot = path.resolve(sourceRoot);
    this.tempRoot = path.resolve(tempRoot || path.join(this.sourceRoot, 'runtime', 'system-shell', 'tmp'));
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await mkdir(this.tempRoot, { recursive: true });
    await context.emit('system-shell.activated', this.manifest.id, {
      shellInterpolation: false,
      safeIsolation: 'immutable-path-deny',
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return { ok: true, summary: 'Exact argv System Shell provider is ready.', output: { shellInterpolation: false } };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    control: MonarchExecutionControl = {},
  ): Promise<MonarchExecutionResult> {
    if (request.capabilityId !== 'system.shell.run') {
      return { ok: false, summary: `Unsupported System Shell capability: ${request.capabilityId}`, error: 'unsupported-capability' };
    }
    if (control.signal?.aborted) {
      return { ok: false, summary: 'System Shell action was cancelled before dispatch.', error: 'cancelled' };
    }
    const parsed = await parseShellInput(request.input);
    if (!parsed.ok) return parsed.result;
    if (control.signal?.aborted) {
      return { ok: false, summary: 'System Shell action was cancelled before dispatch.', error: 'cancelled' };
    }
    const { executable, args, cwd, timeoutMs, networkPosture, maxOutputBytes } = parsed.value;
    const safeBoundary = immutableSafeBoundary([executable, cwd, ...args]);
    if (safeBoundary) {
      return {
        ok: false,
        summary: 'System Shell cannot address Monarch Safe under any Security mode or Owner override.',
        error: 'monarch-safe-isolated',
        metadata: { boundary: safeBoundary },
      };
    }
    if (samePath(cwd, path.parse(cwd).root)) {
      return { ok: false, summary: 'System Shell cwd cannot be a filesystem root.', error: 'root-cwd-blocked' };
    }
    const scopeBoundary = shellActionScopeBoundary(cwd, args, request.actionScope?.roots || []);
    if (scopeBoundary) return scopeBoundary;
    const redZoneBlock = shellRedZoneBoundary(cwd, args, this.sourceRoot, request.ownerUnrestrictedExecution === true);
    if (redZoneBlock) return redZoneBlock;
    if (networkPosture === 'offline' && containsNetworkPrimitive(executable, args)) {
      return {
        ok: false,
        summary: 'The exact argv declares offline posture but contains a network primitive.',
        error: 'network-posture-conflict',
      };
    }

    const startedAt = Date.now();
    const execution = await runExactProcess({
      executable,
      args,
      cwd,
      timeoutMs,
      maxOutputBytes,
      env: sanitizedProcessEnvironment(this.sourceRoot, this.tempRoot),
      ...(control.signal ? { signal: control.signal } : {}),
    });
    const output = {
      executable,
      cwd,
      argvSha256: sha256(JSON.stringify([executable, ...args])),
      exitCode: execution.exitCode,
      stdout: execution.stdout,
      stderr: execution.stderr,
      stdoutSha256: sha256(execution.stdout),
      stderrSha256: sha256(execution.stderr),
      timedOut: execution.timedOut,
      cancelled: execution.cancelled,
      truncated: execution.truncated,
      durationMs: Math.max(0, Date.now() - startedAt),
      networkPosture,
      // No false claim: this provider screens the declared posture but the
      // current Windows host does not provide per-process network isolation.
      networkIsolationEnforced: false,
      receiptVerified: execution.spawned && !execution.timedOut && !execution.cancelled,
    };
    await context.emit('system-shell.completed', this.manifest.id, {
      requestId: request.id,
      executable,
      cwd,
      argvSha256: output.argvSha256,
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      cancelled: execution.cancelled,
      truncated: execution.truncated,
    });
    if (execution.cancelled) return { ok: false, summary: 'System Shell action was cancelled.', error: 'cancelled', output };
    if (execution.timedOut) return { ok: false, summary: `System Shell timed out after ${timeoutMs} ms.`, error: 'timeout', output };
    if (execution.spawnError) return { ok: false, summary: `System Shell could not start the exact executable: ${execution.spawnError}`, error: 'spawn-failed', output };
    return {
      ok: execution.exitCode === 0,
      summary: execution.exitCode === 0
        ? `Exact process completed with exit code 0.`
        : `Exact process exited with code ${execution.exitCode ?? 'unknown'}.`,
      ...(execution.exitCode === 0 ? {} : { error: 'non-zero-exit' }),
      output,
    };
  }
}

function shellActionScopeBoundary(
  cwd: string,
  args: readonly string[],
  roots: readonly string[],
): MonarchExecutionResult | null {
  if (roots.length === 0) return null;
  const normalizedRoots = roots.map((root) => path.resolve(root));
  const candidates = [cwd, ...args.flatMap((entry) => absolutePathCandidates(entry, cwd))];
  const escaped = candidates.find((candidate) => !normalizedRoots.some((root) => (
    isPathWithinRoot(path.resolve(candidate), root, { allowRoot: true })
  )));
  if (!escaped) return null;
  return {
    ok: false,
    summary: 'System Shell exact argv escaped the runtime-owned task scope.',
    error: 'shell-task-scope-blocked',
    metadata: { boundary: { path: path.resolve(escaped), roots: normalizedRoots } },
  };
}

interface ParsedShellInput {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  networkPosture: 'offline' | 'inherit' | 'allowed';
  maxOutputBytes: number;
}

async function parseShellInput(input: unknown): Promise<{ ok: true; value: ParsedShellInput } | { ok: false; result: MonarchExecutionResult }> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('Shell input must be an object.');
  const record = input as Record<string, unknown>;
  const executable = typeof record.executable === 'string' ? record.executable.trim() : '';
  const rawCwd = typeof record.cwd === 'string' ? record.cwd.trim() : '';
  const cwd = rawCwd && path.isAbsolute(rawCwd) ? path.resolve(rawCwd) : '';
  const args = Array.isArray(record.args) && record.args.every((entry) => typeof entry === 'string')
    ? record.args as string[] : null;
  const timeoutMs = Number(record.timeoutMs);
  const networkPosture = record.networkPosture;
  const maxOutputBytes = record.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : Number(record.maxOutputBytes);
  if (!executable || executable.includes('\0') || executable.length > 1024) return invalid('Executable is invalid.');
  if (!cwd) return invalid('cwd must be one exact absolute path.');
  if (!args || args.length > 128 || args.some((entry) => entry.includes('\0') || entry.length > 8192)) return invalid('args must be a bounded string array.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) return invalid('timeoutMs is outside 100..600000.');
  if (networkPosture !== 'offline' && networkPosture !== 'inherit' && networkPosture !== 'allowed') return invalid('networkPosture is invalid.');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 1024 * 1024) return invalid('maxOutputBytes is invalid.');
  const cwdStat = await stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) return invalid('cwd must exist and be a directory.');
  return { ok: true, value: { executable, args: [...args], cwd, timeoutMs, networkPosture, maxOutputBytes } };
}

function runExactProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<{
  spawned: boolean; exitCode: number | null; stdout: string; stderr: string;
  timedOut: boolean; cancelled: boolean; truncated: boolean; spawnError?: string;
}> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(input.executable, input.args, {
        cwd: input.cwd,
        env: input.env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ spawned: false, exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: false, truncated: false, spawnError: safeError(error) });
      return;
    }
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const append = (current: Buffer<ArrayBufferLike>, value: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = input.maxOutputBytes - current.length;
      if (value.length > remaining) truncated = true;
      return remaining <= 0 ? current : Buffer.concat([current, value.subarray(0, remaining)]);
    };
    child.stdout?.on('data', (value: Buffer) => { stdout = append(stdout, value); });
    child.stderr?.on('data', (value: Buffer) => { stderr = append(stderr, value); });
    const stop = () => { if (!child.killed) child.kill('SIGTERM'); };
    const onAbort = () => { cancelled = true; stop(); };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ spawned: false, exitCode: null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, cancelled, truncated, spawnError: safeError(error) });
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      resolve({ spawned: true, exitCode, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut, cancelled, truncated });
    });
  });
}

export function immutableSafeBoundary(values: readonly string[]): string | null {
  for (const value of values) {
    const normalized = String(value || '').replace(/%[^%]+%/gu, (token) => process.env[token.slice(1, -1)] || token)
      .replaceAll('/', '\\').toLocaleLowerCase('en-US');
    if (/(?:^|[\s"'=;(])(?:[a-z]:\\)?monarchdata\\safe(?:\\|$|[\s"');])/iu.test(normalized)
      || /\bsafe-v1\b/iu.test(normalized)
      || /monarch[_ -]?safe(?:[_ -]?(?:path|root))?/iu.test(normalized)
      || /(?:frombase64string|encodedcommand|certutil\b[^\r\n]*\bdecode)/iu.test(normalized)) return value;
  }
  return null;
}

function shellRedZoneBoundary(
  cwd: string,
  args: readonly string[],
  workspaceRoot: string,
  ownerUnrestricted: boolean,
): MonarchExecutionResult | null {
  const candidates = [cwd, ...args.flatMap((entry) => absolutePathCandidates(entry, cwd))];
  for (const candidate of candidates) {
    const evaluation = evaluateFilesystemAccess(candidate, 'read', {
      workspaceRoot,
      sandboxRoot: workspaceRoot,
      fallbackRoot: cwd,
      allowFullDiskAccess: true,
      ...(ownerUnrestricted ? {
        includeDefaultRedZones: false,
        protectWorkspaceInternals: false,
      } : {}),
    });
    if (!evaluation.allowed) {
      return {
        ok: false,
        summary: evaluation.reason.startsWith('red-zone-')
          ? 'System Shell exact argv addresses a protected red zone.'
          : evaluation.message,
        error: evaluation.reason.startsWith('red-zone-') ? 'shell-red-zone-blocked' : 'filesystem-policy-blocked',
        metadata: {
          boundary: {
            reason: evaluation.reason,
            path: evaluation.resolvedPath,
            ownerUnrestricted,
          },
        },
      };
    }
  }
  return null;
}

function absolutePathCandidates(value: string, cwd: string): string[] {
  const candidates = new Set<string>();
  const trimmed = value.trim().replace(/^["']|["']$/gu, '');
  if (path.isAbsolute(trimmed)) candidates.add(trimmed);
  if (/^\.\.?[\\/]/u.test(trimmed)) candidates.add(path.resolve(cwd, trimmed));
  for (const match of value.matchAll(/["']([a-z]:[\\/][^"'\r\n]+)["']/giu)) candidates.add(match[1]!);
  for (const match of value.matchAll(/(?:^|\s)([a-z]:[\\/][^\s;|&<>]+)/giu)) candidates.add(match[1]!.replace(/[),]+$/u, ''));
  for (const match of value.matchAll(/(%[a-z0-9_()]+%[\\/][^\s;|&<>]+)/giu)) candidates.add(match[1]!.replace(/[),]+$/u, ''));
  return [...candidates];
}

function containsNetworkPrimitive(executable: string, args: readonly string[]): boolean {
  return /(?:^|[\\/])(?:curl|wget|ssh|scp|sftp|ftp|telnet|bitsadmin)(?:\.exe)?$/iu.test(executable)
    || /\b(?:invoke-webrequest|invoke-restmethod|start-bitstransfer|downloadstring|http:\/\/|https:\/\/|ftp:\/\/|ssh\s)/iu.test(args.join(' '));
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US')
    === path.resolve(right).replace(/[\\/]+$/u, '').toLocaleLowerCase('en-US');
}

function invalid(summary: string): { ok: false; result: MonarchExecutionResult } {
  return { ok: false, result: { ok: false, summary, error: 'invalid-shell-input' } };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 800);
}

export function createSystemShellModule(options: { workspaceRoot?: string; tempRoot?: string } = {}): MonarchModule {
  return new SystemShellModule(options.workspaceRoot, options.tempRoot);
}

export const systemShellModulePackage: MonarchModulePackage = {
  id: systemShellManifest.id,
  moduleId: systemShellManifest.id,
  version: systemShellManifest.version,
  description: systemShellManifest.description,
  core: { minVersion: '0.1.0' },
  factory: (context) => createSystemShellModule({
    ...(context?.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
    ...(context?.runtimePaths?.stateRoot
      ? { tempRoot: path.join(context.runtimePaths.stateRoot, 'system-shell', 'tmp') }
      : {}),
  }),
};

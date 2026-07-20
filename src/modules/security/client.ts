import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_AUDIT_TAIL_LINES = 1000;
const MAX_INCIDENT_LIST_ITEMS = 1000;
const MAX_SCAN_FILE_LIMIT = 10000;
const MAX_STOP_WAIT_SECONDS = 300;

export interface SecurityClientOptions {
  projectRoot?: string;
  configPath?: string;
  pythonPath?: string;
  timeoutMs?: number;
}

export interface SecurityRuntimeConfig {
  projectRoot: string;
  configPath: string;
  pythonPath: string;
  timeoutMs: number;
}

export interface SecurityCommandResult {
  ok: boolean;
  exitCode: number;
  args: string[];
  stdout: string;
  stderr: string;
  jsonLines: unknown[];
}

export interface SecurityCommandRunOptions {
  timeoutMs?: number;
}

export type SecurityBenchmarkJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface SecurityBenchmarkJobSnapshot {
  jobId: string;
  status: SecurityBenchmarkJobStatus;
  durationSeconds: number;
  intervalSeconds: number;
  startedAt: string;
  updatedAt: string;
  elapsedSeconds: number;
  progressPercent: number;
  result: unknown | null;
  error: string | null;
}

export class SecurityClient {
  readonly config: SecurityRuntimeConfig;
  private benchmarkJob: SecurityBenchmarkJobSnapshot | null = null;
  private benchmarkChild: ChildProcessWithoutNullStreams | null = null;

  constructor(options: SecurityClientOptions = {}) {
    const projectRoot = path.resolve(
      options.projectRoot || process.env.MONARCH_SECURITY_ROOT || path.join(process.cwd(), 'security')
    );

    this.config = {
      projectRoot,
      configPath: path.resolve(
        options.configPath
          || process.env.MONARCH_SECURITY_CONFIG
          || path.join(projectRoot, 'config', 'monarch_security.toml')
      ),
      pythonPath: resolvePythonPath(projectRoot, options.pythonPath || process.env.MONARCH_SECURITY_PYTHON),
      timeoutMs: options.timeoutMs || readTimeout(),
    };
  }

  get available(): boolean {
    return executableLooksAvailable(this.config.pythonPath)
      && existsSync(path.join(this.config.projectRoot, 'src', 'monarch_security', 'cli.py'));
  }

  async status(): Promise<SecurityCommandResult> {
    return this.run(['status'], { timeoutMs: 8000 });
  }

  async profile(): Promise<SecurityCommandResult> {
    return this.run(['profile'], { timeoutMs: 8000 });
  }

  async setProfile(level: 'off' | 'minimal' | 'balanced' | 'strict' | 'maximum'): Promise<SecurityCommandResult> {
    return this.run(['profile-set', '--level', level, '--confirm'], { timeoutMs: 12000 });
  }

  async modelPolicy(): Promise<SecurityCommandResult> {
    return this.run(['model-policy'], { timeoutMs: 8000 });
  }

  async setModelPolicy(input: { enabled: boolean; confirmationMode: 'adaptive' | 'always' }): Promise<SecurityCommandResult> {
    return this.run([
      'model-policy-set',
      '--enabled', input.enabled ? 'true' : 'false',
      '--confirmation', input.confirmationMode,
      '--confirm',
    ], { timeoutMs: 30000 });
  }

  async incidents(limit: number): Promise<SecurityCommandResult> {
    return this.run(
      ['incidents', '--limit', String(boundedInteger(limit, 50, 1, MAX_INCIDENT_LIST_ITEMS))],
      { timeoutMs: 8000 }
    );
  }

  async updateIncident(input: {
    incidentId: string;
    status: 'acknowledged' | 'resolved' | 'dismissed';
    reason: string;
  }): Promise<SecurityCommandResult> {
    return this.run([
      'incident-update',
      '--incident-id', input.incidentId,
      '--status', input.status,
      '--reason', input.reason.slice(0, 500),
      '--confirm',
    ], { timeoutMs: 12000 });
  }

  async listQuarantine(): Promise<SecurityCommandResult> {
    return this.run(['quarantine-list'], { timeoutMs: 8000 });
  }

  async isolateFile(input: { targetPath: string; incidentId?: string }): Promise<SecurityCommandResult> {
    return this.run([
      'quarantine-isolate',
      input.targetPath,
      ...(input.incidentId ? ['--incident-id', input.incidentId] : []),
      '--confirm-isolate',
    ], { timeoutMs: 30000 });
  }

  async restoreQuarantine(input: { quarantineId: string; destination?: string }): Promise<SecurityCommandResult> {
    return this.run([
      'quarantine-restore',
      input.quarantineId,
      ...(input.destination ? ['--destination', input.destination] : []),
      '--confirm-restore',
    ], { timeoutMs: 30000 });
  }

  async listResponses(limit: number): Promise<SecurityCommandResult> {
    return this.run(
      ['responses', '--limit', String(boundedInteger(limit, 50, 1, MAX_INCIDENT_LIST_ITEMS))],
      { timeoutMs: 8000 }
    );
  }

  async proposeResponse(input: {
    incidentId: string;
    action: string;
    scope: Record<string, unknown>;
    rationale: string[];
    proposedBy: 'rules' | 'llm' | 'user';
    ttlSeconds: number;
  }): Promise<SecurityCommandResult> {
    return this.run([
      'propose-response',
      '--incident-id', input.incidentId,
      '--action', input.action,
      '--scope-json', JSON.stringify(input.scope),
      '--proposed-by', input.proposedBy,
      '--ttl', String(boundedInteger(input.ttlSeconds, 300, 30, 3600)),
      ...input.rationale.slice(0, 8).flatMap((item) => ['--rationale', String(item).slice(0, 240)]),
    ], { timeoutMs: 12000 });
  }

  async evaluateResponse(proposalId: string): Promise<SecurityCommandResult> {
    return this.run(['evaluate-response', proposalId], { timeoutMs: 8000 });
  }

  async approveResponse(proposalId: string, pin: string): Promise<SecurityCommandResult> {
    const requestDirectory = path.join(this.config.projectRoot, 'data', 'pin-requests');
    await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    const requestPath = path.join(requestDirectory, `${process.pid}-${randomUUID()}.json`);
    await writeFile(requestPath, `${JSON.stringify({ pin })}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    try {
      const result = await this.run([
        'approve-response', proposalId, '--request-file', requestPath, '--confirm-approval',
      ], { timeoutMs: 15000 });
      result.args = ['approve-response', proposalId, '--request-file', '<ephemeral-local-request>', '--confirm-approval'];
      return result;
    } finally {
      await unlink(requestPath).catch(() => undefined);
    }
  }

  async listResponseActions(): Promise<SecurityCommandResult> {
    return this.run(['response-actions'], { timeoutMs: 8000 });
  }

  async responseServiceStatus(): Promise<SecurityCommandResult> {
    return this.run(['response-service-status'], { timeoutMs: 8000 });
  }

  async emergencyStatus(): Promise<SecurityCommandResult> {
    return this.run(['emergency-status'], { timeoutMs: 8000 });
  }

  async resolveEmergency(input: { decision: 'release' | 'continue'; pin: string }): Promise<SecurityCommandResult> {
    const requestDirectory = path.join(this.config.projectRoot, 'data', 'pin-requests');
    await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    const requestPath = path.join(requestDirectory, `${process.pid}-${randomUUID()}.json`);
    await writeFile(requestPath, `${JSON.stringify({ pin: input.pin })}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    try {
      const result = await this.run([
        'emergency-resolve', '--decision', input.decision,
        '--request-file', requestPath, '--confirm-emergency',
      ], { timeoutMs: 15000 });
      result.args = [
        'emergency-resolve', '--decision', input.decision,
        '--request-file', '<ephemeral-local-request>', '--confirm-emergency',
      ];
      return result;
    } finally {
      await unlink(requestPath).catch(() => undefined);
    }
  }

  async pinStatus(): Promise<SecurityCommandResult> {
    return this.run(['pin-status'], { timeoutMs: 8000 });
  }

  async setPin(input: { newPin: string; confirmation: string; currentPin?: string }): Promise<SecurityCommandResult> {
    return this.runPinRequest('pin-set', {
      new_pin: input.newPin,
      confirmation: input.confirmation,
      current_pin: input.currentPin || '',
    });
  }

  async verifyPin(pin: string): Promise<SecurityCommandResult> {
    return this.runPinRequest('pin-verify', { pin });
  }

  async recoverPin(input: { recoveryCode: string; newPin: string; confirmation: string }): Promise<SecurityCommandResult> {
    return this.runPinRequest('pin-recover', {
      recovery_code: input.recoveryCode,
      new_pin: input.newPin,
      confirmation: input.confirmation,
    });
  }

  async diagnose(): Promise<SecurityCommandResult> {
    return this.run(['diagnose'], { timeoutMs: 12000 });
  }

  async start(noLlm: boolean): Promise<SecurityCommandResult> {
    return this.run(['start', ...(noLlm ? ['--no-llm'] : [])], { timeoutMs: 15000 });
  }

  async stop(waitSeconds: number): Promise<SecurityCommandResult> {
    const boundedWait = boundedNumber(waitSeconds, 10, 0, MAX_STOP_WAIT_SECONDS);
    return this.run(['stop', '--wait', String(boundedWait)], { timeoutMs: Math.max(15000, boundedWait * 1000 + 3000) });
  }

  async verifyIntegrity(): Promise<SecurityCommandResult> {
    return this.run(['verify-integrity'], { timeoutMs: 15000 });
  }

  async tailAudit(lines: number): Promise<SecurityCommandResult> {
    return this.run(['tail-audit', '--lines', String(boundedInteger(lines, 20, 1, MAX_AUDIT_TAIL_LINES))], { timeoutMs: 8000 });
  }

  async scanSystem(input: {
    noLlm: boolean;
    includeFiles: boolean;
    includeInstalls: boolean;
    fileLimit: number;
    summaryOnly: boolean;
  }): Promise<SecurityCommandResult> {
    const fileLimit = boundedInteger(input.fileLimit, 100, 1, MAX_SCAN_FILE_LIMIT);
    const args = [
      'scan-system',
      ...(input.summaryOnly ? ['--summary-only'] : []),
      ...(input.includeFiles ? ['--include-files', '--file-limit', String(fileLimit)] : []),
      ...(input.includeInstalls ? ['--include-installs'] : []),
      ...(input.noLlm ? ['--no-llm'] : []),
    ];
    return this.run(args, { timeoutMs: input.includeFiles ? 90000 : 30000 });
  }

  async generateReport(input: {
    noLlm: boolean;
    includeFiles: boolean;
    includeInstalls: boolean;
    fileLimit: number;
    summaryOnly: boolean;
    outputDir?: string;
  }): Promise<SecurityCommandResult> {
    const fileLimit = boundedInteger(input.fileLimit, 100, 1, MAX_SCAN_FILE_LIMIT);
    const args = [
      'report',
      ...(input.summaryOnly ? ['--summary-only'] : []),
      ...(input.includeFiles ? ['--include-files', '--file-limit', String(fileLimit)] : []),
      ...(input.includeInstalls ? ['--include-installs'] : []),
      ...(input.noLlm ? ['--no-llm'] : []),
      ...(input.outputDir ? ['--output-dir', input.outputDir] : []),
    ];
    return this.run(args, { timeoutMs: input.includeFiles ? 120000 : 45000 });
  }

  async scanSensor(sensor: string, noLlm: boolean): Promise<SecurityCommandResult> {
    return this.run([`scan-${sensor}`, ...(noLlm ? ['--no-llm'] : [])], { timeoutMs: 30000 });
  }

  async networkCenter(limit: number): Promise<SecurityCommandResult> {
    return this.run(
      ['network-center', '--limit', String(boundedInteger(limit, 100, 1, MAX_INCIDENT_LIST_ITEMS))],
      { timeoutMs: 30000 }
    );
  }

  async setNetworkProfileTrust(profileId: string, trusted: boolean): Promise<SecurityCommandResult> {
    return this.run([
      trusted ? 'network-profile-trust' : 'network-profile-untrust',
      '--profile-id', profileId,
      '--confirm',
    ], { timeoutMs: 12000 });
  }

  async scanPath(input: {
    targetPath: string;
    recursive: boolean;
    limit: number;
    noLlm: boolean;
  }): Promise<SecurityCommandResult> {
    const limit = boundedInteger(input.limit, 250, 1, MAX_SCAN_FILE_LIMIT);
    const args = [
      'scan-path',
      input.targetPath,
      '--limit',
      String(limit),
      ...(input.recursive ? ['--recursive'] : []),
      ...(input.noLlm ? ['--no-llm'] : []),
    ];
    return this.run(args, { timeoutMs: 90000 });
  }

  async deepScanFile(input: {
    targetPath: string;
    defender: boolean;
    noLlm: boolean;
  }): Promise<SecurityCommandResult> {
    const args = [
      'deep-scan-file',
      input.targetPath,
      ...(input.defender ? ['--defender'] : []),
      ...(input.noLlm ? ['--no-llm'] : []),
    ];
    return this.run(args, { timeoutMs: input.defender ? 180000 : 90000 });
  }

  async baselinePreview(): Promise<SecurityCommandResult> {
    return this.run(['baseline-preview'], { timeoutMs: 60000 });
  }

  async baseline(scope: string, expectedDigest?: string): Promise<SecurityCommandResult> {
    const flag = baselineScopeFlag(scope);
    return this.run([
      'baseline',
      ...(flag ? [flag] : []),
      ...(expectedDigest ? ['--expected-digest', expectedDigest] : []),
    ], { timeoutMs: 60000 });
  }

  async verifyProtection(withLlm: boolean): Promise<SecurityCommandResult> {
    return this.run(['verify-protection', ...(withLlm ? ['--with-llm'] : [])], { timeoutMs: 120000 });
  }

  async attackSimulation(withLlm: boolean): Promise<SecurityCommandResult> {
    return this.run(['attack-simulation', ...(withLlm ? ['--with-llm'] : [])], { timeoutMs: 120000 });
  }

  async simulateLiveThreat(): Promise<SecurityCommandResult> {
    return this.run(['simulate-live-threat', '--confirm-live-simulation'], { timeoutMs: 60000 });
  }

  startBackgroundBenchmark(durationSeconds: number, intervalSeconds: number): SecurityBenchmarkJobSnapshot {
    const existing = this.backgroundBenchmarkStatus();
    if (existing?.status === 'running') return existing;
    if (!this.available) {
      throw new Error(`Monarch Security runtime is missing at ${this.config.projectRoot}.`);
    }

    const duration = boundedNumber(durationSeconds, 300, 30, 900);
    const interval = boundedNumber(intervalSeconds, 0.5, 0.25, 5);
    const now = new Date().toISOString();
    const jobId = randomUUID();
    const args = [
      'background-benchmark',
      '--duration', String(duration),
      '--interval', String(interval),
      '--output', `background-benchmark-${jobId}.json`,
    ];
    const commandArgs = ['-m', 'monarch_security', '--config', this.config.configPath, ...args];
    this.benchmarkJob = {
      jobId,
      status: 'running',
      durationSeconds: duration,
      intervalSeconds: interval,
      startedAt: now,
      updatedAt: now,
      elapsedSeconds: 0,
      progressPercent: 0,
      result: null,
      error: null,
    };

    const child = spawn(this.config.pythonPath, commandArgs, {
      cwd: this.config.projectRoot,
      env: {
        ...process.env,
        PYTHONPATH: securityPythonPath(this.config.projectRoot),
        PYTHONUTF8: '1',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    this.benchmarkChild = child;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      this.finishBenchmarkJob(jobId, 'failed', null, error.message);
    });
    child.once('close', (code) => {
      if (this.benchmarkChild === child) this.benchmarkChild = null;
      if (this.benchmarkJob?.jobId !== jobId || this.benchmarkJob.status === 'cancelled') return;
      const payload = parseJsonLines(stdout).at(-1) ?? null;
      const payloadOk = payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok === true;
      if (code === 0 && payloadOk) {
        this.finishBenchmarkJob(jobId, 'completed', payload, null);
      } else {
        this.finishBenchmarkJob(jobId, 'failed', payload, stderr.trim() || `Benchmark exited with code ${code ?? -1}.`);
      }
    });
    return this.backgroundBenchmarkStatus() as SecurityBenchmarkJobSnapshot;
  }

  backgroundBenchmarkStatus(): SecurityBenchmarkJobSnapshot | null {
    if (!this.benchmarkJob) return null;
    const elapsed = this.benchmarkJob.status === 'running'
      ? Math.max(0, (Date.now() - Date.parse(this.benchmarkJob.startedAt)) / 1000)
      : this.benchmarkJob.elapsedSeconds;
    const progress = this.benchmarkJob.status === 'completed'
      ? 100
      : this.benchmarkJob.status === 'running'
        ? Math.min(99, Math.max(0, elapsed / this.benchmarkJob.durationSeconds * 100))
        : this.benchmarkJob.progressPercent;
    return {
      ...this.benchmarkJob,
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      progressPercent: Math.round(progress * 10) / 10,
    };
  }

  cancelBackgroundBenchmark(jobId: string): SecurityBenchmarkJobSnapshot | null {
    const job = this.benchmarkJob;
    if (!job || job.jobId !== jobId) return null;
    if (job.status !== 'running') return this.backgroundBenchmarkStatus();
    try {
      this.benchmarkChild?.kill();
    } catch {
      // The close/error handlers still settle the job if the process already exited.
    }
    this.benchmarkChild = null;
    this.finishBenchmarkJob(jobId, 'cancelled', null, 'Cancelled by user.');
    return this.backgroundBenchmarkStatus();
  }

  dispose(): void {
    const running = this.benchmarkJob?.status === 'running' ? this.benchmarkJob.jobId : null;
    if (running) this.cancelBackgroundBenchmark(running);
  }

  async testNotification(): Promise<SecurityCommandResult> {
    return this.run(['test-notification'], { timeoutMs: 12000 });
  }

  async checkAction(input: {
    intentText: string;
    actionModule: string;
    actionCapability: string;
    actionInput: string;
    passkey?: string;
    noLlm?: boolean;
    monarchConfirmed?: boolean;
  }): Promise<SecurityCommandResult> {
    const requestDirectory = path.join(this.config.projectRoot, 'data', 'action-requests');
    await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    const requestPath = path.join(requestDirectory, `${process.pid}-${randomUUID()}.json`);
    await writeFile(requestPath, `${JSON.stringify({
      intent_text: input.intentText,
      action_module: input.actionModule,
      action_capability: input.actionCapability,
      action_input: input.actionInput,
      passkey: input.passkey || '',
      no_llm: input.noLlm === true,
      // Confirmation is owned by Monarch Access / ExecutionEngine. The Python
      // controller must not receive a self-attested confirmation bit.
      monarch_confirmed: false,
    })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      const result = await this.run(['check-action', '--request-file', requestPath], { timeoutMs: 30000 });
      result.args = ['check-action', '--request-file', '<ephemeral-local-request>'];
      return result;
    } finally {
      await unlink(requestPath).catch(() => undefined);
    }
  }

  async blockAction(input: { capabilityId: string }): Promise<SecurityCommandResult> {
    return this.run(['block-action', '--capability', input.capabilityId], { timeoutMs: 15000 });
  }

  async run(args: string[], options: SecurityCommandRunOptions = {}): Promise<SecurityCommandResult> {
    if (!this.available) {
      throw new Error(`Monarch Security runtime is missing at ${this.config.projectRoot}.`);
    }

    const timeoutMs = options.timeoutMs || this.config.timeoutMs;
    const commandArgs = ['-m', 'monarch_security', '--config', this.config.configPath, ...args];

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const child = spawn(this.config.pythonPath, commandArgs, {
        cwd: this.config.projectRoot,
        env: {
          ...process.env,
          PYTHONPATH: securityPythonPath(this.config.projectRoot),
          PYTHONUTF8: '1',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          child.kill();
        } catch {
          // Best effort timeout cleanup.
        }
        resolve({
          ok: false,
          exitCode: -1,
          args,
          stdout,
          stderr: stderr || `Timed out after ${timeoutMs}ms.`,
          jsonLines: parseJsonLines(stdout),
        });
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: code === 0,
          exitCode: code ?? -1,
          args,
          stdout,
          stderr,
          jsonLines: parseJsonLines(stdout),
        });
      });
    });
  }

  private async runPinRequest(command: 'pin-set' | 'pin-verify' | 'pin-recover', payload: Record<string, string>): Promise<SecurityCommandResult> {
    const requestDirectory = path.join(this.config.projectRoot, 'data', 'pin-requests');
    await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    const requestPath = path.join(requestDirectory, `${process.pid}-${randomUUID()}.json`);
    await writeFile(requestPath, `${JSON.stringify(payload)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    try {
      const result = await this.run([command, '--request-file', requestPath], { timeoutMs: 15000 });
      result.args = [command, '--request-file', '<ephemeral-local-request>'];
      return result;
    } finally {
      await unlink(requestPath).catch(() => undefined);
    }
  }

  private finishBenchmarkJob(
    jobId: string,
    status: Exclude<SecurityBenchmarkJobStatus, 'running'>,
    result: unknown | null,
    error: string | null,
  ): void {
    if (!this.benchmarkJob || this.benchmarkJob.jobId !== jobId || this.benchmarkJob.status !== 'running') return;
    const elapsed = Math.max(0, (Date.now() - Date.parse(this.benchmarkJob.startedAt)) / 1000);
    this.benchmarkJob = {
      ...this.benchmarkJob,
      status,
      updatedAt: new Date().toISOString(),
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      progressPercent: status === 'completed'
        ? 100
        : Math.min(99, Math.round(elapsed / this.benchmarkJob.durationSeconds * 1000) / 10),
      result,
      error,
    };
  }
}

export function firstJson(result: SecurityCommandResult): unknown {
  return result.jsonLines[0] ?? null;
}

export function lastJson(result: SecurityCommandResult): unknown {
  return result.jsonLines.at(-1) ?? null;
}

function parseJsonLines(output: string): unknown[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((value): value is unknown => value !== null);
}

function readTimeout(): number {
  const parsed = Number(process.env.MONARCH_SECURITY_TIMEOUT_MS || 30000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  return Math.floor(boundedNumber(value, fallback, minimum, maximum));
}

function boundedNumber(value: number, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (parsed === Number.POSITIVE_INFINITY) {
    return maximum;
  }
  if (parsed === Number.NEGATIVE_INFINITY) {
    return minimum;
  }
  if (!Number.isFinite(parsed)) {
    return fallback < minimum ? minimum : fallback > maximum ? maximum : fallback;
  }
  return parsed < minimum ? minimum : parsed > maximum ? maximum : parsed;
}

function resolvePythonPath(projectRoot: string, configured: string | undefined): string {
  const explicit = String(configured || '').trim();
  if (explicit) {
    return normalizeExecutablePath(explicit);
  }

  const venvPython = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  return existsSync(venvPython) ? venvPython : 'python';
}

function securityPythonPath(projectRoot: string): string {
  const entries = [
    String(process.env.MONARCH_SECURITY_SITE_PACKAGES || '').trim(),
    path.join(projectRoot, 'src'),
  ].filter(Boolean);
  return entries.join(path.delimiter);
}

function normalizeExecutablePath(value: string): string {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value)
    ? path.resolve(value)
    : value;
}

function executableLooksAvailable(executable: string): boolean {
  if (existsSync(executable)) {
    return true;
  }
  if (/[\\/]/.test(executable) || /^[A-Za-z]:/.test(executable)) {
    return false;
  }
  const probe = spawnSync(executable, ['--version'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  return !probe.error;
}

function baselineScopeFlag(scope: string): string {
  switch (scope) {
  case 'devices':
    return '--devices-only';
  case 'installs':
    return '--installs-only';
  case 'files':
    return '--files-only';
  case 'network':
    return '--network-only';
  case 'persistence':
    return '--persistence-only';
  case 'posture':
    return '--posture-only';
  case 'self-protection':
    return '--self-protection-only';
  default:
    return '';
  }
}

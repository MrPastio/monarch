import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAX_BROKER_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export interface CoderSandboxExecutionRequest {
  projectRoot: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  allowNetwork?: boolean;
}

export interface CoderSandboxIsolationReceipt {
  kind: 'windows-appcontainer-bfs' | 'windows-appcontainer-acl';
  verified: boolean;
  appContainer: boolean;
  lowIntegrity: boolean;
  projectReadWrite: boolean;
  hostFilesystemDefaultDeny: boolean;
  networkAllowed: boolean;
}

export interface CoderSandboxExecutionResult {
  exitCode: number | null;
  signal: null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  isolation: CoderSandboxIsolationReceipt;
}

interface BrokerResult extends CoderSandboxExecutionResult {
  error?: string | null;
}

export interface CoderSandboxRunnerOptions {
  monarchRoot: string;
  sourcePath?: string;
  binaryPath?: string;
  runtimeRoot?: string;
}

export class CoderSandboxRunner {
  readonly monarchRoot: string;
  readonly sourcePath: string;
  readonly binaryPath: string;
  readonly jobsRoot: string;
  readonly runtimeRoot: string;
  readonly sourceOwnerRoot: string;
  private compilation: Promise<void> | null = null;

  constructor(options: CoderSandboxRunnerOptions) {
    this.monarchRoot = path.resolve(options.monarchRoot);
    const rootedSource = path.join(this.monarchRoot, 'tools', 'coder-sandbox', 'MonarchCoderSandbox.cs');
    const developmentSource = path.join(process.cwd(), 'tools', 'coder-sandbox', 'MonarchCoderSandbox.cs');
    const sourceOwnerRoot = existsSync(rootedSource) ? this.monarchRoot : process.cwd();
    this.sourceOwnerRoot = path.resolve(sourceOwnerRoot);
    this.runtimeRoot = path.resolve(
      options.runtimeRoot
      || process.env.MONARCH_CODER_SANDBOX_ROOT
      || path.resolve(path.parse(this.sourceOwnerRoot).root, 'MonarchCoderSandbox'),
    );
    this.sourcePath = path.resolve(options.sourcePath || (existsSync(rootedSource) ? rootedSource : developmentSource));
    this.binaryPath = path.resolve(options.binaryPath || path.join(this.runtimeRoot, 'bin', 'monarch-coder-sandbox.exe'));
    this.jobsRoot = path.resolve(this.runtimeRoot, 'jobs');
  }

  async status(): Promise<Record<string, unknown>> {
    if (process.platform !== 'win32') {
      return { available: false, enforced: true, reason: 'Coder command execution requires the Windows AppContainer broker.' };
    }
    const apiPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'processmodel.dll');
    if (!existsSync(apiPath)) {
      return { available: false, enforced: true, reason: 'Windows processmodel.dll sandbox API is unavailable.' };
    }
    try {
      await this.ensureBinary();
      return {
        available: true,
        enforced: true,
        kind: 'windows-appcontainer-bfs-or-acl',
        binary: this.binaryPath,
        policy: 'fail-closed',
      };
    } catch (error) {
      return { available: false, enforced: true, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async execute(request: CoderSandboxExecutionRequest): Promise<CoderSandboxExecutionResult> {
    if (process.platform !== 'win32') throw new Error('Coder command execution is fail-closed outside Windows AppContainer.');
    const projectRoot = path.resolve(request.projectRoot);
    const cwd = path.resolve(request.cwd);
    assertWithin(cwd, projectRoot, 'Command working directory');
    const preferredExecutable = await resolveMonarchToolExecutable(request.executable, this.sourceOwnerRoot);
    const resolvedExecutable = preferredExecutable || await resolveExecutable(request.executable, cwd, process.env);
    await this.ensureBinary();
    const executable = await this.stageExecutableRuntime(resolvedExecutable, projectRoot);

    const jobDirectory = path.join(this.jobsRoot, `job-${randomUUID()}`);
    await mkdir(jobDirectory, { recursive: true });
    const sandboxProjectRoot = path.join(jobDirectory, 'project');
    await symlink(projectRoot, sandboxProjectRoot, 'junction');
    const requestPath = path.join(jobDirectory, 'request.json');
    const resultPath = path.join(jobDirectory, 'result.json');
    const identity = `Monarch.Coder.${createHash('sha256').update(projectRoot.toLowerCase()).digest('hex').slice(0, 24)}`;
    const payload = {
      projectRoot: sandboxProjectRoot,
      hostProjectRoot: projectRoot,
      executable,
      arguments: request.args.map((argument) => remapProjectArgument(argument, projectRoot, sandboxProjectRoot)),
      workingDirectory: path.join(sandboxProjectRoot, path.relative(projectRoot, cwd)),
      timeoutMs: clamp(request.timeoutMs, 1_000, 10 * 60_000),
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      allowNetwork: request.allowNetwork !== false,
      identity,
      jobDirectory,
      readOnlyPaths: executableRuntimeRoots(executable, projectRoot),
    };
    await writeFile(requestPath, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });

    try {
      const env = sanitizedProcessEnvironment(this.runtimeRoot, jobDirectory);
      const broker = await runDirect(this.binaryPath, ['host', requestPath, resultPath], this.runtimeRoot, payload.timeoutMs + 120_000, env);
      if (!existsSync(resultPath)) {
        throw new Error(`Coder sandbox broker returned no receipt (${broker.stderr || `exit ${broker.exitCode}`}).`);
      }
      const parsed = JSON.parse(await readFile(resultPath, 'utf8')) as BrokerResult;
      if (parsed.error) throw new Error(`Coder sandbox rejected execution: ${parsed.error}`);
      if (
        !['windows-appcontainer-bfs', 'windows-appcontainer-acl'].includes(parsed.isolation?.kind)
        || parsed.isolation.verified !== true
        || parsed.isolation.appContainer !== true
        || parsed.isolation.lowIntegrity !== true
        || parsed.isolation.hostFilesystemDefaultDeny !== true
      ) {
        throw new Error('Coder sandbox receipt did not verify AppContainer/BFS isolation.');
      }
      return {
        exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
        signal: null,
        stdout: String(parsed.stdout || ''),
        stderr: String(parsed.stderr || ''),
        timedOut: parsed.timedOut === true,
        truncated: parsed.truncated === true,
        durationMs: Number.isFinite(parsed.durationMs) ? parsed.durationMs : 0,
        isolation: parsed.isolation,
      };
    } finally {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ensureBinary(): Promise<void> {
    if (this.compilation) return this.compilation;
    this.compilation = this.compileIfNeeded().finally(() => { this.compilation = null; });
    return this.compilation;
  }

  private async compileIfNeeded(): Promise<void> {
    if (!existsSync(this.sourcePath)) throw new Error(`Coder sandbox source is missing: ${this.sourcePath}`);
    const source = await readFile(this.sourcePath);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const markerPath = `${this.binaryPath}.source.sha256`;
    const marker = await readFile(markerPath, 'utf8').catch(() => '');
    let markerData: Record<string, unknown> = {};
    try { markerData = JSON.parse(marker) as Record<string, unknown>; } catch { markerData = {}; }
    if (existsSync(this.binaryPath) && markerData.sourceHash === sourceHash && markerData.sharedAcl === 'all-app-packages-read-v1') return;

    const compiler = findFrameworkCompiler();
    if (!compiler) throw new Error('Windows .NET Framework C# compiler is unavailable; sandbox execution remains blocked.');
    const binaryRoot = path.dirname(this.binaryPath);
    const buildTemp = path.join(this.runtimeRoot, 'build-temp');
    await mkdir(binaryRoot, { recursive: true });
    await mkdir(buildTemp, { recursive: true });
    const temporaryBinary = path.join(binaryRoot, `.monarch-coder-sandbox-${randomUUID()}.exe`);
    const result = await runDirect(compiler, [
      '/nologo',
      '/optimize+',
      '/target:exe',
      '/reference:System.Web.Extensions.dll',
      `/out:${temporaryBinary}`,
      this.sourcePath,
    ], this.sourceOwnerRoot, 60_000, sanitizedProcessEnvironment(this.runtimeRoot, buildTemp));
    if (result.exitCode !== 0 || !existsSync(temporaryBinary)) {
      await rm(temporaryBinary, { force: true }).catch(() => undefined);
      throw new Error(`Coder sandbox broker compilation failed: ${(result.stderr || result.stdout).trim().slice(0, 2_000)}`);
    }
    await rm(this.binaryPath, { force: true });
    await rename(temporaryBinary, this.binaryPath);
    const acl = await runDirect(this.binaryPath, ['grant-read', this.runtimeRoot], this.runtimeRoot, 60_000, sanitizedProcessEnvironment(this.runtimeRoot, buildTemp));
    if (acl.exitCode !== 0) throw new Error(`Coder sandbox broker ACL initialization failed: ${acl.stderr || acl.stdout}`);
    await writeFile(markerPath, `${JSON.stringify({ sourceHash, sharedAcl: 'all-app-packages-read-v1' })}\n`, 'utf8');
  }

  private async stageExecutableRuntime(executable: string, projectRoot: string): Promise<string> {
    if (isWithin(executable, projectRoot) || isWithin(executable, this.runtimeRoot)) return executable;
    const systemRoot = path.resolve(process.env.SystemRoot || 'C:\\Windows');
    if (isWithin(executable, systemRoot)) return executable;

    const sourceRoot = await detectToolRuntimeRoot(executable);
    const sourceStat = await stat(executable);
    const signature = createHash('sha256')
      .update(`${sourceRoot.toLowerCase()}|${sourceStat.size}|${sourceStat.mtimeMs}`)
      .digest('hex')
      .slice(0, 20);
    const toolName = path.basename(sourceRoot).replace(/[^a-z0-9._-]+/gi, '-').toLowerCase() || 'tool';
    const targetRoot = path.join(this.runtimeRoot, 'tools', `${toolName}-${signature}`);
    const marker = path.join(targetRoot, '.monarch-tool-runtime');
    const markerData: Record<string, unknown> = await readFile(marker, 'utf8')
      .then((value) => JSON.parse(value) as Record<string, unknown>)
      .catch(() => ({}));
    if (markerData.sharedAcl !== 'all-app-packages-read-v1') {
      const size = await boundedDirectorySize(sourceRoot, 1536 * 1024 * 1024);
      if (size.exceeded) throw new Error(`Tool runtime is too large to stage safely for AppContainer: ${sourceRoot}`);
      const temporary = `${targetRoot}.tmp-${randomUUID()}`;
      await mkdir(path.dirname(targetRoot), { recursive: true });
      await mkdir(temporary, { recursive: false });
      await this.grantSharedReadAccess(temporary);
      for (const entry of await readdir(sourceRoot)) {
        await cp(path.join(sourceRoot, entry), path.join(temporary, entry), { recursive: true, force: false, errorOnExist: true });
      }
      await writeFile(path.join(temporary, '.monarch-tool-runtime'), JSON.stringify({
        sourceRoot,
        signature,
        sizeBytes: size.total,
        sharedAcl: 'all-app-packages-read-v1',
      }), 'utf8');
      await rm(targetRoot, { recursive: true, force: true });
      await rename(temporary, targetRoot);
    }
    const relativeExecutable = path.relative(sourceRoot, executable);
    const stagedGit = /\\Git$/i.test(sourceRoot.replace(/\//g, '\\'))
      ? path.join(targetRoot, 'mingw64', 'bin', 'git.exe')
      : null;
    const staged = stagedGit && existsSync(stagedGit) ? stagedGit : path.join(targetRoot, relativeExecutable);
    await assertExecutableFile(staged);
    return staged;
  }

  private async grantSharedReadAccess(target: string): Promise<void> {
    const result = await runDirect(
      this.binaryPath,
      ['grant-read', target],
      this.runtimeRoot,
      60_000,
      sanitizedProcessEnvironment(this.runtimeRoot, path.join(this.runtimeRoot, 'build-temp')),
    );
    if (result.exitCode !== 0) throw new Error(`AppContainer read-only ACL initialization failed: ${result.stderr || result.stdout}`);
  }
}

export function sanitizedProcessEnvironment(monarchRoot: string, tempRoot = path.join(monarchRoot, 'runtime', 'coder', 'tmp')): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key)) env[key] = value;
  }
  const dataRoot = path.join(path.parse(monarchRoot).root, 'MonarchData');
  env.HF_HOME = process.env.HF_HOME || path.join(dataRoot, 'HuggingFace');
  env.HUGGINGFACE_HUB_CACHE = process.env.HUGGINGFACE_HUB_CACHE || path.join(env.HF_HOME, 'hub');
  env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || path.join(dataRoot, 'Cache');
  env.TEMP = tempRoot;
  env.TMP = tempRoot;
  return env;
}

async function resolveExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const raw = executable.trim().replace(/^['"]|['"]$/g, '');
  if (!raw || raw.includes('\0')) throw new Error('Coder command executable is invalid.');
  const direct = path.isAbsolute(raw) || /[\\/]/.test(raw) ? path.resolve(cwd, raw) : null;
  if (direct) {
    await assertExecutableFile(direct);
    return direct;
  }
  const pathEntries = String(env.Path || env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const hasExtension = Boolean(path.extname(raw));
  for (const directory of pathEntries) {
    for (const extension of hasExtension ? [''] : extensions) {
      const candidate = path.resolve(directory.replace(/^['"]|['"]$/g, ''), `${raw}${extension}`);
      try {
        await assertExecutableFile(candidate);
        return candidate;
      } catch {
        // Continue through the trusted PATH without invoking a shell.
      }
    }
  }
  throw new Error(`Coder command executable was not found on PATH: ${raw}`);
}

async function resolveMonarchToolExecutable(executable: string, monarchRoot: string): Promise<string | null> {
  const raw = executable.trim().replace(/^['"]|['"]$/g, '');
  if (path.isAbsolute(raw) || /[\\/]/.test(raw)) return null;
  const tool = path.basename(raw).toLowerCase();
  if (!['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd'].includes(tool)) return null;
  const version = (await readFile(path.join(monarchRoot, '.node-version'), 'utf8').catch(() => '')).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const runtimeRoot = path.join(monarchRoot, '.tools', `node-v${version}-win-x64`);
  const filename = tool.startsWith('npm') ? 'npm.cmd' : tool.startsWith('npx') ? 'npx.cmd' : 'node.exe';
  const candidate = path.join(runtimeRoot, filename);
  try {
    await assertExecutableFile(candidate);
    return candidate;
  } catch {
    return null;
  }
}

async function assertExecutableFile(candidate: string): Promise<void> {
  await access(candidate);
  const details = await stat(candidate);
  if (!details.isFile()) throw new Error('Command executable must be a file.');
}

function executableRuntimeRoots(executable: string, projectRoot: string): string[] {
  const result = new Set<string>();
  const executableDirectory = path.dirname(executable);
  if (!isWithin(executableDirectory, projectRoot)) result.add(executableDirectory);
  let cursor = executableDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(cursor, '.monarch-tool-runtime'))) {
      result.add(cursor);
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const normalized = executable.replace(/\//g, '\\');
  const gitMatch = /^(.*\\Git)\\(?:cmd|bin|mingw64\\bin)\\[^\\]+$/i.exec(normalized);
  if (gitMatch?.[1]) result.add(path.resolve(gitMatch[1]));
  const scriptsMatch = /^(.*)\\Scripts\\(?:python|pythonw)\.exe$/i.exec(normalized);
  if (scriptsMatch?.[1] && existsSync(path.join(scriptsMatch[1], 'pyvenv.cfg'))) result.add(path.resolve(scriptsMatch[1]));
  return Array.from(result);
}

async function detectToolRuntimeRoot(executable: string): Promise<string> {
  const normalized = executable.replace(/\//g, '\\');
  const gitMatch = /^(.*\\Git)\\(?:cmd|bin|mingw64\\bin)\\[^\\]+$/i.exec(normalized);
  if (gitMatch?.[1]) return path.resolve(gitMatch[1]);
  const scriptsMatch = /^(.*)\\Scripts\\(?:python|pythonw|hf)\.exe$/i.exec(normalized);
  if (scriptsMatch?.[1] && existsSync(path.join(scriptsMatch[1], 'pyvenv.cfg'))) return path.resolve(scriptsMatch[1]);
  const directory = path.dirname(executable);
  const siblingNames = await readdir(directory).catch(() => []);
  if (siblingNames.some((name) => /^(?:node\.exe|npm\.cmd|npx\.cmd)$/i.test(name))) return directory;
  return directory;
}

async function boundedDirectorySize(root: string, limit: number): Promise<{ total: number; exceeded: boolean }> {
  let total = 0;
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile()) {
        total += (await stat(candidate)).size;
        if (total > limit) return { total, exceeded: true };
      }
    }
  }
  return { total, exceeded: false };
}

function findFrameworkCompiler(): string | null {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function runDirect(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    const append = (current: Buffer<ArrayBufferLike>, value: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = MAX_BROKER_OUTPUT_BYTES - current.length;
      return remaining <= 0 ? current : Buffer.concat([current, value.subarray(0, remaining)]);
    };
    child.stdout.on('data', (value: Buffer) => { stdout = append(stdout, value); });
    child.stderr.on('data', (value: Buffer) => { stderr = append(stderr, value); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut });
    });
  });
}

function assertWithin(candidate: string, root: string, label: string): void {
  if (!isWithin(candidate, root)) throw new Error(`${label} must stay inside the selected Coder project.`);
}

function remapProjectArgument(value: string, hostProjectRoot: string, sandboxProjectRoot: string): string {
  const normalizedRoot = hostProjectRoot.replace(/[\\/]+$/, '');
  const lowerValue = value.toLowerCase();
  const lowerRoot = normalizedRoot.toLowerCase();
  if (!lowerValue.startsWith(lowerRoot)) return value;
  const next = value.charAt(normalizedRoot.length);
  if (next && next !== '\\' && next !== '/') return value;
  return `${sandboxProjectRoot}${value.slice(normalizedRoot.length)}`;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

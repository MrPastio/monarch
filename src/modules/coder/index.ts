import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { isPathWithinRoot, permissionModeForRisk } from '../../core';
import { safeFetch } from '../custom-tools';
import { coderManifest } from './manifest';
import { CoderProjectStore } from './project-store';
import { CoderSandboxRunner, sanitizedProcessEnvironment } from './sandbox-runner';
import type { CoderProject } from './types';

const DEFAULT_READ_BYTES = 512 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_NETWORK_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_HF_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_C_DRIVE_HF_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export interface CoderModuleOptions {
  monarchRoot?: string;
  sandboxRunner?: CoderSandboxRunner;
  huggingFaceExecutable?: string;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export class CoderModule implements MonarchModule {
  readonly manifest = coderManifest;
  readonly projects: CoderProjectStore;
  readonly monarchRoot: string;
  readonly sandbox: CoderSandboxRunner;
  private readonly huggingFaceExecutablePath: string;

  constructor(options: CoderModuleOptions = {}) {
    this.monarchRoot = path.resolve(options.monarchRoot || process.cwd());
    this.projects = new CoderProjectStore({ monarchRoot: this.monarchRoot });
    this.sandbox = options.sandboxRunner || new CoderSandboxRunner({ monarchRoot: this.monarchRoot });
    this.huggingFaceExecutablePath = path.resolve(
      options.huggingFaceExecutable || path.join(this.monarchRoot, 'oscar', '.venv', 'Scripts', 'hf.exe'),
    );
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await Promise.all([
      this.projects.initialize(),
      mkdir(path.join(this.sandbox.runtimeRoot, 'integration-tmp'), { recursive: true }),
    ]);
    await context.emit('coder.activated', this.manifest.id, this.projects.list());
  }

  async health(): Promise<MonarchExecutionResult> {
    const registry = this.projects.list();
    const sandbox = await this.sandbox.status();
    return {
      ok: sandbox.available === true,
      summary: sandbox.available === true
        ? `Coder Mode ready with ${registry.projects.length} registered project(s) and enforced AppContainer isolation.`
        : 'Coder Mode loaded, but command execution is fail-closed because AppContainer isolation is unavailable.',
      output: { ...registry, sandbox },
      ...(sandbox.available === true ? {} : { error: 'coder-sandbox-unavailable' }),
    };
  }

  async listActiveSkills(projectId?: string): Promise<Array<{ name: string; description: string; instructions: string }>> {
    const project = this.projects.require(projectId);
    const skillsRoot = path.join(project.root, '.monarch', 'skills');
    if (!existsSync(skillsRoot)) return [];
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    const active: Array<{ name: string; description: string; instructions: string }> = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (active.length >= 3 || !entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.draft-')) continue;
      const skillRoot = path.join(skillsRoot, entry.name);
      try {
        const [metadataText, document] = await Promise.all([
          readFile(path.join(skillRoot, 'skill.json'), 'utf8'),
          readFile(path.join(skillRoot, 'SKILL.md'), 'utf8'),
        ]);
        const metadata = JSON.parse(metadataText) as Record<string, unknown>;
        if (metadata.managedBy !== 'monarch-coder' || metadata.schemaVersion !== 1) continue;
        const description = typeof metadata.description === 'string' ? metadata.description.slice(0, 1_000) : '';
        active.push({ name: entry.name, description, instructions: document.slice(0, 2_000) });
      } catch {
        // Ignore incomplete or user-owned skill folders. Only validated Monarch skills become active.
      }
    }
    return active;
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    const explicit = /^coder\.([a-z.]+)\s*(\{[\s\S]*\})?$/i.exec(text);
    if (!explicit) return null;
    const capabilityId = `coder.${explicit[1]}`;
    const capability = this.manifest.capabilities.find((entry) => entry.id === capabilityId);
    if (!capability) return null;
    let input: unknown = {};
    if (explicit[2]) {
      try { input = JSON.parse(explicit[2]); } catch { input = {}; }
    }
    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId,
      confidence: 1,
      reason: 'Explicit Coder Mode capability.',
      permissionMode: permissionModeForRisk(capability.risk),
      input,
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    try {
      switch (request.capabilityId) {
      case 'coder.projects.list':
        return ok('Coder projects loaded.', this.projects.list());
      case 'coder.projects.create':
        return await this.createProject(request.input, context);
      case 'coder.projects.import':
        return await this.importProject(request.input, context);
      case 'coder.projects.activate':
        return this.activateProject(request.input, context);
      case 'coder.files.list':
        return await this.listFiles(request.input);
      case 'coder.files.read':
        return await this.readTextFile(request.input);
      case 'coder.files.write':
        return await this.writeTextFile(request.input, context);
      case 'coder.files.patch':
        return await this.patchTextFile(request.input, context);
      case 'coder.files.delete':
        return await this.deleteFile(request.input, context);
      case 'coder.command.run':
        return await this.runCommandCapability(request.input, context);
      case 'coder.network.fetch':
        return await this.fetchPublicResource(request.input);
      case 'coder.network.request':
        return await this.requestPublicResource(request.input);
      case 'coder.git.status':
        return await this.gitStatus(request.input);
      case 'coder.git.diff':
        return await this.gitDiff(request.input);
      case 'coder.git.init':
        return await this.gitInit(request.input);
      case 'coder.git.stage':
        return await this.gitStage(request.input);
      case 'coder.git.commit':
        return await this.gitCommit(request.input);
      case 'coder.git.branch.create':
        return await this.gitBranchCreate(request.input);
      case 'coder.git.push':
        return await this.gitPush(request.input);
      case 'coder.github.status':
        return await this.githubStatus();
      case 'coder.github.pr.view':
        return await this.githubPullRequestView(request.input);
      case 'coder.github.pr.create':
        return await this.githubPullRequestCreate(request.input);
      case 'coder.huggingface.status':
        return await this.huggingFaceStatus();
      case 'coder.huggingface.repo.info':
        return await this.huggingFaceRepoInfo(request.input);
      case 'coder.huggingface.download':
        return await this.huggingFaceDownload(request.input);
      case 'coder.huggingface.upload':
        return await this.huggingFaceUpload(request.input);
      case 'coder.skills.create':
        return await this.createSkill(request.input, context);
      case 'coder.integrations.status':
        return await this.integrationsStatus();
      default:
        return fail(`Unsupported Coder capability: ${request.capabilityId}`, 'unsupported-capability');
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 'coder-operation-failed');
    }
  }

  private async createProject(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = await this.projects.create(readString(input, 'name'));
    await context.emit('coder.project.created', this.manifest.id, project);
    return ok(`Project '${project.name}' created.`, project);
  }

  private async importProject(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = await this.projects.import(readString(input, 'path'), readOptionalString(input, 'name'));
    await context.emit('coder.project.imported', this.manifest.id, project);
    return ok(`Project '${project.name}' imported.`, project);
  }

  private async activateProject(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = this.projects.activate(readString(input, 'projectId'));
    await context.emit('coder.project.activated', this.manifest.id, project);
    return ok(`Project '${project.name}' activated.`, project);
  }

  private async listFiles(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const rawPath = readOptionalString(input, 'path') || '.';
    const evaluation = await this.projects.policy.evaluatePath(rawPath, 'list', project.root);
    if (!evaluation.allowed) return blocked(evaluation.message, evaluation);
    const targetStat = await stat(evaluation.resolvedPath);
    if (!targetStat.isDirectory()) throw new Error('Coder list target must be a directory.');
    const recursive = readBoolean(input, 'recursive', true);
    const limit = clamp(readNumber(input, 'limit', 240), 1, 800);
    const entries: Array<{ path: string; type: 'file' | 'directory'; sizeBytes?: number }> = [];
    const queue: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: evaluation.resolvedPath, relative: '', depth: 0 }];
    while (queue.length && entries.length < limit) {
      const current = queue.shift()!;
      const children = await readdir(current.absolute, { withFileTypes: true });
      children.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
      for (const child of children) {
        if (entries.length >= limit) break;
        if (child.isSymbolicLink() || shouldSkipDirectory(child.name)) continue;
        const absolute = path.join(current.absolute, child.name);
        const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
        if (child.isDirectory()) {
          entries.push({ path: relative, type: 'directory' });
          if (recursive && current.depth < 8) queue.push({ absolute, relative, depth: current.depth + 1 });
        } else if (child.isFile()) {
          const fileStat = await stat(absolute);
          entries.push({ path: relative, type: 'file', sizeBytes: fileStat.size });
        }
      }
    }
    return ok(`Listed ${entries.length} project entries.`, { project, root: evaluation.resolvedPath, entries, truncated: entries.length >= limit });
  }

  private async readTextFile(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const evaluation = await this.projects.policy.evaluatePath(readString(input, 'path'), 'read', project.root);
    if (!evaluation.allowed) return blocked(evaluation.message, evaluation);
    const fileStat = await stat(evaluation.resolvedPath);
    if (!fileStat.isFile()) throw new Error('Coder read target must be a file.');
    const maxBytes = clamp(readNumber(input, 'maxBytes', DEFAULT_READ_BYTES), 1, MAX_READ_BYTES);
    if (fileStat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte read limit.`);
    const content = await readFile(evaluation.resolvedPath, 'utf8');
    return ok(`Read ${content.length} characters.`, { path: evaluation.resolvedPath, content, sizeBytes: fileStat.size });
  }

  private async writeTextFile(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const content = readString(input, 'content', true);
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error(`Write exceeds the ${MAX_WRITE_BYTES}-byte limit.`);
    const evaluation = await this.projects.policy.evaluatePath(readString(input, 'path'), 'write', project.root);
    if (!evaluation.allowed) return blocked(evaluation.message, evaluation);
    const overwrite = readBoolean(input, 'overwrite', false);
    if (!overwrite && existsSync(evaluation.resolvedPath)) throw new Error('Target already exists; set overwrite=true to replace it.');
    await atomicWrite(evaluation.resolvedPath, content);
    const persisted = await readFile(evaluation.resolvedPath);
    const expected = Buffer.from(content, 'utf8');
    if (!persisted.equals(expected)) throw new Error('Coder write verification failed after the atomic rename.');
    await context.emit('coder.file.written', this.manifest.id, { projectId: project.id, path: evaluation.resolvedPath });
    return ok(`Wrote and verified ${persisted.length} bytes.`, {
      path: evaluation.resolvedPath,
      sizeBytes: persisted.length,
      sha256: createHash('sha256').update(persisted).digest('hex'),
      verified: true,
    });
  }

  private async patchTextFile(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const evaluation = await this.projects.policy.evaluatePath(readString(input, 'path'), 'write', project.root);
    if (!evaluation.allowed) return blocked(evaluation.message, evaluation);
    const replacements = readReplacements(input);
    let content = await readFile(evaluation.resolvedPath, 'utf8');
    for (const replacement of replacements) {
      const occurrences = content.split(replacement.oldText).length - 1;
      if (occurrences !== 1) throw new Error(`Patch expected exactly one occurrence, found ${occurrences}.`);
      content = content.replace(replacement.oldText, replacement.newText);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('Patched file exceeds the write limit.');
    await atomicWrite(evaluation.resolvedPath, content);
    const persisted = await readFile(evaluation.resolvedPath);
    const expected = Buffer.from(content, 'utf8');
    if (!persisted.equals(expected)) throw new Error('Coder patch verification failed after the atomic rename.');
    await context.emit('coder.file.patched', this.manifest.id, { projectId: project.id, path: evaluation.resolvedPath, replacements: replacements.length });
    return ok(`Applied ${replacements.length} exact replacement(s) and verified the result.`, {
      path: evaluation.resolvedPath,
      replacements: replacements.length,
      sizeBytes: persisted.length,
      sha256: createHash('sha256').update(persisted).digest('hex'),
      verified: true,
    });
  }

  private async deleteFile(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const evaluation = await this.projects.policy.evaluatePath(readString(input, 'path'), 'delete', project.root);
    if (!evaluation.allowed) return blocked(evaluation.message, evaluation);
    const fileStat = await stat(evaluation.resolvedPath);
    if (!fileStat.isFile()) throw new Error('Coder Mode only deletes individual files, never directories.');
    await rm(evaluation.resolvedPath, { force: false, recursive: false });
    if (existsSync(evaluation.resolvedPath)) throw new Error('Coder delete verification failed; the file still exists.');
    await context.emit('coder.file.deleted', this.manifest.id, { projectId: project.id, path: evaluation.resolvedPath });
    return ok('File deleted and verified absent.', { path: evaluation.resolvedPath, verified: true });
  }

  private async runCommandCapability(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const executable = readString(input, 'executable');
    const args = readStringArray(input, 'args');
    const cwd = readOptionalString(input, 'cwd');
    const result = await this.runProjectCommand(project, {
      executable,
      args,
      timeoutMs: readNumber(input, 'timeoutMs', 120_000),
      allowNetwork: readBoolean(input, 'allowNetwork', true),
      ...(cwd ? { cwd } : {}),
    });
    await context.emit('coder.command.completed', this.manifest.id, {
      projectId: project.id,
      executable,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      isolation: 'isolation' in result ? result.isolation : null,
    });
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      summary: result.timedOut ? 'Command timed out.' : `Command exited with code ${result.exitCode}.`,
      output: { executable, args, cwd: cwd || project.root, ...result },
      ...(result.exitCode === 0 && !result.timedOut ? {} : { error: 'command-failed' }),
    };
  }

  private async fetchPublicResource(input: unknown): Promise<MonarchExecutionResult> {
    const method = (readOptionalString(input, 'method') || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') throw new Error('Coder network fetch only allows GET or HEAD requests.');
    const requestedUrl = readPublicNetworkUrl(input);
    const response = await safeFetch(requestedUrl, { method });
    const contentType = response.headers.get('content-type') || '';
    const body = method === 'HEAD' ? '' : await response.text();
    return ok(`Fetched ${response.status} ${response.statusText}.`, {
      url: response.url || requestedUrl,
      status: response.status,
      ok: response.ok,
      contentType,
      body: body.slice(0, 512 * 1024),
      truncated: body.length > 512 * 1024,
    });
  }

  private async requestPublicResource(input: unknown): Promise<MonarchExecutionResult> {
    const method = (readOptionalString(input, 'method') || 'GET').toUpperCase();
    if (!new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).has(method)) {
      throw new Error('Coder network request method must be GET, HEAD, POST, PUT, PATCH, or DELETE.');
    }
    const body = readOptionalString(input, 'body');
    if ((method === 'GET' || method === 'HEAD') && body !== undefined) throw new Error(`${method} requests cannot include a body.`);
    if (body !== undefined && Buffer.byteLength(body, 'utf8') > MAX_NETWORK_REQUEST_BODY_BYTES) {
      throw new Error(`Coder network request body exceeds ${MAX_NETWORK_REQUEST_BODY_BYTES} bytes.`);
    }
    const headers = readSafeNetworkHeaders(input);
    const requestedUrl = readPublicNetworkUrl(input);
    const response = await safeFetch(requestedUrl, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const responseBody = method === 'HEAD' ? '' : await response.text();
    return {
      ok: response.ok,
      summary: `Public API request returned ${response.status} ${response.statusText}.`,
      output: {
        url: response.url || requestedUrl,
        method,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type') || '',
        body: responseBody,
        truncated: false,
      },
      ...(response.ok ? {} : { error: 'network-request-failed' }),
    };
  }

  private async gitStatus(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const result = await this.runGitSandbox(project, ['status', '--short', '--branch'], 30_000);
    return {
      ok: result.exitCode === 0,
      summary: result.exitCode === 0 ? 'Git status loaded.' : 'Git status failed.',
      output: result,
      ...(result.exitCode === 0 ? {} : { error: 'git-status-failed' }),
    };
  }

  private async gitDiff(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const args = ['diff', '--no-ext-diff', '--no-color'];
    if (readBoolean(input, 'staged', false)) args.push('--cached');
    const requestedPath = readOptionalString(input, 'path');
    if (requestedPath) args.push('--', await this.validatedProjectRelativePath(project, requestedPath));
    const result = await this.runGitSandbox(project, args, 30_000);
    return {
      ok: result.exitCode === 0,
      summary: result.exitCode === 0 ? 'Git diff loaded.' : 'Git diff failed.',
      output: result,
      ...(result.exitCode === 0 ? {} : { error: 'git-diff-failed' }),
    };
  }

  private async gitInit(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const initialBranch = readOptionalString(input, 'initialBranch') || 'main';
    await this.assertGitBranch(project, initialBranch);
    const initialized = await this.runGitSandbox(project, ['init', '-b', initialBranch, '.'], 60_000);
    if (initialized.exitCode !== 0) return fail('Git repository initialization failed.', 'git-init-failed');
    await ensureMonarchGitExclude(project.root);
    const verification = await this.runGitSandbox(project, ['rev-parse', '--is-inside-work-tree'], 30_000);
    const verified = verification.exitCode === 0 && verification.stdout.trim() === 'true';
    return {
      ok: verified,
      summary: verified ? `Git repository initialized on '${initialBranch}'.` : 'Git repository initialization could not be verified.',
      output: { branch: initialBranch, verified, initialization: initialized, verification },
      ...(verified ? {} : { error: 'git-init-verification-failed' }),
    };
  }

  private async gitStage(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const requestedPaths = readStringArray(input, 'paths');
    if (requestedPaths.length < 1 || requestedPaths.length > 64) throw new Error('Git stage requires 1 to 64 project paths.');
    const paths: string[] = [];
    for (const requested of requestedPaths) paths.push(await this.validatedProjectRelativePath(project, requested));
    const staged = await this.runGitSandbox(project, ['add', '--', ...paths], 120_000);
    if (staged.exitCode !== 0) return fail('Git staging failed.', 'git-stage-failed');
    const observed = await this.runGitSandbox(project, ['diff', '--cached', '--name-only', '--no-renames'], 30_000);
    const files = observed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).slice(0, 500);
    return ok(`Staged ${files.length} observed path(s).`, {
      requestedPaths: paths,
      stagedFiles: files,
      verified: observed.exitCode === 0,
      isolation: staged.isolation,
    });
  }

  private async gitCommit(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const message = boundedSingleLine(readString(input, 'message'), 'commit message', 500);
    const authorName = boundedSingleLine(readOptionalString(input, 'authorName') || 'Monarch Coder', 'author name', 120);
    const authorEmail = boundedSingleLine(readOptionalString(input, 'authorEmail') || 'coder@monarch.local', 'author email', 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(authorEmail)) throw new Error('Git author email is invalid.');
    const staged = await this.runGitSandbox(project, ['diff', '--cached', '--name-only'], 30_000);
    if (staged.exitCode !== 0 || !staged.stdout.trim()) return fail('No staged changes are available to commit.', 'git-nothing-staged');
    const before = await this.gitHead(project);
    const committed = await this.runGitSandbox(project, [
      '-c', `user.name=${authorName}`,
      '-c', `user.email=${authorEmail}`,
      '-c', 'commit.gpgSign=false',
      'commit', '--no-verify', '--no-gpg-sign', '-m', message,
    ], 120_000);
    if (committed.exitCode !== 0) return fail('Git commit failed.', 'git-commit-failed');
    const after = await this.gitHead(project);
    const details = await this.runGitSandbox(project, ['show', '-s', '--format=%H%x00%s%x00%an%x00%ae', 'HEAD'], 30_000);
    const fields = details.stdout.trim().split('\0');
    const verified = Boolean(after && after !== before && fields[0] === after);
    return {
      ok: verified,
      summary: verified ? `Created and verified Git commit ${after!.slice(0, 12)}.` : 'Git commit was created but readback verification failed.',
      output: {
        commit: after,
        previousCommit: before,
        subject: fields[1] || '',
        authorName: fields[2] || '',
        authorEmail: fields[3] || '',
        stagedFiles: staged.stdout.split(/\r?\n/).filter(Boolean),
        verified,
        isolation: committed.isolation,
      },
      ...(verified ? {} : { error: 'git-commit-verification-failed' }),
    };
  }

  private async gitBranchCreate(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const name = readString(input, 'name');
    await this.assertGitBranch(project, name);
    const startPoint = readOptionalString(input, 'startPoint');
    if (startPoint && (!/^[A-Za-z0-9._/@{}+-]{1,200}$/.test(startPoint) || startPoint.startsWith('-'))) {
      throw new Error('Git branch start point is invalid.');
    }
    const created = await this.runGitSandbox(project, ['switch', '-c', name, ...(startPoint ? [startPoint] : [])], 60_000);
    if (created.exitCode !== 0) return fail('Git branch creation failed.', 'git-branch-create-failed');
    const observed = await this.currentGitBranch(project);
    const verified = observed === name;
    return {
      ok: verified,
      summary: verified ? `Created and switched to branch '${name}'.` : 'Git branch readback did not match the requested branch.',
      output: { branch: observed, requested: name, startPoint: startPoint || null, verified, isolation: created.isolation },
      ...(verified ? {} : { error: 'git-branch-verification-failed' }),
    };
  }

  private async gitPush(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const remote = readOptionalString(input, 'remote') || 'origin';
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(remote)) throw new Error('Git remote name is invalid.');
    const branch = readOptionalString(input, 'branch') || await this.currentGitBranch(project);
    await this.assertGitBranch(project, branch);
    const remoteLookup = await this.runGitSandbox(project, ['remote', 'get-url', '--push', remote], 30_000);
    if (remoteLookup.exitCode !== 0) return fail(`Git remote '${remote}' is unavailable.`, 'git-remote-missing');
    const remoteUrl = remoteLookup.stdout.trim();
    assertSupportedPublicGitRemote(remoteUrl);
    await this.assertSafeHostGitConfiguration(project);
    const localHead = await this.gitHead(project);
    if (!localHead) return fail('Git branch has no commit to push.', 'git-head-missing');
    const args = [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=NUL',
      '-c', `core.sshCommand=${trustedWindowsSshCommand()}`,
      '-c', 'ssh.variant=ssh',
      '-c', 'credential.helper=',
      '-c', 'credential.helper=manager',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      'push', '--porcelain',
      remoteUrl,
      `${branch}:refs/heads/${branch}`,
    ];
    const hostGitEnvironment = hardenedHostGitEnvironment(this.sandbox.runtimeRoot);
    const pushed = await runProcess('git', args, project.root, 10 * 60_000, hostGitEnvironment);
    if (pushed.exitCode !== 0) {
      return { ok: false, summary: 'Git push failed.', output: sanitizeProcessResult(pushed), error: 'git-push-failed' };
    }
    const observed = await runProcess('git', [
      '-c', `core.sshCommand=${trustedWindowsSshCommand()}`,
      '-c', 'ssh.variant=ssh',
      '-c', 'credential.helper=',
      '-c', 'credential.helper=manager',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'protocol.ssh.allow=always',
      'ls-remote', '--heads', remoteUrl, `refs/heads/${branch}`,
    ], project.root, 120_000, hostGitEnvironment);
    const remoteHead = /^([a-f0-9]{40,64})\s/m.exec(observed.stdout)?.[1] || null;
    const verified = observed.exitCode === 0 && remoteHead === localHead;
    const setUpstream = readBoolean(input, 'setUpstream', true);
    let upstreamConfigured = !setUpstream;
    if (verified && setUpstream) {
      const remoteConfig = await this.runGitSandbox(project, ['config', '--local', '--replace-all', `branch.${branch}.remote`, remote], 30_000);
      const mergeConfig = await this.runGitSandbox(project, ['config', '--local', '--replace-all', `branch.${branch}.merge`, `refs/heads/${branch}`], 30_000);
      upstreamConfigured = remoteConfig.exitCode === 0 && mergeConfig.exitCode === 0;
    }
    const complete = verified && upstreamConfigured;
    return {
      ok: complete,
      summary: complete
        ? `Pushed and verified '${branch}' at ${localHead.slice(0, 12)}.`
        : verified
          ? 'Git push was verified, but upstream tracking could not be configured.'
          : 'Git push completed but remote readback did not match local HEAD.',
      output: {
        remote,
        remoteUrl: redactRemoteUrl(remoteUrl),
        branch,
        localHead,
        remoteHead,
        verified,
        upstreamConfigured,
        push: sanitizeProcessResult(pushed),
      },
      ...(complete ? {} : { error: verified ? 'git-upstream-configuration-failed' : 'git-push-verification-failed' }),
    };
  }

  private async githubStatus(): Promise<MonarchExecutionResult> {
    const status = await probe('gh', ['auth', 'status'], this.sandbox.runtimeRoot);
    return ok('GitHub integration status loaded.', status);
  }

  private async githubPullRequestView(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const number = readNumber(input, 'number', 0);
    if (number < 1 || number > Number.MAX_SAFE_INTEGER) throw new Error('GitHub pull request number is required.');
    const repository = await this.githubRepository(project);
    const args = ['pr', 'view', String(Math.trunc(number)), '--repo', repository, '--json', 'number,url,state,isDraft,headRefName,baseRefName,title,mergeStateStatus'];
    const viewed = await runProcess('gh', args, this.sandbox.runtimeRoot, 60_000, integrationProcessEnvironment(this.sandbox.runtimeRoot));
    if (viewed.exitCode !== 0) return { ok: false, summary: 'GitHub pull request lookup failed.', output: sanitizeProcessResult(viewed), error: 'github-pr-view-failed' };
    const data = parseJsonObject(viewed.stdout, 'GitHub pull request response');
    return ok(`GitHub pull request #${String(data.number || '?')} loaded.`, { ...data, verified: true });
  }

  private async githubPullRequestCreate(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const title = boundedText(readString(input, 'title'), 'pull request title', 240);
    const body = boundedText(readString(input, 'body', true), 'pull request body', 32_000, true);
    const base = readString(input, 'base');
    const head = readOptionalString(input, 'head') || await this.currentGitBranch(project);
    await this.assertGitBranch(project, base);
    await this.assertGitBranch(project, head);
    const repository = await this.githubRepository(project);
    const args = ['pr', 'create', '--repo', repository, '--title', title, '--body', body, '--base', base, '--head', head];
    if (readBoolean(input, 'draft', true)) args.push('--draft');
    const created = await runProcess('gh', args, this.sandbox.runtimeRoot, 120_000, integrationProcessEnvironment(this.sandbox.runtimeRoot));
    if (created.exitCode !== 0) return { ok: false, summary: 'GitHub pull request creation failed.', output: sanitizeProcessResult(created), error: 'github-pr-create-failed' };
    const url = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/i.exec(created.stdout)?.[0];
    if (!url) return fail('GitHub CLI returned no pull request URL.', 'github-pr-url-missing');
    const verifiedResult = await runProcess('gh', ['pr', 'view', url, '--repo', repository, '--json', 'number,url,state,isDraft,headRefName,baseRefName,title,mergeStateStatus'], this.sandbox.runtimeRoot, 60_000, integrationProcessEnvironment(this.sandbox.runtimeRoot));
    if (verifiedResult.exitCode !== 0) return fail('GitHub pull request was created but readback verification failed.', 'github-pr-verification-failed');
    const verified = parseJsonObject(verifiedResult.stdout, 'GitHub pull request verification');
    return ok(`Created and verified GitHub pull request #${String(verified.number || '?')}.`, { ...verified, verified: true });
  }

  private async huggingFaceStatus(): Promise<MonarchExecutionResult> {
    const status = await probe(this.huggingFaceExecutable(), ['auth', 'whoami'], this.sandbox.runtimeRoot);
    return ok('Hugging Face integration status loaded.', status);
  }

  private async huggingFaceRepoInfo(input: unknown): Promise<MonarchExecutionResult> {
    const repoId = readHuggingFaceRepoId(input);
    const repoType = readHuggingFaceRepoType(input);
    const revision = readOptionalString(input, 'revision');
    const collection = repoType === 'model' ? 'models' : `${repoType}s`;
    const url = new URL(`https://huggingface.co/api/${collection}/${repoId}`);
    if (revision) url.searchParams.set('revision', boundedSingleLine(revision, 'revision', 200));
    const response = await safeFetch(url);
    if (!response.ok) return fail(`Hugging Face repository lookup returned ${response.status}.`, 'huggingface-repo-info-failed');
    const data = parseJsonObject(await response.text(), 'Hugging Face repository response');
    return ok(`Hugging Face ${repoType} '${repoId}' loaded.`, {
      id: data.id || repoId,
      sha: data.sha || null,
      private: data.private === true,
      gated: data.gated || false,
      downloads: data.downloads || 0,
      likes: data.likes || 0,
      library: data.library_name || null,
      tags: Array.isArray(data.tags) ? data.tags.slice(0, 80) : [],
      files: Array.isArray(data.siblings) ? data.siblings.slice(0, 200).map(readHuggingFaceSibling) : [],
      verified: true,
    });
  }

  private async huggingFaceDownload(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const repoId = readHuggingFaceRepoId(input);
    const repoType = readHuggingFaceRepoType(input);
    const filenames = readStringArray(input, 'filenames').map(validateHuggingFaceFilename);
    if (filenames.length < 1 || filenames.length > 32) throw new Error('Hugging Face download requires 1 to 32 exact filenames.');
    const destination = await this.projects.policy.evaluatePath(readString(input, 'destination'), 'write', project.root);
    if (!destination.allowed || !isPathWithinRoot(destination.resolvedPath, project.root, { allowRoot: true })) {
      return blocked(destination.message || 'Hugging Face downloads must stay inside the selected project.', destination);
    }
    const maxBytes = clamp(readNumber(input, 'maxBytes', 512 * 1024 * 1024), 1, MAX_HF_TRANSFER_BYTES);
    const revision = readOptionalString(input, 'revision');
    const commonArgs = [repoId, ...filenames, '--type', repoType, ...(revision ? ['--revision', boundedSingleLine(revision, 'revision', 200)] : [])];
    const executable = this.huggingFaceExecutable();
    const env = integrationProcessEnvironment(this.sandbox.runtimeRoot);
    const dryRun = await runProcess(executable, ['download', ...commonArgs, '--dry-run', '--format', 'json'], this.sandbox.runtimeRoot, 120_000, env);
    if (dryRun.exitCode !== 0) return { ok: false, summary: 'Hugging Face download plan failed.', output: sanitizeProcessResult(dryRun), error: 'huggingface-download-plan-failed' };
    const planned = parseJsonArray(dryRun.stdout, 'Hugging Face download plan');
    const plannedBytes = planned.reduce<number>((total, entry) => total + parseHumanByteSize(isRecord(entry) ? entry.size : 0), 0);
    if (plannedBytes > maxBytes) throw new Error(`Hugging Face download plan is ${plannedBytes} bytes, above the ${maxBytes}-byte limit.`);
    if (path.parse(destination.resolvedPath).root.toLowerCase() === 'c:\\' && plannedBytes > MAX_C_DRIVE_HF_DOWNLOAD_BYTES) {
      throw new Error('Large Hugging Face downloads to C: are blocked. Select a project or destination on E: or D:.');
    }
    await mkdir(destination.resolvedPath, { recursive: true });
    const downloaded = await runProcess(executable, ['download', ...commonArgs, '--local-dir', destination.resolvedPath, '--max-workers', '4', '--format', 'json'], this.sandbox.runtimeRoot, 10 * 60_000, env);
    if (downloaded.exitCode !== 0) return { ok: false, summary: 'Hugging Face download failed.', output: sanitizeProcessResult(downloaded), error: 'huggingface-download-failed' };
    const files = [] as Array<{ path: string; sizeBytes: number; sha256: string }>;
    for (const filename of filenames) {
      const target = path.resolve(destination.resolvedPath, filename);
      const canonical = await realpath(target);
      if (!isPathWithinRoot(canonical, destination.resolvedPath, { allowRoot: false })) throw new Error('Downloaded Hugging Face file escaped the destination through a link.');
      const details = await stat(canonical);
      if (!details.isFile()) throw new Error(`Downloaded Hugging Face file is missing: ${filename}`);
      files.push({ path: canonical, sizeBytes: details.size, sha256: await sha256File(canonical) });
    }
    return ok(`Downloaded and verified ${files.length} Hugging Face file(s).`, {
      repoId,
      repoType,
      revision: revision || null,
      destination: destination.resolvedPath,
      plannedBytes,
      files,
      verified: true,
    });
  }

  private async huggingFaceUpload(input: unknown): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const repoId = readHuggingFaceRepoId(input);
    const repoType = readHuggingFaceRepoType(input);
    const local = await this.projects.policy.evaluatePath(readString(input, 'localPath'), 'read', project.root);
    if (!local.allowed || !isPathWithinRoot(local.resolvedPath, project.root, { allowRoot: true })) {
      return blocked(local.message || 'Hugging Face uploads must originate inside the selected project.', local);
    }
    const audit = await auditUploadTree(local.resolvedPath, MAX_HF_TRANSFER_BYTES);
    const remotePath = validateHuggingFaceFilename(readOptionalString(input, 'pathInRepo') || path.basename(local.resolvedPath));
    const revision = readOptionalString(input, 'revision');
    const commitMessage = boundedSingleLine(readOptionalString(input, 'commitMessage') || `Upload ${remotePath} from Monarch Coder`, 'commit message', 500);
    const args = [
      'upload', repoId, local.resolvedPath, remotePath,
      '--type', repoType,
      ...(revision ? ['--revision', boundedSingleLine(revision, 'revision', 200)] : []),
      '--commit-message', commitMessage,
      ...(readBoolean(input, 'createPullRequest', false) ? ['--create-pr'] : []),
      ...(audit.directory ? [
        '--exclude', '.git/**',
        '--exclude', '.monarch/**',
        '--exclude', '.venv/**',
        '--exclude', 'node_modules/**',
        '--exclude', '.env*',
        '--exclude', '**/*.pem',
        '--exclude', '**/*.key',
      ] : []),
      '--format', 'json',
    ];
    const executable = this.huggingFaceExecutable();
    const env = integrationProcessEnvironment(this.sandbox.runtimeRoot);
    const uploaded = await runProcess(executable, args, this.sandbox.runtimeRoot, 10 * 60_000, env);
    if (uploaded.exitCode !== 0) return { ok: false, summary: 'Hugging Face upload failed.', output: sanitizeProcessResult(uploaded), error: 'huggingface-upload-failed' };
    const verification = await runProcess(executable, [
      'download', repoId, remotePath, '--type', repoType,
      ...(revision ? ['--revision', revision] : []),
      '--dry-run', '--format', 'json',
    ], this.sandbox.runtimeRoot, 120_000, env);
    const verifiedFiles = verification.exitCode === 0 ? parseJsonArray(verification.stdout, 'Hugging Face upload verification') : [];
    const verified = verifiedFiles.length > 0;
    return {
      ok: verified,
      summary: verified ? `Uploaded and verified '${remotePath}' in '${repoId}'.` : 'Hugging Face upload completed but remote readback verification failed.',
      output: {
        repoId,
        repoType,
        remotePath,
        revision: revision || null,
        localAudit: audit,
        upload: sanitizeProcessResult(uploaded),
        remoteFiles: verifiedFiles,
        verified,
      },
      ...(verified ? {} : { error: 'huggingface-upload-verification-failed' }),
    };
  }

  private async runGitSandbox(project: CoderProject, args: string[], timeoutMs: number, allowNetwork = false): Promise<ProcessResult & { isolation?: unknown }> {
    return this.runProjectCommand(project, {
      executable: 'git',
      args: ['-c', 'core.hooksPath=NUL', '-c', 'diff.external=', ...args],
      timeoutMs,
      allowNetwork,
    });
  }

  private async assertSafeHostGitConfiguration(project: CoderProject): Promise<void> {
    const result = await this.runGitSandbox(project, ['config', '--local', '--no-includes', '--null', '--name-only', '--list'], 30_000);
    if (result.exitCode !== 0) throw new Error('Local Git configuration could not be audited before host credential use.');
    const dangerous = result.stdout
      .split('\0')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry && isDangerousHostGitConfigKey(entry));
    if (dangerous.length > 0) {
      throw new Error(`Git push is blocked because the repository contains host-executable configuration: ${dangerous.slice(0, 8).join(', ')}`);
    }
  }

  private async githubRepository(project: CoderProject): Promise<string> {
    for (const remote of ['origin', 'upstream']) {
      const lookup = await this.runGitSandbox(project, ['remote', 'get-url', remote], 30_000);
      if (lookup.exitCode !== 0) continue;
      const repository = parseGitHubRepository(lookup.stdout.trim());
      if (repository) return repository;
    }
    throw new Error('The selected project has no credential-free GitHub origin or upstream remote.');
  }

  private async validatedProjectRelativePath(project: CoderProject, requested: string): Promise<string> {
    const evaluation = await this.projects.policy.evaluatePath(requested, 'read', project.root);
    if (!evaluation.allowed || !isPathWithinRoot(evaluation.resolvedPath, project.root, { allowRoot: true })) {
      throw new Error('Git paths must stay inside the selected Coder project.');
    }
    const relative = path.relative(project.root, evaluation.resolvedPath).replace(/\\/g, '/');
    return relative || '.';
  }

  private async assertGitBranch(project: CoderProject, branch: string): Promise<void> {
    if (!branch || branch.length > 200 || branch.startsWith('-')) throw new Error('Git branch name is invalid.');
    const checked = await this.runGitSandbox(project, ['check-ref-format', '--branch', branch], 30_000);
    if (checked.exitCode !== 0) throw new Error(`Git branch name is invalid: ${branch}`);
  }

  private async gitHead(project: CoderProject): Promise<string | null> {
    const result = await this.runGitSandbox(project, ['rev-parse', '--verify', 'HEAD'], 30_000);
    const value = result.stdout.trim();
    return result.exitCode === 0 && /^[a-f0-9]{40,64}$/i.test(value) ? value : null;
  }

  private async currentGitBranch(project: CoderProject): Promise<string> {
    const result = await this.runGitSandbox(project, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 30_000);
    const branch = result.stdout.trim();
    if (result.exitCode !== 0 || !branch) throw new Error('Current Git branch is unavailable.');
    return branch;
  }

  private huggingFaceExecutable(): string {
    const executable = this.huggingFaceExecutablePath;
    if (!existsSync(executable)) throw new Error('Bundled Hugging Face CLI is unavailable.');
    return executable;
  }

  private async createSkill(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const project = this.projects.require(readOptionalString(input, 'projectId'));
    const name = readString(input, 'name').trim();
    const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (!slug) throw new Error('Skill name must contain Latin letters or numbers.');
    const skillsRoot = path.join(project.root, '.monarch', 'skills');
    const draft = path.join(skillsRoot, `.draft-${slug}-${randomUUID().slice(0, 8)}`);
    const target = path.join(skillsRoot, slug);
    if (existsSync(target)) throw new Error(`Skill '${slug}' already exists.`);
    const policy = await this.projects.policy.evaluatePath(draft, 'write', project.root);
    if (!policy.allowed) return blocked(policy.message, policy);
    await mkdir(draft, { recursive: true });
    try {
      const description = readString(input, 'description');
      const instructions = readString(input, 'instructions');
      if (instructions.length < 40 || instructions.length > 80_000) throw new Error('Skill instructions must be between 40 and 80,000 characters.');
      const skillDocument = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${instructions.trim()}\n`;
      await writeFile(path.join(draft, 'SKILL.md'), skillDocument, 'utf8');
      await writeFile(path.join(draft, 'skill.json'), JSON.stringify({
        schemaVersion: 1,
        managedBy: 'monarch-coder',
        name: slug,
        description,
        activatedAt: new Date().toISOString(),
      }, null, 2), 'utf8');
      const validation = readRecord(input)?.validation;
      let validationResult: ProcessResult | null = null;
      if (isRecord(validation) && typeof validation.executable === 'string' && validation.executable.trim()) {
        validationResult = await this.runProjectCommand(project, {
          executable: validation.executable,
          args: Array.isArray(validation.args) ? validation.args.map(String) : [],
          cwd: typeof validation.cwd === 'string' ? validation.cwd : project.root,
          timeoutMs: typeof validation.timeoutMs === 'number' ? validation.timeoutMs : 60_000,
          allowNetwork: validation.allowNetwork === true,
        });
        if (validationResult.exitCode !== 0 || validationResult.timedOut) {
          throw new Error(`Skill validation failed: ${validationResult.stderr || validationResult.stdout || 'non-zero exit'}`);
        }
      }
      await rename(draft, target);
      await context.emit('coder.skill.validated', this.manifest.id, { projectId: project.id, skill: slug, path: target });
      return ok(`Skill '${slug}' validated and activated.`, { skill: slug, path: target, validation: validationResult });
    } catch (error) {
      await rm(draft, { recursive: true, force: true });
      throw error;
    }
  }

  private async integrationsStatus(): Promise<MonarchExecutionResult> {
    const [checks, sandbox] = await Promise.all([
      Promise.all([
      probe('git', ['--version'], this.sandbox.runtimeRoot),
      probe('gh', ['auth', 'status'], this.sandbox.runtimeRoot),
      probe(this.huggingFaceExecutablePath, ['auth', 'whoami'], this.sandbox.runtimeRoot),
      ]),
      this.sandbox.status(),
    ]);
    return ok('Coder integration status loaded.', {
      network: { available: true, policy: 'public-http-get-head' },
      git: checks[0],
      github: checks[1],
      huggingFace: checks[2],
      sandbox,
      note: 'Authentication secrets are never returned to the model.',
    });
  }

  private async runProjectCommand(
    project: CoderProject,
    command: { executable: string; args: string[]; cwd?: string; timeoutMs: number; allowNetwork?: boolean },
  ): Promise<ProcessResult> {
    const cwdEvaluation = await this.projects.policy.evaluatePath(command.cwd || project.root, 'read', project.root);
    if (!cwdEvaluation.allowed) throw new Error(cwdEvaluation.message);
    const cwdStat = await stat(cwdEvaluation.resolvedPath);
    if (!cwdStat.isDirectory()) throw new Error('Command working directory must be a folder.');
    if (!isPathWithinRoot(cwdEvaluation.resolvedPath, project.root, { allowRoot: true })) {
      throw new Error('Commands must run inside the selected Coder project. Register another folder as a project before executing there.');
    }
    this.projects.policy.validateCommand(command.executable, command.args, cwdEvaluation.resolvedPath);
    return this.sandbox.execute({
      projectRoot: project.root,
      executable: command.executable,
      args: command.args,
      cwd: cwdEvaluation.resolvedPath,
      timeoutMs: clamp(command.timeoutMs, 1_000, 10 * 60_000),
      allowNetwork: command.allowNetwork !== false,
    });
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let truncated = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const remaining = MAX_PROCESS_OUTPUT_BYTES - current.length;
      if (remaining <= 0) { truncated = true; return current; }
      if (chunk.length > remaining) truncated = true;
      return Buffer.concat([current, chunk.subarray(0, Math.max(0, remaining))]);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        truncated,
      });
    });
  });
}

async function probe(executable: string, args: string[], runtimeRoot: string): Promise<Record<string, unknown>> {
  if (path.isAbsolute(executable) && !existsSync(executable)) return { installed: false, authenticated: false };
  try {
    const result = await runProcess(executable, args, process.cwd(), 15_000, sanitizedProcessEnvironment(runtimeRoot));
    return {
      installed: true,
      authenticated: result.exitCode === 0,
      exitCode: result.exitCode,
      summary: sanitizeProbeOutput(result.stdout || result.stderr),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { installed: code !== 'ENOENT', authenticated: false, summary: code === 'ENOENT' ? 'Not installed.' : 'Status unavailable.' };
  }
}

function sanitizeProbeOutput(value: string): string {
  return value.replace(/(?:hf_|ghp_|github_pat_)[A-Za-z0-9_\-]+/g, '[redacted]').trim().slice(0, 600);
}

function integrationProcessEnvironment(monarchRoot: string): NodeJS.ProcessEnv {
  return {
    ...sanitizedProcessEnvironment(monarchRoot, path.join(monarchRoot, 'integration-tmp')),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_PAGER: 'cat',
    GH_PAGER: 'cat',
    PAGER: 'cat',
    HF_HUB_DISABLE_TELEMETRY: '1',
  };
}

function hardenedHostGitEnvironment(runtimeRoot: string): NodeJS.ProcessEnv {
  return {
    ...integrationProcessEnvironment(runtimeRoot),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: 'NUL',
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    GIT_SSH_COMMAND: trustedWindowsSshCommand(),
  };
}

function trustedWindowsSshCommand(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return `${path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe')} -oBatchMode=yes`;
}

function isDangerousHostGitConfigKey(key: string): boolean {
  return /^(?:include|includeif|url|credential|filter|diff|difftool|merge|mergetool|pager|interactive|sequence|gpg|protocol)\./.test(key)
    || /^core\.(?:hookspath|fsmonitor|sshcommand|editor|askpass)$/.test(key)
    || /^remote\..*\.(?:proxy|uploadpack|receivepack|vcs)$/.test(key)
    || /^submodule\..*\.update$/.test(key)
    || /^http\.(?:proxy|sslverify)$/.test(key);
}

function parseGitHubRepository(value: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(value);
  return match?.[1] || null;
}

function sanitizeIntegrationText(value: string): string {
  return value
    .replace(/(?:hf_|ghp_|github_pat_)[A-Za-z0-9_\-]+/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .trim()
    .slice(0, 64 * 1024);
}

function sanitizeProcessResult(result: ProcessResult): ProcessResult {
  return {
    ...result,
    stdout: sanitizeIntegrationText(result.stdout),
    stderr: sanitizeIntegrationText(result.stderr),
  };
}

function readSafeNetworkHeaders(input: unknown): Record<string, string> {
  const value = readRecord(input)?.headers;
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('headers must be an object of string values.');
  const headers: Record<string, string> = {};
  const forbidden = /(?:authorization|proxy-authorization|cookie|set-cookie|token|secret|api[-_]?key|host|content-length|transfer-encoding|connection)/i;
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(name) || forbidden.test(name)) {
      throw new Error(`Network header '${rawName}' is blocked; authenticated integrations must use dedicated capabilities.`);
    }
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue) || rawValue.length > 4_096) {
      throw new Error(`Network header '${rawName}' has an invalid value.`);
    }
    headers[name] = rawValue;
  }
  return headers;
}

function readPublicNetworkUrl(input: unknown): string {
  const value = readString(input, 'url');
  const parsed = new URL(value);
  if (parsed.username || parsed.password) {
    throw new Error('Credentials in Coder network URLs are blocked; use a dedicated authenticated integration.');
  }
  return parsed.toString();
}

function boundedSingleLine(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) throw new Error(`${label} must be one line and at most ${maxLength} characters.`);
  return normalized;
}

function boundedText(value: string, label: string, maxLength: number, allowEmpty = false): string {
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`${label} must be ${allowEmpty ? 'at most' : 'between 1 and'} ${maxLength} characters.`);
  }
  return normalized;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonArray(value: string, label: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSupportedPublicGitRemote(value: string): void {
  const hostPattern = '(?:github\\.com|gitlab\\.com|bitbucket\\.org|huggingface\\.co)';
  const https = new RegExp(`^https://${hostPattern}/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\\.git)?$`, 'i');
  const ssh = new RegExp(`^(?:ssh://git@${hostPattern}/|git@${hostPattern}:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\\.git)?$`, 'i');
  if (!https.test(value) && !ssh.test(value)) {
    throw new Error('First-class Git push only allows credential-free remote URLs on GitHub, GitLab, Bitbucket, or Hugging Face.');
  }
}

function redactRemoteUrl(value: string): string {
  return value.replace(/(https?:\/\/)[^/@:]+:[^/@]+@/i, '$1[redacted]@');
}

function readHuggingFaceRepoId(input: unknown): string {
  const value = readString(input, 'repoId').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value)) {
    throw new Error('Hugging Face repoId must use the owner/name form.');
  }
  return value;
}

function readHuggingFaceRepoType(input: unknown): 'model' | 'dataset' | 'space' {
  const value = (readOptionalString(input, 'repoType') || 'model').toLowerCase();
  if (value !== 'model' && value !== 'dataset' && value !== 'space') throw new Error('Hugging Face repoType must be model, dataset, or space.');
  return value;
}

function validateHuggingFaceFilename(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.length > 500 || normalized.includes('\0') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid Hugging Face repository path: ${value}`);
  }
  return normalized;
}

function readHuggingFaceSibling(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return {
    path: typeof value.rfilename === 'string' ? value.rfilename : '',
    size: typeof value.size === 'number' ? value.size : null,
    blobId: typeof value.blobId === 'string' ? value.blobId : null,
  };
}

function parseHumanByteSize(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?i?B?)?\s*$/i.exec(String(value || ''));
  if (!match?.[1]) throw new Error(`Unrecognized Hugging Face file size: ${String(value)}`);
  const amount = Number(match[1]);
  const unit = (match[2] || '').toUpperCase();
  const power = unit.startsWith('K') ? 1 : unit.startsWith('M') ? 2 : unit.startsWith('G') ? 3 : unit.startsWith('T') ? 4 : 0;
  return Math.ceil(amount * (1024 ** power));
}

async function auditUploadTree(target: string, maxBytes: number): Promise<{ files: number; totalBytes: number; directory: boolean }> {
  const details = await stat(target);
  const sensitive = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|\.(?:npmrc|pypirc|netrc)|_netrc|(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|txt))?|.*[._-](?:secret|secrets|credential|credentials|token|access[_-]?token|api[_-]?key)(?:\.(?:json|ya?ml|toml|ini|txt))?|.*\.(?:pem|p12|pfx|key))$/i;
  const excludedDirectories = new Set(['.git', '.monarch', '.venv', 'node_modules']);
  if (details.isFile()) {
    if (sensitive.test(path.basename(target))) throw new Error('Sensitive credential-like files cannot be uploaded by Coder Mode.');
    if (details.size > maxBytes) throw new Error(`Upload exceeds the ${maxBytes}-byte limit.`);
    return { files: 1, totalBytes: details.size, directory: false };
  }
  if (!details.isDirectory()) throw new Error('Hugging Face upload target must be a file or directory.');
  let files = 0;
  let totalBytes = 0;
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Hugging Face uploads cannot include symbolic links.');
      if (entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase())) continue;
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile()) {
        if (sensitive.test(entry.name)) throw new Error(`Sensitive credential-like file cannot be uploaded: ${path.relative(target, candidate)}`);
        files += 1;
        totalBytes += (await stat(candidate)).size;
        if (files > 10_000 || totalBytes > maxBytes) throw new Error('Hugging Face upload tree exceeds Coder Mode bounds.');
      }
    }
  }
  return { files, totalBytes, directory: true };
}

async function ensureMonarchGitExclude(projectRoot: string): Promise<void> {
  const excludePath = path.join(projectRoot, '.git', 'info', 'exclude');
  const gitRoot = path.join(projectRoot, '.git');
  const gitDetails = await stat(gitRoot).catch(() => null);
  if (!gitDetails?.isDirectory()) return;
  const existing = await readFile(excludePath, 'utf8').catch(() => '');
  if (existing.split(/\r?\n/).some((line) => line.trim() === '.monarch/')) return;
  await atomicWrite(excludePath, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}.monarch/\n`);
}

function sha256File(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function readRecord(input: unknown): Record<string, unknown> | null {
  return isRecord(input) ? input : null;
}

function readString(input: unknown, key: string, allowEmpty = false): string {
  const value = readRecord(input)?.[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${key} is required.`);
  return value;
}

function readOptionalString(input: unknown, key: string): string | undefined {
  const value = readRecord(input)?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(input: unknown, key: string): string[] {
  const value = readRecord(input)?.[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${key} must be an array of strings.`);
  return value as string[];
}

function readBoolean(input: unknown, key: string, fallback: boolean): boolean {
  const value = readRecord(input)?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readNumber(input: unknown, key: string, fallback: number): number {
  const value = readRecord(input)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readReplacements(input: unknown): Array<{ oldText: string; newText: string }> {
  const value = readRecord(input)?.replacements;
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error('replacements must contain 1 to 64 edits.');
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.oldText !== 'string' || !entry.oldText || typeof entry.newText !== 'string') {
      throw new Error('Each replacement requires non-empty oldText and string newText.');
    }
    return { oldText: entry.oldText, newText: entry.newText };
  });
}

function ok(summary: string, output?: unknown): MonarchExecutionResult {
  return { ok: true, summary, ...(output === undefined ? {} : { output }) };
}

function fail(summary: string, error: string): MonarchExecutionResult {
  return { ok: false, summary, error };
}

function blocked(summary: string, output: unknown): MonarchExecutionResult {
  return { ok: false, summary, error: 'coder-policy-blocked', output };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shouldSkipDirectory(name: string): boolean {
  return new Set(['.git', '.hg', '.svn', '.venv', 'node_modules', 'dist', 'build', 'target', 'vendor']).has(name.toLowerCase());
}

export function createCoderModule(options: CoderModuleOptions = {}): MonarchModule {
  return new CoderModule(options);
}

export const coderModulePackage: MonarchModulePackage = {
  id: coderManifest.id,
  moduleId: coderManifest.id,
  version: coderManifest.version,
  description: coderManifest.description,
  core: { minVersion: '0.1.0' },
  factory: (context) => createCoderModule(context?.workspaceRoot ? { monarchRoot: context.workspaceRoot } : {}),
};

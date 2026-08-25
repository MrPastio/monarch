import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readDurableJson, writeDurableJson } from '../../core/durable-json';
import { CoderHostPolicy } from './policy';
import type { CoderProject, CoderProjectRegistryV1, CoderProjectSnapshot } from './types';

const MAX_PROJECTS = 200;
const SNAPSHOT_SKIP_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
  '.monarch',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

export interface CoderProjectStoreOptions {
  monarchRoot: string;
  registryPath?: string;
  workspaceCoderRoot?: string;
}

export class CoderProjectStore {
  readonly monarchRoot: string;
  readonly workspaceCoderRoot: string;
  readonly registryPath: string;
  readonly policy: CoderHostPolicy;
  private registry: CoderProjectRegistryV1;
  private projectMutationTail: Promise<void> = Promise.resolve();

  constructor(options: CoderProjectStoreOptions) {
    this.monarchRoot = path.resolve(options.monarchRoot);
    this.workspaceCoderRoot = path.resolve(options.workspaceCoderRoot || path.join(this.monarchRoot, 'Workspace Coder'));
    this.registryPath = path.resolve(options.registryPath || path.join(this.monarchRoot, 'runtime', 'coder', 'projects.json'));
    this.policy = new CoderHostPolicy({
      monarchRoot: this.monarchRoot,
      workspaceCoderRoot: this.workspaceCoderRoot,
    });
    this.registry = normalizeRegistry(readDurableJson<unknown>(this.registryPath), this.registryPath);
  }

  async initialize(): Promise<void> {
    await this.enqueueProjectMutation(async () => {
      await mkdir(this.workspaceCoderRoot, { recursive: true });
      this.commitRegistry(() => this.pruneMissingProjects());
    });
  }

  list(): { activeProjectId: string | null; projects: CoderProject[]; workspaceCoderRoot: string } {
    return {
      activeProjectId: this.registry.activeProjectId,
      projects: this.registry.projects.map((project) => ({ ...project })),
      workspaceCoderRoot: this.workspaceCoderRoot,
    };
  }

  get(projectId?: string): CoderProject | null {
    const id = String(projectId || this.registry.activeProjectId || '').trim();
    if (!id) return null;
    const project = this.registry.projects.find((entry) => entry.id === id);
    return project ? { ...project } : null;
  }

  async create(nameInput: unknown): Promise<CoderProject> {
    return await this.enqueueProjectMutation(async () => {
      const name = normalizeProjectName(nameInput);
      await mkdir(this.workspaceCoderRoot, { recursive: true });
      const root = await this.allocateProjectRoot(slugify(name));
      let markerCreated = false;
      try {
        const project = this.buildRecord(name, root, 'created');
        markerCreated = await this.writeProjectMarker(project, false);
        return this.registerRecord(project);
      } catch (error) {
        const markerDirectory = path.join(root, '.monarch');
        if (markerCreated) await rm(path.join(markerDirectory, 'coder-project.json'), { force: true }).catch(() => undefined);
        await rmdir(markerDirectory).catch(() => undefined);
        await rmdir(root).catch(() => undefined);
        throw error;
      }
    });
  }

  async import(existingPathInput: unknown, nameInput?: unknown): Promise<CoderProject> {
    return await this.enqueueProjectMutation(async () => {
      const existingPath = typeof existingPathInput === 'string' ? existingPathInput.trim() : '';
      if (!existingPath) throw new Error('Existing project path is required.');
      const requestedRoot = path.resolve(existingPath);
      const rootStat = await stat(requestedRoot).catch(() => null);
      const root = rootStat?.isDirectory()
        ? this.policy.assertProjectRoot(await realpath(requestedRoot))
        : requestedRoot;
      if (!rootStat?.isDirectory()) throw new Error(`Project folder does not exist: ${root}`);
      const duplicate = this.registry.projects.find((project) => samePath(project.root, root));
      if (duplicate) return this.activate(duplicate.id);
      const name = nameInput ? normalizeProjectName(nameInput) : normalizeProjectName(path.basename(root));
      const project = this.buildRecord(name, root, 'imported');
      const markerPath = path.join(project.root, '.monarch', 'coder-project.json');
      const markerRootExisted = existsSync(path.dirname(markerPath));
      const markerCreated = await this.writeProjectMarker(project, true).catch(() => false);
      try {
        return this.registerRecord(project);
      } catch (error) {
        if (markerCreated) {
          await rm(markerPath, { force: true }).catch(() => undefined);
          if (!markerRootExisted) await rmdir(path.dirname(markerPath)).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  activate(projectId: string): CoderProject {
    const project = this.registry.projects.find((entry) => entry.id === projectId);
    if (!project) throw new Error(`Coder project not found: ${projectId}`);
    if (!existsSync(project.root) || !statSync(project.root).isDirectory()) {
      throw new Error(`Coder project folder is unavailable: ${project.root}`);
    }
    const canonical = this.policy.assertProjectRoot(realpathSync.native(project.root));
    return this.commitRegistry(() => {
      const now = new Date().toISOString();
      project.root = canonical;
      project.lastOpenedAt = now;
      project.updatedAt = now;
      this.registry.activeProjectId = project.id;
      return { ...project };
    });
  }

  async snapshot(projectId?: string, limit = 240): Promise<CoderProjectSnapshot> {
    const project = this.require(projectId);
    const entries = await collectProjectEntries(project.root, Math.max(20, Math.min(limit, 800)));
    const git = await readGitSnapshot(project.root);
    return { project, entries, git };
  }

  require(projectId?: string): CoderProject {
    const id = String(projectId || this.registry.activeProjectId || '').trim();
    const project = this.registry.projects.find((entry) => entry.id === id);
    if (!project) throw new Error('Select or create a Coder project first.');
    this.canonicalizeProject(project);
    return { ...project };
  }

  private canonicalizeProject(project: CoderProject): void {
    const canonical = this.policy.assertProjectRoot(realpathSync.native(project.root));
    if (samePath(project.root, canonical)) return;
    this.commitRegistry(() => {
      project.root = canonical;
      project.updatedAt = new Date().toISOString();
    });
  }

  private buildRecord(name: string, root: string, source: CoderProject['source']): CoderProject {
    if (this.registry.projects.length >= MAX_PROJECTS) {
      throw new Error(`Coder project registry limit reached (${MAX_PROJECTS}).`);
    }
    const now = new Date().toISOString();
    const project: CoderProject = {
      id: `coder_project_${createHash('sha256').update(`${root}\0${randomUUID()}`).digest('hex').slice(0, 18)}`,
      name,
      root,
      source,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    };
    return project;
  }

  private async allocateProjectRoot(base: string): Promise<string> {
    for (let index = 1; index < 10_000; index += 1) {
      const slug = index === 1 ? base : `${base}-${index}`;
      const root = this.policy.assertProjectRoot(path.join(this.workspaceCoderRoot, slug));
      try {
        await mkdir(root, { recursive: false });
        return root;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Could not allocate a unique project folder.');
  }

  private registerRecord(project: CoderProject): CoderProject {
    return this.commitRegistry(() => {
      this.registry.projects.unshift(project);
      this.registry.activeProjectId = project.id;
      return { ...project };
    });
  }

  private async writeProjectMarker(project: CoderProject, allowExisting: boolean): Promise<boolean> {
    const directory = path.join(project.root, '.monarch');
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(path.join(directory, 'coder-project.json'), `${JSON.stringify({
        version: 1,
        id: project.id,
        name: project.name,
        source: project.source,
        createdAt: project.createdAt,
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if (allowExisting && (error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  private pruneMissingProjects(): void {
    this.registry.projects = this.registry.projects.filter((project) => {
      try {
        if (!statSync(project.root).isDirectory()) return false;
        project.root = this.policy.assertProjectRoot(realpathSync.native(project.root));
        return true;
      } catch {
        return false;
      }
    }).slice(0, MAX_PROJECTS);
    if (!this.registry.projects.some((project) => project.id === this.registry.activeProjectId)) {
      this.registry.activeProjectId = this.registry.projects[0]?.id || null;
    }
  }

  private persist(): void {
    writeDurableJson(this.registryPath, this.registry);
  }

  private commitRegistry<R>(mutation: () => R): R {
    const previous = cloneRegistry(this.registry);
    try {
      const result = mutation();
      this.persist();
      return result;
    } catch (error) {
      this.registry = previous;
      throw error;
    }
  }

  private enqueueProjectMutation<R>(mutation: () => Promise<R>): Promise<R> {
    const result = this.projectMutationTail.then(mutation);
    this.projectMutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function normalizeRegistry(value: unknown, registryPath: string): CoderProjectRegistryV1 {
  if (value === null) return { version: 1, activeProjectId: null, projects: [] };
  if (!isRecord(value)
    || value.version !== 1
    || (value.activeProjectId !== null && typeof value.activeProjectId !== 'string')
    || !Array.isArray(value.projects)
    || !value.projects.every(isValidProject)) {
    throw new Error(`Coder project registry ${registryPath} has an invalid schema and was not modified.`);
  }
  const projects = value.projects
    .map((project) => ({ ...project, root: path.resolve(project.root) }))
    .slice(0, MAX_PROJECTS);
  return {
    version: 1,
    activeProjectId: typeof value.activeProjectId === 'string' ? value.activeProjectId : null,
    projects,
  };
}

function isValidProject(value: unknown): value is CoderProject {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.root === 'string'
    && (value.source === 'created' || value.source === 'imported')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.lastOpenedAt === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneRegistry(registry: CoderProjectRegistryV1): CoderProjectRegistryV1 {
  return {
    version: 1,
    activeProjectId: registry.activeProjectId,
    projects: registry.projects.map((project) => ({ ...project })),
  };
}

function normalizeProjectName(value: unknown): string {
  const name = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!name) throw new Error('Project name is required.');
  return Array.from(name).slice(0, 80).join('');
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'new-project';
}

async function collectProjectEntries(root: string, limit: number): Promise<CoderProjectSnapshot['entries']> {
  const result: CoderProjectSnapshot['entries'] = [];
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [{ absolute: root, relative: '', depth: 0 }];
  while (queue.length && result.length < limit) {
    const current = queue.shift()!;
    const entries = await readdir(current.absolute, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.length >= limit) break;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && SNAPSHOT_SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: relative, type: 'directory' });
        if (current.depth < 5) queue.push({ absolute, relative, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        const fileStat = await stat(absolute).catch(() => null);
        result.push({ path: relative, type: 'file', ...(fileStat ? { sizeBytes: fileStat.size } : {}) });
      }
    }
  }
  return result;
}

async function readGitSnapshot(root: string): Promise<CoderProjectSnapshot['git']> {
  const gitDirectory = path.join(root, '.git');
  if (!existsSync(gitDirectory)) {
    return { available: true, repository: false, branch: '', status: [] };
  }
  const head = await readFile(path.join(gitDirectory, 'HEAD'), 'utf8').catch(() => '');
  const branch = head.startsWith('ref:') ? head.trim().split('/').at(-1) || '' : head.trim().slice(0, 12);
  return { available: true, repository: true, branch, status: [] };
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

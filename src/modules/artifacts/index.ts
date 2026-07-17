import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { evaluateFilesystemAccess, permissionModeForRisk } from '../../core';
import { artifactsManifest } from './manifest';

type ArtifactType = 'html' | 'md' | 'txt' | 'json';

export interface ArtifactsModuleOptions {
  workspaceRoot?: string;
  artifactsRoot?: string;
}

export class ArtifactsModule implements MonarchModule {
  readonly manifest = artifactsManifest;
  private readonly workspaceRoot: string;
  private readonly artifactsRoot: string;

  constructor(options: ArtifactsModuleOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.artifactsRoot = path.resolve(options.artifactsRoot || path.join(this.workspaceRoot, 'artifacts', 'generated'));
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await mkdir(this.artifactsRoot, { recursive: true });
    await context.emit('artifacts.activated', this.manifest.id, {
      artifactsRoot: this.artifactsRoot,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: `Artifacts module ready at ${this.artifactsRoot}.`,
      output: {
        artifactsRoot: this.artifactsRoot,
        supportedTypes: ['html', 'md', 'txt', 'json'],
      },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    if (!/(artifact|html|markdown|json).{0,40}(save|write|create|generate)|(?:save|write|create).{0,40}(artifact|html|markdown|json)/i.test(text)) {
      return null;
    }

    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'artifacts.write',
      confidence: 0.72,
      reason: 'Artifact generation/write request detected.',
      permissionMode: permissionModeForRisk('write'),
      input: {
        type: inferArtifactType(text),
        content: '',
      },
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'artifacts.write':
      return this.writeArtifact(request.input, context);
    case 'artifacts.list':
      return this.listArtifacts(request.input);
    default:
      return {
        ok: false,
        summary: `Unsupported artifacts capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async writeArtifact(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const artifactType = normalizeArtifactType(readStringInput(input, 'type'));
    if (!artifactType) {
      return {
        ok: false,
        summary: 'Unsupported artifact type. Use html, md, txt, or json.',
        error: 'unsupported-artifact-type',
      };
    }

    const serialization = serializeArtifact(artifactType, readContentInput(input));
    if (!serialization.ok) {
      return {
        ok: false,
        summary: serialization.error,
        error: 'artifact-serialization-failed',
      };
    }

    const targetPath = resolveArtifactTarget({
      root: this.artifactsRoot,
      requestedPath: readStringInput(input, 'path'),
      fileName: readStringInput(input, 'fileName'),
      artifactType,
    });
    const evaluation = evaluateFilesystemAccess(targetPath, 'write', {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.artifactsRoot,
    });
    if (!evaluation.allowed) {
      return {
        ok: false,
        summary: evaluation.message,
        error: 'filesystem-policy-blocked',
        metadata: { evaluation },
      };
    }

    const overwrite = readBooleanInput(input, 'overwrite', false);
    const existing = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (existing && !overwrite) {
      return {
        ok: false,
        summary: `Artifact already exists: ${evaluation.resolvedPath}`,
        error: 'artifact-exists',
        metadata: { evaluation },
      };
    }

    await mkdir(path.dirname(evaluation.resolvedPath), { recursive: true });
    await writeFile(evaluation.resolvedPath, serialization.content, 'utf8');
    await context.emit('artifacts.file.written', this.manifest.id, {
      path: evaluation.resolvedPath,
      type: artifactType,
      bytes: Buffer.byteLength(serialization.content, 'utf8'),
    });

    return {
      ok: true,
      summary: `Saved ${artifactType} artifact to ${evaluation.resolvedPath}.`,
      output: {
        type: artifactType,
        path: evaluation.resolvedPath,
        fileUrl: pathToFileURL(evaluation.resolvedPath).href,
        bytes: Buffer.byteLength(serialization.content, 'utf8'),
      },
    };
  }

  private async listArtifacts(input: unknown): Promise<MonarchExecutionResult> {
    const limit = Math.max(1, Math.min(Math.floor(readNumberInput(input, 'limit', 25)), 200));
    const entries = await readdir(this.artifactsRoot, { recursive: true, withFileTypes: true }).catch(() => []);
    const files = [];

    for (const entry of entries) {
      if (!entry.isFile() || files.length >= limit) {
        continue;
      }
      const parentPath = 'parentPath' in entry && typeof entry.parentPath === 'string'
        ? entry.parentPath
        : this.artifactsRoot;
      const filePath = path.join(parentPath, entry.name);
      const fileStat = await stat(filePath).catch(() => undefined);
      files.push({
        path: filePath,
        name: path.relative(this.artifactsRoot, filePath),
        sizeBytes: fileStat?.size || 0,
      });
    }

    return {
      ok: true,
      summary: `Listed ${files.length} artifacts.`,
      output: {
        root: this.artifactsRoot,
        files,
      },
    };
  }
}

function normalizeArtifactType(type: string): ArtifactType | '' {
  const normalized = type.trim().toLowerCase();
  if (normalized === 'markdown') {
    return 'md';
  }
  if (normalized === 'text' || normalized === 'plain') {
    return 'txt';
  }
  return normalized === 'html' || normalized === 'md' || normalized === 'txt' || normalized === 'json'
    ? normalized
    : '';
}

function inferArtifactType(text: string): ArtifactType {
  if (/html/i.test(text)) {
    return 'html';
  }
  if (/json/i.test(text)) {
    return 'json';
  }
  if (/markdown|\.md|md/i.test(text)) {
    return 'md';
  }
  return 'txt';
}

function serializeArtifact(
  artifactType: ArtifactType,
  content: unknown
): { ok: true; content: string } | { ok: false; error: string } {
  if (artifactType === 'json') {
    try {
      if (typeof content === 'string') {
        return { ok: true, content: JSON.stringify(JSON.parse(content), null, 2) };
      }
      return { ok: true, content: JSON.stringify(content, null, 2) };
    } catch (error) {
      return {
        ok: false,
        error: `JSON artifact is invalid: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const text = String(content || '');
  if (!text.trim()) {
    return {
      ok: false,
      error: 'Artifact content is empty.',
    };
  }
  if (artifactType === 'html' && !/<[a-z][\w:-]*(?:\s[^>]*)?>/i.test(text)) {
    return {
      ok: false,
      error: 'HTML artifact must contain at least one HTML tag.',
    };
  }

  return { ok: true, content: text };
}

function resolveArtifactTarget(options: {
  root: string;
  requestedPath: string;
  fileName: string;
  artifactType: ArtifactType;
}): string {
  const extension = extensionForType(options.artifactType);
  const baseName = safeBaseName(options.fileName || `artifact-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const requested = options.requestedPath.trim();

  if (!requested) {
    return path.join(options.root, options.artifactType, `${baseName}${extension}`);
  }

  const resolved = path.resolve(path.isAbsolute(requested) ? requested : path.join(options.root, requested));
  return path.extname(resolved) ? resolved : `${resolved}${extension}`;
}

function extensionForType(type: ArtifactType): string {
  switch (type) {
  case 'html':
    return '.html';
  case 'md':
    return '.md';
  case 'json':
    return '.json';
  case 'txt':
    return '.txt';
  }
}

function safeBaseName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'artifact';
}

function readContentInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return '';
  }
  return (input as Record<string, unknown>).content;
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readNumberInput(input: unknown, key: string, fallback: number): number {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBooleanInput(input: unknown, key: string, fallback: boolean): boolean {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function createArtifactsModule(options: ArtifactsModuleOptions = {}): MonarchModule {
  return new ArtifactsModule(options);
}

export const artifactsModulePackage: MonarchModulePackage = {
  id: artifactsManifest.id,
  moduleId: artifactsManifest.id,
  version: artifactsManifest.version,
  description: artifactsManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createArtifactsModule,
};

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import { evaluateFilesystemAccess, isPathWithinRoot, permissionModeForRisk } from '../../core';
import { applyStudioEdit, stepStudioHistory } from './editor';
import { studioManifest } from './manifest';
import {
  createStudioProject,
  safeProjectFileName,
  validateStudioProject,
  type StudioProjectV1,
} from './project';

export interface StudioModuleOptions {
  workspaceRoot?: string;
  projectsRoot?: string;
  exportsRoot?: string;
}

export class StudioModule implements MonarchModule {
  readonly manifest = studioManifest;
  private readonly workspaceRoot: string;
  private readonly projectsRoot: string;
  private readonly exportsRoot: string;

  constructor(options: StudioModuleOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.projectsRoot = path.resolve(
      options.projectsRoot || path.join(this.workspaceRoot, 'artifacts', 'studio', 'projects')
    );
    this.exportsRoot = path.resolve(
      options.exportsRoot || path.join(this.workspaceRoot, 'artifacts', 'studio', 'exports')
    );
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('studio.activated', this.manifest.id, {
      projectsRoot: this.projectsRoot,
      exportsRoot: this.exportsRoot,
      projectFormat: 1,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: 'Monarch Studio project core is ready.',
      output: {
        projectsRoot: this.projectsRoot,
        exportsRoot: this.exportsRoot,
        projectFormat: 'monarch-studio@1',
        editorRuntime: 'fabric-export-mediabunny-probe-guided-ui-ready',
      },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.toLowerCase();
    if (!/(monarch studio|photo editor|video editor|фоторедактор|видеоредактор|редактор (?:фото|видео))/i.test(text)) {
      return null;
    }
    const mode = /video|видео/i.test(text) ? 'video' : 'photo';
    if (/(create|new|start|созда(?:й|ть)|нов(?:ый|ого)|начать)/i.test(text)) {
      return {
        intentId: intent.id,
        targetModuleId: this.manifest.id,
        capabilityId: 'studio.project.create',
        confidence: 0.88,
        reason: `User asks to create a ${mode} project in Monarch Studio.`,
        permissionMode: permissionModeForRisk('write'),
        input: { name: mode === 'video' ? 'Новый видеопроект' : 'Новый фотопроект', mode },
      };
    }
    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId: 'studio.features.list',
      confidence: 0.9,
      reason: 'User asks about Monarch Studio.',
      permissionMode: 'allow',
      input: {},
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'studio.features.list':
      return listStudioFeatures();
    case 'studio.project.open':
      return this.openProject(request.input, context);
    case 'studio.project.create':
      return this.createProject(request.input, context);
    case 'studio.project.validate':
      return validateProjectInput(request.input);
    case 'studio.edit.apply':
      return this.applyEdit(request.input, context);
    case 'studio.history.step':
      return stepHistoryInput(request.input);
    case 'studio.project.save':
      return this.saveProject(request.input, context);
    case 'studio.media.probe':
      return this.probeMedia(request.input, context);
    case 'studio.photo.export':
      return this.exportPhoto(request.input, context);
    case 'studio.export.plan':
      return planExport(request.input);
    default:
      return {
        ok: false,
        summary: `Unsupported Studio capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private async createProject(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const project = createStudioProject(input);
    if (!project) {
      return {
        ok: false,
        summary: 'Studio project requires a name and mode: photo or video.',
        error: 'invalid-studio-project-input',
      };
    }
    const validation = validateStudioProject(project);
    if (!validation.ok) {
      return {
        ok: false,
        summary: `Studio project failed validation: ${validation.errors.join('; ')}`,
        error: 'invalid-studio-project',
        output: validation,
      };
    }

    const target = path.join(this.projectsRoot, safeProjectFileName(project));
    const evaluation = evaluateFilesystemAccess(target, 'create', {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.projectsRoot,
    });
    if (!evaluation.allowed) {
      return {
        ok: false,
        summary: evaluation.message,
        error: 'filesystem-policy-blocked',
        metadata: { evaluation },
      };
    }

    await mkdir(this.projectsRoot, { recursive: true });
    await writeFile(target, `${JSON.stringify(project, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await context.emit('studio.project.created', this.manifest.id, {
      projectId: project.id,
      mode: project.mode,
      path: target,
    });
    return {
      ok: true,
      summary: `Created ${project.mode} project ${project.name}.`,
      output: { path: target, project },
    };
  }

  private async openProject(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const requestedPath = isRecord(input) ? readString(input.path) : '';
    const target = path.resolve(requestedPath || this.projectsRoot);
    if (
      !requestedPath
      || !target.toLowerCase().endsWith('.monarch-studio.json')
      || !isPathWithinRoot(target, this.projectsRoot, { allowRoot: false })
      || !samePath(path.dirname(target), this.projectsRoot)
    ) {
      return {
        ok: false,
        summary: 'Studio can only open .monarch-studio.json files inside the Studio projects root.',
        error: 'studio-project-path-blocked',
      };
    }
    const evaluation = evaluateFilesystemAccess(target, 'read', {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.projectsRoot,
    });
    if (!evaluation.allowed) {
      return {
        ok: false,
        summary: evaluation.message,
        error: 'filesystem-policy-blocked',
        metadata: { evaluation },
      };
    }

    try {
      const [realRoot, realTarget] = await Promise.all([
        realpath(this.projectsRoot),
        realpath(target),
      ]);
      if (!isPathWithinRoot(realTarget, realRoot, { allowRoot: false })) {
        return {
          ok: false,
          summary: 'Studio project path resolves outside the Studio projects root.',
          error: 'studio-project-path-blocked',
        };
      }
      const fileStat = await stat(target);
      if (!fileStat.isFile() || fileStat.size > 25 * 1024 * 1024) {
        return {
          ok: false,
          summary: 'Studio project must be a file no larger than 25 MB.',
          error: 'studio-project-size-blocked',
        };
      }
      const project = JSON.parse(await readFile(target, 'utf8')) as unknown;
      const validation = validateStudioProject(project);
      if (!validation.ok) {
        return {
          ok: false,
          summary: `Studio project failed validation: ${validation.errors.join('; ')}`,
          error: 'invalid-studio-project',
          output: validation,
        };
      }
      await context.emit('studio.project.opened', this.manifest.id, {
        projectId: (project as StudioProjectV1).id,
        path: target,
      });
      return {
        ok: true,
        summary: `Opened Studio project ${(project as StudioProjectV1).name}.`,
        output: { path: target, project, warnings: validation.warnings },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Studio project could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        error: 'studio-project-open-failed',
      };
    }
  }

  private async applyEdit(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    if (!isRecord(input) || !isRecord(input.project)) {
      return {
        ok: false,
        summary: 'Studio edit requires project and edit objects.',
        error: 'invalid-studio-edit-input',
      };
    }
    const result = applyStudioEdit(input.project as unknown as StudioProjectV1, input.edit);
    if (!result.ok) {
      return {
        ok: false,
        summary: result.summary,
        error: result.error,
        output: { project: result.project },
      };
    }
    await context.emit('studio.edit.applied', this.manifest.id, {
      projectId: result.project.id,
      historyCursor: result.project.history.cursor,
      summary: result.summary,
    });
    return {
      ok: true,
      summary: result.summary,
      output: {
        project: result.project,
        warnings: result.warnings,
      },
    };
  }

  private async saveProject(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    if (!isRecord(input) || !isRecord(input.project)) {
      return {
        ok: false,
        summary: 'Studio save requires a project object.',
        error: 'invalid-studio-project-input',
      };
    }
    const project = input.project as unknown as StudioProjectV1;
    const validation = validateStudioProject(project);
    if (!validation.ok) {
      return {
        ok: false,
        summary: `Studio project failed validation: ${validation.errors.join('; ')}`,
        error: 'invalid-studio-project',
        output: validation,
      };
    }
    const requestedPath = readString(input.path);
    const target = requestedPath
      ? path.resolve(requestedPath)
      : path.join(this.projectsRoot, safeProjectFileName(project));
    if (
      !target.toLowerCase().endsWith('.monarch-studio.json')
      || !isPathWithinRoot(target, this.projectsRoot, { allowRoot: false })
      || !samePath(path.dirname(target), this.projectsRoot)
    ) {
      return {
        ok: false,
        summary: 'Studio projects can only be saved as .monarch-studio.json inside the Studio projects root.',
        error: 'studio-project-path-blocked',
      };
    }
    const evaluation = evaluateFilesystemAccess(target, 'write', {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.projectsRoot,
    });
    if (!evaluation.allowed) {
      return {
        ok: false,
        summary: evaluation.message,
        error: 'filesystem-policy-blocked',
        metadata: { evaluation },
      };
    }

    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      const [realRoot, realParent] = await Promise.all([
        realpath(this.projectsRoot),
        realpath(path.dirname(target)),
      ]);
      if (!isPathWithinRoot(realParent, realRoot, { allowRoot: true })) {
        return {
          ok: false,
          summary: 'Studio project path resolves outside the Studio projects root.',
          error: 'studio-project-path-blocked',
        };
      }
      await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return {
        ok: false,
        summary: `Studio project could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        error: 'studio-project-save-failed',
      };
    }
    await context.emit('studio.project.saved', this.manifest.id, {
      projectId: project.id,
      path: target,
      historyCursor: project.history.cursor,
    });
    return {
      ok: true,
      summary: `Saved Studio project ${project.name}.`,
      output: { path: target, project, warnings: validation.warnings },
    };
  }

  private async probeMedia(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const requestedPath = isRecord(input) ? readString(input.path) : '';
    if (!requestedPath) {
      return {
        ok: false,
        summary: 'Studio media probe requires a local file path.',
        error: 'invalid-studio-media-path',
      };
    }
    try {
      const file = await this.resolveReadableWorkspaceFile(requestedPath, 20 * 1024 * 1024 * 1024);
      const { probeStudioMedia } = await import('./media-probe');
      const probe = await probeStudioMedia(file.path);
      await context.emit('studio.media.probed', this.manifest.id, {
        path: file.path,
        sizeBytes: file.sizeBytes,
        mimeType: probe.mimeType,
      });
      return {
        ok: true,
        summary: `Inspected ${path.basename(file.path)} with Mediabunny.`,
        output: { path: file.path, sizeBytes: file.sizeBytes, ...probe },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Studio could not inspect this media file: ${errorMessage(error)}`,
        error: 'studio-media-probe-failed',
      };
    }
  }

  private async exportPhoto(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    if (!isRecord(input) || !isRecord(input.project)) {
      return {
        ok: false,
        summary: 'Studio photo export requires a project object.',
        error: 'invalid-studio-project-input',
      };
    }
    const project = input.project as unknown as StudioProjectV1;
    const validation = validateStudioProject(project);
    if (!validation.ok || project.mode !== 'photo') {
      return {
        ok: false,
        summary: project.mode !== 'photo'
          ? 'Studio photo export requires a photo project.'
          : `Studio project failed validation: ${validation.errors.join('; ')}`,
        error: 'invalid-studio-photo-project',
        output: validation,
      };
    }
    const requestedFormat = readString(input.format).toLowerCase() || project.export.format;
    if (requestedFormat !== 'png' && requestedFormat !== 'jpeg') {
      return {
        ok: false,
        summary: 'Server photo export currently supports PNG and JPEG. WebP stays on the browser fast path.',
        error: 'unsupported-studio-photo-export-format',
      };
    }
    const filename = safePhotoExportFileName(project, readString(input.filename), requestedFormat);
    if (!filename) {
      return {
        ok: false,
        summary: 'Studio export filename must be a simple PNG or JPEG filename.',
        error: 'invalid-studio-export-filename',
      };
    }
    const target = path.join(this.exportsRoot, filename);
    const evaluation = evaluateFilesystemAccess(target, 'create', {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.exportsRoot,
    });
    if (!evaluation.allowed) {
      return {
        ok: false,
        summary: evaluation.message,
        error: 'filesystem-policy-blocked',
        metadata: { evaluation },
      };
    }

    try {
      const { renderStudioPhoto } = await import('./photo-renderer');
      const rendered = await renderStudioPhoto(project, {
        format: requestedFormat,
        ...(typeof input.quality === 'number' ? { quality: input.quality } : {}),
        resolveSource: (source) => this.resolveImageDataUrl(source),
      });
      await mkdir(this.exportsRoot, { recursive: true });
      await writeFile(target, rendered.buffer, { flag: 'wx' });
      await context.emit('studio.photo.exported', this.manifest.id, {
        projectId: project.id,
        path: target,
        mimeType: rendered.mimeType,
        sizeBytes: rendered.buffer.byteLength,
      });
      return {
        ok: true,
        summary: `Exported ${project.name} as ${requestedFormat.toUpperCase()}.`,
        output: {
          path: target,
          format: requestedFormat,
          mimeType: rendered.mimeType,
          width: rendered.width,
          height: rendered.height,
          sizeBytes: rendered.buffer.byteLength,
          warnings: rendered.warnings,
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: `Studio photo export failed: ${errorMessage(error)}`,
        error: 'studio-photo-export-failed',
      };
    }
  }

  private async resolveReadableWorkspaceFile(
    requestedPath: string,
    maximumBytes: number
  ): Promise<{ path: string; sizeBytes: number }> {
    const target = path.resolve(this.workspaceRoot, requestedPath);
    const evaluation = evaluateFilesystemAccess(target, 'read', {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.workspaceRoot,
    });
    if (!evaluation.allowed) {
      throw new Error(evaluation.message);
    }
    const [realWorkspaceRoot, realTarget] = await Promise.all([
      realpath(this.workspaceRoot),
      realpath(target),
    ]);
    if (!isPathWithinRoot(realTarget, realWorkspaceRoot, { allowRoot: false })) {
      throw new Error('Media path resolves outside the Monarch workspace.');
    }
    const fileStat = await stat(realTarget);
    if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > maximumBytes) {
      throw new Error(`Media file must be between 1 byte and ${maximumBytes} bytes.`);
    }
    return { path: realTarget, sizeBytes: fileStat.size };
  }

  private async resolveImageDataUrl(source: string): Promise<string> {
    if (source.startsWith('data:image/')) {
      if (Buffer.byteLength(source, 'utf8') > 50 * 1024 * 1024) {
        throw new Error('Embedded image source exceeds 50 MB.');
      }
      return source;
    }
    if (/^https?:/i.test(source)) {
      throw new Error('Remote image URLs are blocked during local Studio export.');
    }
    const requestedPath = source.startsWith('file:') ? fileURLToPath(source) : source;
    const file = await this.resolveReadableWorkspaceFile(requestedPath, 50 * 1024 * 1024);
    const mimeType = imageMimeTypeForPath(file.path);
    if (!mimeType) {
      throw new Error('Studio image source must be PNG, JPEG, WebP, or GIF.');
    }
    return `data:${mimeType};base64,${(await readFile(file.path)).toString('base64')}`;
  }
}

function listStudioFeatures(): MonarchExecutionResult {
  return {
    ok: true,
    summary: 'Monarch Studio feature contract is available.',
    output: {
      availableCore: [
        'versioned local photo and video projects',
        'project validation',
        'bounded non-destructive undo and redo history',
        'typed photo operations and video timeline operations',
        'atomic project save inside the Studio root',
        'license-aware export planning',
        'Fabric.js-backed PNG and JPEG rendering',
        'Mediabunny-backed local media metadata probing',
      ],
      photoCore: [
        'crop, rotate, flip, resize',
        'exposure, contrast, color, filters',
        'text, drawing, shapes, layers',
        'selection, duplicate, lock, blend modes, and layer ordering',
      ],
      videoCore: [
        'video, audio, and text tracks',
        'add, move, update, split, remove, and reorder',
        'volume, fades, opacity, playback speed, and playhead',
      ],
      rendererReady: [
        'Fabric.js server renderer for PNG and JPEG export',
        'Mediabunny metadata probe for local video and audio',
      ],
      rendererNext: [
        'interactive Fabric.js browser canvas and WebP fast path',
        'Mediabunny/WebCodecs thumbnails and compatible remux fast path',
        'multi-clip browser timeline, MP4 export, and cancellation',
      ],
      optionalLater: [
        'local background removal through Transformers.js',
        'masks, healing, blend modes, histogram',
        'template-driven Remotion adapter after explicit license approval',
      ],
    },
  };
}

function validateProjectInput(input: unknown): MonarchExecutionResult {
  const project = isRecord(input) ? input.project : undefined;
  const validation = validateStudioProject(project);
  return validation.ok
    ? {
      ok: true,
      summary: 'Studio project is valid.',
      output: validation,
    }
    : {
      ok: false,
      summary: `Studio project has ${validation.errors.length} validation errors.`,
      output: validation,
      error: 'invalid-studio-project',
    };
}

function stepHistoryInput(input: unknown): MonarchExecutionResult {
  if (!isRecord(input) || !isRecord(input.project)) {
    return {
      ok: false,
      summary: 'Studio history requires a project object and direction.',
      error: 'invalid-studio-history-input',
    };
  }
  const direction = input.direction === 'undo' || input.direction === 'redo'
    ? input.direction
    : '';
  if (!direction) {
    return {
      ok: false,
      summary: 'Studio history direction must be undo or redo.',
      error: 'invalid-studio-history-direction',
    };
  }
  const result = stepStudioHistory(input.project as unknown as StudioProjectV1, direction);
  return result.ok
    ? {
      ok: true,
      summary: result.summary,
      output: { project: result.project, warnings: result.warnings },
    }
    : {
      ok: false,
      summary: result.summary,
      error: result.error,
      output: { project: result.project },
    };
}

function planExport(input: unknown): MonarchExecutionResult {
  const source = isRecord(input) ? input : {};
  const mode = source.mode === 'photo' || source.mode === 'video' ? source.mode : '';
  const format = typeof source.format === 'string' ? source.format.trim().toLowerCase() : '';
  if (!mode || !format) {
    return {
      ok: false,
      summary: 'Export planning requires mode and format.',
      error: 'invalid-export-plan-input',
    };
  }

  if (mode === 'photo') {
    const supported = ['png', 'jpeg', 'jpg', 'webp'].includes(format);
    return supported
      ? {
        ok: true,
        summary: `Photo export ${format} can run locally in the renderer.`,
        output: {
        engine: 'browser-canvas',
        rendererStatus: 'dependency-not-installed',
        optionalFallback: 'sharp-worker',
        localOnly: true,
        licenseReviewRequired: false,
        },
      }
      : {
        ok: false,
        summary: `Photo export format is not supported: ${format}`,
        error: 'unsupported-export-format',
      };
  }

  const supported = ['mp4', 'webm', 'gif'].includes(format);
  const templateDriven = source.templateDriven === true;
  return supported
    ? {
      ok: true,
      summary: `Video export ${format} planned with a local pipeline.`,
      output: {
      preview: 'native-video-element',
      fastPath: 'mediabunny-webcodecs',
      compatibilityFallback: 'user-provided-ffmpeg',
      rendererStatus: 'dependency-not-installed',
      templateAdapter: templateDriven ? 'remotion-optional-license-required' : 'disabled',
      localOnly: true,
      licenseReviewRequired: templateDriven,
      },
    }
    : {
      ok: false,
      summary: `Video export format is not supported: ${format}`,
      error: 'unsupported-export-format',
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function safePhotoExportFileName(
  project: StudioProjectV1,
  requestedFilename: string,
  format: 'png' | 'jpeg'
): string {
  const extension = format === 'jpeg' ? '.jpg' : '.png';
  if (!requestedFilename) {
    const base = project.name
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'studio-export';
    return `${base}-${project.id.slice(0, 8)}${extension}`;
  }
  if (path.basename(requestedFilename) !== requestedFilename) return '';
  const lowered = requestedFilename.toLowerCase();
  const allowed = format === 'jpeg'
    ? lowered.endsWith('.jpg') || lowered.endsWith('.jpeg')
    : lowered.endsWith('.png');
  return allowed && /^[\p{L}\p{N} ._()-]{1,120}$/u.test(requestedFilename)
    ? requestedFilename
    : '';
}

function imageMimeTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
  case '.png': return 'image/png';
  case '.jpg':
  case '.jpeg': return 'image/jpeg';
  case '.webp': return 'image/webp';
  case '.gif': return 'image/gif';
  default: return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createStudioModule(options: StudioModuleOptions = {}): MonarchModule {
  return new StudioModule(options);
}

export const studioModulePackage: MonarchModulePackage = {
  id: studioManifest.id,
  moduleId: studioManifest.id,
  version: studioManifest.version,
  description: studioManifest.description,
  core: { minVersion: '0.1.0' },
  factory: createStudioModule,
};

export * from './editor';
export * from './photo-document';
export * from './project';
export * from './video-timeline';

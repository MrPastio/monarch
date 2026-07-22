import { appendFile, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type {
  MonarchExecutionRequest,
  MonarchExecutionControl,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
  MonarchRouteDecision,
} from '../../core';
import {
  buildWorkspaceFileArguments,
  defaultLocalReadOnlyRoots,
  evaluateFilesystemAccess,
  extractWorkspaceObjectName,
  permissionModeForRisk,
  resolveKnownUserFolder,
  readOperationalContext,
  type MonarchFilesystemOperation,
  type MonarchFilesystemPolicyOptions,
} from '../../core';
import { workspaceManifest } from './manifest';

const DEFAULT_READ_BYTES = 128 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_COPY_ENTRIES = 2_000;

export interface WorkspaceModuleOptions {
  workspaceRoot?: string;
}

interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
}

type WorkspaceTraversalPolicyGuard = (
  candidatePath: string,
  requiresRealPathCheck?: boolean
) => Promise<MonarchExecutionResult | null>;

class WorkspaceTraversalPolicyError extends Error {
  readonly result: MonarchExecutionResult;

  constructor(result: MonarchExecutionResult) {
    super(result.summary);
    this.name = 'WorkspaceTraversalPolicyError';
    this.result = result;
  }
}

export class WorkspaceModule implements MonarchModule {
  readonly manifest = workspaceManifest;
  private readonly workspaceRoot: string;

  constructor(options: WorkspaceModuleOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit('workspace.activated', this.manifest.id, {
      workspaceRoot: this.workspaceRoot,
    });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: `Workspace file module ready at ${this.workspaceRoot}.`,
      output: { workspaceRoot: this.workspaceRoot },
    };
  }

  async handleIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const text = intent.text.trim();
    const lower = text.toLowerCase();
    const explicitCapability = parseExplicitWorkspaceCapability(text);
    if (explicitCapability) {
      return this.route(intent, explicitCapability.capabilityId, 1, explicitCapability.input);
    }
    const operationalContext = readOperationalContext(intent.context);
    const pendingAction = operationalContext?.pendingAction;
    if (
      pendingAction?.capabilityId === 'workspace.files.write'
      && pendingAction.missingInput.includes('content')
      && !/(?:создай|создать|сделай|запиши|сохрани|удали|найди|create|write|save|delete|find)/i.test(text)
    ) {
      return this.route(intent, 'workspace.files.write', 0.99, {
        ...pendingAction.input,
        content: text,
      });
    }
    if (isWorkspaceRootRequest(lower)) {
      return this.route(intent, 'workspace.root.get', 1, {});
    }

    const standalonePath = extractStandalonePath(text);
    if (standalonePath) {
      const capabilityId = looksLikeTextFilePath(standalonePath)
        ? 'workspace.files.read'
        : 'workspace.files.list';
      return this.route(intent, capabilityId, 0.99, { path: standalonePath });
    }

    const detectedPath = extractPath(text) || extractKnownLocation(text);
    const fileArguments = buildWorkspaceFileArguments(text);
    const contextualDirectory = /(?:в\s+этой\s+папке|in\s+this\s+(?:folder|directory))/i.test(text)
      ? operationalContext?.lastDirectoryPath || ''
      : '';
    const contextualFilePath = contextualDirectory
      ? path.join(contextualDirectory, fileArguments.path || (/текстов[а-яё]*\s+(?:файл|документ)|text\s+file/i.test(text) ? 'note.txt' : ''))
      : '';
    if (isOpenEndedBuildRequest(text)) {
      return null;
    }

    if (/(delete|remove|удали|сотри|стереть).{0,20}(?:file|файл)/i.test(lower) || /^(удали|сотри|стереть) файл/i.test(lower)) {
      return this.route(intent, 'workspace.files.delete', 0.96, { path: extractPath(text) });
    }
    if (/(?:mkdir|create).{0,24}(?:folder|directory)|(?:создай|создать|сделай|сделать).{0,24}(?:папку|директорию)/i.test(lower)) {
      return this.route(intent, 'workspace.files.mkdir', 0.96, extractDirectoryInput(text));
    }
    if (/(?:append|add).{0,24}(?:file)|(?:допиши|добавь).{0,24}(?:файл)/i.test(lower)) {
      return this.route(intent, 'workspace.files.append', 0.95, {
        path: extractPath(text),
        content: extractFileContent(text),
      });
    }
    if (/(?:copy|duplicate|скопируй|дублируй).{0,28}(?:file|folder|directory|файл|папк|директор)/i.test(lower)) {
      return this.route(intent, 'workspace.files.copy', 0.95, extractTransferInput(text));
    }
    if (/(?:move|rename|перемести|переименуй).{0,28}(?:file|folder|directory|файл|папк|директор)/i.test(lower)) {
      return this.route(intent, 'workspace.files.move', 0.95, extractTransferInput(text));
    }
    if (/(replace|замени|заменить).{0,48}(?:file|файл|файле)/i.test(lower) || /^(замени|заменить) в файле/i.test(lower)) {
      const replaceInput = extractReplaceInput(text);
      return this.route(intent, 'workspace.files.replace', 0.94, replaceInput);
    }
    if (/(write|create|save|overwrite|replace|запиши|записать|создай|создать|сделай|сохранить|сохрани|перезапиши|замени).{0,40}(?:file|файл|документ)/i.test(lower) || /^(запиши|создай|сделай|сохрани|перезапиши|замени) файл/i.test(lower) || (fileArguments.path && fileArguments.content !== '')) {
      return this.route(intent, 'workspace.files.write', 0.93, {
        path: contextualFilePath || fileArguments.path || extractPath(text),
        ...((fileArguments.content || extractFileContent(text)) !== ''
          ? { content: fileArguments.content || extractFileContent(text) }
          : {}),
        overwrite: fileArguments.overwrite,
      });
    }
    if (
      /(search|find|grep|найди|поиск|ищи).{0,20}(?:files?|файлах?|project|проекте?)/i.test(lower)
      || /^(найди|поиск|ищи) в файлах/i.test(lower)
      || /^(найди|поиск|ищи)\s+.+\s+в\s+проекте/i.test(lower)
    ) {
      return this.route(intent, 'workspace.files.search', 0.94, {
        query: extractSearchQuery(text),
        path: extractPath(text) || '.',
      });
    }
    if (isWorkspaceListRequest(lower) || (detectedPath && /^(?:что\s+(?:лежит|находится)|что\s+внутри)/i.test(lower))) {
      const entryType = detectRequestedEntryType(lower);
      const extension = detectRequestedExtension(lower);
      return this.route(intent, 'workspace.files.list', 0.96, {
        path: detectedPath || '.',
        recursive: /recursive|recursively|рекурсив|во\s+всех\s+подпапк|вложенн/i.test(lower),
        limit: 100,
        ...(entryType ? { entryType } : {}),
        ...(extension ? { extension } : {}),
      });
    }
    const readPath = detectedPath;
    if (
      /(read|show|open|прочитай|прочитать|открой|содержимое).{0,20}(?:file|файл)/i.test(lower)
      || /^(прочитай|прочитать|открой|покажи) файл/i.test(lower)
      || (readPath && /(?:^|\s)(?:read|show|open|прочитай|прочитать|открой|покажи)\s+/i.test(lower))
    ) {
      return this.route(intent, 'workspace.files.read', 0.96, { path: readPath });
    }

    return null;
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    control: MonarchExecutionControl = {},
  ): Promise<MonarchExecutionResult> {
    switch (request.capabilityId) {
    case 'workspace.root.get':
      return this.workspaceRootCapability();
    case 'workspace.files.read':
      return this.readFileCapability(request.input, context);
    case 'workspace.files.list':
      return this.listFiles(request.input, context);
    case 'workspace.files.search':
      return this.searchFiles(request.input, context);
    case 'workspace.files.write':
      return this.writeFileCapability(request.input, context, control.signal);
    case 'workspace.files.append':
      return this.appendFileCapability(request.input, context);
    case 'workspace.files.mkdir':
      return this.makeDirectoryCapability(request.input, context);
    case 'workspace.files.copy':
      return this.copyPathCapability(request.input, context);
    case 'workspace.files.move':
      return this.movePathCapability(request.input, context);
    case 'workspace.files.replace':
      return this.replaceFileTextCapability(request.input, context);
    case 'workspace.files.delete':
      return this.deleteFileCapability(request.input, context);
    default:
      return {
        ok: false,
        summary: `Unsupported workspace capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    }
  }

  private workspaceRootCapability(): MonarchExecutionResult {
    return {
      ok: true,
      summary: `Точный путь рабочего пространства Monarch: ${this.workspaceRoot}`,
      output: { workspaceRoot: this.workspaceRoot },
    };
  }

  private route(
    intent: MonarchIntent,
    capabilityId: string,
    confidence: number,
    input: Record<string, unknown>
  ): MonarchRouteDecision {
    const capability = this.manifest.capabilities.find((entry) => entry.id === capabilityId);
    return {
      intentId: intent.id,
      targetModuleId: this.manifest.id,
      capabilityId,
      confidence,
      reason: 'Workspace file operation detected.',
      permissionMode: permissionModeForRisk(capability?.risk),
      input,
    };
  }

  private async readFileCapability(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const evaluation = this.evaluate(readStringInput(input, 'path'), 'read', context);
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'read', context);
    if (realPathBlock) {
      return realPathBlock;
    }

    const fileStat = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      return {
        ok: false,
        summary: `Not a readable file: ${evaluation.resolvedPath}`,
        error: 'not-a-file',
        metadata: { evaluation },
      };
    }

    const maxBytes = normalizeLimit(readNumberInput(input, 'maxBytes', DEFAULT_READ_BYTES), 1, MAX_READ_BYTES);
    if (fileStat.size > maxBytes) {
      return {
        ok: false,
        summary: `File is too large to read safely (${fileStat.size} bytes, limit ${maxBytes}).`,
        error: 'file-too-large',
        metadata: { evaluation, sizeBytes: fileStat.size, maxBytes },
      };
    }

    const content = await readFile(evaluation.resolvedPath, 'utf8');
    return {
      ok: true,
      summary: `Read file ${evaluation.resolvedPath}.`,
      output: {
        path: evaluation.resolvedPath,
        sizeBytes: fileStat.size,
        content,
      },
    };
  }

  private async listFiles(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const evaluation = this.evaluate(readStringInput(input, 'path') || '.', 'list', context, { allowRoot: true });
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'list', context);
    if (realPathBlock) {
      return realPathBlock;
    }
    const rootStat = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (!rootStat) {
      return {
        ok: false,
        summary: `List root does not exist: ${evaluation.resolvedPath}`,
        error: 'not-found',
        metadata: { evaluation },
      };
    }

    const recursive = readBooleanInput(input, 'recursive', false);
    const limit = normalizeLimit(readNumberInput(input, 'limit', 100), 1, 500);
    const entryType = normalizeEntryType(readStringInput(input, 'entryType'));
    const extension = normalizeExtension(readStringInput(input, 'extension'));
    const entries = await collectFileEntries(evaluation.resolvedPath, {
      root: evaluation.resolvedPath,
      rootStat,
      recursive,
      limit,
      policyGuard: this.createTraversalPolicyGuard('list', context),
      ...(entryType ? { entryType } : {}),
      ...(extension ? { extension } : {}),
    });

    return {
      ok: true,
      summary: `Listed ${entries.length} workspace entries.`,
      output: {
        root: evaluation.resolvedPath,
        entries,
      },
    };
  }

  private async searchFiles(input: unknown, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const query = readStringInput(input, 'query');
    if (!query) {
      return {
        ok: false,
        summary: 'Search query is empty.',
        error: 'empty-query',
      };
    }

    const evaluation = this.evaluate(readStringInput(input, 'path') || '.', 'search', context, { allowRoot: true });
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'search', context);
    if (realPathBlock) {
      return realPathBlock;
    }
    const rootStat = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (!rootStat) {
      return {
        ok: false,
        summary: `Search root does not exist: ${evaluation.resolvedPath}`,
        error: 'not-found',
        metadata: { evaluation },
      };
    }

    const limit = normalizeLimit(readNumberInput(input, 'limit', 25), 1, 100);
    const entries = await collectFileEntries(evaluation.resolvedPath, {
      root: evaluation.resolvedPath,
      rootStat,
      recursive: true,
      limit: 1000,
      policyGuard: this.createTraversalPolicyGuard('search', context),
    });
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const needle = query.toLowerCase();

    for (const entry of entries) {
      if (matches.length >= limit || entry.type !== 'file' || isLikelyBinary(entry.path)) {
        continue;
      }
      if ((entry.sizeBytes || 0) > MAX_SEARCH_FILE_BYTES) {
        continue;
      }

      const content = await readFile(entry.path, 'utf8').catch(() => '');
      appendTextMatches(content, needle, entry.path, limit, matches);
    }

    return {
      ok: true,
      summary: `Found ${matches.length} file matches.`,
      output: { query, root: evaluation.resolvedPath, matches },
    };
  }

  private async writeFileCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const evaluation = this.evaluate(readStringInput(input, 'path'), 'write', context);
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'write', context);
    if (realPathBlock) {
      return realPathBlock;
    }

    const content = readRawStringInput(input, 'content');
    const overwrite = readBooleanInput(input, 'overwrite', false);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      return {
        ok: false,
        summary: `File would exceed the safe write limit (${bytes} bytes, limit ${MAX_WRITE_BYTES}).`,
        error: 'file-too-large',
        metadata: { evaluation, bytes, maxBytes: MAX_WRITE_BYTES },
      };
    }
    const existing = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (existing && !overwrite) {
      return {
        ok: false,
        summary: `File already exists: ${evaluation.resolvedPath}`,
        error: 'file-exists',
        metadata: { evaluation },
      };
    }
    if (existing?.isDirectory()) {
      return {
        ok: false,
        summary: `Target is a directory: ${evaluation.resolvedPath}`,
        error: 'target-is-directory',
        metadata: { evaluation },
      };
    }

    signal?.throwIfAborted();
    await mkdir(path.dirname(evaluation.resolvedPath), { recursive: true });
    signal?.throwIfAborted();
    await writeFile(evaluation.resolvedPath, content, { encoding: 'utf8', signal });
    signal?.throwIfAborted();
    await context.emit('workspace.file.written', this.manifest.id, {
      path: evaluation.resolvedPath,
      bytes,
    });

    return {
      ok: true,
      summary: `Wrote file ${evaluation.resolvedPath}.`,
      output: {
        path: evaluation.resolvedPath,
        bytes,
      },
    };
  }

  private async replaceFileTextCapability(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const evaluation = this.evaluate(readStringInput(input, 'path'), 'write', context);
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'write', context);
    if (realPathBlock) {
      return realPathBlock;
    }

    const oldText = readRawStringInput(input, 'oldText');
    const newText = readRawStringInput(input, 'newText');
    if (!oldText) {
      return {
        ok: false,
        summary: 'Old text is required for an exact replace.',
        error: 'empty-old-text',
        metadata: { evaluation },
      };
    }

    const fileStat = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      return {
        ok: false,
        summary: `Not an editable file: ${evaluation.resolvedPath}`,
        error: 'not-a-file',
        metadata: { evaluation },
      };
    }
    if (fileStat.size > MAX_READ_BYTES) {
      return {
        ok: false,
        summary: `File is too large to edit safely (${fileStat.size} bytes, limit ${MAX_READ_BYTES}).`,
        error: 'file-too-large',
        metadata: { evaluation, sizeBytes: fileStat.size, maxBytes: MAX_READ_BYTES },
      };
    }
    if (isLikelyBinary(evaluation.resolvedPath)) {
      return {
        ok: false,
        summary: `Binary files cannot be edited through workspace replace: ${evaluation.resolvedPath}`,
        error: 'binary-file',
        metadata: { evaluation },
      };
    }

    const content = await readFile(evaluation.resolvedPath, 'utf8');
    const occurrences = countOccurrences(content, oldText);
    if (occurrences === 0) {
      return {
        ok: false,
        summary: 'Exact old text was not found.',
        error: 'old-text-not-found',
        metadata: { evaluation },
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        summary: `Old text matched ${occurrences} times; provide a more unique fragment.`,
        error: 'ambiguous-old-text',
        metadata: { evaluation, occurrences },
      };
    }

    const updated = content.replace(oldText, newText);
    const bytes = Buffer.byteLength(updated, 'utf8');
    if (bytes > MAX_WRITE_BYTES) {
      return {
        ok: false,
        summary: `Updated file would exceed the safe write limit (${bytes} bytes, limit ${MAX_WRITE_BYTES}).`,
        error: 'file-too-large',
        metadata: { evaluation, bytes, maxBytes: MAX_WRITE_BYTES },
      };
    }

    await writeFile(evaluation.resolvedPath, updated, 'utf8');
    await context.emit('workspace.file.replaced', this.manifest.id, {
      path: evaluation.resolvedPath,
      bytes,
    });

    return {
      ok: true,
      summary: `Replaced text in file ${evaluation.resolvedPath}.`,
      output: {
        path: evaluation.resolvedPath,
        bytes,
      },
    };
  }

  private async appendFileCapability(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const evaluation = this.evaluate(readStringInput(input, 'path'), 'write', context);
    if (!evaluation.allowed) return blockedResult(evaluation.message, evaluation);
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'write', context);
    if (realPathBlock) return realPathBlock;
    const content = readRawStringInput(input, 'content');
    if (!content) return { ok: false, summary: 'Append content is empty.', error: 'empty-content' };
    const existing = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (existing && !existing.isFile()) return { ok: false, summary: `Target is not a file: ${evaluation.resolvedPath}`, error: 'not-a-file' };
    const nextBytes = (existing?.size || 0) + Buffer.byteLength(content, 'utf8');
    if (nextBytes > MAX_WRITE_BYTES) return { ok: false, summary: `Appended file would exceed ${MAX_WRITE_BYTES} bytes.`, error: 'file-too-large' };
    await mkdir(path.dirname(evaluation.resolvedPath), { recursive: true });
    await appendFile(evaluation.resolvedPath, content, 'utf8');
    await context.emit('workspace.file.written', this.manifest.id, { path: evaluation.resolvedPath, append: true, bytes: nextBytes });
    return { ok: true, summary: `Appended file ${evaluation.resolvedPath}.`, output: { path: evaluation.resolvedPath, bytes: nextBytes } };
  }

  private async makeDirectoryCapability(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const evaluation = this.evaluate(readStringInput(input, 'path'), 'mkdir', context);
    if (!evaluation.allowed) return blockedResult(evaluation.message, evaluation);
    const targetPath = readBooleanInput(input, 'ensureUnique', false)
      ? await nextAvailableDirectoryPath(evaluation.resolvedPath)
      : evaluation.resolvedPath;
    const targetEvaluation = sameResolvedPath(targetPath, evaluation.resolvedPath)
      ? evaluation
      : this.evaluate(targetPath, 'mkdir', context);
    if (!targetEvaluation.allowed) return blockedResult(targetEvaluation.message, targetEvaluation);
    const realPathBlock = await this.blockIfRealPathEscapes(targetEvaluation.resolvedPath, 'mkdir', context);
    if (realPathBlock) return realPathBlock;
    const existing = await stat(targetEvaluation.resolvedPath).catch(() => undefined);
    if (existing && !existing.isDirectory()) {
      return { ok: false, summary: `Directory target already exists as a file: ${targetEvaluation.resolvedPath}`, error: 'target-exists' };
    }
    if (existing?.isDirectory()) {
      return { ok: true, summary: `Directory already exists ${targetEvaluation.resolvedPath}.`, output: { path: targetEvaluation.resolvedPath, alreadyExists: true } };
    }
    await mkdir(targetEvaluation.resolvedPath, { recursive: true });
    await context.emit('workspace.directory.created', this.manifest.id, { path: targetEvaluation.resolvedPath });
    return { ok: true, summary: `Created directory ${targetEvaluation.resolvedPath}.`, output: { path: targetEvaluation.resolvedPath } };
  }

  private async copyPathCapability(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const source = this.evaluate(readStringInput(input, 'path'), 'read', context);
    const target = this.evaluate(readStringInput(input, 'targetPath'), 'write', context);
    if (!source.allowed) return blockedResult(source.message, source);
    if (!target.allowed) return blockedResult(target.message, target);
    const sourceBlock = await this.blockIfRealPathEscapes(source.resolvedPath, 'read', context);
    if (sourceBlock) return sourceBlock;
    const targetBlock = await this.blockIfRealPathEscapes(target.resolvedPath, 'write', context);
    if (targetBlock) return targetBlock;
    if (await stat(target.resolvedPath).catch(() => undefined)) return { ok: false, summary: `Copy target already exists: ${target.resolvedPath}`, error: 'target-exists' };
    let copied: { bytes: number; entries: number };
    try {
      copied = await copyWorkspaceTree(source.resolvedPath, target.resolvedPath, {
        sourcePolicyGuard: (candidatePath) => this.blockIfRealPathEscapes(candidatePath, 'read', context),
      });
    } catch (error) {
      if (error instanceof WorkspaceTraversalPolicyError) return error.result;
      return {
        ok: false,
        summary: `Copy failed: ${errorMessage(error)}`,
        error: 'copy-failed',
      };
    }
    await context.emit('workspace.path.copied', this.manifest.id, { source: source.resolvedPath, target: target.resolvedPath, ...copied });
    return { ok: true, summary: `Copied ${source.resolvedPath} to ${target.resolvedPath}.`, output: { source: source.resolvedPath, target: target.resolvedPath, ...copied } };
  }

  private async movePathCapability(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const source = this.evaluate(readStringInput(input, 'path'), 'delete', context);
    const target = this.evaluate(readStringInput(input, 'targetPath'), 'write', context);
    if (!source.allowed) return blockedResult(source.message, source);
    if (!target.allowed) return blockedResult(target.message, target);
    const sourceBlock = await this.blockIfRealPathEscapes(source.resolvedPath, 'delete', context);
    if (sourceBlock) return sourceBlock;
    const targetBlock = await this.blockIfRealPathEscapes(target.resolvedPath, 'write', context);
    if (targetBlock) return targetBlock;
    if (!(await stat(source.resolvedPath).catch(() => undefined))) return { ok: false, summary: `Move source does not exist: ${source.resolvedPath}`, error: 'source-not-found' };
    if (await stat(target.resolvedPath).catch(() => undefined)) return { ok: false, summary: `Move target already exists: ${target.resolvedPath}`, error: 'target-exists' };
    await mkdir(path.dirname(target.resolvedPath), { recursive: true });
    await rename(source.resolvedPath, target.resolvedPath);
    await context.emit('workspace.path.moved', this.manifest.id, { source: source.resolvedPath, target: target.resolvedPath });
    return { ok: true, summary: `Moved ${source.resolvedPath} to ${target.resolvedPath}.`, output: { source: source.resolvedPath, target: target.resolvedPath } };
  }

  private async deleteFileCapability(
    input: unknown,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult> {
    const evaluation = this.evaluate(readStringInput(input, 'path'), 'delete', context);
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'delete', context);
    if (realPathBlock) {
      return realPathBlock;
    }

    const fileStat = await stat(evaluation.resolvedPath).catch(() => undefined);
    if (!fileStat) {
      return {
        ok: false,
        summary: `File does not exist: ${evaluation.resolvedPath}`,
        error: 'file-not-found',
        metadata: { evaluation },
      };
    }
    if (!fileStat.isFile()) {
      return {
        ok: false,
        summary: `Delete is limited to files: ${evaluation.resolvedPath}`,
        error: 'not-a-file',
        metadata: { evaluation },
      };
    }

    await rm(evaluation.resolvedPath, { force: false });
    await context.emit('workspace.file.deleted', this.manifest.id, {
      path: evaluation.resolvedPath,
    });

    return {
      ok: true,
      summary: `Deleted file ${evaluation.resolvedPath}.`,
      output: { path: evaluation.resolvedPath },
    };
  }

  private evaluate(
    targetPath: unknown,
    operation: MonarchFilesystemOperation,
    context: MonarchKernelContext,
    overrides: { allowRoot?: boolean } = {}
  ) {
    return evaluateFilesystemAccess(targetPath, operation, this.filesystemPolicyOptions(context, overrides));
  }

  private filesystemPolicyOptions(
    context: MonarchKernelContext,
    overrides: { allowRoot?: boolean } = {}
  ): MonarchFilesystemPolicyOptions & { fallbackRoot: string; allowRoot?: boolean } {
    const localReadOnlyRoots = defaultLocalReadOnlyRoots();
    const options: MonarchFilesystemPolicyOptions & { fallbackRoot: string; allowRoot?: boolean } = {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.workspaceRoot,
      allowedRoots: [this.workspaceRoot, ...localReadOnlyRoots],
      readOnlyRoots: localReadOnlyRoots,
      createDirectoryRoots: localReadOnlyRoots,
      allowFullDiskAccess: context.getPermissionProfile().sandboxMode === 'danger-full-access',
    };
    if (overrides.allowRoot !== undefined) {
      options.allowRoot = overrides.allowRoot;
    }
    return options;
  }

  private async blockIfRealPathEscapes(
    resolvedPath: string,
    operation: MonarchFilesystemOperation,
    context: MonarchKernelContext,
    policyOptions = this.filesystemPolicyOptions(context, { allowRoot: true })
  ): Promise<MonarchExecutionResult | null> {
    let realTarget = await realpath(resolvedPath).catch(async () => {
      const parent = await realpath(path.dirname(resolvedPath)).catch(() => path.dirname(resolvedPath));
      return path.join(parent, path.basename(resolvedPath));
    });
    realTarget = path.resolve(realTarget);
    const evaluation = evaluateFilesystemAccess(
      realTarget,
      operation,
      policyOptions
    );
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    return null;
  }

  private createTraversalPolicyGuard(
    operation: MonarchFilesystemOperation,
    context: MonarchKernelContext
  ): WorkspaceTraversalPolicyGuard {
    const policyOptions = this.filesystemPolicyOptions(context, { allowRoot: true });
    return async (candidatePath, requiresRealPathCheck = false) => {
      const evaluation = evaluateFilesystemAccess(candidatePath, operation, policyOptions);
      if (!evaluation.allowed) {
        return blockedResult(evaluation.message, evaluation);
      }
      if (!requiresRealPathCheck) {
        return null;
      }
      return this.blockIfRealPathEscapes(candidatePath, operation, context, policyOptions);
    };
  }
}

async function collectFileEntries(
  startPath: string,
  options: {
    root: string;
    rootStat: Stats;
    recursive: boolean;
    limit: number;
    entryType?: FileEntry['type'];
    extension?: string;
    policyGuard?: WorkspaceTraversalPolicyGuard;
  }
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  if (options.rootStat.isFile()) {
    if (matchesEntryFilters(startPath, 'file', options)) {
      entries.push(toFileEntry(startPath, options.root, options.rootStat.size, 'file'));
    }
    return entries;
  }
  if (!options.rootStat.isDirectory()) {
    return entries;
  }

  const queue = [startPath];
  let queueIndex = 0;

  while (queueIndex < queue.length && entries.length < options.limit) {
    const current = queue[queueIndex++];
    if (!current) continue;
    const children = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (entries.length >= options.limit) {
        break;
      }
      const childPath = path.join(current, child.name);
      const blocked = await options.policyGuard?.(
        childPath,
        child.isDirectory() || child.isSymbolicLink()
      );
      if (blocked) {
        continue;
      }
      if (child.isDirectory()) {
        if (matchesEntryFilters(childPath, 'directory', options)) {
          entries.push(toFileEntry(childPath, options.root, undefined, 'directory'));
        }
        if (options.recursive && !shouldSkipDirectory(child.name)) {
          queue.push(childPath);
        }
      } else if (child.isFile()) {
        if (matchesEntryFilters(childPath, 'file', options)) {
          const childStat = await stat(childPath).catch(() => undefined);
          entries.push(toFileEntry(childPath, options.root, childStat?.size, 'file'));
        }
      }
    }
  }

  return entries;
}

function toFileEntry(
  fullPath: string,
  root: string,
  sizeBytes: number | undefined,
  type: FileEntry['type']
): FileEntry {
  const entry: FileEntry = {
    path: fullPath,
    name: path.relative(root, fullPath) || path.basename(fullPath),
    type,
  };
  if (sizeBytes !== undefined) {
    entry.sizeBytes = sizeBytes;
  }
  return entry;
}

function shouldSkipDirectory(name: string): boolean {
  return name === 'node_modules'
    || name === '.git'
    || name === 'LLM models'
    || name.endsWith('.WebView2');
}

function appendTextMatches(
  content: string,
  needle: string,
  filePath: string,
  limit: number,
  matches: Array<{ path: string; line: number; preview: string }>
): void {
  let lineNumber = 1;
  let lineStart = 0;
  while (lineStart <= content.length && matches.length < limit) {
    const newlineIndex = content.indexOf('\n', lineStart);
    const lineEnd = newlineIndex < 0 ? content.length : newlineIndex;
    const contentEnd = lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13
      ? lineEnd - 1
      : lineEnd;
    const line = content.slice(lineStart, contentEnd);
    if (line.toLowerCase().includes(needle)) {
      matches.push({
        path: filePath,
        line: lineNumber,
        preview: line.trim().slice(0, 240),
      });
    }
    if (newlineIndex < 0) break;
    lineStart = newlineIndex + 1;
    lineNumber += 1;
  }
}

function isLikelyBinary(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|zip|7z|rar|exe|dll|bin|gguf|safetensors|sqlite3?)$/i.test(filePath);
}

function blockedResult(summary: string, evaluation: unknown): MonarchExecutionResult {
  return {
    ok: false,
    summary,
    error: 'filesystem-policy-blocked',
    metadata: { evaluation },
  };
}

function parseExplicitWorkspaceCapability(
  text: string
): { capabilityId: string; input: Record<string, unknown> } | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  if (!trimmed.startsWith('{')) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const capabilityId = readFirstString(record, ['capability', 'capabilityId', 'name']);
  const rawInput = record.parameters ?? record.arguments ?? record.input ?? {};
  if (!isRecord(rawInput) || !WORKSPACE_CAPABILITY_IDS.has(capabilityId)) return null;

  const input: Record<string, unknown> = {};
  const allowedKeys = WORKSPACE_CAPABILITY_INPUTS[capabilityId] || [];
  for (const key of allowedKeys) {
    const value = readAliasedInputValue(rawInput, key);
    if (value !== undefined) input[key] = value;
  }
  if (capabilityId === 'workspace.files.list' && typeof input.path !== 'string') input.path = '.';
  return { capabilityId, input };
}

const WORKSPACE_INPUT_ALIASES: Record<string, readonly string[]> = {
  maxBytes: ['max_bytes'],
  entryType: ['entry_type'],
  ensureUnique: ['ensure_unique'],
  targetPath: ['target_path'],
  oldText: ['old_text'],
  newText: ['new_text'],
};

const WORKSPACE_CAPABILITY_INPUTS: Record<string, readonly string[]> = {
  'workspace.root.get': [],
  'workspace.files.read': ['path', 'maxBytes'],
  'workspace.files.list': ['path', 'recursive', 'limit', 'entryType', 'extension'],
  'workspace.files.search': ['query', 'path', 'limit'],
  'workspace.files.write': ['path', 'content', 'overwrite'],
  'workspace.files.append': ['path', 'content'],
  'workspace.files.mkdir': ['path', 'ensureUnique'],
  'workspace.files.copy': ['path', 'targetPath'],
  'workspace.files.move': ['path', 'targetPath'],
  'workspace.files.replace': ['path', 'oldText', 'newText'],
  'workspace.files.delete': ['path'],
};
const WORKSPACE_CAPABILITY_IDS = new Set(Object.keys(WORKSPACE_CAPABILITY_INPUTS));

function readAliasedInputValue(record: Record<string, unknown>, key: string): unknown {
  if (record[key] !== undefined) return record[key];
  for (const alias of WORKSPACE_INPUT_ALIASES[key] || []) {
    if (record[alias] !== undefined) return record[alias];
  }
  return undefined;
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key].trim();
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function extractStandalonePath(text: string): string {
  const value = text.trim().replace(/^(?:["'`])|(?:["'`])$/g, '');
  if (!value || /[\r\n\0]/.test(value)) return '';
  return /^(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])/.test(value)
    || /^[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_. -]+)+$/.test(value)
    ? value
    : '';
}

function isWorkspaceRootRequest(text: string): boolean {
  const workspace = '(?:workspace|рабоч[^\\s]*\\s+пространств[^\\s]*|корнев[^\\s]*\\s+(?:каталог|папк|директор))';
  const location = '(?:путь|адрес|расположен[^\\s]*|находится|location|path|located)';
  return new RegExp(`(?:где|какой|укажи|покажи|назови|дай|where|what).{0,80}${location}.{0,80}${workspace}`, 'i').test(text)
    || new RegExp(`${workspace}.{0,80}${location}`, 'i').test(text);
}

function isWorkspaceListRequest(text: string): boolean {
  const action = '(?:list|show|view|inspect|browse|покажи|выведи|перечисли|посмотри|просмотри|показать|посмотреть|просмотреть)';
  const target = '(?:files?|folders?|director(?:y|ies)|файлы?|папк\\w*|директор\\w*|содержим\\w*|названи\\w*)';
  return new RegExp(`${action}.{0,80}${target}`, 'i').test(text)
    || new RegExp(`${target}.{0,48}${action}`, 'i').test(text)
    || /\b(?:folder|directory)\s+contents\b|(?:содержим|содержание)\s+(?:папк|директор)/i.test(text);
}

function detectRequestedEntryType(text: string): FileEntry['type'] | '' {
  const hasFile = /\bfiles?\b|файл/i.test(text);
  const hasDirectory = /\bfolders?\b|\bdirector(?:y|ies)\b|папк|директор/i.test(text);
  if (hasDirectory && !hasFile) return 'directory';
  if (hasFile && !hasDirectory) return 'file';
  return '';
}

function detectRequestedExtension(text: string): string {
  const dotted = text.match(/(?:^|[^\w.])\.([a-z0-9]{1,12})\b/i)?.[1];
  if (dotted) return `.${dotted.toLowerCase()}`;
  const language = text.match(/\b(java|py|js|jsx|ts|tsx|md|txt|json|yaml|yml|toml|css|html)\s+файл/i)?.[1];
  return language ? `.${language.toLowerCase()}` : '';
}

function extractKnownLocation(text: string): string {
  if (/\bdesktop\b|рабоч[^\s]*\s+стол|(?:^|\s)на\s+стол(?:е)?(?:$|[\s,.;!?])/i.test(text)) return resolveKnownUserFolder('desktop');
  if (/\bdownloads?\b|загрузк/i.test(text)) return resolveKnownUserFolder('downloads');
  return '';
}

function extractDirectoryInput(text: string): { path: string; ensureUnique?: boolean } {
  const knownLocation = extractKnownLocation(text);
  const rawExtractedPath = extractPath(text);
  const extractedPath = isGeneratedNamePlaceholder(rawExtractedPath) ? '' : rawExtractedPath;
  const directoryName = extractWorkspaceObjectName(text) || extractDirectoryName(text) || extractDescribedDirectoryName(text);
  const wantsUniqueDefault = wantsUnnamedNewDirectory(text) && !directoryName;

  if (knownLocation) {
    const relativeName = directoryName || (!looksLikePath(extractedPath) ? extractedPath : '');
    const targetName = relativeName || defaultNewDirectoryName(text);
    return {
      path: joinKnownLocation(knownLocation, targetName),
      ...(wantsUniqueDefault ? { ensureUnique: true } : {}),
    };
  }

  return {
    path: extractedPath || directoryName || (wantsUniqueDefault ? defaultNewDirectoryName(text) : ''),
    ...(wantsUniqueDefault ? { ensureUnique: true } : {}),
  };
}

function extractDirectoryName(text: string): string {
  const match = text.match(
    /(?:folder|directory|папку|директорию)\s+(?:named\s+|called\s+|с\s+именем\s+)?(["'`].+?["'`]|[^\s,;]+)/i
  );
  const value = match?.[1]?.trim().replace(/^["'`]|["'`]$/g, '') || '';
  return value && !looksLikePath(value) && !isGenericLocationToken(value) && !isGeneratedNamePlaceholder(value) ? value : '';
}

function extractDescribedDirectoryName(text: string): string {
  const english = text.match(/\b(?:create|make|mkdir)\s+((?:(?!new\s+)[a-z][a-z0-9_-]*\s+){1,3})(?:folder|directory)\b/i)?.[1];
  if (english) {
    const normalized = normalizeFolderNameWords(english, 'en');
    if (normalized) return normalized;
  }

  const russian = text.match(/(?:^|\s)(?:создай|создать|сделай|сделать)\s+((?:(?!нов[а-яё]*\s+)[а-яё-]+\s+){1,3})(?:папку|директорию)(?:$|[\s,.;!?])/i)?.[1];
  if (russian) {
    const normalized = normalizeFolderNameWords(russian, 'ru');
    if (normalized) return normalized;
  }

  return '';
}

function normalizeFolderNameWords(value: string, language: 'en' | 'ru'): string {
  const words = value
    .trim()
    .replace(/[.,;:]+$/g, '')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !isGenericDirectoryDescriptor(word));
  if (words.length === 0) return '';
  const normalized = language === 'ru'
    ? words.map(normalizeRussianFolderDescriptor)
    : words.map((word) => word.toLowerCase());
  return [...normalized, language === 'ru' ? 'папка' : 'folder']
    .map((word, index) => language === 'en' || index === 0 ? capitalizeWord(word) : word)
    .join(' ');
}

function normalizeRussianFolderDescriptor(word: string): string {
  const lower = word.toLowerCase();
  if (lower.endsWith('ую')) return `${lower.slice(0, -2)}ая`;
  if (lower.endsWith('юю')) return `${lower.slice(0, -2)}яя`;
  return lower;
}

function isGenericDirectoryDescriptor(word: string): boolean {
  return /^(?:new|empty|blank|name|title|названи[ея]?|имя|нов[а-яё]*|пуст[а-яё]*|обычн[а-яё]*)$/i.test(word);
}

function isGeneratedNamePlaceholder(value: string): boolean {
  const normalized = value.trim().replace(/[.,;:!?]+$/g, '').toLowerCase();
  return /^(?:name|title|названи[ея]?|имя)$/i.test(normalized);
}

function capitalizeWord(word: string): string {
  return word ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : '';
}

function wantsUnnamedNewDirectory(text: string): boolean {
  return /\bnew\s+folder\b|(?:invent|choose|generate)\s+(?:a\s+)?name|нов[а-яё]*\s+папк|(?:названи[ея]?|имя).{0,32}придум|придумай\s+сам/i.test(text);
}

function defaultNewDirectoryName(text: string): string {
  return /[а-яё]/i.test(text) ? 'Новая папка' : 'New Folder';
}

function joinKnownLocation(root: string, child: string): string {
  const trimmed = child.trim().replace(/^["'`]|["'`]$/g, '').replace(/[.,;:]+$/g, '');
  if (!trimmed || path.isAbsolute(trimmed)) return trimmed || root;
  return path.join(root, trimmed);
}

function extractPath(text: string): string {
  const cleaned = text.replace(/\b(?:in\s+files?|в\s+файлах?|in\s+project|в\s+проекте)\b/gi, ' ');
  const objectMatch = cleaned.match(/(?:^|\s)(?:file|folder|directory|path|файл|файла|папку|директорию|путь)\s+(?:named\s+|called\s+|с\s+именем\s+)?(["'`].+?["'`]|[^\s,;]+)/i);
  if (objectMatch?.[1]) {
    const matchedPath = objectMatch[1].trim().replace(/^["'`]|["'`]$/g, '');
    if (!isGenericLocationToken(matchedPath)) return matchedPath;
  }
  const quotedPaths = Array.from(text.matchAll(/["'`](.+?)["'`]/g))
    .map((match) => match[1]?.trim() || '')
    .filter(looksLikePath);
  if (quotedPaths[0]) return quotedPaths[0];

  const locationMatch = cleaned.match(/(?:^|\s)(?:in|from|inside|to|в|из|по)\s+([^\s,;]+)/i);
  if (locationMatch?.[1] && looksLikePath(locationMatch[1])) {
    return locationMatch[1].trim();
  }
  const directRead = cleaned.match(/(?:^|\s)(?:read|show|open|view|прочитай|прочитать|открой|покажи|посмотри|просмотри)\s+([^\s,;]+)/i);
  const candidate = directRead?.[1]?.trim() || '';
  return looksLikePath(candidate) ? candidate : '';
}

function extractFileContent(text: string): string {
  const quoted = Array.from(text.matchAll(/["'`](.+?)["'`]/g)).map((match) => match[1]?.trim() || '');
  if (quoted.length >= 2) {
    return quoted[1] || '';
  }

  const match = text.match(/(?:with\s+text|with\s+content|content|с\s+текстом|с\s+содержимым|текстом)\s*[:\-]?\s*(.+)$/i);
  return match?.[1]?.trim().replace(/^["'`]|["'`]$/g, '') || '';
}

function matchesEntryFilters(
  entryPath: string,
  entryType: FileEntry['type'],
  options: { entryType?: FileEntry['type']; extension?: string }
): boolean {
  if (options.entryType && options.entryType !== entryType) return false;
  if (options.extension && (entryType !== 'file' || path.extname(entryPath).toLowerCase() !== options.extension)) {
    return false;
  }
  return true;
}

async function copyWorkspaceTree(
  source: string,
  target: string,
  options: { sourcePolicyGuard?: WorkspaceTraversalPolicyGuard } = {}
): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;

  const visit = async (currentSource: string, currentTarget: string): Promise<void> => {
    entries += 1;
    if (entries > MAX_COPY_ENTRIES) throw new Error(`Copy exceeds ${MAX_COPY_ENTRIES} entries.`);
    const blocked = await options.sourcePolicyGuard?.(currentSource);
    if (blocked) throw new WorkspaceTraversalPolicyError(blocked);
    const info = await lstat(currentSource);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not copied: ${currentSource}`);
    if (info.isDirectory()) {
      await mkdir(currentTarget, { recursive: false });
      const children = await readdir(currentSource);
      for (const child of children) {
        await visit(path.join(currentSource, child), path.join(currentTarget, child));
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Unsupported filesystem entry: ${currentSource}`);
    bytes += info.size;
    if (bytes > MAX_COPY_BYTES) throw new Error(`Copy exceeds ${MAX_COPY_BYTES} bytes.`);
    await mkdir(path.dirname(currentTarget), { recursive: true });
    await copyFile(currentSource, currentTarget);
  };

  try {
    await visit(source, target);
    return { bytes, entries };
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function extractTransferInput(text: string): { path: string; targetPath: string } {
  const quoted = Array.from(text.matchAll(/["'`](.+?)["'`]/g)).map((match) => match[1]?.trim() || '');
  if (quoted.length >= 2) return { path: quoted[0] || '', targetPath: quoted[1] || '' };
  const match = text.match(/(?:copy|duplicate|move|rename|скопируй|дублируй|перемести|переименуй)\s+(?:file|folder|directory|файл|папку|директорию)?\s*([^\s,;]+)\s+(?:to|into|в|на)\s+([^\s,;]+)/i);
  return { path: match?.[1]?.trim() || extractPath(text), targetPath: match?.[2]?.trim() || '' };
}

function extractReplaceInput(text: string): { path: string; oldText: string; newText: string } {
  const quoted = Array.from(text.matchAll(/["'`](.+?)["'`]/g)).map((match) => match[1]?.trim() || '');
  let pathValue = extractPathAfterFileKeyword(text);
  let oldText = '';
  let newText = '';

  if (quoted.length >= 3 && pathValue === quoted[0]) {
    oldText = quoted[1] || '';
    newText = quoted[2] || '';
  } else if (quoted.length >= 2) {
    oldText = quoted[quoted.length - 2] || '';
    newText = quoted[quoted.length - 1] || '';
  }
  if (!pathValue && quoted.length >= 3) {
    pathValue = quoted[0] || '';
  }

  return { path: pathValue, oldText, newText };
}

function extractPathAfterFileKeyword(text: string): string {
  const match = text.match(/(?:file|файл(?:е|а)?)\s+(["'`].+?["'`]|[^\s,;]+)/i);
  return match?.[1]?.trim().replace(/^["'`]|["'`]$/g, '') || '';
}

function extractSearchQuery(text: string): string {
  const quoted = text.match(/["'`](.+?)["'`]/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  return text
    .replace(/(?:^|\s)(?:search|find|grep|поиск|найди|ищи).{0,20}(?:files?|файлах?)\s*(for|чтобы)?\s*/i, '')
    .replace(/^(?:search|find|grep|поиск|найди|ищи)\s+/i, '')
    .replace(/\s+(?:in\s+project|в\s+проекте)\s*$/i, '')
    .trim();
}

function readStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readRawStringInput(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function readNumberInput(input: unknown, key: string, fallback: number): number {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBooleanInput(input: unknown, key: string, fallback: boolean): boolean {
  if (!input || typeof input !== 'object') {
    return fallback;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeLimit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.floor(Number(value) || min), max));
}

function normalizeEntryType(value: string): FileEntry['type'] | undefined {
  return value === 'file' || value === 'directory' ? value : undefined;
}

function normalizeExtension(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (index <= text.length) {
    const foundAt = text.indexOf(needle, index);
    if (foundAt === -1) {
      break;
    }
    count += 1;
    index = foundAt + needle.length;
  }
  return count;
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function looksLikeTextFilePath(value: string): boolean {
  return /\.(?:css|csv|html?|ini|js|json|jsx|log|md|ps1|py|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i.test(value);
}

function isGenericLocationToken(value: string): boolean {
  return /^(project|workspace|desktop|downloads?|on|at|to|from|inside|in|проект|проекте|пространств\w*|рабоч\w*|стол\w*|загрузк\w*|files?|файлы?|файлах?|with|content|text|с|со|в|во|на|из|по|текстом|содержимым)$/i.test(value);
}

function isOpenEndedBuildRequest(text: string): boolean {
  const asksToBuild = /(?:создай|создать|сделай|сделать|собери|собрать|реализуй|реализовать|напиши|build|create|make|implement|generate)/i.test(text);
  if (!asksToBuild) return false;
  const buildSubject = /(?:калькулятор|calculator|приложен\w*|app\b|application|сайт|website|страниц\w*|game|игр\w*|dashboard|дашборд|интерфейс|ui\b)/i.test(text);
  const buildQualifier = /(?:рабоч\w*|работающ\w*|графическ\w*|визуальн\w*|интерактивн\w*|functional|working|graphical|interactive|with\s+ui|gui\b)/i.test(text);
  return buildSubject && buildQualifier && !isExplicitWorkspaceBatch(text);
}

function isExplicitWorkspaceBatch(text: string): boolean {
  return /(?:с\s+текстом|с\s+содержимым|with\s+(?:text|content)|content\s*:)/i.test(text)
    || /(?:структур\w*|дерево|скелет|structure|scaffold).{0,80}(?:[\\/]|├|└|\.\w{1,12})/i.test(text)
    || /(?:^|\n)\s*(?:[-*]|\d+[.)])\s+[^:\n]+\.\w{1,12}\s*:/i.test(text);
}

async function nextAvailableDirectoryPath(basePath: string): Promise<string> {
  if (!(await stat(basePath).catch(() => undefined))) return basePath;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${basePath} (${index})`;
    if (!(await stat(candidate).catch(() => undefined))) return candidate;
  }
  return `${basePath}-${Date.now()}`;
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function createWorkspaceModule(options: WorkspaceModuleOptions = {}): MonarchModule {
  return new WorkspaceModule(options);
}

export const workspaceModulePackage: MonarchModulePackage = {
  id: workspaceManifest.id,
  moduleId: workspaceManifest.id,
  version: workspaceManifest.version,
  description: workspaceManifest.description,
  core: {
    minVersion: '0.1.0',
  },
  factory: createWorkspaceModule,
};

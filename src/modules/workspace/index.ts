import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  MonarchExecutionRequest,
  MonarchExecutionControl,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModulePackage,
} from '../../core';
import {
  defaultLocalReadOnlyRoots,
  evaluateFilesystemAccess,
  ensureWritableParentDirectory,
  immutableMonarchSafeRoots,
  isWritableKnownFolder,
  normalizeKnownFolderBasename,
  resolveKnownUserFolder,
  type MonarchFilesystemAccessResult,
  type MonarchFilesystemOperation,
  type MonarchFilesystemPolicyOptions,
} from '../../core';
import { workspaceManifest } from './manifest';
import { runWorkspaceStorageAudit } from './storage-audit';
import { renameWithWindowsRetry } from '../../core/durable-json-file';

const DEFAULT_READ_BYTES = 128 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const LINE_COUNT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const SEARCH_FILE_BUDGET = 20_000;
const SEARCH_BYTE_BUDGET = 64 * 1024 * 1024;
const SEARCH_TIME_BUDGET_MS = 12_000;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_COPY_ENTRIES = 2_000;

export const WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public sealed class MonarchRecycleAncestorFence : IDisposable
{
    private const uint FileReadAttributes = 0x0080;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;
    private const uint FileFlagOpenReparsePoint = 0x00200000;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private readonly List<SafeFileHandle> handles;

    private MonarchRecycleAncestorFence(List<SafeFileHandle> handles)
    {
        this.handles = handles;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo
    {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    private enum FileInfoByHandleClass
    {
        FileAttributeTagInfo = 9
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file,
        FileInfoByHandleClass fileInformationClass,
        out FileAttributeTagInfo fileInformation,
        uint bufferSize);

    public static MonarchRecycleAncestorFence Acquire(string targetPath)
    {
        string fullTarget = Path.GetFullPath(targetPath);
        string parent = Path.GetDirectoryName(fullTarget);
        if (String.IsNullOrWhiteSpace(parent))
        {
            throw new InvalidOperationException("Recycle target has no parent directory.");
        }

        var chain = new Stack<string>();
        string root = Path.GetPathRoot(fullTarget);
        string cursor = parent;
        while (!String.IsNullOrWhiteSpace(cursor))
        {
            chain.Push(cursor);
            if (String.Equals(
                cursor.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
            {
                break;
            }
            string trimmed = cursor.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string next = Path.GetDirectoryName(trimmed);
            if (String.IsNullOrWhiteSpace(next) ||
                String.Equals(next, cursor, StringComparison.OrdinalIgnoreCase))
            {
                break;
            }
            cursor = next;
        }

        var opened = new List<SafeFileHandle>();
        try
        {
            while (chain.Count > 0)
            {
                string ancestor = chain.Pop();
                SafeFileHandle handle = CreateFileW(
                    ancestor,
                    FileReadAttributes,
                    FileShareRead | FileShareWrite,
                    IntPtr.Zero,
                    OpenExisting,
                    FileFlagBackupSemantics | FileFlagOpenReparsePoint,
                    IntPtr.Zero);
                if (handle.IsInvalid)
                {
                    int error = Marshal.GetLastWin32Error();
                    handle.Dispose();
                    throw new Win32Exception(error, "Could not hold recycle target ancestor: " + ancestor);
                }

                FileAttributeTagInfo info;
                if (!GetFileInformationByHandleEx(
                    handle,
                    FileInfoByHandleClass.FileAttributeTagInfo,
                    out info,
                    (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo))))
                {
                    int error = Marshal.GetLastWin32Error();
                    handle.Dispose();
                    throw new Win32Exception(error, "Could not verify recycle target ancestor: " + ancestor);
                }
                if ((info.FileAttributes & FileAttributeReparsePoint) != 0)
                {
                    handle.Dispose();
                    throw new IOException("Recycle target ancestor is a reparse point: " + ancestor);
                }
                opened.Add(handle);
            }
            return new MonarchRecycleAncestorFence(opened);
        }
        catch
        {
            foreach (SafeFileHandle handle in opened)
            {
                handle.Dispose();
            }
            throw;
        }
    }

    public void Dispose()
    {
        for (int index = handles.Count - 1; index >= 0; index--)
        {
            handles[index].Dispose();
        }
        handles.Clear();
    }
}
`;

export interface WorkspaceModuleOptions {
  workspaceRoot?: string;
  /** Immutable host-resolved policy snapshot, never capability/model input.
   * Omit to retain Windows folder discovery; isolated hosts pass [] so file
   * operations do not synchronously probe HKCU or launch a discovery helper. */
  localReadOnlyRoots?: readonly string[];
  trashPath?: (
    targetPath: string,
    isDirectory: boolean,
    signal?: AbortSignal,
    expectedIdentity?: WorkspacePathIdentity,
  ) => Promise<void>;
  beforeMutation?: (
    operation: 'write' | 'replace' | 'append' | 'mkdir' | 'copy' | 'move' | 'delete' | 'trash',
    targetPaths: readonly string[],
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

interface WorkspacePathIdentity {
  realPath: string;
  kind: 'file' | 'directory';
  device: number;
  inode: number;
  size: number;
  mode: number;
  createdMs: number;
  modifiedMs: number;
}

interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
}

interface InspectableFileSnapshot {
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
}

interface InspectBatchSkip {
  path: string;
  reason: string;
  detail?: string;
}

interface InspectBatchCursorV1 {
  version: 1;
  rootHash: string;
  snapshotId: string;
  index: number;
}

interface InspectBatchItem {
  path: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
  modifiedMs: number;
  sha256?: string;
  format: string;
  status: 'read' | 'metadata-only' | 'skipped';
  content?: string;
  reason?: string;
}

const INSPECT_BATCH_SCHEMA_VERSION = 'monarch.workspace-files-inspect-batch.v1';
const DEFAULT_INSPECT_BATCH_PAGE_SIZE = 50;
const DEFAULT_INSPECT_MAX_BYTES_PER_FILE = 64 * 1024;
const DEFAULT_INSPECT_MAX_TOTAL_CONTENT_BYTES = 256 * 1024;
const DEFAULT_INSPECT_MAX_ENTRIES = 50_000;
const TEXT_FILE_EXTENSIONS = new Set([
  '', '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.ps1', '.psm1',
  '.bat', '.cmd', '.sh', '.css', '.scss', '.less', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.sql', '.srt', '.vtt',
  '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs',
]);
const UNSUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf',
]);

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
  private readonly trashPath: NonNullable<WorkspaceModuleOptions['trashPath']>;
  private readonly beforeMutation: NonNullable<WorkspaceModuleOptions['beforeMutation']>;
  private readonly localReadOnlyRoots: string[] | undefined;
  private ownerRedZoneRootsProvider: () => readonly string[] = () => [];

  constructor(options: WorkspaceModuleOptions = {}) {
    this.workspaceRoot = path.resolve(options.workspaceRoot || process.cwd());
    this.trashPath = options.trashPath || trashWorkspacePath;
    this.beforeMutation = options.beforeMutation || (() => undefined);
    this.localReadOnlyRoots = options.localReadOnlyRoots === undefined ? undefined : [...options.localReadOnlyRoots];
  }

  setOwnerRedZoneRootsProvider(provider: () => readonly string[]): void {
    this.ownerRedZoneRootsProvider = provider;
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


  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    control: MonarchExecutionControl = {},
  ): Promise<MonarchExecutionResult> {
    const executionContext = request.ownerUnrestrictedExecution === true
      ? Object.assign(Object.create(context) as MonarchKernelContext, { ownerUnrestrictedExecution: true as const })
      : context;
    switch (request.capabilityId) {
    case 'workspace.root.get':
      return this.workspaceRootCapability();
    case 'workspace.storage.audit':
      return this.auditStorageCapability(request.input, executionContext, control.signal);
    case 'workspace.files.read':
      return this.readFileCapability(request.input, executionContext);
    case 'workspace.files.list':
      return this.listFiles(request.input, executionContext);
    case 'workspace.files.inspect-batch':
      return this.inspectFilesBatch(request.input, executionContext, control.signal);
    case 'workspace.known-folder.resolve':
      return this.resolveKnownFolderCapability(request.input, executionContext);
    case 'workspace.files.search':
      return this.searchFiles(request.input, executionContext);
    case 'workspace.files.write':
      return this.writeFileCapability(request.input, executionContext, control.signal);
    case 'workspace.known-folder.write':
      return this.writeKnownFolderFileCapability(request.input, executionContext, control.signal);
    case 'workspace.files.append':
      return this.appendFileCapability(request.input, executionContext, control.signal);
    case 'workspace.files.mkdir':
      return this.makeDirectoryCapability(request.input, executionContext, control.signal);
    case 'workspace.files.copy':
      return this.copyPathCapability(request.input, executionContext, control.signal);
    case 'workspace.files.move':
      return this.movePathCapability(request.input, executionContext, control.signal);
    case 'workspace.files.replace':
      return this.replaceFileTextCapability(request.input, executionContext, control.signal);
    case 'workspace.files.trash':
      return this.trashPathCapability(request.input, executionContext, control.signal);
    case 'workspace.files.delete':
      return this.deleteFileCapability(request.input, executionContext, control.signal);
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
    // Without an explicit offset the exact-read contract holds: the whole file or
    // `file-too-large`. With one, a large file is read as a window: exact size,
    // line count and where to continue, so an agent can read on by offset.
    const windowed = typeof (input as { offset?: unknown } | null)?.offset === 'number';
    if (!windowed && fileStat.size > maxBytes) {
      return {
        ok: false,
        summary: `File is too large to read at once (${fileStat.size} bytes, limit ${maxBytes}); read it in parts with offset 0 and maxBytes, then continue from nextOffset.`,
        error: 'file-too-large',
        metadata: { evaluation, sizeBytes: fileStat.size, maxBytes },
      };
    }
    const offset = Math.max(0, Math.min(fileStat.size, Math.trunc(readNumberInput(input, 'offset', 0))));
    const whole = offset === 0 && fileStat.size <= maxBytes;
    const buffer = whole ? await readFile(evaluation.resolvedPath) : await readFileWindow(evaluation.resolvedPath, offset, maxBytes);
    const content = decodeUtf8Window(buffer, !whole);
    const end = offset + buffer.length;
    const lineCount = fileStat.size <= LINE_COUNT_MAX_BYTES ? await countFileLines(evaluation.resolvedPath) : undefined;
    const truncated = end < fileStat.size;
    return {
      ok: true,
      summary: truncated
        ? `Read bytes ${offset}-${end} of ${fileStat.size} from ${evaluation.resolvedPath}; continue with offset ${end}.`
        : `Read file ${evaluation.resolvedPath} (${fileStat.size} bytes${lineCount === undefined ? '' : `, ${lineCount} lines`}).`,
      output: {
        path: evaluation.resolvedPath,
        sizeBytes: fileStat.size,
        ...(lineCount === undefined ? {} : { lineCount }),
        ...(whole ? {} : { offset, nextOffset: truncated ? end : null, truncated }),
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
    const nameContains = normalizeNameContains(readStringInput(input, 'nameContains'));
    const collected = await collectFileEntries(evaluation.resolvedPath, {
      root: evaluation.resolvedPath,
      rootStat,
      recursive,
      limit: limit + 1,
      policyGuard: this.createTraversalPolicyGuard('list', context),
      ...(entryType ? { entryType } : {}),
      ...(extension ? { extension } : {}),
      ...(nameContains ? { nameContains } : {}),
    });

    const entries = collected.slice(0, limit);
    return {
      ok: true,
      summary: `Listed ${entries.length} workspace entries.`,
      output: {
        root: evaluation.resolvedPath,
        entries,
        recursive,
        entryType: entryType || null,
        extension: extension || null,
        truncated: collected.length > limit,
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
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const needle = query.toLowerCase();
    // A whole-project search used to list only the first 1000 entries (folders
    // included) and read those: on a real repository it never reached source
    // folders two levels down and reported "0 matches" for code that exists.
    // Walk files only, skip generated/dependency trees, and bound by work done;
    // an incomplete scan says so instead of reading as "not found".
    const scan = { files: 0, bytes: 0, truncated: false };
    const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
    if (rootStat.isFile()) {
      if (!isLikelyBinary(evaluation.resolvedPath) && rootStat.size <= MAX_SEARCH_FILE_BYTES) {
        const content = await readFile(evaluation.resolvedPath, 'utf8').catch(() => '');
        scan.files = 1; scan.bytes = content.length;
        appendTextMatches(content, needle, evaluation.resolvedPath, limit, matches);
      }
    } else {
      const guard = this.createTraversalPolicyGuard('search', context);
      const queue = [evaluation.resolvedPath];
      for (let index = 0; index < queue.length && matches.length < limit; index++) {
        if (scan.files >= SEARCH_FILE_BUDGET || scan.bytes >= SEARCH_BYTE_BUDGET || Date.now() > deadline) { scan.truncated = true; break; }
        const children = await readdir(queue[index]!, { withFileTypes: true }).catch(() => []);
        for (const child of children) {
          if (matches.length >= limit) break;
          const childPath = path.join(queue[index]!, child.name);
          if (await guard(childPath, child.isDirectory() || child.isSymbolicLink())) continue;
          if (child.isDirectory()) {
            if (!shouldSkipDirectory(child.name) && !shouldSkipSearchDirectory(child.name)) queue.push(childPath);
            continue;
          }
          if (!child.isFile() || isLikelyBinary(childPath)) continue;
          if (scan.files >= SEARCH_FILE_BUDGET || scan.bytes >= SEARCH_BYTE_BUDGET || Date.now() > deadline) { scan.truncated = true; break; }
          const size = (await stat(childPath).catch(() => undefined))?.size ?? 0;
          if (size > MAX_SEARCH_FILE_BYTES) continue;
          const content = await readFile(childPath, 'utf8').catch(() => '');
          scan.files++; scan.bytes += size;
          appendTextMatches(content, needle, childPath, limit, matches);
        }
      }
    }

    return {
      ok: true,
      summary: `Found ${matches.length} file matches in ${scan.files} scanned files`
        + (scan.truncated ? '; the scan stopped at its budget before covering the whole tree, so narrow the path to search the rest.' : '.'),
      output: { query, root: evaluation.resolvedPath, matches, scannedFiles: scan.files, truncated: scan.truncated },
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

    return this.writeEvaluatedFile(input, context, evaluation, signal);
  }

  private async resolveKnownFolderCapability(
    input: unknown,
    context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    const knownFolder = normalizeInspectableKnownFolder(readStringInput(input, 'knownFolder'));
    if (!knownFolder) {
      return { ok: false, summary: 'Known folder must be desktop or downloads.', error: 'invalid-known-folder' };
    }
    const resolvedPath = resolveKnownUserFolder(knownFolder);
    if (!resolvedPath) {
      return { ok: false, summary: `Windows ${knownFolder} folder could not be resolved.`, error: 'known-folder-unavailable' };
    }
    const evaluation = this.evaluate(resolvedPath, 'list', context, { allowRoot: true });
    if (!evaluation.allowed) return blockedResult(evaluation.message, evaluation);
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'list', context);
    if (realPathBlock) return realPathBlock;
    const folderStat = await stat(evaluation.resolvedPath).catch(() => undefined);
    return {
      ok: true,
      summary: folderStat?.isDirectory()
        ? `Resolved ${knownFolder} to ${evaluation.resolvedPath}.`
        : `Resolved ${knownFolder} to ${evaluation.resolvedPath}, but the directory is unavailable.`,
      output: {
        knownFolder,
        path: evaluation.resolvedPath,
        exists: Boolean(folderStat),
        directory: folderStat?.isDirectory() === true,
      },
    };
  }

  private async inspectFilesBatch(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const knownFolder = normalizeInspectableKnownFolder(readStringInput(input, 'knownFolder'));
    const explicitPath = readStringInput(input, 'path');
    if ((knownFolder && explicitPath) || (!knownFolder && !explicitPath)) {
      return {
        ok: false,
        summary: 'Batch inspection requires exactly one of path or knownFolder.',
        error: 'invalid-inspect-batch-root',
      };
    }
    const requestedRoot = knownFolder ? resolveKnownUserFolder(knownFolder) : explicitPath;
    if (!requestedRoot) {
      return { ok: false, summary: 'Batch inspection root could not be resolved.', error: 'inspect-batch-root-unavailable' };
    }
    const evaluation = this.evaluate(requestedRoot, 'list', context, { allowRoot: true });
    if (!evaluation.allowed) return blockedResult(evaluation.message, evaluation);
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'list', context);
    if (realPathBlock) return realPathBlock;
    const rootInfo = await lstat(evaluation.resolvedPath).catch(() => undefined);
    if (!rootInfo || (!rootInfo.isDirectory() && !rootInfo.isFile()) || rootInfo.isSymbolicLink()) {
      return {
        ok: false,
        summary: `Batch inspection root must be one real file or directory: ${evaluation.resolvedPath}`,
        error: 'invalid-inspect-batch-root',
      };
    }

    const recursive = readBooleanInput(input, 'recursive', true);
    const pageSize = normalizeLimit(readNumberInput(input, 'pageSize', DEFAULT_INSPECT_BATCH_PAGE_SIZE), 1, 50);
    const maxBytesPerFile = normalizeLimit(
      readNumberInput(input, 'maxBytesPerFile', DEFAULT_INSPECT_MAX_BYTES_PER_FILE),
      1,
      256 * 1024,
    );
    const maxTotalContentBytes = normalizeLimit(
      readNumberInput(input, 'maxTotalContentBytes', DEFAULT_INSPECT_MAX_TOTAL_CONTENT_BYTES),
      1,
      512 * 1024,
    );
    const maxEntries = normalizeLimit(
      readNumberInput(input, 'maxEntries', DEFAULT_INSPECT_MAX_ENTRIES),
      1,
      100_000,
    );
    const snapshot = await collectInspectableFileSnapshot(evaluation.resolvedPath, {
      recursive,
      maxEntries,
      ...(signal ? { signal } : {}),
      policyGuard: this.createTraversalPolicyGuard('read', context),
    });
    const snapshotId = inspectBatchSnapshotId(evaluation.resolvedPath, recursive, snapshot.files, snapshot.skips);
    const rootHash = createHash('sha256').update(canonicalInspectRoot(evaluation.resolvedPath)).digest('hex');
    const cursorText = readStringInput(input, 'cursor');
    const cursor = cursorText ? decodeInspectBatchCursor(cursorText) : null;
    if (cursorText && (!cursor
      || cursor.rootHash !== rootHash
      || cursor.snapshotId !== snapshotId
      || cursor.index < 0
      || cursor.index > snapshot.files.length)) {
      return {
        ok: false,
        summary: 'Batch inspection cursor is invalid or stale because the target changed. Restart from the first page.',
        error: 'stale-inspect-batch-cursor',
        output: { root: evaluation.resolvedPath, snapshotId, restartRequired: true },
      };
    }
    const startIndex = cursor?.index || 0;
    const endIndex = Math.min(snapshot.files.length, startIndex + pageSize);
    const page = snapshot.files.slice(startIndex, endIndex);
    const inspected = await inspectFileSnapshotPage(page, {
      maxBytesPerFile,
      maxTotalContentBytes,
      ...(signal ? { signal } : {}),
    });
    const nextCursor = endIndex < snapshot.files.length
      ? encodeInspectBatchCursor({ version: 1, rootHash, snapshotId, index: endIndex })
      : null;
    const paginationComplete = nextCursor === null;
    const complete = paginationComplete && !snapshot.truncated;
    const skips = [...snapshot.skips, ...inspected.skips];
    const readFiles = inspected.items.filter((entry) => entry.status === 'read').length;
    const metadataOnlyFiles = inspected.items.filter((entry) => entry.status === 'metadata-only').length;
    const skippedFiles = inspected.items.filter((entry) => entry.status === 'skipped').length;
    return {
      ok: true,
      summary: complete
        ? `Inspected the final page and accounted for ${snapshot.files.length} files under ${evaluation.resolvedPath}.`
        : `Inspected files ${startIndex + 1}-${endIndex} of ${snapshot.files.length} under ${evaluation.resolvedPath}.`,
      output: {
        schemaVersion: INSPECT_BATCH_SCHEMA_VERSION,
        root: evaluation.resolvedPath,
        snapshotId,
        items: inspected.items,
        skips,
        coverage: {
          totalFiles: snapshot.files.length,
          pageStart: startIndex,
          pageEnd: endIndex,
          returnedFiles: inspected.items.length,
          readFiles,
          metadataOnlyFiles,
          skippedFiles,
          remainingFiles: Math.max(0, snapshot.files.length - endIndex),
          enumerationSkipped: snapshot.skips.length,
          enumerationComplete: !snapshot.truncated,
          paginationComplete,
        },
        nextCursor,
        complete,
      },
      metadata: {
        evaluation,
        partial: !complete || skips.length > 0,
        warnings: skips.length > 0
          ? [`Batch inspection explicitly reported ${skips.length} skipped or metadata-only entries.`]
          : [],
      },
    };
  }

  private async writeKnownFolderFileCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const knownFolder = readStringInput(input, 'knownFolder');
    if (!isWritableKnownFolder(knownFolder)) {
      return {
        ok: false,
        summary: 'Known folder must be exactly desktop or downloads.',
        error: 'invalid-known-folder',
        output: { verified: false },
      };
    }

    const basename = normalizeKnownFolderBasename(readStringInput(input, 'basename'));
    if (!basename) {
      return {
        ok: false,
        summary: 'Known-folder basename must be one safe leaf name without path separators or traversal.',
        error: 'invalid-known-folder-basename',
        output: { knownFolder, verified: false },
      };
    }
    if (readBooleanInput(input, 'overwrite', false)) {
      return {
        ok: false,
        summary: 'Known-folder writes are create-only; replacing an existing user file requires a separate typed capability.',
        error: 'known-folder-overwrite-unsupported',
        output: { knownFolder, basename, verified: false },
      };
    }

    const configuredRoot = resolveKnownUserFolder(knownFolder);
    const trustedRoot = configuredRoot
      ? await realpath(configuredRoot).catch(() => '')
      : '';
    const rootStat = trustedRoot
      ? await stat(trustedRoot).catch(() => undefined)
      : undefined;
    if (!trustedRoot || !rootStat?.isDirectory()) {
      return {
        ok: false,
        summary: `Known folder is unavailable: ${knownFolder}.`,
        error: 'known-folder-unavailable',
        output: { knownFolder, verified: false },
      };
    }

    const targetPath = path.join(trustedRoot, basename);
    const policyOptions: MonarchFilesystemPolicyOptions & { fallbackRoot: string; allowRoot?: boolean } = {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: trustedRoot,
      fallbackRoot: trustedRoot,
      allowedRoots: [trustedRoot],
      allowFullDiskAccess: false,
      protectWorkspaceInternals: true,
    };
    const evaluation = evaluateFilesystemAccess(targetPath, 'write', policyOptions);
    if (!evaluation.allowed) {
      return blockedResult(evaluation.message, evaluation);
    }
    const realPathBlock = await this.blockIfRealPathEscapes(
      evaluation.resolvedPath,
      'write',
      context,
      policyOptions,
    );
    if (realPathBlock) {
      return realPathBlock;
    }
    const existingTarget = await lstat(evaluation.resolvedPath).catch(() => undefined);
    if (existingTarget?.isSymbolicLink()) {
      return {
        ok: false,
        summary: `Known-folder target cannot be a symbolic link: ${evaluation.resolvedPath}`,
        error: 'known-folder-target-link-blocked',
        output: { knownFolder, basename, path: evaluation.resolvedPath, verified: false },
      };
    }

    return this.writeEvaluatedFile(input, context, evaluation, signal, {
      knownFolder,
      basename,
      createParent: false,
    });
  }

  private async writeEvaluatedFile(
    input: unknown,
    context: MonarchKernelContext,
    evaluation: MonarchFilesystemAccessResult,
    signal?: AbortSignal,
    options: {
      knownFolder?: 'desktop' | 'downloads';
      basename?: string;
      createParent?: boolean;
    } = {},
  ): Promise<MonarchExecutionResult> {

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

    try {
      signal?.throwIfAborted();
      await this.beforeMutation('write', [evaluation.resolvedPath], signal);
      signal?.throwIfAborted();
      if (options.createParent !== false) {
        await ensureWritableParentDirectory(evaluation.resolvedPath);
      }
      signal?.throwIfAborted();
      await writeFile(evaluation.resolvedPath, content, {
        encoding: 'utf8',
        signal,
        // The preflight stat is not an exclusive-create guarantee: another
        // process may create the name before this open. Preserve its bytes.
        flag: overwrite ? 'w' : 'wx',
      });
    } catch (error) {
      if (!overwrite && filesystemNodeErrorCode(error) === 'EEXIST') {
        return {
          ok: false,
          summary: `File already exists: ${evaluation.resolvedPath}`,
          error: 'file-exists',
          output: {
            ...(options.knownFolder ? { knownFolder: options.knownFolder } : {}),
            ...(options.basename ? { basename: options.basename } : {}),
            path: evaluation.resolvedPath,
            verified: false,
          },
        };
      }
      return filesystemMutationFailure('write', evaluation.resolvedPath, error);
    }
    const readback = await readFile(evaluation.resolvedPath).catch(() => undefined);
    const expected = Buffer.from(content, 'utf8');
    if (!readback?.equals(expected)) {
      return {
        ok: false,
        summary: `Write readback failed for ${evaluation.resolvedPath}.`,
        error: 'write-readback-mismatch',
        output: {
          path: evaluation.resolvedPath,
          bytes: readback?.byteLength || 0,
          verified: false,
          cancellationObservedAfterDispatch: signal?.aborted === true,
        },
      };
    }
    await context.emit('workspace.file.written', this.manifest.id, {
      path: evaluation.resolvedPath,
      bytes,
    });

    return {
      ok: true,
      summary: `Wrote file ${evaluation.resolvedPath}.`,
      output: {
        ...(options.knownFolder ? { knownFolder: options.knownFolder } : {}),
        ...(options.basename ? { basename: options.basename } : {}),
        path: evaluation.resolvedPath,
        bytes,
        verified: true,
        readbackSha256: createHash('sha256').update(readback).digest('hex'),
        createdExclusively: !overwrite,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async replaceFileTextCapability(
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

    const content = await readFile(evaluation.resolvedPath, { encoding: 'utf8', signal });
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

    try {
      signal?.throwIfAborted();
      await this.beforeMutation('replace', [evaluation.resolvedPath], signal);
      signal?.throwIfAborted();
      await writeFile(evaluation.resolvedPath, updated, { encoding: 'utf8', signal });
    } catch (error) {
      return filesystemMutationFailure('replace', evaluation.resolvedPath, error);
    }
    const readback = await readFile(evaluation.resolvedPath);
    const expected = Buffer.from(updated, 'utf8');
    if (!readback.equals(expected)) {
      return {
        ok: false,
        summary: `Exact replace readback failed for ${evaluation.resolvedPath}.`,
        error: 'replace-readback-mismatch',
        output: { path: evaluation.resolvedPath, verified: false },
      };
    }
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
        verified: true,
        readbackSha256: createHash('sha256').update(readback).digest('hex'),
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async auditStorageCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    const rootInput = readStringInput(input, 'root');
    const evaluation = this.evaluate(rootInput, 'list', context, { allowRoot: true });
    if (!evaluation.allowed) return blockedResult(evaluation.message, evaluation);
    const rootInfo = await lstat(evaluation.resolvedPath).catch(() => undefined);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
      return {
        ok: false,
        summary: `Storage audit root must be one real directory, not a file or reparse point: ${evaluation.resolvedPath}`,
        error: 'invalid-audit-root',
        metadata: { evaluation },
      };
    }
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'list', context);
    if (realPathBlock) return realPathBlock;
    const topN = normalizeLimit(readNumberInput(input, 'topN', 20), 1, 100);
    const maxDepth = normalizeLimit(readNumberInput(input, 'maxDepth', 64), 0, 256);
    const maxEntries = normalizeLimit(readNumberInput(input, 'maxEntries', 500_000), 1, 2_000_000);
    const maxWallTimeMs = normalizeLimit(readNumberInput(input, 'maxWallTimeMs', 120_000), 100, 600_000);
    const driveRoot = path.parse(evaluation.resolvedPath).root;
    const fixedRedZones = [
      ...evaluation.policy.redZoneRoots,
      ...Array.from({ length: 26 }, (_entry, index) => `${String.fromCharCode(65 + index)}:\\MonarchData\\Safe`),
      path.join(driveRoot, '$Recycle.Bin'),
      path.join(driveRoot, 'System Volume Information'),
      path.join(driveRoot, 'Recovery'),
      path.join(driveRoot, 'Boot'),
      path.join(driveRoot, 'EFI'),
    ];
    const audit = await runWorkspaceStorageAudit({
      root: evaluation.resolvedPath,
      topN,
      maxDepth,
      maxEntries,
      maxWallTimeMs,
      blockedRoots: [...new Set(fixedRedZones.map((entry) => path.resolve(entry)))],
      ...(signal ? { signal } : {}),
    });
    const skipCount = Object.values(audit.skipReasons).reduce((sum, count) => sum + count, 0);
    return {
      ok: true,
      summary: audit.partial
        ? `Storage audit observed ${audit.directories} directories and ${audit.files} files under ${audit.root}; ${skipCount} entries or subtrees were skipped.`
        : `Storage audit verified ${audit.directories} directories and ${audit.files} files under ${audit.root}.`,
      output: {
        observationVerified: true,
        complete: !audit.partial,
        audit,
      },
      metadata: {
        evaluation,
        partial: audit.partial,
        warnings: audit.partial
          ? [`Storage audit is partial. Skip reasons: ${JSON.stringify(audit.skipReasons)}.`]
          : [],
      },
    };
  }

  private async appendFileCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
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
    try {
      signal?.throwIfAborted();
      await this.beforeMutation('append', [evaluation.resolvedPath], signal);
      signal?.throwIfAborted();
      await ensureWritableParentDirectory(evaluation.resolvedPath);
      signal?.throwIfAborted();
      await appendFile(evaluation.resolvedPath, content, 'utf8');
    } catch (error) {
      return filesystemMutationFailure('append', evaluation.resolvedPath, error);
    }
    const readback = await readFile(evaluation.resolvedPath);
    const appendedBytes = Buffer.from(content, 'utf8');
    const verified = readback.byteLength === nextBytes
      && readback.subarray(Math.max(0, readback.byteLength - appendedBytes.byteLength)).equals(appendedBytes);
    if (!verified) {
      return {
        ok: false,
        summary: `Append readback failed for ${evaluation.resolvedPath}.`,
        error: 'append-readback-mismatch',
        output: { path: evaluation.resolvedPath, bytes: readback.byteLength, verified: false },
      };
    }
    await context.emit('workspace.file.written', this.manifest.id, { path: evaluation.resolvedPath, append: true, bytes: nextBytes });
    return {
      ok: true,
      summary: `Appended file ${evaluation.resolvedPath}.`,
      output: {
        path: evaluation.resolvedPath,
        bytes: nextBytes,
        verified: true,
        readbackSha256: createHash('sha256').update(readback).digest('hex'),
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async makeDirectoryCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
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
      return {
        ok: true,
        summary: `Directory already exists ${targetEvaluation.resolvedPath}.`,
        output: {
          path: targetEvaluation.resolvedPath,
          alreadyExists: true,
          verified: true,
          cancellationObservedAfterDispatch: false,
        },
      };
    }
    try {
      signal?.throwIfAborted();
      await this.beforeMutation('mkdir', [targetEvaluation.resolvedPath], signal);
      signal?.throwIfAborted();
      await mkdir(targetEvaluation.resolvedPath, { recursive: true });
    } catch (error) {
      return filesystemMutationFailure('mkdir', targetEvaluation.resolvedPath, error);
    }
    const readback = await stat(targetEvaluation.resolvedPath).catch(() => undefined);
    if (!readback?.isDirectory()) {
      return {
        ok: false,
        summary: `Directory creation was not verified: ${targetEvaluation.resolvedPath}`,
        error: 'mkdir-readback-mismatch',
        output: { path: targetEvaluation.resolvedPath, verified: false },
      };
    }
    await context.emit('workspace.directory.created', this.manifest.id, { path: targetEvaluation.resolvedPath });
    return {
      ok: true,
      summary: `Created directory ${targetEvaluation.resolvedPath}.`,
      output: {
        path: targetEvaluation.resolvedPath,
        verified: true,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async copyPathCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
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
      await this.beforeMutation('copy', [source.resolvedPath, target.resolvedPath], signal);
      copied = await copyWorkspaceTree(source.resolvedPath, target.resolvedPath, {
        sourcePolicyGuard: (candidatePath) => this.blockIfRealPathEscapes(candidatePath, 'read', context),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof WorkspaceTraversalPolicyError) return error.result;
      const targetAfter = await lstat(target.resolvedPath).catch(() => undefined);
      return {
        ok: false,
        summary: `Copy failed: ${errorMessage(error)}`,
        error: filesystemErrorCode(error, 'copy-failed'),
        output: {
          source: source.resolvedPath,
          target: target.resolvedPath,
          targetExists: Boolean(targetAfter),
          verified: false,
          cancellationObservedAfterDispatch: signal?.aborted === true,
        },
      };
    }
    await context.emit('workspace.path.copied', this.manifest.id, { source: source.resolvedPath, target: target.resolvedPath, ...copied });
    return {
      ok: true,
      summary: `Copied ${source.resolvedPath} to ${target.resolvedPath}.`,
      output: {
        source: source.resolvedPath,
        target: target.resolvedPath,
        ...copied,
        verified: true,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async movePathCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
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
    try {
      signal?.throwIfAborted();
      await this.beforeMutation('move', [source.resolvedPath, target.resolvedPath], signal);
      signal?.throwIfAborted();
      await ensureWritableParentDirectory(target.resolvedPath);
      signal?.throwIfAborted();
      await renameWithWindowsRetry(source.resolvedPath, target.resolvedPath);
    } catch (error) {
      return filesystemMutationFailure('move', source.resolvedPath, error, target.resolvedPath);
    }
    const sourceAfter = await lstat(source.resolvedPath).catch(() => undefined);
    const targetAfter = await lstat(target.resolvedPath).catch(() => undefined);
    if (sourceAfter || !targetAfter) {
      return {
        ok: false,
        summary: `Move reconciliation failed for ${source.resolvedPath}.`,
        error: 'move-readback-mismatch',
        output: {
          source: source.resolvedPath,
          target: target.resolvedPath,
          sourceExists: Boolean(sourceAfter),
          targetExists: Boolean(targetAfter),
          verified: false,
        },
      };
    }
    await context.emit('workspace.path.moved', this.manifest.id, { source: source.resolvedPath, target: target.resolvedPath });
    return {
      ok: true,
      summary: `Moved ${source.resolvedPath} to ${target.resolvedPath}.`,
      output: {
        source: source.resolvedPath,
        target: target.resolvedPath,
        sourceExists: false,
        targetExists: true,
        verified: true,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async deleteFileCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
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

    try {
      signal?.throwIfAborted();
      await this.beforeMutation('delete', [evaluation.resolvedPath], signal);
      signal?.throwIfAborted();
      await rm(evaluation.resolvedPath, { force: false });
    } catch (error) {
      return filesystemMutationFailure('delete', evaluation.resolvedPath, error);
    }
    const existsAfter = Boolean(await lstat(evaluation.resolvedPath).catch(() => undefined));
    if (existsAfter) {
      return {
        ok: false,
        summary: `Permanent delete was not verified: ${evaluation.resolvedPath}.`,
        error: 'delete-readback-mismatch',
        output: { path: evaluation.resolvedPath, exists: true, verified: false },
      };
    }
    await context.emit('workspace.file.deleted', this.manifest.id, {
      path: evaluation.resolvedPath,
    });

    return {
      ok: true,
      summary: `Deleted file ${evaluation.resolvedPath}.`,
      output: {
        path: evaluation.resolvedPath,
        exists: false,
        permanent: true,
        verified: true,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
    };
  }

  private async trashPathCapability(
    input: unknown,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    signal?.throwIfAborted();
    const evaluation = this.evaluate(readStringInput(input, 'path'), 'delete', context);
    if (!evaluation.allowed) return blockedResult(evaluation.message, evaluation);
    const realPathBlock = await this.blockIfRealPathEscapes(evaluation.resolvedPath, 'delete', context);
    if (realPathBlock) return realPathBlock;
    const before = await lstat(evaluation.resolvedPath).catch(() => undefined);
    if (!before) {
      return {
        ok: false,
        summary: `Trash target does not exist: ${evaluation.resolvedPath}`,
        error: 'path-not-found',
        metadata: { evaluation },
      };
    }
    if (!before.isFile() && !before.isDirectory()) {
      return {
        ok: false,
        summary: `Trash target type is unsupported: ${evaluation.resolvedPath}`,
        error: 'unsupported-entry-type',
        metadata: { evaluation },
      };
    }
    try {
      const expectedIdentity = await captureWorkspacePathIdentity(evaluation.resolvedPath, before);
      signal?.throwIfAborted();
      await this.beforeMutation('trash', [evaluation.resolvedPath], signal);
      signal?.throwIfAborted();
      const immediatelyBeforeDispatch = await captureWorkspacePathIdentity(evaluation.resolvedPath);
      if (!sameWorkspacePathIdentity(expectedIdentity, immediatelyBeforeDispatch)) {
        return {
          ok: false,
          summary: `Trash target changed before dispatch: ${evaluation.resolvedPath}.`,
          error: 'trash-target-identity-changed',
          output: {
            path: evaluation.resolvedPath,
            recycled: false,
            verified: false,
            authoritative: true,
          },
        };
      }
      await this.trashPath(evaluation.resolvedPath, before.isDirectory(), signal, expectedIdentity);
    } catch (error) {
      return filesystemMutationFailure('trash', evaluation.resolvedPath, error);
    }
    const existsAfter = Boolean(await lstat(evaluation.resolvedPath).catch(() => undefined));
    if (existsAfter) {
      return {
        ok: false,
        summary: `Recycle Bin move was not verified: ${evaluation.resolvedPath}`,
        error: 'trash-readback-mismatch',
        output: { path: evaluation.resolvedPath, exists: true, recycled: false, verified: false },
      };
    }
    await context.emit('workspace.path.trashed', this.manifest.id, {
      path: evaluation.resolvedPath,
      entryType: before.isDirectory() ? 'directory' : 'file',
    });
    return {
      ok: true,
      summary: `Moved ${evaluation.resolvedPath} to the Windows Recycle Bin.`,
      output: {
        path: evaluation.resolvedPath,
        entryType: before.isDirectory() ? 'directory' : 'file',
        exists: false,
        recycled: true,
        recoverable: true,
        verified: true,
        cancellationObservedAfterDispatch: signal?.aborted === true,
      },
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
    const ownerUnrestricted = (context as MonarchKernelContext & { ownerUnrestrictedExecution?: boolean })
      .ownerUnrestrictedExecution === true;
    const localReadOnlyRoots = this.localReadOnlyRoots ?? defaultLocalReadOnlyRoots();
    const options: MonarchFilesystemPolicyOptions & { fallbackRoot: string; allowRoot?: boolean } = {
      workspaceRoot: this.workspaceRoot,
      sandboxRoot: this.workspaceRoot,
      fallbackRoot: this.workspaceRoot,
      allowedRoots: ownerUnrestricted ? [] : [this.workspaceRoot, ...localReadOnlyRoots],
      readOnlyRoots: ownerUnrestricted ? [] : localReadOnlyRoots,
      createDirectoryRoots: ownerUnrestricted ? [] : localReadOnlyRoots,
      allowFullDiskAccess: ownerUnrestricted
        || context.getPermissionProfile().sandboxMode === 'danger-full-access',
      redZoneRoots: [...this.ownerRedZoneRootsProvider()],
      ...(ownerUnrestricted ? {
        includeDefaultRedZones: false,
        protectWorkspaceInternals: false,
      } : {}),
    };
    if (ownerUnrestricted) {
      options.redZoneRoots = [...immutableMonarchSafeRoots(this.workspaceRoot), ...this.ownerRedZoneRootsProvider()];
    }
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

async function collectInspectableFileSnapshot(
  root: string,
  options: {
    recursive: boolean;
    maxEntries: number;
    signal?: AbortSignal;
    policyGuard: WorkspaceTraversalPolicyGuard;
  },
): Promise<{ files: InspectableFileSnapshot[]; skips: InspectBatchSkip[]; truncated: boolean }> {
  const files: InspectableFileSnapshot[] = [];
  const skips: InspectBatchSkip[] = [];
  const rootInfo = await lstat(root);
  if (rootInfo.isFile()) {
    return {
      files: [{
        path: root,
        relativePath: path.basename(root),
        sizeBytes: rootInfo.size,
        modifiedMs: Math.trunc(rootInfo.mtimeMs),
      }],
      skips,
      truncated: false,
    };
  }

  const queue = [root];
  let queueIndex = 0;
  let truncated = false;
  while (queueIndex < queue.length) {
    options.signal?.throwIfAborted();
    const current = queue[queueIndex++];
    if (!current) continue;
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch (error) {
      skips.push({
        path: current,
        reason: 'directory-unreadable',
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
      continue;
    }
    children.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    for (const child of children) {
      options.signal?.throwIfAborted();
      const childPath = path.join(current, child.name);
      const policyBlock = await options.policyGuard(childPath, child.isDirectory() || child.isSymbolicLink());
      if (policyBlock) {
        skips.push({ path: childPath, reason: 'filesystem-policy-blocked', detail: policyBlock.summary.slice(0, 500) });
        continue;
      }
      if (child.isSymbolicLink()) {
        skips.push({ path: childPath, reason: 'reparse-point-not-followed' });
        continue;
      }
      if (child.isDirectory()) {
        if (options.recursive) queue.push(childPath);
        continue;
      }
      if (!child.isFile()) {
        skips.push({ path: childPath, reason: 'unsupported-filesystem-entry' });
        continue;
      }
      const childInfo = await stat(childPath).catch(() => undefined);
      if (!childInfo?.isFile()) {
        skips.push({ path: childPath, reason: 'file-metadata-unavailable' });
        continue;
      }
      if (files.length >= options.maxEntries) {
        truncated = true;
        skips.push({ path: childPath, reason: 'enumeration-limit-reached' });
        break;
      }
      files.push({
        path: childPath,
        relativePath: path.relative(root, childPath) || path.basename(childPath),
        sizeBytes: childInfo.size,
        modifiedMs: Math.trunc(childInfo.mtimeMs),
      });
    }
    if (truncated) break;
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en-US'));
  return { files, skips, truncated };
}

async function inspectFileSnapshotPage(
  files: readonly InspectableFileSnapshot[],
  options: { maxBytesPerFile: number; maxTotalContentBytes: number; signal?: AbortSignal },
): Promise<{ items: InspectBatchItem[]; skips: InspectBatchSkip[] }> {
  const items: InspectBatchItem[] = [];
  const skips: InspectBatchSkip[] = [];
  let remainingContentBytes = options.maxTotalContentBytes;
  for (const file of files) {
    options.signal?.throwIfAborted();
    const extension = path.extname(file.path).toLocaleLowerCase('en-US');
    const format = extension ? extension.slice(1) : 'text';
    const base: InspectBatchItem = {
      path: file.path,
      relativePath: file.relativePath,
      name: path.basename(file.path),
      sizeBytes: file.sizeBytes,
      modifiedMs: file.modifiedMs,
      format,
      status: 'metadata-only',
    };
    try {
      let bytes: Buffer | null = null;
      if (file.sizeBytes <= options.maxBytesPerFile && file.sizeBytes <= remainingContentBytes) {
        bytes = await readFile(file.path);
      }
      const sha256 = bytes
        ? createHash('sha256').update(bytes).digest('hex')
        : await sha256File(file.path, options.signal);
      const after = await stat(file.path);
      if (after.size !== file.sizeBytes || Math.trunc(after.mtimeMs) !== file.modifiedMs) {
        const item = { ...base, sha256, status: 'skipped' as const, reason: 'target-changed-during-inspection' };
        items.push(item);
        skips.push({ path: file.path, reason: item.reason });
        continue;
      }
      if (bytes && TEXT_FILE_EXTENSIONS.has(extension) && looksLikeUtf8Text(bytes)) {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        items.push({ ...base, sha256, status: 'read', content });
        remainingContentBytes = Math.max(0, remainingContentBytes - bytes.byteLength);
        continue;
      }
      let reason: string;
      if (UNSUPPORTED_DOCUMENT_EXTENSIONS.has(extension)) reason = `unsupported-document-format:${extension.slice(1)}`;
      else if (TEXT_FILE_EXTENSIONS.has(extension) && file.sizeBytes > options.maxBytesPerFile) reason = 'file-too-large-for-content';
      else if (TEXT_FILE_EXTENSIONS.has(extension) && file.sizeBytes > remainingContentBytes) reason = 'page-content-budget-exhausted';
      else if (TEXT_FILE_EXTENSIONS.has(extension)) reason = 'invalid-utf8-or-binary-content';
      else reason = 'binary-or-unsupported-format';
      items.push({ ...base, sha256, status: 'metadata-only', reason });
      skips.push({ path: file.path, reason });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'AbortError'
        ? 'inspection-cancelled'
        : 'file-read-failed';
      if (reason === 'inspection-cancelled') throw error;
      items.push({ ...base, status: 'skipped', reason });
      skips.push({
        path: file.path,
        reason,
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  return { items, skips };
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024, ...(signal ? { signal } : {}) });
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

function looksLikeUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function inspectBatchSnapshotId(
  root: string,
  recursive: boolean,
  files: readonly InspectableFileSnapshot[],
  skips: readonly InspectBatchSkip[],
): string {
  return createHash('sha256').update(JSON.stringify({
    root: canonicalInspectRoot(root),
    recursive,
    files: files.map((file) => [file.relativePath, file.sizeBytes, file.modifiedMs]),
    skips: skips.map((skip) => [path.relative(root, skip.path), skip.reason]),
  })).digest('hex');
}

function canonicalInspectRoot(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function encodeInspectBatchCursor(cursor: InspectBatchCursorV1): string {
  const body = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  const checksum = createHash('sha256')
    .update(`${INSPECT_BATCH_SCHEMA_VERSION}\u0000${body}`)
    .digest('hex')
    .slice(0, 32);
  return `${body}.${checksum}`;
}

function decodeInspectBatchCursor(value: string): InspectBatchCursorV1 | null {
  const [body, checksum, ...extra] = value.split('.');
  if (!body || !checksum || extra.length > 0) return null;
  const expected = createHash('sha256')
    .update(`${INSPECT_BATCH_SCHEMA_VERSION}\u0000${body}`)
    .digest('hex')
    .slice(0, 32);
  if (checksum !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<InspectBatchCursorV1>;
    if (parsed.version !== 1
      || typeof parsed.rootHash !== 'string'
      || typeof parsed.snapshotId !== 'string'
      || !Number.isInteger(parsed.index)) return null;
    return parsed as InspectBatchCursorV1;
  } catch {
    return null;
  }
}

function normalizeInspectableKnownFolder(value: string): 'desktop' | 'downloads' | null {
  const normalized = value.trim().toLocaleLowerCase('en-US');
  return normalized === 'desktop' || normalized === 'downloads' ? normalized : null;
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
    nameContains?: string;
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

/** Dependency, build and tool-state trees: never what a person means by "in the project". */
function shouldSkipSearchDirectory(name: string): boolean {
  return name.startsWith('.') || ['dist', 'build', 'out', 'coverage', '__pycache__', 'target', 'venv', 'site-packages'].includes(name);
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

function normalizeNameContains(value: string): string {
  const normalized = String(value || '').trim();
  return normalized && normalized.length <= 80 ? normalized : '';
}

function matchesEntryFilters(
  entryPath: string,
  entryType: FileEntry['type'],
  options: { entryType?: FileEntry['type']; extension?: string; nameContains?: string }
): boolean {
  if (options.entryType && options.entryType !== entryType) return false;
  if (options.extension && (entryType !== 'file' || path.extname(entryPath).toLowerCase() !== options.extension)) {
    return false;
  }
  if (options.nameContains) {
    const needle = options.nameContains.toLocaleLowerCase();
    const name = path.basename(entryPath).toLocaleLowerCase();
    if (!name.includes(needle)) return false;
  }
  return true;
}

async function copyWorkspaceTree(
  source: string,
  target: string,
  options: {
    sourcePolicyGuard?: WorkspaceTraversalPolicyGuard;
    signal?: AbortSignal;
  } = {}
): Promise<{ bytes: number; entries: number; readbackSha256: string }> {
  let bytes = 0;
  let entries = 0;
  const readbackHash = createHash('sha256');

  const visit = async (currentSource: string, currentTarget: string): Promise<void> => {
    options.signal?.throwIfAborted();
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
        options.signal?.throwIfAborted();
        await visit(path.join(currentSource, child), path.join(currentTarget, child));
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Unsupported filesystem entry: ${currentSource}`);
    bytes += info.size;
    if (bytes > MAX_COPY_BYTES) throw new Error(`Copy exceeds ${MAX_COPY_BYTES} bytes.`);
    await ensureWritableParentDirectory(currentTarget);
    options.signal?.throwIfAborted();
    await copyFile(currentSource, currentTarget);
    const [sourceReadback, targetReadback] = await Promise.all([
      readFile(currentSource),
      readFile(currentTarget),
    ]);
    if (!sourceReadback.equals(targetReadback)) {
      throw new Error(`Copy byte-for-byte verification failed: ${currentSource}`);
    }
    readbackHash.update(path.relative(source, currentSource));
    readbackHash.update('\0');
    readbackHash.update(targetReadback);
  };

  try {
    await visit(source, target);
    return { bytes, entries, readbackSha256: readbackHash.digest('hex') };
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

const execFileAsync = promisify(execFile);

async function trashWorkspacePath(
  targetPath: string,
  isDirectory: boolean,
  signal?: AbortSignal,
  expectedIdentity?: WorkspacePathIdentity,
): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('workspace.files.trash requires Windows Recycle Bin support.');
  }
  signal?.throwIfAborted();
  const request = Buffer.from(JSON.stringify({
    path: targetPath,
    kind: isDirectory ? 'directory' : 'file',
    expectedIdentity,
  }), 'utf8').toString('base64');
  const ancestorFenceSource = Buffer.from(
    WINDOWS_RECYCLE_ANCESTOR_FENCE_CSHARP,
    'utf8',
  ).toString('base64');
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      "$fenceSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MONARCH_TRASH_FENCE_SOURCE_B64))",
      "Add-Type -TypeDefinition $fenceSource -Language CSharp",
      "$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MONARCH_TRASH_REQUEST_B64)) | ConvertFrom-Json",
      "$fence = [MonarchRecycleAncestorFence]::Acquire([string]$request.path)",
      'try {',
      "$item = Get-Item -LiteralPath ([string]$request.path) -Force -ErrorAction Stop",
      "if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Trash target became a reparse point.' }",
      "$actualKind = if ($item.PSIsContainer) { 'directory' } else { 'file' }",
      "if ($actualKind -ne [string]$request.kind) { throw 'Trash target type changed before dispatch.' }",
      "if ($null -ne $request.expectedIdentity) {",
      "  $actualSize = if ($item.PSIsContainer) { 0 } else { [int64]$item.Length }",
      "  $actualCreatedMs = [DateTimeOffset]::new($item.CreationTimeUtc).ToUnixTimeMilliseconds()",
      "  $actualModifiedMs = [DateTimeOffset]::new($item.LastWriteTimeUtc).ToUnixTimeMilliseconds()",
      "  if ($actualSize -ne [int64]$request.expectedIdentity.size -or $actualCreatedMs -ne [int64]$request.expectedIdentity.createdMs -or $actualModifiedMs -ne [int64]$request.expectedIdentity.modifiedMs) { throw 'Trash target identity changed before Windows dispatch.' }",
      "}",
      "if ([string]$request.kind -eq 'directory') {",
      "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory([string]$request.path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)",
      '} else {',
      "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile([string]$request.path, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)",
      '}',
      '} finally {',
      '  if ($null -ne $fence) { $fence.Dispose() }',
      '}',
    ].join('; '),
  ], {
    env: {
      ...process.env,
      MONARCH_TRASH_REQUEST_B64: request,
      MONARCH_TRASH_FENCE_SOURCE_B64: ancestorFenceSource,
    },
    windowsHide: true,
    maxBuffer: 64 * 1024,
    ...(signal ? { signal } : {}),
  });
}

async function captureWorkspacePathIdentity(
  targetPath: string,
  existing?: Stats,
): Promise<WorkspacePathIdentity> {
  const stats = existing || await lstat(targetPath);
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error('Workspace trash target must be one regular file or directory, not a reparse point.');
  }
  return {
    realPath: await realpath(targetPath),
    kind: stats.isDirectory() ? 'directory' : 'file',
    device: stats.dev,
    inode: stats.ino,
    size: stats.isDirectory() ? 0 : stats.size,
    mode: stats.mode,
    createdMs: Math.trunc(stats.birthtimeMs),
    modifiedMs: Math.trunc(stats.mtimeMs),
  };
}

function sameWorkspacePathIdentity(
  expected: WorkspacePathIdentity,
  actual: WorkspacePathIdentity,
): boolean {
  return expected.realPath === actual.realPath
    && expected.kind === actual.kind
    && expected.device === actual.device
    && expected.inode === actual.inode
    && expected.size === actual.size
    && expected.mode === actual.mode
    && expected.createdMs === actual.createdMs
    && expected.modifiedMs === actual.modifiedMs;
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

function filesystemMutationFailure(
  operation: string,
  targetPath: string,
  error: unknown,
  secondaryPath?: string,
): MonarchExecutionResult {
  const code = filesystemErrorCode(error, `${operation}-failed`);
  return {
    ok: false,
    summary: `${operation} failed for ${targetPath}: ${errorMessage(error)}`,
    error: code,
    output: {
      path: targetPath,
      ...(secondaryPath ? { targetPath: secondaryPath } : {}),
      verified: false,
    },
  };
}

function filesystemErrorCode(error: unknown, fallback: string): string {
  const code = filesystemNodeErrorCode(error);
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk-full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission-denied';
  if (code === 'ABORT_ERR' || (error instanceof Error && error.name === 'AbortError')) return 'cancelled-before-dispatch';
  return fallback;
}

function filesystemNodeErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '').toUpperCase()
    : '';
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
  factory: (context) => createWorkspaceModule(
    context?.userWorkspaceRoot || context?.workspaceRoot
      ? { workspaceRoot: context.userWorkspaceRoot || context.workspaceRoot! }
      : {},
  ),
};

async function readFileWindow(filePath: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** A window cut on byte offsets may split a UTF-8 sequence at either edge; drop
 * the partial characters instead of emitting replacement glyphs. */
function decodeUtf8Window(buffer: Buffer, window: boolean): string {
  if (!window) return buffer.toString('utf8');
  let start = 0;
  while (start < buffer.length && start < 3 && (buffer[start]! & 0xc0) === 0x80) start++;
  let end = buffer.length;
  for (let back = 1; back <= 3 && end - back >= start; back++) {
    const byte = buffer[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (need > back) end -= back;
    break;
  }
  return buffer.subarray(start, end).toString('utf8');
}

async function countFileLines(filePath: string): Promise<number> {
  const data = await readFile(filePath);
  if (!data.length) return 0;
  let lines = 1;
  for (const byte of data) if (byte === 0x0a) lines++;
  return data[data.length - 1] === 0x0a ? lines - 1 : lines;
}

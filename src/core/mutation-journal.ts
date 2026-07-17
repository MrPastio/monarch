import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MonarchActionRollbackState,
  MonarchExecutionRequest,
  MonarchExecutionResult,
} from './contracts';
import { readDurableJson, writeDurableJson } from './durable-json';
import { nowIso } from './utils';

const MAX_BACKUP_BYTES = 1_048_576;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_BYTES = 64 * 1_048_576;
const MAX_ENTRIES = 200;
const JOURNALED_CAPABILITIES = new Set([
  'workspace.files.write',
  'workspace.files.append',
  'workspace.files.replace',
  'workspace.files.mkdir',
  'workspace.files.copy',
]);

type SnapshotKind = 'missing' | 'file' | 'directory';

interface MutationSnapshot {
  kind: SnapshotKind;
  digest: string;
  bytes: number;
  entries: number;
}

interface MutationJournalEntryV1 {
  version: 1;
  ledgerId: string;
  capabilityId: string;
  targetPath: string;
  before: MutationSnapshot;
  after?: MutationSnapshot;
  backupFile?: string;
  state: MonarchActionRollbackState;
}

interface PersistedMutationJournalV1 {
  version: 1;
  entries: MutationJournalEntryV1[];
}

export interface MutationJournalCaptureResult {
  supported: boolean;
  ok: boolean;
  state?: MonarchActionRollbackState;
  error?: string;
}

export class MonarchMutationJournal {
  private readonly entries = new Map<string, MutationJournalEntryV1>();
  private readonly memoryBackups = new Map<string, Buffer>();
  private readonly persistencePath?: string;
  private readonly backupDirectory?: string;

  constructor(
    private readonly workspaceRoot: string,
    storageDirectory?: string,
  ) {
    if (storageDirectory) {
      this.persistencePath = path.join(storageDirectory, 'journal.json');
      this.backupDirectory = path.join(storageDirectory, 'backups');
    }
    this.restore();
  }

  async capture(ledgerId: string, request: MonarchExecutionRequest): Promise<MutationJournalCaptureResult> {
    if (!request.proposalId || !JOURNALED_CAPABILITIES.has(request.capabilityId)) {
      return { supported: false, ok: true };
    }
    try {
      const targetPath = await this.resolveTarget(request);
      const before = await snapshotPath(targetPath);
      if (before.kind === 'file' && before.bytes > MAX_BACKUP_BYTES) {
        return { supported: true, ok: false, error: `Rollback snapshot exceeds ${MAX_BACKUP_BYTES} bytes.` };
      }
      if (before.kind === 'directory' && request.capabilityId !== 'workspace.files.mkdir') {
        return { supported: true, ok: false, error: 'Rollback cannot safely replace an existing directory.' };
      }

      const capturedAt = nowIso();
      const state: MonarchActionRollbackState = {
        status: 'unavailable',
        targetPath,
        capturedAt,
        updatedAt: capturedAt,
        reason: 'Action has not completed yet.',
      };
      const entry: MutationJournalEntryV1 = {
        version: 1,
        ledgerId,
        capabilityId: request.capabilityId,
        targetPath,
        before,
        state,
      };
      if (before.kind === 'file') {
        const backup = await readFile(targetPath);
        if (this.backupDirectory) {
          await mkdir(this.backupDirectory, { recursive: true });
          const backupFile = `${safeLedgerName(ledgerId)}.bin`;
          await writeFile(path.join(this.backupDirectory, backupFile), backup);
          entry.backupFile = backupFile;
        } else {
          this.memoryBackups.set(ledgerId, backup);
        }
      }
      this.entries.set(ledgerId, entry);
      this.prune();
      this.persist();
      return { supported: true, ok: true, state: cloneState(state) };
    } catch (error) {
      return { supported: true, ok: false, error: errorMessage(error) };
    }
  }

  async finalize(
    ledgerId: string,
    request: MonarchExecutionRequest,
    result: MonarchExecutionResult,
  ): Promise<MonarchActionRollbackState | null> {
    const entry = this.entries.get(ledgerId);
    if (!entry) return null;
    try {
      const resultPath = readResultPath(result);
      if (resultPath && entry.before.kind === 'missing') {
        entry.targetPath = await this.resolveCandidate(resultPath, request);
      }
      const after = await snapshotPath(entry.targetPath);
      if (!result.ok) {
        if (after.kind === entry.before.kind && after.digest === entry.before.digest) {
          return this.updateState(entry, 'unavailable', 'Action failed without changing the journaled target.');
        }
        entry.after = after;
        return this.updateState(entry, 'available', 'Action failed after a partial mutation; rollback is hash-guarded.');
      }
      if (after.kind === 'missing') {
        return this.updateState(entry, 'unavailable', 'Action reported success but the target does not exist.');
      }
      if (entry.before.kind === 'directory' && after.digest === entry.before.digest) {
        return this.updateState(entry, 'unavailable', 'Directory already existed and was not changed.');
      }
      entry.after = after;
      return this.updateState(entry, 'available', 'Rollback is guarded by the post-action content hash.');
    } catch (error) {
      return this.updateState(entry, 'unavailable', `Rollback finalization failed: ${errorMessage(error)}`);
    }
  }

  async rollback(ledgerId: string): Promise<MonarchActionRollbackState | null> {
    const entry = this.entries.get(ledgerId);
    if (!entry) return null;
    if (entry.state.status !== 'available' || !entry.after) return cloneState(entry.state);
    try {
      await this.assertInsideWorkspace(entry.targetPath);
      const current = await snapshotPath(entry.targetPath);
      if (current.kind !== entry.after.kind || current.digest !== entry.after.digest) {
        return this.updateState(entry, 'blocked', 'Target changed after the action; rollback was not applied.');
      }

      if (entry.before.kind === 'missing') {
        await rm(entry.targetPath, { recursive: current.kind === 'directory', force: false });
      } else if (entry.before.kind === 'file') {
        const backup = await this.readBackup(entry);
        if (!backup) return this.updateState(entry, 'blocked', 'Rollback backup is unavailable.');
        await writeFile(entry.targetPath, backup);
      } else {
        return this.updateState(entry, 'blocked', 'Restoring a replaced directory is not supported.');
      }

      const restored = await snapshotPath(entry.targetPath);
      if (restored.kind !== entry.before.kind || restored.digest !== entry.before.digest) {
        return this.updateState(entry, 'blocked', 'Rollback verification failed after applying the backup.');
      }
      return this.updateState(entry, 'rolled-back', 'Original workspace state was restored and verified.');
    } catch (error) {
      return this.updateState(entry, 'blocked', `Rollback failed safely: ${errorMessage(error)}`);
    }
  }

  get(ledgerId: string): MonarchActionRollbackState | null {
    const state = this.entries.get(ledgerId)?.state;
    return state ? cloneState(state) : null;
  }

  private async resolveTarget(request: MonarchExecutionRequest): Promise<string> {
    const input = asRecord(request.input);
    const raw = request.capabilityId === 'workspace.files.copy'
      ? readString(input.targetPath)
      : readString(input.path);
    if (!raw) throw new Error('Workspace mutation target path is missing.');
    return this.resolveCandidate(raw, request);
  }

  private async resolveCandidate(raw: string, request: MonarchExecutionRequest): Promise<string> {
    const candidate = path.resolve(this.workspaceRoot, raw);
    await this.assertInsideWorkspace(candidate);
    const roots = request.actionScope?.roots || [];
    if (roots.length > 0 && !roots.some((root) => isInside(path.resolve(root), candidate))) {
      throw new Error('Mutation target is outside the approved action scope.');
    }
    return candidate;
  }

  private async assertInsideWorkspace(candidate: string): Promise<void> {
    const resolvedWorkspace = await realpath(this.workspaceRoot).catch(() => path.resolve(this.workspaceRoot));
    if (!isInside(resolvedWorkspace, candidate)) throw new Error('Mutation target is outside the workspace.');
    let ancestor = candidate;
    for (;;) {
      const resolved = await realpath(ancestor).catch(() => null);
      if (resolved) {
        if (!isInside(resolvedWorkspace, resolved)) throw new Error('Mutation target resolves outside the workspace.');
        return;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error('Mutation target has no trusted workspace ancestor.');
      ancestor = parent;
    }
  }

  private async readBackup(entry: MutationJournalEntryV1): Promise<Buffer | null> {
    if (entry.backupFile && this.backupDirectory) {
      return readFile(path.join(this.backupDirectory, entry.backupFile)).catch(() => null);
    }
    return this.memoryBackups.get(entry.ledgerId) || null;
  }

  private updateState(
    entry: MutationJournalEntryV1,
    status: MonarchActionRollbackState['status'],
    reason: string,
  ): MonarchActionRollbackState {
    entry.state = {
      status,
      targetPath: entry.targetPath,
      capturedAt: entry.state.capturedAt,
      updatedAt: nowIso(),
      reason,
    };
    this.persist();
    return cloneState(entry.state);
  }

  private restore(): void {
    if (!this.persistencePath) return;
    const persisted = readDurableJson<PersistedMutationJournalV1>(this.persistencePath);
    if (!persisted || persisted.version !== 1 || !Array.isArray(persisted.entries)) return;
    for (const entry of persisted.entries.slice(-MAX_ENTRIES)) {
      if (isJournalEntry(entry)) this.entries.set(entry.ledgerId, entry);
    }
  }

  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries.values()]
      .sort((left, right) => Date.parse(left.state.updatedAt) - Date.parse(right.state.updatedAt));
    for (const entry of oldest) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (entry.state.status === 'available') continue;
      this.entries.delete(entry.ledgerId);
      this.memoryBackups.delete(entry.ledgerId);
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    writeDurableJson(this.persistencePath, {
      version: 1,
      entries: [...this.entries.values()],
    } satisfies PersistedMutationJournalV1);
  }
}

async function snapshotPath(targetPath: string): Promise<MutationSnapshot> {
  const stats = await lstat(targetPath).catch(() => null);
  if (!stats) return { kind: 'missing', digest: hashText('missing'), bytes: 0, entries: 0 };
  if (stats.isSymbolicLink()) throw new Error('Symbolic-link mutation targets are not journaled.');
  if (stats.isFile()) {
    const content = await readFile(targetPath);
    return { kind: 'file', digest: hashBuffer(content), bytes: content.byteLength, entries: 1 };
  }
  if (!stats.isDirectory()) throw new Error('Unsupported workspace target type.');

  const hash = createHash('sha256');
  let entries = 0;
  let bytes = 0;
  const visit = async (directory: string, relativeRoot: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) throw new Error('Rollback tree exceeds the entry limit.');
      const relative = path.posix.join(relativeRoot, child.name);
      const absolute = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error('Rollback tree contains a symbolic link.');
      if (child.isDirectory()) {
        hash.update(`d:${relative}\n`);
        await visit(absolute, relative);
      } else if (child.isFile()) {
        const content = await readFile(absolute);
        bytes += content.byteLength;
        if (bytes > MAX_TREE_BYTES) throw new Error('Rollback tree exceeds the byte limit.');
        hash.update(`f:${relative}:${content.byteLength}:`);
        hash.update(content);
      } else {
        throw new Error('Rollback tree contains an unsupported entry type.');
      }
    }
  };
  await visit(targetPath, '');
  return { kind: 'directory', digest: hash.digest('hex'), bytes, entries };
}

function readResultPath(result: MonarchExecutionResult): string {
  const output = asRecord(result.output);
  return readString(output.path) || readString(output.targetPath);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function safeLedgerName(ledgerId: string): string {
  return ledgerId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || hashText(ledgerId);
}

function cloneState(state: MonarchActionRollbackState): MonarchActionRollbackState {
  return { ...state };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJournalEntry(value: unknown): value is MutationJournalEntryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.version === 1
    && typeof entry.ledgerId === 'string'
    && typeof entry.capabilityId === 'string'
    && typeof entry.targetPath === 'string'
    && Boolean(entry.before)
    && Boolean(entry.state);
}

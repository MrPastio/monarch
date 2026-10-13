import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SealedFileError } from './sealed-file';
import { StoreProtectionError, decodeStoreBytes, encodeStoreText, storeProtection, type StoreProtection } from './store-protection';

export interface DurableJsonFileQuarantine {
  code: 'invalid-json' | 'invalid-document';
  /** Where the damaged bytes were moved, unchanged. */
  quarantinePath: string;
}

export interface DurableJsonFileOptions<T> {
  createEmpty: () => T;
  validate: (value: unknown) => asserts value is T;
  /**
   * Opt-in for a store whose whole feature would otherwise stop on one damaged
   * file: a file that does not parse or validate is moved aside byte for byte
   * (under the lock, after a re-check) and the store continues from empty.
   * Nothing from the damaged file is used. I/O errors still fail closed.
   */
  onQuarantine?: (info: DurableJsonFileQuarantine) => void;
  /**
   * Personal data: the file follows Monarch Security storage protection —
   * sealed on disk, kept only in memory for the session without OS
   * encryption, or plain when the person turned encryption off. A plain file
   * from an earlier version is replaced by a sealed one right after it is read.
   */
  sensitive?: { storeId: string };
  lockTimeoutMs?: number;
  lockTtlMs?: number;
  retryDelayMs?: number;
  jsonSpace?: number;
  now?: () => Date;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface WindowsRenameRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  renameFile?: (source: string, target: string) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface AtomicFileWriteOptions {
  processId?: number;
  assertOwned?: () => Promise<void>;
}

export interface DurableJsonAtomicWriteOptions extends AtomicFileWriteOptions {
  jsonSpace?: number;
}

interface DurableJsonLock {
  schemaVersion: 'monarch.durable-json-lock.v1';
  ownerId: string;
  pid: number;
  createdAt: string;
  expiresAt: string;
}

export class DurableJsonFileError extends Error {
  readonly code: string;
  readonly filePath: string;

  constructor(code: string, message: string, filePath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableJsonFileError';
    this.code = code;
    this.filePath = filePath;
  }
}

/**
 * Strict local JSON persistence with one process queue, a cross-process lease,
 * fsync-before-rename, and fail-closed validation. It never converts an I/O or
 * corruption error into an empty document silently; a store that opts into
 * `onQuarantine` gets its damaged file moved aside, unchanged, and reported.
 */
export class DurableJsonFile<T> {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly protection: StoreProtection | undefined;
  private sessionDocument: T | undefined;
  private sealingScheduled = false;
  private readonly options: Required<Omit<DurableJsonFileOptions<T>, 'createEmpty' | 'validate' | 'onQuarantine' | 'sensitive'>>
    & Pick<DurableJsonFileOptions<T>, 'createEmpty' | 'validate' | 'onQuarantine' | 'sensitive'>;
  private queue: Promise<void> = Promise.resolve();
  /** Last validated document and the file identity it came from. Every read
   * used to read, parse, validate and clone the whole file: 75 ms per Turn
   * lookup on a 3.7 MB turns.v1.json, about 10 s of each startup. */
  private cache: { mtimeNs: bigint; size: bigint; document: T } | undefined;

  constructor(filePathInput: string, options: DurableJsonFileOptions<T>) {
    if (typeof filePathInput !== 'string' || !filePathInput.trim()) {
      throw new DurableJsonFileError('invalid-path', 'Durable JSON file path is required.', '');
    }
    this.filePath = path.resolve(filePathInput);
    this.lockPath = `${this.filePath}.lock`;
    this.protection = options.sensitive ? storeProtection() : undefined;
    this.options = {
      ...options,
      lockTimeoutMs: normalizePositive(options.lockTimeoutMs, 5_000),
      lockTtlMs: normalizePositive(options.lockTtlMs, 30_000),
      retryDelayMs: normalizePositive(options.retryDelayMs, 25),
      jsonSpace: normalizeJsonSpace(options.jsonSpace, 2),
      now: options.now || (() => new Date()),
      pid: normalizePositive(options.pid, process.pid),
      isProcessAlive: options.isProcessAlive || processIsAlive,
    };
  }

  /** Session-only protection: the document lives in memory, nothing touches disk. */
  private get sessionOnly(): boolean {
    return this.protection?.mode === 'session';
  }

  private sessionCurrent(): T {
    if (!this.sessionDocument) this.sessionDocument = deepFreeze(cloneJson(this.options.createEmpty()));
    return this.sessionDocument;
  }

  read(): Promise<T> {
    return this.enqueue(() => this.readUnlocked(false));
  }

  /** The current document without a copy, deep-frozen: for callers that only
   * read and copy what they keep. Still revalidated whenever the file changed. */
  readShared(): Promise<Readonly<T>> {
    return this.enqueue(() => this.currentDocument(false));
  }

  mutate<R>(mutator: (document: T) => { changed: boolean; value: R }): Promise<R> {
    if (this.sessionOnly) {
      return this.enqueue(() => {
        const document = cloneJson(this.sessionCurrent());
        const result = mutator(document);
        if (result.changed) {
          this.options.validate(document);
          this.sessionDocument = deepFreeze(document);
        }
        return cloneJson(result.value);
      });
    }
    return this.enqueue(async () => {
      await ensureParentDirectory(this.filePath);
      const lease = await this.acquireLock();
      try {
        const document = await this.readUnlocked(true);
        const result = mutator(document);
        if (result.changed) {
          this.options.validate(document);
          const text = `${JSON.stringify(document, null, this.options.jsonSpace)}\n`;
          await writeFileAtomically(this.filePath, this.options.sensitive
            ? encodeStoreText(text, this.options.sensitive.storeId, path.basename(this.filePath), this.protection)
            : text, { processId: this.options.pid, assertOwned: lease.assertOwned });
          this.cache = undefined;
          const written = await stat(this.filePath, { bigint: true }).catch(() => null);
          if (written) this.cache = { mtimeNs: written.mtimeNs, size: written.size, document: deepFreeze(document) };
        }
        return cloneJson(result.value);
      } finally {
        await lease.release();
      }
    });
  }

  private enqueue<R>(operation: () => R | Promise<R>): Promise<R> {
    const running = this.queue.then(operation, operation);
    this.queue = running.then(() => undefined, () => undefined);
    return running;
  }

  private async readUnlocked(locked: boolean): Promise<T> {
    return cloneJson(await this.currentDocument(locked));
  }

  /** `locked`: the caller already holds the file lease (the lock is not reentrant). */
  private async currentDocument(locked: boolean): Promise<T> {
    if (this.sessionOnly) return this.sessionCurrent();
    const identity = await this.identity();
    if (!identity) { this.cache = undefined; return deepFreeze(cloneJson(this.options.createEmpty())); }
    if (this.cache && this.cache.mtimeNs === identity.mtimeNs && this.cache.size === identity.size) return this.cache.document;
    let document: T;
    try {
      document = await this.parseFromDisk();
    } catch (error) {
      if (!this.options.onQuarantine || !isCorruption(error)) throw error;
      return locked ? this.quarantineCorrupt() : this.withLease(() => this.quarantineCorrupt());
    }
    this.cache = { mtimeNs: identity.mtimeNs, size: identity.size, document: deepFreeze(document) };
    return this.cache.document;
  }

  /** A plain file read under sealed protection is rewritten sealed once. */
  private scheduleSealing(): void {
    if (this.sealingScheduled) return;
    this.sealingScheduled = true;
    void this.mutate(() => ({ changed: true, value: undefined }))
      .catch(() => undefined)
      .finally(() => { this.sealingScheduled = false; });
  }

  private async identity() {
    return stat(this.filePath, { bigint: true }).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return null;
      throw new DurableJsonFileError('read-failed', `Unable to read durable JSON file ${this.filePath}.`, this.filePath, { cause: error });
    });
  }

  private async withLease<R>(operation: () => Promise<R>): Promise<R> {
    await ensureParentDirectory(this.filePath);
    const lease = await this.acquireLock();
    try { return await operation(); } finally { await lease.release(); }
  }

  /** Under the lease: another writer may have replaced the file meanwhile, so
   * it is read again and moved aside only if it is still damaged. */
  private async quarantineCorrupt(): Promise<T> {
    const identity = await this.identity();
    if (!identity) { this.cache = undefined; return deepFreeze(cloneJson(this.options.createEmpty())); }
    let code: DurableJsonFileQuarantine['code'];
    try {
      const document = await this.parseFromDisk();
      this.cache = { mtimeNs: identity.mtimeNs, size: identity.size, document: deepFreeze(document) };
      return this.cache.document;
    } catch (error) {
      if (!isCorruption(error)) throw error;
      code = (error as DurableJsonFileError).code as DurableJsonFileQuarantine['code'];
    }
    const stamp = this.options.now().toISOString().replace(/[:.]/gu, '-');
    const quarantinePath = `${this.filePath}.corrupt-${stamp}-${randomUUID().slice(0, 8)}`;
    await renameWithWindowsRetry(this.filePath, quarantinePath);
    this.cache = undefined;
    try { this.options.onQuarantine?.({ code, quarantinePath }); } catch { /* reporting must not undo recovery */ }
    return deepFreeze(cloneJson(this.options.createEmpty()));
  }

  private async parseFromDisk(): Promise<T> {
    let raw: string;
    try {
      const bytes = await readFile(this.filePath);
      if (this.options.sensitive) {
        const decoded = decodeStoreBytes(bytes, this.options.sensitive.storeId, path.basename(this.filePath), this.protection);
        raw = decoded.text;
        if (decoded.needsSealing) this.scheduleSealing();
      } else {
        raw = bytes.toString('utf8');
      }
    } catch (error) {
      if (error instanceof StoreProtectionError || error instanceof SealedFileError) {
        // A sealed file that cannot be opened is never treated as damaged and
        // replaced: the store stops instead of starting empty over real data.
        throw new DurableJsonFileError('read-failed',
          `Durable JSON file ${this.filePath} is sealed and cannot be opened (${error.message}).`, this.filePath, { cause: error });
      }
      if (errorCode(error) === 'ENOENT') return cloneJson(this.options.createEmpty());
      throw new DurableJsonFileError(
        'read-failed',
        `Unable to read durable JSON file ${this.filePath}.`,
        this.filePath,
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new DurableJsonFileError(
        'invalid-json',
        `Durable JSON file ${this.filePath} contains invalid JSON and was not modified.`,
        this.filePath,
        { cause: error },
      );
    }
    try {
      this.options.validate(parsed);
      return parsed as T;
    } catch (error) {
      throw new DurableJsonFileError(
        'invalid-document',
        `Durable JSON file ${this.filePath} failed schema validation and was not modified.`,
        this.filePath,
        { cause: error },
      );
    }
  }

  private async acquireLock(): Promise<{
    assertOwned: () => Promise<void>;
    release: () => Promise<void>;
  }> {
    const ownerId = `durable_json_${randomUUID()}`;
    const deadline = Date.now() + this.options.lockTimeoutMs;
    while (true) {
      const now = this.options.now();
      const lock: DurableJsonLock = {
        schemaVersion: 'monarch.durable-json-lock.v1',
        ownerId,
        pid: this.options.pid,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.options.lockTtlMs).toISOString(),
      };
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      // The lock appears complete or not at all: the owner is written to a
      // private file first, then hard-linked into place (atomic, and failing
      // with EEXIST like 'wx'). Created with 'wx' and written afterwards, a
      // process that exited in between left an empty lock no one could
      // attribute, and every operation on the store timed out until its TTL.
      const pendingPath = `${this.lockPath}.${ownerId}.pending`;
      try {
        handle = await open(pendingPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
          await link(pendingPath, this.lockPath);
        } catch (error) {
          // A volume without hard links (FAT/exFAT, some network shares)
          // keeps the previous create-then-write lock.
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(errorCode(error) ?? '')) throw error;
          handle = await open(this.lockPath, 'wx', 0o600);
          await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
          await handle.sync();
          await handle.close();
          handle = undefined;
        } finally {
          await unlinkWithWindowsRetry(pendingPath).catch(() => undefined);
        }
        return {
          assertOwned: async () => {
            const current = await readLock(this.lockPath);
            if (!current || current.ownerId !== ownerId || Date.parse(current.expiresAt) <= Date.now()) {
              throw new DurableJsonFileError(
                'lock-lost',
                `Durable JSON lock ownership was lost for ${this.filePath}.`,
                this.filePath,
              );
            }
          },
          release: async () => {
            const current = await readLock(this.lockPath).catch(() => null);
            if (current?.ownerId === ownerId) await unlinkWithWindowsRetry(this.lockPath);
          },
        };
      } catch (error) {
        if (handle) await handle.close().catch(() => undefined);
        const code = errorCode(error);
        if (code !== 'EEXIST') {
          if (isTransientWindowsError(code) && Date.now() < deadline) {
            await delay(Math.min(this.options.retryDelayMs, Math.max(1, deadline - Date.now())));
            continue;
          }
          throw new DurableJsonFileError(
            'lock-create-failed',
            `Unable to acquire durable JSON lock ${this.lockPath}.`,
            this.filePath,
            { cause: error },
          );
        }
        const raw = await readFile(this.lockPath, 'utf8').catch(() => null);
        const existing = raw === null ? null : parseLock(raw);
        const metadata = await stat(this.lockPath).catch(() => null);
        // A lock that reads but does not parse was never written by a live
        // owner (locks appear complete): a crash left it. One that cannot be
        // read right now (held open, gone) is judged by age as before.
        const stale = existing
          ? Date.parse(existing.expiresAt) <= Date.now() || !this.options.isProcessAlive(existing.pid)
          : raw !== null || Boolean(metadata && Date.now() - metadata.mtimeMs >= this.options.lockTtlMs);
        if (stale) {
          await unlinkWithWindowsRetry(this.lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new DurableJsonFileError(
            'lock-timeout',
            `Timed out waiting for durable JSON lock ${this.lockPath}.`,
            this.filePath,
          );
        }
        await delay(Math.min(this.options.retryDelayMs, Math.max(1, deadline - Date.now())));
      }
    }
  }
}

export async function writeDurableJsonAtomically(
  filePathInput: string,
  value: unknown,
  options: DurableJsonAtomicWriteOptions = {},
): Promise<void> {
  await writeFileAtomically(
    filePathInput,
    `${JSON.stringify(value, null, normalizeJsonSpace(options.jsonSpace, 2))}\n`,
    options,
  );
}

export async function writeFileAtomically(
  filePathInput: string,
  content: string | Uint8Array,
  options: AtomicFileWriteOptions = {},
): Promise<void> {
  const filePath = path.resolve(filePathInput);
  await ensureParentDirectory(filePath);
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${options.processId || process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.assertOwned?.();
    await renameWithWindowsRetry(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlinkWithWindowsRetry(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Node's recursive mkdir answers EPERM for a drive root on Windows
 * (`mkdir('D:\', { recursive: true })`), so a file placed directly in a
 * root could never be written. A root needs no creating. */
export async function ensureParentDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(path.resolve(filePath));
  if (path.parse(directory).root === directory) return;
  await mkdir(directory, { recursive: true });
}

async function readLock(filePath: string): Promise<DurableJsonLock | null> {
  return parseLock(await readFile(filePath, 'utf8'));
}

function parseLock(raw: string): DurableJsonLock | null {
  try {
    const value = JSON.parse(raw) as Partial<DurableJsonLock>;
    if (
      value.schemaVersion !== 'monarch.durable-json-lock.v1'
      || typeof value.ownerId !== 'string'
      || !Number.isSafeInteger(value.pid)
      || typeof value.createdAt !== 'string'
      || typeof value.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(value.expiresAt))
    ) return null;
    return value as DurableJsonLock;
  } catch {
    return null;
  }
}

function isCorruption(error: unknown): boolean {
  return error instanceof DurableJsonFileError && (error.code === 'invalid-json' || error.code === 'invalid-document');
}

export async function renameWithWindowsRetry(
  source: string,
  target: string,
  options: WindowsRenameRetryOptions = {},
): Promise<void> {
  // ~1.6 s in all. A scanner or indexer that opened the fresh file without
  // FILE_SHARE_DELETE holds it longer than the former 224 ms; live, the rename
  // of turns.v1.json still failed with EPERM after that budget.
  const attempts = normalizePositive(options.attempts, 12);
  const baseDelayMs = normalizePositive(options.baseDelayMs, 25);
  const renameFile = options.renameFile || rename;
  const sleep = options.sleep || delay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await renameFile(source, target);
      return;
    } catch (error) {
      if (!isTransientWindowsError(errorCode(error)) || attempt === attempts - 1) throw error;
      await sleep(baseDelayMs * (attempt + 1));
    }
  }
}

async function unlinkWithWindowsRetry(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await unlink(filePath);
      return;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      if (!isTransientWindowsError(errorCode(error)) || attempt === 7) throw error;
      await delay(8 * (attempt + 1));
    }
  }
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function normalizeJsonSpace(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), 10)
    : fallback;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function isTransientWindowsError(code: string | undefined): boolean {
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM';
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : undefined;
}

function deepFreeze<V>(value: V): V {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function cloneJson<V>(value: V): V {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as V;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

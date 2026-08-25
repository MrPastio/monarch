import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface DurableJsonFileOptions<T> {
  createEmpty: () => T;
  validate: (value: unknown) => asserts value is T;
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
 * corruption error into an empty document.
 */
export class DurableJsonFile<T> {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly options: Required<Omit<DurableJsonFileOptions<T>, 'createEmpty' | 'validate'>>
    & Pick<DurableJsonFileOptions<T>, 'createEmpty' | 'validate'>;
  private queue: Promise<void> = Promise.resolve();

  constructor(filePathInput: string, options: DurableJsonFileOptions<T>) {
    if (typeof filePathInput !== 'string' || !filePathInput.trim()) {
      throw new DurableJsonFileError('invalid-path', 'Durable JSON file path is required.', '');
    }
    this.filePath = path.resolve(filePathInput);
    this.lockPath = `${this.filePath}.lock`;
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

  read(): Promise<T> {
    return this.enqueue(() => this.readUnlocked());
  }

  mutate<R>(mutator: (document: T) => { changed: boolean; value: R }): Promise<R> {
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const lease = await this.acquireLock();
      try {
        const document = await this.readUnlocked();
        const result = mutator(document);
        if (result.changed) {
          this.options.validate(document);
          await writeDurableJsonAtomically(this.filePath, document, {
            processId: this.options.pid,
            assertOwned: lease.assertOwned,
            jsonSpace: this.options.jsonSpace,
          });
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

  private async readUnlocked(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
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
      return cloneJson(parsed);
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
      try {
        handle = await open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
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
        const existing = await readLock(this.lockPath).catch(() => null);
        const metadata = await stat(this.lockPath).catch(() => null);
        const stale = existing
          ? Date.parse(existing.expiresAt) <= Date.now() || !this.options.isProcessAlive(existing.pid)
          : Boolean(metadata && Date.now() - metadata.mtimeMs >= this.options.lockTtlMs);
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
  await mkdir(path.dirname(filePath), { recursive: true });
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

async function readLock(filePath: string): Promise<DurableJsonLock | null> {
  const raw = await readFile(filePath, 'utf8');
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

export async function renameWithWindowsRetry(
  source: string,
  target: string,
  options: WindowsRenameRetryOptions = {},
): Promise<void> {
  const attempts = normalizePositive(options.attempts, 8);
  const baseDelayMs = normalizePositive(options.baseDelayMs, 8);
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

function cloneJson<V>(value: V): V {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as V;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

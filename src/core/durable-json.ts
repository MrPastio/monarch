import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export class DurableJsonSyncError extends Error {
  readonly code: string;
  readonly filePath: string;

  constructor(code: string, message: string, filePath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DurableJsonSyncError';
    this.code = code;
    this.filePath = filePath;
  }
}

export interface SyncWindowsRenameRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  renameFile?: (source: string, target: string) => void;
  sleep?: (milliseconds: number) => void;
}

export interface WriteDurableJsonOptions extends SyncWindowsRenameRetryOptions {
  processId?: number;
}

export function readDurableJson<T>(filePathInput: string): T | null {
  const filePath = normalizePath(filePathInput);
  let raw: string;
  try {
    if (!existsSync(filePath)) return null;
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new DurableJsonSyncError(
      'read-failed',
      `Unable to read durable JSON file ${filePath}.`,
      filePath,
      { cause: error },
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new DurableJsonSyncError(
      'invalid-json',
      `Durable JSON file ${filePath} contains invalid JSON and was not modified.`,
      filePath,
      { cause: error },
    );
  }
}

export function tryReadDurableJson<T>(filePath: string): T | null {
  try {
    return readDurableJson<T>(filePath);
  } catch {
    return null;
  }
}

export function writeDurableJson(
  filePathInput: string,
  value: unknown,
  options: WriteDurableJsonOptions = {},
): void {
  const filePath = normalizePath(filePathInput);
  let serialized: string;
  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json !== 'string') throw new TypeError('value is not JSON serializable');
    serialized = `${json}\n`;
  } catch (error) {
    throw new DurableJsonSyncError(
      'serialize-failed',
      `Unable to serialize durable JSON file ${filePath}.`,
      filePath,
      { cause: error },
    );
  }

  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${options.processId || process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameWithWindowsRetrySync(temporaryPath, filePath, options);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the primary write failure.
      }
    }
    removeWithWindowsRetrySync(temporaryPath);
    throw new DurableJsonSyncError(
      'write-failed',
      `Unable to write durable JSON file ${filePath}.`,
      filePath,
      { cause: error },
    );
  }
}

export function tryWriteDurableJson(filePath: string, value: unknown): boolean {
  try {
    writeDurableJson(filePath, value);
    return true;
  } catch {
    return false;
  }
}

export function renameWithWindowsRetrySync(
  source: string,
  target: string,
  options: SyncWindowsRenameRetryOptions = {},
): void {
  const attempts = normalizePositive(options.attempts, 8);
  const baseDelayMs = normalizePositive(options.baseDelayMs, 8);
  const renameFile = options.renameFile || renameSync;
  const sleep = options.sleep || sleepSync;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameFile(source, target);
      return;
    } catch (error) {
      if (!isTransientWindowsError(errorCode(error)) || attempt === attempts - 1) throw error;
      sleep(baseDelayMs * (attempt + 1));
    }
  }
}

function removeWithWindowsRetrySync(filePath: string): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(filePath, { force: true });
      return;
    } catch (error) {
      if (!isTransientWindowsError(errorCode(error)) || attempt === 7) return;
      sleepSync(8 * (attempt + 1));
    }
  }
}

function normalizePath(filePathInput: string): string {
  if (typeof filePathInput !== 'string' || !filePathInput.trim()) {
    throw new DurableJsonSyncError('invalid-path', 'Durable JSON file path is required.', '');
  }
  return path.resolve(filePathInput);
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isTransientWindowsError(code: string | undefined): boolean {
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM';
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : undefined;
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

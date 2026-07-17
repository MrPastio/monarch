import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PAIRING_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const PAIRING_ATTEMPT_LIMIT = 5;
export const TRANSIENT_LOCK_TIMEOUT_MS = 3_000;
export const TRANSIENT_LOCK_STALE_MS = 30_000;

export interface TelegramPairing {
  chatId: number;
  userId: number;
  username?: string;
  pairedAt: string;
}

export interface TelegramReminder {
  id: string;
  chatId: number;
  text: string;
  dueAt: string;
  createdAt: string;
}

export interface TelegramState {
  offset: number;
  pairings: TelegramPairing[];
  reminders: TelegramReminder[];
  remotePaused: boolean;
  pairingAttempts: Record<string, PairingAttemptWindow>;
}

export interface PairingAttemptWindow {
  attempts: number[];
  blockedUntil: number;
}

interface TelegramPairingCodeSnapshot {
  code: string;
  expiresAt: string;
}

interface TelegramFileLock {
  pid: number;
  token: string;
  createdAt: string;
}

export function defaultTelegramState(remotePaused: boolean): TelegramState {
  return { offset: 0, pairings: [], reminders: [], remotePaused, pairingAttempts: {} };
}

export function pairingAttemptKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

export function readPairingAttempts(value: unknown): Record<string, PairingAttemptWindow> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const now = Date.now();
  const result: Record<string, PairingAttemptWindow> = {};
  for (const [key, rawWindow] of Object.entries(value).slice(0, 512)) {
    if (!/^-?\d+:-?\d+$/.test(key) || !rawWindow || typeof rawWindow !== 'object' || Array.isArray(rawWindow)) continue;
    const record = rawWindow as Partial<PairingAttemptWindow>;
    const blockedUntil = typeof record.blockedUntil === 'number' && Number.isFinite(record.blockedUntil) ? record.blockedUntil : 0;
    const attempts = Array.isArray(record.attempts)
      ? record.attempts
        .filter((attempt): attempt is number => typeof attempt === 'number' && Number.isFinite(attempt) && attempt > 0 && now - attempt < PAIRING_ATTEMPT_WINDOW_MS)
        .slice(-PAIRING_ATTEMPT_LIMIT)
      : [];
    if (blockedUntil > now) result[key] = { attempts: [], blockedUntil };
    else if (attempts.length) result[key] = { attempts, blockedUntil: 0 };
  }
  return result;
}

export async function acquireFileLock(filePath: string, waitMs: number, staleMs: number): Promise<string | null> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + Math.max(0, waitMs);
  let staleRecoveries = 0;
  while (true) {
    const token = randomUUID();
    const lock: TelegramFileLock = {
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await open(filePath, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const existing = await readFileLock(filePath);
      if (isStaleFileLock(existing, staleMs) && staleRecoveries < 2) {
        staleRecoveries += 1;
        await unlink(filePath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(30);
    }
  }
}

export async function releaseFileLock(filePath: string, token: string): Promise<void> {
  const lock = await readFileLock(filePath);
  if (lock?.token === token) {
    await unlink(filePath).catch(() => undefined);
  }
}

export function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

export async function readPairingSnapshot(filePath: string): Promise<TelegramPairingCodeSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<TelegramPairingCodeSnapshot>;
    return typeof parsed.code === 'string' && typeof parsed.expiresAt === 'string'
      ? { code: parsed.code, expiresAt: parsed.expiresAt }
      : null;
  } catch {
    return null;
  }
}

export async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

export function validPairing(value: unknown): value is TelegramPairing {
  const item = value as TelegramPairing;
  return Boolean(item && Number.isSafeInteger(item.chatId) && Number.isSafeInteger(item.userId) && typeof item.pairedAt === 'string');
}

export function validReminder(value: unknown): value is TelegramReminder {
  const item = value as TelegramReminder;
  return Boolean(
    item
    && typeof item.id === 'string'
    && Boolean(item.id.trim())
    && Number.isSafeInteger(item.chatId)
    && typeof item.text === 'string'
    && Boolean(item.text.trim())
    && typeof item.dueAt === 'string'
    && Number.isFinite(Date.parse(item.dueAt))
  );
}

async function readFileLock(filePath: string): Promise<TelegramFileLock | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Partial<TelegramFileLock>;
    return Number.isSafeInteger(parsed.pid) && typeof parsed.token === 'string' && typeof parsed.createdAt === 'string'
      ? { pid: Number(parsed.pid), token: parsed.token, createdAt: parsed.createdAt }
      : null;
  } catch {
    return null;
  }
}

function isStaleFileLock(lock: TelegramFileLock | null, staleMs: number): boolean {
  if (!lock) return true;
  const age = Date.now() - Date.parse(lock.createdAt);
  if (!Number.isFinite(age) || age > staleMs) return true;
  return !isProcessAlive(lock.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPERM');
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EEXIST');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

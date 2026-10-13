import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeDurableJsonAtomically } from '../../core/durable-json-file';

export const PAIRING_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const PAIRING_ATTEMPT_LIMIT = 5;
export const TRANSIENT_LOCK_TIMEOUT_MS = 3_000;
export const TRANSIENT_LOCK_STALE_MS = 30_000;

export interface TelegramPairing {
  chatId: number;
  userId: number;
  username?: string;
  pairedAt: string;
  /** Telegram message that durably created this pairing; used only for exact replay. */
  sourceMessageId?: number;
}

export interface TelegramReminder {
  threadId?: number;
  pairingEpoch?: string;
  deliveryState?: 'attempting' | 'uncertain';
  id: string;
  chatId: number;
  text: string;
  dueAt: string;
  createdAt: string;
}

export interface TelegramPendingTaskDelivery {
  threadId?: number;
  pairingEpoch?: string;
  clientRequestId: string;
  turnClientRequestId: string;
  turnId: string;
  chatId: number;
  userId: number;
  sourceMessageId: number;
  progressMessageId: number;
  /** Digest of a deterministic multipart result plan; never stores result text. */
  deliveryDigest?: string;
  /** Number of tail parts durably acknowledged before a restart. */
  deliveredPartCount?: number;
  /** Last content-free Turn phase projected into the Telegram progress card. */
  projectedTurnStatus?: 'accepted' | 'routing' | 'answering' | 'running';
  privacyMode: 'persistent';
  createdAt: string;
}

export interface TelegramArtifactEgressOffer {
  id: string;
  turnId: string;
  taskId: string;
  artifactId: string;
  chatId: number;
  userId: number;
  pairingEpoch: string;
  messageId: number;
  name: string;
  checksum: string;
  status: 'offered' | 'attempting' | 'delivered' | 'uncertain';
  createdAt: string;
  expiresAt: string;
  permitDigest?: string;
  sizeBytes?: number;
  mimeType?: string;
  telegramMessageId?: number;
}

export interface TelegramState {
  offset: number;
  pairings: TelegramPairing[];
  reminders: TelegramReminder[];
  pendingTaskDeliveries: TelegramPendingTaskDelivery[];
  artifactEgressOffers: TelegramArtifactEgressOffer[];
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
  return { offset: 0, pairings: [], reminders: [], pendingTaskDeliveries: [], artifactEgressOffers: [], remotePaused, pairingAttempts: {} };
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
  await writeDurableJsonAtomically(filePath, value);
}

export function validPairing(value: unknown): value is TelegramPairing {
  const item = value as TelegramPairing;
  return Boolean(
    item
    && Number.isSafeInteger(item.chatId)
    && item.chatId !== 0
    && Number.isSafeInteger(item.userId)
    && item.userId > 0
    && typeof item.pairedAt === 'string'
    && Number.isFinite(Date.parse(item.pairedAt))
    && (item.sourceMessageId === undefined
      || Number.isSafeInteger(item.sourceMessageId) && item.sourceMessageId > 0)
    && (item.username === undefined
      || (typeof item.username === 'string' && item.username.length >= 1 && item.username.length <= 64))
  );
}

export function validReminder(value: unknown): value is TelegramReminder {
  const item = value as TelegramReminder;
  return Boolean(
    item
    && (item.threadId === undefined || Number.isSafeInteger(item.threadId) && item.threadId >= 0)
    && (item.pairingEpoch === undefined || typeof item.pairingEpoch === 'string' && item.pairingEpoch.length > 0 && item.pairingEpoch.length <= 128)
    && (item.deliveryState === undefined || item.deliveryState === 'attempting' || item.deliveryState === 'uncertain')
    && typeof item.id === 'string'
    && Boolean(item.id.trim())
    && Number.isSafeInteger(item.chatId)
    && typeof item.text === 'string'
    && Boolean(item.text.trim())
    && typeof item.dueAt === 'string'
    && Number.isFinite(Date.parse(item.dueAt))
  );
}

export function validPendingTaskDelivery(value: unknown): value is TelegramPendingTaskDelivery {
  const item = value as TelegramPendingTaskDelivery;
  const validDeliveryCursor = Boolean(item) && (
    item.deliveryDigest === undefined && item.deliveredPartCount === undefined
    || /^sha256:[a-f0-9]{64}$/u.test(String(item.deliveryDigest))
      && Number.isSafeInteger(item.deliveredPartCount)
      && Number(item.deliveredPartCount) >= 0
  );
  return Boolean(
    item
    && /^[A-Za-z0-9._:-]{1,256}$/u.test(item.clientRequestId)
    && /^[A-Za-z0-9._:-]{1,256}$/u.test(item.turnClientRequestId)
    && /^[A-Za-z0-9._:-]{1,256}$/u.test(item.turnId)
    && (item.threadId === undefined || Number.isSafeInteger(item.threadId) && item.threadId >= 0)
    && (item.pairingEpoch === undefined || typeof item.pairingEpoch === 'string' && item.pairingEpoch.length > 0 && item.pairingEpoch.length <= 128)
    && Number.isSafeInteger(item.chatId)
    && Number.isSafeInteger(item.userId)
    && Number.isSafeInteger(item.sourceMessageId)
    && item.sourceMessageId > 0
    && Number.isSafeInteger(item.progressMessageId)
    && item.progressMessageId > 0
    && validDeliveryCursor
    && (item.projectedTurnStatus === undefined
      || ['accepted', 'routing', 'answering', 'running'].includes(item.projectedTurnStatus))
    && item.privacyMode === 'persistent'
    && typeof item.createdAt === 'string'
    && Number.isFinite(Date.parse(item.createdAt))
  );
}

export function validArtifactEgressOffer(value: unknown): value is TelegramArtifactEgressOffer {
  const item = value as TelegramArtifactEgressOffer;
  const hasAttempt = item?.status !== 'offered';
  return Boolean(
    item
    && /^telegram_artifact_offer_[a-f0-9]{24}$/u.test(item.id)
    && /^[A-Za-z0-9._:-]{1,256}$/u.test(item.turnId)
    && /^[A-Za-z0-9._:-]{1,256}$/u.test(item.taskId)
    && /^agent_artifact_[A-Za-z0-9_-]{8,128}$/u.test(item.artifactId)
    && Number.isSafeInteger(item.chatId) && item.chatId !== 0
    && Number.isSafeInteger(item.userId) && item.userId > 0
    && typeof item.pairingEpoch === 'string' && Number.isFinite(Date.parse(item.pairingEpoch))
    && Number.isSafeInteger(item.messageId) && item.messageId > 0
    && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 120
    && !/[\\/\u0000-\u001F\u007F]/u.test(item.name)
    && /^sha256:[a-f0-9]{64}$/u.test(item.checksum)
    && ['offered', 'attempting', 'delivered', 'uncertain'].includes(item.status)
    && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
    && typeof item.expiresAt === 'string' && Number.isFinite(Date.parse(item.expiresAt))
    && (!hasAttempt || (
      /^sha256:[a-f0-9]{64}$/u.test(String(item.permitDigest))
      && Number.isSafeInteger(item.sizeBytes) && Number(item.sizeBytes) > 0
      && Number(item.sizeBytes) <= 8 * 1024 * 1024
      && typeof item.mimeType === 'string' && item.mimeType.length > 0 && item.mimeType.length <= 120
    ))
    && (item.telegramMessageId === undefined
      || Number.isSafeInteger(item.telegramMessageId) && item.telegramMessageId > 0)
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

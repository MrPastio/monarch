import { isSealed, openBytes, sealBytes } from './sealed-file';

/** How runtime stores keep personal data on disk (Monarch Security stage 3).
 *
 * Desktop starts the runtime with MONARCH_STORE_PROTECTION=desktop and, when it
 * has a profile data key, MONARCH_STORE_KEY (a key derived for the runtime
 * only). The mode follows the person's storage.encryption level.
 * The key is read once and removed from this process's environment, so the
 * Oscar backend and other children never inherit it.
 *
 *   sealed   files are AES-256-GCM sealed files; a plain file left by an earlier
 *            version is read once and replaced by a sealed one on the next write
 *   session  no OS encryption: sensitive stores live in memory for this session
 *            and nothing is written (owner decision 2026-10-12)
 *   plain    the person turned storage encryption off, or the runtime was
 *            started without Desktop (development, tests); sealed files are
 *            still read while the key is available
 */
export type StoreProtectionMode = 'sealed' | 'session' | 'plain';

export interface StoreProtection {
  mode: StoreProtectionMode;
  /** Present whenever Desktop provided a key, also in `plain` mode. */
  key?: Buffer;
  /** Desktop manages protection; false for a runtime started without it. */
  managed?: boolean;
  /** Oscar's SQLCipher key (hex), handed to Oscar only when the runtime starts it. */
  oscarDatabaseKey?: string;
}

let current: StoreProtection | undefined;

export function initializeStoreProtection(environment: NodeJS.ProcessEnv = process.env,
  policyLevel: string = 'required'): StoreProtection {
  const managed = String(environment.MONARCH_STORE_PROTECTION || '').trim() === 'desktop';
  const encoded = String(environment.MONARCH_STORE_KEY || '').trim();
  const oscarEncoded = String(environment.MONARCH_OSCAR_DB_KEY || '').trim().toLowerCase();
  delete environment.MONARCH_STORE_KEY;
  delete environment.MONARCH_OSCAR_DB_KEY;
  const oscarDatabaseKey = /^[0-9a-f]{64}$/u.test(oscarEncoded) ? oscarEncoded : current?.oscarDatabaseKey;
  const key = /^[A-Za-z0-9_-]{43}$/u.test(encoded) ? Buffer.from(encoded, 'base64url') : undefined;
  // A second initialization in the same process keeps the key already taken
  // from the environment (it is removed there on the first read).
  const usableKey = key && key.length === 32 ? key : current?.key;
  const oscar = oscarDatabaseKey ? { oscarDatabaseKey } : {};
  if (!managed) {
    current = { mode: 'plain' };
  } else if (policyLevel === 'off') {
    current = usableKey ? { mode: 'plain', key: usableKey, managed, ...oscar } : { mode: 'plain', managed, ...oscar };
  } else {
    current = usableKey && oscarDatabaseKey ? { mode: 'sealed', key: usableKey, managed, ...oscar } : { mode: 'session', managed };
  }
  return current;
}

export function storeProtection(): StoreProtection {
  return current ?? initializeStoreProtection();
}

/** Tests only: the protection a fresh store sees. */
export function setStoreProtectionForTesting(value: StoreProtection | undefined): void {
  current = value;
}

/** What Oscar is started with, and what its health must report back. */
export function oscarStorageEnvironment(protection: StoreProtection = storeProtection()): Record<string, string> {
  if (!protection.managed) return {};
  return {
    OSCAR_STORE_PROTECTION: protection.mode,
    ...(protection.oscarDatabaseKey && protection.mode !== 'session' ? { OSCAR_DB_KEY: protection.oscarDatabaseKey } : {}),
  };
}

export class StoreProtectionError extends Error {
  constructor(readonly code: 'sealed-without-key') {
    super(`store-protection:${code}`);
  }
}

/** Bytes on disk → JSON text, and whether the file still has to be sealed. */
export function decodeStoreBytes(bytes: Buffer, storeId: string, fileName: string,
  protection: StoreProtection = storeProtection()): { text: string; needsSealing: boolean } {
  if (isSealed(bytes)) {
    if (!protection.key) throw new StoreProtectionError('sealed-without-key');
    return { text: openBytes(protection.key, storeId, fileName, bytes).toString('utf8'), needsSealing: false };
  }
  return { text: bytes.toString('utf8'), needsSealing: protection.mode === 'sealed' };
}

export function encodeStoreText(text: string, storeId: string, fileName: string,
  protection: StoreProtection = storeProtection()): string | Buffer {
  if (protection.mode === 'sealed' && protection.key) return sealBytes(protection.key, storeId, fileName, Buffer.from(text, 'utf8'));
  return text;
}

/** Append-only JSONL stores seal each line on its own, so appending stays
 * possible. The record name in the additional data is fixed per store: a
 * rotated archive keeps opening under its new file name. */
const LINE_PREFIX = 'MSF1:';
const LINE_RECORD_NAME = 'jsonl-record';

export function encodeStoreLine(text: string, storeId: string, protection: StoreProtection = storeProtection()): string {
  if (protection.mode !== 'sealed' || !protection.key) return text;
  return LINE_PREFIX + sealBytes(protection.key, storeId, LINE_RECORD_NAME, Buffer.from(text, 'utf8')).toString('base64');
}

/** `legacy`: a plain line that sealed protection still has to replace. */
export function decodeStoreLine(line: string, storeId: string,
  protection: StoreProtection = storeProtection()): { text: string; legacy: boolean } {
  if (!line.startsWith(LINE_PREFIX)) return { text: line, legacy: protection.mode === 'sealed' };
  if (!protection.key) throw new StoreProtectionError('sealed-without-key');
  const bytes = Buffer.from(line.slice(LINE_PREFIX.length), 'base64');
  return { text: openBytes(protection.key, storeId, LINE_RECORD_NAME, bytes).toString('utf8'), legacy: false };
}

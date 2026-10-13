import { hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './windows-rename.mjs';

/** Profile data key (Monarch Security stage 3): one random 256-bit key per
 * Monarch profile, kept only by Desktop as an OS-encrypted record. Processes
 * receive keys derived from it for their own stores, never the key itself.
 *
 * Without OS encryption there is no persistent key: the result says so, and
 * stores must then keep their data for the session only. */
const RECORD_NAME = 'profile-data-key.encrypted';
const KEY_BYTES = 32;
const STORE_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/u;

export function deriveProfileStoreKey(profileDataKey, storeId) {
  if (!Buffer.isBuffer(profileDataKey) || profileDataKey.length !== KEY_BYTES || !STORE_ID.test(storeId)) {
    throw Error('profile-data-key:derive');
  }
  return Buffer.from(hkdfSync('sha256', profileDataKey, Buffer.alloc(0), `monarch.store.v1/${storeId}`, KEY_BYTES));
}

/** recoveryAvailable: whether a copy of the key exists (stage 3f). A missing
 * record then means the key was lost, not that this is a new profile. */
export function createProfileDataKeyStore({ dataRoot, safeStorage, restrictAccess = async () => true,
  recoveryAvailable = async () => false }) {
  const recordPath = path.join(dataRoot, RECORD_NAME);
  let loaded = null;

  async function readRecord() {
    let bytes;
    try { bytes = await readFile(recordPath); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw Error('profile-data-key:record');
    }
    if (bytes.byteLength > 4096) throw Error('profile-data-key:record');
    let key;
    try { key = Buffer.from(safeStorage.decryptString(bytes), 'base64'); } catch { throw Error('profile-data-key:record'); }
    if (key.length !== KEY_BYTES) throw Error('profile-data-key:record');
    return key;
  }

  async function writeRecord(key) {
    await mkdir(dataRoot, { recursive: true });
    if (await restrictAccess(dataRoot) !== true) throw Error('profile-data-key:protected-record');
    const encoded = key.toString('base64');
    const encrypted = Buffer.from(safeStorage.encryptString(encoded));
    if (!encrypted.length || safeStorage.decryptString(encrypted) !== encoded) throw Error('profile-data-key:verification');
    const temporary = `${recordPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      // 'wx': a second writer fails instead of replacing a key data depends on.
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, recordPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const stored = await readRecord();
    if (!stored || !stored.equals(key)) throw Error('profile-data-key:verification');
  }

  return {
    /** The key once per process. A damaged record is an error, never a new key:
     * replacing it would make every sealed store unreadable. */
    async load() {
      if (loaded) return loaded;
      if (safeStorage?.isEncryptionAvailable?.() !== true) {
        loaded = Object.freeze({ key: null, persistent: false });
        return loaded;
      }
      const stored = await readRecord();
      if (stored) {
        loaded = Object.freeze({ key: stored, persistent: true });
        return loaded;
      }
      // With a copy on record the key was lost, not never made: a new key would
      // leave every sealed store unreadable. The person restores it instead.
      if (await recoveryAvailable()) throw Error('profile-data-key:needs-recovery');
      const key = randomBytes(KEY_BYTES);
      await writeRecord(key);
      loaded = Object.freeze({ key, persistent: true });
      return loaded;
    },
    /** Writes a recovered key as this account's record. A damaged record is
     * kept aside, never deleted; a readable record with another key is left
     * alone, because data may already depend on it. */
    async restore(key) {
      if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw Error('profile-data-key:restore');
      if (safeStorage?.isEncryptionAvailable?.() !== true) throw Error('profile-data-key:os-encryption');
      let stored = null;
      let damaged = false;
      try { stored = await readRecord(); } catch { damaged = true; }
      if (stored && !stored.equals(key)) throw Error('profile-data-key:different-key');
      if (!stored) {
        if (damaged) await renameWithRetry(recordPath, `${recordPath}.damaged-${Date.now()}`);
        await writeRecord(key);
      }
      loaded = Object.freeze({ key: Buffer.from(key), persistent: true });
      return { restored: !stored };
    },
    recordName: RECORD_NAME,
  };
}

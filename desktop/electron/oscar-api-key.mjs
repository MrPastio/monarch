import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './windows-rename.mjs';

/** The Oscar API key: the bearer token between Monarch and its local Oscar
 * backend, and the key the owner copies for the Sharing API. Desktop owns it as
 * an OS-encrypted record and hands it to the runtime when it starts it; it is
 * never written as plain text. A plain-text key left by an earlier version is
 * moved into the record with the same value (apps the owner already gave it
 * keep working) and the plain file is then removed. Diagnostic profiles pass
 * removeLegacyFile: false: they may copy the value but never delete the owner's file.
 *
 * Without OS encryption the key lives only in memory for this session: Oscar
 * still runs, but the Sharing key changes on the next start. */
const RECORD_NAME = 'oscar-api-key.encrypted';
const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{32,256}$/u;

export function createOscarApiKeyStore({ dataRoot, legacyPath, safeStorage, restrictAccess = async () => true,
  removeLegacyFile = true }) {
  const recordPath = path.join(dataRoot, RECORD_NAME);
  let loaded = null;

  const encryptionAvailable = () => safeStorage?.isEncryptionAvailable?.() === true;

  async function readRecord() {
    let bytes;
    try { bytes = await readFile(recordPath); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw Error('oscar-api-key:record');
    }
    if (bytes.byteLength > 4096) throw Error('oscar-api-key:record');
    let value;
    try { value = safeStorage.decryptString(bytes); } catch { throw Error('oscar-api-key:record'); }
    if (!KEY_PATTERN.test(value)) throw Error('oscar-api-key:record');
    return value;
  }

  async function writeRecord(value) {
    await mkdir(dataRoot, { recursive: true });
    if (await restrictAccess(dataRoot) !== true) throw Error('oscar-api-key:protected-record');
    const encrypted = Buffer.from(safeStorage.encryptString(value));
    if (!encrypted.length || safeStorage.decryptString(encrypted) !== value) throw Error('oscar-api-key:verification');
    const temporary = `${recordPath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await renameWithRetry(temporary, recordPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    if (await readRecord() !== value) throw Error('oscar-api-key:verification');
  }

  async function readLegacy() {
    if (!legacyPath) return null;
    const entry = await lstat(legacyPath).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > 4096) return null;
    const value = (await readFile(legacyPath, 'utf8').catch(() => '')).replace(/^\uFEFF/, '').trim();
    return KEY_PATTERN.test(value) ? value : null;
  }

  async function removeLegacy() {
    if (!removeLegacyFile) return;
    await unlink(legacyPath).catch(error => { if (error?.code !== 'ENOENT') throw error; });
  }

  return {
    /** Loads the key once per process; later calls return the same value. */
    async load() {
      if (loaded) return loaded;
      if (!encryptionAvailable()) {
        loaded = Object.freeze({ key: randomBytes(32).toString('hex'), persistent: false, migrated: false });
        return loaded;
      }
      const stored = await readRecord();
      const legacy = await readLegacy();
      if (stored) {
        // An earlier migration may have stopped before deleting the plain file.
        if (legacy === stored) await removeLegacy();
        loaded = Object.freeze({ key: stored, persistent: true, migrated: false });
        return loaded;
      }
      const key = legacy ?? randomBytes(32).toString('hex');
      await writeRecord(key);
      if (legacy) await removeLegacy();
      loaded = Object.freeze({ key, persistent: true, migrated: Boolean(legacy) });
      return loaded;
    },
    recordName: RECORD_NAME,
  };
}

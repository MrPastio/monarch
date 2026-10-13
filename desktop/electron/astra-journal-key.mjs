import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { restrictProtectedIntegrationAcl } from './protected-integration-acl.mjs';

const KEY_BYTES = 32;
const KEY_FILE = 'journal-key.dpapi';

/** Main-process-only device key. The protected record stays outside Monarch Safe;
 * only its short-lived decoded value crosses into the local runtime child.
 * Missing records may be created once; corrupt or aliased records fail closed and
 * are never replaced automatically.
 */
export async function loadOrCreateAstraJournalKey({
  rootPath,
  safeStorage,
  restrictAccess = root => restrictProtectedIntegrationAcl(root, { recordNames: [KEY_FILE] }),
  randomBytesFactory = randomBytes,
}) {
  if (!path.isAbsolute(rootPath) || !safeStorage?.isEncryptionAvailable?.() || typeof restrictAccess !== 'function') return null;
  const root = path.resolve(rootPath), file = path.join(root, KEY_FILE);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.resolve(await realpath(root)).toLowerCase() !== root.toLowerCase()) return null;
    let encrypted;
    try {
      const fileStat = await lstat(file);
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size <= 0 || fileStat.size > 16 * 1024) return null;
      encrypted = await readFile(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const key = Buffer.from(randomBytesFactory(KEY_BYTES));
      if (key.byteLength !== KEY_BYTES) { key.fill(0); return null; }
      try {
        encrypted = Buffer.from(safeStorage.encryptString(key.toString('base64')));
        const probe = decodeProtectedKey(encrypted, safeStorage);
        const verified = Boolean(probe?.equals(key)); probe?.fill(0);
        if (!encrypted.length || encrypted.length > 16 * 1024 || !verified) return null;
        await writeFile(file, encrypted, { flag: 'wx', mode: 0o600 });
      } catch { return null; }
      finally { key.fill(0); }
    }
    if (!await restrictAccess(root)) return null;
    return decodeProtectedKey(encrypted, safeStorage);
  } catch { return null; }
}

function decodeProtectedKey(encrypted, safeStorage) {
  try {
    const encoded = safeStorage.decryptString(Buffer.from(encrypted));
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) return null;
    const key = Buffer.from(encoded, 'base64');
    if (key.byteLength === KEY_BYTES && key.toString('base64') === encoded) return key;
    key.fill(0);
  } catch { /* Device protection unavailable or record corrupt. */ }
  return null;
}

export const ASTRA_JOURNAL_KEY_RECORD = Object.freeze({ fileName: KEY_FILE, keyBytes: KEY_BYTES });

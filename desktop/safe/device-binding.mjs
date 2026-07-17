import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEVICE_KEY_BYTES = 32;
const DEVICE_KEY_FILE = 'device-key.safe';

export async function loadOrCreateSafeDeviceKey({ rootPath, safeStorage, randomBytesFactory = randomBytes }) {
  if (!path.isAbsolute(rootPath) || !safeStorage?.isEncryptionAvailable?.()) return null;
  const deviceKeyPath = path.join(rootPath, DEVICE_KEY_FILE);
  await mkdir(rootPath, { recursive: true, mode: 0o700 });

  try {
    return decodeProtectedKey(await readFile(deviceKeyPath), safeStorage);
  } catch (error) {
    if (error?.code !== 'ENOENT') return null;
  }

  const key = Buffer.from(randomBytesFactory(DEVICE_KEY_BYTES));
  if (key.byteLength !== DEVICE_KEY_BYTES) {
    key.fill(0);
    return null;
  }
  try {
    const encrypted = safeStorage.encryptString(key.toString('base64'));
    await writeFile(deviceKeyPath, encrypted, { flag: 'wx', mode: 0o600 });
    return key;
  } catch {
    key.fill(0);
    return null;
  }
}

function decodeProtectedKey(encrypted, safeStorage) {
  try {
    const key = Buffer.from(safeStorage.decryptString(encrypted), 'base64');
    if (key.byteLength === DEVICE_KEY_BYTES) return key;
    key.fill(0);
  } catch {
    // A missing or corrupt device binding must never be replaced automatically.
  }
  return null;
}

export const SAFE_DEVICE_BINDING = Object.freeze({ fileName: DEVICE_KEY_FILE, keyBytes: DEVICE_KEY_BYTES });

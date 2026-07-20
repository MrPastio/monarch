import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_SECRET_FILES = new Set([
  'oscar_token.txt',
  'telegram_bot_token.txt',
]);

export async function migrateLegacySecretsForCurrentUser({
  migrationRoot,
  safeRoot,
  safeStorage,
  now = () => new Date(),
}) {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    return Object.freeze({ status: 'deferred', reason: 'safe-storage-unavailable', migrated: 0 });
  }
  const source = path.resolve(migrationRoot);
  const sourceStat = await stat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    return Object.freeze({ status: 'not-needed', migrated: 0 });
  }

  const targetRoot = path.resolve(safeRoot, 'legacy-secret-backup');
  const markerPath = path.join(targetRoot, 'migration-marker.json');
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const records = [];
  for (const filePath of await walkSupportedSecretFiles(source)) {
    const bytes = await readFile(filePath);
    const value = bytes.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!value) continue;
    const encrypted = safeStorage.encryptString(value);
    if (safeStorage.decryptString(encrypted) !== value) {
      throw new Error(`safeStorage verification failed for ${path.basename(filePath)}.`);
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const destination = path.join(targetRoot, `${digest}.safe`);
    await atomicWriteBytes(destination, encrypted);
    records.push({
      sourceName: path.basename(filePath),
      sourceSha256: digest,
      protectedFile: path.basename(destination),
    });
  }

  await atomicWriteJson(markerPath, {
    schemaVersion: 1,
    migratedAt: now().toISOString(),
    userContext: process.env.USERNAME || null,
    records,
    originalRetained: true,
  });
  return Object.freeze({
    status: records.length > 0 ? 'migrated' : 'not-needed',
    migrated: records.length,
    markerPath,
  });
}

async function walkSupportedSecretFiles(root) {
  const result = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(filePath);
      else if (entry.isFile() && SUPPORTED_SECRET_FILES.has(entry.name.toLowerCase())) {
        result.push(filePath);
      }
    }
  }
  return result.sort();
}

async function atomicWriteJson(filePath, value) {
  await atomicWriteBytes(
    filePath,
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
  );
}

async function atomicWriteBytes(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, filePath);
}

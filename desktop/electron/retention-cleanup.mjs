import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MINIMUM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function cleanupRetainedUpdateComponents({
  installRoot,
  payloadRoot,
  now = () => Date.now(),
  retentionMs = MINIMUM_RETENTION_MS,
}) {
  const install = path.resolve(installRoot);
  const payload = path.resolve(payloadRoot);
  const [pointer, layout, pending] = await Promise.all([
    readJsonIfExists(path.join(install, 'current.json')),
    readJsonIfExists(path.join(install, 'install-layout.json')),
    readJsonIfExists(path.join(payload, 'transactions', 'pending-update.json')),
  ]);
  if (
    pointer?.schemaVersion !== 1
    || layout?.schemaVersion !== 1
    || path.resolve(layout.payloadRoot || '') !== payload
    || pending?.phase !== 'committed'
  ) {
    return Object.freeze({ status: 'skipped', removed: Object.freeze([]) });
  }

  const protectedVersions = new Set([
    pointer.currentVersion,
    pointer.previousVersion,
    pending.candidateVersion,
    pending.previousVersion,
  ].filter(Boolean));
  const versionsRoot = path.join(install, 'versions');
  const versionEntries = await readSafeDirectories(versionsRoot);
  const removed = [];
  for (const entry of versionEntries) {
    if (protectedVersions.has(entry.name)) continue;
    if (!await isPastRetention(entry.path, now(), retentionMs)) continue;
    await removeTrustedDirectory(entry.path, versionsRoot);
    removed.push(`version:${entry.name}`);
  }

  const retainedDescriptors = [];
  for (const entry of await readSafeDirectories(versionsRoot)) {
    const descriptor = await readJsonIfExists(path.join(entry.path, 'version.json'));
    if (descriptor?.descriptorVersion === 1) retainedDescriptors.push(descriptor);
  }
  const protectedRuntimes = new Set(retainedDescriptors.map((value) => `runtime-${value.runtimeVersion}`));
  const protectedEnvironments = new Set(retainedDescriptors.map((value) => value.backendEnvironment));
  await cleanupPayloadFamily({
    root: path.join(payload, 'runtimes'),
    protectedNames: protectedRuntimes,
    prefix: 'runtime',
    removed,
    now: now(),
    retentionMs,
  });
  await cleanupPayloadFamily({
    root: path.join(payload, 'environments'),
    protectedNames: protectedEnvironments,
    prefix: 'environment',
    removed,
    now: now(),
    retentionMs,
  });
  return Object.freeze({ status: 'completed', removed: Object.freeze(removed) });
}

async function cleanupPayloadFamily({
  root,
  protectedNames,
  prefix,
  removed,
  now,
  retentionMs,
}) {
  for (const entry of await readSafeDirectories(root)) {
    if (protectedNames.has(entry.name)) continue;
    if (!await isPastRetention(entry.path, now, retentionMs)) continue;
    await removeTrustedDirectory(entry.path, root);
    removed.push(`${prefix}:${entry.name}`);
  }
}

async function readSafeDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: path.join(root, entry.name),
    }));
}

async function isPastRetention(candidate, now, retentionMs) {
  const metadata = await stat(candidate);
  return now - metadata.mtimeMs >= retentionMs;
}

async function removeTrustedDirectory(candidate, root) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Retention cleanup path escaped its trusted component root.');
  }
  await rm(resolved, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

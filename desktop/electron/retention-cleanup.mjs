import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { collectReferencedComponents } from './component-references.mjs';

const MINIMUM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export async function cleanupRetainedUpdateComponents({
  installRoot,
  payloadRoot,
  now = () => Date.now(),
  retentionMs = MINIMUM_RETENTION_MS,
  findReferences = collectReferencedComponents,
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
  const versionDescriptors = new Map();
  for (const entry of versionEntries) {
    const descriptor = await readJsonIfExists(path.join(entry.path, 'version.json'));
    if (isUsableVersionDescriptor(descriptor)) versionDescriptors.set(entry.name, descriptor);
  }
  if (
    !isVersionName(pointer.currentVersion)
    || pointer.currentVersion !== pending.candidateVersion
    || [...protectedVersions].some((version) => !isVersionName(version) || !versionDescriptors.has(version))
  ) {
    // A pointer/transaction without matching descriptors is an incomplete
    // installation inventory, never evidence that shared payload is orphaned.
    return Object.freeze({
      status: 'skipped',
      reason: 'version-inventory-incomplete',
      removed: Object.freeze([]),
    });
  }
  const componentEntries = [...versionEntries,
    ...await readSafeDirectories(path.join(payload, 'runtimes')),
    ...await readSafeDirectories(path.join(payload, 'environments'))];
  let references;
  try {
    const roots = componentEntries.map(entry => entry.path);
    const result = await findReferences(roots);
    if (!Array.isArray(result) || result.some(value => !roots.includes(value))) throw new Error('Invalid ownership inventory');
    references = new Set(result);
  } catch {
    // Unavailable process/task inventory is not evidence that deletion is safe.
    return Object.freeze({ status: 'skipped', reason: 'component-ownership-unavailable', removed: Object.freeze([]) });
  }
  const removed = [];
  const observedAt = now();
  const retainedVersionNames = new Set();
  for (const entry of versionEntries) {
    if (
      protectedVersions.has(entry.name)
      || references.has(entry.path)
      || !await isPastRetention(entry.path, observedAt, retentionMs)
    ) {
      retainedVersionNames.add(entry.name);
      continue;
    }
    await removeTrustedDirectory(entry.path, versionsRoot);
    removed.push(`version:${entry.name}`);
  }

  const retainedDescriptors = [...retainedVersionNames]
    .map((version) => versionDescriptors.get(version));
  if (retainedDescriptors.some((descriptor) => !descriptor)) {
    // A retained version with no component binding makes payload cleanup
    // ambiguous. Version cleanup above is bounded, but payload stays intact.
    return Object.freeze({
      status: 'completed',
      reason: 'retained-version-inventory-incomplete',
      removed: Object.freeze(removed),
    });
  }
  const protectedRuntimes = new Set(retainedDescriptors.map((value) => `runtime-${value.runtimeVersion}`));
  const protectedEnvironments = new Set(retainedDescriptors.map((value) => value.backendEnvironment));
  await cleanupPayloadFamily({
    root: path.join(payload, 'runtimes'),
    protectedNames: protectedRuntimes,
    references,
    prefix: 'runtime',
    removed,
    now: observedAt,
    retentionMs,
  });
  await cleanupPayloadFamily({
    root: path.join(payload, 'environments'),
    protectedNames: protectedEnvironments,
    references,
    prefix: 'environment',
    removed,
    now: observedAt,
    retentionMs,
  });
  return Object.freeze({ status: 'completed', removed: Object.freeze(removed) });
}

function isVersionName(value) {
  return /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(String(value || ''));
}

function isUsableVersionDescriptor(value) {
  return value?.descriptorVersion === 1
    && /^\d{4}\.\d{2}\.\d+$/.test(String(value.runtimeVersion || ''))
    && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(String(value.backendEnvironment || ''));
}

async function cleanupPayloadFamily({
  root,
  protectedNames,
  references,
  prefix,
  removed,
  now,
  retentionMs,
}) {
  for (const entry of await readSafeDirectories(root)) {
    if (protectedNames.has(entry.name) || references.has(entry.path)) continue;
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
  await rm(resolved, { recursive: true, force: false, maxRetries: 0 });
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

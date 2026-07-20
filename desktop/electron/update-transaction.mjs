import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const MUTABLE_STORE_IDS = Object.freeze([
  'core',
  'chats',
  'memory',
  'config',
  'indexes',
  'safe',
]);

export class MigrationContractError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MigrationContractError';
    this.code = code;
  }
}

export class MonarchMigrationRegistry {
  constructor() {
    this.stores = new Map();
    this.steps = new Map();
  }

  registerStore(adapter) {
    const id = validateStoreId(adapter?.id);
    for (const method of ['readSchema', 'createSnapshot', 'restoreSnapshot', 'validate']) {
      if (typeof adapter?.[method] !== 'function') {
        throw new MigrationContractError('invalid-store-adapter', `${id} must implement ${method}().`);
      }
    }
    if (this.stores.has(id)) {
      throw new MigrationContractError('duplicate-store', `Migration store ${id} is already registered.`);
    }
    this.stores.set(id, Object.freeze({ ...adapter, id }));
    return this;
  }

  registerStep(step) {
    const storeId = validateStoreId(step?.storeId);
    if (!Number.isSafeInteger(step?.from) || !Number.isSafeInteger(step?.to) || step.to !== step.from + 1) {
      throw new MigrationContractError('invalid-migration-step', 'Migration steps must advance one schema version.');
    }
    if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(String(step?.idempotencyKey || ''))) {
      throw new MigrationContractError('invalid-idempotency-key', 'Migration idempotency key is invalid.');
    }
    if (typeof step.reversible !== 'boolean' || typeof step.snapshotRequired !== 'boolean') {
      throw new MigrationContractError('invalid-migration-step', 'Migration rollback properties are required.');
    }
    for (const method of ['apply', 'validate']) {
      if (typeof step?.[method] !== 'function') {
        throw new MigrationContractError('invalid-migration-step', `Migration step must implement ${method}().`);
      }
    }
    const key = `${storeId}:${step.from}:${step.to}`;
    if (this.steps.has(key)) {
      throw new MigrationContractError('duplicate-migration-step', `Migration step ${key} already exists.`);
    }
    this.steps.set(key, Object.freeze({ ...step, storeId }));
    return this;
  }

  plan(storeId, from, to) {
    validateStoreId(storeId);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) {
      throw new MigrationContractError('invalid-migration-range', 'Migration range is invalid.');
    }
    const result = [];
    for (let schema = from; schema < to; schema += 1) {
      const step = this.steps.get(`${storeId}:${schema}:${schema + 1}`);
      if (!step) {
        throw new MigrationContractError(
          'missing-migration-step',
          `No registered migration for ${storeId} ${schema} -> ${schema + 1}.`,
        );
      }
      result.push(step);
    }
    return Object.freeze(result);
  }
}

export async function preparePostUpdateTrial({
  argv = process.argv,
  env = process.env,
  registry = new MonarchMigrationRegistry(),
  now = () => new Date(),
} = {}) {
  const updateId = readIntentId(argv, '--post-update=');
  if (!updateId) return null;
  const context = await readTransactionContext({ updateId, env });
  if (context.pending.candidateVersion !== context.descriptor.appVersion) {
    throw new MigrationContractError('candidate-version-mismatch', 'Pending update does not match this app version.');
  }
  if (
    context.pending.expectedRuntimeVersion !== context.descriptor.runtimeVersion
    || context.pending.expectedBackendEnvironment !== context.descriptor.backendEnvironment
  ) {
    throw new MigrationContractError('candidate-payload-mismatch', 'Candidate payload descriptor is inconsistent.');
  }

  const journalPath = path.join(context.transactionDirectory, 'migration-journal.json');
  const journal = await readJsonIfExists(journalPath) || {
    schemaVersion: 1,
    updateId,
    phase: 'prepared',
    stores: {},
    createdAt: now().toISOString(),
  };
  const currentSchema = await readDataSchema(context.installRoot);
  if (currentSchema > context.descriptor.maximumReadableDataSchema) {
    throw new MigrationContractError('candidate-cannot-read-data', 'Candidate cannot read the active data schema.');
  }
  if (currentSchema < context.descriptor.dataSchemaVersion) {
    await executeRegisteredMigrations({
      registry,
      context,
      journal,
      journalPath,
      from: currentSchema,
      to: context.descriptor.dataSchemaVersion,
      now,
    });
  }
  journal.phase = 'ready-for-health';
  journal.completedAt = now().toISOString();
  await atomicWriteJson(journalPath, journal);
  return Object.freeze({ ...context, journalPath });
}

export async function prepareRollback({
  argv = process.argv,
  env = process.env,
  registry = new MonarchMigrationRegistry(),
  now = () => new Date(),
} = {}) {
  const updateId = readIntentId(argv, '--rollback-update=');
  if (!updateId) return null;
  const context = await readTransactionContext({ updateId, env });
  const activeSchema = await readDataSchema(context.installRoot);
  if (
    activeSchema >= context.descriptor.minimumReadableDataSchema
    && activeSchema <= context.descriptor.maximumReadableDataSchema
  ) {
    return Object.freeze({ ...context, restored: false });
  }
  if (!context.pending.snapshotId) {
    throw new MigrationContractError('rollback-snapshot-required', 'Rollback requires a verified data snapshot.');
  }
  for (const adapter of registry.stores.values()) {
    await adapter.restoreSnapshot({
      snapshotId: context.pending.snapshotId,
      transactionDirectory: context.transactionDirectory,
    });
    await adapter.validate();
  }
  await atomicWriteJson(path.join(context.installRoot, 'data-schema.json'), {
    schemaVersion: 1,
    dataSchemaVersion: context.pending.previousDataSchema,
    updatedAt: now().toISOString(),
  });
  return Object.freeze({ ...context, restored: true });
}

export async function writeHealthAcknowledgement({
  trial,
  backendHealth,
  configValid,
  securityState,
  windowReady,
  now = () => new Date(),
}) {
  if (!trial) return null;
  if (!backendHealth?.ok || configValid !== true || windowReady !== true) {
    throw new MigrationContractError('health-incomplete', 'Core post-update health checks did not pass.');
  }
  if (!['active', 'available', 'expected'].includes(String(securityState || ''))) {
    throw new MigrationContractError('security-state-invalid', 'Security did not reach an expected startup state.');
  }
  const acknowledgementPath = path.join(trial.transactionDirectory, 'health-ack.json');
  await atomicWriteJson(acknowledgementPath, {
    schemaVersion: 1,
    updateId: trial.updateId,
    appVersion: trial.descriptor.appVersion,
    status: 'healthy',
    backend: 'healthy',
    config: 'valid',
    security: securityState,
    acknowledgedAt: now().toISOString(),
  });
  return acknowledgementPath;
}

export async function createFileStoreSnapshot({
  sourceRoot,
  snapshotRoot,
  storeId,
}) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(snapshotRoot, validateStoreId(storeId));
  await mkdir(target, { recursive: true });
  const inventory = [];
  for (const file of await walkFiles(source)) {
    const relative = path.relative(source, file);
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file, destination);
    const [sourceHash, targetHash] = await Promise.all([hashFile(file), hashFile(destination)]);
    if (sourceHash !== targetHash) {
      throw new MigrationContractError('snapshot-verification-failed', `Snapshot hash mismatch for ${relative}.`);
    }
    inventory.push({ path: relative.replaceAll('\\', '/'), sha256: sourceHash });
  }
  await atomicWriteJson(path.join(target, 'inventory.json'), {
    schemaVersion: 1,
    storeId,
    files: inventory,
  });
  return Object.freeze({ storeId, root: target, inventory: Object.freeze(inventory) });
}

export async function createSqliteSnapshot({ backup }) {
  if (typeof backup !== 'function') {
    throw new MigrationContractError(
      'sqlite-backup-api-required',
      'SQLite snapshots must use the database backup API while holding the store lock.',
    );
  }
  return backup();
}

async function executeRegisteredMigrations({
  registry,
  context,
  journal,
  journalPath,
  from,
  to,
  now,
}) {
  if (registry.stores.size === 0) {
    throw new MigrationContractError('migration-registry-empty', 'A schema increase requires registered stores.');
  }
  const snapshotId = context.pending.snapshotId || randomUUID();
  context.pending.snapshotId = snapshotId;
  await atomicWriteJson(context.pendingPath, context.pending);
  for (const [storeId, adapter] of registry.stores) {
    const storeSchema = await adapter.readSchema();
    const steps = registry.plan(storeId, storeSchema, to);
    const storeJournal = journal.stores[storeId] || {
      from: storeSchema,
      to,
      completedKeys: [],
      snapshotId,
    };
    journal.stores[storeId] = storeJournal;
    if (steps.some((step) => step.snapshotRequired) && !storeJournal.snapshotComplete) {
      await adapter.createSnapshot({
        snapshotId,
        transactionDirectory: context.transactionDirectory,
      });
      storeJournal.snapshotComplete = true;
      await atomicWriteJson(journalPath, journal);
    }
    for (const step of steps) {
      if (storeJournal.completedKeys.includes(step.idempotencyKey)) continue;
      if (!step.reversible && !step.snapshotRequired) {
        throw new MigrationContractError(
          'unsafe-migration-step',
          `${step.idempotencyKey} is neither reversible nor snapshot-backed.`,
        );
      }
      storeJournal.activeKey = step.idempotencyKey;
      storeJournal.startedAt = now().toISOString();
      await atomicWriteJson(journalPath, journal);
      await step.apply({ context, store: adapter, journal: storeJournal });
      await step.validate({ context, store: adapter });
      storeJournal.completedKeys.push(step.idempotencyKey);
      delete storeJournal.activeKey;
      await atomicWriteJson(journalPath, journal);
    }
    await adapter.validate();
  }
  await atomicWriteJson(path.join(context.installRoot, 'data-schema.json'), {
    schemaVersion: 1,
    dataSchemaVersion: to,
    updatedAt: now().toISOString(),
  });
}

async function readTransactionContext({ updateId, env }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(updateId)) {
    throw new MigrationContractError('invalid-update-id', 'Post-update identifier is invalid.');
  }
  const installRoot = requireAbsoluteEnv(env, 'MONARCH_INSTALL_ROOT');
  const versionRoot = requireInside(requireAbsoluteEnv(env, 'MONARCH_VERSION_ROOT'), path.join(installRoot, 'versions'));
  const transactionRoot = requireAbsoluteEnv(env, 'MONARCH_TRANSACTION_ROOT');
  const pendingPath = path.join(transactionRoot, 'pending-update.json');
  const pending = await readJson(pendingPath);
  if (pending.updateId !== updateId) {
    throw new MigrationContractError('transaction-mismatch', 'Pending update identifier does not match.');
  }
  const transactionDirectory = requireInside(path.join(transactionRoot, updateId), transactionRoot);
  const descriptor = await readJson(path.join(versionRoot, 'version.json'));
  validateDescriptor(descriptor);
  return {
    updateId,
    installRoot,
    versionRoot,
    transactionRoot,
    transactionDirectory,
    pendingPath,
    pending,
    descriptor,
  };
}

function validateDescriptor(value) {
  if (
    value?.descriptorVersion !== 1
    || value?.layoutSchemaVersion !== 1
    || !/^\d+\.\d+\.\d+$/.test(String(value?.appVersion || ''))
  ) {
    throw new MigrationContractError('invalid-version-descriptor', 'Installed version descriptor is invalid.');
  }
  for (const field of [
    'dataSchemaVersion',
    'minimumReadableDataSchema',
    'maximumReadableDataSchema',
  ]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new MigrationContractError('invalid-version-descriptor', `${field} is invalid.`);
    }
  }
}

function readIntentId(argv, prefix) {
  const argument = argv.find((value) => String(value).startsWith(prefix));
  return argument ? String(argument).slice(prefix.length) : null;
}

function validateStoreId(value) {
  const id = String(value || '');
  if (!/^(?:core|chats|memory|config|indexes|safe|module:[a-z0-9][a-z0-9._-]{0,63})$/i.test(id)) {
    throw new MigrationContractError('invalid-store-id', `Invalid migration store: ${id || '(empty)'}.`);
  }
  return id;
}

function requireAbsoluteEnv(env, name) {
  const value = env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new MigrationContractError('missing-transaction-environment', `${name} is missing or invalid.`);
  }
  return path.resolve(value);
}

function requireInside(candidate, root) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MigrationContractError('path-outside-transaction-root', 'Transaction path escaped its trusted root.');
  }
  return resolved;
}

async function readDataSchema(installRoot) {
  const state = await readJson(path.join(installRoot, 'data-schema.json'));
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.dataSchemaVersion)) {
    throw new MigrationContractError('invalid-data-schema', 'Active data schema metadata is invalid.');
  }
  return state.dataSchemaVersion;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new MigrationContractError('invalid-transaction-json', `Cannot read ${path.basename(filePath)}.`, error);
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${filePath}.previous`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rm(previous, { force: true });
  try {
    await rename(filePath, previous);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(temporary, filePath);
    await rm(previous, { force: true });
  } catch (error) {
    await rename(previous, filePath).catch(() => undefined);
    throw error;
  }
}

async function walkFiles(root) {
  const result = [];
  const rootStat = await stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) return result;
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new MigrationContractError('snapshot-link-rejected', 'Snapshot sources cannot contain links.');
      }
      if (entry.isDirectory()) queue.push(filePath);
      else if (entry.isFile()) result.push(filePath);
    }
  }
  return result.sort();
}

async function hashFile(filePath) {
  const digest = createHash('sha256');
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
}

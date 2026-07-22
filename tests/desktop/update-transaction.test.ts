import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MonarchMigrationRegistry,
  createSqliteSnapshot,
  preparePostUpdateTrial,
  prepareRollback,
  writeHealthAcknowledgement,
} from '../../desktop/electron/update-transaction.mjs';
import { migrateLegacySecretsForCurrentUser } from '../../desktop/electron/protected-storage-migration.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transactional update contract', () => {
  it('prepares and acknowledges a candidate without migrating an unchanged schema', async () => {
    const fixture = await createTransactionFixture({
      candidateSchema: 1,
      readableRange: [1, 1],
      activeSchema: 1,
    });
    const trial = await preparePostUpdateTrial({
      argv: ['electron', `--post-update=${fixture.updateId}`],
      env: fixture.env,
    });

    expect(trial?.descriptor.appVersion).toBe('0.2.0');
    const acknowledgement = await writeHealthAcknowledgement({
      trial,
      backendHealth: { ok: true },
      configValid: true,
      securityState: 'active',
      windowReady: true,
    });
    expect(JSON.parse(await readFile(acknowledgement!, 'utf8'))).toMatchObject({
      updateId: fixture.updateId,
      appVersion: '0.2.0',
      status: 'healthy',
    });
  });

  it('fails closed when a schema increase has no registered store migrations', async () => {
    const fixture = await createTransactionFixture({
      candidateSchema: 2,
      readableRange: [1, 2],
      activeSchema: 1,
    });
    await expect(preparePostUpdateTrial({
      argv: ['electron', `--post-update=${fixture.updateId}`],
      env: fixture.env,
      registry: new MonarchMigrationRegistry(),
    })).rejects.toMatchObject({ code: 'migration-registry-empty' });
  });

  it('requires a verified snapshot when the previous app cannot read the active schema', async () => {
    const fixture = await createTransactionFixture({
      candidateSchema: 1,
      readableRange: [1, 1],
      activeSchema: 2,
      rollback: true,
    });
    await expect(prepareRollback({
      argv: ['electron', `--rollback-update=${fixture.updateId}`],
      env: fixture.env,
    })).rejects.toMatchObject({ code: 'rollback-snapshot-required' });
  });

  it('refuses raw SQLite copying when no backup API is supplied', async () => {
    await expect(createSqliteSnapshot({ backup: undefined as never }))
      .rejects.toMatchObject({ code: 'sqlite-backup-api-required' });
  });

  it('encrypts supported legacy secrets under the current user and retains the original', async () => {
    const root = await createTempRoot();
    const migrationRoot = path.join(root, 'migration');
    const safeRoot = path.join(root, 'Safe');
    const secretPath = path.join(migrationRoot, 'legacy-1', 'oscar_token.txt');
    await mkdir(path.dirname(secretPath), { recursive: true });
    await writeFile(secretPath, 'private-token\n', 'utf8');
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`protected:${value}`, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8').slice('protected:'.length),
    };

    const result = await migrateLegacySecretsForCurrentUser({
      migrationRoot,
      safeRoot,
      safeStorage,
    });

    expect(result).toMatchObject({ status: 'migrated', migrated: 1 });
    expect(await readFile(secretPath, 'utf8')).toBe('private-token\n');
    const marker = JSON.parse(await readFile(path.join(safeRoot, 'legacy-secret-backup', 'migration-marker.json'), 'utf8'));
    expect(marker).toMatchObject({ originalRetained: true });
    expect(marker.records[0]).not.toHaveProperty('value');
  });
});

async function createTransactionFixture({
  candidateSchema,
  readableRange,
  activeSchema,
  rollback = false,
}: {
  candidateSchema: number;
  readableRange: [number, number];
  activeSchema: number;
  rollback?: boolean;
}) {
  const root = await createTempRoot();
  const installRoot = path.join(root, 'install');
  const version = rollback ? '0.1.5' : '0.2.0';
  const versionRoot = path.join(installRoot, 'versions', version);
  const transactionRoot = path.join(root, 'payload', 'transactions');
  const updateId = randomUUID();
  await mkdir(path.join(transactionRoot, updateId), { recursive: true });
  await mkdir(versionRoot, { recursive: true });
  await writeJson(path.join(versionRoot, 'version.json'), {
    descriptorVersion: 1,
    appVersion: version,
    layoutSchemaVersion: 1,
    minimumLauncherVersion: '1.0.0',
    runtimeVersion: rollback ? '2026.07.1' : '2026.08.0',
    backendEnvironment: rollback ? 'backend-0.1.5' : 'backend-0.2.0',
    dataSchemaVersion: candidateSchema,
    minimumReadableDataSchema: readableRange[0],
    maximumReadableDataSchema: readableRange[1],
    minimumModelCatalogSchema: 1,
    maximumModelCatalogSchema: 1,
  });
  await writeJson(path.join(installRoot, 'data-schema.json'), {
    schemaVersion: 1,
    dataSchemaVersion: activeSchema,
  });
  await writeJson(path.join(transactionRoot, 'pending-update.json'), {
    schemaVersion: 1,
    updateId,
    previousVersion: '0.1.5',
    candidateVersion: '0.2.0',
    expectedRuntimeVersion: '2026.08.0',
    expectedBackendEnvironment: 'backend-0.2.0',
    previousDataSchema: 1,
    expectedDataSchema: candidateSchema,
    snapshotId: null,
  });
  return {
    updateId,
    env: {
      MONARCH_INSTALL_ROOT: installRoot,
      MONARCH_VERSION_ROOT: versionRoot,
      MONARCH_TRANSACTION_ROOT: transactionRoot,
    },
  };
}

async function createTempRoot() {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp-update-transaction-'));
  temporaryRoots.push(root);
  return root;
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupRetainedUpdateComponents } from '../../desktop/electron/retention-cleanup.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('update retention cleanup', () => {
  it.each(['unused', 'version', 'payload', 'unavailable', 'invalid'])('protects referenced components: %s', async (mode) => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-update-retention-'));
    roots.push(root);
    const installRoot = path.join(root, 'install');
    const payloadRoot = path.join(root, 'payload');
    const versions = path.join(installRoot, 'versions');
    const old = new Date('2026-07-01T00:00:00Z');
    await writeJson(path.join(installRoot, 'current.json'), {
      schemaVersion: 1,
      currentVersion: '0.2.0',
      previousVersion: '0.1.5',
    });
    await writeJson(path.join(installRoot, 'install-layout.json'), {
      schemaVersion: 1,
      payloadRoot,
    });
    await writeJson(path.join(payloadRoot, 'transactions', 'pending-update.json'), {
      phase: 'committed',
      candidateVersion: '0.2.0',
      previousVersion: '0.1.5',
    });
    for (const [version, runtime, environment] of [
      ['0.1.4', '2026.06.0', 'backend-0.1.4'],
      ['0.1.5', '2026.07.1', 'backend-0.1.5'],
      ['0.2.0', '2026.08.0', 'backend-0.2.0'],
    ]) {
      await writeJson(path.join(versions, version, 'version.json'), {
        descriptorVersion: 1,
        runtimeVersion: runtime,
        backendEnvironment: environment,
      });
      await mkdir(path.join(payloadRoot, 'runtimes', `runtime-${runtime}`), { recursive: true });
      await mkdir(path.join(payloadRoot, 'environments', environment), { recursive: true });
    }
    for (const candidate of [
      path.join(versions, '0.1.4'),
      path.join(payloadRoot, 'runtimes', 'runtime-2026.06.0'),
      path.join(payloadRoot, 'environments', 'backend-0.1.4'),
    ]) {
      await utimes(candidate, old, old);
    }

    const result = await cleanupRetainedUpdateComponents({
      installRoot,
      payloadRoot,
      now: () => Date.parse('2026-07-20T12:00:00Z'),
      findReferences: async () => {
        if (mode === 'unavailable') throw new Error('inventory denied');
        if (mode === 'invalid') return ['outside inventory'];
        if (mode === 'version') return [path.join(versions, '0.1.4')];
        if (mode === 'payload') return [path.join(payloadRoot, 'runtimes', 'runtime-2026.06.0'), path.join(payloadRoot, 'environments', 'backend-0.1.4')];
        return [];
      },
    });

    expect(result.removed).toEqual(mode === 'unused' ? [
      'version:0.1.4',
      'runtime:runtime-2026.06.0',
      'environment:backend-0.1.4',
    ] : mode === 'payload' ? ['version:0.1.4'] : []);
    if (['version', 'unavailable', 'invalid'].includes(mode)) {
      await expect(stat(path.join(versions, '0.1.4'))).resolves.toBeTruthy();
    }
    if (mode !== 'unused') {
      await expect(stat(path.join(payloadRoot, 'runtimes', 'runtime-2026.06.0'))).resolves.toBeTruthy();
      await expect(stat(path.join(payloadRoot, 'environments', 'backend-0.1.4'))).resolves.toBeTruthy();
    }
    if (['unavailable', 'invalid'].includes(mode)) expect(result.status).toBe('skipped');
    await expect(stat(path.join(versions, '0.1.5'))).resolves.toBeTruthy();
    await expect(stat(path.join(versions, '0.2.0'))).resolves.toBeTruthy();
    await expect(readFile(path.join(installRoot, 'current.json'), 'utf8')).resolves.toContain('0.2.0');
  });

  it('does nothing before a committed health acknowledgement', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-update-retention-'));
    roots.push(root);
    const installRoot = path.join(root, 'install');
    const payloadRoot = path.join(root, 'payload');
    await writeJson(path.join(installRoot, 'current.json'), {
      schemaVersion: 1,
      currentVersion: '0.2.0',
    });
    await writeJson(path.join(installRoot, 'install-layout.json'), {
      schemaVersion: 1,
      payloadRoot,
    });
    const result = await cleanupRetainedUpdateComponents({ installRoot, payloadRoot });
    expect(result).toEqual({ status: 'skipped', removed: [] });
  });

  it.each([
    ['missing current version directory', 'missing-current'],
    ['missing current version descriptor', 'missing-descriptor'],
    ['transaction does not match the current pointer', 'mismatched-transaction'],
  ])('preserves the entire payload when the version inventory is incomplete: %s', async (_label, mode) => {
    const root = await mkdtemp(path.join(process.cwd(), '.tmp-update-retention-'));
    roots.push(root);
    const installRoot = path.join(root, 'install');
    const payloadRoot = path.join(root, 'payload');
    const currentVersion = '0.2.0';
    const candidateVersion = mode === 'mismatched-transaction' ? '0.3.0' : currentVersion;
    await writeJson(path.join(installRoot, 'current.json'), {
      schemaVersion: 1,
      currentVersion,
    });
    await writeJson(path.join(installRoot, 'install-layout.json'), {
      schemaVersion: 1,
      payloadRoot,
    });
    await writeJson(path.join(payloadRoot, 'transactions', 'pending-update.json'), {
      phase: 'committed',
      candidateVersion,
    });
    if (mode !== 'missing-current') {
      await mkdir(path.join(installRoot, 'versions', currentVersion), { recursive: true });
    }
    if (mode === 'mismatched-transaction') {
      await writeJson(path.join(installRoot, 'versions', currentVersion, 'version.json'), {
        descriptorVersion: 1,
        runtimeVersion: '2026.08.0',
        backendEnvironment: 'backend-0.2.0',
      });
    }
    const runtimePath = path.join(payloadRoot, 'runtimes', 'runtime-2026.07.1');
    const environmentPath = path.join(payloadRoot, 'environments', 'backend-0.1.5');
    await mkdir(runtimePath, { recursive: true });
    await mkdir(environmentPath, { recursive: true });
    const old = new Date('2026-07-01T00:00:00Z');
    await utimes(runtimePath, old, old);
    await utimes(environmentPath, old, old);
    let inventoryCalls = 0;

    const result = await cleanupRetainedUpdateComponents({
      installRoot,
      payloadRoot,
      now: () => Date.parse('2026-07-20T12:00:00Z'),
      findReferences: async () => {
        inventoryCalls += 1;
        return [];
      },
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'version-inventory-incomplete',
      removed: [],
    });
    expect(inventoryCalls).toBe(0);
    await expect(stat(runtimePath)).resolves.toBeTruthy();
    await expect(stat(environmentPath)).resolves.toBeTruthy();
  });
});

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

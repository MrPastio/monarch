import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupRetainedUpdateComponents } from '../../desktop/electron/retention-cleanup.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('update retention cleanup', () => {
  it('keeps current, previous and their payloads while removing only old unreferenced components', async () => {
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
    });

    expect(result.removed).toEqual([
      'version:0.1.4',
      'runtime:runtime-2026.06.0',
      'environment:backend-0.1.4',
    ]);
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
});

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

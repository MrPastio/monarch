import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { applyMonarchFuses, checkMonarchFuses } from '../scripts/electron-fuses.mjs';

describe('packaged Electron fuses', () => {
  it('turns off Node mode, NODE_OPTIONS and inspect, and turns on cookie encryption', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'monarch-fuses-'));
    try {
      const executable = path.join(dir, 'electron.exe');
      await copyFile(path.resolve('node_modules/electron/dist/electron.exe'), executable);
      expect((await checkMonarchFuses(executable)).ok).toBe(false);
      expect(await applyMonarchFuses(executable)).toEqual({ ok: true, wrong: [] });
      expect(await checkMonarchFuses(executable)).toEqual({ ok: true, wrong: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('applies the fuses to the packaged copy before the payload is hashed', async () => {
    const build = await readFile(path.resolve('installer/build-offline-payload.ps1'), 'utf8');
    const copy = build.indexOf('-Destination (Join-Path $runtimeOutput "electron")');
    const fuses = build.indexOf('scripts\\electron-fuses.mjs');
    const hashing = build.indexOf('Hashing exact payload trees');
    expect(copy).toBeGreaterThan(0);
    expect(fuses).toBeGreaterThan(copy);
    expect(hashing).toBeGreaterThan(fuses);
    expect(build).toContain('Assert-NativeSuccess "Electron fuses"');
  });
});

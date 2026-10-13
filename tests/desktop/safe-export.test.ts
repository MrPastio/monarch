import { afterEach, describe, expect, it } from 'vitest';
import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSafeExport } from '../../desktop/electron/safe-export.mjs';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-safe-export-test-'));
  roots.push(root);
  const safeRoot = path.join(root, 'Safe');
  const outRoot = path.join(root, 'Exports');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(safeRoot);
  await mkdir(outRoot);
  return { root, safeRoot, outRoot };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Safe plaintext export boundary', () => {
  it('writes the chosen copy and leaves no temporary file', async () => {
    const { safeRoot, outRoot } = await fixture();
    const destinationPath = path.join(outRoot, 'note.txt');
    const bytes = new TextEncoder().encode('private note');
    const result = await writeSafeExport({ destinationPath, safeRoot, bytes });
    expect(result).toMatchObject({ ok: true, path: destinationPath, bytes: bytes.length });
    expect(await readFile(destinationPath, 'utf8')).toBe('private note');
    expect(await readdir(outRoot)).toEqual(['note.txt']);
  });

  it('refuses any destination inside the vault root', async () => {
    const { safeRoot } = await fixture();
    await expect(writeSafeExport({ destinationPath: path.join(safeRoot, 'manifest.safe'), safeRoot, bytes: new Uint8Array([1]) }))
      .rejects.toThrow('safe-export-protected-root');
    expect(await readdir(safeRoot)).toEqual([]);
  });

  it('replaces a chosen hardlink without writing into its target', async () => {
    const { safeRoot, outRoot } = await fixture();
    const protectedPath = path.join(safeRoot, 'protected.bin');
    await writeFile(protectedPath, 'protected');
    const destinationPath = path.join(outRoot, 'chosen.txt');
    await link(protectedPath, destinationPath);
    await writeSafeExport({ destinationPath, safeRoot, bytes: new TextEncoder().encode('exported') });
    expect(await readFile(protectedPath, 'utf8')).toBe('protected');
    expect(await readFile(destinationPath, 'utf8')).toBe('exported');
  });

  it('keeps the previous destination if the Safe session closes before commit', async () => {
    const { safeRoot, outRoot } = await fixture();
    const destinationPath = path.join(outRoot, 'chosen.txt');
    await writeFile(destinationPath, 'existing');
    await expect(writeSafeExport({
      destinationPath, safeRoot, bytes: new TextEncoder().encode('private'), shouldCommit: () => false,
    })).rejects.toThrow('safe-export-session-changed');
    expect(await readFile(destinationPath, 'utf8')).toBe('existing');
    expect(await readdir(outRoot)).toEqual(['chosen.txt']);
  });

  it('awaits the utility recheck before replacing an existing destination', async () => {
    const { safeRoot, outRoot } = await fixture();
    const destinationPath = path.join(outRoot, 'chosen.txt');
    await writeFile(destinationPath, 'existing');
    let finishCheck!: (valid: boolean) => void;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    const exporting = writeSafeExport({
      destinationPath, safeRoot, bytes: new TextEncoder().encode('private'),
      shouldCommit: () => { checkStarted(); return new Promise<boolean>((resolve) => { finishCheck = resolve; }); },
    });
    const rejection = expect(exporting).rejects.toThrow('safe-export-session-changed');
    await started;
    expect(await readFile(destinationPath, 'utf8')).toBe('existing');
    finishCheck(false);
    await rejection;
    expect(await readFile(destinationPath, 'utf8')).toBe('existing');
    expect(await readdir(outRoot)).toEqual(['chosen.txt']);
  });

  it('cleans the staged copy if the utility recheck fails', async () => {
    const { safeRoot, outRoot } = await fixture();
    const destinationPath = path.join(outRoot, 'chosen.txt');
    await writeFile(destinationPath, 'existing');
    await expect(writeSafeExport({
      destinationPath, safeRoot, bytes: new TextEncoder().encode('private'),
      shouldCommit: async () => { throw new Error('utility-closed'); },
    })).rejects.toThrow('utility-closed');
    expect(await readFile(destinationPath, 'utf8')).toBe('existing');
    expect(await readdir(outRoot)).toEqual(['chosen.txt']);
  });
});

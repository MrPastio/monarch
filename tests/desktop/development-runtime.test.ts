import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { prepareDevelopmentMaxBundle, prepareDevelopmentRuntime } from '../../desktop/electron/development-runtime.mjs';

const run = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(path.resolve('.test-tmp/development-runtime-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  const entry = path.join(root, 'src', 'main.ts');
  const options = { workspaceRoot: root, outputRoot: path.join(root, 'runtime'), preferSource: true,
    resolveLaunch: () => ({ kind: 'tsx', entryPath: entry, args: ['--import', 'tsx', entry] }) };
  return { entry, options };
}
describe('fresh source runtime', () => {
  it('executes new TypeScript after each build rather than a stale dist file', async () => {
    const { entry, options } = await fixture();
    await writeFile(entry, 'const version: string = "first"; console.log(version);');
    let launch = await prepareDevelopmentRuntime(options);
    expect(launch.kind).toBe('source-bundle');
    expect((await run(process.execPath, launch.args)).stdout.trim()).toBe('first');
    await writeFile(entry, 'const version: string = "second"; console.log(version);');
    launch = await prepareDevelopmentRuntime(options);
    expect((await run(process.execPath, launch.args)).stdout.trim()).toBe('second');
    await writeFile(entry, 'const broken: =');
    await expect(prepareDevelopmentRuntime(options)).rejects.toThrow();
    expect((await run(process.execPath, launch.args)).stdout.trim()).toBe('second');
  });
  it('leaves packaged runtime selection intact without starting a source builder', async () => {
    const buildSource = vi.fn();
    const installed = { kind: 'bundle', entryPath: 'installed.mjs', args: ['installed.mjs'] };
    expect(await prepareDevelopmentRuntime({ workspaceRoot: 'installed', preferSource: false,
      buildSource, resolveLaunch: () => installed })).toBe(installed);
    expect(buildSource).not.toHaveBeenCalled();
  });
  it('refuses an empty build without replacing the successful runtime', async () => {
    const { entry, options } = await fixture();
    await writeFile(entry, 'console.log("valid")');
    const launch = await prepareDevelopmentRuntime(options);
    const before = await readFile(launch.entryPath);
    await expect(prepareDevelopmentRuntime({ ...options, buildSource: async () => ({ outputFiles: [] }) }))
      .rejects.toThrow('development-runtime-build-empty');
    expect(await readFile(launch.entryPath)).toEqual(before);
  });
});

describe('fresh source MAX bundle', () => {
  it('rebuilds dist/astra-max-electron.mjs from source and keeps the last bundle when a build fails', async () => {
    const root = await mkdtemp(path.resolve('.test-tmp/development-max-'));
    await mkdir(path.join(root, 'src', 'agent-v3'), { recursive: true });
    const entry = path.join(root, 'src', 'agent-v3', 'max-electron-entry.ts');
    await writeFile(entry, 'export const version: string = "first";');
    expect(await prepareDevelopmentMaxBundle({ workspaceRoot: root, preferSource: true })).toBe(true);
    const bundle = path.join(root, 'dist', 'astra-max-electron.mjs');
    expect(await readFile(bundle, 'utf8')).toContain('"first"');
    await writeFile(entry, 'export const broken: =');
    await expect(prepareDevelopmentMaxBundle({ workspaceRoot: root, preferSource: true })).rejects.toThrow();
    expect(await readFile(bundle, 'utf8')).toContain('"first"');
    const buildSource = vi.fn();
    expect(await prepareDevelopmentMaxBundle({ workspaceRoot: root, preferSource: false, buildSource })).toBe(false);
    expect(buildSource).not.toHaveBeenCalled();
  });
});

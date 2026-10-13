import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const roots: string[] = [];
afterEach(async () => {
  const parent = await realpath('.test-tmp');
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root);
    expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root).startsWith('astra-telegram-electron-')).toBe(true);
    await rm(root, { recursive: true, force: false });
  }
});

describe('Astra Telegram actual Electron process boundary', () => {
  it('crosses real preload IPC and returns no native path to renderer', async () => {
    const parent = await realpath('.test-tmp'); expect(parent).toBe('D:\\Monarch-test-tmp-astra-v3');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-telegram-electron-'))); roots.push(root);
    const selectedPath = path.join(root, 'selected.txt'); await writeFile(selectedPath, 'electron acceptance', 'utf8');
    const executable = path.resolve('node_modules', 'electron', 'dist', 'electron.exe');
    const fixture = path.resolve('tests', 'fixtures', 'agent-v3', 'astra-telegram-electron-acceptance.mjs');
    const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(executable, [fixture, root, selectedPath], { cwd: process.cwd(), windowsHide: true,
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', MONARCH_TELEGRAM_AUTO_START: '0',
          MONARCH_SECRETS_ROOT: path.join(root, 'secrets'), MONARCH_DATA_ROOT: path.join(root, 'data'),
          MONARCH_STATE_ROOT: path.join(root, 'state'), MONARCH_WORKSPACE_ROOT: root },
        stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 25_000); timer.unref();
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(output.code, output.stderr).toBe(0);
    const line = output.stdout.split(/\r?\n/u).find(value => value.startsWith('ASTRA_ELECTRON_ACCEPTANCE '));
    expect(line, output.stdout).toBeTruthy();
    expect(JSON.parse(line!.slice('ASTRA_ELECTRON_ACCEPTANCE '.length))).toEqual({ ok: true,
      actualPreloadIpc: true, hostBinding: true, rawPathReturned: false, authority: 'read-only' });
  }, 30_000);
});

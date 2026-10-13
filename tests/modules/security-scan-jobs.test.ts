import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecurityClient } from '../../src/modules/security/client';
import { SecurityModule } from '../../src/modules/security';
import { MonarchKernel } from '../../src/core';

async function fixture(body: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-security-scan-'));
  const module = path.join(root, 'src', 'monarch_security');
  await mkdir(module, { recursive: true });
  await writeFile(path.join(module, '__init__.py'), '');
  await writeFile(path.join(module, '__main__.py'), body);
  const client = new SecurityClient({ projectRoot: root, dataRoot: path.join(root, 'data'), configPath: path.join(root, 'config.toml'),
    pythonPath: process.env.MONARCH_SECURITY_PYTHON || path.resolve('security/.venv/Scripts/python.exe') });
  return { root, client };
}

describe('manual Security scan workers', () => {
  it('executes the native file worker through Kernel and reads the same job', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-security-kernel-'));
    const configPath = path.join(root, 'config.toml');
    const target = path.join(root, 'ordinary.txt');
    await writeFile(configPath, '[notifications]\nenabled=false\n');
    await writeFile(target, 'Local read-only Security acceptance.');
    const client = new SecurityClient({ projectRoot: path.resolve('security'), dataRoot: path.join(root, 'data'), configPath,
      pythonPath: process.env.MONARCH_SECURITY_PYTHON || path.resolve('security/.venv/Scripts/python.exe') });
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false, permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' } });
    kernel.registerModule(new SecurityModule(client));
    const execute = (capabilityId: string, input = {}) => kernel.execute({ id: crypto.randomUUID(), intentId: 'local-security-acceptance', moduleId: 'security', capabilityId,
      input, createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: false });
    try {
      await kernel.start();
      const started = await execute('security.scan.start', { kind: 'file', path: target });
      expect(started).toMatchObject({ ok: true, output: { payload: { status: 'running' } } });
      await expect.poll(() => client.scans.status()?.status, { timeout: 12000 }).toBe('completed');
      const read = await execute('security.scan.status');
      expect(read).toMatchObject({ ok: true, output: { payload: { jobId: client.scans.status()?.jobId, status: 'completed', result: { assessment: { event: { subject: target } } } } } });
      expect(await execute('security.scan.cancel', { jobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })).toMatchObject({ ok: false, error: 'scan-job-not-found' });
    } finally { await kernel.stop(); client.dispose(); }
  }, 20000);

  it('returns before completion and reattaches to the same completed result', async () => {
    const { client } = await fixture('import json, time\ntime.sleep(.2)\nprint(json.dumps({"summary":{"events":4},"complete":False,"coverage":{"checked":4,"total":5}}))');
    try {
      const job = client.scans.start('system');
      expect(job.status).toBe('running');
      expect(() => client.scans.start('system')).toThrow('Другая проверка');
      expect(client.scans.cancel('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBeNull();
      await expect.poll(() => client.scans.status()?.status).toBe('completed');
      expect(client.scans.status()).toMatchObject({ jobId: job.jobId, result: { complete: false, summary: { events: 4 } } });
      expect(client.scans.status()?.jobId).toBe(job.jobId);
    } finally { client.dispose(); }
  });

  it('never converts malformed output into a clean scan', async () => {
    const { client } = await fixture('print("not a scan result")');
    try {
      client.scans.start('system');
      await expect.poll(() => client.scans.status()?.status).toBe('failed');
      expect(client.scans.status()?.result).toBeNull();
    } finally { client.dispose(); }
  });

  it('cancels only the owned worker tree and waits for confirmed exit', async () => {
    const { root, client } = await fixture(`import subprocess, sys, time\nfrom pathlib import Path\nsubprocess.Popen([sys.executable, '-c', "import time; from pathlib import Path; time.sleep(3); Path('late-result').write_text('unexpected')"])\nPath('ready').write_text('ready')\ntime.sleep(30)\n`);
    try {
      const job = client.scans.start('file', path.join(root, 'sample.txt'));
      await expect.poll(async () => readFile(path.join(root, 'ready'), 'utf8').catch(() => '')).toBe('ready');
      expect(client.scans.cancel(job.jobId)?.status).toBe('stopping');
      expect(() => client.scans.start('system')).toThrow('Другая проверка');
      await expect.poll(() => client.scans.status()?.status).toBe('cancelled');
      await new Promise(resolve => setTimeout(resolve, 3200));
      expect(await access(path.join(root, 'late-result')).then(() => true, () => false)).toBe(false);
    } finally { client.dispose(); }
  }, 10000);
});

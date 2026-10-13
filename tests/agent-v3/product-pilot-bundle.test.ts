import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let child: ChildProcessWithoutNullStreams | null = null;
const roots: string[] = [];

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child!.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  child = null;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('packaged Astra same-owner product pilot', () => {
  it('runs a certified workspace read from the exact installed-form runtime bundle', async () => {
    const markedParent = await realpath('.test-tmp');
    expect(markedParent).toBe('D:\\Monarch-test-tmp-astra-v3');
    const root = await realpath(await mkdtemp(path.join(markedParent, 'astra-v3-bundle-pilot-')));
    roots.push(root);
    await writeFile(path.join(root, '.fixture-marker'), 'astra-product-bundle-v1', { flag: 'wx' });

    const installRoot = path.join(root, 'install');
    const versionRoot = path.join(installRoot, 'versions', '0.3.0-test');
    const bundle = path.join(versionRoot, 'dist', 'monarch-server.mjs');
    const workspace = path.join(root, 'workspace');
    await Promise.all([mkdir(versionRoot, { recursive: true }), mkdir(workspace)]);
    await writeFile(path.join(workspace, 'installed.txt'), 'installed Astra bundle evidence 🟠\n', { flag: 'wx' });
    execFileSync(process.execPath, ['scripts/build-runtime-bundle.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, MONARCH_RUNTIME_BUNDLE_OUTPUT: bundle },
      stdio: 'pipe', timeout: 60_000, windowsHide: true,
    });

    const port = await reserveLoopbackPort();
    const desktopToken = 'bundle-desktop-' + 'x'.repeat(48);
    const hostToken = 'bundle-host-' + 'y'.repeat(48);
    const apiToken = 'bundle-api-' + 'z'.repeat(48);
    child = spawn(process.execPath, [bundle, 'serve', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: versionRoot,
      env: {
        ...process.env,
        MONARCH_INSTALL_ROOT: installRoot,
        MONARCH_VERSION_ROOT: versionRoot,
        MONARCH_PAYLOAD_ROOT: path.join(root, 'payload'),
        MONARCH_CONFIG_ROOT: path.join(root, 'config'),
        MONARCH_DATA_ROOT: path.join(root, 'data'),
        MONARCH_LOGS_ROOT: path.join(root, 'logs'),
        MONARCH_GENERATED_ROOT: path.join(root, 'generated'),
        MONARCH_MODELS_ROOT: path.join(root, 'models'),
        MONARCH_SECRETS_ROOT: path.join(root, 'secrets'),
        MONARCH_STATE_ROOT: path.join(root, 'state'),
        MONARCH_WORKSPACE_ROOT: workspace,
        MONARCH_CODER_WORKSPACE_ROOT: path.join(root, 'coder-workspace'),
        MONARCH_CODER_SANDBOX_ROOT: path.join(root, 'coder-sandbox'),
        MONARCH_UI_PORT: String(port),
        MONARCH_STRICT_PORT: '1',
        MONARCH_API_TOKEN: apiToken,
        MONARCH_DESKTOP_ATTESTATION_TOKEN: desktopToken,
        MONARCH_ASTRA_V3_HOST_TOKEN: hostToken,
        MONARCH_ASTRA_V3_JOURNAL_KEY: Buffer.alloc(32, 0x50).toString('base64'),
        MONARCH_ASTRA_V3_PILOT: 'runtime-same-owner-v1',
        MONARCH_TELEGRAM_AUTO_START: '0',
        MONARCH_STT_PREWARM_ON_ACTIVATE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (value) => { stdout += String(value); });
    child.stderr.on('data', (value) => { stderr += String(value); });
    const base = `http://127.0.0.1:${port}`;
    await waitReady(base, () => `${stdout}\n${stderr}`);

    const hostHeaders = {
      'content-type': 'application/json',
      'x-monarch-desktop-attestation': desktopToken,
      'x-monarch-astra-host-token': hostToken,
    };
    const selected = await fetch(base + '/api/astra/v3/host/target-selections', {
      method: 'POST', headers: hostHeaders, body: JSON.stringify({
        version: 1, conversationId: 'installed_bundle_chat', requestId: 'installed_bundle_target',
        access: 'observe', selectedPath: path.join(workspace, 'installed.txt'),
      }),
    });
    const selectedBody = await selected.json() as any;
    expect(selected.status, JSON.stringify(selectedBody)).toBe(201);
    expect(JSON.stringify(selectedBody)).not.toContain(workspace);

    const request = {
      version: 1, clientRequestId: 'installed_bundle_read', conversationId: 'installed_bundle_chat',
      inputMessageId: 'installed_bundle_message', text: 'Read only the selected installed fixture.',
      privacyMode: 'persistent', selectionId: selectedBody.selection.selectionId,
      goal: { kind: 'observe', targets: ['picked'] },
    };
    const desktopHeaders = { 'content-type': 'application/json', 'x-monarch-desktop-attestation': desktopToken };
    const admitted = await fetch(base + '/api/astra/v3/read-tasks', {
      method: 'POST', headers: desktopHeaders, body: JSON.stringify(request),
    });
    const admittedBody = await admitted.json() as any;
    expect(admitted.status, JSON.stringify(admittedBody)).toBe(202);
    const item = base + '/api/astra/v3/read-tasks/' + admittedBody.task.id;
    const query = '?' + new URLSearchParams({ conversationId: request.conversationId, inputMessageId: request.inputMessageId });
    let task = admittedBody.task;
    const deadline = Date.now() + 10_000;
    while (!task.message && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const response = await fetch(item + query, { headers: desktopHeaders });
      expect(response.ok).toBe(true);
      task = (await response.json() as any).task;
    }
    expect(task).toMatchObject({ status: 'completed', message: { verification: 'internal-read-certificate' } });
    expect(JSON.stringify(task)).toContain('installed Astra bundle evidence 🟠');
    expect(JSON.stringify(task)).not.toContain(workspace);
    expect(await readFile(path.join(workspace, 'installed.txt'), 'utf8')).toBe('installed Astra bundle evidence 🟠\n');
  }, 120_000);
});

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('loopback-port-unavailable');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitReady(base: string, diagnostics: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + '/api/ready');
      if (response.ok) return;
    } catch {
      // The exact child process is still starting.
    }
    if (child?.exitCode !== null) throw Error(`bundled-runtime-exited:${child?.exitCode}\n${diagnostics()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`bundled-runtime-not-ready\n${diagnostics()}`);
}

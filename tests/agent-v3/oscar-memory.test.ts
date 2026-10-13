import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OscarClient } from '../../src/modules/oscar/client';
import { createAstraOscarMemoryPorts, createAstraOscarMemoryFromSettings } from '../../src/app/astra-oscar-memory';
import { LocalOwnerDevSettingsStore } from '../../src/settings/owner-dev';
import { isAstraMemoryRecallCurrent } from '../../src/agent-v3/memory-recall';

let root: string;
const marker = 'astra-v3-memory-server-synthetic-only';
beforeEach(async () => {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-memory-')));
  await writeFile(path.join(root, '.fixture-marker'), marker, { flag: 'wx' });
  await writeFile(path.join(root, 'oscar_token.txt'), 'synthetic-memory-only', { flag: 'wx' });
});
afterEach(async () => {
  expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(await realpath('.test-tmp'));
  expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(root, { recursive: true });
});

describe('explicit OscarClient -> Astra live recall composition', () => {
  it('binds durable settings revision: off/on never re-admits the old policy', async () => {
    const settings = new LocalOwnerDevSettingsStore(root);
    const client = { retrieveAgentMemoryContext: vi.fn(async () => ({})), readMemoryContextValidity: async () => ({}) };
    const ports = createAstraOscarMemoryFromSettings(client, settings);
    expect(ports.isCurrent()).toBe(true); expect(ports.admission.isPolicyCurrent('dev_0')).toBe(true);
    const update = async (revision: number, patch: Record<string, boolean>) => settings.execute({ schemaVersion: 1,
      clientRequestId: 'policy_' + revision, command: 'dev.update', scope: { type: 'chat' }, expectedRevision: revision,
      payload: { patch }, policyDecisionHash: 'b'.repeat(64) });
    await update(0, { memoryEnabled: false });
    expect(ports.isCurrent()).toBe(false);
    await update(1, { memoryEnabled: true });
    expect(ports.isCurrent()).toBe(true); expect(ports.admission.isPolicyCurrent('dev_0')).toBe(false);
    expect(ports.admission.isPolicyCurrent('dev_2')).toBe(true);
    const reopened = createAstraOscarMemoryFromSettings(client, new LocalOwnerDevSettingsStore(root));
    expect(reopened.admission.isPolicyCurrent('dev_2')).toBe(true);
    expect(reopened.admission.isPolicyCurrent('dev_0')).toBe(false);
    await update(2, { zeroRetentionEnabled: true });
    expect(ports.isCurrent()).toBe(false); expect(ports.admission.isPolicyCurrent('dev_2')).toBe(false);
    expect(client.retrieveAgentMemoryContext).not.toHaveBeenCalled();
  });
  it('retrieves actual synthetic Memory V4 content and detects deletion through the real client', async () => {
    const child = spawn(path.resolve('oscar/.venv/Scripts/python.exe'), ['-B', path.resolve('tests/fixtures/agent-v3/memory-server.py'), root],
      { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    child.stdin.end();
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = '', errors = '';
        const timer = setTimeout(() => reject(Error('fixture-start-timeout')), 10000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(Error('fixture-exit:' + errors.slice(0, 1000))); });
        child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
        child.stdout.on('data', chunk => { output += chunk; if (!output.includes('\n')) return;
          clearTimeout(timer); const info = JSON.parse(output.split('\n')[0]!); expect(info.marker).toBe(marker); resolve(info.endpoint); });
      });
      const client = new OscarClient({ apiBase: endpoint, autoStart: false, secretsRoot: root });
      const ports = createAstraOscarMemoryPorts(client, () => ({ enabled: true, revision: '1' }), 2000);
      const recalled = await ports.admission.prepare({ source: 'desktop', privacy: 'persistent', destination: 'local', operation: 'analyze', query: 'syntheticneedle' });
      expect(recalled.status).toBe('prepared'); if (recalled.status !== 'prepared') throw Error('recall-not-prepared');
      expect(recalled.snapshot.items[0]?.text).toBe('syntheticneedle use concise answers');
      expect(isAstraMemoryRecallCurrent(recalled.snapshot, await ports.readValidity(new AbortController().signal))).toBe(true);
      const deleted = await fetch(endpoint + '/fixture/delete', { method: 'POST', headers: { 'X-Oscar-Token': 'synthetic-memory-only' }, body: '{}' });
      expect(deleted.ok).toBe(true);
      expect(isAstraMemoryRecallCurrent(recalled.snapshot, await ports.readValidity(new AbortController().signal))).toBe(false);
    } finally { if (child.exitCode === null) child.kill(); await exited; }
  });
  it('retrieves once with bounded local scope, checks live metadata and never starts backend', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const token = 'sha256:' + 'a'.repeat(64);
    const live = { schemaVersion: 1, scope: { type: 'chat' }, revision: '1:0', crossChatEnabled: false, validityToken: token };
    const server = http.createServer((req, res) => {
      let text = ''; req.on('data', value => { text += value; });
      req.on('end', () => {
        calls.push({ path: req.url!, body: JSON.parse(text) });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url?.endsWith('/validity') ? live : { ...live,
          explicitMemories: [], episodes: [], budgetChars: 2400, usedChars: 0,
          engine: 'synthetic-loopback', semanticTimedOut: false, cache: 'miss' }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const client = new OscarClient({ apiBase: `http://127.0.0.1:${address.port}`, autoStart: true, secretsRoot: root });
    const startup = vi.spyOn(client as any, 'ensureBackendAvailable').mockRejectedValue(Error('startup-forbidden'));
    let enabled = true;
    const ports = createAstraOscarMemoryPorts(client, () => ({ enabled, revision: '1' }), 2000);
    const request = { source: 'desktop' as const, privacy: 'persistent' as const, destination: 'local' as const,
      operation: 'analyze' as const, query: 'Synthetic query' };
    try {
      const prepared = await ports.admission.prepare(request);
      expect(prepared.status).toBe('prepared');
      if (prepared.status !== 'prepared') throw Error('expected-prepared');
      expect(isAstraMemoryRecallCurrent(prepared.snapshot, await ports.readValidity(new AbortController().signal))).toBe(true);
      expect(calls).toEqual([
        { path: '/api/memory/context', body: { schemaVersion: 1, query: request.query, scope: { type: 'chat' } } },
        { path: '/api/memory/context/validity', body: { schemaVersion: 1, scope: { type: 'chat' } } },
      ]);
      for (const excluded of [{ destination: 'max' as const }, { source: 'api' as const }, { privacy: 'incognito' as const }]) {
        expect(await ports.admission.prepare({ ...request, ...excluded })).toEqual({ status: 'omitted', reason: 'scope-excluded' });
      }
      enabled = false;
      expect(ports.admission.isAdmissible(request, prepared)).toBe(false);
      expect(await ports.admission.prepare(request)).toEqual({ status: 'omitted', reason: 'disabled' });
      const controller = new AbortController(); controller.abort();
      await expect(client.retrieveAgentMemoryContext(request.query, controller.signal)).rejects.toThrow();
      expect(calls).toHaveLength(2); expect(startup).not.toHaveBeenCalled();
    } finally { startup.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('rejects tokenless legacy retrieval on the live path', async () => {
    const ports = createAstraOscarMemoryPorts({ retrieveAgentMemoryContext: async () => ({ schemaVersion: 1 }),
      readMemoryContextValidity: async () => ({}) }, () => ({ enabled: true, revision: '1' }));
    expect(await ports.admission.prepare({ source: 'desktop', privacy: 'persistent', destination: 'local',
      operation: 'analyze', query: 'fixture' })).toEqual({ status: 'omitted', reason: 'unavailable' });
  });
});

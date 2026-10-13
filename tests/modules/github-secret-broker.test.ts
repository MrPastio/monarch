import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createGitHubSecretBroker, startGitHubSecretServer } from '../../desktop/electron/github-secret-broker.mjs';

const fixtureParent = path.resolve('runtime', 'github-broker-tests');
const roots: string[] = [];
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
  decryptString: (value: Buffer) => Buffer.from(value.toString('utf8').replace(/^protected:/u, ''), 'base64').toString('utf8'),
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});

beforeAll(() => mkdir(fixtureParent, { recursive: true }));
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() {
  const value = await mkdtemp(path.join(fixtureParent, 'case-'));
  roots.push(value);
  return value;
}
const token = 'github_pat_test_value';

describe('GitHub main-process secret broker', () => {
  it('verifies an exact repository allowlist and stores only an encrypted token', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/user')) return json({ login: 'owner' });
      return json({ full_name: 'owner/project', private: true, default_branch: 'main', html_url: 'https://github.com/owner/project' });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const dataRoot = await root();
    const broker = createGitHubSecretBroker({ dataRoot, safeStorage, fetchImpl, restrictAccess: async () => true });
    await expect(broker.configure({ token, repositories: ['owner/project'],
      permissions: { read: true, issues: false, pullRequests: false } })).resolves.toEqual({
      connected: true, login: 'owner', repositories: ['owner/project'],
      permissions: { read: true, issues: false, pullRequests: false },
    });
    const bytes = await readFile(path.join(dataRoot, 'github-token.encrypted'));
    expect(bytes.toString('utf8')).toContain('protected:');
    expect(bytes.toString('utf8')).not.toContain(token);
    expect(JSON.stringify(await broker.status())).not.toContain(token);
    expect(calls.every(call => (call.options.headers as Record<string, string>).authorization === `Bearer ${token}`)).toBe(true);
    expect(calls.every(call => (call.options.headers as Record<string, string>)['x-github-api-version'] === '2022-11-28')).toBe(true);
  });

  it('enforces Monarch permissions, repository scope and operation-specific input keys', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/user')) return json({ login: 'owner' });
      if (String(url).endsWith('/repos/owner/project')) return json({ full_name: 'owner/project' });
      if (String(url).endsWith('/issues') && options.method === 'POST') {
        return json({ number: 7, title: 'Typed agent task', state: 'open', html_url: 'https://github.com/owner/project/issues/7' });
      }
      return json([]);
    }) as unknown as typeof fetch;
    const broker = createGitHubSecretBroker({ dataRoot: await root(), safeStorage, fetchImpl, restrictAccess: async () => true });
    await broker.configure({ token, repositories: ['owner/project'],
      permissions: { read: false, issues: true, pullRequests: false } });
    await expect(broker.operation('issue.create', { repository: 'owner/project', title: 'Typed agent task', body: 'Receipt-bound.' }))
      .resolves.toMatchObject({ repository: 'owner/project', number: 7 });
    expect(JSON.parse(String(calls.at(-1)?.options.body))).toEqual({ title: 'Typed agent task', body: 'Receipt-bound.' });
    await expect(broker.operation('repositories.list', {})).rejects.toThrow('github:permission-required');
    await expect(broker.operation('issues.list', { repository: 'other/project' })).rejects.toThrow('github:repository-denied');
    await expect(broker.operation('issues.list', { repository: 'owner/project', body: 'cross-operation-smuggling' }))
      .rejects.toThrow('github:input');
    await expect(broker.operation('pull-request.comment', { repository: 'owner/project', pullNumber: 1, body: 'No grant.' }))
      .rejects.toThrow('github:permission-required');
  });

  it('propagates runtime cancellation into the active GitHub request', async () => {
    let stall = false;
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const fetchMock = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      if (stall) {
        markEntered();
        return new Promise<Response>((_resolve, reject) => options.signal?.addEventListener('abort',
          () => reject(Error('github-request-aborted')), { once: true }));
      }
      if (String(url).endsWith('/user')) return json({ login: 'owner' });
      return json({ full_name: 'owner/project' });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const broker = createGitHubSecretBroker({
      dataRoot: await root(), safeStorage, fetchImpl, restrictAccess: async () => true,
    });
    await broker.configure({ token, repositories: ['owner/project'],
      permissions: { read: true, issues: false, pullRequests: false } });
    stall = true;
    const controller = new AbortController();
    const pending = broker.operation('repositories.list', {}, controller.signal);
    await entered;
    controller.abort('stop');
    await expect(pending).rejects.toThrow('github-request-aborted');
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });

  it('bounds text-file reads and protects the loopback host with a separate bearer', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/user')) return json({ login: 'owner' });
      if (String(url).endsWith('/repos/owner/project')) return json({ full_name: 'owner/project' });
      if (String(url).includes('/contents/src/index.ts')) return json({ type: 'file', encoding: 'base64',
        sha: 'abc123', content: Buffer.from('export const ready = true;\n').toString('base64') });
      return json({});
    }) as unknown as typeof fetch;
    const broker = createGitHubSecretBroker({ dataRoot: await root(), safeStorage, fetchImpl, restrictAccess: async () => true });
    await broker.configure({ token, repositories: ['owner/project'],
      permissions: { read: true, issues: false, pullRequests: false } });
    await expect(broker.operation('repository.file.read', { repository: 'owner/project', path: 'src/index.ts', ref: 'main' }))
      .resolves.toMatchObject({ repository: 'owner/project', path: 'src/index.ts', ref: 'main', content: 'export const ready = true;\n' });
    await expect(broker.operation('repository.file.read', { repository: 'owner/project', path: '../secret' }))
      .rejects.toThrow('github:input');
    const server = await startGitHubSecretServer(broker);
    try {
      await expect(fetch(server.endpoint, { method: 'POST', body: '{}' }).then(response => response.status)).resolves.toBe(401);
      const response = await fetch(server.endpoint, { method: 'POST', headers: {
        authorization: `Bearer ${server.bearerToken}`, 'content-type': 'application/json',
      }, body: JSON.stringify({ operation: 'status', input: {} }) });
      await expect(response.json()).resolves.toMatchObject({ result: { connected: true, login: 'owner' } });
    } finally { await server.close(); }
  });
});

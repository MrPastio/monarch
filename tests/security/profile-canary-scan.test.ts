import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { isSealed } from '../../src/core/sealed-file';
import { setStoreProtectionForTesting } from '../../src/core/store-protection';
import {
  InMemoryOscarTurnStore,
  LocalJsonOscarTurnStore,
  OscarAttachmentStore,
  OscarDataEgressConsentStore,
  OscarTurnCoordinator,
} from '../../src/oscar-turn';
import { executeTypedCapability } from '../helpers/typed-capability';

/** Monarch Security stage 3e. A harmless unique marker goes through the
 * ordinary product paths of one profile — a chat turn with an attachment, the
 * answer, memory and profile — and is then searched for in every file of the
 * profile and in everything the runtime printed (Desktop keeps that output as
 * its log). With sealed storage it must be found nowhere. */

const ATTESTATION = randomUUID();
const roots: string[] = [];
afterEach(async () => {
  setStoreProtectionForTesting(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('profile-wide marker scan', () => {
  it('finds the marker in no file of the profile and in no runtime output with sealed storage', async () => {
    const scan = await runProfile(true);
    expect(scan.turnStoreSealed).toBe(true);
    expect(scan.hits).toEqual([]);
    expect(scan.output.includes(scan.marker)).toBe(false);
  }, 30_000);

  it('finds the marker in the same profile when the person turned encryption off (scanner control)', async () => {
    const scan = await runProfile(false);
    expect(scan.turnStoreSealed).toBe(false);
    expect(scan.hits).toEqual(expect.arrayContaining([path.join('runtime', 'oscar', 'turns.v1.json'),
      path.join('data', 'local', 'profile.json')]));
  }, 30_000);
});

async function runProfile(sealed: boolean) {
    const marker = `MARKER${randomBytes(8).toString('hex')}`;
    // Keys arrive the way Desktop hands them to the runtime; the application
    // takes them from the environment itself.
    setStoreProtectionForTesting(undefined);
    if (sealed) {
      vi.stubEnv('MONARCH_STORE_PROTECTION', 'desktop');
      vi.stubEnv('MONARCH_STORE_KEY', randomBytes(32).toString('base64url'));
      vi.stubEnv('MONARCH_OSCAR_DB_KEY', randomBytes(32).toString('hex'));
    }
    const output = captureOutput();
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-marker-scan-'));
    roots.push(root);

    const runtimeRoot = path.join(root, 'runtime');
    const attachments = new OscarAttachmentStore(runtimeRoot);
    const consents = new OscarDataEgressConsentStore(runtimeRoot);
    const coordinator = new OscarTurnCoordinator({
      persistentStore: new LocalJsonOscarTurnStore(path.join(runtimeRoot, 'oscar', 'turns.v1.json')),
      volatileStore: new InMemoryOscarTurnStore(),
      answerExecutor: async () => (async function* () {
        yield { type: 'token' as const, token: `Ответ про ${marker}.` };
        yield { type: 'done' as const };
      })(),
      persistMessage: async () => undefined,
      resolveAttachments: (ids, privacy, source, conversationId) => attachments.resolve(ids, privacy, source, conversationId),
    });
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace', 'security', 'profile'],
      enableLocalSystemRouter: false,
      oscarTurnCoordinator: coordinator,
      oscarAttachmentStore: attachments,
      oscarDataEgressConsentStore: consents,
    });
    await app.start();
    const server = createMonarchHttpServer({
      app, publicDirectory: path.join(process.cwd(), 'src', 'ui', 'public'), host: '127.0.0.1', port: 4317,
      apiToken: randomUUID(), desktopAttestationToken: ATTESTATION, requireApiToken: true,
    });
    const baseUrl = await listen(server);
    try {
      const conversationId = `conversation_${randomUUID().replaceAll('-', '')}`;
      const uploaded = await postJson(`${baseUrl}/api/oscar/attachments`, {
        version: 1, conversationId, privacyMode: 'persistent', name: 'note.txt', mimeType: 'text/plain',
        dataBase64: Buffer.from(`Заметка ${marker}`).toString('base64'),
      });
      expect(uploaded.status).toBe(201);
      const attachmentId = (await uploaded.json() as { attachment: { id: string } }).attachment.id;
      const created = await postJson(`${baseUrl}/api/oscar/turns`, {
        version: 1, clientRequestId: `marker_${randomUUID()}`, conversationId,
        text: `Что значит слово ${marker}?`, attachmentIds: [attachmentId],
      });
      expect(created.status).toBe(202);
      const terminal = ['succeeded', 'blocked', 'failed', 'cancelled'];
      await waitFor(async () => (await coordinator.persistentStore.listTurns())
        .some(turn => turn.conversationId === conversationId && terminal.includes(turn.status)));
      const [turn] = (await coordinator.persistentStore.listTurns()).filter(item => item.conversationId === conversationId);
      expect(turn?.status, JSON.stringify(turn).slice(0, 1500)).toBe('succeeded');

      const kernel = app.runtime.kernel;
      const profile = await executeTypedCapability(kernel, 'profile.update',
        { displayName: marker }, { confirmed: true });
      expect(profile.ok, `${profile.error} ${profile.summary}`).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await app.stop();
    }

    expect(process.env.MONARCH_STORE_KEY).toBeUndefined();
    const files = await profileFiles(root);
    // The scan is only meaningful when the stores really wrote to this profile.
    const turnStore = path.join(runtimeRoot, 'oscar', 'turns.v1.json');
    expect(files).toContain(turnStore);

    const hits: string[] = [];
    for (const file of files) {
      const bytes = await readFile(file);
      if (containsMarker(bytes, marker)) hits.push(path.relative(root, file));
    }
    return { marker, hits, output: output.text(), turnStoreSealed: isSealed(await readFile(turnStore)) };
}

function containsMarker(bytes: Buffer, marker: string): boolean {
  return bytes.includes(Buffer.from(marker, 'utf8'))
    || bytes.includes(Buffer.from(marker, 'utf16le'))
    || bytes.includes(Buffer.from(Buffer.from(marker).toString('base64').slice(0, 16)));
}

async function profileFiles(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true, recursive: true }))
    .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
}

function captureOutput() {
  const chunks: string[] = [];
  const keep = (...args: unknown[]) => { chunks.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')); };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(keep);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { chunks.push(String(chunk)); return true; }) as never);
  return { text: () => chunks.join('\n') };
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:4317', 'X-Monarch-Desktop-Attestation': ATTESTATION }, body: JSON.stringify(body) });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no address'));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('condition not reached');
}

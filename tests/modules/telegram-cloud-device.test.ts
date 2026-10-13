import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TelegramV2Store, telegramDigest } from '../../src/modules/telegram/v2-store';
import { TelegramCloudDevice } from '../../src/modules/telegram/cloud-device';
import type { TelegramSecretTransport } from '../../src/modules/telegram/host-transport';
import { deferredTaskApprovalPayload, type DeferredPcTask } from '../../src/modules/telegram/cloud-contract';
const cleanups: (() => void)[] = []; afterEach(() => cleanups.splice(0).forEach(f => f()));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'monarch-cloud-device-')); const store = new TelegramV2Store(root, root);
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.configure({ ownerUserId: 7, controlChatId: 7, botId: 123456, pairingEpoch: 'one', historyEnabled: true });
  let task: DeferredPcTask = { version: 2, id: '42', deviceId: 'home', pairingEpoch: 'one', revision: 1, text: 'Подготовь документ',
    chatId: 7, threadId: 10, messageId: 50, createdAt: Date.now(), expiresAt: Date.now() + 7 * 86400_000, status: 'waiting-pc' };
  let starts = 0; let accepts = 0;
  const transport = { available: true, request: async (input: { kind: string; request?: { action: string } }) => {
    if (input.kind === 'cloud-status') return { enabled: true, deviceId: 'home', pairingEpoch: 'one' };
    if (input.request?.action === 'pull') return { tasks: [task], ingress: [], cloudEvents: [] };
    if (input.request?.action === 'accept') { accepts++; if (task.status === 'cancelled') throw Error('cancelled'); return { task: { ...task, status: 'accepted' } }; }
    return { ok: true };
  } } as unknown as TelegramSecretTransport;
  const client = new TelegramCloudDevice(store, transport);
  client.ports = { ingress: async () => {}, admit: async () => { starts++; return 'turn-one'; },
    inspect: async () => ({ status: 'running', summary: 'Running' }), sync: async () => [], importEvent: async () => {} };
  return { client, store, root, task, starts: () => starts, accepts: () => accepts,
    requestStop: () => { task = { ...task, status: 'running', cancelRequested: true }; },
    cancel: () => { task = { ...task, status: 'cancelled', revision: 2 }; } };
}
describe('Durable cloud PC queue', () => {
  it('scoped automatic start requires a live locally issued grant', async () => {
    const f = fixture(); expect(() => f.store.setQueueMode('scoped-auto')).toThrow();
    const project = path.join(f.root, 'project'); mkdirSync(project); f.store.grant(project, ['workspace.files.read']);
    f.store.setQueueMode('scoped-auto'); f.store.revokeGrant(); await f.client.tick(); expect(f.starts()).toBe(0);
    f.store.grant(project, ['workspace.files.read']); await f.client.tick(); expect(f.starts()).toBe(1);
  });
  it('routes a cloud Stop to the already accepted local Turn', async () => {
    const f = fixture(); await f.client.tick(); f.client.approve([{ id: f.task.id, revision: 1, digest: telegramDigest(f.task.text), proposalDigest: telegramDigest(deferredTaskApprovalPayload(f.task)) }]);
    await f.client.tick(); const cancelled: string[] = []; f.client.ports!.cancel = async id => { cancelled.push(id); };
    f.requestStop(); f.store.pause(); await f.client.tick(); expect(cancelled).toEqual(['turn-one']); expect(f.starts()).toBe(1);
  });
  it('cloud intake cannot grant PC execution, local approval starts exactly one Turn', async () => {
    const f = fixture(); await f.client.tick(); expect(f.starts()).toBe(0); expect(f.accepts()).toBe(0);
    f.client.approve([{ id: f.task.id, revision: 1, digest: telegramDigest(f.task.text), proposalDigest: telegramDigest(deferredTaskApprovalPayload(f.task)) }]);
    await f.client.tick(); await f.client.tick(); expect(f.starts()).toBe(1); expect(f.accepts()).toBe(1);
    expect(f.client.status().tasks[0]?.turnId).toBe('turn-one');
  });
  it('cancellation before the PC accepts invalidates prior local approval', async () => {
    const f = fixture(); await f.client.tick(); f.client.approve([{ id: f.task.id, revision: 1, digest: telegramDigest(f.task.text), proposalDigest: telegramDigest(deferredTaskApprovalPayload(f.task)) }]);
    f.cancel(); await f.client.tick(); expect(f.starts()).toBe(0); expect(f.accepts()).toBe(0);
  });
  it('a stale list hash cannot approve a changed proposal', async () => {
    const f = fixture(); await f.client.tick();
    expect(() => f.client.approve([{ id: f.task.id, revision: 1, digest: telegramDigest('другой текст'), proposalDigest: telegramDigest(deferredTaskApprovalPayload(f.task)) }])).toThrow();
    await f.client.tick(); expect(f.starts()).toBe(0);
  });
});

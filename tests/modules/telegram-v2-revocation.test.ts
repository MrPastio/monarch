import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TelegramModule } from '../../src/modules/telegram';
import { TelegramSecretary } from '../../src/modules/telegram/v2-secretary';
import { createTelegramOscarBridge } from '../../src/modules/telegram/v2-oscar-bridge';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.unstubAllGlobals(); });
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(r => { resolve = r; }), resolve: (v: T) => resolve(v) };
}
function fixture() {
  vi.stubGlobal('fetch', async () => { throw Error('Unexpected network in isolated regression'); });
  const root = mkdtempSync(path.join(tmpdir(), 'telegram-revocation-'));
  const module = new TelegramModule({ projectRoot: root, stateRoot: root, autoStart: false });
  cleanup.push(() => { module.v2.close(); rmSync(root, { recursive: true, force: true }); });
  module.v2.configure({ ownerUserId: 7, controlChatId: 7, botId: 123456, pairingEpoch: 'one', historyEnabled: true });
  const binding = module.v2.bind(11, 'conversation-a', 'Private title');
  const internal = module as any;
  internal.botIdentity = { id: 123456 };
  internal.state.pairings = [{ chatId: 7, userId: 7, pairedAt: 'one' }];
  internal.callApi = vi.fn(async () => ({ message_id: 90 }));
  return { module, internal, binding };
}

it('deselecting a secretary recipient while checking rights prevents the pending send', async () => {
  const f = fixture(); const entered = deferred(); const gate = deferred(); let suspend = false;
  const connection = { id: 'connection', user: { id: 7 }, is_enabled: true, rights: { can_reply: true } };
  const request = vi.fn(async (input: any) => {
    if (input.method === 'getBusinessConnection') { if (suspend) { entered.resolve(true); return gate.promise; } return connection; }
    if (input.method === 'sendMessage') return { message_id: 91 };
    throw Error('Unexpected transport operation');
  });
  const secretary = new TelegramSecretary(f.module.v2, { request } as any);
  f.internal.secretary = secretary; secretary.configure([8], true);
  await secretary.ingest({ update_id: 1, business_message: { message_id: 1, business_connection_id: 'connection',
    chat: { id: 8, type: 'private' }, from: { id: 8 }, text: 'Synthetic incoming', date: Math.floor(Date.now() / 1000) } });
  const draft = await secretary.draft('connection:8', 'Exact synthetic reply'); suspend = true;
  const result = secretary.send(draft.id).catch(error => error);
  await entered.promise; secretary.start = async () => {};
  await f.module.desktopV2Control({ action: 'secretary-configure', chats: [], enabled: true });
  gate.resolve(connection); expect(await result).toBeInstanceOf(Error);
  expect(request.mock.calls.some(([input]) => input.method === 'sendMessage')).toBe(false);
});

it.each([false, true])('privacy closes pending result delivery, success=%s', async success => {
  const f = fixture(); const entered = deferred(); const gate = deferred();
  f.internal.running = true; f.internal.taskDeliveryGeneration = 1;
  f.internal.dispatcher = { resume: async () => { entered.resolve(true); return gate.promise; }, listArtifacts: async () => [] };
  const pending = { clientRequestId: 'request-one', turnId: 'turn-one', privacyMode: 'persistent', chatId: 7, userId: 7,
    sourceMessageId: 1, progressMessageId: 90, threadId: 11, pairingEpoch: 'one' };
  const delivery = f.internal.topicContext.run({ threadId: 11 }, () => f.internal.deliverPendingTask(pending, 1, new AbortController().signal));
  await entered.promise; await f.module.desktopV2Control({ action: 'conversation', id: f.binding.id, localOnly: true });
  gate.resolve({ summary: 'Private summary', execution: { ok: success, summary: 'Private summary', ...(success ? {} : {
    error: 'confirmation-required', metadata: { approvalPresentation: { turnId: 'turn-one', taskId: 'task-one', approvalId: 'approval-one',
      capabilityId: 'workspace.files.write', canonicalProposalHash: 'hash', target: 'private/result.txt', risk: 'write', expiresAt: new Date(Date.now() + 10000).toISOString() } },
  }) } });
  expect(await delivery).toBeNull(); expect(f.internal.callApi).not.toHaveBeenCalled();
});

it('a menu waiting on history cannot disclose titles after actual local revoke', async () => {
  const f = fixture(); const entered = deferred(); const gate = deferred();
  f.module.v2Interface.bridge = createTelegramOscarBridge({ listConversations: async () => { entered.resolve(true); return gate.promise; } } as any, {} as any, f.module.v2);
  const message = { message_id: 4, message_thread_id: 11, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/chats' };
  const pending = f.internal.handleUpdate({ update_id: 4, message }).catch((e: Error) => e);
  await entered.promise; await f.module.desktopV2Control({ action: 'revoke' });
  gate.resolve({ conversations: [{ id: 'conversation-a', title: 'Private title' }] });
  expect(await pending).toBeInstanceOf(Error); expect(f.internal.callApi).not.toHaveBeenCalled();
  await f.internal.handleUpdate({ update_id: 5, message }); expect(f.internal.callApi).not.toHaveBeenCalled();
});

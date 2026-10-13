import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TelegramV2Store, authenticatedTelegramContext } from '../../src/modules/telegram/v2-store';
import { TelegramV2Interface } from '../../src/modules/telegram/v2-interface';

const roots: string[] = []; const stores: TelegramV2Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'monarch-tgv2-')); roots.push(root);
  const project = path.join(root, 'project'); mkdirSync(project);
  let now = Date.now(); const store = new TelegramV2Store(path.join(root, 'state'), root, () => now); stores.push(store);
  store.configure({ ownerUserId: 7, controlChatId: 7, botId: 123456, pairingEpoch: 'epoch1', historyEnabled: true });
  return { root, project, store, advance: (ms: number) => { now += ms; } };
}
describe('Telegram V2 authority and native conversations', () => {
  it('follows the global MAX for new requests, retains accepted roles and fails unavailable MAX without local fallback', () => {
    const { store } = fixture(); store.bind(11, 'a', 'A');
    store.configureGlobalModel(true, 'max-gpt-oss-120b'); store.selectModel(11, true);
    const first = authenticatedTelegramContext(store.context(7, 7, 11, 1, {}, 'one'))!;
    store.configureGlobalModel(true); expect(store.followsGlobalModel()).toBe(true);
    expect(() => store.context(7, 7, 11, 2, {}, 'two')).toThrow('MAX недоступен');
    expect(store.request(first.requestId)?.modelRole).toBe('max-gpt-oss-120b');
    // A replay of the accepted request preserves its model even during outage.
    expect(authenticatedTelegramContext(store.context(7, 7, 11, 1, {}, 'one'))?.requestId).toBe(first.requestId);
    store.selectModel(11, false); expect(store.modelForThread(11)).toBeUndefined();
  });
  it('captures the exact locally authorized MAX choice per request while topics stay independent', () => {
    const { store } = fixture(); store.bind(11, 'a', 'A'); store.bind(12, 'b', 'B');
    expect(() => store.configureModel('max-gpt-oss-120b', false)).toThrow();
    store.configureModel('max-gpt-oss-120b', true); store.selectModel(11, true);
    const first = authenticatedTelegramContext(store.context(7, 7, 11, 1, {}, 'one'))!;
    const second = authenticatedTelegramContext(store.context(7, 7, 12, 2, {}, 'two'))!;
    store.selectModel(11, false);
    expect(store.request(first.requestId)?.modelRole).toBe('max-gpt-oss-120b');
    expect(store.request(second.requestId)?.modelRole).toBeUndefined();
    expect(store.modelForThread(11)).toBeUndefined();
  });
  it('separates transport identity from arbitrary shared conversation IDs and denies forged contexts', () => {
    const { store } = fixture(); store.bind(11, 'desktop-chat-a', 'A'); store.bind(12, 'desktop-chat-b', 'B');
    const a = store.context(7, 7, 11, 1, {}, 'one'); const b = store.context(7, 7, 12, 2, {}, 'two');
    expect(authenticatedTelegramContext(a)?.conversationId).toBe('desktop-chat-a');
    expect(authenticatedTelegramContext(b)?.conversationId).toBe('desktop-chat-b');
    expect(authenticatedTelegramContext({ ...a })).toBeUndefined();
    expect(() => store.context(7, 8, 11, 3, {}, 'intruder')).toThrow();
    expect(() => store.context(7, 7, 12, 1, {}, 'replay')).toThrow();
  });
  it('persists one-time pairing challenges without storing the reusable secret', () => {
    const { store, advance } = fixture(); const c = store.pairingChallenge();
    expect(JSON.stringify(store.read('pair-challenge', 'current'))).not.toContain(c.token);
    store.proposePairing(c.token, { userId: 7, chatId: 7, botId: 123456 });
    expect(() => store.proposePairing(c.token, { userId: 8, chatId: 8, botId: 123456 })).toThrow();
    expect(store.read('pair-candidate', 'current')).toBeTruthy();
    const expired = store.pairingChallenge();
    expect(store.read('pair-candidate', 'current')).toBeNull();
    advance(300_001);
    expect(() => store.proposePairing(expired.token, { userId: 7, chatId: 7, botId: 123456 })).toThrow();
  });
  it('rechecks scope, expiry, revocation, no-overwrite and captured grant identity', () => {
    const { store, project, root, advance } = fixture();
    store.grant(project, ['workspace.files.read', 'workspace.files.write']);
    store.bind(1, 'a', 'A'); const c = store.context(7, 7, 1, 1, {}, 'write');
    const id = authenticatedTelegramContext(c)!.requestId;
    const permits = (p: string) => store.permits(id, 'a', 'workspace.files.write', { path: p });
    expect(permits(path.join(project, 'new.txt'))).toBe(true);
    expect(permits(path.join(root, 'outside.txt'))).toBe(false);
    writeFileSync(path.join(project, 'old.txt'), 'preserve'); expect(permits(path.join(project, 'old.txt'))).toBe(false);
    expect(store.permits(id, 'a', 'system.shell.run', { command: 'echo test' })).toBe(false);
    store.revokeGrant(); expect(permits(path.join(project, 'new.txt'))).toBe(false);
    store.grant(project, ['workspace.files.write']); expect(permits(path.join(project, 'new.txt'))).toBe(false);
    store.context(7, 7, 1, 2, {}, 'next'); advance(30 * 60_000 + 1);
    expect(store.activeGrant()).toBeNull();
  });
  it('retains binding identity over restart but rejects it after revoke', () => {
    const { store, root } = fixture(); store.bind(55, 'shared', 'Shared'); store.close();
    const next = new TelegramV2Store(path.join(root, 'state'), root); stores.push(next);
    expect(next.binding(55)?.conversationId).toBe('shared'); next.revoke();
    expect(next.settings().enabled).toBe(false); expect(next.settings().pairingEpoch).not.toBe('');
    expect(() => next.context(7, 7, 55, 2, {}, 'old')).toThrow();
  });
  it('rejects forwarded, cross-topic and revoked native buttons before an effect', async () => {
    const { store } = fixture(); const calls: { method: string; params: Record<string, any> }[] = [];
    let created = 0;
    const ui = new TelegramV2Interface(store, async <T>(method: string, params: Record<string, unknown>) => {
      calls.push({ method, params }); return { message_id: 50, message_thread_id: 100 } as T;
    });
    ui.bridge = { list: async () => [], create: async () => ({ id: `chat${++created}`, title: 'New' }),
      update: async () => {}, messages: async () => ({ messages: [] }), tasks: async () => [], cancel: async () => {} };
    const message = { message_id: 1, message_thread_id: 10, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/menu' };
    await ui.message(message);
    const data = calls.find(c => c.method === 'sendMessage')!.params.reply_markup.inline_keyboard[0][0].callback_data;
    await ui.callback({ id: 'a', from: { id: 8 }, message: { ...message, message_id: 50 }, data });
    await ui.callback({ id: 'b', from: { id: 7 }, message: { ...message, message_thread_id: 11, message_id: 50 }, data });
    expect(created).toBe(0);
    await ui.callback({ id: 'c', from: { id: 7 }, message: { ...message, message_id: 50 }, data });
    await ui.callback({ id: 'd', from: { id: 7 }, message: { ...message, message_id: 50 }, data });
    expect(created).toBe(1);
    store.revoke(); await ui.callback({ id: 'e', from: { id: 7 }, message: { ...message, message_id: 50 }, data });
    expect(created).toBe(1);
  });
});

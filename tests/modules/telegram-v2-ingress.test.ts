import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TelegramModule } from '../../src/modules/telegram';
const cleanups: (() => void)[] = []; afterEach(() => cleanups.splice(0).forEach(f => f()));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'telegram-v2-ingress-'));
  const module = new TelegramModule({ projectRoot: root, stateRoot: root, autoStart: false });
  cleanups.push(() => { module.v2.close(); rmSync(root, { recursive: true, force: true }); });
  module.v2.configure({ ownerUserId: 7, controlChatId: 7, botId: 123456, pairingEpoch: 'one', historyEnabled: true });
  module.v2.bind(11, 'chat-a', 'A'); module.v2.bind(12, 'chat-b', 'B');
  const transport = module as any; transport.botIdentity = { id: 123456 };
  transport.callApi = vi.fn(async () => ({ message_id: 90 }));
  const cancel = vi.fn(async () => {});
  module.v2Interface.bridge = { list: async () => [], create: async () => ({ id: 'new', title: 'New' }), update: async () => {},
    messages: async () => ({ messages: [] }), tasks: async () => [], cancel };
  return { module, transport, cancel };
}
it('guides an existing chat through a pending V2 link without authorizing a plain Start', async () => {
  const f = fixture();
  const link = f.module.v2.pairingChallenge();
  f.transport.handleMessage = vi.fn();
  const message = { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/start' };
  await f.transport.handleUpdate({ update_id: 1, message });
  expect(f.module.v2.read('pair-candidate', 'current')).toBeNull();
  expect(f.transport.handleMessage).not.toHaveBeenCalled();
  expect(f.transport.callApi.mock.calls.some(([, params]: any) => params.text?.includes('Обычный /start не содержит код'))).toBe(true);
  message.text = ` /start@fixture_bot  v2_${link.token}\n`;
  await f.transport.handleUpdate({ update_id: 2, message });
  expect(f.module.v2.read('pair-candidate', 'current')).toMatchObject({ userId: 7, chatId: 7, botId: 123456 });
  expect(f.module.v2.settings().pairingEpoch).toBe('one');
});
it('native Stop is bound to the exact owner topic/draft and is consumed once', async () => {
  const f = fixture();
  f.module.v2.put('draft-stop', '90', { turnId: 'turn-a', conversationId: 'chat-a', threadId: 11, epoch: 'one', expiresAt: Date.now() + 40000 });
  const update = { update_id: 1, stopped_message_generation: { chat: { id: 7, type: 'private' }, message_thread_id: 12, draft_id: 90 } };
  await f.transport.handleUpdate(update); expect(f.cancel).not.toHaveBeenCalled();
  update.stopped_message_generation.message_thread_id = 11;
  await f.transport.handleUpdate(update); await f.transport.handleUpdate(update);
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith('turn-a', 'chat-a');
});
it('native Stop and an exact task button continue to cancel while intake is paused', async () => {
  const f = fixture();
  f.module.v2Interface.bridge!.tasks = async () => [{ id: 'turn-b', conversationId: 'chat-b', status: 'running' }];
  f.module.v2.put('draft-stop', '90', { turnId: 'turn-a', conversationId: 'chat-a', threadId: 11, epoch: 'one', expiresAt: Date.now() + 40000 });
  f.module.v2.put('ui-button', 'stop-b', { action: { kind: 'cancel', id: 'turn-b' }, epoch: 'one', threadId: 12, messageId: 91, expiresAt: Date.now() + 40000 });
  f.module.v2.pause();
  await f.transport.handleUpdate({ update_id: 1, stopped_message_generation: { chat: { id: 7, type: 'private' }, message_thread_id: 11, draft_id: 90 } });
  await f.transport.handleUpdate({ update_id: 2, callback_query: { id: 'stop', from: { id: 7 }, data: 'v2:stop-b',
    message: { message_id: 91, message_thread_id: 12, chat: { id: 7, type: 'private' } } } });
  expect(f.cancel.mock.calls).toEqual([['turn-a', 'chat-a'], ['turn-b', 'chat-b']]);
  expect(f.module.v2.settings().paused).toBe(true);
});
it('stop all reports component results and closes intake without resuming permissions', async () => {
  const f = fixture();
  f.module.v2Interface.bridge!.tasks = async () => [{ id: 'turn-a', conversationId: 'chat-a', status: 'running' }];
  const result = await f.module.desktopV2Control({ action: 'stop-all' }) as { summary: string };
  expect(result.summary).toContain('остановка запрошена для 1');
  expect(result.summary).toContain('Секретарь: приостановлен');
  expect(result.summary).toContain('удалённая остановка не подтверждена');
  expect(f.module.v2.settings().paused).toBe(true); expect(f.cancel).toHaveBeenCalledExactlyOnceWith('turn-a', 'chat-a');
});
it('old and moved approval cards cannot enter the legacy action handler in V2', async () => {
  const f = fixture(); const handle = vi.spyOn(f.transport, 'handleCallback').mockResolvedValue(undefined);
  const callback = { id: 'c1', from: { id: 7 }, message: { message_id: 20, message_thread_id: 11, chat: { id: 7, type: 'private' } }, data: 'approve:proposal' };
  await f.transport.handleUpdate({ update_id: 1, callback_query: callback }); expect(handle).not.toHaveBeenCalled();
  f.module.v2.put('action-button', 'opaque', { data: 'approve:proposal', messageId: 20, threadId: 12, epoch: 'one', expiresAt: Date.now() + 10000 });
  callback.data = 'v2a:opaque'; await f.transport.handleUpdate({ update_id: 2, callback_query: callback }); expect(handle).not.toHaveBeenCalled();
  callback.message.message_thread_id = 12; await f.transport.handleUpdate({ update_id: 3, callback_query: callback });
  await f.transport.handleUpdate({ update_id: 4, callback_query: callback }); expect(handle).toHaveBeenCalledTimes(1);
});

it('an armed V2 card produces working, exact-topic, single-use follow-up buttons', async () => {
  const f = fixture();
  f.transport.state.pairings = [{ chatId: 7, userId: 7, pairedAt: 'one' }];
  f.transport.dispatcher = vi.fn(async (input: any) => input.approval.action === 'arm' ? {
    summary: 'Synthetic action', execution: { ok: false, error: 'confirmation-required', summary: 'Synthetic action',
      metadata: { approvalPresentation: { turnId: 'turn-a', taskId: 'task-a', approvalId: 'proposal',
        capabilityId: 'workspace.files.write', canonicalProposalHash: 'hash', expiresAt: new Date(Date.now() + 8000).toISOString() } } },
  } : { summary: 'Approved', execution: { ok: true, summary: 'Approved' } });
  const callback = { id: 'arm-one', from: { id: 7 }, message: { message_id: 20, message_thread_id: 11, chat: { id: 7, type: 'private' } }, data: 'v2a:initial' };
  f.module.v2.put('action-button', 'initial', { data: 'arm:proposal', messageId: 20, threadId: 11, epoch: 'one', expiresAt: Date.now() + 10000 });
  await f.transport.handleUpdate({ update_id: 1, callback_query: callback });
  const edit = f.transport.callApi.mock.calls.find(([method]: any) => method === 'editMessageText');
  const data = edit[1].reply_markup.inline_keyboard[0][0].callback_data;
  expect(data).toMatch(/^v2a:/);
  callback.data = data; await f.transport.handleUpdate({ update_id: 2, callback_query: callback });
  await f.transport.handleUpdate({ update_id: 3, callback_query: callback });
  expect(f.transport.dispatcher.mock.calls.map(([input]: any) => input.approval.action)).toEqual(['arm', 'approve']);
});

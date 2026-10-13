import path from 'node:path';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraTargetSelectionStore } from '../../src/app/astra-target-selection-store';
import { attachAstraDesktopHost } from '../../src/app/astra-desktop-host';
import type { OscarTurnCheckpoint } from '../../src/oscar-turn/types';
const cleanups: Array<() => Promise<void>> = [];
async function setup(referenceInputs = false) {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-desktop-host-')));
  await writeFile(path.join(root, '.fixture-marker'), 'astra-v3-desktop-host-only', { flag: 'wx' });
  const journal = new AstraJournal(path.join(root, 'journal.sqlite'));
  const token = 'synthetic-host-test', actor = { source: 'desktop' as const,
    id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') };
  const selections = new AstraTargetSelectionStore({ deployment: 'isolated-validation', scopeId: 'host', canonicalRoot: root, journal });
  const origin = 'http://127.0.0.1:32771', frame = { url: origin + '/' };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
  const window = { webContents: contents, isDestroyed: () => false };
  const handlers = new Map<string, (event: unknown, value?: unknown) => Promise<any>>();
  const ipcMain = { handle: (name: string, handler: any) => { if (handlers.has(name)) throw Error('duplicate-ipc'); handlers.set(name, handler); },
    removeHandler: (name: string) => handlers.delete(name) };
  const turn = { id: 'turn', clientRequestId: 'request', conversationId: 'conversation', source: 'desktop', status: 'succeeded',
    request: { astra: { actor } } };
  const getTurn = vi.fn(async () => ({ turn } as unknown as OscarTurnCheckpoint));
  const row = { client_message_id: 'message', turn_id: 'turn', role: 'assistant', content: '  Exact 🟠\n', causal_parent_id: 'user',
    attachments: ['MUST_NOT_LEAK'], provenance: { private: 'MUST_NOT_LEAK' } };
  const page = { id: 'conversation', messages: [row], message_page: { has_more: false, next_before: null as number | null } };
  const readHistory = vi.fn(async (_id: string, _options: { messageLimit: number; before?: number }): Promise<unknown> => page);
  const open = () => attachAstraDesktopHost({ deployment: 'isolated-validation', scopeId: 'desktop', canonicalRoot: root, journal,
    actor, selections, coordinator: { getTurn }, ipcMain, window, origin, desktopAttestationToken: token, conversationId: 'conversation',
    referenceInputs,
    conversations: { maxConversations: 3, readHistory }, dialog: {} } as unknown as Parameters<typeof attachAstraDesktopHost>[0]);
  let host = open();
  const invoke = (name: string, request?: unknown, event = { sender: contents, senderFrame: frame }) => handlers.get('monarch:astra-' + name)!(event, request);
  const boot = () => invoke('desktop-bootstrap');
  const command = async (kind: string, extra = {}) => invoke('conversations', { version: 1, kind, source: (await boot()).source, ...extra });
  cleanups.push(async () => { host.dispose(); journal.close(); expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root).startsWith('astra-v3-desktop-host-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-v3-desktop-host-only'); await rm(root, { recursive: true, force: false }); });
  return { root, journal, host, handlers, contents, frame, turn, row, page, readHistory, getTurn, invoke, boot, command,
    reopen: () => { host.dispose(); host = open(); return host; } };
}
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
describe('isolated native conversation IPC source ownership', () => {
  it.each([false, true])('advertises only the attached host reference capability (%s)', async enabled => {
    const s = await setup(enabled); expect((await s.boot()).referenceInputs).toBe(enabled ? true : undefined);
    await s.command('create', { requestId: 'next' }); expect((await s.boot()).referenceInputs).toBe(enabled ? true : undefined);
  });
  it('creates/selects registered sources and retains independent pending state', async () => {
    const s = await setup(), first = await s.boot();
    await s.invoke('desktop-state', { version: 1, kind: 'pending', id: 'first', source: first.source });
    const second = await s.command('create', { requestId: 'new' }); expect(second.surface.state).toBe('idle');
    await s.invoke('desktop-state', { version: 1, kind: 'pending', id: 'second', source: second.source });
    await s.command('select', { conversationId: 'conversation' }); expect((await s.boot()).surface.requestId).toBe('first');
    await s.command('select', { conversationId: second.conversationId }); expect((await s.boot()).surface.requestId).toBe('second');
  });
  it.each(['away-back', 'reload', 'restart'])('rejects old source after %s before writes or history reads', async change => {
    const s = await setup(), old = await s.boot();
    if (change === 'away-back') { await s.command('create', { requestId: 'new' }); await s.command('select', { conversationId: 'conversation' }); }
    if (change === 'reload') s.contents.emit('did-start-navigation', { isMainFrame: true });
    if (change === 'restart') s.reopen();
    const before = s.journal.capacity();
    await expect(s.invoke('desktop-state', { version: 1, kind: 'pending', id: 'stale', source: old.source })).rejects.toThrow('source-changed');
    await expect(s.invoke('conversations', { version: 1, kind: 'history', source: old.source })).rejects.toThrow('source-changed');
    await expect(s.invoke('pick-target', { version: 1, requestId: 'stale', access: 'observe', source: old.source })).rejects.toThrow('source-changed');
    expect(s.journal.capacity()).toEqual(before); expect(s.readHistory).not.toHaveBeenCalled();
  });
  it('projects bounded exact history without private fields; absence is explicit', async () => {
    const s = await setup(), page = await s.command('history', { before: 9 });
    expect(s.readHistory).toHaveBeenCalledWith('conversation', { messageLimit: 4, before: 9 });
    expect(page).toEqual({ conversationId: 'conversation', availability: 'available', messages: [
      { messageId: 'message', turnId: 'turn', role: 'assistant', content: s.row.content, causalParentId: 'user' } ], hasMore: false, before: null });
    s.readHistory.mockResolvedValue(null); expect(await s.command('history')).toMatchObject({ availability: 'not-found', messages: [] });
  });
  it.each(['owner', 'duplicate', 'cursor', 'count', 'role'])('rejects invalid history %s', async invalid => {
    const s = await setup();
    if (invalid === 'owner') s.turn.conversationId = 'other';
    if (invalid === 'duplicate') s.page.messages.push(s.row);
    if (invalid === 'cursor') { s.page.message_page.has_more = true; s.page.message_page.next_before = 0; }
    if (invalid === 'count') s.page.messages = Array.from({ length: 5 }, () => s.row);
    if (invalid === 'role') s.row.role = 'system';
    await expect(s.command('history')).rejects.toThrow('astra-desktop:history-');
  });
  it('rejects delayed history after a switch and delayed state after a page navigation', async () => {
    const s = await setup(); let release!: (value: unknown) => void;
    s.readHistory.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const source = (await s.boot()).source;
    const history = s.invoke('conversations', { version: 1, kind: 'history', source });
    await s.command('create', { requestId: 'new' }); release(s.page); await expect(history).rejects.toThrow('source-changed');
    await s.command('select', { conversationId: 'conversation' }); const current = (await s.boot()).source;
    await s.invoke('desktop-state', { version: 1, kind: 'pending', id: 'request', source: current });
    let releaseTurn!: (value: OscarTurnCheckpoint) => void;
    s.getTurn.mockImplementationOnce(() => new Promise(resolve => { releaseTurn = resolve; }));
    const link = s.invoke('desktop-state', { version: 1, kind: 'linked', id: 'turn', source: current });
    s.contents.emit('did-start-navigation', { isMainFrame: true }); const capacity = s.journal.capacity();
    releaseTurn({ turn: s.turn } as unknown as OscarTurnCheckpoint);
    await expect(link).rejects.toThrow('untrusted-frame'); expect(s.journal.capacity()).toEqual(capacity);
    expect((await s.boot()).surface.state).toBe('pending');
  });
  it('denies foreign sender and malformed commands without provider access', async () => {
    const s = await setup(), source = (await s.boot()).source;
    await expect(s.invoke('conversations', { version: 1, kind: 'history', source }, { sender: {} as any, senderFrame: s.frame })).rejects.toThrow('untrusted-frame');
    await expect(s.command('history', { before: -1 })).rejects.toThrow('history-cursor');
    await expect(s.command('history', { conversationId: 'foreign' })).rejects.toThrow('conversation-request');
    await expect(s.command('select', { conversationId: 'foreign' })).rejects.toThrow('unregistered-source');
    await expect(s.command('create', { requestId: 'new', path: 'foreign' })).rejects.toThrow('source-request');
    expect(s.readHistory).not.toHaveBeenCalled();
  });
});

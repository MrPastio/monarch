import path from 'node:path';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraDesktopStateStore } from '../../src/app/astra-desktop-state';
import { AstraDesktopConversations } from '../../src/app/astra-desktop-conversations';
import type { OscarTurnCheckpoint } from '../../src/oscar-turn/types';
const roots: string[] = [], journals: AstraJournal[] = [];
const actor = { source: 'desktop' as const, id: 'sha256:' + 'a'.repeat(64) };
async function setup(maxConversations = 3) {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-desktop-conversations-'))); roots.push(root);
  await writeFile(path.join(root, '.fixture-marker'), 'astra-v3-desktop-conversations-only', { flag: 'wx' });
  const turns = new Map<string, OscarTurnCheckpoint>();
  const options = { deployment: 'isolated-validation' as const, scopeId: 'desktop', canonicalRoot: root, initialConversationId: 'conversation',
    actor, maxConversations, getTurn: async (id: string) => turns.get(id) ?? null };
  const open = () => { const journal = new AstraJournal(path.join(root, 'journal.sqlite')); journals.push(journal);
    return { journal, directory: new AstraDesktopConversations({ ...options, journal }) }; };
  return { ...open(), open, options, root, turns };
}
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(await realpath('.test-tmp'));
    expect(path.basename(root).startsWith('astra-v3-desktop-conversations-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-v3-desktop-conversations-only');
    await rm(root, { recursive: true, force: false });
  }
});
describe('same-journal registered desktop conversation lifecycle', () => {
  it.each([8, 16])('atomically reserves and opens the full %i source cohort within journal transaction bounds', async maximum => {
    const s = await setup(maximum); await s.directory.pointer().pending('request_0');
    for (let slot = 1; slot < maximum; slot++) {
      s.directory.create('create_' + slot, s.directory.read().revision); await s.directory.pointer().pending('request_' + slot);
    }
    const before = s.journal.capacity(); s.journal.close(); const reopened = s.open();
    expect(reopened.directory.read().conversations).toHaveLength(maximum);
    expect(reopened.directory.pointer().read().requestId).toBe('request_' + (maximum - 1));
    expect(reopened.journal.capacity()).toEqual(before);
  });
  it('retains active source and independent pending pointers across reopening without copying content', async () => {
    const s = await setup(); const initial = s.directory.read();
    await s.directory.pointer().pending('first_request');
    const second = s.directory.create('create_second', initial.revision).activeConversationId;
    expect(s.directory.pointer().read().state).toBe('idle'); await s.directory.pointer().pending('second_request');
    s.journal.close(); const reopened = s.open();
    expect(reopened.directory.read().activeConversationId).toBe(second);
    expect(reopened.directory.pointer().read().requestId).toBe('second_request');
    reopened.directory.select('conversation', reopened.directory.read().revision);
    expect(reopened.directory.pointer().read().requestId).toBe('first_request');
    expect(reopened.directory.read().conversations).toHaveLength(2);
  });
  it('reuses the original single-conversation pointer and does not replenish its reservation', async () => {
    const s = await setup();
    const old = new AstraDesktopStateStore({ deployment: 'isolated-validation', scopeId: 'desktop', journal: s.journal,
      actor, conversationId: 'conversation', getTurn: s.options.getTurn });
    await old.pending('old_request'); const capacity = s.journal.capacity();
    expect(s.directory.pointer().read().requestId).toBe('old_request'); expect(s.journal.capacity()).toEqual(capacity);
    expect(new AstraDesktopConversations({ ...s.options, journal: s.journal }).read()).toEqual(s.directory.read());
    expect(s.journal.capacity()).toEqual(capacity);
  });
  it('keeps an active task alive when selecting another source and rejects a cross-source Turn link', async () => {
    const s = await setup();
    s.turns.set('first_turn', { turn: { id: 'first_turn', clientRequestId: 'first_request', conversationId: 'conversation', source: 'desktop',
      status: 'running', request: { astra: { actor } } } } as unknown as OscarTurnCheckpoint);
    await s.directory.pointer().pending('first_request'); await s.directory.pointer().linked('first_turn');
    s.directory.create('second', s.directory.read().revision); await s.directory.pointer().pending('first_request');
    await expect(s.directory.pointer().linked('first_turn')).rejects.toThrow('turn-owner');
    s.directory.select('conversation', s.directory.read().revision);
    expect(s.directory.pointer().read().turnId).toBe('first_turn');
    expect(s.turns.get('first_turn')!.turn.status).toBe('running');
  });
  it('fences an awaited old-source link even after switching away and back', async () => {
    const s = await setup(); await s.directory.pointer().pending('first_request');
    let release!: (value: OscarTurnCheckpoint) => void;
    const pointer = new AstraDesktopStateStore({ deployment: 'isolated-validation', scopeId: 'desktop', journal: s.journal,
      actor, conversationId: 'conversation', getTurn: () => new Promise(resolve => { release = resolve; }) });
    const before = s.directory.read(), assertSource = () => { if (s.directory.read().revision !== before.revision) throw Error('source-changed'); };
    const pending = pointer.linked('first_turn', assertSource);
    s.directory.create('second', before.revision); s.directory.select('conversation', s.directory.read().revision);
    const capacity = s.journal.capacity();
    release({ turn: { id: 'first_turn', clientRequestId: 'first_request', conversationId: 'conversation', source: 'desktop',
      status: 'running', request: { astra: { actor } } } } as unknown as OscarTurnCheckpoint);
    await expect(pending).rejects.toThrow('source-changed'); expect(pointer.read().state).toBe('pending');
    expect(s.journal.capacity()).toEqual(capacity);
  });
  it('does not create, select or initialize unregistered sources on stale commands', async () => {
    const s = await setup(), before = s.directory.read();
    s.directory.create('second', before.revision); const capacity = s.journal.capacity();
    expect(() => s.directory.create('third', before.revision)).toThrow('stale-source');
    expect(() => s.directory.select('conversation', before.revision)).toThrow('stale-source');
    expect(() => s.directory.select('foreign', s.directory.read().revision)).toThrow('unregistered-source');
    expect(() => s.directory.pointer('foreign')).toThrow('unregistered-source');
    expect(s.journal.capacity()).toEqual(capacity);
  });
  it('replays create without stealing later focus and bounds registration', async () => {
    const s = await setup(); s.directory.create('second', s.directory.read().revision);
    s.directory.select('conversation', s.directory.read().revision); const capacity = s.journal.capacity();
    expect(s.directory.create('second', s.directory.read().revision).activeConversationId).toBe('conversation');
    expect(s.journal.capacity()).toEqual(capacity);
    s.directory.create('third', s.directory.read().revision);
    expect(() => s.directory.create('fourth', s.directory.read().revision)).toThrow('conversation-budget');
  });
  it.each(['actor', 'root', 'initial', 'limit'])('rejects changed %s configuration without mutating the old cohort', async field => {
    const s = await setup(), capacity = s.journal.capacity();
    const options = { ...s.options, journal: s.journal };
    if (field === 'actor') options.actor = { ...actor, id: 'sha256:' + 'b'.repeat(64) };
    if (field === 'root') options.canonicalRoot += '_other';
    if (field === 'initial') options.initialConversationId = 'other';
    if (field === 'limit') options.maxConversations = 4;
    expect(() => new AstraDesktopConversations(options)).toThrow('state-or-binding');
    expect(s.journal.capacity()).toEqual(capacity);
  });
  it('retains enough reserved capacity to initialize later sources and clear pointers under pressure', async () => {
    const s = await setup(), free = s.journal.capacity().remainingBytes;
    s.journal.appendAtomic({ primary: { streamId: 'pressure', requestId: 'pressure', expectedRevision: 0, checkpoint: {}, events: [{ type: 'synthetic.pressure' }] },
      reserve: [{ id: 'pressure_budget', allocations: [{ streamId: 'pressure_future', commits: 1, checkpointBytes: 1024, eventBytes: free - 8192 }] }] });
    const next = s.directory.create('second', s.directory.read().revision); await s.directory.pointer().pending('request');
    s.directory.select('conversation', next.revision); s.directory.select(next.activeConversationId, s.directory.read().revision);
    expect(s.directory.pointer().clear('request').state).toBe('idle');
  });
});

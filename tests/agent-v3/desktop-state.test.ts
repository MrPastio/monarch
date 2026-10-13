import path from 'node:path';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraDesktopStateStore } from '../../src/app/astra-desktop-state';
import type { OscarTurnCheckpoint } from '../../src/oscar-turn/types';
const roots: string[] = [], journals: AstraJournal[] = [];
const actor = { id: 'sha256:' + 'a'.repeat(64), source: 'desktop' as const };
async function setup() {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-desktop-state-'))); roots.push(root);
  await writeFile(path.join(root, '.fixture-marker'), 'astra-v3-desktop-state-only', { flag: 'wx' });
  const turn = { id: 'turn', clientRequestId: 'request', conversationId: 'conversation', source: 'desktop', status: 'running', request: { astra: { actor } } };
  const options = { deployment: 'isolated-validation' as const, scopeId: 'desktop', actor, conversationId: 'conversation',
    getTurn: async () => ({ turn } as unknown as OscarTurnCheckpoint) };
  const open = () => { const journal = new AstraJournal(path.join(root, 'journal.sqlite')); journals.push(journal);
    return { journal, store: new AstraDesktopStateStore({ ...options, journal }) }; };
  return { ...open(), root, open, options, turn };
}
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) { expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(await realpath('.test-tmp'));
    expect(path.basename(root).startsWith('astra-v3-desktop-state-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-v3-desktop-state-only'); await rm(root, { recursive: true, force: false }); }
});
describe('host-retained opaque desktop identity', () => {
  it('persists pending before admission, reopens, links exact Turn and replays without another commit', async () => {
    const s = await setup(); await s.store.pending('request'); const capacity = s.journal.capacity();
    await s.store.pending('request'); expect(s.journal.capacity()).toEqual(capacity); s.journal.close();
    const reopened = s.open(); expect(reopened.store.read()).toEqual({ state: 'pending', requestId: 'request', turnId: null });
    expect(await reopened.store.linked('turn')).toEqual({ state: 'linked', requestId: 'request', turnId: 'turn' });
    const linkedBudget = reopened.journal.capacity(); await reopened.store.linked('turn'); expect(reopened.journal.capacity()).toEqual(linkedBudget);
    reopened.journal.close(); expect(s.open().store.read().turnId).toBe('turn');
  });
  it('does not replace pending or active Turn; new request waits for actual terminal state', async () => {
    const s = await setup(); await s.store.pending('request'); await expect(s.store.pending('another')).rejects.toThrow('pending-submission');
    await s.store.linked('turn'); await expect(s.store.pending('another')).rejects.toThrow('active-turn');
    s.turn.status = 'succeeded'; expect(await s.store.pending('another')).toEqual({ state: 'pending', requestId: 'another', turnId: null });
  });
  it.each(['actor', 'conversation', 'request', 'id'] as const)('rejects a mismatched %s link', async mismatch => {
    const s = await setup(); await s.store.pending('request');
    if (mismatch === 'actor') s.turn.request.astra = { actor: { ...actor, id: 'sha256:' + 'b'.repeat(64) } };
    else if (mismatch === 'conversation') s.turn.conversationId = 'other';
    else if (mismatch === 'id') s.turn.id = 'other'; else s.turn.clientRequestId = 'other';
    await expect(s.store.linked('turn')).rejects.toThrow(); expect(s.store.read().state).toBe('pending');
  });
  it('rejects a delayed old link after the surface moves to another pending request', async () => {
    const s = await setup(); await s.store.pending('request');
    let release!: (value: OscarTurnCheckpoint) => void;
    const delayed = new AstraDesktopStateStore({ ...s.options, journal: s.journal,
      getTurn: () => new Promise(resolve => { release = resolve; }) });
    const linked = delayed.linked('turn'); s.store.clear('request'); await s.store.pending('new');
    const capacity = s.journal.capacity(); release({ turn: s.turn } as unknown as OscarTurnCheckpoint);
    await expect(linked).rejects.toThrow('stale-transition');
    expect(s.store.read()).toEqual({ state: 'pending', requestId: 'new', turnId: null });
    expect(s.journal.capacity()).toEqual(capacity);
  });
  it('clears only exact pending pointer, not a linked task; old clear cannot remove a newer pending request', async () => {
    const s = await setup(); await s.store.pending('request'); expect(() => s.store.clear('other')).toThrow('clear-mismatch');
    expect(s.store.clear('request').state).toBe('idle'); await s.store.pending('new'); expect(() => s.store.clear('request')).toThrow('clear-mismatch');
    s.turn.clientRequestId = 'new'; await s.store.linked('turn'); expect(() => s.store.clear('new')).toThrow('clear-mismatch');
  });
  it('does not mutate old host identity when config/actor changes', async () => {
    const s = await setup(); await s.store.pending('request'); const capacity = s.journal.capacity();
    expect(() => new AstraDesktopStateStore({ ...s.options, journal: s.journal, conversationId: 'other' })).toThrow('state-or-binding');
    expect(s.journal.capacity()).toEqual(capacity);
  });
  it('retains link/clear capacity under logical pressure', async () => {
    const s = await setup(); await s.store.pending('request'); const free = s.journal.capacity().remainingBytes;
    s.journal.appendAtomic({ primary: { streamId: 'pressure', requestId: 'pressure', expectedRevision: 0, checkpoint: {}, events: [{ type: 'synthetic.pressure' }] },
      reserve: [{ id: 'pressure_budget', allocations: [{ streamId: 'pressure_future', commits: 1, checkpointBytes: 1024, eventBytes: free - 8192 }] }] });
    await s.store.linked('turn'); s.turn.status = 'succeeded'; await s.store.pending('next'); expect(s.store.clear('next').state).toBe('idle');
  });
});

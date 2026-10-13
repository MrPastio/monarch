import path from 'node:path';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraTargetSelectionStore, type AstraTargetSelectionRequest } from '../../src/app/astra-target-selection-store';
import { AstraSourceGoalCompiler } from '../../src/app/astra-source-goal-compiler';

const roots: string[] = [], journals: AstraJournal[] = [];
const actor = { id: 'sha256:' + 'a'.repeat(64), source: 'desktop' as const };
const owner = { actor, conversationId: 'conversation' };
const request = (): AstraTargetSelectionRequest => ({ ...owner, requestId: 'trusted_picker_event', ttlMs: 60000,
  targets: [{ id: 'file', relativePath: 'selected.txt', access: 'observe', maxBytes: 4096, timeoutMs: 1000 }] });
const source = { ...owner, inputMessageId: 'message', text: 'Read selected', goal: { kind: 'observe' as const, targets: ['file'] } };
async function setup(maxSelections = 32) {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-selection-'))); roots.push(root);
  await writeFile(path.join(root, '.fixture-marker'), 'astra-v3-target-selection-only', { flag: 'wx' });
  let now = Date.now(); const options = { deployment: 'isolated-validation' as const, scopeId: 'selection_test', canonicalRoot: root,
    maxSelections, now: () => now };
  const open = () => { const journal = new AstraJournal(path.join(root, 'selection.sqlite')); journals.push(journal);
    return { journal, store: new AstraTargetSelectionStore({ ...options, journal }) }; };
  return { ...open(), root, options, open, advance: (ms: number) => { now += ms; } };
}
afterEach(async () => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(await realpath('.test-tmp'));
    expect(path.basename(root).startsWith('astra-v3-selection-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-v3-target-selection-only'); await rm(root, { recursive: true, force: false });
  }
});
describe('durable bounded host target selections', () => {
  it('characterizes default lifetime exhaustion after every selection is revoked and the store restarts', async () => {
    const s = await setup();
    for (let index = 0; index < 32; index++) {
      const selected = s.store.issue({ ...request(), requestId: `lifetime_${index}` });
      s.store.revoke(selected.selectionId, owner);
    }
    expect(s.store.list(owner)).toEqual([]);
    s.journal.close();
    const reopened = s.open(), capacity = reopened.journal.capacity();
    expect(reopened.store.list(owner)).toEqual([]);
    // Characterization of an OPEN product blocker, not desired steady-state
    // availability. Reclaiming grants must also preserve old replay denial.
    expect(() => reopened.store.issue({ ...request(), requestId: 'lifetime_33' })).toThrow('cohort-capacity');
    expect(() => reopened.store.issue({ ...request(), requestId: 'lifetime_0' })).toThrow('unavailable');
    expect(reopened.journal.capacity()).toEqual(capacity);
  });
  it('issues immutable exact selection and restores same compiler binding after journal reopen', async () => {
    const s = await setup(), input = request(), selected = s.store.issue(input);
    const before = new AstraSourceGoalCompiler(s.store).read(selected.selectionId, source), capacity = s.journal.capacity();
    input.targets[0]!.relativePath = 'changed.txt'; selected.targets[0]!.relativePath = 'mutated.txt';
    expect(s.store.resolve(selected.selectionId, source).targets[0]!.relativePath).toBe('selected.txt');
    s.journal.close(); const reopened = s.open();
    expect(new AstraSourceGoalCompiler(reopened.store).read(selected.selectionId, source)).toEqual(before);
    expect(reopened.store.issue(request()).selectionId).toBe(selected.selectionId); expect(reopened.journal.capacity()).toEqual(capacity);
    expect(reopened.store.list(owner)).toEqual([{ selectionId: selected.selectionId, expiresAt: expect.any(Number),
      targets: [{ targetId: 'file', label: 'selected.txt', access: 'observe', maxBytes: 4096 }] }]);
    expect(JSON.stringify(reopened.store.list(owner))).not.toContain(s.root);
  });
  it.each(['actor', 'surface', 'conversation'] as const)('does not list, resolve or revoke another %s', async change => {
    const s = await setup(), selected = s.store.issue(request());
    const other = { actor: { ...actor }, conversationId: owner.conversationId };
    if (change === 'actor') other.actor.id = 'sha256:' + 'b'.repeat(64);
    if (change === 'surface') (other.actor as { source: string }).source = 'api';
    if (change === 'conversation') other.conversationId = 'other';
    expect(s.store.list(other)).toEqual([]);
    expect(() => s.store.resolve(selected.selectionId, { ...source, ...other })).toThrow('not-found');
    expect(() => s.store.revoke(selected.selectionId, other)).toThrow('not-found');
    expect(s.store.resolve(selected.selectionId, source)).toEqual(selected);
  });
  it('keeps a paired Telegram workspace selection isolated from desktop and other remote actors', async () => {
    const s = await setup();
    const remoteActor = { id: 'sha256:' + 'c'.repeat(64), source: 'telegram' as const };
    const remoteOwner = { actor: remoteActor, conversationId: 'telegram_remote_conversation' };
    const remoteRequest: AstraTargetSelectionRequest = { ...remoteOwner, requestId: 'trusted_remote_alias', ttlMs: 60_000,
      targets: [{ id: 'file', relativePath: 'selected.txt', access: 'observe', maxBytes: 4096, timeoutMs: 1000 }] };
    const selected = s.store.issue(remoteRequest);
    const remoteSource = { ...remoteOwner, inputMessageId: 'telegram_message', text: 'Read selected',
      goal: { kind: 'observe' as const, targets: ['file'] } };

    expect(new AstraSourceGoalCompiler(s.store).read(selected.selectionId, remoteSource).authority).toBe('observe');
    expect(s.store.list(owner)).toEqual([]);
    expect(() => s.store.resolve(selected.selectionId, { ...remoteSource, actor: { ...remoteActor, id: 'sha256:' + 'd'.repeat(64) } }))
      .toThrow('not-found');
    expect(s.store.list(remoteOwner)).toHaveLength(1);
  });
  it('does not change target or extend expiry by replaying the same issuance', async () => {
    const s = await setup(), selected = s.store.issue(request()); s.advance(30000);
    const expiry = s.store.list(owner)[0]!.expiresAt;
    expect(s.store.issue(request())).toEqual(selected); expect(s.store.list(owner)[0]!.expiresAt).toBe(expiry);
    expect(() => s.store.issue({ ...request(), ttlMs: 120000 })).toThrow('request-conflict');
    expect(() => s.store.issue({ ...request(), targets: [{ ...request().targets[0]!, relativePath: 'other.txt' }] })).toThrow('request-conflict');
    s.advance(30000); expect(s.store.list(owner)).toEqual([]);
    expect(() => s.store.resolve(selected.selectionId, source)).toThrow('unavailable');
    expect(() => s.store.issue(request())).toThrow('unavailable');
    s.store.revoke(selected.selectionId, owner); s.journal.close();
    expect(() => s.open().store.resolve(selected.selectionId, source)).toThrow('unavailable');
  });
  it('revokes with reserved capacity under pressure; replay and restart never resurrect it', async () => {
    const s = await setup(), selected = s.store.issue(request());
    const free = s.journal.capacity().remainingBytes;
    s.journal.appendAtomic({ primary: { streamId: 'pressure', requestId: 'pressure', expectedRevision: 0, checkpoint: {}, events: [{ type: 'synthetic.pressure' }] },
      reserve: [{ id: 'pressure_budget', allocations: [{ streamId: 'pressure_future', commits: 1, checkpointBytes: 1024, eventBytes: free - 8192 }] }] });
    expect(s.journal.capacity().remainingBytes).toBeLessThan(8192);
    s.store.revoke(selected.selectionId, owner); const capacity = s.journal.capacity();
    s.store.revoke(selected.selectionId, owner); expect(s.journal.capacity()).toEqual(capacity);
    expect(s.journal.read(selected.selectionId)?.revision).toBe(2);
    s.journal.close(); const reopened = s.open(); expect(reopened.store.list(owner)).toEqual([]);
    expect(() => reopened.store.issue(request())).toThrow('unavailable');
    expect(reopened.journal.read(selected.selectionId)?.checkpoint).toHaveProperty('state', 'revoked');
  });
  it('rejects unsupported targets and configuration/root changes before replacing history', async () => {
    const s = await setup();
    expect(() => s.store.issue({ ...request(), targets: [{ ...request().targets[0]!, relativePath: '../Safe' }] })).toThrow('target-contract');
    expect(s.store.list(owner)).toEqual([]);
    expect(() => new AstraTargetSelectionStore({ ...s.options, journal: s.journal, maxSelections: 16 })).toThrow('index-config-or-corruption');
    expect(() => new AstraTargetSelectionStore({ ...s.options, journal: s.journal, canonicalRoot: path.dirname(s.root) })).toThrow('index-config-or-corruption');
  });
  it('refuses finite cohort overflow without index/record/reservation debris', async () => {
    const s = await setup(1); s.store.issue(request()); const capacity = s.journal.capacity();
    expect(() => s.store.issue({ ...request(), requestId: 'another' })).toThrow('cohort-capacity');
    expect(s.journal.capacity()).toEqual(capacity); expect(s.store.list(owner)).toHaveLength(1);
  });
});

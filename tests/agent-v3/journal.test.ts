import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AstraJournal, astraJournalJson, type AstraJournalCommit, type AstraJournalReservation } from '../../src/agent-v3/journal';

let parent: string, directory: string;
const marker = 'astra-v3-journal-tests-synthetic-only';
beforeAll(async () => {
  parent = await realpath('.test-tmp');
  expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  directory = await realpath(await mkdtemp(path.join(parent, 'astra-v3-journal-')));
  expect(path.dirname(directory)).toBe(parent);
  await writeFile(path.join(directory, '.fixture-marker'), marker, { flag: 'wx' });
});
afterAll(async () => {
  if (!directory) return;
  expect(await realpath(directory)).toBe(directory);
  expect(path.dirname(directory)).toBe(parent);
  expect(path.basename(directory).startsWith('astra-v3-journal-')).toBe(true);
  expect(await readFile(path.join(directory, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(directory, { recursive: true, force: false });
});
const input = (revision = 0, requestId = `request_${revision}`): AstraJournalCommit => ({
  streamId: 'task_synthetic', requestId, expectedRevision: revision,
  events: [{ type: 'fixture-observed', logicalBytes: '4103' }], checkpoint: { phase: 'observed', logicalBytes: '4103' },
});

async function worker(mode: string, request: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/journal-worker.ts', directory, mode, request],
      { cwd: process.cwd(), windowsHide: true, env: { ...process.env, TSX_DISABLE_CACHE: '1', TEMP: directory, TMP: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { error += String(data); });
    child.once('error', failure => { clearTimeout(timer); reject(failure); });
    child.once('close', code => { clearTimeout(timer); if (timedOut) reject(new Error('owned-fixture-worker-timeout'));
      else if (code !== 0 && code !== 17) reject(new Error(`owned-fixture-${mode}/${request}: ${error}`)); else resolve({ code, output }); });
  });
}

describe('Astra V3 atomic journal (storage, not execution authority)', () => {
  it('re-admits only a bounded Windows initial WAL probe and exposes recovered errors', () => {
    const file = path.join(directory, 'initial-probe.sqlite');
    const original = DatabaseSync.prototype.prepare, connections: DatabaseSync[] = [];
    const fault = Object.assign(new Error('synthetic-initial-vfs-truncate'), { code: 'ERR_SQLITE_ERROR', errcode: 1546 });
    let calls = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
      if (sql === 'PRAGMA user_version') { connections.push(this); if (calls++ === 0) throw fault; }
      return original.call(this, sql);
    });
    try {
      if (process.platform !== 'win32') { expect(() => new AstraJournal(file)).toThrow(fault); return; }
      const journal = new AstraJournal(file);
      try {
        expect(calls).toBe(2); expect(connections[0]!.isOpen).toBe(false); expect(connections[1]!.isOpen).toBe(true);
        expect(journal.openingRecovery()).toEqual({ attempts: 2, waitedMs: 20, recoveredCodes: [1546] });
        journal.openingRecovery().recoveredCodes.push(999);
        expect(journal.openingRecovery().recoveredCodes).toEqual([1546]);
        expect(journal.read('task_synthetic')).toBeNull();
        expect(journal.append(input()).revision).toBe(1);
      } finally { journal.close(); }
    } finally { spy.mockRestore(); }
  });

  it('does not retry permanent opening faults, in-memory faults, or post-probe application writes', () => {
    const original = DatabaseSync.prototype.prepare;
    for (const code of [1546, 10, 1034, 11]) {
      let calls = 0;
      const fault = Object.assign(new Error('synthetic-permanent-open'), { code: 'ERR_SQLITE_ERROR', errcode: code });
      const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
        if (sql === 'PRAGMA user_version') { calls++; throw fault; } return original.call(this, sql);
      });
      try {
        expect(() => new AstraJournal(path.join(directory, 'permanent-' + code + '.sqlite'))).toThrow(fault);
        expect(calls).toBe(process.platform === 'win32' && code === 1546 ? 4 : 1);
        calls = 0; expect(() => new AstraJournal(':memory:')).toThrow(fault); expect(calls).toBe(1);
      } finally { spy.mockRestore(); }
    }
    const journal = new AstraJournal(path.join(directory, 'post-probe.sqlite'));
    const fault = Object.assign(new Error('synthetic-application-write'), { code: 'ERR_SQLITE_ERROR', errcode: 1546 });
    let failed = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
      if (sql.startsWith('INSERT INTO astra_streams')) { failed++; throw fault; } return original.call(this, sql);
    });
    try {
      expect(() => journal.append(input())).toThrow(fault); expect(failed).toBe(1);
      expect(journal.openingRecovery()).toEqual({ attempts: 1, waitedMs: 0, recoveredCodes: [] });
      expect(journal.read('task_synthetic')).toBeNull();
    } finally { spy.mockRestore(); journal.close(); }
  });

  it('rolls back a complete group if its read-only ownership guard expires before commit', () => {
    const journal = new AstraJournal(':memory:');
    try {
      let checks = 0;
      const operation = { primary: input(), reserve: [{ id: 'guarded', allocations: [
        { streamId: 'child', commits: 2, eventBytes: 4096, checkpointBytes: 4096 },
      ] }] };
      expect(() => journal.appendAtomic(operation, () => ++checks === 1)).toThrow('commit-fenced');
      expect(journal.read('task_synthetic')).toBeNull(); expect(journal.reservation('guarded')).toBeNull();
      expect(journal.capacity().occupiedOrReservedStreams).toBe(0);
      expect(() => journal.appendAtomic(operation, () => { throw new Error('private-guard-details'); })).toThrow('astra-journal:commit-fenced');
      journal.appendAtomic(operation, () => true);
      expect(() => journal.scoped('guarded', () => false).append({ ...input(), streamId: 'child' })).toThrow('commit-fenced');
      expect(journal.read('child')).toBeNull();
    } finally { journal.close(); }
  });

  it('reclaims completed allocation metadata instead of exhausting the 256-active-reservation limit', () => {
    const journal = new AstraJournal(':memory:');
    try {
      for (let index = 0; index < 300; index++) {
        const id = 'completed_' + index;
        journal.appendAtomic({ primary: input(index * 2), reserve: [{ id, allocations: [
          { streamId: 'never_materialized_' + index, commits: 1, eventBytes: 1024, checkpointBytes: 1024 },
        ] }] });
        journal.appendAtomic({ primary: input(index * 2 + 1), release: [id] });
        expect(journal.reservation(id)).toBeNull();
      }
      expect(journal.capacity().occupiedOrReservedStreams).toBe(1);
      expect(journal.capacity().reservedBytes).toBe(0);
      expect(journal.capacity().retainedBytes).toBeLessThan(100000);
      expect(() => journal.appendAtomic({ primary: input(600), reserve: [{ id: 'completed_299', allocations: [
        { streamId: 'never_materialized_299', commits: 1, eventBytes: 1024, checkpointBytes: 1024 },
      ] }] })).toThrow('reservation-released');
    } finally { journal.close(); }
  });
  it('atomically reserves future stream capacity across real competing processes', async () => {
    new AstraJournal(path.join(directory, 'capacity-process.sqlite')).close();
    const results = await Promise.all([worker('reservation-race', 'capacity_first'), worker('reservation-race', 'capacity_second')]);
    const replies = results.map(result => JSON.parse(result.output));
    expect(replies.filter(reply => reply.status === 'committed')).toHaveLength(1);
    expect(replies.filter(reply => reply.status === 'rejected').map(({ openingRecovery, ...reply }) => reply))
      .toEqual([{ status: 'rejected', code: 'astra-journal:stream-count-budget' }]);
    const journal = new AstraJournal(path.join(directory, 'capacity-process.sqlite'));
    try {
      expect(journal.capacity().occupiedOrReservedStreams).toBe(513);
      expect([journal.read('capacity_first'), journal.read('capacity_second')].filter(Boolean)).toHaveLength(1);
    } finally { journal.close(); }
  }, 15000);

  it('atomically joins admission, child checkpoint and capacity with sealed replay', () => {
    const journal = new AstraJournal(':memory:');
    const plan: AstraJournalReservation = { id: 'read_budget', allocations: [
      { streamId: 'child', commits: 4, eventBytes: 4096, checkpointBytes: 8192 },
    ] };
    const operation = { primary: input(), reserve: [plan], additional: [{ ...input(), streamId: 'child', reservationId: plan.id }] };
    try {
      const committed = journal.appendAtomic(operation), before = journal.capacity();
      expect(committed.receipts).toHaveLength(2);
      expect(journal.reservation(plan.id)?.remaining[0]?.commits).toBe(3);
      expect(journal.appendAtomic(operation)).toEqual(committed);
      expect(journal.capacity()).toEqual(before);
      expect(journal.reservation(plan.id)?.remaining[0]?.commits).toBe(3);
      expect(() => journal.appendAtomic({ ...operation, additional: [{ ...operation.additional[0]!, checkpoint: { forged: true } }] }))
        .toThrow('idempotency-conflict');
      expect(journal.read('child')?.revision).toBe(1);
      expect(() => journal.append(operation.primary)).toThrow('idempotency-conflict');
    } finally { journal.close(); }
  });

  it('atomically reclaims only an exact unreserved stream frontier and seals replay', () => {
    const journal = new AstraJournal(':memory:');
    try {
      const child = journal.append({ ...input(), streamId: 'retired_child' });
      const operation = { primary: input(), retire: [{ streamId: child.streamId, revision: child.revision, commitHash: child.commitHash }] };
      const committed = journal.appendAtomic(operation), capacity = journal.capacity();
      expect(journal.read('retired_child')).toBeNull(); expect(journal.history('retired_child')).toEqual([]);
      expect(capacity.occupiedOrReservedStreams).toBe(1);
      expect(journal.appendAtomic(operation)).toEqual(committed);
      expect(journal.capacity()).toEqual(capacity);
    } finally { journal.close(); }
  });

  it('rolls back the primary transition when a retirement frontier changed or remains reserved', () => {
    const changed = new AstraJournal(':memory:');
    try {
      const first = changed.append({ ...input(), streamId: 'changed_child' });
      changed.append({ ...input(1), streamId: 'changed_child' });
      expect(() => changed.appendAtomic({ primary: input(), retire: [{ streamId: first.streamId,
        revision: first.revision, commitHash: first.commitHash }] })).toThrow('retirement-frontier-changed');
      expect(changed.read('task_synthetic')).toBeNull(); expect(changed.read('changed_child')?.revision).toBe(2);
    } finally { changed.close(); }

    const reserved = new AstraJournal(':memory:');
    try {
      reserved.appendAtomic({ primary: { ...input(), streamId: 'reservation_owner' }, reserve: [{ id: 'live_child_budget', allocations: [
        { streamId: 'reserved_child', commits: 2, eventBytes: 4096, checkpointBytes: 4096 },
      ] }] });
      const child = reserved.scoped('live_child_budget').append({ ...input(), streamId: 'reserved_child' });
      expect(() => reserved.appendAtomic({ primary: input(), retire: [{ streamId: child.streamId,
        revision: child.revision, commitHash: child.commitHash }] })).toThrow('retirement-stream-reserved');
      expect(reserved.read('task_synthetic')).toBeNull(); expect(reserved.read('reserved_child')).not.toBeNull();
    } finally { reserved.close(); }
  });

  it('rolls back all admission/capacity writes when the last child event fails', () => {
    const file = path.join(directory, 'atomic-reservation-rollback.sqlite');
    const journal = new AstraJournal(file), fault = new DatabaseSync(file);
    const operation = { primary: input(), additional: [{ ...input(), streamId: 'child', reservationId: 'budget' }],
      reserve: [{ id: 'budget', allocations: [{ streamId: 'child', commits: 2, eventBytes: 2048, checkpointBytes: 2048 }] }] };
    try {
      fault.exec("CREATE TRIGGER fail_child BEFORE INSERT ON astra_commits WHEN NEW.stream_id='child' BEGIN SELECT RAISE(ABORT,'synthetic-admission-failure'); END;");
      const before = journal.capacity();
      expect(() => journal.appendAtomic(operation)).toThrow('synthetic-admission-failure');
      expect(journal.capacity()).toEqual(before);
      expect(journal.read('child')).toBeNull(); expect(journal.read('task_synthetic')).toBeNull();
      expect(journal.reservation('budget')).toBeNull();
      fault.exec('DROP TRIGGER fail_child');
      expect(journal.appendAtomic(operation).receipts).toHaveLength(2);
    } finally { fault.close(); journal.close(); }
  });

  it('protects reserved revisions from unreserved writes and debits its scoped writer exactly once', () => {
    const journal = new AstraJournal(':memory:');
    try {
      journal.appendAtomic({ primary: input(), reserve: [{ id: 'all_revisions', allocations: [
        { streamId: 'child', commits: 4096, eventBytes: 65536, checkpointBytes: 2048 },
      ] }] });
      const child = { ...input(), streamId: 'child' }, scoped = journal.scoped('all_revisions');
      expect(() => journal.append(child)).toThrow('stream-budget'); expect(journal.read('child')).toBeNull();
      const receipt = scoped.append(child);
      expect(scoped.append(child)).toEqual(receipt);
      expect(journal.reservation('all_revisions')?.remaining[0]?.commits).toBe(4095);
      expect(() => scoped.append({ ...child, reservationId: 'another' })).toThrow('reservation-scope');
      expect(() => scoped.append({ ...child, streamId: 'outside' })).toThrow('reservation-budget');
      journal.appendAtomic({ primary: input(1), release: ['all_revisions'] });
      expect(journal.reservation('all_revisions')).toBeNull();
      expect(scoped.append(child)).toEqual(receipt); // replay is not a new debit
      expect(() => scoped.append({ ...child, expectedRevision: 1, requestId: 'after_release' })).toThrow('reservation-unavailable');
      expect(journal.append({ ...child, expectedRevision: 1, requestId: 'after_release' }).revision).toBe(2);
    } finally { journal.close(); }
  });

  it('settles a reservation through its own final commit even once that reservation is spent', () => {
    // The scheduler settles a job it can no longer drive by writing its
    // terminal state through the job's own reservation and releasing that
    // same reservation in the one atomic commit (work-scheduler.ts `replace`).
    // A job reconciled many times over a long recovery already exhausts that
    // reservation before it ever reaches a terminal write — the very commit
    // meant to free the resource then needs budget from the resource it is
    // freeing, and none is left: the job can never be settled, keeps its
    // resources, and (with one model slot) freezes every later agent task for
    // the rest of the process lifetime. Live evidence: a job stuck
    // `cancelling` since 2026-09-17T18:38Z, still stuck the next morning,
    // "astra-journal:reservation-budget" on every retire attempt since.
    const journal = new AstraJournal(':memory:');
    try {
      journal.appendAtomic({ primary: input(), reserve: [{ id: 'exhaustible', allocations: [
        { streamId: 'child', commits: 1, eventBytes: 4096, checkpointBytes: 4096 },
      ] }] });
      const scoped = journal.scoped('exhaustible');
      scoped.append({ ...input(), streamId: 'child' });
      expect(journal.reservation('exhaustible')?.remaining[0]?.commits).toBe(0);
      expect(() => scoped.append({ ...input(1), streamId: 'child' })).toThrow('reservation-budget');
      journal.appendAtomic({ primary: { ...input(1), streamId: 'child', reservationId: 'exhaustible' },
        release: ['exhaustible'] });
      expect(journal.reservation('exhaustible')).toBeNull();
      expect(journal.read('child')?.revision).toBe(2);
    } finally { journal.close(); }
  });

  it('refuses over-admission without allocating the reserved payload or leaving an accepted checkpoint', () => {
    const journal = new AstraJournal(':memory:');
    try {
      journal.appendAtomic({ primary: input(), reserve: [{ id: 'first', allocations: [
        { streamId: 'child', commits: 2, eventBytes: 40 * 1024 * 1024, checkpointBytes: 2048 },
      ] }] });
      const before = journal.capacity();
      expect(before.reservedBytes).toBe(40 * 1024 * 1024 + 2048);
      expect(before.retainedBytes).toBeLessThan(1024);
      const impossible = { primary: { ...input(), streamId: 'other' }, reserve: [{ id: 'second', allocations: [
        { streamId: 'other_child', commits: 2, eventBytes: 30 * 1024 * 1024, checkpointBytes: 2048 },
      ] }] };
      expect(() => journal.appendAtomic(impossible)).toThrow('store-budget');
      expect(journal.read('other')).toBeNull(); expect(journal.reservation('second')).toBeNull();
      expect(journal.capacity()).toEqual(before);
      journal.appendAtomic({ primary: input(1), release: ['first'] });
      expect(journal.appendAtomic(impossible).receipt.revision).toBe(1);
      expect(journal.read('task_synthetic')?.revision).toBe(2); // release does not erase history
    } finally { journal.close(); }
  });

  it('charges the maximum shared checkpoint reservation once, not once per job', () => {
    const journal = new AstraJournal(':memory:');
    try {
      journal.appendAtomic({ primary: input(), reserve: ['first', 'second'].map(id => ({ id,
        allocations: [{ streamId: 'shared_scheduler', commits: 2, eventBytes: 1000, checkpointBytes: 65536 }] })) });
      expect(journal.capacity().reservedBytes).toBe(65536 + 2000);
      journal.appendAtomic({ primary: input(1), release: ['first'] });
      expect(journal.capacity().reservedBytes).toBe(65536 + 1000);
      expect(journal.reservation('first')).toBeNull();
    } finally { journal.close(); }
  });

  it('refuses checkpoint/event debit overruns without spending its last settlement credit', () => {
    const journal = new AstraJournal(':memory:');
    try {
      journal.appendAtomic({ primary: input(), reserve: [{ id: 'small', allocations: [
        { streamId: 'child', commits: 1, eventBytes: 16, checkpointBytes: 16 },
      ] }] });
      const scoped = journal.scoped('small'), child = { ...input(), streamId: 'child' };
      expect(() => scoped.append(child)).toThrow('reservation-budget');
      expect(journal.reservation('small')?.remaining[0]?.commits).toBe(1);
      expect(scoped.append({ ...child, checkpoint: null, events: ['blocked'] }).revision).toBe(1);
      expect(() => scoped.append({ ...child, expectedRevision: 1, requestId: 'extra', checkpoint: null, events: [0] })).toThrow('reservation-budget');
    } finally { journal.close(); }
  });

  it('requires explicit opt-in to upgrade only its own V1 database and preserves existing receipt identity', () => {
    const file = path.join(directory, 'owned-v1.sqlite'), original = new AstraJournal(file);
    const committed = original.append(input()); original.close();
    const old = new DatabaseSync(file);
    old.exec('DROP TABLE astra_allocations; DROP TABLE astra_reservations; DROP TABLE astra_reservation_tombstones; PRAGMA user_version=1;'); old.close();
    expect(() => new AstraJournal(file)).toThrow('explicit-schema-upgrade-required');
    const upgraded = new AstraJournal(file, { upgradeFromV1: true });
    try { expect(upgraded.append(input())).toEqual(committed); expect(upgraded.capacity().occupiedOrReservedStreams).toBe(1); }
    finally { upgraded.close(); }
  });
  it('retains a committed checkpoint and rolls back uncommitted bytes after real child-process exit', async () => {
    const committed = await worker('commit-exit', 'process_first');
    expect(committed.code).toBe(0); expect(JSON.parse(committed.output).status).toBe('committed');
    expect((await worker('uncommitted-exit', 'unused')).code).toBe(17);
    const restored = new AstraJournal(path.join(directory, 'process.sqlite'));
    try {
      expect(restored.read('process_task')).toMatchObject({ revision: 1, checkpoint: { synthetic: true, value: '4103' } });
      expect(restored.history('process_task')).toHaveLength(1);
    } finally { restored.close(); }
    // Both other processes compete for expectedRevision=1; exactly one can append.
    const competitors = await Promise.all([worker('race', 'process_second'), worker('race', 'process_third')]);
    const responses = competitors.map(result => JSON.parse(result.output));
    for (const response of responses) {
      expect(response.openingRecovery.attempts).toBeGreaterThanOrEqual(1);
      expect(response.openingRecovery.attempts).toBeLessThanOrEqual(4);
      expect(response.openingRecovery.waitedMs).toBeLessThanOrEqual(200);
      if (response.openingRecovery.attempts > 1) console.info('owned-journal-race-recovery', response.openingRecovery);
    }
    expect(responses.filter(result => result.status === 'committed')).toHaveLength(1);
    expect(responses.filter(result => result.status === 'rejected').map(({ openingRecovery, ...reply }) => reply))
      .toEqual([{ status: 'rejected', code: 'astra-journal:revision-conflict' }]);
    const afterRace = new AstraJournal(path.join(directory, 'process.sqlite'));
    try { expect(afterRace.read('process_task')!.revision).toBe(2); expect(afterRace.history('process_task')).toHaveLength(2); }
    finally { afterRace.close(); }
  }, 15000);
  it('commits events and checkpoint atomically and replays the original receipt', () => {
    const journal = new AstraJournal(':memory:');
    try {
      expect(journal.read('task_synthetic')).toBeNull();
      const first = journal.append(input());
      journal.append(input(1));
      expect(journal.append(input())).toEqual(first);
      expect(journal.read('task_synthetic')).toMatchObject({ revision: 2, checkpoint: { logicalBytes: '4103' } });
      expect(journal.history('task_synthetic').map(row => row.receipt.revision)).toEqual([1, 2]);
      expect(journal.history('task_synthetic', 1, 1).map(row => row.receipt.revision)).toEqual([2]);
      const copy = journal.read('task_synthetic')!;
      (copy.checkpoint as Record<string, string>).logicalBytes = '0';
      expect(journal.read('task_synthetic')?.checkpoint).toEqual(input().checkpoint);
    } finally { journal.close(); }
  });

  it('rejects changed bodies under the same command and stale expected revisions', () => {
    const journal = new AstraJournal(':memory:');
    try {
      const first = journal.append(input());
      expect(() => journal.append({ ...input(), checkpoint: { logicalBytes: '0' } })).toThrow('idempotency-conflict');
      expect(() => journal.append(input(0, 'different-request'))).toThrow('revision-conflict');
      expect(journal.history('task_synthetic')).toHaveLength(1);
      expect(journal.append(input())).toEqual(first);
    } finally { journal.close(); }
  });

  it('survives close/reopen and rejects a stale second connection without losing the winner', () => {
    const file = path.join(directory, 'reopen.sqlite');
    const first = new AstraJournal(file), second = new AstraJournal(file);
    let receipt;
    try {
      receipt = first.append(input());
      expect(second.read('task_synthetic')?.revision).toBe(1);
      expect(() => second.append(input(0, 'stale-connection'))).toThrow('revision-conflict');
      second.append(input(1));
    } finally { first.close(); second.close(); }
    const reopened = new AstraJournal(file);
    try {
      expect(reopened.read('task_synthetic')?.revision).toBe(2);
      expect(reopened.append(input())).toEqual(receipt);
    } finally { reopened.close(); }
  });

  it('rolls back the checkpoint update when the subsequent event insert fails', () => {
    const file = path.join(directory, 'rollback.sqlite');
    const journal = new AstraJournal(file), fault = new DatabaseSync(file);
    try {
      journal.append(input());
      const before = journal.read('task_synthetic');
      fault.exec("CREATE TRIGGER reject_event BEFORE INSERT ON astra_commits BEGIN SELECT RAISE(ABORT,'synthetic-event-failure'); END;");
      expect(() => journal.append(input(1))).toThrow('synthetic-event-failure');
      expect(journal.read('task_synthetic')).toEqual(before);
      expect(journal.history('task_synthetic')).toHaveLength(1);
      fault.exec('DROP TRIGGER reject_event');
      expect(journal.append(input(1)).revision).toBe(2);
    } finally { fault.close(); journal.close(); }
  });

  it.each(['checkpoint', 'events', 'commit-hash'])('detects %s corruption instead of returning a valid snapshot', variant => {
    const file = path.join(directory, `corrupt-${variant}.sqlite`);
    const journal = new AstraJournal(file), fault = new DatabaseSync(file);
    try {
      journal.append(input());
      if (variant === 'checkpoint') fault.prepare('UPDATE astra_streams SET checkpoint=?').run(Buffer.from('{"phase":"forged"}'));
      if (variant === 'events') fault.prepare('UPDATE astra_commits SET events=?').run(Buffer.from('[]'));
      if (variant === 'commit-hash') fault.prepare('UPDATE astra_commits SET commit_hash=?').run('sha256:' + 'f'.repeat(64));
      expect(() => journal.read('task_synthetic')).toThrow(/integrity/u);
    } finally { fault.close(); journal.close(); }
  });

  it('encrypts checkpoint and event payloads at rest and requires the exact key after restart', () => {
    const file = path.join(directory, 'encrypted.sqlite'), key = Buffer.alloc(32, 0x41);
    const secret = 'synthetic-journal-secret-never-log';
    const commit: AstraJournalCommit = { streamId: 'encrypted_task', requestId: 'encrypted_request', expectedRevision: 0,
      events: [{ type: 'private-observation', value: secret }], checkpoint: { phase: 'observed', value: secret } };
    const journal = new AstraJournal(file, { encryptionKey: key });
    const committed = journal.append(commit);
    expect(journal.read('encrypted_task')?.checkpoint).toEqual(commit.checkpoint);
    expect(journal.history('encrypted_task')[0]?.events).toEqual(commit.events);
    journal.close();

    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
      const stored = raw.prepare(`SELECT s.checkpoint,c.events FROM astra_streams s JOIN astra_commits c
        ON c.stream_id=s.stream_id AND c.revision=s.revision WHERE s.stream_id=?`).get('encrypted_task')!;
      expect(Buffer.from(stored.checkpoint as Uint8Array).includes(Buffer.from(secret))).toBe(false);
      expect(Buffer.from(stored.events as Uint8Array).includes(Buffer.from(secret))).toBe(false);
    } finally { raw.close(); }

    expect(() => new AstraJournal(file)).toThrow('encryption-key-required');
    expect(() => new AstraJournal(file, { encryptionKey: Buffer.alloc(32, 0x42) })).toThrow('encryption-key-mismatch');
    const reopened = new AstraJournal(file, { encryptionKey: key });
    try {
      expect(reopened.read('encrypted_task')?.checkpoint).toEqual(commit.checkpoint);
      expect(reopened.append(commit)).toEqual(committed);
    } finally { reopened.close(); key.fill(0); }
  });

  it('atomically migrates an owned plaintext v2 journal without changing logical receipts', () => {
    const file = path.join(directory, 'encrypted-upgrade.sqlite'), key = Buffer.alloc(32, 0x55);
    const secret = 'synthetic-legacy-private-payload';
    const legacy = new AstraJournal(file);
    const first = legacy.append({ streamId: 'legacy_task', requestId: 'legacy_1', expectedRevision: 0,
      events: [{ value: secret }], checkpoint: { revision: 1, value: secret } });
    legacy.close();
    expect(() => new AstraJournal(file, { encryptionKey: key })).toThrow('explicit-schema-upgrade-required');
    const upgraded = new AstraJournal(file, { encryptionKey: key, upgradeFromV2: true });
    try {
      expect(upgraded.read('legacy_task')?.checkpoint).toEqual({ revision: 1, value: secret });
      expect(upgraded.history('legacy_task')[0]?.receipt).toEqual(first);
      expect(upgraded.append({ streamId: 'legacy_task', requestId: 'legacy_1', expectedRevision: 0,
        events: [{ value: secret }], checkpoint: { revision: 1, value: secret } })).toEqual(first);
    } finally { upgraded.close(); }
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const stored = raw.prepare('SELECT checkpoint FROM astra_streams WHERE stream_id=?').get('legacy_task')!;
      expect(Buffer.from(stored.checkpoint as Uint8Array).includes(Buffer.from(secret))).toBe(false);
      expect(raw.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    } finally { raw.close(); key.fill(0); }
  });

  it('rejects authenticated payload tampering before JSON interpretation', () => {
    const file = path.join(directory, 'encrypted-corrupt.sqlite'), key = Buffer.alloc(32, 0x77);
    const journal = new AstraJournal(file, { encryptionKey: key });
    journal.append({ ...input(), streamId: 'encrypted_corrupt' });
    const fault = new DatabaseSync(file);
    try {
      const row = fault.prepare('SELECT events FROM astra_commits WHERE stream_id=?').get('encrypted_corrupt')!;
      const forged = Buffer.from(row.events as Uint8Array); forged[forged.length - 1] ^= 0xff;
      fault.prepare('UPDATE astra_commits SET events=? WHERE stream_id=?').run(forged, 'encrypted_corrupt');
      expect(() => journal.read('encrypted_corrupt')).toThrow('encrypted-payload-integrity');
    } finally { fault.close(); journal.close(); key.fill(0); }
  });

  it('refuses an unrelated SQLite database without modifying its data', () => {
    const file = path.join(directory, 'unrelated.sqlite'), db = new DatabaseSync(file);
    db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep');");
    try {
      expect(() => new AstraJournal(file)).toThrow('unsupported-database');
      expect(db.prepare('SELECT value FROM unrelated').get()?.value).toBe('keep');
      expect(db.prepare('PRAGMA application_id').get()?.application_id).toBe(0);
    } finally { db.close(); }
  });

  it('bounds event payloads and rejects invalid values before any write', () => {
    const journal = new AstraJournal(':memory:');
    try {
      expect(() => journal.append({ ...input(), events: [] })).toThrow('event-count');
      expect(() => journal.append({ ...input(), events: ['x'.repeat(262144)] })).toThrow('event-size');
      expect(() => journal.append({ ...input(), checkpoint: Number.MAX_SAFE_INTEGER + 1 })).toThrow('unsafe-number');
      expect(journal.read('task_synthetic')).toBeNull();
      expect(() => journal.history('task_synthetic', 0, 129)).toThrow('history-limit');
      expect(astraJournalJson({ zero: 0, value: '9007199254740993' })).toContain('9007199254740993');
    } finally { journal.close(); }
    expect(() => journal.read('task_synthetic')).toThrow('closed');
  });
});

describe('Astra V3 journal history compaction', () => {
  it('keeps a compacted stream writable past the commit limit and anchors history at the oldest kept commit', () => {
    const journal = new AstraJournal(':memory:');
    try {
      let revision = 0;
      for (; revision < 4200; revision++) {
        journal.appendAtomic({ primary: input(revision), ...((revision + 1) % 512 === 0 ? { compactHistory: { keepLatest: 256 } } : {}) });
      }
      expect(journal.read('task_synthetic')!.revision).toBe(4200);
      const first = journal.history('task_synthetic', 0, 128);
      expect(first[0]!.receipt.revision).toBe(4096 - 256 + 1);
      expect(journal.history('task_synthetic', 10, 1)[0]!.receipt.revision).toBe(first[0]!.receipt.revision);
      expect(() => journal.appendAtomic({ primary: input(4200), compactHistory: { keepLatest: 8 } })).toThrow('compact-history');
    } finally { journal.close(); }
  }, 60_000);
  it('still refuses an uncompacted stream at the commit limit', () => {
    const journal = new AstraJournal(':memory:');
    try {
      for (let revision = 0; revision < 4096; revision++) journal.append(input(revision));
      expect(() => journal.append(input(4096))).toThrow('stream-budget');
    } finally { journal.close(); }
  }, 60_000);
});

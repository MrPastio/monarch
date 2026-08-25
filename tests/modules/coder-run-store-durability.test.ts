import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDurableJson } from '../../src/core/durable-json';
import { CoderRunStore } from '../../src/modules/coder/context-manager';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Coder run journal durability', () => {
  it.each([
    ['malformed JSON', '{ broken run', /invalid JSON/],
    ['schema-invalid JSON', '{"unexpected":true}\n', /invalid schema/],
  ])('fails closed on %s without replacing its bytes', async (_label, content, expectedError) => {
    const root = await temporaryRoot('monarch-coder-run-invalid-');
    const journalPath = path.join(root, 'runtime', 'coder', 'runs', 'broken.json');
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, content, 'utf8');

    expect(() => new CoderRunStore({ monarchRoot: root })).toThrowError(expectedError);
    await expect(readFile(journalPath, 'utf8')).resolves.toBe(content);
  });

  it('rejects a journal whose embedded run id does not match its filename', async () => {
    const root = await temporaryRoot('monarch-coder-run-id-mismatch-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Preserve journal path integrity.');
    const originalPath = path.join(store.runsRoot, `${created.id}.json`);
    const mismatchedPath = path.join(store.runsRoot, 'different-name.json');
    const bytes = await readFile(originalPath, 'utf8');
    await rm(originalPath);
    await writeFile(mismatchedPath, bytes, 'utf8');

    expect(() => new CoderRunStore({ monarchRoot: root })).toThrowError(/does not match its run id/);
    await expect(readFile(mismatchedPath, 'utf8')).resolves.toBe(bytes);
  });

  it('rolls back a new run when the journal root is occupied by a file', async () => {
    const root = await temporaryRoot('monarch-coder-run-create-');
    const store = new CoderRunStore({ monarchRoot: root });
    await mkdir(path.dirname(store.runsRoot), { recursive: true });
    await writeFile(store.runsRoot, 'occupied by an unexpected file', 'utf8');

    expect(() => store.create('project-1', 'This run must not leak into memory.')).toThrowError(/Unable to write durable JSON/);
    expect(store.list()).toEqual([]);
    await expect(readFile(store.runsRoot, 'utf8')).resolves.toBe('occupied by an unexpected file');
  });

  it('rolls back every in-memory transition when its single durable commit fails', async () => {
    const root = await temporaryRoot('monarch-coder-run-mutations-');
    let writes = 0;
    let failWrites = false;
    const store = new CoderRunStore({
      monarchRoot: root,
      writeRun: (filePath, run) => {
        writes += 1;
        if (failWrites) throw new Error('injected journal commit failure');
        writeDurableJson(filePath, run);
      },
    });
    const created = store.create('project-1', 'Exercise every durable transition.');
    const before = store.require(created.id);
    const journalPath = path.join(store.runsRoot, `${created.id}.json`);
    const bytesBefore = await readFile(journalPath, 'utf8');
    failWrites = true;

    const mutations: Array<() => unknown> = [
      () => store.setStatus(created.id, 'running', 'Should roll back.'),
      () => store.setIteration(created.id, 17),
      () => store.setPersonalitySnapshot(created.id, null),
      () => store.recordModelUsage(created.id, { prompt_tokens: 42, completion_tokens: 7 }),
      () => store.recordDecision(created.id, 'A decision that must not leak.'),
      () => store.setPending(created.id, ['A pending item that must not leak.']),
      () => store.addEvent(created.id, 'tool-result', 'Failed durable event', 'Must roll back.', { ok: false }),
      () => store.requestCancel(created.id),
      () => store.fail(created.id, 'A terminal failure that must remain invisible.'),
      () => store.complete(created.id, 'A terminal answer that must remain invisible.'),
      () => store.projection(created.id),
    ];

    for (const mutate of mutations) {
      expect(mutate).toThrowError('injected journal commit failure');
      expect(store.require(created.id)).toEqual(before);
    }
    expect(writes).toBe(1 + mutations.length);
    await expect(readFile(journalPath, 'utf8')).resolves.toBe(bytesBefore);

    failWrites = false;
    const writesBeforeCompletion = writes;
    const completed = store.complete(created.id, 'Persisted final answer.');
    expect(writes - writesBeforeCompletion).toBe(1);
    expect(completed.status).toBe('completed');
    expect(completed.events.slice(-2).map((event) => [event.kind, event.title])).toEqual([
      ['assistant', 'Coder completed'],
      ['status', 'Task completed'],
    ]);

    const reloaded = new CoderRunStore({ monarchRoot: root });
    expect(reloaded.require(created.id)).toEqual(completed);
  });

  it('never exposes mutable references to the stored run', async () => {
    const root = await temporaryRoot('monarch-coder-run-clone-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Keep the internal journal isolated.');
    store.setStatus(created.id, 'completed', 'Done.');
    const before = store.require(created.id);

    const snapshots = [store.require(created.id), store.get(created.id)!, store.list()[0]!];
    for (const snapshot of snapshots) {
      snapshot.status = 'failed';
      snapshot.events[0]!.detail = 'externally mutated';
      snapshot.summary.pending.push('externally mutated');
      snapshot.context.totalEvents = 99_999;
    }

    expect(store.require(created.id)).toEqual(before);
    expect(new CoderRunStore({ monarchRoot: root }).require(created.id)).toEqual(before);
  });

  it('preserves a running journal byte-for-byte if restart recovery cannot commit', async () => {
    const root = await temporaryRoot('monarch-coder-run-recovery-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Recover me only after a durable write.');
    store.setStatus(created.id, 'running', 'Work is active.');
    const journalPath = path.join(store.runsRoot, `${created.id}.json`);
    const bytesBefore = await readFile(journalPath, 'utf8');

    expect(() => new CoderRunStore({
      monarchRoot: root,
      writeRun: () => { throw new Error('injected recovery commit failure'); },
    })).toThrowError('injected recovery commit failure');
    await expect(readFile(journalPath, 'utf8')).resolves.toBe(bytesBefore);

    const recovered = new CoderRunStore({ monarchRoot: root }).require(created.id);
    expect(recovered.status).toBe('interrupted');
    expect(recovered.events.at(-1)).toMatchObject({ title: 'Task interrupted', kind: 'status' });
    expect(recovered.context.totalEvents).toBe(recovered.events.length);
  });
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

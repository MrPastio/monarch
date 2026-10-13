import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDurableJson } from '../../src/core/durable-json';
import { CoderRunStore } from '../../src/modules/coder/context-manager';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Coder run journal durability', () => {
  it('projects generic MAX tasks, actual command checks and three-digit activity rounds across restart', async () => {
    const root = await temporaryRoot('monarch-coder-v3-projection-');
    const store = new CoderRunStore({ monarchRoot: root });
    const role = 'max-cloud:openrouter:Owner/Any-New-Model:free' as const;
    const created = store.create('project-1', 'Verify the project.', role, undefined, 'stable_request');
    const projection = { taskId: 'task_generic_max', status: 'completed' as const, modelTurns: 102, capabilityCalls: 2,
      runtimeStatus: 'completed', completionEvidence: 'succeeded' as const, answer: 'Verified.', activities: [
        { round: 100, capabilityId: 'coder.command.run', reason: 'Run project tests.', thought: 'Use the project test command.',
          state: 'observed' as const, ok: true, summary: 'Command exited with code 0.',
          output: { executable: 'npm', args: ['test'], exitCode: 0 } },
        { round: 101, capabilityId: 'coder.files.write', reason: 'Save result.', state: 'observed' as const,
          ok: true, summary: 'Wrote result.', output: { path: 'result.txt', verified: true } },
      ] };
    const projected = store.projectAstraTask(created.id, projection);
    expect(projected).toMatchObject({ model: role, clientRequestId: 'stable_request', summary: {
      modifiedFiles: ['result.txt'], tests: ['PASS: npm test'] }, completionEvidence: 'succeeded' });
    expect(projected.events.filter(event => event.title === 'План следующего шага')).toHaveLength(1);
    store.projectAstraTask(created.id, projection);
    expect(store.require(created.id).events).toHaveLength(projected.events.length);
    expect(new CoderRunStore({ monarchRoot: root }).require(created.id)).toMatchObject({ status: 'completed', model: role, astraActivityRound: 101 });
  });
  it('leaves a finished run untouched when a later projection changes nothing', async () => {
    // Startup re-projects every bound run. Stamping each one with a new
    // updatedAt rewrote every file and moved old conversations to the top.
    const root = await temporaryRoot('monarch-coder-v3-noop-projection-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Say hello.');
    const projection = { taskId: 'task_noop', status: 'completed' as const, modelTurns: 1, capabilityCalls: 0,
      runtimeStatus: 'completed', completionEvidence: 'succeeded' as const, answer: 'Hello.', activities: [] };
    const first = store.projectAstraTask(created.id, projection);
    const filePath = path.join(store.runsRoot, `${created.id}.json`);
    const bytes = await readFile(filePath, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 5));
    const again = store.projectAstraTask(created.id, projection);
    expect(again.updatedAt).toBe(first.updatedAt);
    expect(store.require(created.id).updatedAt).toBe(first.updatedAt);
    await expect(readFile(filePath, 'utf8')).resolves.toBe(bytes);
  });
  it.each([
    ['malformed JSON', '{ broken run', 'invalid-json'],
    ['schema-invalid JSON', '{"unexpected":true}\n', 'invalid-schema'],
  ])('sets aside %s byte for byte and keeps every other run', async (_label, content, reason) => {
    // One damaged journal used to stop the whole Coder module from loading.
    const root = await temporaryRoot('monarch-coder-run-invalid-');
    const healthy = new CoderRunStore({ monarchRoot: root }).create('project-1', 'A healthy run.');
    const journalPath = path.join(root, 'runtime', 'coder', 'runs', 'broken.json');
    await writeFile(journalPath, content, 'utf8');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = new CoderRunStore({ monarchRoot: root });
      expect(store.list().map(run => run.id)).toEqual([healthy.id]);
      await expect(readFile(journalPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const quarantine = path.join(store.runsRoot, 'quarantine');
      const [moved] = await readdir(quarantine);
      expect(moved).toMatch(new RegExp(`^broken\\.json\\..+\\.${reason}$`));
      await expect(readFile(path.join(quarantine, moved!), 'utf8')).resolves.toBe(content);
      expect(String(errors.mock.calls[0]?.[0])).toContain(`"reason":"${reason}"`);
    } finally { errors.mockRestore(); }
  });

  it('sets aside a journal whose embedded run id does not match its filename', async () => {
    const root = await temporaryRoot('monarch-coder-run-id-mismatch-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Preserve journal path integrity.');
    const originalPath = path.join(store.runsRoot, `${created.id}.json`);
    const mismatchedPath = path.join(store.runsRoot, 'different-name.json');
    const bytes = await readFile(originalPath, 'utf8');
    await rm(originalPath);
    await writeFile(mismatchedPath, bytes, 'utf8');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(new CoderRunStore({ monarchRoot: root }).list()).toEqual([]);
      const [moved] = await readdir(path.join(store.runsRoot, 'quarantine'));
      expect(moved).toMatch(/^different-name\.json\..+\.id-mismatch$/u);
      await expect(readFile(path.join(store.runsRoot, 'quarantine', moved!), 'utf8')).resolves.toBe(bytes);
    } finally { errors.mockRestore(); }
  });

  it('moves finished runs beyond the live window to archive/, keeping them and loading only the window', async () => {
    const root = await temporaryRoot('monarch-coder-run-archive-');
    const store = new CoderRunStore({ monarchRoot: root });
    // Distinct, increasing times: equal timestamps would make the order of
    // the oldest runs arbitrary.
    let clock = Date.parse('2026-10-01T00:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let index = 0; index < 123; index++) {
        vi.setSystemTime(clock += 1000);
        const run = store.create('project-1', `Run ${index}`);
        vi.setSystemTime(clock += 1000);
        store.complete(run.id, 'Done.');
      }
      vi.setSystemTime(clock += 1000);
    } finally { vi.useRealTimers(); }
    const unfinished = store.create('project-1', 'Still running.');
    expect(store.list(undefined, 500)).toHaveLength(120);
    const archived = await readdir(path.join(store.runsRoot, 'archive'));
    expect(archived).toHaveLength(4);
    const live = (await readdir(store.runsRoot)).filter(name => name.endsWith('.json'));
    expect(live).toHaveLength(120);
    expect(live).toContain(`${unfinished.id}.json`);
    expect(new CoderRunStore({ monarchRoot: root }).list(undefined, 500)).toHaveLength(120);
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
    ];
    // Building the prompt view of an unchanged run is a read, not a commit.
    const writesBeforeRead = writes;
    expect(store.projection(created.id).summary.goal).toBe('Exercise every durable transition.');
    expect(writes).toBe(writesBeforeRead);

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

  it('projects V3 model and capability progress exactly once across repeated snapshots', async () => {
    const root = await temporaryRoot('monarch-coder-v3-projection-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Create and verify src/ready.ts.');
    const proposed = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_1',
      status: 'running',
      modelTurns: 1,
      capabilityCalls: 1,
      activities: [{ round: 0, capabilityId: 'coder.files.write', reason: 'Create the requested file.', state: 'proposed' }],
    });
    const proposedEventCount = proposed.events.length;
    expect(proposed).toMatchObject({ agentTaskId: 'astra_agent_task_1', agentRuntimeVersion: 'v3',
      astraActivityStates: { 0: 'proposed' }, status: 'running' });
    expect(proposed.events.filter((event) => event.kind === 'tool-start')).toHaveLength(1);

    const replayed = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_1', status: 'running', modelTurns: 1, capabilityCalls: 1,
      activities: [{ round: 0, capabilityId: 'coder.files.write', reason: 'Create the requested file.', state: 'proposed' }],
    });
    expect(replayed.events).toHaveLength(proposedEventCount);

    const observed = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_1', status: 'running', modelTurns: 2, capabilityCalls: 1,
      activities: [{ round: 0, capabilityId: 'coder.files.write', reason: 'Create the requested file.',
        state: 'observed', summary: 'File written.', ok: true, output: { path: 'src/ready.ts', verified: true } }],
    });
    expect(observed.events.filter((event) => event.kind === 'tool-start')).toHaveLength(1);
    expect(observed.events.filter((event) => event.kind === 'tool-result')).toHaveLength(1);
    expect(observed.summary.modifiedFiles).toContain('src/ready.ts');

    const completed = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_1', status: 'completed', modelTurns: 2, capabilityCalls: 1,
      answer: 'Файл создан и подтверждён Kernel receipt.',
      activities: [{ round: 0, capabilityId: 'coder.files.write', reason: 'Create the requested file.',
        state: 'observed', summary: 'File written.', ok: true, output: { path: 'src/ready.ts', verified: true } }],
    });
    const completedEventCount = completed.events.length;
    expect(completed).toMatchObject({ status: 'completed', answer: 'Файл создан и подтверждён Kernel receipt.' });
    expect(completed.events.filter((event) => event.kind === 'assistant')).toHaveLength(1);
    expect(completed.events.filter((event) => event.title === 'Task completed')).toHaveLength(1);

    const terminalReplay = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_1', status: 'completed', modelTurns: 2, capabilityCalls: 1,
      answer: 'Файл создан и подтверждён Kernel receipt.',
      activities: [{ round: 0, capabilityId: 'coder.files.write', reason: 'Create the requested file.',
        state: 'observed', summary: 'File written.', ok: true, output: { path: 'src/ready.ts', verified: true } }],
    });
    expect(terminalReplay.events).toHaveLength(completedEventCount);
    expect(new CoderRunStore({ monarchRoot: root }).require(created.id)).toEqual(terminalReplay);
  });

  it('keeps an active V3-bound run eligible for automatic Turn recovery after restart', async () => {
    const root = await temporaryRoot('monarch-coder-v3-auto-recovery-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Continue this durable Agent-First task automatically.');
    store.bindAgentTurn(created.id, 'oscar_turn_durable_recovery');
    const running = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_durable_recovery', status: 'running', modelTurns: 2,
      capabilityCalls: 1, activities: [{ round: 0, capabilityId: 'coder.files.read',
        reason: 'Inspect the exact project file.', state: 'observed', summary: 'File read.', ok: true }],
    });

    const recovered = new CoderRunStore({ monarchRoot: root }).require(created.id);
    expect(recovered).toMatchObject({ status: 'running', oscarTurnId: 'oscar_turn_durable_recovery',
      agentTaskId: 'astra_agent_task_durable_recovery', agentRuntimeVersion: 'v3', finishedAt: null, error: '' });
    expect(recovered.events).toHaveLength(running.events.length + 1);
    expect(recovered.events.at(-1)).toMatchObject({ kind: 'status', title: 'Task recovery pending' });
    expect(recovered.events.at(-1)?.detail).toContain('continue automatically');
    expect(recovered.events.some((event) => event.title === 'Task interrupted')).toBe(false);
  });

  it('migrates version-local run journals once into the durable state root without replaying deleted history', async () => {
    const root = await temporaryRoot('monarch-coder-run-state-migration-');
    const legacyRoot = path.join(root, 'version');
    const durableRunsRoot = path.join(root, 'data', 'runtime', 'coder', 'runs');
    const legacyStore = new CoderRunStore({ monarchRoot: legacyRoot });
    const created = legacyStore.create('project-1', 'preserve this completed run', 'qwen3-coder-30b-a3b-instruct');
    legacyStore.setStatus(created.id, 'completed', 'legacy completion');

    const migrated = new CoderRunStore({
      monarchRoot: legacyRoot,
      runsRoot: durableRunsRoot,
      legacyRunsRoot: legacyStore.runsRoot,
    });
    expect(migrated.require(created.id).status).toBe('completed');
    await expect(readFile(path.join(durableRunsRoot, `${created.id}.json`), 'utf8')).resolves.toContain(created.id);

    migrated.delete(created.id);
    expect(new CoderRunStore({
      monarchRoot: legacyRoot,
      runsRoot: durableRunsRoot,
      legacyRunsRoot: legacyStore.runsRoot,
    }).get(created.id)).toBeNull();
  });

  it('persists the exact V3 question binding and clears it on the next authoritative projection', async () => {
    const root = await temporaryRoot('monarch-coder-v3-question-');
    const store = new CoderRunStore({ monarchRoot: root });
    const created = store.create('project-1', 'Ask only when a real decision is missing.');
    const question = {
      id: 'agent_question_1234567890abcdef',
      digest: `sha256:${'a'.repeat(64)}`,
      text: 'Какой формат файла использовать?',
      predecessorMessageId: 'coder_message_1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const waiting = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_question', status: 'running', modelTurns: 1, capabilityCalls: 0,
      question, activities: [],
    });
    expect(waiting.agentQuestion).toEqual(question);
    expect(new CoderRunStore({ monarchRoot: root }).require(created.id).agentQuestion).toEqual(question);

    const resumed = store.projectAstraTask(created.id, {
      taskId: 'astra_agent_task_question', status: 'running', modelTurns: 2, capabilityCalls: 0, activities: [],
    });
    expect(resumed.agentQuestion).toBeUndefined();
    expect(new CoderRunStore({ monarchRoot: root }).require(created.id).agentQuestion).toBeUndefined();
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

describe('Coder run live notifications', () => {
  it('tells subscribers about every durable change and never lets a viewer break the journal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-coder-stream-'));
    roots.push(root);
    const store = new CoderRunStore({ monarchRoot: root });
    const seen: string[] = [];
    store.subscribe(() => { throw new Error('viewer failed'); });
    const stop = store.subscribe(run => seen.push(run.status));
    const created = store.create('project-1', 'Stream me.');
    store.setStatus(created.id, 'running');
    stop();
    store.setStatus(created.id, 'completed');
    expect(seen).toEqual(['queued', 'running']);
    expect(store.get(created.id)?.status).toBe('completed');
    expect(created.sessionId).toMatch(/^coder_session_/u);
  });
});

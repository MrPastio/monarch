import path from 'node:path';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { oscarBridgeHost, oscarBridgeMarker, oscarBridgeRequest as request } from '../fixtures/agent-v3/oscar-bridge-host';
import { OscarTurnCoordinator } from '../../src/oscar-turn/coordinator';
import { AstraJournal } from '../../src/agent-v3/journal';
import type { OscarAstraInput } from '../../src/oscar-turn/astra-contract';
import { AstraMemoryRecallAdmission } from '../../src/agent-v3/memory-recall-admission';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); const parent = await realpath('.test-tmp');
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
    expect(path.basename(root).startsWith('astra-v3-oscar-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(oscarBridgeMarker);
    await rm(root, { recursive: true, force: false });
  }
});
async function setup(start = true, input: Parameters<typeof oscarBridgeHost>[1] = {}) {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-'))); roots.push(root);
  await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
  await writeFile(path.join(root, 'selected.txt'), 'Синтетический текст 🟠', { flag: 'wx' });
  const s = await oscarBridgeHost(root, input); if (start) await s.start(); return s;
}

describe('real Oscar coordinator -> isolated Astra source bridge', () => {
  it.each([
    [`Создай файл "x.txt" с текстом: "${'a'.repeat(4070)}"`, 'astra-oscar-unsupported-source'],
    ['Прочитай missing.txt', 'ENOENT'],
    ['Прочитай "../selected.txt"', 'path-alias'],
    ['Создай файл "selected.txt" с текстом: "overwrite denied"', 'target-not-readable-or-exists'],
  ])('does not let exact-looking prose claim an executor or durable selection (%s)', async (text) => {
    const s = await setup(true, { durableSelections: true });
    try {
      // What this request could have taken: streams and reservations. Retained
      // bytes are left out: an idle owner lets its 1 s lease lapse and the next
      // drain re-acquires it with one scheduler commit, which a loaded machine
      // reaches between the two reads.
      const allocated = () => { const { occupiedOrReservedStreams, reservedBytes, remainingStreamSlots } = s.journal.capacity();
        return { occupiedOrReservedStreams, reservedBytes, remainingStreamSlots }; };
      const capacity = allocated();
      const admitted = await s.coordinator.submit({ clientRequestId: 'oversized_source', inputMessageId: 'oversized_message',
        conversationId: 'conversation', source: 'desktop', privacyMode: 'persistent',
        text });
      await s.flush();
      const current = (await s.coordinator.getTurn(admitted.turn.id))!;
      expect(current.turn.request.astra).toBeUndefined();
      expect(current.turn.status).toBe('waiting-for-user');
      expect(allocated()).toEqual(capacity);
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
    } finally { await s.close(); }
  });
  it.each(['read', 'create'] as const)('keeps retired phrase-only %s waiting after restart without effects', async kind => {
    const options = { durableSelections: true };
    const s = await setup(true, options); let closed = false;
    try {
      const input = { clientRequestId: 'ordinary_restart', inputMessageId: 'ordinary_restart_message',
        conversationId: 'conversation', source: 'desktop' as const, privacyMode: 'persistent' as const,
        text: kind === 'read' ? 'Прочитай файл "selected.txt"' : 'Создай файл "Новый отчёт.txt" с текстом: "  retained 🟠  "' };
      const initial = await s.coordinator.submit(input); await s.flush();
      const completed = (await s.coordinator.getTurn(initial.turn.id))!;
      expect(completed.turn.status).toBe('waiting-for-user');
      expect(completed.turn.request.astra).toBeUndefined();
      await s.close(); closed = true;
      const reopened = await oscarBridgeHost(s.root, options);
      const dispatch = vi.spyOn(reopened.kernel, 'executeActionProposal');
      try {
        await reopened.start(); await reopened.flush();
        const replay = await reopened.coordinator.submit(input); await reopened.flush();
        expect(replay.turn.id).toBe(initial.turn.id);
        expect(replay.turn.outcome).toEqual(completed.turn.outcome);
        expect(dispatch).not.toHaveBeenCalled();
        expect(reopened.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
        await expect(reopened.coordinator.submit({ ...input, text: input.text + ' изменено' })).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
        await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await reopened.close(); }
    } finally { if (!closed) await s.close(); }
  });
  it.each(['Создай файл "Новый отчёт.txt" с текстом: "Не записывать"', 'Прочитай файл "selected.txt"'])
    ('honours Stop before semantic routing, without phrase binding or Kernel dispatch: %s', async text => {
    const s = await setup(true, { durableSelections: true });
    const dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      await s.coordinator.cancelByClientRequestId({ clientRequestId: 'stop_before_binding', source: 'desktop', privacyMode: 'persistent' });
      const cp = await s.coordinator.submit({ clientRequestId: 'stop_before_binding', inputMessageId: 'stopped_message',
        source: 'desktop', privacyMode: 'persistent', conversationId: 'conversation',
        text });
      await s.flush();
      expect((await s.coordinator.getTurn(cp.turn.id))!.turn.status).toBe('cancelled');
      expect(dispatch).not.toHaveBeenCalled(); expect(s.counts().legacyCalls).toBe(0);
    } finally { await s.close(); }
  });
  it('does not route plain exact-create wording before semantic Agent admission', async () => {
    const s = await setup(true, { durableSelections: true });
    try {
      const input = { clientRequestId: 'ordinary_create', inputMessageId: 'ordinary_message', conversationId: 'conversation',
        source: 'desktop' as const, privacyMode: 'persistent' as const,
        text: 'Создай файл "Новый отчёт.txt" с текстом: "  Точные байты 🟠  "', modifiers: { requestedModel: 'gemma4-fast', webSearch: false } };
      const initial = await s.coordinator.submit(input); await s.flush();
      expect(initial.turn.request.astra).toBeUndefined();
      const waiting = await s.coordinator.getTurn(initial.turn.id);
      expect(waiting!.turn.status).toBe('waiting-for-user');
      await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const replay = await s.coordinator.submit(input); await s.flush();
      expect(replay.turn.id).toBe(initial.turn.id);
      expect(s.counts().legacyCalls).toBe(0); expect(s.counts().modelCalls).toBe(0);
      await expect(s.coordinator.submit({ ...input, text: input.text.replace('Точные', 'Другие') })).rejects.toThrow();
    } finally { await s.close(); }
  });
  it('keeps local analysis disabled on an unconfigured host', async () => {
    const s = await setup(false);
    try {
      const input = request(); input.astra!.goal = { kind: 'analyze', targets: ['selected'], modelMode: 'local' };
      await expect(s.coordinator.submit(input)).rejects.toThrow('astra-model-mode-unavailable');
    } finally { await s.close(); }
  });
  it.each(['cancel', 'pause'] as const)('rechecks durable %s after async source preparation before any task admission', async command => {
    const s = await setup(false);
    try {
      const admitted = await s.coordinator.submit(request());
      vi.spyOn(s.bridge, 'prepare').mockImplementation(async turn => {
        await s.coordinator.commandAstra(turn.id, 'desktop', command);
        return undefined;
      });
      const submit = vi.spyOn(s.bridge, 'submit');
      const dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
      await s.start(); await s.flush();
      const current = (await s.coordinator.getTurn(admitted.turn.id))!.turn;
      expect(s.bridge.find(current)).toBeNull();
      expect(submit).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
      if (command === 'cancel') expect(current.status).toBe('cancelled');
      else expect(current.astraControl?.desired).toBe('pause');
    } finally { await s.close(); }
  });
  it.each([false, true])('retains host-prepared recall and fences a changed policy (change=%s)', async changePolicy => {
    const token = 'sha256:' + 'a'.repeat(64);
    const retrieve = vi.fn(async () => ({ schemaVersion: 1, scope: { type: 'chat' }, revision: '1:0', validityToken: token,
      explicitMemories: [{ kind: 'explicit', id: 'fixture_memory', title: '', text: 'OWNED_RECALL_KEEP',
        createdAt: '2026-09-05T00:00:00Z', score: 1, reason: 'fixture', origin: {} }],
      episodes: [], budgetChars: 2400, usedChars: 17, engine: 'fixture', semanticTimedOut: false,
      crossChatEnabled: false, cache: 'miss' }));
    let revision = '1';
    const admission = new AstraMemoryRecallAdmission({ policy: () => ({ enabled: true, revision }), retrieve });
    const s = await setup(false, { recall: { admission, isCurrent: () => true,
      readValidity: async () => ({ schemaVersion: 1, scope: { type: 'chat' }, revision: '1:0', validityToken: token, crossChatEnabled: false }) } });
    try {
      // Owner acquired, but no background progression/model call needed to prove atomic intake.
      await s.facade.startWithSourceRestore(async () => {});
      const input = request(); input.astra!.goal = { kind: 'analyze', targets: ['selected'], modelMode: 'local' };
      const admitted = await s.coordinator.submit(input);
      const turn = admitted.turn;
      const prepared = await s.bridge.prepare(turn);
      const task = s.bridge.submit(turn, prepared);
      const retained = s.journal.read(task.id)!.checkpoint as any;
      const source = s.journal.read(retained.goal.source.interactionId)!;
      expect((source.checkpoint as any).memoryRecall.validityToken).toBe(token);
      expect((source.checkpoint as any).memoryPolicyRevision).toBe('1');
      expect((s.journal.read(task.id)!.checkpoint as any).memoryRecall).toEqual((source.checkpoint as any).memoryRecall);
      expect(await s.bridge.prepare(turn)).toBeUndefined();
      expect(s.bridge.submit(turn).id).toBe(task.id);
      expect(retrieve).toHaveBeenCalledTimes(1);
      if (changePolicy) {
        revision = '3'; // Off/on returned to enabled but not the admitted revision.
        s.facade.notifySourceChange(); await s.facade.drain();
        expect(s.facade.read((source.checkpoint as any).actor, task.id, turn).status).toBe('blocked');
        expect(s.counts().modelCalls).toBe(0); expect(retrieve).toHaveBeenCalledTimes(1);
      } else s.facade.command((source.checkpoint as any).actor, task.id, turn, 'cancel');
      await s.facade.drain();
    } finally { await s.close(); }
  });
  it('restores a pending durable recovery intent on a new host and never repeats the approval effect', async () => {
    const s = await setup(); let closed = false;
    const draining = s.coordinator as unknown as { drainOutbox(): Promise<void> };
    let blockedDelivery: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const admitted = await s.coordinator.submit(request('literal')); await s.flush();
      const before = await s.coordinator.getTurn(admitted.turn.id);
      expect(before!.turn.status).toBe('waiting-for-approval');
      const approval = before!.events.filter(event => event.type === 'approval.required').at(-1)!.payload;
      blockedDelivery = vi.spyOn(draining, 'drainOutbox').mockResolvedValue(undefined);
      await s.coordinator.recoverAstra(admitted.turn.id, 'desktop', 'recover_after_restart');
      expect((await s.persistentStore.listPendingOutbox()).some(item => item.kind === 'astra-wake')).toBe(true);
      await s.close(); closed = true; blockedDelivery.mockRestore(); blockedDelivery = undefined;
      const reopened = await oscarBridgeHost(s.root), wake = vi.spyOn(reopened.bridge, 'wake'), dispatch = vi.spyOn(reopened.kernel, 'executeActionProposal');
      try {
        await reopened.start(); await reopened.flush();
        const after = await reopened.coordinator.getTurn(admitted.turn.id);
        expect(after!.turn.status).toBe('waiting-for-approval');
        expect(after!.turn.astraRecoveryRequests).toEqual(['recover_after_restart']);
        expect(after!.events.filter(event => event.type === 'approval.required').at(-1)!.payload.digest).toBe(approval.digest);
        expect(wake).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled();
        await reopened.coordinator.recoverAstra(admitted.turn.id, 'desktop', 'recover_after_restart'); await reopened.flush();
        expect(wake).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled();
        expect(reopened.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
      } finally { await reopened.close(); }
    } finally { blockedDelivery?.mockRestore(); if (!closed) await s.close(); }
  });

  it('adds nothing to a waiting Turn when the application restarts', async () => {
    // Live: every launch recorded the restore phase as a transition and back,
    // re-sending the open question; a waiting Turn had grown to 585 events.
    const s = await setup(); let closed = false;
    try {
      const admitted = await s.coordinator.submit(request('literal')); await s.flush();
      const before = (await s.coordinator.getTurn(admitted.turn.id))!;
      expect(before.turn.status).toBe('waiting-for-approval');
      await s.close(); closed = true;
      for (let launch = 0; launch < 2; launch++) {
        const reopened = await oscarBridgeHost(s.root);
        try {
          await reopened.start(); await reopened.flush();
          const after = (await reopened.coordinator.getTurn(admitted.turn.id))!;
          expect(after.turn.status).toBe('waiting-for-approval');
          expect(after.events).toHaveLength(before.events.length);
        } finally { await reopened.close(); }
      }
    } finally { if (!closed) await s.close(); }
  });

  it('projects healthy -> recovery issue -> same healthy view again, without repeating effects', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const admitted = await s.coordinator.submit(request('literal')); await s.flush();
      const original = s.bridge.find.bind(s.bridge); let issue: 'recovery-required' | undefined;
      vi.spyOn(s.bridge, 'find').mockImplementation(turn => {
        const view = original(turn); if (!view) return view; delete view.runtimeIssue;
        if (issue) view.runtimeIssue = issue; return view;
      });
      const projections = async () => (await s.coordinator.getTurn(admitted.turn.id))!.events.filter(event => event.payload.astraProjection);
      await s.coordinator.reconcileAstraTurn(admitted.turn.id); const healthy = (await projections()).at(-1)!.payload.astraProjection;
      issue = 'recovery-required'; await s.coordinator.reconcileAstraTurn(admitted.turn.id);
      expect((await projections()).at(-1)!.payload.runtimeIssue).toBe('recovery-required');
      issue = undefined; await s.coordinator.reconcileAstraTurn(admitted.turn.id);
      expect((await projections()).at(-1)!.payload).toMatchObject({ astraProjection: healthy, status: 'awaiting-approval' });
      expect((await projections()).at(-1)!.payload).not.toHaveProperty('runtimeIssue');
      const count = (await projections()).length; await s.coordinator.reconcileAstraTurn(admitted.turn.id); expect(await projections()).toHaveLength(count);
      expect(dispatch).toHaveBeenCalledTimes(1); await expect(readFile(path.join(s.root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  });
  it('finishes a terminal Astra task that has no model message instead of leaving Oscar running forever', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const admitted = await s.coordinator.submit(request('literal')); await s.flush();
      const original = s.bridge.find.bind(s.bridge);
      vi.spyOn(s.bridge, 'find').mockImplementation(turn => {
        const view = original(turn); if (!view) return view;
        delete view.message; delete view.approval; delete view.question;
        return { ...view, status: 'blocked', failureReason: 'decision-json-invalid' };
      });
      await s.coordinator.reconcileAstraTurn(admitted.turn.id);
      const terminal = (await s.coordinator.getTurn(admitted.turn.id))!;
      expect(terminal.turn).toMatchObject({ status: 'blocked', outcome: {
        kind: 'blocked', diagnostic: { code: 'decision-json-invalid' },
      } });
      expect(terminal.turn.outcome?.summary).toContain('План задачи не прошёл проверку');
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('imports the ordinary Oscar coordinator with node:sqlite unavailable', async () => {
    const child = spawn(process.execPath, ['--no-experimental-sqlite', '--import', 'tsx', '--input-type=module', '-e',
      "await import('./src/oscar-turn/coordinator.ts'); process.stdout.write('ordinary-import-ok');"],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
    await new Promise<void>((resolve, reject) => {
      let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill(), 10000);
      child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-4096); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer);
        if (code !== 0 || stdout !== 'ordinary-import-ok') reject(Error('ordinary-import:' + code + ':' + stderr)); else resolve(); });
    });
  }, 15000);
  it.each(['admitted', 'cancel-stored', 'terminal-stored', 'delivered', 'effect-unrecorded'])('restores after actual process exit68 at %s without duplicate execution/delivery', async stage => {
    const initial = await setup(false), root = initial.root; await initial.close();
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/oscar-bridge-worker.ts', root, stage],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEMP: root, TMP: root, TSX_DISABLE_CACHE: '1' } });
    const exited = await new Promise<{ turnId: string; dispatches: number }>((resolve, reject) => {
      let stdout = '', stderr = '', timeout = false;
      const timer = setTimeout(() => { timeout = true; child.kill(); }, 15000);
      child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 16384) child.kill(); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer);
        if (timeout || code !== 68) return reject(Error('owned-oscar-crash:' + code + ':' + stderr));
        try { const result = JSON.parse(stdout.trim()); expect(result.marker).toBe('owned-astra-oscar-exit');
          expect([result.modelCalls, result.legacyCalls, result.answerCalls]).toEqual([0, 0, 0]); resolve(result); } catch (error) { reject(error); }
      });
    });
    const probe = new AstraJournal(path.join(root, 'astra.sqlite'));
    const expiry = (probe.read('scheduler_oscar_bridge')!.checkpoint as { expiresAt: number }).expiresAt; probe.close();
    expect(expiry - Date.now()).toBeLessThanOrEqual(1100);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry - Date.now() + 20)));
    const s = await oscarBridgeHost(root), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      await s.start(); await s.flush(); const turn = (await s.coordinator.getTurn(exited.turnId))!.turn;
      if (stage === 'effect-unrecorded') {
        expect(turn.status).toBe('running'); expect(turn.outcome).toBeUndefined();
        const task = s.bridge.find(turn)!; expect(task.status).toBe('indeterminate'); expect(task.message).toBeUndefined();
        expect(exited.dispatches).toBe(2); expect(dispatch).not.toHaveBeenCalled();
        expect(await readFile(path.join(root, 'Новый отчёт.txt'), 'utf8')).toBe('Точные байты 🟠');
        expect((await s.delivered()).some(message => message.role === 'assistant')).toBe(false);
        return;
      }
      expect(turn.status).toBe(stage === 'cancel-stored' ? 'cancelled' : 'succeeded');
      expect(exited.dispatches + dispatch.mock.calls.length).toBe(1);
      const messages = await s.delivered(); expect(messages).toHaveLength(2);
      expect(new Set(messages.map(message => message.messageId)).size).toBe(2);
      expect(s.bridge.find(turn)!.message!.delivery).toBe('acknowledged');
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
      if (stage === 'cancel-stored') await expect(readFile(path.join(root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await s.close(); }
  }, 20000);
  it('routes a typed read through real Kernel with causal durable delivery and no V2/model/chat', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    const historyScan = vi.spyOn(s.persistentStore, 'listTurns');
    try {
      const admitted = await s.coordinator.submit(request()); await s.flush();
      const checkpoint = (await s.coordinator.getTurn(admitted.turn.id))!;
      expect(checkpoint.turn.status).toBe('succeeded'); expect(checkpoint.turn.outcome?.kind).toBe('partial');
      expect(checkpoint.turn.request.astra?.version).toBe('astra-oscar-isolated-v1'); expect(dispatch).toHaveBeenCalledTimes(1);
      const messages = await s.delivered(); expect(messages).toHaveLength(2);
      expect(messages[1]!.requiredPreviousMessageId).toBe('source_message'); expect(messages[1]!.provenance.verification).toBe('system-state');
      expect(s.bridge.find(checkpoint.turn)?.message?.delivery).toBe('acknowledged');
      const replay = await s.coordinator.submit(request()); await s.flush(); expect(replay.turn.id).toBe(admitted.turn.id);
      expect(dispatch).toHaveBeenCalledTimes(1); expect(await s.delivered()).toHaveLength(2);
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
      expect(historyScan).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('holds actual queued work behind a failed source restore and rejects concurrent barrier opening', async () => {
    const s = await setup(false), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const turn = (await s.coordinator.submit(request())).turn;
      let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
      const restoring = s.facade.startWithSourceRestore(async () => { s.bridge.submit(turn); await waiting; throw Error('source-restore-failed'); });
      await expect(s.facade.startWithSourceRestore(async () => {})).rejects.toThrow('restore-in-progress');
      expect(s.facade.hostStatus().issue).toBe('source-restore-required');
      release(); await expect(restoring).rejects.toThrow('source-restore-failed'); await s.facade.drain();
      expect(dispatch).not.toHaveBeenCalled(); expect(s.facade.hostStatus().issue).toBe('progression-failed');
      await s.facade.startWithSourceRestore(() => s.coordinator.start()); await s.flush();
      expect(dispatch).toHaveBeenCalledTimes(1); expect((await s.coordinator.getTurn(turn.id))!.turn.status).toBe('succeeded');
    } finally { await s.close(); }
  });
  it('does not silently change executor, content, message or selection on replay/save', async () => {
    const s = await setup();
    try {
      const first = await s.coordinator.submit(request()); await s.flush();
      for (const changed of [{ ...request(), inputMessageId: 'another' }, { ...request(), astra: { ...request().astra!, selectionId: 'different' } }])
        await expect(s.coordinator.submit(changed)).rejects.toThrow('different Oscar Turn request');
      const plain = request(); delete plain.astra; await expect(s.coordinator.submit(plain)).rejects.toThrow('different Oscar Turn request');
      const saved = (await s.coordinator.getTurn(first.turn.id))!.turn, changed = structuredClone(saved); delete changed.request.astra;
      await expect(s.persistentStore.saveTurn(changed, { expectedRevision: saved.revision })).rejects.toThrow('Immutable');
    } finally { await s.close(); }
  });
  it('keeps a missing/revoked Astra bridge from reaching V2 or answering', async () => {
    const s = await setup(false);
    try {
      const admitted = await s.coordinator.submit(request()); const { astra: _bridge, ...options } = s.options;
      const unavailable = new OscarTurnCoordinator(options);
      await expect(unavailable.start()).rejects.toThrow('Bound Astra host'); await unavailable.stop();
      expect((await s.coordinator.getTurn(admitted.turn.id))!.turn.status).toBe('running');
      s.revokeActor(); await expect(s.start()).rejects.toThrow('fixture-actor-revoked');
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
    } finally { await s.close(); }
  });
  it('restores a cancel before work starts, without even admitting a new Astra task', async () => {
    const s = await setup(false), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const admitted = await s.coordinator.submit(request('literal'));
      await s.coordinator.cancel(admitted.turn.id, 'desktop'); await s.start(); await s.flush();
      const turn = (await s.coordinator.getTurn(admitted.turn.id))!.turn;
      expect(turn.status).toBe('cancelled'); expect(s.bridge.find(turn)).toBeNull(); expect(dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('makes source projection failure visible and rejects mismatched approval without dispatch', async () => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const admitted = await s.coordinator.submit(request('literal')); await s.flush();
      const turn = (await s.coordinator.getTurn(admitted.turn.id))!.turn, approval = s.bridge.find(turn)!.approval!;
      await expect(s.coordinator.submitAstraInput(turn.id, 'api', { kind: 'decide', decision: {
        approvalId: approval.id, approvalDigest: approval.digest, messageId: 'foreign', decision: 'approve' } })).rejects.toThrow('source mismatch');
      await expect(s.coordinator.submitAstraInput(turn.id, 'desktop', { kind: 'decide', decision: {
        approvalId: approval.id, approvalDigest: 'sha256:' + '0'.repeat(64), messageId: 'stale', decision: 'approve' } })).rejects.toThrow('exact pending');
      s.revokeActor(); await s.flush();
      const checkpoint = (await s.coordinator.getTurn(turn.id))!;
      expect(checkpoint.events.filter(event => event.payload.runtimeIssue === 'source-projection-failed')).toHaveLength(1);
      expect(checkpoint.turn.outcome).toBeUndefined(); expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('restores pause before admission and resumes the same durable source once', async () => {
    const s = await setup(false), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const admitted = await s.coordinator.submit(request());
      await s.coordinator.commandAstra(admitted.turn.id, 'desktop', 'pause'); await s.start(); await s.flush();
      expect(dispatch).not.toHaveBeenCalled();
      await s.coordinator.commandAstra(admitted.turn.id, 'desktop', 'resume'); await s.flush();
      expect((await s.coordinator.getTurn(admitted.turn.id))!.turn.status,
        JSON.stringify({ outbox: await s.persistentStore.listPendingOutbox(new Date(Date.now() + 100000)), jobs: s.scheduler.list() })).toBe('succeeded'); expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it.each(['', '  Точные байты 🟠\n'])('preserves exact reply bytes (%j), requires bound approval and follows its predecessor', async content => {
    const s = await setup(), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      const admitted = await s.coordinator.submit(request('reply')); await s.flush();
      let turn = (await s.coordinator.getTurn(admitted.turn.id))!.turn;
      const question = s.bridge.find(turn)!.question!; expect(question).toBeDefined();
      expect(dispatch).not.toHaveBeenCalled();
      await expect(s.coordinator.sendMessage(turn.id, { source: 'desktop', content: 'new unrelated task' })).rejects.toThrow('exact Astra question');
      const reply: OscarAstraInput = { kind: 'reply', reply: { requestId: 'reply_request', questionId: question.id, questionDigest: question.digest, messageId: 'content_reply', text: content } };
      await s.coordinator.submitAstraInput(turn.id, 'desktop', reply); await s.flush();
      turn = (await s.coordinator.getTurn(turn.id))!.turn;
      expect(turn.status).toBe('waiting-for-approval'); expect(dispatch).toHaveBeenCalledTimes(1);
      const approval = s.bridge.find(turn)!.approval!;
      await s.coordinator.sendMessage(turn.id, { source: 'desktop', messageId: 'plain_yes', content: 'да' }); await s.flush();
      expect(dispatch).toHaveBeenCalledTimes(1);
      const decision: OscarAstraInput = { kind: 'decide', decision: { approvalId: approval.id, approvalDigest: approval.digest, messageId: 'exact_approval', decision: 'approve' } };
      await s.coordinator.submitAstraInput(turn.id, 'desktop', decision); await s.flush();
      turn = (await s.coordinator.getTurn(turn.id))!.turn;
      expect(turn.status).toBe('succeeded'); expect(turn.outcome?.kind).toBe('partial'); expect(dispatch).toHaveBeenCalledTimes(2);
      expect(await readFile(path.join(s.root, 'Новый отчёт.txt'), 'utf8')).toBe(content);
      const messages = await s.delivered(); expect(messages.find(message => message.messageId === 'content_reply')!.content).toBe(content);
      expect(messages.at(-1)!.requiredPreviousMessageId).toBe('exact_approval');
      await s.coordinator.submitAstraInput(turn.id, 'desktop', decision); await s.flush(); expect(dispatch).toHaveBeenCalledTimes(2);
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
    } finally { await s.close(); }
  });
});

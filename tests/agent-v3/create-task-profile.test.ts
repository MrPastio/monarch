import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core/kernel';
import { WorkspaceModule } from '../../src/modules/workspace';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraWorkScheduler, type AstraWorkJob } from '../../src/agent-v3/work-scheduler';
import { AstraReadWorkAdapter } from '../../src/agent-v3/read-work-adapter';
import { AstraReadTaskProfile } from '../../src/agent-v3/read-task-runtime';
import { astraCreateWorkId } from '../../src/agent-v3/create-work-adapter';
import { AstraCreateTaskProfile, type AstraCreateAdmissionPort, type AstraCreateTaskRecord } from '../../src/agent-v3/create-task-profile';
import { astraCreateValueDigest, certifyAstraCreateTask, type AstraCreateCertificationInput,
  type AstraCreateSelection } from '../../src/agent-v3/create-task-certifier';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';
import { createApprovalAnswerId, type AstraCreateApprovalDecision } from '../../src/agent-v3/create-approval';

let parent: string, fixture: string, sequence = 0;
const marker = 'astra-v3-create-task-owned-synthetic-only';
beforeAll(async () => {
  parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  fixture = await realpath(await mkdtemp(path.join(parent, 'astra-v3-create-task-'))); expect(path.dirname(fixture)).toBe(parent);
  await writeFile(path.join(fixture, '.fixture-marker'), marker, { flag: 'wx' });
});
afterAll(async () => {
  if (!fixture) return;
  expect(await realpath(fixture)).toBe(fixture); expect(path.dirname(fixture)).toBe(parent);
  expect(path.basename(fixture).startsWith('astra-v3-create-task-')).toBe(true);
  expect(await readFile(path.join(fixture, '.fixture-marker'), 'utf8')).toBe(marker);
  await rm(fixture, { recursive: true, force: false });
});
async function setup(fileBacked = false, joinedReadTasks = false, exactApprovals = false) {
  const root = path.join(fixture, 'workspace_' + sequence++); await mkdir(root);
  await writeFile(path.join(root, 'read-source.txt'), 'OWNED READ', { flag: 'wx' });
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
  const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] });
  kernel.registerModule(workspace); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
  const calls = vi.spyOn(workspace, 'executeCapability'), gateway = vi.spyOn(kernel, 'executeActionProposal');
  const file = fileBacked ? path.join(root, 'tasks.sqlite') : ':memory:', journal = new AstraJournal(file);
  const selections = new Map<string, AstraCreateSelection>(), revoked = new Set<string>();
  const admission: AstraCreateAdmissionPort = {
    resolve: source => {
      const selected = selections.get(source.messageId);
      if (source.interactionId !== 'owned_interaction' || !selected) throw new Error('unknown-owned-selection');
      return structuredClone(selected);
    },
    isCurrent: source => !revoked.has(source.messageId) && selections.get(source.messageId)?.revision === source.revision
      && selections.get(source.messageId)?.digest === source.digest,
  };
  const options = { deployment: 'isolated-validation' as const, canonicalRoot: root, scopeId: 'create_tasks', kernel, journal, admission, exactApprovals };
  const tasks = new AstraCreateTaskProfile(options), read = new AstraReadWorkAdapter(options);
  const readSelection = { authority: 'observe' as const, revision: 1, digest: astraCreateValueDigest('owned-read-selection'),
    requirements: [{ id: 'read_input', relativePath: 'read-source.txt' }] };
  const readTasks = joinedReadTasks ? new AstraReadTaskProfile({ ...options, admission: {
    resolve: source => {
      if (source.interactionId !== 'read_interaction' || source.messageId !== 'read_message') throw new Error('unknown-read-selection');
      return structuredClone(readSelection);
    }, isCurrent: source => source.interactionId === 'read_interaction' && source.messageId === 'read_message'
      && source.revision === readSelection.revision && source.digest === readSelection.digest,
  } }) : undefined;
  const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'create_tasks',
    adapters: [tasks.adapter, readTasks?.adapter ?? read], limits: { maxActive: 2, kernelSlots: 1, modelSlots: 0 } });
  tasks.attach(scheduler); readTasks?.attach(scheduler); scheduler.acquire();
  return { root, file, kernel, workspace, calls, gateway, journal, tasks, scheduler, options, selections, revoked, read, readTasks,
    request: (requestId: string, content = 'OWNED OUTPUT', basename = requestId + '.txt') => {
      const messageId = 'user_' + requestId, selected = { authority: 'exclusive-create' as const, revision: 1,
        digest: astraCreateValueDigest({ requestId, content, basename }), content, basename,
        userText: 'Create the synthetic file ' + basename + ' with the explicitly selected content.' };
      selections.set(messageId, selected); return { requestId, source: { interactionId: 'owned_interaction', messageId } };
    },
    drain: async () => { await scheduler.drain(); return tasks.synchronizeAll(); },
    close: async () => { await scheduler.close(); await kernel.stop(); journal.close(); calls.mockRestore(); gateway.mockRestore(); },
  };
}
function certificationInput(journal: AstraJournal, taskId: string): AstraCreateCertificationInput {
  const record = journal.read(taskId)!.checkpoint as unknown as AstraCreateTaskRecord;
  const job = (journal.read('scheduler_create_tasks')!.checkpoint as unknown as { jobs: AstraWorkJob[] }).jobs.find(job => job.id === record.jobId)!;
  return { goal: record.goal, goalDigest: record.goalDigest, job, effect: journal.read(astraCreateWorkId('create_tasks', job.id)) };
}
async function crashedTask(root: string, stage: string): Promise<{ taskId: string; workspaceCalls: number; helperCalls: number; status: string; delivery: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-v3/create-task-worker.ts', root, stage],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_DISABLE_CACHE: '1', TEMP: root, TMP: root } });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
    child.stdout.on('data', data => { stdout += String(data); if (stdout.length > 8192) { timedOut = true; child.kill(); } });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8192); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 64) reject(new Error(timedOut ? 'owned-worker-budget' : stderr));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
}

describe('Astra create Goal → shared scheduler → real Kernel effect → pure certificate and causal outbox', () => {
  const vague = (s: Awaited<ReturnType<typeof setup>>, name = 'approval') => {
    const request = s.request(name, 'Точные байты 🟠\r\n', 'Новый отчёт.txt');
    s.selections.get(request.source.messageId)!.userText = 'Обработай выбранную цель согласно явно заданному действию.';
    return request;
  };
  const approve = (s: Awaited<ReturnType<typeof setup>>, taskId: string): AstraCreateApprovalDecision => {
    const card = s.tasks.read(taskId).approval!; expect(card).toBeDefined();
    return { approvalId: card.id, approvalDigest: card.digest, messageId: 'exact_user_answer', decision: 'approve' };
  };
  it.each(['approve', 'reject'] as const)('waits for exact Kernel approval then %s on the same job', async decision => {
    const s = await setup(false, true, true);
    try {
      const request = vague(s), initial = s.tasks.submit(request); await s.drain();
      const waiting = s.tasks.read(initial.taskId);
      expect(waiting.status).toBe('awaiting-approval'); expect(waiting.message).toBeUndefined();
      expect(waiting.approval).toMatchObject({ basename: 'Новый отчёт.txt', content: 'Точные байты 🟠\r\n', overwrite: false, grantScope: 'once' });
      expect(s.calls).not.toHaveBeenCalled(); expect(s.gateway).toHaveBeenCalledTimes(1);
      s.tasks.command(initial.taskId, 'resume'); await s.drain();
      expect(s.tasks.read(initial.taskId).status).toBe('awaiting-approval'); expect(s.gateway).toHaveBeenCalledTimes(1);
      const read = s.readTasks!.submit({ requestId: 'read_while_waiting', source: { interactionId: 'read_interaction', messageId: 'read_message' } });
      await s.scheduler.drain(); expect(s.readTasks!.synchronize(read.taskId).status).toBe('completed');
      const answer = { ...approve(s, initial.taskId), decision };
      s.tasks.decide(initial.taskId, answer); await s.drain();
      const done = s.tasks.read(initial.taskId);
      expect(done.status).toBe(decision === 'approve' ? 'completed' : 'blocked');
      expect(done.message?.predecessorMessageId).toBe(answer.messageId);
      expect(done.certificate?.approvalEvidence?.decision).toBe(decision);
      expect(s.scheduler.list()).toHaveLength(2);
      expect(s.calls.mock.calls.filter(call => call[0].capabilityId === 'workspace.files.write')).toHaveLength(decision === 'approve' ? 1 : 0);
      if (decision === 'approve') expect(await readFile(path.join(s.root, 'Новый отчёт.txt'), 'utf8')).toBe('Точные байты 🟠\r\n');
      expect(s.tasks.decide(initial.taskId, answer)).toEqual(done);
      expect(() => s.tasks.decide(initial.taskId, { ...answer, decision: decision === 'approve' ? 'reject' : 'approve' })).toThrow('approval-conflict');
      s.tasks.acknowledgeMessage(initial.taskId, done.message!.certificateDigest);
      expect(s.tasks.decide(initial.taskId, answer).message?.delivery).toBe('acknowledged');
    } finally { await s.close(); }
  });
  it.each(['pause', 'cancel', 'source-stale', 'expired', 'tamper', 'no-answer-proof'] as const)('preserves exact approval boundary: %s', async mode => {
    const s = await setup(false, false, true);
    try {
      const request = vague(s), initial = s.tasks.submit({ ...request, ...(mode === 'expired' ? { startWithinMs: 100, finishWithinMs: 200 } : {}) });
      await s.drain(); const answer = approve(s, initial.taskId);
      if (mode === 'tamper') {
        expect(() => s.tasks.decide(initial.taskId, { ...answer, approvalDigest: 'sha256:' + '0'.repeat(64) })).toThrow('answer-binding');
        expect(() => s.tasks.decide(initial.taskId, { ...answer, confirmed: true } as any)).toThrow('invalid-decision');
      } else if (mode === 'pause') {
        s.tasks.command(initial.taskId, 'pause'); s.tasks.decide(initial.taskId, answer); await s.drain();
        expect(s.tasks.read(initial.taskId).status).toBe('paused'); expect(s.calls).not.toHaveBeenCalled();
        s.tasks.command(initial.taskId, 'resume'); await s.drain(); expect(s.tasks.read(initial.taskId).status).toBe('completed');
      } else if (mode === 'no-answer-proof') {
        s.tasks.decide(initial.taskId, answer); await s.drain();
        const proof = certificationInput(s.journal, initial.taskId);
        expect(() => certifyAstraCreateTask(proof)).toThrow('approval-required');
        expect(certifyAstraCreateTask({ ...proof, approvalAnswer: s.journal.read(createApprovalAnswerId(initial.taskId)) }).status).toBe('completed');
      } else {
        if (mode === 'source-stale') s.revoked.add(request.source.messageId);
        if (mode === 'cancel') s.tasks.command(initial.taskId, 'cancel');
        if (mode === 'expired') {
          await new Promise(resolve => setTimeout(resolve, 225));
          expect(() => s.tasks.decide(initial.taskId, answer)).toThrow('approval-unavailable');
          expect(s.tasks.synchronize(initial.taskId).status).toBe('blocked');
        } else expect(() => s.tasks.decide(initial.taskId, answer)).toThrow('approval-unavailable');
      }
      if (!['pause', 'no-answer-proof'].includes(mode)) expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('accepts a late rejection while refusing the same expired approval', async () => {
    const s = await setup(false, false, true);
    try {
      const initial = s.tasks.submit({ ...vague(s, 'late_rejection'), startWithinMs: 100, finishWithinMs: 200 });
      await s.drain();
      const answer = approve(s, initial.taskId);
      await new Promise(resolve => setTimeout(resolve, 225));
      expect(() => s.tasks.decide(initial.taskId, answer)).toThrow('approval-unavailable');
      const rejected = s.tasks.decide(initial.taskId, { ...answer, decision: 'reject', messageId: 'late_rejection_answer' });
      expect(rejected.status).toBe('blocked');
      expect(rejected.certificate?.approvalEvidence?.decision).toBe('reject');
      expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('recovers the committed exact answer after a failure before the scheduler wake', async () => {
    const s = await setup(true, false, true);
    try {
      const initial = s.tasks.submit(vague(s)); await s.drain(); const answer = approve(s, initial.taskId);
      const wake = vi.spyOn(s.scheduler, 'command').mockImplementationOnce(() => { throw Error('owned-wake-crash'); });
      expect(() => s.tasks.decide(initial.taskId, answer)).toThrow('owned-wake-crash'); wake.mockRestore();
      expect(s.journal.read(createApprovalAnswerId(initial.taskId))).not.toBeNull(); expect(s.calls).not.toHaveBeenCalled();
      await s.scheduler.close();
      const resumed = new AstraCreateTaskProfile(s.options), scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal: s.journal,
        scopeId: 'create_tasks', adapters: [resumed.adapter, s.read], limits: { maxActive: 2, kernelSlots: 1, modelSlots: 0 } });
      resumed.attach(scheduler); scheduler.acquire();
      try { resumed.synchronizeAll(); await scheduler.drain(); expect(resumed.synchronize(initial.taskId).status).toBe('completed');
        expect(resumed.decide(initial.taskId, answer).status).toBe('completed'); expect(s.calls).toHaveBeenCalledTimes(1);
      } finally { await scheduler.close(); }
    } finally { await s.close(); }
  });
  it('rolls back the approval answer, source claim and capacity together on real SQLite failure', async () => {
    const s = await setup(true, false, true), fault = new DatabaseSync(s.file);
    try {
      const initial = s.tasks.submit(vague(s)); await s.drain(); const answer = approve(s, initial.taskId), before = s.journal.capacity();
      const source = { records: [{ streamId: 'owned_approval_source', checkpoint: { taskId: initial.taskId, messageId: answer.messageId },
        events: [{ type: 'owned.approval-source' }] }] };
      fault.exec("CREATE TRIGGER reject_approval_source BEFORE INSERT ON astra_commits WHEN NEW.stream_id='owned_approval_source' BEGIN SELECT RAISE(ABORT,'owned-approval-source-fault'); END;");
      expect(() => s.tasks.decide(initial.taskId, answer, source)).toThrow('owned-approval-source-fault');
      expect(s.journal.read(createApprovalAnswerId(initial.taskId))).toBeNull(); expect(s.journal.read('owned_approval_source')).toBeNull();
      expect(s.journal.capacity()).toEqual(before); expect(s.calls).not.toHaveBeenCalled();
      fault.exec('DROP TRIGGER reject_approval_source'); s.tasks.decide(initial.taskId, answer, source); await s.drain();
      expect(s.tasks.read(initial.taskId).status).toBe('completed');
      expect(s.journal.reservation('approval_source_' + initial.taskId)).toBeNull();
      const after = s.journal.capacity(); s.tasks.decide(initial.taskId, answer, source); expect(s.journal.capacity()).toEqual(after);
    } finally { fault.close(); await s.close(); }
  });
  it('pins explicit create-pack v2 and refuses reopening its scheduler as legacy v1', async () => {
    const s = await setup(true, false, true);
    try {
      const initial = s.tasks.submit(vague(s)); await s.drain(); expect(s.scheduler.job(initial.jobId).adapterVersion).toBe('v2');
      await s.scheduler.close(); const legacy = new AstraCreateTaskProfile({ ...s.options, exactApprovals: false });
      const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal: s.journal, scopeId: 'create_tasks',
        adapters: [legacy.adapter, s.read], limits: { maxActive: 2, kernelSlots: 1, modelSlots: 0 } });
      expect(() => scheduler.acquire()).toThrow('checkpoint-binding'); expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it.each(['policy-change', 'lost-return', 'missing-receipt', 'target-appeared'] as const)('does not weaken confirmed-create recovery: %s', async mode => {
    const s = await setup(false, false, true);
    try {
      const initial = s.tasks.submit(vague(s)); await s.drain(); const answer = approve(s, initial.taskId);
      s.tasks.decide(initial.taskId, answer);
      const actual = MonarchKernel.prototype.executeActionProposal.bind(s.kernel);
      if (mode === 'policy-change') s.gateway.mockImplementationOnce((proposal, options) => actual(proposal,
        { ...options, approvalPolicyDecisionHash: '0'.repeat(64) })); // Kernel rejects an old policy binding.
      if (mode === 'lost-return' || mode === 'missing-receipt') s.gateway.mockImplementationOnce(async (...args) => {
        await actual(...args); throw Error('owned-approved-return-lost');
      });
      if (mode === 'target-appeared') await writeFile(path.join(s.root, 'Новый отчёт.txt'), 'OTHER ACTOR', { flag: 'wx' });
      await s.drain();
      if (mode === 'lost-return') expect(s.tasks.reconcile(initial.taskId).status).toBe('completed');
      else if (mode === 'missing-receipt') {
        const receipt = vi.spyOn(s.kernel, 'getActionLedgerRecord').mockReturnValue(null);
        try {
          expect(s.tasks.reconcile(initial.taskId).status).toBe('indeterminate');
          expect(s.tasks.reconcile(initial.taskId).message).toBeUndefined();
          expect(() => s.tasks.command(initial.taskId, 'resume')).toThrow('not-paused');
          expect(s.tasks.decide(initial.taskId, answer).status).toBe('indeterminate'); await s.drain();
        } finally { receipt.mockRestore(); }
      } else expect(s.tasks.read(initial.taskId).status).toBe('blocked');
      expect(s.calls).toHaveBeenCalledTimes(['lost-return', 'missing-receipt'].includes(mode) ? 1 : 0);
      expect(s.gateway).toHaveBeenCalledTimes(mode === 'target-appeared' ? 1 : 2);
    } finally { await s.close(); }
  });
  it.each(['approval-waiting', 'approval-answered', 'approval-effect', 'approval-certified'])('restores exact approval after real process exit: %s', async stage => {
    const root = path.join(fixture, 'crash_' + sequence++); await mkdir(root); const crash = await crashedTask(root, stage);
    await new Promise(resolve => setTimeout(resolve, 550));
    const journal = new AstraJournal(path.join(root, 'tasks.sqlite'));
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
    const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] });
    kernel.registerModule(workspace); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
    const writes = vi.spyOn(workspace, 'executeCapability');
    const source = { interactionId: 'crash_interaction', messageId: 'crash_message' };
    const selection = { authority: 'exclusive-create' as const, revision: 1, digest: astraCreateValueDigest('owned-crash-selection'),
      basename: 'Новый отчёт.txt', content: 'OWNED CAUSAL ARTIFACT\n', userText: 'Обработай выбранную цель согласно явно заданному действию.' };
    const tasks = new AstraCreateTaskProfile({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: 'create_task_crash', kernel, journal, exactApprovals: true,
      admission: { resolve: key => { expect(key).toEqual(source); return structuredClone(selection); }, isCurrent: key => key.digest === selection.digest && key.revision === 1 } });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'create_task_crash',
      adapters: [tasks.adapter], limits: { leaseMs: 500, kernelSlots: 1, modelSlots: 0 } }); tasks.attach(scheduler); scheduler.acquire();
    try {
      if (stage === 'approval-waiting') {
        const card = tasks.read(crash.taskId).approval!; expect(card).toBeDefined();
        tasks.decide(crash.taskId, { approvalId: card.id, approvalDigest: card.digest, messageId: 'crash_approval_message', decision: 'approve' });
      }
      tasks.synchronizeAll(); await scheduler.drain(); const done = tasks.synchronize(crash.taskId);
      expect(done.status).toBe('completed'); expect(done.message?.predecessorMessageId).toBe('crash_approval_message');
      expect(writes.mock.calls.length + crash.workspaceCalls).toBe(1);
      expect(await readFile(path.join(root, selection.basename), 'utf8')).toBe(selection.content);
      tasks.acknowledgeMessage(crash.taskId, done.message!.certificateDigest); await scheduler.drain();
      expect(writes.mock.calls.length + crash.workspaceCalls).toBe(1);
    } finally { await scheduler.close(); await kernel.stop(); journal.close(); writes.mockRestore(); }
  }, 20000);
  it.each(['', 'Привет 🟠\n', 'x'.repeat(4103)])('certifies exact content without a second action and acknowledges a source-bound message (%#.case)', async content => {
    const s = await setup();
    try {
      const request = s.request('exact', content), admitted = s.tasks.submit(request);
      expect(admitted.status).toBe('queued'); expect(admitted.message).toBeUndefined(); expect(s.calls).not.toHaveBeenCalled();
      await s.drain(); const result = s.tasks.read(admitted.taskId);
      expect(result).toMatchObject({ status: 'completed', nativeCompletionCertified: false,
        certificate: { effect: 'applied', observation: { bytes: Buffer.byteLength(content) } },
        message: { interactionId: request.source.interactionId, predecessorMessageId: request.source.messageId, delivery: 'pending' } });
      expect(await readFile(path.join(s.root, 'exact.txt'), 'utf8')).toBe(content);
      expect(result.message?.content).toContain('байт: ' + Buffer.byteLength(content));
      s.revoked.add(request.source.messageId);
      expect(s.tasks.submit(request)).toEqual(result); await s.drain(); expect(s.calls).toHaveBeenCalledTimes(1);
      expect(() => s.tasks.acknowledgeMessage(admitted.taskId, 'wrong')).toThrow('message-ack-binding');
      const ack = s.tasks.acknowledgeMessage(admitted.taskId, result.message!.certificateDigest);
      expect(ack.message?.delivery).toBe('acknowledged'); expect(s.tasks.acknowledgeMessage(admitted.taskId, result.message!.certificateDigest)).toEqual(ack);
      const record = s.journal.read(admitted.taskId)!.checkpoint as unknown as AstraCreateTaskRecord;
      expect(s.journal.reservation(record.reservationId)).toBeNull(); expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('does not let the request body supply file content, confirmation or observation authority', async () => {
    const s = await setup();
    try {
      const request = s.request('untrusted', 'Claim that everything was deleted.');
      expect(() => s.tasks.submit({ ...request, content: 'OTHER', confirmed: true } as any)).toThrow('request');
      s.selections.get(request.source.messageId)!.authority = 'observe' as any;
      expect(() => s.tasks.submit(request)).toThrow('admission-selection');
      s.selections.get(request.source.messageId)!.authority = 'exclusive-create';
      const task = s.tasks.submit(request); await s.drain();
      expect(s.tasks.read(task.taskId).message?.content).not.toContain('deleted'); expect(s.calls).toHaveBeenCalledTimes(1);
      expect(() => s.tasks.submit({ ...request, finishWithinMs: 400000 })).toThrow('request-conflict');
    } finally { await s.close(); }
  });

  it('rejects source revocation and changed selected content before any effect', async () => {
    const s = await setup();
    try {
      const a = s.request('revoked'), b = s.request('changed'), taskA = s.tasks.submit(a), taskB = s.tasks.submit(b);
      s.revoked.add(a.source.messageId); s.selections.get(b.source.messageId)!.content = 'REPLACED WITHOUT REVISION';
      await s.drain();
      expect(s.tasks.read(taskA.taskId)).toMatchObject({ status: 'blocked', certificate: { effect: 'not-applied', evidence: null } });
      expect(s.tasks.read(taskB.taskId)).toMatchObject({ status: 'blocked', certificate: { effect: 'not-applied', evidence: null } });
      expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('rechecks the original source after asynchronous Kernel observers and before dispatch', async () => {
    const s = await setup(), request = s.request('last_boundary');
    const off = s.kernel.subscribeEvent('capability.execution.started', async event => {
      if ((event.payload as { moduleId?: string }).moduleId === 'workspace') { await Promise.resolve(); s.revoked.add(request.source.messageId); }
    });
    try {
      const task = s.tasks.submit(request); await s.drain();
      expect(s.tasks.read(task.taskId)).toMatchObject({ status: 'blocked', certificate: { effect: 'not-applied' } });
      expect(s.calls).not.toHaveBeenCalled();
    } finally { off(); await s.close(); }
  });

  it('reports an existing target as blocked without modifying it or inventing a created artifact', async () => {
    const s = await setup();
    try {
      const task = s.tasks.submit(s.request('existing', 'NO', 'read-source.txt')); await s.drain();
      expect(s.tasks.read(task.taskId)).toMatchObject({ status: 'blocked', certificate: { effect: 'not-applied' } });
      expect(await readFile(path.join(s.root, 'read-source.txt'), 'utf8')).toBe('OWNED READ'); expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it('certifies a queued cancellation without a create and retains the original predecessor', async () => {
    const s = await setup();
    try {
      const request = s.request('queued_cancel'), task = s.tasks.submit(request);
      expect(s.tasks.command(task.taskId, 'pause').status).toBe('paused'); await s.drain();
      const cancelled = s.tasks.command(task.taskId, 'cancel');
      expect(cancelled).toMatchObject({ status: 'cancelled', certificate: { effect: 'not-applied' },
        message: { predecessorMessageId: request.source.messageId } });
      expect(cancelled.message?.content).toContain('не создало'); expect(s.calls).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it.each(['cancel', 'pause'] as const)('preserves actual created bytes when %s happens before the task can certify', async command => {
    const s = await setup();
    try {
      const task = s.tasks.submit(s.request('late_control', 'CREATED BEFORE RETURN'));
      const off = s.kernel.subscribeEvent('workspace.file.written', () => { s.tasks.command(task.taskId, command); });
      try { await s.drain(); } finally { off(); }
      if (command === 'pause') {
        expect(s.tasks.read(task.taskId).status).toBe('paused'); expect(s.tasks.read(task.taskId).message).toBeUndefined();
        expect(s.tasks.command(task.taskId, 'resume').status).toBe('completed');
      }
      const result = s.tasks.read(task.taskId);
      expect(result).toMatchObject({ status: command === 'cancel' ? 'cancelled' : 'completed', certificate: { effect: 'applied' } });
      expect(result.message?.content).toContain('файл создан'); expect(s.calls).toHaveBeenCalledTimes(1);
      if (command === 'cancel') expect(result.message?.content).toContain('отменена');
    } finally { await s.close(); }
  });

  it('rolls back Goal, queue and future capacity together when source admission cannot be persisted', async () => {
    const s = await setup(true), fault = new DatabaseSync(s.file);
    try {
      const before = s.journal.capacity(), request = s.request('atomic_admit');
      fault.exec("CREATE TRIGGER reject_create_goal BEFORE INSERT ON astra_commits WHEN NEW.stream_id LIKE 'task_create_%' BEGIN SELECT RAISE(ABORT,'owned-create-admit-fault'); END;");
      expect(() => s.tasks.submit(request)).toThrow('owned-create-admit-fault');
      expect(s.tasks.list()).toHaveLength(0); expect(s.scheduler.list()).toHaveLength(0);
      expect(s.journal.capacity()).toEqual(before); expect(s.calls).not.toHaveBeenCalled();
      fault.exec('DROP TRIGGER reject_create_goal');
      const task = s.tasks.submit(request); await s.drain(); expect(s.tasks.read(task.taskId).status).toBe('completed');
    } finally { fault.close(); await s.close(); }
  });

  it('atomically retries certificate/terminal/outbox storage without repeating the already applied effect', async () => {
    const s = await setup(true), fault = new DatabaseSync(s.file);
    try {
      const task = s.tasks.submit(s.request('cert_fault'));
      fault.exec("CREATE TRIGGER reject_create_message BEFORE INSERT ON astra_commits WHEN NEW.stream_id LIKE 'message_task_create_%' BEGIN SELECT RAISE(ABORT,'owned-create-outbox-fault'); END;");
      await expect(s.drain()).rejects.toThrow('owned-create-outbox-fault');
      expect(s.tasks.read(task.taskId)).toMatchObject({ status: 'awaiting-certification' });
      expect(s.journal.read('certificate_' + task.taskId)).toBeNull(); expect(s.tasks.read(task.taskId).message).toBeUndefined();
      expect(s.calls).toHaveBeenCalledTimes(1); fault.exec('DROP TRIGGER reject_create_message');
      expect(s.tasks.synchronize(task.taskId).status).toBe('completed'); await s.drain(); expect(s.calls).toHaveBeenCalledTimes(1);
    } finally { fault.close(); await s.close(); }
  });

  it('does not certify a missing return until exact Kernel receipt reconciliation', async () => {
    const s = await setup();
    try {
      const actual = MonarchKernel.prototype.executeActionProposal.bind(s.kernel);
      s.gateway.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('owned-lost-create-return'); });
      const task = s.tasks.submit(s.request('lost_return')); await s.drain();
      expect(s.tasks.read(task.taskId)).toMatchObject({ status: 'indeterminate' }); expect(s.tasks.read(task.taskId).message).toBeUndefined();
      expect(s.tasks.reconcile(task.taskId)).toMatchObject({ status: 'completed', certificate: { effect: 'applied' } });
      expect(s.calls).toHaveBeenCalledTimes(1); expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it('shares one scheduler slot with read work instead of constructing a parallel effect executor', async () => {
    const s = await setup();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const off = s.kernel.subscribeEvent('workspace.file.written', async () => { entered(); await gate; });
    try {
      const task = s.tasks.submit(s.request('shared'));
      const read = s.scheduler.submit({ requestId: 'read_alongside_create', adapterId: s.read.id,
        input: { steps: [{ id: 'read', relativePath: 'read-source.txt' }] } });
      const running = s.scheduler.drain(); await ready;
      expect(s.scheduler.job(read.id).state).toBe('queued'); expect(s.calls).toHaveBeenCalledTimes(1);
      release(); await running; expect(s.tasks.synchronize(task.taskId).status).toBe('completed');
      expect(s.scheduler.job(read.id).state).toBe('observed'); expect(s.tasks.list()).toHaveLength(1);
      expect(s.calls.mock.calls.map(call => call[0].capabilityId)).toEqual(['workspace.files.write', 'workspace.files.read']);
    } finally { release(); off(); await s.close(); }
  });

  it('rejects mismatched external scheduler attachment before accepting any task', async () => {
    const s = await setup();
    const another = new AstraCreateTaskProfile(s.options);
    try { expect(() => another.attach(s.scheduler)).toThrow('scheduler-binding'); expect(s.calls).not.toHaveBeenCalled(); }
    finally { await s.close(); }
  });

  it('runs admitted read and create Goals on the SAME scheduler while keeping their certificates and outboxes separate', async () => {
    const s = await setup(false, true);
    try {
      const read = s.readTasks!.submit({ requestId: 'joined_read', source: { interactionId: 'read_interaction', messageId: 'read_message' } });
      const create = s.tasks.submit(s.request('joined_create'));
      // The read profile pumps the shared host, but certifies ONLY its own jobs.
      await s.readTasks!.drain();
      expect(s.readTasks!.read(read.taskId)).toMatchObject({ status: 'completed', message: { predecessorMessageId: 'read_message' } });
      expect(s.tasks.read(create.taskId).status).toBe('awaiting-certification');
      expect(s.tasks.synchronize(create.taskId)).toMatchObject({ status: 'completed', message: { predecessorMessageId: 'user_joined_create' } });
      expect(s.readTasks!.list()).toHaveLength(1); expect(s.tasks.list()).toHaveLength(1); expect(s.scheduler.list()).toHaveLength(2);
      expect(s.calls.mock.calls.map(call => call[0].capabilityId)).toEqual(['workspace.files.read', 'workspace.files.write']);
      await s.kernel.stop();
      expect(s.readTasks!.read(read.taskId).status).toBe('completed'); expect(s.tasks.read(create.taskId).status).toBe('completed');
      expect(s.calls).toHaveBeenCalledTimes(2);
    } finally { await s.close(); }
  });

  it('pure certification refuses invented values, wrong Goal, uncertain effect and changed frontiers', async () => {
    const s = await setup();
    try {
      const task = s.tasks.submit(s.request('pure', 'x'.repeat(4103))); await s.drain();
      const valid = certificationInput(s.journal, task.taskId);
      expect(certifyAstraCreateTask(valid).status).toBe('completed');
      const mutations: Array<(input: any) => void> = [
        input => { input.goal.requirement.bytes = 0; }, input => { input.effect = null; },
        input => { input.effect.revision++; }, input => { input.effect.checkpoint.observation.bytes = 0; },
        input => { input.effect.checkpoint.effect = 'unknown'; }, input => { input.job.state = 'cancelled'; },
        input => { input.effect.checkpoint.observation.proposalHash = '0'.repeat(64); },
        input => { input.job.input.create.content = 'OTHER'; }, input => { input.job.input.taskId = 'foreign_task'; },
      ];
      for (const mutate of mutations) { const wrong = structuredClone(valid); mutate(wrong); expect(() => certifyAstraCreateTask(wrong)).toThrow(); }
      expect(s.calls).toHaveBeenCalledTimes(1); expect(s.gateway).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });

  it.each(['after-effect', 'after-certificate', 'after-ack'])('survives real process exit %s and resumes the causal outbox without even an active Kernel module', async stage => {
    const root = path.join(fixture, 'crash_' + sequence++); await mkdir(root);
    const crash = await crashedTask(root, stage);
    expect(crash).toMatchObject({ workspaceCalls: 1, helperCalls: 0,
      status: stage === 'after-effect' ? 'awaiting-certification' : 'completed', delivery: stage === 'after-effect' ? null : stage === 'after-ack' ? 'acknowledged' : 'pending' });
    await new Promise(resolve => setTimeout(resolve, 600));
    const journal = new AstraJournal(path.join(root, 'tasks.sqlite'));
    // Deliberately no Workspace registration/start and no live source admission.
    // Historical Store facts, not a renewed capability or read, certify the result.
    const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false });
    const gateway = vi.spyOn(kernel, 'executeActionProposal'), receipt = vi.spyOn(kernel, 'getActionLedgerRecord');
    const tasks = new AstraCreateTaskProfile({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: 'create_task_crash', kernel, journal,
      admission: { resolve: () => { throw new Error('no-current-source'); }, isCurrent: () => false } });
    const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'create_task_crash',
      adapters: [tasks.adapter], limits: { leaseMs: 500, kernelSlots: 1, modelSlots: 0 } });
    tasks.attach(scheduler);
    try {
      scheduler.acquire(); const recovered = tasks.synchronize(crash.taskId);
      expect(recovered).toMatchObject({ status: 'completed', nativeCompletionCertified: false, certificate: { effect: 'applied' },
        message: { interactionId: 'crash_interaction', predecessorMessageId: 'crash_message', delivery: stage === 'after-ack' ? 'acknowledged' : 'pending' } });
      const ack = tasks.acknowledgeMessage(crash.taskId, recovered.message!.certificateDigest);
      expect(tasks.acknowledgeMessage(crash.taskId, recovered.message!.certificateDigest)).toEqual(ack);
      await scheduler.drain(); expect(gateway).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
      expect(await readFile(path.join(root, 'crashed.txt'), 'utf8')).toBe('OWNED CAUSAL ARTIFACT\n');
    } finally { await scheduler.close(); journal.close(); gateway.mockRestore(); receipt.mockRestore(); }
  }, 20000);
});

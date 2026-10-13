// Opt-in real prepared-model + typed Astra draft probe. Synthetic data ONLY.
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, writeFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { AstraJournal } from '../src/agent-v3/journal.ts';
import { AstraPreparedModelClient } from '../src/agent-v3/prepared-model-client.ts';
import { AstraModelCreateTaskProfile } from '../src/agent-v3/model-create-task-profile.ts';
import { AstraWorkScheduler } from '../src/agent-v3/work-scheduler.ts';
import { AstraSourceGoalCompiler } from '../src/app/astra-source-goal-compiler.ts';
import { MonarchKernel } from '../src/core/kernel.ts';
import { WorkspaceModule } from '../src/modules/workspace/index.ts';
import { isolatedLocalSecurity } from '../tests/fixtures/agent-v3/local-security.ts';
import { oscarAstraNativeRequest } from '../src/ui/public/modules/oscar-astra-native.js';

if (!process.argv.includes('--real-local-model')) throw Error('Explicit --real-local-model required');
const repo = process.cwd(), parent = await realpath('.test-tmp');
if (parent.toLowerCase() !== 'd:\\monarch-test-tmp-astra-v3') throw Error('fixture-parent');
const ordinaryHttp = process.argv.includes('--ordinary-http');
const root = await mkdtemp(path.join(parent, ordinaryHttp ? 'astra-v3-oscar-recovery-' : 'agent-recovery-draft-'));
await writeFile(path.join(root, '.owner'), 'monarch-synthetic-draft-v1', { flag: 'wx' });
if (path.dirname(await realpath(root)) !== parent) throw Error('fixture-realpath');
const source = 'Project ORBIT: 7 tasks completed. 2 tasks pending. Next step: review the two pending tasks.\n';
await writeFile(path.join(root, 'notes.txt'), source, { flag: 'wx' });
console.log('Synthetic artifacts: ' + root);
const child = spawn(path.join(repo, 'oscar/.venv/Scripts/python.exe'), ['-B',
  path.join(repo, 'tests/fixtures/agent-v3/recovery-prepared-server.py'), root],
{ cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
  TEMP: root, TMP: root, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' } });
child.stdin.end();
let stderr = '', scheduler, kernel, journal;
child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', error => resolve(String(error))); });
const deadline = setTimeout(() => child.kill(), 240000);
const report = { scope: 'synthetic-typed-Astra-profile', nativePicker: false, installed: false,
  ordinaryHttpAdmission: false, calls: [], accepted: false };
try {
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const first = await lines.next();
  if (first.done) throw Error('prepared-server-startup:' + stderr);
  const host = JSON.parse(first.value);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(host.endpoint)) throw Error('loopback-host');
  if (ordinaryHttp) {
    const { runRecoveryDraftHttp } = await import('./agent-recovery-draft-http.mjs');
    Object.assign(report, await runRecoveryDraftHttp(root, host, source));
    if (!report.accepted) process.exitCode = 1;
  } else {
  const headers = { Authorization: 'Bearer synthetic-draft-recovery' };
  const transport = async (url, init) => {
    if (!String(url).startsWith(host.endpoint + '/')) throw Error('external-network-forbidden');
    if (String(url).endsWith('/prepare')) report.preparedSurface = JSON.parse(String(init.body)).surface;
    return fetch(url, init);
  };
  journal = new AstraJournal(path.join(root, 'journal.sqlite'));
  kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
  kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] }));
  kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
  const dispatch = kernel.executeActionProposal.bind(kernel);
  kernel.executeActionProposal = async (...args) => {
    const proposal = args[0], index = report.calls.length;
    report.calls.push(proposal);
    const expected = index === 0 ? 'notes.txt' : 'summary.txt';
    if (index > 2 || proposal.capabilityId !== (index === 0 ? 'workspace.files.read' : 'workspace.files.write')
      || proposal.args.path !== path.join(root, expected)
      || (index > 0 && (proposal.args.overwrite !== false || typeof proposal.args.content !== 'string'
        || Buffer.byteLength(proposal.args.content) > 4096))) throw Error('unexpected-kernel-dispatch');
    return dispatch(...args);
  };
  const destination = { key: 'output', selectionId: 'destination', targetId: 'result', label: 'summary.txt', access: 'exclusive-create' };
  const input = { key: 'input', selectionId: 'source', targetId: 'notes', label: 'notes.txt', access: 'observe' };
  const text = 'Составь краткое резюме прикреплённого материала на русском языке и сохрани в выбранный новый файл. Укажи, сколько задач выполнено, сколько осталось и следующий шаг.';
  const request = oscarAstraNativeRequest({ conversationId: 'conversation', target: destination,
    references: [input], localAnalysis: true, referenceInputs: true, mode: 'draft' }, text,
  { clientRequestId: 'request', inputMessageId: 'message' });
  const actor = { id: 'sha256:' + 'a'.repeat(64), source: 'api' };
  const compiler = new AstraSourceGoalCompiler({ resolve: selectionId => {
    if (!['destination', 'source'].includes(selectionId)) throw Error('foreign-selection');
    return { selectionId, actor, conversationId: 'conversation', revision: 1, targets: [selectionId === 'source'
      ? { id: 'notes', relativePath: 'notes.txt', access: 'observe', maxBytes: 4096, timeoutMs: 5000 }
      : { id: 'result', relativePath: 'summary.txt', access: 'exclusive-create', maxBytes: 4096, timeoutMs: 5000 }] };
  } });
  const compiled = compiler.create(request.astra.selectionId, { actor, conversationId: request.conversationId,
    inputMessageId: request.inputMessageId, text, goal: request.astra.goal });
  const { kind, ...selected } = compiled;
  if (kind !== 'draft') throw Error('wrong-composer-route');
  const tasks = new AstraModelCreateTaskProfile({ deployment: 'isolated-validation', canonicalRoot: root,
    scopeId: 'recovery_draft', journal, kernel, exactApprovals: true, referenceInputs: true,
    client: new AstraPreparedModelClient({ deployment: 'isolated-validation', ...host,
      bearerToken: 'synthetic-draft-recovery', timeoutMs: 65000, fetch: transport }),
    policy: { expectedModelDigest: host.modelDigest, maxOutputTokens: 512, modelTimeoutMs: 60000,
      maxModelAttempts: 1, contextLimits: { tokenizerTimeoutMs: 5000 } },
    admission: { resolve: value => {
      if (value.interactionId !== 'interaction' || value.messageId !== 'message') throw Error('foreign-source');
      return { ...selected, userText: text };
    }, isCurrent: () => true } });
  scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId: 'recovery_draft', journal,
    adapters: tasks.adapters, limits: { activationTimeoutMs: 30000, kernelSlots: 1 } });
  tasks.attach(scheduler); scheduler.acquire();
  const initial = tasks.submit({ requestId: 'request', source: { interactionId: 'interaction', messageId: 'message' } });
  await tasks.drain();
  const pending = tasks.read(initial.taskId); report.pending = pending;
  const readOutput = () => readFile(path.join(root, 'summary.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  report.outputBeforeApproval = await readOutput();
  if (report.outputBeforeApproval !== null) throw Error('write-before-approval');
  if (pending.status === 'awaiting-approval') {
    const approval = pending.approval;
    tasks.decide(initial.taskId, { approvalId: approval.id, approvalDigest: approval.digest,
      messageId: 'synthetic-owner-approval', decision: 'approve' });
    await tasks.drain();
  }
  report.task = tasks.read(initial.taskId);
  report.output = await readOutput();
  report.sourceUnchanged = await readFile(path.join(root, 'notes.txt'), 'utf8') === source;
  report.metrics = await (await transport(host.endpoint + '/metrics', { headers, signal: AbortSignal.timeout(3000) })).json();
  report.semanticCheck = typeof report.output === 'string' && /[а-яё]/iu.test(report.output)
    && /7/u.test(report.output) && /2/u.test(report.output) && /ORBIT/iu.test(report.output);
  report.accepted = pending.status === 'awaiting-approval' && report.task.certificate?.effect === 'applied'
    && report.sourceUnchanged && report.semanticCheck && report.calls.length === 3
    && report.metrics.calls === 1 && report.metrics.mock === false && report.metrics.fallback === false
    && report.metrics.tier === 'gemma4-fast' && report.metrics.slotReserved === false;
  if (!report.accepted) process.exitCode = 1;
  }
} catch (error) { report.failure = String(error); process.exitCode = 1; }
finally {
  await scheduler?.close(); await kernel?.stop(); journal?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await exited; clearTimeout(deadline);
  report.stderr = stderr;
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ root, accepted: report.accepted, failure: report.failure,
    status: report.task?.status, metrics: report.metrics, output: report.output }));
}

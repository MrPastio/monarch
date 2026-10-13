import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { MonarchKernel } from '../../../src/core/kernel';
import { WorkspaceModule } from '../../../src/modules/workspace';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { AstraCreateTaskProfile } from '../../../src/agent-v3/create-task-profile';
import { astraCreateValueDigest } from '../../../src/agent-v3/create-task-certifier';
import { isolatedLocalSecurity } from './local-security';

const directory = process.argv[2], stage = process.argv[3];
if (!directory || !['after-effect', 'after-certificate', 'after-ack', 'approval-waiting', 'approval-answered', 'approval-effect', 'approval-certified'].includes(stage ?? '')) throw new Error('fixture-arguments');
const exactApprovals = stage!.startsWith('approval-');
const parent = await realpath('.test-tmp'), root = await realpath(directory), fixture = path.dirname(root);
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(fixture) !== parent
  || !path.basename(fixture).startsWith('astra-v3-create-task-') || !/^crash_[0-9]+$/u.test(path.basename(root))
  || (await lstat(directory)).isSymbolicLink()
  || await readFile(path.join(fixture, '.fixture-marker'), 'utf8') !== 'astra-v3-create-task-owned-synthetic-only') throw new Error('fixture-scope');
let helperCalls = 0;
const deny = (): never => { helperCalls++; throw new Error('owned-fixture-helper-forbidden'); };
childProcess.execFileSync = deny; childProcess.execSync = deny; childProcess.spawnSync = deny;
childProcess.execFile = Object.assign(deny, { __promisify__: deny });
childProcess.exec = Object.assign(deny, { __promisify__: deny }); childProcess.spawn = deny; syncBuiltinESMExports();
const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
  permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] });
kernel.registerModule(workspace); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
const journal = new AstraJournal(path.join(root, 'tasks.sqlite'));
const source = { interactionId: 'crash_interaction', messageId: 'crash_message' };
const selection = { authority: 'exclusive-create' as const, revision: 1, digest: astraCreateValueDigest('owned-crash-selection'),
  basename: exactApprovals ? 'Новый отчёт.txt' : 'crashed.txt', content: 'OWNED CAUSAL ARTIFACT\n', userText: exactApprovals
    ? 'Обработай выбранную цель согласно явно заданному действию.' : 'Create the synthetic file crashed.txt with the explicitly selected content.' };
const tasks = new AstraCreateTaskProfile({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: 'create_task_crash', kernel, journal,
  exactApprovals,
  admission: { resolve: key => {
    if (key.interactionId !== source.interactionId || key.messageId !== source.messageId) throw new Error('wrong-source');
    return structuredClone(selection);
  }, isCurrent: key => key.interactionId === source.interactionId && key.messageId === source.messageId
    && key.revision === selection.revision && key.digest === selection.digest } });
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'create_task_crash',
  adapters: [tasks.adapter], limits: { leaseMs: 500, kernelSlots: 1, modelSlots: 0 } });
tasks.attach(scheduler); scheduler.acquire();
let workspaceCalls = 0;
const actual = workspace.executeCapability.bind(workspace);
workspace.executeCapability = async (...args) => { workspaceCalls++; return actual(...args); };
const task = tasks.submit({ requestId: 'owned_task_crash', source }); await scheduler.drain();
if (exactApprovals) {
  const waiting = tasks.read(task.taskId);
  if (waiting.status !== 'awaiting-approval' || !waiting.approval || workspaceCalls !== 0) throw Error('wrong-approval-frontier');
  if (stage !== 'approval-waiting') {
    if (stage === 'approval-answered') scheduler.command = () => { throw Error('owned-crash-before-wake'); };
    try { tasks.decide(task.taskId, { approvalId: waiting.approval.id, approvalDigest: waiting.approval.digest, messageId: 'crash_approval_message', decision: 'approve' }); }
    catch (error) { if (!(stage === 'approval-answered' && error instanceof Error && error.message === 'owned-crash-before-wake')) throw error; }
    if (stage !== 'approval-answered') await scheduler.drain();
    if (stage === 'approval-certified') tasks.synchronize(task.taskId);
  }
} else if (stage !== 'after-effect') tasks.synchronize(task.taskId);
if (stage === 'after-ack') tasks.acknowledgeMessage(task.taskId, tasks.read(task.taskId).message!.certificateDigest);
const view = tasks.read(task.taskId);
const waiting = stage === 'approval-waiting' || stage === 'approval-answered';
const expectedStatus = waiting ? 'awaiting-approval' : ['after-effect', 'approval-effect'].includes(stage!) ? 'awaiting-certification' : 'completed';
if (workspaceCalls !== (waiting ? 0 : 1) || helperCalls !== 0 || view.status !== expectedStatus) throw new Error('wrong-crash-frontier');
process.stdout.write(JSON.stringify({ stage, taskId: task.taskId, workspaceCalls, helperCalls, status: view.status,
  delivery: view.message?.delivery ?? null }), () => process.exit(64));

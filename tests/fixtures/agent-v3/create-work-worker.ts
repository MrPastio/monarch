import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { MonarchKernel } from '../../../src/core/kernel';
import { WorkspaceModule } from '../../../src/modules/workspace';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraCreateWorkAdapter } from '../../../src/agent-v3/create-work-adapter';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { isolatedLocalSecurity } from './local-security';

// Real OS process termination at two real Kernel boundaries. Only an exact
// marked child on D: is admitted; no production config, model, helper or network.
const directory = process.argv[2], stage = process.argv[3];
if (!directory || !['before-ledger', 'after-ledger'].includes(stage ?? '')) throw new Error('fixture-arguments');
const parent = await realpath('.test-tmp'), root = await realpath(directory), fixture = path.dirname(root);
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(fixture) !== parent
  || !path.basename(fixture).startsWith('astra-v3-create-') || !/^crash_[0-9]+$/u.test(path.basename(root))
  || (await lstat(directory)).isSymbolicLink()
  || await readFile(path.join(fixture, '.fixture-marker'), 'utf8') !== 'astra-v3-create-owned-kernel-effects-only') throw new Error('fixture-scope');
let helperCalls = 0;
const denyHelper = (): never => { helperCalls++; throw new Error('owned-fixture-helper-forbidden'); };
childProcess.execFileSync = denyHelper; childProcess.execSync = denyHelper; childProcess.spawnSync = denyHelper;
childProcess.execFile = Object.assign(denyHelper, { __promisify__: denyHelper });
childProcess.exec = Object.assign(denyHelper, { __promisify__: denyHelper }); childProcess.spawn = denyHelper;
syncBuiltinESMExports();
const source = { interactionId: 'synthetic_crash', messageId: 'synthetic_crash_message', revision: 1,
  userText: 'Create the synthetic file crashed.txt with the explicitly selected content.' };
const content = 'OWNED CRASH ARTIFACT\n';
const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: path.join(root, 'owned-agency'),
  permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] });
kernel.registerModule(workspace); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
const journal = new AstraJournal(path.join(root, 'owned.sqlite'));
const adapter = new AstraCreateWorkAdapter({ deployment: 'isolated-validation', canonicalRoot: root, kernel, journal,
  isSourceCurrent: input => input.basename === 'crashed.txt' && input.content === content
    && JSON.stringify(input.source) === JSON.stringify(source) });
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: 'create_crash',
  adapters: [adapter], limits: { leaseMs: 500 } });
scheduler.acquire();
let workspaceCalls = 0;
const actual = workspace.executeCapability.bind(workspace);
workspace.executeCapability = async (...args) => { workspaceCalls++; return actual(...args); };
const job = scheduler.submit({ requestId: 'owned_crash', adapterId: adapter.id,
  input: { basename: 'crashed.txt', content, source } });
const crash = async (): Promise<never> => {
  const checkpoint = adapter.inspect(job.input).checkpoint;
  const receipt = kernel.getActionLedgerRecord(checkpoint.invocation!.idempotencyKey);
  const report = { stage, jobId: job.id, workspaceCalls, phase: checkpoint.phase, effect: checkpoint.effect,
    ledgerStatus: receipt?.status, idempotencyKey: checkpoint.invocation!.idempotencyKey, helperCalls,
    error: receipt?.result?.error };
  return new Promise<never>((_resolve, reject) => {
    process.stdout.write(JSON.stringify(report), error => { if (error) reject(error); else process.exit(stage === 'after-ledger' ? 62 : 63); });
  });
};
kernel.subscribeEvent(stage === 'after-ledger' ? 'capability.execution.finished' : 'workspace.file.written', async event => {
  if (stage === 'after-ledger' && (event.payload as { moduleId?: string }).moduleId !== 'workspace') return;
  await crash();
});
await scheduler.drain();
throw new Error('expected-owned-crash-boundary-not-reached:' + JSON.stringify({ job: scheduler.job(job.id),
  audit: kernel.getSnapshot().audit.slice(-3) }));

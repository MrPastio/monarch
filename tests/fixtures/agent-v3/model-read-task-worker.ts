// Deliberate process exits at joined Goal boundaries. Exact synthetic fixture,
// actual shared ModelHost/Kernel/SQLite; no V2 route or product data discovery.
import { writeSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { AstraModelReadTaskProfile } from '../../../src/agent-v3/model-read-task-profile';
import { modelReadDigest } from '../../../src/agent-v3/model-read-task-state';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { MonarchKernel } from '../../../src/core/kernel';
import { WorkspaceModule } from '../../../src/modules/workspace';

const [fixtureArg, file, scopeId, stage, endpoint, hostGeneration, modelDigest] = process.argv.slice(2);
const fixture = await realpath(fixtureArg!), parent = await realpath('.test-tmp');
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(fixture) !== parent
  || !path.basename(fixture).startsWith('astra-v3-prepared-model-')
  || (await readFile(path.join(fixture, '.fixture-marker'), 'utf8')) !== 'astra-v3-prepared-model-synthetic-only'
  || !/^joined-crash-[a-zA-Z0-9_-]+\.sqlite$/u.test(file ?? '') || !/^[A-Za-z0-9_-]{1,96}$/u.test(scopeId ?? '')
  || !['model-result', 'read-result', 'certified', 'between-reads'].includes(stage ?? '')) throw Error('owned-crash-scope');
const root = await realpath(path.join(fixture, 'workspace')); if (path.dirname(root) !== fixture) throw Error('owned-workspace-scope');
const journal = new AstraJournal(path.join(fixture, file!));
const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
  permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] })); await kernel.start();
let dispatches = 0; const execute = kernel.executeActionProposal.bind(kernel);
kernel.executeActionProposal = (...args) => { dispatches++; return execute(...args); };
const tasks = new AstraModelReadTaskProfile({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: scopeId!, kernel, journal,
  client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: endpoint!, hostGeneration: hostGeneration!,
    bearerToken: 'astra-synthetic-test', timeoutMs: 10000 }),
  policy: { expectedModelDigest: modelDigest!, modelTimeoutMs: 5000, contextLimits: { tokenizerTimeoutMs: 1000 } },
  admission: { resolve: source => {
    if (source.interactionId !== 'joined_interaction' || source.messageId !== 'joined_message') throw Error('unknown-owned-source');
    return { authority: 'observe', revision: 1, digest: modelReadDigest('synthetic-owner-source'),
      userText: 'Read the explicitly selected synthetic files, then report observed byte counts.',
      requirements: stage === 'between-reads'
        ? [{ id: 'first', relativePath: 'synthetic.txt', maxBytes: 8192 },
          { id: 'second', relativePath: 'second.txt', maxBytes: 512, dependsOn: ['first'] }]
        : [{ id: 'first', relativePath: 'synthetic.txt', maxBytes: 8192 }],
      ...(stage === 'between-reads' ? { answerMode: 'grounded-model' as const } : {}) };
  }, isCurrent: () => true } });
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: scopeId!, adapters: tasks.adapters,
  limits: { activationTimeoutMs: 5000, leaseMs: 1000 } }); tasks.attach(scheduler); scheduler.acquire();
const task = tasks.submit({ requestId: 'joined_task', source: { interactionId: 'joined_interaction', messageId: 'joined_message' } });
await scheduler.drain();
if (!['model-result', 'between-reads'].includes(stage!)) { tasks.synchronize(task.taskId); await scheduler.drain(); }
if (stage === 'certified') tasks.synchronize(task.taskId);
const view = tasks.read(task.taskId);
if (stage === 'certified' ? view.status !== 'completed' : view.status !== 'awaiting-progression') throw Error('crash-stage-not-reached');
writeSync(1, JSON.stringify({ marker: 'owned-joined-goal-crash', taskId: task.taskId, stage, dispatches, phase: view.phase }) + '\n');
process.exit(65); // No Store close or scheduler finalizer; parent proves recovery.

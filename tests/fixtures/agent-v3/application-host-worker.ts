// Actual disposable controller exit66 after durable Application source/model/
// outbox boundaries. No normal app bootstrap, V2, product data or default model.
import { createHmac } from 'node:crypto';
import { writeSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { modelReadDigest } from '../../../src/agent-v3/model-read-task-state';
import { MonarchAstraReadTaskFacade } from '../../../src/app/astra-read-task-facade';
import { MonarchKernel } from '../../../src/core/kernel';
import { WorkspaceModule } from '../../../src/modules/workspace';

const [fixtureArg, file, scopeId, stage, endpoint, hostGeneration, modelDigest] = process.argv.slice(2);
const parent = await realpath('.test-tmp'), fixture = await realpath(fixtureArg!);
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(fixture) !== parent
  || !path.basename(fixture).startsWith('astra-v3-prepared-model-')
  || await readFile(path.join(fixture, '.fixture-marker'), 'utf8') !== 'astra-v3-prepared-model-synthetic-only'
  || !/^http-crash-[A-Za-z0-9_-]+\.sqlite$/u.test(file ?? '') || !/^[A-Za-z0-9_-]{1,96}$/u.test(scopeId ?? '')
  || !['admitted', 'model-result', 'certified'].includes(stage ?? '')) throw Error('owned-application-crash-scope');
const root = await realpath(path.join(fixture, 'workspace')); if (path.dirname(root) !== fixture) throw Error('owned-workspace-scope');
const journal = new AstraJournal(path.join(fixture, file!));
const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
  permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] })); await kernel.start();
let dispatches = 0, taskId = ''; const execute = kernel.executeActionProposal.bind(kernel);
kernel.executeActionProposal = (...args) => { dispatches++; return execute(...args); };
const facade = new MonarchAstraReadTaskFacade({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: scopeId!, journal, kernel,
  client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: endpoint!, hostGeneration: hostGeneration!,
    bearerToken: 'astra-synthetic-test', timeoutMs: 10000 }),
  policy: { expectedModelDigest: modelDigest!, modelTimeoutMs: 5000, contextLimits: { tokenizerTimeoutMs: 1000 } },
  catalog: { resolve: id => {
    if (id !== 'selection_first') throw Error('unknown-worker-selection');
    return { authority: 'observe', revision: 1, digest: modelReadDigest('fixture-selection'),
      requirements: [{ id: 'first', relativePath: 'synthetic.txt', maxBytes: 8192 }] };
  } } });
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: scopeId!, adapters: facade.adapters,
  limits: { activationTimeoutMs: 5000, leaseMs: 1000 } }); facade.attach(scheduler); facade.start();
const append = journal.appendAtomic.bind(journal);
journal.appendAtomic = (input, guard) => {
  const result = append(input, guard), members = [input.primary, ...(input.additional ?? [])];
  const source = members.find(item => item.events.some(event => (event as { type?: string }).type === 'application.source-admitted'));
  if (source) taskId = (source.checkpoint as { taskId: string }).taskId;
  const boundary = stage === 'admitted' ? !!source : stage === 'certified'
    ? members.some(item => item.events.some(event => (event as { type?: string }).type === 'task.certified'))
    : members.some(item => (item.checkpoint as { schemaVersion?: string; phase?: string })?.schemaVersion === 'monarch.astra-v3-model-work.internal.v1'
      && (item.checkpoint as { phase?: string }).phase === 'returned');
  if (boundary) {
    writeSync(1, JSON.stringify({ marker: 'owned-application-host-crash', taskId, stage, dispatches }) + '\n');
    process.exit(66); // No graceful host stop or Store close.
  }
  return result;
};
facade.submit({ source: 'api', id: 'sha256:' + createHmac('sha256', 'owned-astra-http-fixture-api')
  .update('monarch.astra-v3.http-actor.v1/api').digest('hex') },
{ version: 1, clientRequestId: 'request_first', conversationId: 'conversation_first', inputMessageId: 'message_first',
  text: 'Read the selected synthetic file and report observed byte count.', selectionId: 'selection_first', privacyMode: 'persistent' });
await facade.drain(); throw Error('crash-boundary-not-reached');

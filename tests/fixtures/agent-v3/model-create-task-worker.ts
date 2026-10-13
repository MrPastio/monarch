// Disposable real process exits after durable model/effect/result writes. No
// normal Application bootstrap, user data, default model or external network.
import { writeSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { AstraModelCreateTaskProfile } from '../../../src/agent-v3/model-create-task-profile';
import { modelReadDigest } from '../../../src/agent-v3/model-read-task-state';
import { MonarchKernel } from '../../../src/core/kernel';
import { WorkspaceModule } from '../../../src/modules/workspace';
import { isolatedLocalSecurity } from './local-security';
import { astraDraftContentFingerprint } from '../../../src/agent-v3/draft-content-acceptance';

const [fixtureArg, workspaceName, scopeId, stage, endpoint, hostGeneration, modelDigest, constraintMode] = process.argv.slice(2);
const parent = await realpath('.test-tmp'), fixture = await realpath(fixtureArg!);
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(fixture) !== parent
  || !path.basename(fixture).startsWith('astra-v3-prepared-model-')
  || await readFile(path.join(fixture, '.fixture-marker'), 'utf8') !== 'astra-v3-prepared-model-synthetic-only'
  || !/^workspace_[0-9]+$/u.test(workspaceName ?? '') || !/^[A-Za-z0-9_-]{1,96}$/u.test(scopeId ?? '')
  || !['model-result', 'create-result', 'effect-unrecorded', 'certified', 'reference-read', 'reference-linked', 'reference-approval'].includes(stage ?? '')
  || !['draft', 'exact', 'reference'].includes(constraintMode ?? '')) throw Error('owned-draft-crash-scope');
const root = await realpath(path.join(fixture, workspaceName!)); if (path.dirname(root) !== fixture) throw Error('owned-draft-root');
const journal = new AstraJournal(path.join(root, 'owned.sqlite'));
const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
  permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] }));
kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
let dispatches = 0, taskId = ''; const execute = kernel.executeActionProposal.bind(kernel);
kernel.executeActionProposal = (...args) => { dispatches++; return execute(...args); };
const tasks = new AstraModelCreateTaskProfile({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: scopeId!, journal, kernel,
  ...(constraintMode === 'reference' ? { referenceInputs: true, exactApprovals: true } : {}),
  client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: endpoint!, hostGeneration: hostGeneration!,
    bearerToken: 'astra-synthetic-test', timeoutMs: 10000 }),
  policy: { expectedModelDigest: modelDigest!, maxOutputTokens: 1024, modelTimeoutMs: 5000, contextLimits: { tokenizerTimeoutMs: 1000 } },
  admission: { resolve: source => {
    if (source.interactionId !== 'draft_interaction' || source.messageId !== 'draft_message') throw Error('owned-draft-source');
    return { authority: 'exclusive-create', revision: 1, digest: modelReadDigest('owned-draft-source'),
      userText: 'Create the new synthetic file draft.txt containing the model-drafted text.', basename: 'draft.txt', maxBytes: 8192, timeoutMs: 5000,
      ...(constraintMode === 'reference' ? { references: [{ id: 'material', relativePath: 'material.txt', maxBytes: 4096, timeoutMs: 1000, dependsOn: [] }] } : {}),
      ...(constraintMode === 'exact' ? { contentRequirement: { kind: 'exact-utf8' as const, ...astraDraftContentFingerprint('Hello, Astra!') } } : {}) };
  }, isCurrent: () => true } });
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', journal, scopeId: scopeId!, adapters: tasks.adapters,
  limits: { activationTimeoutMs: 5000, leaseMs: 1000, kernelSlots: 1 } }); tasks.attach(scheduler); scheduler.acquire();
const append = journal.appendAtomic.bind(journal);
journal.appendAtomic = (input, guard) => {
  if (stage === 'effect-unrecorded' && [input.primary, ...(input.additional ?? [])].some(item => {
    const cp = item.checkpoint as { schemaVersion?: string; phase?: string; effect?: string };
    return cp?.schemaVersion === 'monarch.astra-v3-create-work.internal.v1' && cp.phase === 'settled' && cp.effect === 'applied';
  })) {
    // The real write happened, but the durable family receipt has not. This
    // fixture intentionally has no persistent Kernel ledger; restart must retain
    // unknown, not infer success from file existence or repeat the write.
    writeSync(1, JSON.stringify({ marker: 'owned-draft-task-crash', taskId, stage, dispatches }) + '\n'); process.exit(67);
  }
  const result = append(input, guard), members = [input.primary, ...(input.additional ?? [])];
  const admitted = members.find(item => item.events.some(event => (event as { type?: string }).type === 'draft.admitted'));
  if (admitted) taskId = (admitted.checkpoint as { taskId: string }).taskId;
  const boundary = stage === 'certified' ? members.some(item => item.events.some(event => (event as { type?: string }).type === 'draft.certified'))
    : stage === 'reference-linked' ? members.some(item => item.events.some(event => (event as { type?: string }).type === 'draft.references-linked'))
    : members.some(item => { const cp = item.checkpoint as { schemaVersion?: string; phase?: string; effect?: string };
      return stage === 'reference-read' ? cp?.schemaVersion === 'monarch.astra-v3-read-workflow.internal.v1' && cp.phase === 'observed'
        : stage === 'reference-approval' ? cp?.schemaVersion === 'monarch.astra-v3-create-work.internal.v1' && cp.phase === 'awaiting-approval'
        : stage === 'model-result' ? cp?.schemaVersion === 'monarch.astra-v3-model-work.internal.v1' && cp.phase === 'returned'
        : cp?.schemaVersion === 'monarch.astra-v3-create-work.internal.v1' && cp.phase === 'settled' && cp.effect === 'applied'; });
  if (boundary) { writeSync(1, JSON.stringify({ marker: 'owned-draft-task-crash', taskId, stage, dispatches }) + '\n'); process.exit(67); }
  return result;
};
tasks.submit({ requestId: 'draft_request', source: { interactionId: 'draft_interaction', messageId: 'draft_message' } });
await tasks.drain(); throw Error('draft-crash-boundary-not-reached');

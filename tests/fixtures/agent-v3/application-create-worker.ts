// Actual HTTP admission, then exit68 at an exact durable boundary. Disposable
// D-backed synthetic workspace only; no ordinary Application/bootstrap/config.
import { writeSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { MonarchAstraTaskFacade } from '../../../src/app/astra-task-facade';
import { createMonarchHttpServer } from '../../../src/app/http-server';
import type { MonarchApplication } from '../../../src/app/application';
import { MonarchKernel } from '../../../src/core/kernel';
import { WorkspaceModule } from '../../../src/modules/workspace';
import { isolatedLocalSecurity } from './local-security';
import { createSelection, readSelection, fixtureRequest, draftContent, type FixtureTaskKind } from './application-create-contract';
import type { AstraTaskHttpTask } from '../../../src/app/astra-task-facade';
import { AstraSourceGoalCompiler } from '../../../src/app/astra-source-goal-compiler';
import { compiledFixtureRequest, compiledFixtureTargets, compiledFixtureContent, type CompiledFixtureKind } from './application-source-contract';
import { approvalFixtureRequest, approvalFixtureTargets, type ApprovalFixtureKind } from './application-approval-contract';
const [fixtureArg, workspaceName, scopeId, kind, stage, endpoint, hostGeneration, modelDigest] = process.argv.slice(2);
const parent = await realpath('.test-tmp'), fixture = await realpath(fixtureArg!);
if (path.parse(parent).root.toUpperCase() !== 'D:\\' || path.dirname(fixture) !== parent
  || !path.basename(fixture).startsWith('astra-v3-prepared-model-')
  || await readFile(path.join(fixture, '.fixture-marker'), 'utf8') !== 'astra-v3-prepared-model-synthetic-only'
  || !/^workspace_[0-9]+$/u.test(workspaceName ?? '') || !/^[A-Za-z0-9_-]{1,96}$/u.test(scopeId ?? '')
  || !['literal', 'constrained', 'required', 'literal-input', 'compiled-read', 'compiled-literal', 'compiled-reply', 'approval-reply', 'approval-draft'].includes(kind ?? '')
  || !['admitted', 'model-result', 'certified', 'question', 'input-result', 'reply-admitted', 'reply-model-result', 'reply-certified', 'effect-unrecorded', 'effect-recorded',
    'approval-pending', 'approval-answered', 'approval-effect', 'approval-certified', 'approval-unrecorded'].includes(stage ?? '')) throw Error('owned-create-http-crash-scope');
const root = await realpath(path.join(fixture, workspaceName!)); if (path.dirname(root) !== fixture) throw Error('owned-create-http-crash-root');
const journal = new AstraJournal(path.join(root, 'owned-http.sqlite'));
const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
  permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
kernel.registerModule(new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] })); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
let calls = 0, dispatches = 0, taskId = '', openings = 0;
const approval = kind!.startsWith('approval-'), compiled = kind!.startsWith('compiled-') || approval;
const questionScenario = kind === 'required' || kind === 'literal-input' || kind === 'compiled-reply' || kind === 'approval-reply' || stage === 'question' || stage!.startsWith('reply-');
const execute = kernel.executeActionProposal.bind(kernel);
kernel.executeActionProposal = async (...args) => { dispatches++; const result = await execute(...args);
  if (stage === 'effect-unrecorded' || stage === 'approval-unrecorded' && result.result.ok) { writeSync(1, JSON.stringify({ marker: 'owned-create-http-crash', taskId, calls, dispatches }) + '\n'); process.exit(68); }
  return result; };
const facade = new MonarchAstraTaskFacade({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: scopeId!, journal, kernel,
  requiredInputs: kind === 'required' || kind === 'literal-input' || compiled,
  compositeApprovals: approval,
  ...(compiled ? { sourceCompiler: new AstraSourceGoalCompiler({ resolve: approval ? approvalFixtureTargets : compiledFixtureTargets }) }
    : { catalog: { resolve: readSelection }, createCatalog: { resolve: createSelection } }),
  client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: endpoint!, hostGeneration: hostGeneration!,
    bearerToken: 'astra-synthetic-test', timeoutMs: 10000, fetch: async (url, init) => {
      calls++; if (kind === 'literal' || kind === 'literal-input' || compiled && kind !== 'approval-draft') throw Error('literal-model-call-forbidden');
      if ((questionScenario || approval) && String(url).endsWith('/model-turns') && init?.method === 'POST') {
        const first = openings++ === 0;
        const output = kind !== 'required' && !approval && first ? { kind: 'ask-user', question: 'What should the file contain?' }
          : { kind: 'create', requirementId: 'draft_file', capabilityHandle: 'create_file', targetHandle: 'selected_file', content: approval ? compiledFixtureContent : draftContent };
        const configured = await fetch(endpoint + '/__fixture/control', { method: 'POST',
          headers: { Authorization: 'Bearer astra-synthetic-test', 'Content-Type': 'application/json' },
          body: JSON.stringify({ output: JSON.stringify(output), finish: 'stop', block: false }) });
        if (!configured.ok) throw Error('owned-question-fixture-control');
      }
      return fetch(url, init);
    } }),
  policy: { expectedModelDigest: modelDigest!, maxOutputTokens: 256, modelTimeoutMs: 5000, contextLimits: { tokenizerTimeoutMs: 1000 } } });
const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId: scopeId!, journal, adapters: facade.adapters,
  limits: { activationTimeoutMs: 5000, leaseMs: 1000, kernelSlots: 1 } }); facade.attach(scheduler); facade.start(); await facade.drain();
const append = journal.appendAtomic.bind(journal);
journal.appendAtomic = (input, guard) => {
  const result = append(input, guard), members = [input.primary, ...(input.additional ?? [])];
  const source = members.find(item => item.events.some(event => (event as { type?: string }).type === 'application.source-admitted'));
  if (source) taskId = (source.checkpoint as { taskId: string }).taskId;
  const crash = stage === 'approval-pending' ? members.some(item => (item.checkpoint as { phase?: string })?.phase === 'awaiting-approval')
    : stage === 'approval-answered' ? members.some(item => item.events.some(event => (event as { type?: string }).type === 'application.approval-bound'))
    : stage === 'admitted' ? !!source
    : stage === 'input-result' ? members.some(item => { const cp = item.checkpoint as { schemaVersion?: string; status?: string };
      return cp?.schemaVersion === 'monarch.astra-v3-required-input-work.internal.v1' && cp.status === 'issued'; })
    : stage === 'question' ? members.some(item => item.events.some(event => (event as { type?: string }).type === 'draft.question-pending'))
    : stage === 'reply-admitted' ? members.some(item => item.events.some(event => ['draft.reply-admitted', 'draft.literal-reply-admitted'].includes((event as { type?: string }).type ?? '')))
    : stage === 'effect-recorded' || stage === 'approval-effect' ? members.some(item => { const cp = item.checkpoint as { schemaVersion?: string; phase?: string; effect?: string };
      return cp?.schemaVersion === 'monarch.astra-v3-create-work.internal.v1' && cp.phase === 'settled' && cp.effect === 'applied'; })
    : stage === 'effect-unrecorded' || stage === 'approval-unrecorded' ? false
    : stage === 'model-result' || stage === 'reply-model-result' ? (stage !== 'reply-model-result' || openings === (kind === 'required' ? 1 : 2)) && members.some(item => {
    const cp = item.checkpoint as { schemaVersion?: string; phase?: string }; return cp?.schemaVersion === 'monarch.astra-v3-model-work.internal.v1' && cp.phase === 'returned';
  }) : members.some(item => item.streamId === taskId && (item.checkpoint as { phase?: string })?.phase === 'certified');
  if (crash) { writeSync(1, JSON.stringify({ marker: 'owned-create-http-crash', taskId, calls, dispatches }) + '\n'); process.exit(68); }
  return result;
};
const server = createMonarchHttpServer({ app: new Proxy({} as MonarchApplication, { get() { throw Error('ordinary-app-forbidden'); } }),
  publicDirectory: root, host: '127.0.0.1', port: 4317, apiToken: 'owned-create-api', desktopAttestationToken: 'owned-create-desktop',
  requireApiToken: true, allowNonLoopbackMutations: false, astraTasks: facade });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/astra/v3/' + (kind === 'compiled-read' ? 'read-tasks' : 'create-tasks');
const headers = { Authorization: 'Bearer owned-create-api', 'Content-Type': 'application/json' }, request = approval ? approvalFixtureRequest(kind as ApprovalFixtureKind)
  : compiled ? compiledFixtureRequest(kind as CompiledFixtureKind) : fixtureRequest(kind as FixtureTaskKind);
await fetch(base, { method: 'POST', headers, body: JSON.stringify(request) }); await facade.drain();
if (questionScenario) {
  const response = await fetch(base + '/' + taskId + '?' + new URLSearchParams({ conversationId: request.conversationId, inputMessageId: request.inputMessageId }), { headers });
  const task = (await response.json() as { task: AstraTaskHttpTask }).task;
  if (task.status !== 'awaiting-user' || !task.question) throw Error('owned-question-not-pending');
  if (stage === 'question') { writeSync(1, JSON.stringify({ marker: 'owned-create-http-crash', taskId, calls, dispatches }) + '\n'); process.exit(68); }
  await fetch(base + '/' + taskId + '/reply', { method: 'POST', headers, body: JSON.stringify({ version: 1,
    conversationId: request.conversationId, inputMessageId: request.inputMessageId, clientRequestId: 'reply_request',
    questionId: task.question.id, questionDigest: task.question.digest, replyMessageId: 'reply_message', text: compiled ? compiledFixtureContent : draftContent }) });
  await facade.drain();
}
if (approval) {
  const response = await fetch(base + '/' + taskId + '?' + new URLSearchParams({ conversationId: request.conversationId, inputMessageId: request.inputMessageId }), { headers });
  const task = (await response.json() as { task: AstraTaskHttpTask }).task;
  if (task.status !== 'awaiting-approval' || !task.approval) throw Error('owned-approval-not-pending');
  const decided = await fetch(base + '/' + taskId + '/decide', { method: 'POST', headers, body: JSON.stringify({ version: 1,
    conversationId: request.conversationId, inputMessageId: request.inputMessageId, approvalId: task.approval.id, approvalDigest: task.approval.digest,
    replyMessageId: 'approval_message', decision: 'approve' }) });
  if (!decided.ok) throw Error('owned-approval-not-accepted'); await facade.drain();
}
throw Error('owned-create-http-crash-not-reached');

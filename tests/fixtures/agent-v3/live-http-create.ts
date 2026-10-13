import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import type { MonarchApplication } from '../../../src/app/application';
import type { MonarchKernel } from '../../../src/core/kernel';
import type { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { MonarchAstraTaskFacade, type AstraTaskHttpTask } from '../../../src/app/astra-task-facade';
import { createMonarchHttpServer } from '../../../src/app/http-server';
import { fixtureRequest, readSelection, createSelection, literalContent, draftContent } from './application-create-contract';
import { astraDraftContentFingerprint } from '../../../src/agent-v3/draft-content-acceptance';
import { modelReadDigest } from '../../../src/agent-v3/model-read-task-state';
import { AstraSourceGoalCompiler } from '../../../src/app/astra-source-goal-compiler';

/** Only called AFTER the native harness's exact marked D-child preflight.
 * One real host/Kernel/scheduler; no product Application discovery or output repair. */
export async function runAstraNativeHttpCreate(options: {
  workspaceRoot: string; journal: AstraJournal; kernel: MonarchKernel; invocation: string; clarificationOnly?: boolean; requiredInput?: boolean; literalInput?: boolean; sourceGoal?: boolean;
  host: { endpoint: string; hostGeneration: string; modelDigest: string };
  kernelCalls: () => number;
  metrics: () => Promise<{ generationCalls: number; slotReserved: boolean; generationWorkerActive: boolean; rssBytes: number }>;
}) {
  let modelRequests = 0;
  const literalReply = ' \tПривет, Astra 🟠\r\ne\u0301\n';
  const apiToken = 'owned-native-unified-' + options.invocation;
  const sourceCompiler = options.sourceGoal ? new AstraSourceGoalCompiler({ resolve: () => ({
    selectionId: 'live_targets', conversationId: 'owned_conversation', revision: 1,
    actor: { id: 'sha256:' + createHmac('sha256', apiToken).update('monarch.astra-v3.http-actor.v1/api').digest('hex'), source: 'api' },
    targets: [{ id: 'read_one', relativePath: 'selected.txt', access: 'observe', maxBytes: 8192, timeoutMs: 5000 },
      { id: 'read_two', relativePath: 'unicode.txt', access: 'observe', maxBytes: 8192, timeoutMs: 5000 },
      { id: 'literal', relativePath: 'literal.txt', access: 'exclusive-create', maxBytes: 4096, timeoutMs: 5000 },
      { id: 'reply', relativePath: 'draft.txt', access: 'exclusive-create', maxBytes: 4096, timeoutMs: 5000 }],
  }) }) : undefined;
  const clarificationText = options.requiredInput ? 'Create a new greeting in draft.txt. The recipient and tone still need clarification.'
    : 'Create the new file draft.txt, but its content is not known yet. First ask the user what the file should contain. Do not invent its content.';
  const client = new AstraPreparedModelClient({ deployment: 'isolated-validation', ...options.host,
    bearerToken: 'astra-owned-live-smoke', timeoutMs: 25000,
    fetch: (url, init) => { modelRequests++; return fetch(url, init); } });
  const tasks = new MonarchAstraTaskFacade({ deployment: 'isolated-validation', canonicalRoot: options.workspaceRoot,
    scopeId: 'live_unified_http', kernel: options.kernel, journal: options.journal, client,
    requiredInputs: !!(options.requiredInput || options.literalInput || options.sourceGoal),
    policy: { expectedModelDigest: options.host.modelDigest, maxOutputTokens: 256, modelTimeoutMs: 15000,
      maxModelAttempts: 1, contextLimits: { tokenizerTimeoutMs: 5000 } },
    ...(sourceCompiler ? { sourceCompiler } : { catalog: { resolve: readSelection }, createCatalog: { resolve: (id, context) => {
      if (!options.clarificationOnly) return createSelection(id, context);
      if (id !== 'constrained' || context.text !== clarificationText) throw Error('native-clarification-source');
      return { kind: 'draft', authority: 'exclusive-create', revision: 1, digest: modelReadDigest('native-clarification-selection'),
        basename: 'draft.txt', maxBytes: 1024, timeoutMs: 5000,
        ...(options.requiredInput ? { requiredInput: { kind: 'draft-guidance' as const, id: 'greeting_details',
          question: 'Who is the greeting for, and what tone should it use?', maxUtf8Bytes: 128 } } : {}),
        contentRequirement: { kind: 'exact-utf8', ...astraDraftContentFingerprint(draftContent) } };
    } } }) });
  const common = new AstraWorkScheduler({ deployment: 'isolated-validation', journal: options.journal,
    scopeId: 'live_unified_http', adapters: tasks.adapters, limits: { activationTimeoutMs: 20000, kernelSlots: 1 } });
  tasks.attach(common); tasks.start();
  const api = createMonarchHttpServer({ app: new Proxy({} as MonarchApplication, { get() { throw Error('ordinary-application-bootstrap-forbidden'); } }),
    publicDirectory: options.workspaceRoot, host: '127.0.0.1', port: 4317, apiToken,
    desktopAttestationToken: 'unused-owned-' + options.invocation, requireApiToken: true,
    allowNonLoopbackMutations: false, astraTasks: tasks });
  const results = [];
  try {
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (api.address() as { port: number }).port;
    const headers = { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' };
    const call = async (route: string, body?: unknown) => {
      const response = await fetch(base + route, { headers, signal: AbortSignal.timeout(5000),
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as { task?: AstraTaskHttpTask } };
    };
    for (const kind of options.sourceGoal ? ['literal', 'read', 'literal-input'] as const : options.literalInput ? ['literal-input'] as const : options.clarificationOnly ? ['constrained'] as const : ['literal', 'read', 'constrained'] as const) {
      const before = await options.metrics(), dispatchBefore = options.kernelCalls(), requestsBefore = modelRequests, started = performance.now();
      const request = fixtureRequest(kind), route = '/api/astra/v3/' + (kind === 'read' ? 'read-tasks' : 'create-tasks');
      if (options.sourceGoal) { request.selectionId = 'live_targets';
        request.goal = kind === 'read' ? { kind: 'observe', targets: ['read_one', 'read_two'] }
          : { kind: 'create', target: kind === 'literal' ? 'literal' : 'reply', content: kind === 'literal' ? { kind: 'literal', text: literalContent } : { kind: 'reply' } };
        if (kind === 'read') request.text = 'Read the selected files and report observed byte counts.';
      }
      if (options.clarificationOnly) request.text = clarificationText;
      const initial = await call(route, request);
      if (initial.status !== 202 || !initial.body.task) throw Error('live-unified-admission:' + initial.status);
      await tasks.drain();
      const itemRoute = route + '/' + initial.body.task.id;
      const source = { conversationId: request.conversationId, inputMessageId: request.inputMessageId };
      let get = await call(itemRoute + '?' + new URLSearchParams(source)), view = get.body.task;
      const clarificationCase = options.clarificationOnly || kind === 'literal-input', requiredCase = options.requiredInput || kind === 'literal-input';
      const question = clarificationCase ? view?.question ?? null : null;
      let replyStatus: number | null = null, replyReplayed = false, questionQuiescent = false;
      let questionModelCalls: number | null = null, questionModelHttpRequests: number | null = null;
      if (question && view?.status === 'awaiting-user') {
        const waiting = await options.metrics(); questionQuiescent = !waiting.slotReserved && !waiting.generationWorkerActive && options.kernelCalls() === dispatchBefore;
        questionModelCalls = waiting.generationCalls - before.generationCalls; questionModelHttpRequests = modelRequests - requestsBefore;
        const reply = { version: 1, ...source, clientRequestId: 'native_reply', questionId: question.id,
          questionDigest: question.digest, replyMessageId: 'native_reply_message', text: kind === 'literal-input' ? literalReply : options.requiredInput
            ? 'Astra; a short friendly greeting containing exactly Hello, Astra!' : draftContent };
        replyStatus = (await call(itemRoute + '/reply', reply)).status; await tasks.drain();
        const count = modelRequests; replyReplayed = (await call(itemRoute + '/reply', reply)).status === 200;
        await tasks.drain(); replyReplayed &&= modelRequests === count;
        get = await call(itemRoute + '?' + new URLSearchParams(source)); view = get.body.task;
      }
      const observed = kind === 'read' ? null : await readFile(path.join(options.workspaceRoot, kind === 'literal' ? 'literal.txt' : 'draft.txt'), 'utf8')
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      const replay = await call(route, request); await tasks.drain();
      const ack = await call(itemRoute + '/ack', { version: 1, ...source, certificateDigest: view?.message?.certificateDigest });
      const after = await options.metrics(), modelCalls = after.generationCalls - before.generationCalls, kernelCalls = options.kernelCalls() - dispatchBefore;
      const deliveryPassed = get.status === 200 && replay.status === 202 && replay.body.task?.id === initial.body.task.id
        && ack.status === 200 && ack.body.task?.message?.delivery === 'acknowledged'
        && view?.message?.conversationId === request.conversationId && view.message.predecessorMessageId === (replyStatus === 200 ? 'native_reply_message' : request.inputMessageId);
      const expectedContent = kind === 'literal' ? literalContent : kind === 'literal-input' ? literalReply : draftContent;
      const requiredInputBarrierPassed = !requiredCase ? null : !!question && question.origin === 'host-required-input'
        && questionModelCalls === 0 && questionModelHttpRequests === 0 && questionQuiescent;
      const clarificationPassed = !clarificationCase || !!question && replyStatus === 200 && replyReplayed && questionQuiescent
        && (!requiredCase || requiredInputBarrierPassed);
      const expectedReadBytes = 4103 + (options.sourceGoal ? Buffer.byteLength('Привет, Astra 🟠\n') : 0);
      const requestedResultPassed = clarificationPassed && view?.status === 'completed' && (kind === 'read'
        ? view.message?.content.includes(String(expectedReadBytes)) === true : observed === expectedContent);
      const sourceReason = (options.journal.read(initial.body.task.id)?.checkpoint as { reason?: string } | undefined)?.reason ?? null;
      const commonPassed = deliveryPassed && !after.slotReserved && !after.generationWorkerActive
        && modelCalls === (options.sourceGoal || kind === 'literal' || kind === 'literal-input' ? 0 : replyStatus === 200 && !options.requiredInput ? 2 : 1)
        && (!(options.sourceGoal || ['literal', 'literal-input'].includes(kind)) || modelRequests === requestsBefore);
      const constraintGuardPassed = kind !== 'constrained' ? null : commonPassed && (requestedResultPassed && kernelCalls === 1
        || view?.status === 'blocked' && sourceReason === 'content-requirement-mismatch' && view.createJobs === 0 && kernelCalls === 0 && observed === null);
      const result = { id: 'unified-http-' + (options.sourceGoal ? 'compiled-' + kind : options.requiredInput ? 'required-input' : options.clarificationOnly ? 'clarification' : kind), task: view, sourceReason, requestedResultPassed, constraintGuardPassed,
        ...(clarificationCase ? { question, replyStatus, replyReplayed, questionQuiescent, questionModelCalls, questionModelHttpRequests,
          clarificationPassed, requiredInputBarrierPassed } : {}),
        passed: commonPassed && requestedResultPassed && kernelCalls === (options.sourceGoal && kind === 'read' ? 2 : 1), deliveryPassed, modelCalls, kernelCalls,
        modelHttpRequests: modelRequests - requestsBefore, observedContent: observed,
        ...(kind === 'read' ? { expectedReadBytes } : {}),
        elapsedMs: Math.round(performance.now() - started), slotReserved: after.slotReserved, rssBytes: after.rssBytes,
        adapterCount: tasks.adapters.length, ordinaryApplicationBootstrap: false, nativeCompletionCertified: false };
      results.push(result); process.stdout.write(JSON.stringify(result) + '\n');
    }
    return results;
  } finally {
    await new Promise<void>(resolve => { api.close(() => resolve()); api.closeAllConnections(); }); await tasks.stop();
  }
}

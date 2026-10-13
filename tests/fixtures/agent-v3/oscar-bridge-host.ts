import path from 'node:path';
import type { AstraMemoryRecallAdmission } from '../../../src/agent-v3/memory-recall-admission';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { AstraJournal } from '../../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../../src/agent-v3/work-scheduler';
import { AstraPreparedModelClient } from '../../../src/agent-v3/prepared-model-client';
import { MonarchKernel } from '../../../src/core/kernel';
import { WorkspaceModule } from '../../../src/modules/workspace';
import { MonarchAstraTaskFacade } from '../../../src/app/astra-task-facade';
import type { AstraAuthenticatedHttpActor } from '../../../src/app/astra-task-facade';
import { AstraSourceGoalCompiler } from '../../../src/app/astra-source-goal-compiler';
import { AstraTargetSelectionStore } from '../../../src/app/astra-target-selection-store';
import { AstraOscarBridge } from '../../../src/app/astra-oscar-bridge';
import { OscarTurnCoordinator, type OscarPersistedMessage, type SubmitOscarTurnInput } from '../../../src/oscar-turn/coordinator';
import { InMemoryOscarTurnStore, LocalJsonOscarTurnStore } from '../../../src/oscar-turn/turn-store';
import { isolatedLocalSecurity } from './local-security';
import { syntheticComputerSource, type SyntheticComputerSource } from './computer-source';
import { AstraComputerSelectionStore } from '../../../src/app/astra-computer-selection-store';
import type { ComputerNativeActionReceipt } from '../../../src/modules/computer';
import type { AstraComputerAction } from '../../../src/agent-v3/computer-action-work-adapter';
import { AstraComputerActionPlanStore } from '../../../src/app/astra-computer-action-plan-store';

export const oscarBridgeMarker = 'astra-v3-oscar-bridge-synthetic-only';
export function oscarBridgeRequest(kind: 'read' | 'literal' | 'reply' = 'read'): SubmitOscarTurnInput {
  return { clientRequestId: 'source_request', conversationId: 'conversation', inputMessageId: 'source_message', source: 'desktop', privacyMode: 'persistent',
    text: kind === 'read' ? 'Прочитай выбранный файл.' : 'Обработай выбранную цель согласно явно заданному действию.',
    astra: { selectionId: 'selection', goal: kind === 'read' ? { kind: 'observe', targets: ['selected'] }
      : { kind: 'create', target: 'output', content: kind === 'literal' ? { kind: 'literal', text: 'Точные байты 🟠' } : { kind: 'reply' } } } };
}
export async function oscarBridgeHost(root: string, input: { actor?: AstraAuthenticatedHttpActor; durableSelections?: boolean; referenceInputs?: boolean; computer?: boolean;
  genericAgent?: boolean;
  recall?: { admission: AstraMemoryRecallAdmission; isCurrent: () => boolean; readValidity: (signal: AbortSignal) => Promise<unknown> };
  computerAction?: boolean; computerPlans?: boolean; computerSource?: SyntheticComputerSource;
  persistMessage?: (message: OscarPersistedMessage) => Promise<{ disposition: 'created' | 'duplicate' | 'superseded' }>;
  model?: { endpoint: string; hostGeneration: string; modelDigest: string; fetch: typeof fetch; bearerToken?: string; timeoutMs?: number } } = {}) {
  const resolved = await realpath(root), parent = await realpath('.test-tmp');
  if (resolved !== root || path.dirname(root) !== parent || path.parse(parent).root.toUpperCase() !== 'D:\\'
    || !path.basename(root).startsWith('astra-v3-oscar-') || await readFile(path.join(root, '.fixture-marker'), 'utf8') !== oscarBridgeMarker)
    throw Error('owned-oscar-fixture-required');
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: input.computerAction || input.computerPlans ? { sandboxMode: 'read-only', approvalPolicy: 'on-request' }
      : { sandboxMode: 'workspace-write', approvalPolicy: 'never' } });
  const workspace = new WorkspaceModule({ workspaceRoot: root, localReadOnlyRoots: [] });
  const computer = input.computerSource ?? (input.computer || input.computerAction || input.computerPlans ? syntheticComputerSource(root) : undefined);
  if (computer) kernel.registerModule(computer.module);
  kernel.registerModule(workspace); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
  computer?.module.control.start('owned-synthetic-user');
  let modelCalls = 0, answerCalls = 0, actorRevoked = false;
  const actor = input.actor ?? { id: 'sha256:' + 'd'.repeat(64), source: 'desktop' as const };
  const journal = new AstraJournal(path.join(root, 'astra.sqlite'));
  const targets = [{ id: 'selected', relativePath: 'selected.txt', access: 'observe' as const, maxBytes: 4096, timeoutMs: 1000 },
    { id: 'output', relativePath: 'Новый отчёт.txt', access: 'exclusive-create' as const, maxBytes: 4096, timeoutMs: 1000 }];
  let sourceChanged = () => {};
  const windowSelections = computer ? new AstraComputerSelectionStore({ deployment: 'isolated-validation', journal, scopeId: 'oscar_windows', onRevoked: () => sourceChanged() }) : undefined;
  const actionPlans = input.computerPlans ? new AstraComputerActionPlanStore({ deployment: 'isolated-validation', journal,
    scopeId: 'oscar_action_plans', onRevoked: () => sourceChanged() }) : undefined;
  const computerAction: AstraComputerAction = { kind: 'type', elementId: 'owned_editor', text: '  Oscar Astra exact 🟠  ', textMode: 'replace' };
  const actionPlan = input.computerAction && computer ? await (async () => {
    const proposal = kernel.prepareActionProposal({ capabilityId: 'computer.window.observe', proposalId: 'oscar_action_seed',
      args: { windowRef: computer.window.windowRef, captureNonce: 'oscar_action_seed',
        selectionBinding: { processId: computer.window.processId, processInstanceId: computer.window.processInstanceId,
          title: computer.window.title } }, reason: 'Owned Oscar action seed.' },
    { requestedBy: 'user:owned-test', intentId: 'oscar_action_seed', originatingUserText: 'Capture the owned synthetic action target.' });
    const captured = await kernel.executeActionProposal(proposal, { requestedBy: 'user:owned-test', intentId: 'oscar_action_seed',
      source: 'desktop', originatingUserText: 'Capture the owned synthetic action target.' });
    if (!captured.result.ok) throw Error('owned-action-seed-failed:' + captured.result.error);
    const output = captured.result.output as any;
    return { selectionId: 'oscar_action_plan', actor, conversationId: 'conversation', revision: 1,
      windowRef: computer.window.windowRef, processId: computer.window.processId,
      processInstanceId: computer.window.processInstanceId, title: computer.window.title,
      expiresAt: Date.now() + 60_000, timeoutMs: 3000,
      observation: { authority: 'none' as const, authorizesInput: false as const, temporalSemantics: 'snapshot-at-capture' as const,
        observationId: output.observationId, observedAt: output.observedAt,
        windowRef: computer.window.windowRef, processId: computer.window.processId,
        processInstanceId: computer.window.processInstanceId, title: computer.window.title,
        screenshotDigest: 'sha256:' + output.screenshot.sha256, truncated: output.truncated,
        omittedPasswordElements: output.omittedPasswordElements,
        elements: output.elements.map((element: any) => ({ elementId: element.elementId, name: element.name, value: element.value,
          automationId: element.automationId, className: element.className, controlType: element.controlType,
          enabled: element.enabled, offscreen: element.offscreen, focused: element.focused })) },
      action: computerAction };
  })() : undefined;
  let computerActionCalls = 0;
  if ((actionPlan || actionPlans) && computer && !input.computerSource) computer.provider.act = async request => {
    computerActionCalls++;
    const after = await computer.provider.observe(request.windowRef, request.afterScreenshotPath, undefined,
      { processId: computer.window.processId, processInstanceId: computer.window.processInstanceId, title: computer.window.title });
    const receipt: ComputerNativeActionReceipt = { dispatchedAt: new Date().toISOString(), actionKind: request.action.kind, foregroundVerified: false,
      exactTargetVerified: true, dispatchMode: 'uia-semantic', inputLeaseId: request.inputLeaseId, controlEpoch: request.controlEpoch,
      cursor: { x: 1, y: 1, style: 'oscar-orange', nativeOverlay: true, systemCursorRestored: true, userTakeoverDetected: false,
        dispatchMode: 'uia-semantic', exactTargetVerifiedAtDispatch: true }, after,
      ...(request.action.kind === 'type' ? { textVerification: { textMode: request.action.textMode,
        textSha256: createHash('sha256').update(request.action.text).digest('hex'),
        valueVerifiedAfterDispatch: request.action.textMode === 'replace' } } : {}) };
    return receipt;
  };
  const selections = input.durableSelections ? new AstraTargetSelectionStore({ deployment: 'isolated-validation', scopeId: 'oscar_selections',
    canonicalRoot: root, journal, onRevoked: () => sourceChanged() }) : undefined;
  // This fixture owns these two exact paths. No production picker/discovery.
  const selection = selections?.findIssued('synthetic_host_choice', { actor, conversationId: 'conversation' })
    ?? selections?.issue({ actor, conversationId: 'conversation', requestId: 'synthetic_host_choice', ttlMs: 3600000, targets });
  const facade = new MonarchAstraTaskFacade({ deployment: 'isolated-validation', canonicalRoot: root, scopeId: 'oscar_bridge', journal, kernel,
    ...(input.recall ? { localAnalysis: true, memoryPolicyCurrent: (revision: string) => input.recall!.admission.isPolicyCurrent(revision),
      memory: { destination: 'local-desktop' as const, modelDigest: input.model?.modelDigest ?? 'sha256:' + 'a'.repeat(64),
      isCurrent: input.recall.isCurrent, readValidity: input.recall.readValidity } } : {}),
    requiredInputs: true, literalApprovals: true, compositeApprovals: true,
    referenceInputs: input.referenceInputs === true,
    ...(windowSelections ? { computerCatalog: windowSelections } : {}),
    ...(actionPlans ? { computerActionCatalog: actionPlans } : actionPlan ? { computerActionCatalog: { resolve: (selectionId: string, context: { actor: AstraAuthenticatedHttpActor; conversationId: string }) => {
      if (selectionId !== actionPlan.selectionId || context.actor.id !== actor.id || context.actor.source !== actor.source
        || context.conversationId !== actionPlan.conversationId) throw Error('owned-action-plan-not-found');
      return structuredClone(actionPlan);
    } } } : {}),
    sourceCompiler: new AstraSourceGoalCompiler(selections ?? { resolve: (selectionId, context) => ({ selectionId, actor, conversationId: context.conversationId,
      revision: 1, targets }) }),
    client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: input.model?.endpoint ?? 'http://127.0.0.1:9', hostGeneration: input.model?.hostGeneration ?? 'synthetic_oscar_host',
      bearerToken: input.model ? input.model.bearerToken ?? 'astra-synthetic-test' : 'synthetic-only', fetch: async (...args) => { modelCalls++;
        if (input.model) return input.model.fetch(...args); throw Error('model-network-forbidden'); } }),
    policy: { expectedModelDigest: input.model?.modelDigest ?? 'sha256:' + 'a'.repeat(64), maxOutputTokens: 256,
      modelTimeoutMs: input.model?.timeoutMs ?? 5000, contextLimits: { tokenizerTimeoutMs: 1000 } },
    ...(input.genericAgent ? { genericAgent: {
      catalogKey: createHash('sha256').update('owned-oscar-generic-agent').digest(),
      policy: { modelId: 'owned-oscar-agent', expectedModelDigest: input.model?.modelDigest ?? 'sha256:' + 'a'.repeat(64),
        maxOutputTokens: 256, modelTimeoutMs: input.model?.timeoutMs ?? 5000, maxModelTurns: 8, maxCapabilityCalls: 4 },
    } } : {}) });
  const scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId: 'oscar_bridge', journal, adapters: facade.adapters,
    limits: { activationTimeoutMs: 5000, leaseMs: 1000, kernelSlots: 1 } }); facade.attach(scheduler);
  // Synthetic fixture only: retain the original failure before the public host
  // reduces it to a safe issue code. Never retry, repair or change its result.
  const progressionFailures: Array<{ stage: string; message: string }> = [];
  let failProgress = false;
  const internals = facade as unknown as { progress(): Promise<void>; recoveryCandidates(): unknown[] };
  const recordFailure = (stage: string, error: unknown) => {
    if (progressionFailures.length < 8) {
      const failure = { stage, message: String(error instanceof Error ? error.message : error).slice(0, 192) };
      progressionFailures.push(failure); process.stderr.write('ASTRA_OWNED_PROGRESS_FAILURE ' + JSON.stringify({ ...failure,
        stack: error instanceof Error ? error.stack?.split('\n').slice(1, 7).join('\n') : undefined }) + '\n');
    }
  };
  const progress = internals.progress.bind(facade), candidates = internals.recoveryCandidates.bind(facade);
  internals.progress = async () => { try { if (failProgress) throw Error('owned-synthetic-progression-fault'); await progress(); }
    catch (error) { recordFailure('progress', error); throw error; } };
  internals.recoveryCandidates = () => { try { return candidates(); } catch (error) { recordFailure('recovery-candidates', error); throw error; } };
  sourceChanged = () => facade.notifySourceChange();
  const bridge = new AstraOscarBridge(facade, () => { if (actorRevoked) throw Error('fixture-actor-revoked'); return actor; },
    { ...(input.recall ? { localAnalysis: true, memoryAdmission: input.recall.admission } : {}),
      ...(input.genericAgent ? { genericAgent: { local: true, max: false }, localAnalysis: true } : {}) });
  const persistentStore = new LocalJsonOscarTurnStore(path.join(root, 'turns.json'));
  const deliveries = path.join(root, 'deliveries.json');
  async function delivered(): Promise<OscarPersistedMessage[]> {
    try { return JSON.parse(await readFile(deliveries, 'utf8')) as OscarPersistedMessage[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  const hooks = { beforePersist: (_message: OscarPersistedMessage) => {}, afterPersist: (_message: OscarPersistedMessage) => {} };
  const persistMessage = async (message: OscarPersistedMessage) => {
    if (input.persistMessage) { hooks.beforePersist(message); const receipt = await input.persistMessage(message); hooks.afterPersist(message); return receipt; }
    hooks.beforePersist(message); const messages = await delivered(), old = messages.find(item => item.messageId === message.messageId);
    if (old && JSON.stringify(old) !== JSON.stringify(message)) throw Error('fixture-delivery-conflict');
    if (message.requiredPreviousMessageId && !messages.some(item => item.messageId === message.requiredPreviousMessageId)) throw Error('fixture-predecessor-missing');
    if (!old) { messages.push(message); await writeFile(deliveries, JSON.stringify(messages), 'utf8'); }
    hooks.afterPersist(message); return { disposition: old ? 'duplicate' as const : 'created' as const };
  };
  const options = { persistentStore, volatileStore: new InMemoryOscarTurnStore(), astra: bridge,
    answerExecutor: async () => { answerCalls++; throw Error('answer-execution-forbidden'); }, persistMessage };
  const coordinator = new OscarTurnCoordinator(options);
  const flush = async () => {
    for (let i = 0; i < 4; i++) {
      await (coordinator as unknown as { drainOutbox(): Promise<void> }).drainOutbox(); await facade.drain();
    }
  };
  return { root, kernel, workspace, journal, facade, scheduler, bridge, coordinator, options, persistentStore, hooks, delivered, flush,
    selections, computer, windowSelections, actionPlans, progressionFailures, progressFault: (active: boolean) => { failProgress = active; if (active) facade.notifySourceChange(); },
    selectionId: selection?.selectionId ?? 'selection', actionPlan, computerAction, computerActionCalls: () => computerActionCalls,
    counts: () => ({ modelCalls, legacyCalls: 0, answerCalls }), revokeActor: () => { actorRevoked = true; },
    start: () => facade.startWithSourceRestore(() => coordinator.start()),
    close: async () => { await coordinator.stop(); await facade.stop(); await kernel.stop(); journal.close(); } };
}

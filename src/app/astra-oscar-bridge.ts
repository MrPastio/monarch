import type { OscarTurnV1 } from '../oscar-turn/types';
import { AstraMemoryRecallAdmission, type AstraRecallAdmission, type AstraRecallRequest } from '../agent-v3/memory-recall-admission';
import { validateOscarAstraBinding, type OscarAstraBinding, type OscarAstraInput, type OscarAstraPort, type OscarAstraSelection } from '../oscar-turn/astra-contract';
import { MonarchAstraTaskFacade, type AstraAuthenticatedHttpActor, type AstraTaskHttpRequest } from './astra-task-facade';
import { createHash } from 'node:crypto';
import { astraAgentHistoryTail, isAstraAgentExecutionProfile, type AstraAgentInitialEvidenceItem } from '../agent-v3/agent-task-profile';
import { parseCloudRole } from '../agent-v3/max-cloud-catalog';
import { isAstraLocalAgentModelChoice, type AstraLocalAgentModelChoice,
  type AstraMaxModelChoice } from '../agent-v3/source-goal-contract';

function assertSource(turn: OscarTurnV1, goal: OscarAstraSelection['goal'], privacyMode: 'persistent' | 'incognito' = 'persistent'): void {
  const coderProfile = turn.source === 'coder' && isAstraAgentExecutionProfile(turn.request.executionProfile);
  if (turn.privacyMode !== privacyMode || !['desktop', 'voice', 'api', 'telegram', 'coder', 'system'].includes(turn.source)
    || (goal?.kind !== 'agent' && turn.request.attachmentIds.length) || Object.keys(turn.request.modifiers).length
    || (turn.request.executionProfile !== undefined && !coderProfile) || (coderProfile && goal?.kind !== 'agent')
    || ![turn.conversationId, turn.inputMessageId].every(id => /^[A-Za-z0-9_-]{1,96}$/u.test(id))
    || Buffer.byteLength(turn.request.text) > (coderProfile ? 20_000
      : goal?.kind === 'agent' ? 16_384 : goal?.kind === 'observe' || goal?.kind === 'analyze' ? 8192 : 4096))
    throw Error('astra-oscar-unsupported-source');
}

/** Explicit isolated source bridge. Host authenticates the actor; user/model data
 * never supplies it. The existing facade owns all work and Kernel authority.
 * Host must restore Oscar state/control before starting its Astra work host. */
export class AstraOscarBridge implements OscarAstraPort {
  constructor(private readonly facade: MonarchAstraTaskFacade,
    private readonly actorForTurn: (turn: OscarTurnV1) => AstraAuthenticatedHttpActor,
    private readonly policy: { requiredModelMode?: 'max'; optionalMax?: boolean; localAnalysis?: boolean; memoryAdmission?: AstraMemoryRecallAdmission;
      genericAgent?: { local: boolean; max: boolean;
        /** Live readiness of the selected MAX provider. Without it, a present
         * MAX host is taken as ready (isolated compositions and tests). */
        maxReady?: () => Promise<boolean>;
        defaultMaxModel?: AstraMaxModelChoice;
        defaultLocalModel?: AstraLocalAgentModelChoice;
        localModels?: ReadonlyArray<AstraLocalAgentModelChoice> };
      privacyMode?: 'persistent' | 'incognito' } = {}) {}
  private maxReady = true;
  async refreshAgentAvailability(): Promise<void> {
    const probe = this.policy.genericAgent?.maxReady;
    if (probe) this.maxReady = await probe().catch(() => false);
  }
  bindAgent(turn: OscarTurnV1): OscarAstraBinding | null {
    const enabled = this.policy.genericAgent;
    if (!enabled || turn.request.astra || !['desktop', 'voice', 'api', 'telegram', 'coder', 'system'].includes(turn.source)
      || turn.privacyMode !== (this.policy.privacyMode ?? 'persistent')
      || turn.source === 'api' && !turn.request.authenticatedAgentActor
      || turn.source === 'telegram' && !turn.request.telegramActor
      || (turn.source === 'coder') !== isAstraAgentExecutionProfile(turn.request.executionProfile)) return null;
    const modifiers = turn.request.modifiers;
    if (Object.keys(modifiers).some(key => !['requestedModel', 'reasoningEffort', 'computerUseCapability',
      'imageGenerationCapability', 'researchMode', 'webSearch'].includes(key))
      || modifiers.researchMode === 'deep' || modifiers.webSearch === true) return null;
    const requested = modifiers.requestedModel;
    const maxChoice: AstraMaxModelChoice | undefined = requested === 'max-gpt-oss-120b' ? 'gpt-oss-120b'
      : requested === 'max-qwen-3.8-27b' ? 'qwen-3.8-27b'
        : parseCloudRole(requested) ? requested as AstraMaxModelChoice : undefined;
    const localChoice: AstraLocalAgentModelChoice | undefined = isAstraLocalAgentModelChoice(requested)
      ? requested : undefined;
    if (turn.source === 'coder' && !localChoice && !maxChoice) return null;
    if (localChoice && !enabled.localModels?.includes(localChoice)) return null;
    // With MAX connected the owner has already supplied a key and the transfer
    // consent, and only the cloud policies carry the turn/capability budget a
    // long agent run needs. An ordinary turn that names no model therefore runs
    // on MAX; an exact local request still binds locally, and without a
    // connected MAX default the local lane stays the default. `maxReady` also
    // carries the owner's work mode: "На компьютере" keeps unnamed turns local
    // (owner decision 2026-10-16, after an offline local task failed on MAX).
    const preferMax = !maxChoice && !localChoice && enabled.max && this.maxReady && enabled.defaultMaxModel !== undefined;
    const modelMode = this.policy.requiredModelMode === 'max' || maxChoice || preferMax ? 'max' : 'local';
    if (modelMode === 'max' ? !enabled.max : !enabled.local) return null;
    const modelChoice = maxChoice ?? localChoice ?? (modelMode === 'max'
      ? enabled.defaultMaxModel : enabled.defaultLocalModel);
    const goal: Extract<OscarAstraSelection['goal'], { kind: 'agent' }> = { kind: 'agent', modelMode,
      ...(modelChoice ? { modelChoice } : {}),
      ...(maxChoice === 'qwen-3.8-27b' ? { previewAcknowledged: true as const } : {}) };
    const source = { ...turn, request: { ...turn.request, modifiers: {} } };
    assertSource(source, goal, this.policy.privacyMode);
    const actor = this.actorForTurn(turn);
    if (actor.source !== turn.source) throw Error('astra-oscar-actor-source-mismatch');
    const selectionId = 'agent_' + createHash('sha256').update(JSON.stringify(
      [actor, turn.conversationId, turn.clientRequestId, goal])).digest('hex').slice(0, 48);
    return { ...this.bind(source, { selectionId, goal }), admission: 'ordinary-agent-v1' };
  }
  async prepare(turn: OscarTurnV1): Promise<unknown> {
    const goal = this.binding(turn).goal;
    if (goal.kind === 'agent') return undefined;
    if (goal.kind === 'analyze' && goal.modelMode === 'max'
      || goal.kind === 'create' && goal.content.kind === 'draft' && goal.content.modelMode === 'max') return undefined;
    if (!this.policy.memoryAdmission || this.find(turn)) return undefined;
    return this.policy.memoryAdmission.prepare(this.recallRequest(turn));
  }
  private recallRequest(turn: OscarTurnV1): AstraRecallRequest {
    const goal = this.binding(turn).goal;
    return { source: turn.source as AstraRecallRequest['source'], privacy: turn.privacyMode as AstraRecallRequest['privacy'],
      destination: this.policy.requiredModelMode === 'max' || goal.kind === 'analyze' && goal.modelMode === 'max' ? 'max' : 'local',
      operation: goal.kind === 'analyze' ? 'analyze' : 'observe', query: turn.request.text };
  }
  bind(turn: OscarTurnV1, selection: OscarAstraSelection, authenticatedActor?: AstraAuthenticatedHttpActor): OscarAstraBinding {
    if (!selection || Object.keys(selection).some(key => !['selectionId', 'goal'].includes(key)))
      throw Error('astra-oscar-unsupported-source');
    assertSource(turn, selection.goal, this.policy.privacyMode);
    // Telegram admission already supplies its authenticated remote principal and
    // cannot be resolved from the Turn until this binding exists. Desktop/API
    // must also match the host-owned principal before a durable Turn is created.
    const hostActor = authenticatedActor?.source === 'telegram' ? authenticatedActor : this.actorForTurn(turn);
    if (authenticatedActor && (authenticatedActor.id !== hostActor.id || authenticatedActor.source !== hostActor.source))
      throw Object.assign(Error('astra-oscar-authenticated-actor-mismatch'), { statusCode: 403, code: 'astra-oscar-authenticated-actor-mismatch' });
    const binding: OscarAstraBinding = { ...structuredClone(selection), version: 'astra-oscar-isolated-v1',
      actor: structuredClone(hostActor) };
    validateOscarAstraBinding(binding);
    const modelTask = binding.goal.kind === 'agent' || binding.goal.kind === 'analyze'
      || binding.goal.kind === 'create' && binding.goal.content.kind === 'draft';
    const modelMode = binding.goal.kind === 'agent' || binding.goal.kind === 'analyze' ? binding.goal.modelMode
      : binding.goal.kind === 'create' && binding.goal.content.kind === 'draft' ? binding.goal.content.modelMode : undefined;
    if (modelTask
      && (this.policy.requiredModelMode ? modelMode !== this.policy.requiredModelMode
        : modelMode !== undefined && !(modelMode === 'max' && this.policy.optionalMax === true)
          && !((binding.goal.kind === 'analyze' || binding.goal.kind === 'agent')
            && modelMode === 'local' && this.policy.localAnalysis === true))) {
      const code = this.policy.requiredModelMode ? 'astra-model-mode-required' : 'astra-model-mode-unavailable';
      throw Object.assign(Error(code), { statusCode: 400, code });
    }
    if (binding.goal.kind === 'computer-observe' && (turn.source !== 'desktop' || !this.facade.computerTasks)
      || binding.goal.kind === 'computer-action' && (turn.source !== 'desktop' || !this.facade.computerActionTasks))
      throw Object.assign(Error('astra-computer-source-unavailable'), { statusCode: 409, code: 'astra-computer-source-unavailable' });
    if (binding.actor.source !== turn.source) throw Error('astra-oscar-actor-source-mismatch');
    return binding;
  }
  find(turn: OscarTurnV1) { const binding = this.binding(turn);
    return this.facade.findRequest(binding.actor, this.request(turn), this.operation(turn)); }
  submit(turn: OscarTurnV1, prepared?: unknown) { const binding = this.binding(turn);
    const agentPrepared = prepared && typeof prepared === 'object' && !Array.isArray(prepared)
      && (prepared as { kind?: unknown }).kind === 'agent-attachments-v1'
      ? prepared as { kind: 'agent-attachments-v1'; initialEvidence: AstraAgentInitialEvidenceItem[] } : undefined;
    const recall = (agentPrepared ? undefined : prepared) as AstraRecallAdmission | undefined;
    if (recall?.status === 'prepared') {
      if (!this.policy.memoryAdmission?.isAdmissible(this.recallRequest(turn), recall)) throw Error('astra-memory-admission-stale');
      return this.facade.submitWithLocalRecall(binding.actor, this.request(turn), recall.snapshot, recall.policyRevision);
    }
    return this.facade.submit(binding.actor, this.request(turn), this.operation(turn), agentPrepared?.initialEvidence); }
  input(turn: OscarTurnV1, input: OscarAstraInput) {
    const operation = this.operation(turn);
    if (!['create', 'computer-action', 'agent'].includes(operation)) throw Error('astra-oscar-input-unsupported');
    const binding = this.binding(turn), taskId = this.taskId(turn), surface = operation === 'create'
      ? this.facade.createTasks : operation === 'computer-action' ? this.facade.computerActionTasks : this.facade.agentTasks;
    if (input.kind === 'reply' && surface?.reply) return surface.reply(binding.actor, taskId, turn, input.reply);
    if (input.kind === 'decide' && surface?.decide) return surface.decide(binding.actor, taskId, turn, input.decision);
    throw Error('astra-oscar-input-unsupported');
  }
  command(turn: OscarTurnV1, command: 'pause' | 'resume' | 'cancel') { const binding = this.binding(turn);
    const task = this.find(turn); if (!task) throw Error('astra-oscar-task-missing');
    if (task.message) return task;
    if (command === 'resume' && task.status !== 'paused') {
      if (['indeterminate', 'pausing', 'cancelling'].includes(task.status)) throw Error('astra-oscar-recovery-required');
      return task; // A replay of desired=run is not a second resume activation.
    }
    if (command === 'pause' && task.status === 'paused' || command === 'cancel' && task.status === 'cancelling') return task;
    return this.facade.command(binding.actor, this.taskId(turn), turn, command, this.operation(turn)); }
  wake(turn: OscarTurnV1): void {
    const binding = this.binding(turn), task = this.find(turn);
    if (!task) throw Error('astra-oscar-task-missing'); // No replacement admission on recovery.
    if (task.message) return;
    const desired = turn.astraControl?.desired;
    // Durable source controls precede any progression. A wake is not resume;
    // unknown work retains its slot and the host's existing recovery budget.
    if (desired && (desired !== 'resume' || task.status === 'paused')) this.command(turn, desired);
    this.facade.wake(binding.actor, task.id, turn, this.operation(turn));
  }
  acknowledge(turn: OscarTurnV1, digest: string): void { const binding = this.binding(turn);
    this.facade.acknowledge(binding.actor, this.taskId(turn), turn, digest, this.operation(turn)); }
  private binding(turn: OscarTurnV1): OscarAstraBinding {
    const binding = turn.request.astra; if (!binding) throw Error('astra-oscar-binding-required');
    validateOscarAstraBinding(binding);
    const actor = this.actorForTurn(turn);
    if (actor.id !== binding.actor.id || actor.source !== binding.actor.source || turn.source !== actor.source)
      throw Error('astra-oscar-actor-changed');
    return binding;
  }
  private operation(turn: OscarTurnV1) { const kind = this.binding(turn).goal.kind;
    return kind === 'computer-observe' || kind === 'computer-action' ? kind
      : kind === 'agent' ? 'agent' as const : kind === 'observe' || kind === 'analyze' ? 'read' as const : 'create' as const; }
  private request(turn: OscarTurnV1): AstraTaskHttpRequest { const binding = this.binding(turn);
    const history = binding.goal.kind === 'agent' ? astraAgentHistoryTail(turn.request.history ?? []) : [];
    return { version: 1, clientRequestId: 'oscar_' + turn.id, conversationId: turn.conversationId,
      inputMessageId: turn.inputMessageId, text: turn.request.text, privacyMode: turn.privacyMode as 'persistent' | 'incognito',
      selectionId: binding.selectionId, ...(history.length ? { history } : {}),
      ...(turn.request.attachmentIds.length ? { attachmentIds: [...turn.request.attachmentIds] } : {}),
      ...(turn.request.telegramActor ? { telegramActor: { ...turn.request.telegramActor,
        requestId: turn.clientRequestId } } : {}),
      ...(turn.request.executionProfile ? { executionProfile: structuredClone(turn.request.executionProfile) } : {}),
      ...(turn.request.explicitAgentTask ? { specification: structuredClone(turn.request.explicitAgentTask) } : {}),
      ...(binding.goal.kind === 'computer-observe' || binding.goal.kind === 'computer-action'
        ? {} : { goal: structuredClone(binding.goal) }) }; }
  private taskId(turn: OscarTurnV1): string {
    const task = this.find(turn); if (!task || turn.taskId && task.id !== turn.taskId) throw Error('astra-oscar-task-missing');
    return task.id;
  }
}

/** One product-facing port with separate durable and memory-only V3 owners. */
export class AstraOscarBridgeRouter implements OscarAstraPort {
  constructor(private readonly persistent: AstraOscarBridge, private readonly incognito: AstraOscarBridge) {}
  private port(turn: OscarTurnV1) { return turn.privacyMode === 'incognito' ? this.incognito : this.persistent; }
  bindAgent(turn: OscarTurnV1) { return this.port(turn).bindAgent(turn); }
  async refreshAgentAvailability(): Promise<void> {
    await Promise.all([this.persistent.refreshAgentAvailability(), this.incognito.refreshAgentAvailability()]);
  }
  bind(turn: OscarTurnV1, selection: OscarAstraSelection, actor?: AstraAuthenticatedHttpActor) {
    return this.port(turn).bind(turn, selection, actor);
  }
  find(turn: OscarTurnV1) { return this.port(turn).find(turn); }
  prepare(turn: OscarTurnV1) { return this.port(turn).prepare(turn); }
  submit(turn: OscarTurnV1, prepared?: unknown) { return this.port(turn).submit(turn, prepared); }
  input(turn: OscarTurnV1, input: OscarAstraInput) { return this.port(turn).input(turn, input); }
  command(turn: OscarTurnV1, command: 'pause' | 'resume' | 'cancel') { return this.port(turn).command(turn, command); }
  wake(turn: OscarTurnV1) { return this.port(turn).wake(turn); }
  acknowledge(turn: OscarTurnV1, digest: string) { return this.port(turn).acknowledge(turn, digest); }
}

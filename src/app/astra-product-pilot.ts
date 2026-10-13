import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AstraJournal } from '../agent-v3/journal';
import { AstraPreparedModelClient } from '../agent-v3/prepared-model-client';
import type { AstraModelHostProvider } from '../agent-v3/model-host-provider';
import { AstraWorkScheduler } from '../agent-v3/work-scheduler';
import type { AstraComputerAction } from '../agent-v3/computer-action-work-adapter';
import type { MonarchKernel } from '../core/kernel';
import { AstraComputerActionPlanStore } from './astra-computer-action-plan-store';
import { AstraComputerSelectionStore, validateAstraWindowChoice, type AstraWindowChoice } from './astra-computer-selection-store';
import { AstraOscarBridge, AstraOscarBridgeRouter } from './astra-oscar-bridge';
import { AstraSourceGoalCompiler } from './astra-source-goal-compiler';
import { MonarchAstraTaskFacade, type AstraAuthenticatedHttpActor } from './astra-task-facade';
import { AstraTargetSelectionStore } from './astra-target-selection-store';
import { preflightAstraPickedTarget } from './astra-target-picker';
import type { AstraTelegramRemotePrincipal } from './astra-telegram-admission';
import type { AstraMemoryRecallAdmission } from '../agent-v3/memory-recall-admission';
import type { AstraModelReadTaskOptions } from '../agent-v3/model-read-task-profile';
import { astraMaxModelLimits } from '../agent-v3/max-provider-contract';
import { maxCloudAgentContextTokens, maxCloudOutputTokens } from '../agent-v3/max-cloud-limits';
import { isAstraAgentExecutionProfile, type AstraAgentTaskPolicy } from '../agent-v3/agent-task-profile';
import type { AstraLocalModelDigests } from './astra-model-host-config';
import { maxCloudPreparedModelDigest, parseCloudRole, type MaxCloudRole } from '../agent-v3/max-cloud-catalog';
import type { AstraLocalAgentModelChoice, AstraMaxModelChoice } from '../agent-v3/source-goal-contract';

export const ASTRA_PRODUCT_PILOT_MODE = 'runtime-same-owner-v1';
type AstraMaxModelDigests = Readonly<Record<string, string>>;
type AstraProductModelHost = { endpoint: string; bearerToken: string; hostGeneration: string; hostPid?: number; hostProvider?: AstraModelHostProvider;
  modelDigest: string; modelDigests: AstraMaxModelDigests; dynamicMaxCloud?: boolean };
type AstraProductLocalModelHost = Omit<AstraProductModelHost, 'modelDigests'> & { modelDigests?: AstraLocalModelDigests };
type AstraProductLocalMemory = { admission: AstraMemoryRecallAdmission;
  gate: NonNullable<AstraModelReadTaskOptions['memory']> };

/** Explicit opt-in runtime-side composition. It deliberately owns no Electron
 * UI or picker: those must cross the authenticated loopback host boundary.
 * When the exact mode is absent this function allocates and writes nothing. */
export function createAstraProductPilotRuntime(options: { mode?: string; canonicalRoot: string;
  stateRoot: string; kernel: MonarchKernel; desktopAttestationToken?: string; hostToken?: string;
  journalEncryptionKey?: Uint8Array;
  modelHost?: AstraProductModelHost; localModelHost?: AstraProductLocalModelHost;
  optionalMaxHost?: AstraProductModelHost;
  localMemory?: AstraProductLocalMemory; maxReady?: () => Promise<boolean> }): AstraProductPilotRuntime | null {
  if (options.mode !== ASTRA_PRODUCT_PILOT_MODE) return null;
  if (!path.isAbsolute(options.stateRoot) || !path.isAbsolute(options.canonicalRoot)
    || typeof options.desktopAttestationToken !== 'string' || options.desktopAttestationToken.length < 32
    || options.desktopAttestationToken.length > 4096 || typeof options.hostToken !== 'string' || options.hostToken.length < 32
    || options.hostToken.length > 4096 || options.journalEncryptionKey?.byteLength !== 32) {
    throw Error('astra-product-pilot:trusted-desktop-required');
  }
  if (options.modelHost && (!/^sha256:[a-f0-9]{64}$/u.test(options.modelHost.modelDigest)
    || typeof options.modelHost.bearerToken !== 'string' || options.modelHost.bearerToken.length < 32
    || options.modelHost.dynamicMaxCloud !== undefined && options.modelHost.dynamicMaxCloud !== true
    || !validMaxModelDigests(options.modelHost.modelDigests, options.modelHost.dynamicMaxCloud === true)
    || !Object.values(options.modelHost.modelDigests).includes(options.modelHost.modelDigest))) {
    throw Error('astra-product-pilot:model-host');
  }
  return new AstraProductPilotRuntime({ mode: ASTRA_PRODUCT_PILOT_MODE, canonicalRoot: options.canonicalRoot,
    stateRoot: options.stateRoot, kernel: options.kernel,
    desktopAttestationToken: options.desktopAttestationToken, hostToken: options.hostToken,
    journalEncryptionKey: options.journalEncryptionKey,
    ...(options.modelHost ? { modelHost: options.modelHost } : {}),
    ...(options.optionalMaxHost ? { optionalMaxHost: options.optionalMaxHost } : {}),
    ...(options.localModelHost ? { localModelHost: options.localModelHost } : {}),
    ...(options.localMemory ? { localMemory: options.localMemory } : {}),
    ...(options.maxReady ? { maxReady: options.maxReady } : {}), includeIncognito: true });
}

export class AstraProductPilotRuntime {
  readonly maxModelConfigured: boolean;
  readonly localAgentModels: ReadonlyArray<AstraLocalAgentModelChoice>;
  readonly journal: AstraJournal;
  readonly selections: AstraTargetSelectionStore;
  readonly computerSelections: AstraComputerSelectionStore;
  readonly computerActionPlans: AstraComputerActionPlanStore;
  readonly facade: MonarchAstraTaskFacade;
  readonly scheduler: AstraWorkScheduler;
  readonly bridge: AstraOscarBridge | AstraOscarBridgeRouter;
  readonly actor: AstraAuthenticatedHttpActor;
  readonly coderActor: AstraAuthenticatedHttpActor;
  readonly voiceActor: AstraAuthenticatedHttpActor;
  readonly systemActor: AstraAuthenticatedHttpActor;
  private closed = false;
  private readonly hostToken: Buffer;
  private readonly actorBindingKey: Buffer;
  private readonly canonicalRoot: string;
  private readonly kernel: MonarchKernel;
  private readonly incognitoRuntime?: AstraProductPilotRuntime;
  private readonly computerCandidates = new Map<string, { actor: AstraAuthenticatedHttpActor; conversationId: string;
    requestId: string; candidates: AstraWindowChoice[]; expiresAt: number; expirationTimer: NodeJS.Timeout }>();

  constructor(options: { mode: typeof ASTRA_PRODUCT_PILOT_MODE; canonicalRoot: string;
    stateRoot: string; kernel: MonarchKernel; desktopAttestationToken: string; hostToken: string;
    journalEncryptionKey: Uint8Array;
    modelHost?: AstraProductModelHost; optionalMaxHost?: AstraProductModelHost; localModelHost?: AstraProductLocalModelHost;
    localMemory?: AstraProductLocalMemory; includeIncognito?: boolean; volatile?: boolean;
    maxReady?: () => Promise<boolean> }) {
    // Validate exclusive destinations before allocating state. A local memory
    // gate must never be inherited by a cloud-configured host.
    if (options.localModelHost && options.modelHost || options.localMemory && !options.localModelHost) {
      throw Error('astra-product-pilot:model-destination-conflict');
    }
    const local = options.localModelHost;
    const max = options.optionalMaxHost ?? options.modelHost;
    this.maxModelConfigured = Boolean(max);
    const localDigests = local?.modelDigests ? Object.values(local.modelDigests) : local ? [local.modelDigest] : [];
    if (local && max && localDigests.some(digest => Object.values(max.modelDigests).includes(digest)))
      throw Error('astra-product-pilot:model-digest-overlap');
    if (options.optionalMaxHost && (options.modelHost
      || options.optionalMaxHost.dynamicMaxCloud !== undefined && options.optionalMaxHost.dynamicMaxCloud !== true
      || !validMaxModelDigests(options.optionalMaxHost.modelDigests, options.optionalMaxHost.dynamicMaxCloud === true)
      || !Object.values(options.optionalMaxHost.modelDigests).includes(options.optionalMaxHost.modelDigest))) {
      throw Error('astra-product-pilot:optional-max-host');
    }
    if (local && (!/^sha256:[a-f0-9]{64}$/u.test(local.modelDigest)
      || typeof local.bearerToken !== 'string' || local.bearerToken.length < 32
      || local.modelDigests !== undefined && !validLocalModelDigests(local.modelDigests, local.modelDigest)))
      throw Error('astra-product-pilot:local-model-host');
    if (options.localMemory && (options.localMemory.gate?.destination !== 'local-desktop'
      || options.localMemory.gate.modelDigest !== local!.modelDigest || typeof options.localMemory.gate.readValidity !== 'function'
      || typeof options.localMemory.gate.isCurrent !== 'function'
      || typeof options.localMemory.admission?.prepare !== 'function' || typeof options.localMemory.admission?.isAdmissible !== 'function'
      || typeof options.localMemory.admission?.isPolicyCurrent !== 'function')) {
      throw Error('astra-product-pilot:local-memory-binding');
    }
    const modelHost = local ?? options.modelHost;
    const modelClient = modelHost ? new AstraPreparedModelClient({ deployment: 'isolated-validation',
      endpoint: modelHost.endpoint, bearerToken: modelHost.bearerToken, hostGeneration: modelHost.hostGeneration,
      ...(modelHost.hostProvider ? { hostProvider: modelHost.hostProvider } : {}) }) : undefined;
    const maxClient = options.optionalMaxHost ? new AstraPreparedModelClient({ deployment: 'isolated-validation',
      endpoint: options.optionalMaxHost.endpoint, bearerToken: options.optionalMaxHost.bearerToken,
      hostGeneration: options.optionalMaxHost.hostGeneration, timeoutMs: 610_000,
      ...(options.optionalMaxHost.hostProvider ? { hostProvider: options.optionalMaxHost.hostProvider } : {}) }) : undefined;
    const primaryClient = modelClient ?? maxClient;
    this.hostToken = Buffer.from(options.hostToken);
    this.canonicalRoot = options.canonicalRoot;
    this.kernel = options.kernel;
    const scopeId = options.volatile ? 'product_incognito' : 'product_pilot';
    const directory = path.join(options.stateRoot, 'astra-v3', 'same-owner-pilot');
    if (!options.volatile) mkdirSync(directory, { recursive: true });
    this.journal = options.volatile ? new AstraJournal(':memory:') : new AstraJournal(path.join(directory, 'journal.sqlite'), {
      encryptionKey: options.journalEncryptionKey, upgradeFromV2: true });
    // The desktop attestation token intentionally rotates on every Electron
    // process. Persistent actor identity must instead survive that rotation so
    // an exact journal-bound Turn can resume after a restart. Incognito keeps
    // the session token as its deliberately ephemeral root.
    const actorRoot = options.volatile
      ? Buffer.from(options.desktopAttestationToken)
      : Buffer.from(options.journalEncryptionKey);
    this.actorBindingKey = createHmac('sha256', actorRoot)
      .update('monarch.astra-v3.actor-binding-root.v2').digest();
    actorRoot.fill(0);
    this.actor = { source: 'desktop', id: 'sha256:' + createHmac('sha256', this.actorBindingKey)
      .update(`monarch.astra-v3.http-actor.v1/desktop${options.volatile ? '/incognito' : ''}`).digest('hex') };
    this.coderActor = { source: 'coder', id: 'sha256:' + createHmac('sha256', this.actorBindingKey)
      .update('monarch.astra-v3.http-actor.v1/coder').digest('hex') };
    this.voiceActor = { source: 'voice', id: 'sha256:' + createHmac('sha256', this.actorBindingKey)
      .update('monarch.astra-v3.http-actor.v1/voice').digest('hex') };
    this.systemActor = { source: 'system', id: 'sha256:' + createHmac('sha256', this.actorBindingKey)
      .update('monarch.astra-v3.http-actor.v1/system').digest('hex') };
    let sourceChanged = () => {};
    this.selections = new AstraTargetSelectionStore({ deployment: 'isolated-validation', journal: this.journal,
      scopeId: 'product_pilot_targets', canonicalRoot: options.canonicalRoot, onRevoked: () => sourceChanged() });
    this.computerSelections = new AstraComputerSelectionStore({ deployment: 'isolated-validation', journal: this.journal,
      scopeId: 'product_pilot_windows', onRevoked: () => sourceChanged() });
    this.computerActionPlans = new AstraComputerActionPlanStore({ deployment: 'isolated-validation', journal: this.journal,
      scopeId: 'product_pilot_actions', onRevoked: () => sourceChanged() });
    const gptLimits = astraMaxModelLimits('openai/gpt-oss-120b');
    const qwenLimits = astraMaxModelLimits('qwen/qwen3.8-27b');
    const gptMaxContextLimits = { hardTokens: gptLimits.contextWindowTokens,
      softTokens: 114_688, rearmTokens: 98_304, reservedOutputTokens: gptLimits.maxOutputTokens,
      hardBytes: 512 * 1024, tokenizerTimeoutMs: 10_000 };
    const qwenMaxContextLimits = { hardTokens: qwenLimits.contextWindowTokens,
      softTokens: 114_688, rearmTokens: 98_304, reservedOutputTokens: qwenLimits.maxOutputTokens,
      hardBytes: 512 * 1024, tokenizerTimeoutMs: 10_000 };
    const gptAgentPolicy = { modelId: 'gpt-oss-120b', expectedModelDigest: max?.modelDigests['openai/gpt-oss-120b'] ?? 'sha256:' + '0'.repeat(64),
      maxOutputTokens: gptLimits.maxOutputTokens, modelTimeoutMs: 600_000, maxModelAttempts: 1,
      maxModelTurns: 64, maxCapabilityCalls: 48, contextLimits: gptMaxContextLimits };
    const qwenAgentPolicy = { modelId: 'qwen-3.8-27b', expectedModelDigest: max?.modelDigests['qwen/qwen3.8-27b'] ?? 'sha256:' + '0'.repeat(64),
      maxOutputTokens: qwenLimits.maxOutputTokens, modelTimeoutMs: 600_000, maxModelAttempts: 1,
      maxModelTurns: 64, maxCapabilityCalls: 48, contextLimits: qwenMaxContextLimits };
    const cloudAgentPolicy = (choice: AstraMaxModelChoice) => {
      const cloud = parseCloudRole(choice); if (!cloud || cloud.providerId === 'groq' || !max?.dynamicMaxCloud) return undefined;
      // Read per task: the person's Settings → MAX limits apply without a restart.
      const contextTokens = maxCloudAgentContextTokens(), outputTokens = maxCloudOutputTokens(choice);
      return { modelId: choice, expectedModelDigest: maxCloudPreparedModelDigest(choice as MaxCloudRole), maxOutputTokens: outputTokens,
        modelTimeoutMs: 600_000, maxModelAttempts: 1, maxModelTurns: 64, maxCapabilityCalls: 48,
        // Same window as the prepared host; a smaller policy cap stopped DeepSeek agents after one effect.
        contextLimits: { hardTokens: contextTokens, softTokens: contextTokens * 3 / 4,
          rearmTokens: contextTokens * 5 / 8, reservedOutputTokens: outputTokens,
          // Four uncompactable recent rounds (newest up to 24 KB, each written
          // file echoed in its args) plus a long request overflowed the window
          // live after seven files. Receipts stay mandatory, so the model still
          // knows every file it wrote once older rounds are compacted.
          recentNarrativeItems: 2,
          hardBytes: 2 * contextTokens, tokenizerTimeoutMs: 10_000 } } satisfies AstraAgentTaskPolicy;
    };
    const maxAgentPolicies: Partial<Record<AstraMaxModelChoice, AstraAgentTaskPolicy>> = {};
    if (max?.modelDigests['openai/gpt-oss-120b']) maxAgentPolicies['gpt-oss-120b'] = gptAgentPolicy;
    if (max?.modelDigests['qwen/qwen3.8-27b']) maxAgentPolicies['qwen-3.8-27b'] = qwenAgentPolicy;
    for (const [role] of Object.entries(max?.modelDigests ?? {})) {
      if (!cloudAgentPolicy(role as AstraMaxModelChoice)) continue;
      // A getter keeps the policy current when the person changes the limits.
      Object.defineProperty(maxAgentPolicies, role, { enumerable: true, configurable: true,
        get: () => cloudAgentPolicy(role as AstraMaxModelChoice) });
    }
    const primaryMaxRole = Object.entries(max?.modelDigests ?? {}).find(([, digest]) => digest === max?.modelDigest)?.[0];
    const defaultMaxModel: AstraMaxModelChoice | undefined = primaryMaxRole === 'openai/gpt-oss-120b' ? 'gpt-oss-120b'
      : primaryMaxRole === 'qwen/qwen3.8-27b' ? 'qwen-3.8-27b'
        : parseCloudRole(primaryMaxRole) ? primaryMaxRole as AstraMaxModelChoice : undefined;
    // Gemma Fast/Balanced are resident with a 4096-token llama.cpp context.
    // One Agent turn emits one structured decision, so reserve 1024 tokens and
    // leave the remaining window to the live catalog, goal and observations.
    const localAgentPolicy = { modelId: 'local-agent', expectedModelDigest: local?.modelDigest ?? 'sha256:' + '0'.repeat(64),
      maxOutputTokens: 1024, modelTimeoutMs: 120_000, maxModelAttempts: 2, maxModelTurns: 24, maxCapabilityCalls: 16,
      contextLimits: { tokenizerTimeoutMs: 10_000, recentNarrativeItems: 0 } };
    const localAgentPolicies: Partial<Record<AstraLocalAgentModelChoice, AstraAgentTaskPolicy>> = {};
    if (local?.modelDigests?.['gemma4-balanced']) localAgentPolicies['gemma4-balanced'] = {
      modelId: 'gemma4-balanced', expectedModelDigest: local.modelDigests['gemma4-balanced'], maxOutputTokens: 1024,
      modelTimeoutMs: 120_000, maxModelAttempts: 2, maxModelTurns: 48, maxCapabilityCalls: 32,
      // Kernel receipts are mandatory and remain available; full action/result
      // bodies are optional replay detail. On the 4K resident, compact all of
      // that optional detail under pressure instead of terminating a long task.
      contextLimits: { tokenizerTimeoutMs: 10_000, recentNarrativeItems: 0 } };
    if (local?.modelDigests?.['qwen3-coder-30b-a3b-instruct']) localAgentPolicies['qwen3-coder-30b-a3b-instruct'] = {
      modelId: 'qwen3-coder-30b-a3b-instruct', expectedModelDigest: local.modelDigests['qwen3-coder-30b-a3b-instruct'],
      maxOutputTokens: 4096, modelTimeoutMs: 120_000, maxModelAttempts: 2, maxModelTurns: 64, maxCapabilityCalls: 48,
      contextLimits: { tokenizerTimeoutMs: 10_000 } };
    if (local?.modelDigests?.['deepseek-coder-v2-lite-instruct']) localAgentPolicies['deepseek-coder-v2-lite-instruct'] = {
      modelId: 'deepseek-coder-v2-lite-instruct', expectedModelDigest: local.modelDigests['deepseek-coder-v2-lite-instruct'],
      maxOutputTokens: 4096, modelTimeoutMs: 120_000, maxModelAttempts: 2, maxModelTurns: 64, maxCapabilityCalls: 48,
      contextLimits: { tokenizerTimeoutMs: 10_000 } };
    // Ordinary local agent work defaults to the same Gemma tier the chat keeps
    // resident. Preferring a Coder model here made the agent ask for a different
    // tier than the resident chat model on every ordinary turn, so load_tier had
    // to release and reload inside the live CUDA process. Coder models stay
    // selectable by exact request; they are no longer an implicit default.
    const defaultLocalModel: AstraLocalAgentModelChoice | undefined = localAgentPolicies['gemma4-balanced']
      ? 'gemma4-balanced' : localAgentPolicies['qwen3-coder-30b-a3b-instruct']
        ? 'qwen3-coder-30b-a3b-instruct' : localAgentPolicies['deepseek-coder-v2-lite-instruct']
          ? 'deepseek-coder-v2-lite-instruct' : undefined;
    this.localAgentModels = Object.freeze(Object.keys(localAgentPolicies) as AstraLocalAgentModelChoice[]);
    const agentCatalogKey = primaryClient ? createHmac('sha256', Buffer.from(options.journalEncryptionKey))
      .update('monarch.astra-v3.generic-agent-catalog.v1').digest() : undefined;
    this.facade = new MonarchAstraTaskFacade({ deployment: 'isolated-validation', canonicalRoot: options.canonicalRoot,
      scopeId, journal: this.journal, kernel: options.kernel,
      ...(options.volatile ? { privacyMode: 'incognito' as const } : {}),
      computerCatalog: this.computerSelections, computerActionCatalog: this.computerActionPlans,
      sourceCompiler: new AstraSourceGoalCompiler(this.selections), requiredInputs: true, literalApprovals: true,
      compositeApprovals: true, referenceInputs: true,
      desktopCreateConfirmation: 'kernel',
      ...(local ? { localAnalysis: true } : {}),
      ...(options.localMemory ? { memory: options.localMemory.gate,
        memoryPolicyCurrent: (revision: string) => options.localMemory!.admission.isPolicyCurrent(revision) } : {}),
      ...(options.modelHost ? { requiredModelMode: 'max' as const } : {}),
      ...(options.optionalMaxHost && maxClient ? { optionalMax: true, modelClients: Object.freeze(Object.fromEntries(
        Object.values(options.optionalMaxHost.modelDigests).map(digest => [digest, maxClient]))) } : {}),
      ...(primaryClient && agentCatalogKey ? { genericAgent: { catalogKey: agentCatalogKey,
        policy: local ? localAgentPolicy : maxAgentPolicies[defaultMaxModel ?? 'gpt-oss-120b'] ?? gptAgentPolicy,
        ...(Object.keys(localAgentPolicies).length ? { localPolicies: localAgentPolicies } : {}),
        ...(Object.keys(maxAgentPolicies).length ? { maxPolicies: maxAgentPolicies } : {}),
        ...(max?.dynamicMaxCloud && maxClient ? { dynamicMaxClient: maxClient, dynamicMaxPolicy: cloudAgentPolicy } : {}) } } : {}),
      ...(max?.modelDigests['openai/gpt-oss-120b'] && max.modelDigests['qwen/qwen3.8-27b'] ? { maxModelPolicies: {
        'gpt-oss-120b': { expectedModelDigest: max.modelDigests['openai/gpt-oss-120b'],
          maxOutputTokens: gptLimits.maxOutputTokens, modelTimeoutMs: 600_000, maxModelAttempts: 1,
          contextLimits: gptMaxContextLimits },
        'qwen-3.8-27b': { expectedModelDigest: max.modelDigests['qwen/qwen3.8-27b'],
          maxOutputTokens: qwenLimits.maxOutputTokens, modelTimeoutMs: 600_000, maxModelAttempts: 1,
          contextLimits: qwenMaxContextLimits },
      } } : {}),
      client: primaryClient
        ? primaryClient
        : new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: 'http://127.0.0.1:1',
          bearerToken: options.desktopAttestationToken, hostGeneration: 'product_same_owner_pilot',
          fetch: async () => { throw Error('astra-product-pilot:model-host-not-attached'); } }),
      policy: { expectedModelDigest: (modelHost ?? options.optionalMaxHost)?.modelDigest ?? 'sha256:' + '0'.repeat(64), maxOutputTokens: local ? 1024 : 256,
        modelTimeoutMs: local ? 120000 : 5000, contextLimits: { tokenizerTimeoutMs: local ? 10000 : 1000 } } });
    agentCatalogKey?.fill(0);
    this.scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation', scopeId,
      journal: this.journal, adapters: this.facade.adapters,
      ...(this.facade.adapters.length === this.facade.legacyAdapters.length ? {}
        : { upgradeFromAdapterSets: [this.facade.legacyAdapters] }) });
    this.facade.attach(this.scheduler);
    this.bridge = new AstraOscarBridge(this.facade, turn => {
      if (turn.privacyMode !== (options.volatile ? 'incognito' : 'persistent')) throw Error('astra-product-pilot:privacy-owner');
      if (turn.source === 'desktop') return structuredClone(this.actor);
      if (turn.source === 'coder' && isAstraAgentExecutionProfile(turn.request.executionProfile)) return structuredClone(this.coderActor);
      if (turn.source === 'voice') return structuredClone(this.voiceActor);
      if (turn.source === 'system') return structuredClone(this.systemActor);
      if (turn.source === 'api' && turn.request.authenticatedAgentActor?.source === 'api') {
        return structuredClone(turn.request.authenticatedAgentActor);
      }
      if (turn.source === 'api' && turn.request.astra?.actor.source === 'api') {
        return structuredClone(turn.request.astra.actor);
      }
      if (turn.source === 'telegram' && turn.request.telegramActor) {
        const telegram = turn.request.telegramActor;
        const identity = [telegram.ownerUserId, telegram.controlChatId, telegram.botId,
          telegram.threadId, telegram.pairingEpoch].map(String);
        const hmac = createHmac('sha256', this.actorBindingKey)
          .update('monarch.astra-v3.ordinary-telegram-actor.v1');
        for (const part of identity) hmac.update(String(Buffer.byteLength(part))).update(':').update(part).update('|');
        return { source: 'telegram', id: 'sha256:' + hmac.digest('hex') };
      }
      const binding = turn.source === 'telegram' ? turn.request.astra : undefined;
      if (!binding || binding.actor.source !== 'telegram'
        || !this.selections.owns(binding.selectionId, { actor: binding.actor, conversationId: turn.conversationId })) {
        throw Error('astra-product-pilot:telegram-actor-unavailable');
      }
      return structuredClone(binding.actor);
    }, { ...(options.volatile ? { privacyMode: 'incognito' as const } : {}),
      ...(this.facade.agentTasks ? { genericAgent: { local: Boolean(local), max: Boolean(max),
        ...(options.maxReady ? { maxReady: options.maxReady } : {}),
        ...(defaultMaxModel ? { defaultMaxModel } : {}),
        ...(defaultLocalModel ? { defaultLocalModel } : {}),
        ...(Object.keys(localAgentPolicies).length ? { localModels: Object.keys(localAgentPolicies) as AstraLocalAgentModelChoice[] } : {}) } } : {}),
      ...(options.optionalMaxHost ? { optionalMax: true } : {}),
      ...(options.modelHost ? { requiredModelMode: 'max' as const } : {
      ...(local ? { localAnalysis: true } : {}),
      ...(options.localMemory ? { memoryAdmission: options.localMemory.admission } : {}) }) });
    if (options.includeIncognito && !options.volatile && primaryClient) {
      const { localMemory: _persistentMemory, ...volatileOptions } = options;
      this.incognitoRuntime = new AstraProductPilotRuntime({ ...volatileOptions, includeIncognito: false, volatile: true });
      this.bridge = new AstraOscarBridgeRouter(this.bridge as AstraOscarBridge,
        this.incognitoRuntime.bridge as AstraOscarBridge);
    }
    sourceChanged = () => this.facade.notifySourceChange();
  }

  async startWithSourceRestore(restore: () => Promise<void>): Promise<void> {
    await this.facade.startWithSourceRestore(restore);
    await this.incognitoRuntime?.facade.startWithSourceRestore(async () => undefined);
  }

  async drain(): Promise<void> {
    await this.facade.drain();
    await this.incognitoRuntime?.facade.drain();
  }

  notifySourceChange(): void {
    this.facade.notifySourceChange();
    this.incognitoRuntime?.facade.notifySourceChange();
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await this.incognitoRuntime?.stop(); await this.facade.stop(); } finally {
      for (const key of [...this.computerCandidates.keys()]) this.removeComputerCandidates(key);
      this.journal.close(); this.actorBindingKey.fill(0); this.hostToken.fill(0);
    }
  }

  authenticateHostToken(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const candidate = Buffer.from(value); return candidate.length === this.hostToken.length && timingSafeEqual(candidate, this.hostToken);
  }

  issuePickedTarget(actor: AstraAuthenticatedHttpActor, raw: unknown) {
    if (actor.source !== 'desktop' || actor.id !== this.actor.id || !raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 5 || Object.keys(raw).some(key => !['version', 'conversationId', 'requestId', 'access',
        'selectedPath', 'selectedPaths'].includes(key)))
      throw Object.assign(Error('astra-product-pilot:host-request'), { statusCode: 403, code: 'astra-product-pilot-host-request' });
    const request = raw as { version: unknown; conversationId: unknown; requestId: unknown; access: unknown;
      selectedPath?: unknown; selectedPaths?: unknown };
    if (request.version !== 1 || typeof request.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(request.conversationId)
      || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,91}$/u.test(request.requestId)
      || !['observe', 'exclusive-create'].includes(String(request.access)))
      throw Object.assign(Error('astra-product-pilot:host-request'), { statusCode: 400, code: 'astra-product-pilot-host-request' });
    const access = request.access as 'observe' | 'exclusive-create';
    const selectedPaths = access === 'observe'
      ? Array.isArray(request.selectedPaths) ? request.selectedPaths : typeof request.selectedPath === 'string' ? [request.selectedPath] : []
      : typeof request.selectedPath === 'string' && request.selectedPaths === undefined ? [request.selectedPath] : [];
    if (selectedPaths.length < 1 || selectedPaths.length > (access === 'observe' ? 8 : 1)
      || !selectedPaths.every(value => typeof value === 'string')
      || new Set(selectedPaths.map(value => path.normalize(value as string).toLowerCase())).size !== selectedPaths.length)
      throw Object.assign(Error('astra-product-pilot:host-request'), { statusCode: 400, code: 'astra-product-pilot-host-request' });
    const targets = selectedPaths.map((selectedPath, index) => ({ ...preflightAstraPickedTarget({ canonicalRoot: this.canonicalRoot,
      selectedPath: selectedPath as string, access, maxReadBytes: 65_536, maxCreateBytes: 16_384, timeoutMs: 5000 }),
      id: selectedPaths.length === 1 ? 'picked' : 'picked_' + index }));
    const snapshot = this.selections.issue({ actor, conversationId: request.conversationId, requestId: 'host_' + request.requestId,
      targets, ttlMs: 3_600_000 });
    const descriptor = this.selections.list({ actor, conversationId: request.conversationId }).find(item => item.selectionId === snapshot.selectionId);
    if (!descriptor) throw Error('astra-product-pilot:selection-projection'); return descriptor;
  }

  /** Trusted local host grants one already paired remote actor read-only access
   * to one explicitly picked workspace target. The returned alias carries no
   * path and is useless for another actor/conversation or after expiry/revoke. */
  issueTelegramTargetAlias(
    hostActor: AstraAuthenticatedHttpActor,
    principal: AstraTelegramRemotePrincipal,
    raw: unknown,
  ): { targetAlias: string; expiresAt: number; authority: 'read-only'; authorizesCreate: false; authorizesComputer: false } {
    this.assertDesktopActor(hostActor);
    this.assertTelegramPrincipal(principal);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 4
      || Object.keys(raw).some((key) => !['version', 'requestId', 'selectedPath', 'ttlMs'].includes(key))) {
      throw Object.assign(Error('astra-product-pilot:telegram-alias-request'),
        { statusCode: 400, code: 'astra-product-pilot-telegram-alias-request' });
    }
    const request = raw as { version: unknown; requestId: unknown; selectedPath: unknown; ttlMs: unknown };
    if (request.version !== 1 || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(request.requestId)
      || typeof request.selectedPath !== 'string' || !Number.isSafeInteger(request.ttlMs)
      || Number(request.ttlMs) < 60_000 || Number(request.ttlMs) > 3_600_000) {
      throw Object.assign(Error('astra-product-pilot:telegram-alias-request'),
        { statusCode: 400, code: 'astra-product-pilot-telegram-alias-request' });
    }
    const target = preflightAstraPickedTarget({ canonicalRoot: this.canonicalRoot,
      selectedPath: request.selectedPath, access: 'observe', maxReadBytes: 65_536, maxCreateBytes: 0, timeoutMs: 5_000 });
    const snapshot = this.selections.issue({ actor: principal.actor, conversationId: principal.conversationId,
      requestId: `telegram_${request.requestId}`, targets: [target], ttlMs: Number(request.ttlMs) });
    const descriptor = this.selections.list(principal)
      .find((entry) => entry.selectionId === snapshot.selectionId);
    if (!descriptor) throw Error('astra-product-pilot:telegram-alias-projection');
    return { targetAlias: `astra_remote_alias_${snapshot.selectionId.slice('selection_'.length)}`,
      expiresAt: descriptor.expiresAt, authority: 'read-only', authorizesCreate: false, authorizesComputer: false };
  }

  selectionIdForTelegramAlias(targetAlias: unknown, principal: AstraTelegramRemotePrincipal): string {
    this.assertTelegramPrincipal(principal);
    if (typeof targetAlias !== 'string' || !/^astra_remote_alias_[a-f0-9]{32}$/u.test(targetAlias)) {
      throw Object.assign(Error('astra-product-pilot:telegram-alias-unavailable'),
        { statusCode: 404, code: 'astra-product-pilot-telegram-alias-unavailable' });
    }
    const selectionId = `selection_${targetAlias.slice('astra_remote_alias_'.length)}`;
    if (!this.selections.list(principal).some((entry) => entry.selectionId === selectionId)) {
      throw Object.assign(Error('astra-product-pilot:telegram-alias-unavailable'),
        { statusCode: 404, code: 'astra-product-pilot-telegram-alias-unavailable' });
    }
    return selectionId;
  }

  async listComputerCandidates(actor: AstraAuthenticatedHttpActor, raw: unknown) {
    this.assertDesktopActor(actor); const request = this.computerCandidateRequest(raw);
    const now = Date.now(); this.pruneComputerCandidates(now);
    const prior = [...this.computerCandidates.entries()].find(([, item]) => item.actor.id === actor.id
      && item.conversationId === request.conversationId && item.requestId === request.requestId && item.expiresAt > now);
    if (prior) return this.projectComputerCandidates(prior[0], prior[1]);
    if (this.computerCandidates.size >= 2) throw Object.assign(Error('astra-product-pilot:computer-candidate-capacity'),
      { statusCode: 429, code: 'astra-product-pilot-computer-candidate-capacity' });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort('astra-product-window-list-timeout'), 10_000);
    try {
      const startedAt = Date.now();
      const invocationId = 'product_window_list_' + randomBytes(16).toString('hex');
      const proposal = this.kernel.prepareActionProposal({ capabilityId: 'computer.windows.list', proposalId: invocationId,
        args: { limit: 32 }, reason: 'Explicit Astra product native window picker; metadata only.' },
      { requestedBy: 'user:astra-product-window-picker', intentId: invocationId });
      const returned = await this.kernel.executeActionProposal(proposal,
        { requestedBy: 'user:astra-product-window-picker', intentId: invocationId, source: 'desktop', signal: controller.signal });
      const output = returned.result.output as { verified?: boolean; observedAt?: string; windows?: unknown[] } | undefined;
      const windows = output?.windows;
      const observedAt = typeof output?.observedAt === 'string' ? Date.parse(output.observedAt) : NaN;
      const invalid = { proposal: returned.proposal.canonicalHash !== proposal.canonicalHash, result: !returned.result.ok,
        verified: output?.verified !== true, time: !Number.isFinite(observedAt) || observedAt < startedAt || observedAt > Date.now() + 1000,
        windows: !Array.isArray(windows) || windows.length > 32 };
      if (Object.values(invalid).some(Boolean))
        throw Object.assign(Error('astra-product-pilot:computer-enumeration-unavailable:' + Object.entries(invalid)
          .filter(([, failed]) => failed).map(([name]) => name).join(',')
          + ':' + String(returned.result.userFacing?.code || returned.result.error || 'invalid-receipt')), { statusCode: 409,
          code: 'astra-product-pilot-computer-enumeration-unavailable' });
      const candidates = (windows as unknown[]).map(rawWindow => {
        const value = rawWindow as AstraWindowChoice, item = { windowRef: value.windowRef, processId: value.processId,
          processInstanceId: value.processInstanceId, title: value.title, processName: value.processName };
        validateAstraWindowChoice(item); return item;
      });
      if (new Set(candidates.map(item => item.windowRef)).size !== candidates.length)
        throw Object.assign(Error('astra-product-pilot:duplicate-window'), { statusCode: 409, code: 'astra-product-pilot-duplicate-window' });
      const candidateSetId = 'window_candidates_' + randomBytes(16).toString('hex');
      const expiresAt = Date.now() + 60_000;
      const item = { actor: structuredClone(actor), conversationId: request.conversationId, requestId: request.requestId,
        candidates, expiresAt, expirationTimer: undefined as unknown as NodeJS.Timeout };
      item.expirationTimer = setTimeout(() => this.removeComputerCandidates(candidateSetId), Math.max(1, expiresAt - Date.now()));
      item.expirationTimer.unref();
      this.computerCandidates.set(candidateSetId, item); return this.projectComputerCandidates(candidateSetId, item);
    } finally { clearTimeout(timer); }
  }

  issueComputerWindow(actor: AstraAuthenticatedHttpActor, raw: unknown) {
    this.assertDesktopActor(actor);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 5
      || Object.keys(raw).some(key => !['version', 'conversationId', 'requestId', 'candidateSetId', 'index'].includes(key)))
      throw Object.assign(Error('astra-product-pilot:computer-selection-request'), { statusCode: 400, code: 'astra-product-pilot-computer-selection-request' });
    const request = raw as { version: unknown; conversationId: unknown; requestId: unknown; candidateSetId: unknown; index: unknown };
    if (request.version !== 1 || typeof request.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(request.conversationId)
      || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(request.requestId)
      || typeof request.candidateSetId !== 'string' || !/^window_candidates_[a-f0-9]{32}$/u.test(request.candidateSetId)
      || !Number.isSafeInteger(request.index))
      throw Object.assign(Error('astra-product-pilot:computer-selection-request'), { statusCode: 400, code: 'astra-product-pilot-computer-selection-request' });
    const principal = { actor, conversationId: request.conversationId };
    const prior = this.computerSelections.findIssued(request.requestId, principal); if (prior) return prior;
    this.pruneComputerCandidates(Date.now()); const item = this.computerCandidates.get(request.candidateSetId);
    if (!item || item.actor.id !== actor.id || item.actor.source !== actor.source || item.conversationId !== request.conversationId
      || !Number.isSafeInteger(request.index) || Number(request.index) < 0 || Number(request.index) >= item.candidates.length)
      throw Object.assign(Error('astra-product-pilot:computer-candidate-unavailable'), { statusCode: 409,
        code: 'astra-product-pilot-computer-candidate-unavailable' });
    const selection = this.computerSelections.issue({ actor, conversationId: request.conversationId, requestId: request.requestId,
      window: item.candidates[Number(request.index)]!, ttlMs: 120_000, timeoutMs: 5000 },
    () => this.computerCandidates.get(request.candidateSetId as string) === item && item.expiresAt > Date.now());
    this.removeComputerCandidates(request.candidateSetId); return selection;
  }

  async issueComputerActionPlan(actor: AstraAuthenticatedHttpActor, raw: unknown, flushOutbox: () => Promise<void>) {
    this.assertDesktopActor(actor);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 5
      || Object.keys(raw).some(key => !['version', 'conversationId', 'requestId', 'taskId', 'action'].includes(key)))
      throw Object.assign(Error('astra-product-pilot:computer-action-request'), { statusCode: 400, code: 'astra-product-pilot-computer-action-request' });
    const request = raw as { version: unknown; conversationId: unknown; requestId: unknown; taskId: unknown; action: unknown };
    if (request.version !== 1 || typeof request.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(request.conversationId)
      || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(request.requestId)
      || typeof request.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(request.taskId)
      || !request.action || typeof request.action !== 'object' || Array.isArray(request.action))
      throw Object.assign(Error('astra-product-pilot:computer-action-request'), { statusCode: 400, code: 'astra-product-pilot-computer-action-request' });
    await flushOutbox(); const seed = this.facade.computerActionSeed(actor, request.conversationId, request.taskId);
    const computer = this.kernel.getModule('computer') as { hasFreshObservation?(value: typeof seed.observation): boolean } | undefined;
    if (!computer?.hasFreshObservation || !computer.hasFreshObservation(seed.observation))
      throw Object.assign(Error('astra-product-pilot:computer-observation-not-fresh'), { statusCode: 409,
        code: 'astra-product-pilot-computer-observation-not-fresh' });
    return this.computerActionPlans.issue({ actor, conversationId: request.conversationId, requestId: request.requestId,
      source: seed.source, observation: seed.observation, action: request.action as AstraComputerAction, ttlMs: 90_000, timeoutMs: 5000 },
    () => computer.hasFreshObservation!(seed.observation));
  }

  controlComputerWindows(actor: AstraAuthenticatedHttpActor, raw: unknown) {
    const request = this.computerCatalogRequest(actor, raw, 'window');
    if (request.kind === 'revoke') this.computerSelections.revoke(request.selectionId, request);
    return this.computerSelections.list(request);
  }

  controlComputerActionPlans(actor: AstraAuthenticatedHttpActor, raw: unknown) {
    const request = this.computerCatalogRequest(actor, raw, 'action');
    if (request.kind === 'revoke') this.computerActionPlans.revoke(request.selectionId, request);
    return this.computerActionPlans.list(request);
  }

  private assertDesktopActor(actor: AstraAuthenticatedHttpActor): void {
    if (actor.source !== 'desktop' || actor.id !== this.actor.id)
      throw Object.assign(Error('astra-product-pilot:desktop-principal'), { statusCode: 403, code: 'astra-product-pilot-desktop-principal' });
  }
  private assertTelegramPrincipal(principal: AstraTelegramRemotePrincipal): void {
    if (!principal || Object.keys(principal).length !== 2
      || !principal.actor || Object.keys(principal.actor).length !== 2
      || principal.actor.source !== 'telegram' || !/^sha256:[a-f0-9]{64}$/u.test(principal.actor.id)
      || !/^telegram_remote_[a-f0-9]{48}$/u.test(principal.conversationId)) {
      throw Object.assign(Error('astra-product-pilot:telegram-principal'),
        { statusCode: 403, code: 'astra-product-pilot-telegram-principal' });
    }
  }
  private computerCandidateRequest(raw: unknown): { conversationId: string; requestId: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 3
      || Object.keys(raw).some(key => !['version', 'conversationId', 'requestId'].includes(key)))
      throw Object.assign(Error('astra-product-pilot:computer-candidate-request'), { statusCode: 400, code: 'astra-product-pilot-computer-candidate-request' });
    const value = raw as { version: unknown; conversationId: unknown; requestId: unknown };
    if (value.version !== 1 || typeof value.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value.conversationId)
      || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value.requestId))
      throw Object.assign(Error('astra-product-pilot:computer-candidate-request'), { statusCode: 400, code: 'astra-product-pilot-computer-candidate-request' });
    return { conversationId: value.conversationId, requestId: value.requestId };
  }
  private computerCatalogRequest(actor: AstraAuthenticatedHttpActor, raw: unknown, catalog: 'window' | 'action'):
    { actor: AstraAuthenticatedHttpActor; conversationId: string; kind: 'list' }
    | { actor: AstraAuthenticatedHttpActor; conversationId: string; kind: 'revoke'; selectionId: string } {
    this.assertDesktopActor(actor);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw Object.assign(Error('astra-product-pilot:computer-catalog-request'),
        { statusCode: 400, code: 'astra-product-pilot-computer-catalog-request' });
    const value = raw as { version?: unknown; conversationId?: unknown; kind?: unknown; selectionId?: unknown };
    const keys = Object.keys(value), revoke = value.kind === 'revoke';
    const prefix = catalog === 'window' ? /^window_selection_[a-f0-9]{32}$/u : /^computer_action_plan_[a-f0-9]{32}$/u;
    if (value.version !== 1 || typeof value.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value.conversationId)
      || !['list', 'revoke'].includes(String(value.kind))
      || keys.length !== (revoke ? 4 : 3)
      || keys.some(key => !['version', 'conversationId', 'kind', 'selectionId'].includes(key))
      || revoke && (typeof value.selectionId !== 'string' || !prefix.test(value.selectionId))
      || !revoke && value.selectionId !== undefined)
      throw Object.assign(Error('astra-product-pilot:computer-catalog-request'),
        { statusCode: 400, code: 'astra-product-pilot-computer-catalog-request' });
    return revoke
      ? { actor: structuredClone(actor), conversationId: value.conversationId, kind: 'revoke', selectionId: value.selectionId as string }
      : { actor: structuredClone(actor), conversationId: value.conversationId, kind: 'list' };
  }
  private pruneComputerCandidates(now: number): void {
    for (const [key, item] of this.computerCandidates) if (item.expiresAt <= now) this.removeComputerCandidates(key);
  }
  private removeComputerCandidates(key: string): void {
    const item = this.computerCandidates.get(key); if (!item) return;
    clearTimeout(item.expirationTimer); this.computerCandidates.delete(key);
  }
  private projectComputerCandidates(candidateSetId: string, item: { candidates: AstraWindowChoice[]; expiresAt: number }) {
    return { candidateSetId, expiresAt: item.expiresAt, candidates: item.candidates.map((candidate, index) =>
      ({ index, title: candidate.title, processName: candidate.processName })) };
  }
}

function validMaxModelDigests(value: unknown, dynamicMaxCloud: boolean): value is AstraMaxModelDigests {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  return keys.length >= 1 && keys.length <= 3
    && (!dynamicMaxCloud ? keys.length === 2
      && keys.every(key => ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(key))
      : keys.every(key => ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(key)
        || Boolean(parseCloudRole(key) && parseCloudRole(key)!.providerId !== 'groq')))
    && keys.every(key => typeof record[key] === 'string' && /^sha256:[a-f0-9]{64}$/u.test(record[key] as string))
    && new Set(keys.map(key => record[key])).size === keys.length;
}

function validLocalModelDigests(value: unknown, defaultDigest: string): value is AstraLocalModelDigests {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  const expected = ['gemma4-fast', 'gemma4-balanced', 'qwen3-coder-30b-a3b-instruct', 'deepseek-coder-v2-lite-instruct'];
  return keys.length >= 1 && keys.length <= expected.length && keys.every(key => expected.includes(key))
    && keys.every(key => typeof record[key] === 'string' && /^sha256:[a-f0-9]{64}$/u.test(record[key] as string))
    && record['gemma4-fast'] === defaultDigest && new Set(Object.values(record)).size === keys.length;
}

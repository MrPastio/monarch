import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createMonarchRuntime,
  type MonarchBootstrapOptions,
  type MonarchRuntime,
} from '../bootstrap';
import {
  createMonarchId,
  nowIso,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchIntent,
  type MonarchIntentResult,
  type MonarchIntentSource,
  type MonarchAgentCapabilitySource,
  type MonarchPermissionProfile,
  type MonarchActionProposalInput,
  type MonarchActionProposalV1,
  type MonarchCapabilityLeaseV1,
  type MonarchRecentIntentJobQuery,
  type MonarchRecentIntentJobSnapshot,
  type MonarchRuntimePaths,
  type MonarchAuthorityContext,
  type MonarchOwnerUnrestrictedOverride,
  MONARCH_PUBLIC_AUTHORITY_CONTEXT,
  resolveMonarchRuntimePaths,
  supportsWorkspaceTaskLease,
  withUserFacingExecutionResult,
  withUserFacingIntentResult,
} from '../core';
import {
  createRouterPipeline,
  readModelCatalog,
  selectModelForInput,
  type MonarchModelCatalog,
} from '../modules/models/model-catalog';
import {
  createModelRuntimeReport,
  type MonarchModelRuntimeReport,
} from '../modules/models/runtime-adapters';
import type { MonarchComponentManagerSnapshot } from '../modules/models/component-manager';
import {
  MonarchModelProvisioningManager,
  type MonarchInstallableModelRole,
  type MonarchModelProvisioningController,
  type MonarchModelProvisioningSnapshot,
} from '../modules/models/model-provisioning-manager';
import {
  createAgentSystemProfile,
  type MonarchAgentSystemProfile,
} from './system-profile';
import { readMonarchProductVersion } from './product-version';
import type { TelegramIntentDispatcher, TelegramIntentDispatchRequest } from '../modules/telegram';
import {
  AgentKernelExecutionAdapter,
  InMemoryAgentTaskStore,
  LocalAgentDecisionProvider,
  LocalJsonAgentTaskStore,
  MonarchAgentRuntime,
  type AgentApproval,
  type AgentActionGatewayApprovalBinding,
  type AgentDecisionProvider,
  type AgentTaskStore,
  type CreateAgentTaskInput,
} from '../agent';
import {
  OscarAttachmentStore,
  OscarDataEgressConsentStore,
  isNonAuthoritativeConfirmationText,
  type OscarTurnCoordinator,
  type OscarTurnCheckpoint,
} from '../oscar-turn';
import { createApplicationOscarTurnCoordinator } from './oscar-turn-runtime';
import {
  OscarClient,
  createDefaultOscarChatRequest,
} from '../modules/oscar/client';
import {
  renderPersonalitySystemContext,
  resolvePersonalityContext,
  SettingsCommandBus,
  LocalOwnerDevSettingsStore,
  LocalOwnerUnrestrictedOverrideStore,
  type MonarchMemoryScopeV1,
  type MonarchOwnerDevSettingsV1,
  type MonarchPersonalityContextV2,
  type MonarchSettingsBackend,
} from '../settings';
import {
  ImageGenerationService,
  ImagePromptTranslator,
  classifyImagePrompt,
  type ImagePromptTranslationV1,
} from '../image-generation';
import type { ComputerUseCapabilitySnapshotV1 } from '../modules/computer';

export interface MonarchApplicationOptions extends MonarchBootstrapOptions {
  workspaceRoot?: string;
  enableAgentRuntimeV2?: boolean;
  agentTaskStore?: AgentTaskStore;
  agentDecisionProvider?: AgentDecisionProvider;
  agentRuntimeAutoRun?: boolean;
  oscarTurnCoordinator?: OscarTurnCoordinator;
  oscarAttachmentStore?: OscarAttachmentStore;
  oscarDataEgressConsentStore?: OscarDataEgressConsentStore;
  settingsCommandBus?: SettingsCommandBus;
  imageGenerationService?: ImageGenerationService;
  imagePromptTranslator?: ImagePromptTranslator;
  modelComponentManager?: MonarchModelProvisioningController;
}

export interface MonarchIntentSubmission {
  text: string;
  source?: MonarchIntentSource;
  confirmed?: boolean;
  confirmationToken?: string;
  replyToTurnId?: string;
  context?: Record<string, unknown>;
}

export type MonarchIntentJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface MonarchIntentJobSubmission extends MonarchIntentSubmission {
  timeoutMs?: number;
}

export interface MonarchIntentJobSnapshot {
  id: string;
  text: string;
  source: MonarchIntentSource;
  status: MonarchIntentJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutMs: number;
  summary: string;
  progress: string[];
  result: MonarchIntentResult | null;
  error: string | null;
  clientConversationId?: string;
  clientSessionId?: string;
}

export interface MonarchCapabilityExecution {
  moduleId: string;
  capabilityId: string;
  input?: unknown;
  requestedBy?: string;
  /** Trusted caller surface; HTTP handlers derive this instead of accepting it from JSON. */
  source?: MonarchAgentCapabilitySource;
  confirmed?: boolean;
  confirmationToken?: string;
  intentId?: string;
}

export interface MonarchActionProposalSubmission {
  proposal: MonarchActionProposalInput | MonarchActionProposalV1;
  originatingUserText?: string;
  requestedBy?: string;
  /** Trusted caller surface; HTTP handlers derive this instead of accepting it from JSON. */
  source?: MonarchAgentCapabilitySource;
  model?: string;
  skillIds?: string[];
  confirmed?: boolean;
  confirmationToken?: string;
  grantScope?: 'once' | 'task';
  leaseId?: string;
  /** Internal-only trusted Agent Runtime lane. HTTP bodies never populate this field. */
  executionMode?: 'agent-runtime';
  /** Internal-only task-owned execution profile. HTTP bodies never populate this field. */
  permissionProfileOverride?: MonarchPermissionProfile;
  /** Durable exact approval binding supplied only by Agent Runtime. */
  agentApprovalBinding?: AgentActionGatewayApprovalBinding;
  /** Internal-only cancellation signal. HTTP bodies never populate this field. */
  signal?: AbortSignal;
}

export interface MonarchActionProposalResult {
  proposal: MonarchActionProposalV1;
  result: MonarchExecutionResult;
  lease?: MonarchCapabilityLeaseV1;
}

export interface MonarchApplicationState {
  app: {
    name: string;
    version: string;
    workspaceRoot: string;
    started: boolean;
    startedAt: string | null;
  };
  runtime: {
    loadRecords: MonarchRuntime['loadRecords'];
    health: Awaited<ReturnType<MonarchRuntime['kernel']['checkHealth']>>;
    snapshot: ReturnType<MonarchRuntime['kernel']['getSnapshot']>;
    diagnostics: MonarchRuntimeDiagnostics;
  };
  models: MonarchModelCatalog;
  modelRuntime: MonarchModelRuntimeReport;
  components: MonarchComponentManagerSnapshot | MonarchModelProvisioningSnapshot;
  selectedModel: ReturnType<typeof selectModelForInput>;
  routerPipeline: ReturnType<typeof createRouterPipeline>;

  lastIntent: MonarchIntentResult | null;
  system: MonarchAgentSystemProfile;
  permissions: MonarchPermissionProfile;
  authority: MonarchAuthorityContext;
  ownerDev?: MonarchOwnerDevSettingsV1;
  agency: {
    activeLeases: MonarchCapabilityLeaseV1[];
    recentActions: ReturnType<MonarchRuntime['kernel']['listActionLedger']>;
  };
}

export interface MonarchRuntimeDiagnostics {
  generatedAt: string;
  cache: {
    healthAgeMs: number;
    modelCatalogAgeMs: number;
    ttlMs: number;
  };
  queue: {
    queued: number;
    running: number;
    terminal: number;
    total: number;
    activeJobId: string | null;
    activeJobAgeMs: number | null;
  };
}

interface CachedRuntimeState {
  cachedAt: number;
  health: Awaited<ReturnType<MonarchRuntime['kernel']['checkHealth']>>;
  modelCatalog: MonarchModelCatalog;
  modelRuntime: MonarchModelRuntimeReport;
}

export class MonarchApplication {
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly productVersion: string;
  readonly runtimePaths: MonarchRuntimePaths;
  readonly runtime: MonarchRuntime;
  readonly agentRuntime: MonarchAgentRuntime | null;
  /** Session-only runtime; its task store is never written to disk. */
  readonly incognitoAgentRuntime: MonarchAgentRuntime | null;
  readonly oscarTurnCoordinator: OscarTurnCoordinator;
  readonly oscarAttachmentStore: OscarAttachmentStore;
  readonly oscarDataEgressConsentStore: OscarDataEgressConsentStore;
  readonly settingsCommandBus: SettingsCommandBus;
  readonly ownerDevSettingsStore: LocalOwnerDevSettingsStore;
  readonly ownerUnrestrictedOverrideStore: LocalOwnerUnrestrictedOverrideStore;
  readonly imageGeneration: ImageGenerationService;
  readonly imagePromptTranslator: ImagePromptTranslator;
  readonly modelComponentManager: MonarchModelProvisioningController;
  private readonly contextClient: OscarClient;
  readonly authorityContext: MonarchAuthorityContext;
  private started = false;
  private startedAt: string | null = null;
  private modelCatalog: MonarchModelCatalog | null = null;
  private cachedRuntimeState: CachedRuntimeState | null = null;

  private lastIntent: MonarchIntentResult | null = null;
  private static readonly STATE_CACHE_TTL_MS = 1500;

  constructor(options: MonarchApplicationOptions = {}) {
    const {
      workspaceRoot = process.cwd(),
      enableAgentRuntimeV2,
      agentTaskStore,
      agentDecisionProvider,
      agentRuntimeAutoRun,
      oscarTurnCoordinator,
      oscarAttachmentStore,
      oscarDataEgressConsentStore,
      settingsCommandBus,
      imageGenerationService,
      imagePromptTranslator,
      modelComponentManager,
      ...bootstrapOptions
    } = options;
    this.sourceRoot = workspaceRoot;
    this.productVersion = readMonarchProductVersion(this.sourceRoot);
    this.runtimePaths = resolveMonarchRuntimePaths(workspaceRoot);
    this.workspaceRoot = this.runtimePaths.userWorkspaceRoot;
    this.modelComponentManager = modelComponentManager
      || new MonarchModelProvisioningManager(this.runtimePaths);
    this.authorityContext = Object.freeze({ ...(bootstrapOptions.authorityContext || MONARCH_PUBLIC_AUTHORITY_CONTEXT) });
    const storedPermissionProfile = readStoredPermissionProfile(this.runtimePaths.stateRoot);
    const migratedStoredProfile = migrateStoredOwnerPermissionProfile(storedPermissionProfile, this.authorityContext);
    const permissionProfile = bootstrapOptions.permissionProfile || migratedStoredProfile;
    if (!bootstrapOptions.permissionProfile && migratedStoredProfile && migratedStoredProfile !== storedPermissionProfile) {
      persistPermissionProfile(this.runtimePaths.stateRoot, migratedStoredProfile);
    }
    this.runtime = createMonarchRuntime({
      ...bootstrapOptions,
      workspaceRoot,
      authorityContext: this.authorityContext,
      ...(permissionProfile ? { permissionProfile } : {}),
    });
    this.runtime.kernel.setRecentIntentJobsProvider((query) => this.listRecentIntentJobs(query));
    const agentEnabled = enableAgentRuntimeV2 ?? readBooleanEnvironment('MONARCH_AGENT_RUNTIME_V2', false);
    if (agentEnabled) {
      const store = agentTaskStore || new LocalJsonAgentTaskStore(
        path.join(this.runtimePaths.stateRoot, 'agent', 'tasks.v3.json'),
        { legacyFilePath: path.join(this.runtimePaths.stateRoot, 'agent', 'tasks.v2.json') },
      );
      const decisionProvider = agentDecisionProvider || new LocalAgentDecisionProvider({
        // Model catalog/runtime configuration belongs to the installed source
        // tree, while Agent file actions intentionally use userWorkspaceRoot.
        workspaceRoot: this.sourceRoot,
      });
      const executionAdapter = new AgentKernelExecutionAdapter(
        (submission) => this.submitActionProposal(submission),
        (submission) => this.prepareActionProposal(submission),
      );
      this.agentRuntime = new MonarchAgentRuntime({
        store,
        decisionProvider,
        executionAdapter,
        listCapabilities: () => this.runtime.kernel.listCapabilities(),
        getPermissionProfile: () => this.runtime.kernel.getPermissionProfile(),
        getModuleStates: () => Object.fromEntries(
          this.runtime.kernel.getSnapshot().modules.map((record) => [
            record.manifest.id,
            record.status === 'registered' ? 'inactive' : record.status,
          ]),
        ),
        ...(agentRuntimeAutoRun !== undefined ? { autoRun: agentRuntimeAutoRun } : {}),
      });
      this.incognitoAgentRuntime = new MonarchAgentRuntime({
        store: new InMemoryAgentTaskStore(),
        decisionProvider,
        executionAdapter,
        listCapabilities: () => this.runtime.kernel.listCapabilities(),
        getPermissionProfile: () => this.runtime.kernel.getPermissionProfile(),
        getModuleStates: () => Object.fromEntries(
          this.runtime.kernel.getSnapshot().modules.map((record) => [
            record.manifest.id,
            record.status === 'registered' ? 'inactive' : record.status,
          ]),
        ),
        runnerId: `incognito_agent_runner_${process.pid}`,
        ...(agentRuntimeAutoRun !== undefined ? { autoRun: agentRuntimeAutoRun } : {}),
      });
    } else {
      this.agentRuntime = null;
      this.incognitoAgentRuntime = null;
    }
    this.oscarAttachmentStore = oscarAttachmentStore || new OscarAttachmentStore(this.runtimePaths.stateRoot);
    this.oscarDataEgressConsentStore = oscarDataEgressConsentStore
      || new OscarDataEgressConsentStore(this.runtimePaths.stateRoot);
    this.contextClient = new OscarClient({
      workspaceRoot: this.sourceRoot,
      projectRoot: path.join(this.sourceRoot, 'oscar'),
      logsRoot: this.runtimePaths.logsRoot,
      secretsRoot: this.runtimePaths.secretsRoot,
    });
    this.ownerDevSettingsStore = new LocalOwnerDevSettingsStore(this.runtimePaths.stateRoot);
    this.ownerUnrestrictedOverrideStore = new LocalOwnerUnrestrictedOverrideStore(this.runtimePaths.stateRoot);
    for (const module of this.runtime.modules) {
      const bridge = module as typeof module & {
        setOwnerDevSettingsProvider?: (provider: () => MonarchOwnerDevSettingsV1) => void;
      };
      bridge.setOwnerDevSettingsProvider?.(() => this.getOwnerDevSettings());
    }
    const settingsBackend: MonarchSettingsBackend = {
      read: (request) => request.kind === 'dev'
        ? this.ownerDevSettingsStore.read(request)
        : request.kind === 'owner-override'
          ? this.ownerUnrestrictedOverrideStore.read(request)
          : this.contextClient.readSettingsContext(request),
      execute: async (request) => {
        const receipt = request.command.startsWith('dev.')
          ? await this.ownerDevSettingsStore.execute(request)
          : request.command.startsWith('owner-override.')
            ? await this.ownerUnrestrictedOverrideStore.execute(request)
            : await this.contextClient.executeSettingsCommand(request);
        if (request.command.startsWith('owner-override.')) {
          await this.emitOwnerUnrestrictedOverrideState();
        }
        return receipt;
      },
    };
    this.settingsCommandBus = settingsCommandBus || new SettingsCommandBus(
      settingsBackend,
      {
        evaluateLocalSettingsCommand: (input) => this.runtime.kernel.evaluateLocalSettingsCommand(input),
      },
      this.authorityContext,
    );
    this.imageGeneration = imageGenerationService
      || new ImageGenerationService(path.join(this.runtimePaths.dataRoot, 'images'));
    this.imagePromptTranslator = imagePromptTranslator || new ImagePromptTranslator(
      (request, signal) => this.contextClient.completeRaw(request, signal),
    );
    this.oscarTurnCoordinator = oscarTurnCoordinator || createApplicationOscarTurnCoordinator({
      sourceRoot: this.sourceRoot,
      runtimePaths: this.runtimePaths,
      agentRuntime: this.agentRuntime,
      incognitoAgentRuntime: this.incognitoAgentRuntime,
      attachments: this.oscarAttachmentStore,
      dataEgressConsents: this.oscarDataEgressConsentStore,
      settingsCommandBus: this.settingsCommandBus,
      getOwnerDevSettings: () => this.getOwnerDevSettings(),
    });
    const telegramDispatcher: TelegramIntentDispatcher = async (request) => request.approval
      ? this.resolveAgentSurfaceApproval(request)
      : this.submitAgentSurfaceIntent({ text: request.text, source: 'telegram', context: request.context });
    for (const module of this.runtime.modules) {
      const bridge = module as typeof module & { setIntentDispatcher?: (dispatcher: TelegramIntentDispatcher) => void };
      bridge.setIntentDispatcher?.(telegramDispatcher);
    }
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.modelComponentManager.initialize?.();
    this.modelCatalog = await readModelCatalog(this.sourceRoot);
    await this.runtime.kernel.start();
    await this.emitOwnerUnrestrictedOverrideState();
    try {
      await this.agentRuntime?.start();
      await this.incognitoAgentRuntime?.start();
      await this.oscarTurnCoordinator.start();
    } catch (error) {
      try {
        await this.oscarTurnCoordinator.stop();
        await this.incognitoAgentRuntime?.discardAllTasks();
        await this.incognitoAgentRuntime?.stop();
        await this.agentRuntime?.stop();
      } catch {
        // Preserve the startup failure; runtime cleanup is best-effort.
      }
      try {
        await this.runtime.kernel.stop();
      } catch {
        // Preserve the startup failure; kernel cleanup is best-effort.
      }
      this.started = false;
      this.startedAt = null;
      throw error;
    }
    this.started = true;
    this.startedAt = nowIso();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    await this.oscarTurnCoordinator.stop();
    this.oscarAttachmentStore.clearVolatile();
    this.oscarDataEgressConsentStore.clearVolatile();
    await this.incognitoAgentRuntime?.discardAllTasks();
    await this.incognitoAgentRuntime?.stop();
    await this.agentRuntime?.stop();
    await this.modelComponentManager.stop();
    await this.runtime.kernel.stop();
    this.started = false;
  }

  async getState(input = ''): Promise<MonarchApplicationState> {
    await this.ensureStarted();
    const cached = await this.getCachedRuntimeState();
    const modelCatalog = cached.modelCatalog;
    const health = cached.health;
    const modelRuntime = cached.modelRuntime;

    return {
      app: {
        name: 'Monarch',
        version: this.productVersion,
        workspaceRoot: this.workspaceRoot,
        started: this.started,
        startedAt: this.startedAt,
      },
      runtime: {
        loadRecords: this.runtime.loadRecords,
        health,
        snapshot: this.runtime.kernel.getSnapshot(),
        diagnostics: this.buildRuntimeDiagnostics(cached),
      },
      models: modelCatalog,
      modelRuntime,
      components: this.modelComponentManager.snapshot(),
      selectedModel: selectModelForInput(input, modelCatalog),
      routerPipeline: createRouterPipeline(input, modelCatalog, modelRuntime),

      lastIntent: this.lastIntent,
      system: this.getSystemProfile(),
      permissions: this.runtime.kernel.getPermissionProfile(),
      authority: this.authorityContext,
      ...(this.authorityContext.tier === 'owner' && this.authorityContext.source === 'signed-device-entitlement'
        ? { ownerDev: this.getOwnerDevSettings() }
        : {}),
      agency: {
        activeLeases: this.runtime.kernel.listCapabilityLeases(true),
        recentActions: this.runtime.kernel.listActionLedger(30),
      },
    };
  }

  async submitIntent(submission: MonarchIntentSubmission): Promise<MonarchIntentResult> {
    await this.ensureStarted();
    const text = submission.text.trim();
    if (!text) {
      throw new Error('Intent text is required.');
    }

    if (submission.confirmed || submission.confirmationToken) {
      throw new MonarchApplicationError(
        410,
        'legacy-text-confirmation-disabled',
        'Text confirmation tokens cannot authorize an action. Use the exact structured Agent approval endpoint.',
      );
    }
    const source = submission.source || 'desktop';
    if (source === 'smoke') {
      this.lastIntent = withUserFacingIntentResult(await this.runtime.kernel.submitIntent(
        text,
        source,
        { ...(submission.context || {}), confirmed: false },
      ));
      return this.lastIntent;
    }
    return this.submitAgentSurfaceIntent({ ...submission, text, source });
  }

  async readComputerUseCapabilitySnapshot(): Promise<ComputerUseCapabilitySnapshotV1> {
    const module = this.runtime.kernel.getModule('computer') as (
      { readCapabilitySnapshot?: () => Promise<ComputerUseCapabilitySnapshotV1> } | undefined
    );
    if (module?.readCapabilitySnapshot) return module.readCapabilitySnapshot();
    return {
      schemaVersion: 1,
      available: false,
      enabled: false,
      surface: 'computer-use',
      invocation: '@Computer Use',
      ownCursor: true,
      observeAnalyzeAct: true,
      emergencyShortcut: 'Ctrl+Alt+Escape',
    };
  }

  async translateImagePrompt(text: string, signal?: AbortSignal): Promise<ImagePromptTranslationV1> {
    await this.ensureStarted();
    const classification = classifyImagePrompt(text);
    if (classification === 'prohibited') {
      throw new MonarchApplicationError(
        403,
        'prohibited-content',
        'Этот prompt запрещён политикой защиты несовершеннолетних.',
      );
    }
    if (classification === 'nsfw') {
      const policy = await this.imageGeneration.readPolicySnapshot();
      if (!policy.matureModeActive) {
        throw new MonarchApplicationError(409, 'mature-mode-disabled', 'Режим 18+ сейчас выключен.');
      }
    }
    return this.imagePromptTranslator.translate(text, signal);
  }

  async indexCoderMemoryEpisode(input: {
    projectId: string;
    runId: string;
    projectName: string;
    userText: string;
    assistantText: string;
    structuredSummary: Record<string, unknown>;
  }): Promise<unknown> {
    return this.contextClient.indexMemoryEpisode({
      schemaVersion: 1,
      source: 'coder',
      scope: { type: 'coder-project', projectId: input.projectId },
      conversationId: `coder:${input.runId}`,
      turnId: input.runId,
      projectName: input.projectName,
      userText: input.userText,
      assistantText: input.assistantText,
      structuredSummary: input.structuredSummary,
    });
  }

  async retrieveCoderMemoryContext(input: { projectId: string; query: string }): Promise<unknown> {
    return this.contextClient.retrieveMemoryContext({
      query: input.query,
      scope: { type: 'coder-project', projectId: input.projectId },
    });
  }

  async readPersonalityContext(scope: MonarchMemoryScopeV1): Promise<{
    scope: MonarchMemoryScopeV1;
    settingsRevision: number;
    context: MonarchPersonalityContextV2 | null;
  }> {
    const result = await this.settingsCommandBus.read({
      schemaVersion: 1,
      kind: 'personality',
      scope,
    }, 'desktop');
    return {
      scope,
      settingsRevision: result.revision,
      context: resolvePersonalityContext(result.value),
    };
  }

  async previewPersonality(scope: MonarchMemoryScopeV1): Promise<{
    scope: MonarchMemoryScopeV1;
    settingsRevision: number;
    personality: MonarchPersonalityContextV2;
    answer: string;
  }> {
    await this.ensureStarted();
    const snapshot = await this.readPersonalityContext(scope);
    if (!snapshot.context) {
      throw new MonarchApplicationError(
        409,
        'personality-disabled',
        'Select a personality profile and enable personalization before previewing it.',
      );
    }
    const language = snapshot.context.language;
    const prompt = language === 'en'
      ? 'Briefly introduce yourself and explain how you would help me improve a software product. Use your selected communication style.'
      : language === 'uk'
        ? 'Коротко представся і поясни, як ти допоможеш мені покращити програмний продукт. Використовуй обраний стиль спілкування.'
        : language === 'bg'
          ? 'Представи се накратко и обясни как ще ми помогнеш да подобря софтуерен продукт. Използвай избрания стил на общуване.'
          : 'Коротко представься и объясни, как ты поможешь мне улучшить программный продукт. Используй выбранный стиль общения.';
    const payload = await this.contextClient.chat(createDefaultOscarChatRequest([
      { role: 'system', content: renderPersonalitySystemContext(snapshot.context) },
      { role: 'user', content: prompt },
    ], false, {
      conversation_id: `personality-preview:${createMonarchId('preview')}`,
      incognito: true,
      use_memory: false,
      research_mode: 'off',
      reasoning_effort: 'low',
      max_new_tokens: 320,
      execution_authority: 'none',
      persistence_owner: 'backend',
      inference_lane: 'interactive',
    }));
    if (isOscarRecoveryPayload(payload)) {
      throw new MonarchApplicationError(
        503,
        'personality-preview-runtime-unavailable',
        'Локальная модель сейчас недоступна. Настройки сохранены; повтори проверку после восстановления runtime.',
      );
    }
    const answer = readOscarAnswer(payload);
    if (!answer) {
      throw new MonarchApplicationError(
        502,
        'personality-preview-empty',
        'Oscar preview runtime returned no answer.',
      );
    }
    return {
      scope,
      settingsRevision: snapshot.settingsRevision,
      personality: snapshot.context,
      answer,
    };
  }

  async submitAgentSurfaceIntent(
    submission: MonarchIntentSubmission & { source: Extract<MonarchIntentSource, 'desktop' | 'telegram' | 'voice' | 'api' | 'system'> },
  ): Promise<MonarchIntentResult> {
    await this.ensureStarted();
    const text = submission.text.trim();
    if (!text) {
      throw new Error('Intent text is required.');
    }
    const context = submission.context || {};
    const zeroRetention = this.getOwnerDevSettings().zeroRetentionEnabled;
    const privacyMode = zeroRetention ? 'incognito' as const : 'persistent' as const;
    if (submission.confirmed || submission.confirmationToken) {
      throw new MonarchApplicationError(
        410,
        'legacy-text-confirmation-disabled',
        'Text confirmation tokens cannot authorize an action. Use the exact structured Agent approval endpoint.',
      );
    }
    const conversationId = surfaceConversationId(submission.source, context);
    const activeApproval = isNonAuthoritativeConfirmationText(text)
      ? await this.oscarTurnCoordinator.findLatestTurn({
        conversationId,
        source: submission.source,
        statuses: ['waiting-for-approval'],
        privacyMode,
      })
      : null;
    if (activeApproval) {
      const refocused = await this.oscarTurnCoordinator.sendMessage(activeApproval.turn.id, {
        content: text,
        messageId: readBoundedContextId(context.clientMessageId)
          || readBoundedContextId(context.clientRequestId)
          || createMonarchId('surface_confirmation_message'),
        source: submission.source,
      });
      return this.surfaceTurnResult(refocused, text, submission.source, context);
    }
    const clientRequestId = readBoundedContextId(context.clientRequestId)
      || createMonarchId('surface_turn_request');
    const checkpoint = await this.oscarTurnCoordinator.submit({
      clientRequestId,
      conversationId,
      text,
      privacyMode,
      source: submission.source,
      inputMessageId: readBoundedContextId(context.clientMessageId) || clientRequestId,
      ...(!zeroRetention && submission.replyToTurnId
        ? { replyToTurnId: readBoundedContextId(submission.replyToTurnId) }
        : {}),
    });
    const settled = await this.waitForSurfaceTurn(checkpoint, 5 * 60 * 1000);
    return this.surfaceTurnResult(settled, text, submission.source, context);
  }

  async submitIntentJob(submission: MonarchIntentJobSubmission): Promise<MonarchIntentJobSnapshot> {
    await this.ensureStarted();
    const text = submission.text.trim();
    if (!text) {
      throw new Error('Intent text is required.');
    }

    const now = nowIso();
    const result = await this.submitIntent({ ...submission, text });
    const output = result.execution?.output && typeof result.execution.output === 'object'
      ? result.execution.output as Record<string, unknown>
      : {};
    const ok = result.execution?.ok === true;
    return {
      id: typeof output.turnId === 'string' ? output.turnId : result.intent.id,
      text,
      source: result.intent.source,
      status: ok ? 'completed' : 'failed',
      createdAt: result.intent.createdAt,
      updatedAt: now,
      startedAt: result.intent.createdAt,
      finishedAt: now,
      timeoutMs: normalizeJobTimeout(submission.timeoutMs),
      summary: result.summary,
      progress: [`turn:${String(output.status || (ok ? 'succeeded' : 'failed'))}`],
      result,
      error: ok ? null : result.execution?.error || 'turn-failed',
    };
  }

  listIntentJobs(_limit = 20): MonarchIntentJobSnapshot[] {
    return [];
  }

  listRecentIntentJobs(query: MonarchRecentIntentJobQuery): readonly MonarchRecentIntentJobSnapshot[] {
    void query;
    return [];
  }

  getIntentJob(id: string): MonarchIntentJobSnapshot | null {
    void id;
    return null;
  }

  cancelIntentJob(id: string): MonarchIntentJobSnapshot | null {
    void id;
    return null;
  }

  async executeCapability(
    execution: MonarchCapabilityExecution
  ): Promise<MonarchExecutionResult> {
    await this.ensureStarted();
    const moduleId = execution.moduleId.trim();
    const capabilityId = execution.capabilityId.trim();
    if (!moduleId || !capabilityId) {
      throw new Error('moduleId and capabilityId are required.');
    }

    if (execution.confirmed || execution.confirmationToken) {
      throw new MonarchApplicationError(
        410,
        'legacy-text-confirmation-disabled',
        'Text confirmation tokens cannot authorize a capability execution.',
      );
    }

    const request: MonarchExecutionRequest = {
      id: createMonarchId('exec_api'),
      intentId: execution.intentId || createMonarchId('intent_api'),
      moduleId,
      capabilityId,
      input: execution.input ?? {},
      createdAt: nowIso(),
      requestedBy: execution.requestedBy || 'api',
      ...(execution.source ? { source: execution.source } : {}),
      confirmed: false,
    };

    return withUserFacingExecutionResult(await this.runtime.kernel.execute(request));
  }

  async submitActionProposal(submission: MonarchActionProposalSubmission): Promise<MonarchActionProposalResult> {
    await this.ensureStarted();
    const originatingUserText = String(submission.originatingUserText || '').trim().slice(0, 8_000);
    const requestedBy = String(submission.requestedBy || 'api').trim().slice(0, 200) || 'api';

    if (submission.confirmed || submission.confirmationToken) {
      if (submission.executionMode !== 'agent-runtime' || !submission.agentApprovalBinding) {
        throw new MonarchApplicationError(
          410,
          'legacy-text-confirmation-disabled',
          'Text confirmation tokens cannot authorize an action. Use a durable exact Agent approval binding.',
        );
      }
      return this.executeDurablyApprovedActionProposal(submission, originatingUserText, requestedBy);
    }

    const executed = await this.runtime.kernel.executeActionProposal(submission.proposal, {
      originatingUserText,
      requestedBy,
      ...(submission.source ? { source: submission.source } : {}),
      ...(submission.model ? { model: submission.model } : {}),
      ...(submission.skillIds ? { skillIds: submission.skillIds } : {}),
      ...(submission.leaseId ? { leaseId: submission.leaseId } : {}),
      ...(submission.executionMode ? { executionMode: submission.executionMode } : {}),
      ...(submission.permissionProfileOverride ? { permissionProfileOverride: submission.permissionProfileOverride } : {}),
      ...(submission.signal ? { signal: submission.signal } : {}),
    });
    const result = withUserFacingExecutionResult(executed.result);
    return { proposal: executed.proposal, result };
  }

  private async executeDurablyApprovedActionProposal(
    submission: MonarchActionProposalSubmission,
    originatingUserText: string,
    requestedBy: string,
  ): Promise<MonarchActionProposalResult> {
    const binding = submission.agentApprovalBinding;
    if (!binding) {
      throw new MonarchApplicationError(409, 'agent-approval-unavailable', 'Durable Agent approval is unavailable.');
    }
    const runtime = await this.resolveAgentRuntimeForTask(binding.taskId);
    if (!runtime) {
      throw new MonarchApplicationError(409, 'agent-approval-unavailable', 'Durable Agent approval is unavailable.');
    }
    const checkpoint = await runtime.getTask(binding.taskId);
    const approval = checkpoint?.approvals.find((entry) => entry.id === binding.approvalId);
    const reference = checkpoint?.task.approvals.find((entry) => entry.id === binding.approvalId);
    const pending = checkpoint?.task.pendingAction;
    if (
      !checkpoint
      || !approval
      || approval.status !== 'approved'
      || reference?.status !== 'approved'
      || checkpoint.task.status !== 'running'
      || pending?.status !== 'dispatched'
      || pending.canonicalProposalHash !== binding.canonicalProposalHash
      || approval.canonicalProposalHash !== binding.canonicalProposalHash
      || approval.capabilityId !== binding.capabilityId
      || reference.purpose !== approval.purpose
      || reference.policyDecisionHash !== approval.policyDecisionHash
      || reference.authorityTierAtRequest !== approval.authorityTierAtRequest
      || binding.purpose !== approval.purpose
      || binding.policyDecisionHash !== approval.policyDecisionHash
      || binding.authorityTierAtRequest !== approval.authorityTierAtRequest
      || checkpoint.task.source.surface !== submission.source
    ) {
      throw new MonarchApplicationError(409, 'agent-approval-binding-mismatch', 'Durable Agent approval no longer matches the dispatched action.');
    }
    const ownerOverride = approval.purpose === 'owner-security-override';
    if (ownerOverride && (
      approval.authorityTierAtRequest !== 'owner'
      || !approval.policyDecisionHash
      || this.authorityContext.tier !== 'owner'
      || this.authorityContext.source !== 'signed-device-entitlement'
      || (submission.source !== 'desktop' && submission.source !== 'coder')
      || approval.grantScope !== 'once'
      || submission.grantScope === 'task'
    )) {
      throw new MonarchApplicationError(
        409,
        'owner-authority-changed',
        'Owner authority or the exact one-time override binding changed; review a new action-card.',
      );
    }
    const approvedProposal = approval.proposal as unknown as MonarchActionProposalV1;
    const supplied = this.runtime.kernel.prepareActionProposal(submission.proposal, {
      intentId: approvedProposal.intentId,
      originatingUserText,
      requestedBy,
      ...(submission.model ? { model: submission.model } : {}),
      ...(submission.skillIds ? { skillIds: submission.skillIds } : {}),
    });
    if (
      supplied.proposalId !== approvedProposal.proposalId
      || supplied.canonicalHash !== binding.canonicalProposalHash
      || supplied.capabilityId !== binding.capabilityId
    ) {
      throw new MonarchApplicationError(409, 'agent-approval-binding-mismatch', 'Prepared action changed after durable approval.');
    }
    const grantScope = submission.grantScope === 'task' ? 'task' : 'once';
    if (grantScope === 'task' && !canGrantTaskLease(supplied)) {
      throw new MonarchApplicationError(400, 'task-grant-not-allowed', 'This action cannot be expanded into a task lease.');
    }
    const lease = grantScope === 'task' ? this.runtime.kernel.issueTaskLease(supplied) : undefined;
    const executed = await this.runtime.kernel.executeActionProposal(supplied, {
      intentId: supplied.intentId,
      originatingUserText,
      requestedBy,
      ...(submission.source ? { source: submission.source } : {}),
      confirmed: true,
      securityOverrideConfirmed: ownerOverride,
      ...(approval.policyDecisionHash ? { approvalPolicyDecisionHash: approval.policyDecisionHash } : {}),
      ...(approval.purpose ? { approvalPurpose: approval.purpose } : {}),
      ...(approval.authorityTierAtRequest ? { authorityTierAtApproval: approval.authorityTierAtRequest } : {}),
      ...(lease ? { leaseId: lease.leaseId } : {}),
      executionMode: 'agent-runtime',
      ...(submission.permissionProfileOverride ? { permissionProfileOverride: submission.permissionProfileOverride } : {}),
      ...(submission.signal ? { signal: submission.signal } : {}),
    });
    return {
      proposal: executed.proposal,
      result: withUserFacingExecutionResult(executed.result),
      ...(lease ? { lease } : {}),
    };
  }

  async prepareActionProposal(submission: MonarchActionProposalSubmission): Promise<MonarchActionProposalV1> {
    await this.ensureStarted();
    const originatingUserText = String(submission.originatingUserText || '').trim().slice(0, 8_000);
    const requestedBy = String(submission.requestedBy || 'agent-runtime').trim().slice(0, 200) || 'agent-runtime';
    return this.runtime.kernel.prepareActionProposal(submission.proposal, {
      originatingUserText,
      requestedBy,
      ...(submission.model ? { model: submission.model } : {}),
      ...(submission.skillIds ? { skillIds: submission.skillIds } : {}),
    });
  }

  get isAgentRuntimeV2Enabled(): boolean {
    return this.agentRuntime !== null;
  }

  async resolveAgentRuntimeForTask(taskId: string): Promise<MonarchAgentRuntime | null> {
    if (this.incognitoAgentRuntime && await this.incognitoAgentRuntime.getTask(taskId)) {
      return this.incognitoAgentRuntime;
    }
    if (this.agentRuntime && await this.agentRuntime.getTask(taskId)) return this.agentRuntime;
    return null;
  }

  async createAgentTask(input: CreateAgentTaskInput) {
    await this.ensureStarted();
    if (!this.agentRuntime) {
      throw new MonarchApplicationError(404, 'agent-runtime-disabled', 'Oscar Agent Runtime V2 is disabled.');
    }
    return this.agentRuntime.createTask(input);
  }

  listCapabilityLeases(activeOnly = false): MonarchCapabilityLeaseV1[] {
    return this.runtime.kernel.listCapabilityLeases(activeOnly);
  }

  revokeCapabilityLease(leaseId: string): MonarchCapabilityLeaseV1 | null {
    return this.runtime.kernel.revokeCapabilityLease(leaseId);
  }

  listActionLedger(limit = 100): ReturnType<MonarchRuntime['kernel']['listActionLedger']> {
    return this.runtime.kernel.listActionLedger(limit);
  }

  rollbackAction(ledgerId: string): ReturnType<MonarchRuntime['kernel']['rollbackAction']> {
    return this.runtime.kernel.rollbackAction(ledgerId);
  }

  getSystemProfile(): MonarchAgentSystemProfile {
    return createAgentSystemProfile(this.runtime, this.workspaceRoot);
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) {
      await this.start();
    }
  }

  private async refreshModelCatalog(): Promise<MonarchModelCatalog> {
    this.modelCatalog = await readModelCatalog(this.sourceRoot);
    return this.modelCatalog;
  }

  getPermissionProfile(): MonarchPermissionProfile {
    return this.runtime.kernel.getPermissionProfile();
  }

  getComponentManagerSnapshot(): MonarchComponentManagerSnapshot | MonarchModelProvisioningSnapshot {
    return this.modelComponentManager.snapshot();
  }

  async ensureRequiredComponents(): Promise<MonarchComponentManagerSnapshot | MonarchModelProvisioningSnapshot> {
    const snapshot = await this.modelComponentManager.ensureRequiredModel();
    this.cachedRuntimeState = null;
    return snapshot;
  }

  startRequiredComponents(): MonarchComponentManagerSnapshot | MonarchModelProvisioningSnapshot {
    void this.ensureRequiredComponents();
    return this.modelComponentManager.snapshot();
  }

  startModelInstall(
    roles: MonarchInstallableModelRole[],
    source: 'onboarding' | 'settings',
  ): MonarchComponentManagerSnapshot | MonarchModelProvisioningSnapshot {
    if (!this.modelComponentManager.startInstallModels) {
      void this.ensureRequiredComponents();
      return this.modelComponentManager.snapshot();
    }
    const snapshot = this.modelComponentManager.startInstallModels(roles, source);
    this.cachedRuntimeState = null;
    return snapshot;
  }

  async skipModelOnboarding(): Promise<MonarchComponentManagerSnapshot | MonarchModelProvisioningSnapshot> {
    if (!this.modelComponentManager.skipOnboarding) return this.modelComponentManager.snapshot();
    const snapshot = await this.modelComponentManager.skipOnboarding();
    this.cachedRuntimeState = null;
    return snapshot;
  }

  async acknowledgeModelOnboardingWelcome(): Promise<MonarchComponentManagerSnapshot | MonarchModelProvisioningSnapshot> {
    if (!this.modelComponentManager.acknowledgeOnboardingWelcome) return this.modelComponentManager.snapshot();
    const snapshot = await this.modelComponentManager.acknowledgeOnboardingWelcome();
    this.cachedRuntimeState = null;
    return snapshot;
  }

  getAuthorityContext(): MonarchAuthorityContext {
    return this.authorityContext;
  }

  getOwnerDevSettings(): MonarchOwnerDevSettingsV1 {
    return this.ownerDevSettingsStore.snapshot();
  }

  getOwnerUnrestrictedOverride(): MonarchOwnerUnrestrictedOverride {
    return this.ownerUnrestrictedOverrideStore.snapshot();
  }

  private async emitOwnerUnrestrictedOverrideState(): Promise<void> {
    await this.runtime.kernel.emitRuntimeEvent('security.owner_override.changed', 'security', {
      ownerOverride: this.getOwnerUnrestrictedOverride(),
      localOwnerOnly: true,
    });
  }

  setPermissionProfile(profile: MonarchPermissionProfile): MonarchPermissionProfile {
    const updated = this.runtime.kernel.setPermissionProfile(profile);
    persistPermissionProfile(this.runtimePaths.stateRoot, updated);
    return updated;
  }

  private async getCachedRuntimeState(): Promise<CachedRuntimeState> {
    const now = Date.now();
    const cached = this.cachedRuntimeState;
    if (cached && now - cached.cachedAt <= MonarchApplication.STATE_CACHE_TTL_MS) {
      return cached;
    }

    const modelCatalog = await this.refreshModelCatalog();
    const [health] = await Promise.all([
      this.runtime.kernel.checkHealth(),
    ]);
    const modelRuntime = createModelRuntimeReport(modelCatalog);
    const next: CachedRuntimeState = {
      cachedAt: now,
      health,
      modelCatalog,
      modelRuntime,
    };
    this.cachedRuntimeState = next;
    return next;
  }

  private buildRuntimeDiagnostics(cached: CachedRuntimeState): MonarchRuntimeDiagnostics {
    const now = Date.now();
    return {
      generatedAt: nowIso(),
      cache: {
        healthAgeMs: Math.max(0, now - cached.cachedAt),
        modelCatalogAgeMs: Math.max(0, now - cached.cachedAt),
        ttlMs: MonarchApplication.STATE_CACHE_TTL_MS,
      },
      queue: {
        queued: 0,
        running: 0,
        terminal: 0,
        total: 0,
        activeJobId: null,
        activeJobAgeMs: null,
      },
    };
  }

  async resolveAgentSurfaceApproval(request: TelegramIntentDispatchRequest): Promise<MonarchIntentResult> {
    await this.ensureStarted();
    if (!request.approval || (!this.agentRuntime && !this.incognitoAgentRuntime)) {
      throw new MonarchApplicationError(409, 'agent-approval-unavailable', 'Durable Agent approval is unavailable.');
    }
    const context = request.context || {};
    const conversationId = surfaceConversationId('telegram', context);
    const privacyMode = this.getOwnerDevSettings().zeroRetentionEnabled ? 'incognito' as const : 'persistent' as const;
    const turnCheckpoint = await this.oscarTurnCoordinator.findLatestTurn({
      conversationId,
      source: 'telegram',
      statuses: ['waiting-for-approval'],
      activeApprovalId: request.approval.approvalId,
      privacyMode,
    });
    if (!turnCheckpoint?.turn.taskId) {
      throw new MonarchApplicationError(409, 'approval-presentation-stale', 'The Telegram approval card is stale or belongs to another chat/user.');
    }
    const surfaceRuntime = await this.resolveAgentRuntimeForTask(turnCheckpoint.turn.taskId);
    const taskCheckpoint = await surfaceRuntime?.getTask(turnCheckpoint.turn.taskId);
    const approval = taskCheckpoint?.approvals.find((entry) => (
      entry.id === request.approval!.approvalId
      && entry.status === 'pending'
      && taskCheckpoint.task.activeApprovalId === entry.id
    ));
    if (!surfaceRuntime || !taskCheckpoint || !approval || taskCheckpoint.task.source.surface !== 'telegram') {
      throw new MonarchApplicationError(409, 'approval-presentation-stale', 'The exact pending Agent approval no longer exists.');
    }
    const requestId = readBoundedContextId(
      `telegram:${String(context.telegramChatId || '')}:${String(context.telegramUserId || '')}:${approval.id}:${request.approval.action}`,
    );
    if (request.approval.action === 'arm') {
      const armed = await surfaceRuntime.armApproval(taskCheckpoint.task.id, approval.id, {
        canonicalProposalHash: approval.canonicalProposalHash,
        capabilityId: approval.capabilityId,
        actorSurface: 'telegram',
        requestId,
      });
      const latest = await this.oscarTurnCoordinator.getTurn(turnCheckpoint.turn.id) || turnCheckpoint;
      const result = this.surfaceTurnResult(latest, taskCheckpoint.task.goal.originalRequest, 'telegram', context);
      if (result.execution) {
        result.execution.metadata = {
          ...(result.execution.metadata || {}),
          armExpiresAt: armed.approvals.find((entry) => entry.id === approval.id)?.arm?.expiresAt || null,
        };
      }
      return result;
    }
    await surfaceRuntime.resolveApproval(taskCheckpoint.task.id, approval.id, {
      decision: request.approval.action,
      grantScope: 'once',
      requestId,
      actorSurface: 'telegram',
      requireArm: request.approval.action === 'approve' && requiresSensitiveAgentApproval(approval),
    });
    const current = await this.oscarTurnCoordinator.getTurn(turnCheckpoint.turn.id) || turnCheckpoint;
    const settled = await this.waitForSurfaceTurn(
      current,
      5 * 60 * 1000,
      (checkpoint) => isSurfaceTurnSettled(checkpoint.turn.status)
        && !(checkpoint.turn.status === 'waiting-for-approval' && checkpoint.turn.activeApprovalId === approval.id),
    );
    return this.surfaceTurnResult(settled, taskCheckpoint.task.goal.originalRequest, 'telegram', context);
  }

  private async waitForSurfaceTurn(
    initial: OscarTurnCheckpoint,
    timeoutMs: number,
    isSettled: (checkpoint: OscarTurnCheckpoint) => boolean = (checkpoint) => isSurfaceTurnSettled(checkpoint.turn.status),
  ): Promise<OscarTurnCheckpoint> {
    if (isSettled(initial)) return initial;
    return new Promise((resolve) => {
      let finished = false;
      let latest = initial;
      let unsubscribe: () => void = () => undefined;
      const finish = (checkpoint: OscarTurnCheckpoint) => {
        if (finished) return;
        latest = checkpoint;
        if (!isSettled(checkpoint)) return;
        finished = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(checkpoint);
      };
      const timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        unsubscribe();
        resolve(latest);
      }, timeoutMs);
      unsubscribe = this.oscarTurnCoordinator.subscribe(initial.turn.id, (commit) => {
        finish({ turn: commit.turn, events: [...latest.events, ...commit.appendedEvents] });
      });
      void this.oscarTurnCoordinator.getTurn(initial.turn.id).then((checkpoint) => {
        if (checkpoint) finish(checkpoint);
      });
    });
  }

  private surfaceTurnResult(
    checkpoint: OscarTurnCheckpoint,
    text: string,
    source: Extract<MonarchIntentSource, 'desktop' | 'telegram' | 'voice' | 'api' | 'system'>,
    context: Record<string, unknown>,
  ): MonarchIntentResult {
    const turn = checkpoint.turn;
    const intent: MonarchIntent = {
      id: turn.id,
      source,
      text,
      createdAt: turn.createdAt,
      context,
    };
    const presentation = approvalPresentation(checkpoint);
    const question = [...checkpoint.events].reverse().find((event) => event.type === 'user.input.required')?.payload.question;
    const summary = turn.outcome?.summary
      || (typeof question === 'string' ? question : '')
      || (presentation ? `Нужно решение по точной capability ${presentation.capabilityId}.` : '')
      || (isSurfaceTurnSettled(turn.status)
        ? 'Проверенный результат не получен.'
        : 'Задача остаётся в durable Turn; финального исхода пока нет.');
    let execution: MonarchExecutionResult;
    if (turn.status === 'waiting-for-approval' && presentation) {
      execution = {
        ok: false,
        error: 'confirmation-required',
        summary,
        output: { reply: summary, turnId: turn.id, agentTaskId: turn.taskId, status: turn.status },
        metadata: { approvalPresentation: presentation },
      };
    } else if (turn.status === 'waiting-for-user') {
      execution = {
        ok: false,
        error: 'clarification-required',
        summary,
        output: { reply: summary, turnId: turn.id, agentTaskId: turn.taskId, status: turn.status },
      };
    } else if (turn.status === 'succeeded' && turn.outcome) {
      execution = {
        ok: true,
        summary,
        output: {
          reply: summary,
          turnId: turn.id,
          agentTaskId: turn.taskId,
          status: turn.status,
          outcome: turn.outcome.kind,
          verified: turn.outcome.kind === 'verified',
          partial: turn.outcome.kind === 'partial',
          evidenceRefs: turn.outcome.evidenceRefs,
        },
      };
    } else {
      const error = turn.status === 'blocked'
        ? 'turn-blocked'
        : turn.status === 'failed'
          ? 'turn-failed'
          : turn.status === 'cancelled'
            ? 'turn-cancelled'
            : 'turn-running';
      execution = {
        ok: false,
        error,
        summary,
        output: { reply: summary, turnId: turn.id, agentTaskId: turn.taskId, status: turn.status },
      };
    }
    this.lastIntent = withUserFacingIntentResult({ intent, route: null, plan: null, execution, summary });
    return this.lastIntent;
  }

}

function readBoundedContextId(value: unknown): string {
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : '';
  const normalized = raw.trim().replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 256);
  return normalized;
}

function surfaceConversationId(
  source: Extract<MonarchIntentSource, 'desktop' | 'telegram' | 'voice' | 'api' | 'system'>,
  context: Record<string, unknown>,
): string {
  if (source === 'telegram') {
    const chatId = readBoundedContextId(context.telegramChatId);
    const userId = readBoundedContextId(context.telegramUserId);
    if (!chatId || !userId) {
      throw new MonarchApplicationError(400, 'telegram-actor-binding-required', 'Telegram Turn requires exact chat_id and user_id bindings.');
    }
    return `telegram:${chatId}:${userId}`;
  }
  return readBoundedContextId(context.clientConversationId)
    || readBoundedContextId(context.clientSessionId)
    || `${source}:default`;
}

function isSurfaceTurnSettled(status: OscarTurnCheckpoint['turn']['status']): boolean {
  return [
    'waiting-for-user',
    'waiting-for-approval',
    'succeeded',
    'blocked',
    'failed',
    'cancelled',
  ].includes(status);
}

function approvalPresentation(checkpoint: OscarTurnCheckpoint): Record<string, unknown> | null {
  const activeApprovalId = checkpoint.turn.activeApprovalId;
  const event = [...checkpoint.events].reverse().find((candidate) => (
    candidate.type === 'approval.required'
    && (!activeApprovalId || candidate.payload.approvalId === activeApprovalId)
  ));
  if (!event) return null;
  const required = ['taskId', 'approvalId', 'capabilityId', 'canonicalProposalHash', 'expiresAt'] as const;
  if (required.some((key) => typeof event.payload[key] !== 'string' || !String(event.payload[key]).trim())) return null;
  return {
    turnId: checkpoint.turn.id,
    taskId: String(event.payload.taskId),
    approvalId: String(event.payload.approvalId),
    capabilityId: String(event.payload.capabilityId),
    canonicalProposalHash: String(event.payload.canonicalProposalHash),
    target: String(event.payload.target || ''),
    risk: String(event.payload.risk || 'action'),
    expiresAt: String(event.payload.expiresAt),
    requiresArm: event.payload.requiresArm === true,
  };
}

function requiresSensitiveAgentApproval(approval: AgentApproval): boolean {
  if (approval.purpose === 'owner-security-override') return true;
  const riskVector = approval.proposal.riskVector;
  const effect = riskVector && typeof riskVector === 'object' && !Array.isArray(riskVector)
    ? String((riskVector as Record<string, unknown>).effect || '')
    : '';
  return /(?:delete|device-control|identity|irreversible|sensitive)/iu.test(effect)
    || /(?:delete|trash|recycle-bin\.empty|identity|credential)/iu.test(approval.capabilityId);
}

function canGrantTaskLease(proposal: MonarchActionProposalV1): boolean {
  return supportsWorkspaceTaskLease(proposal.capabilityId)
    && proposal.riskVector.effect !== 'delete'
    && proposal.riskVector.effect !== 'network'
    && proposal.riskVector.effect !== 'execute'
    && proposal.riskVector.effect !== 'device'
    && proposal.riskVector.reversibility !== 'irreversible'
    && proposal.riskVector.externality === 'local'
    && proposal.riskVector.privilege === 'user'
    && proposal.riskVector.data !== 'secret';
}

function readOscarAnswer(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  if (typeof record.answer === 'string' && record.answer.trim()) return record.answer;
  if (typeof record.content === 'string' && record.content.trim()) return record.content;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return '';
  const choice = first as Record<string, unknown>;
  if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
  const message = choice.message;
  return message && typeof message === 'object' && !Array.isArray(message)
    && typeof (message as Record<string, unknown>).content === 'string'
    ? String((message as Record<string, unknown>).content)
    : '';
}

function isOscarRecoveryPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = (value as Record<string, unknown>).usage;
  return Boolean(
    usage
    && typeof usage === 'object'
    && !Array.isArray(usage)
    && (usage as Record<string, unknown>).runtime_recovery === true,
  );
}

function permissionProfilePath(stateRoot: string): string {
  return path.join(stateRoot, 'settings', 'permissions.json');
}

function readStoredPermissionProfile(stateRoot: string): MonarchPermissionProfile | undefined {
  const filePath = permissionProfilePath(stateRoot);
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (
      (parsed.sandboxMode === 'read-only'
        || parsed.sandboxMode === 'workspace-write'
        || parsed.sandboxMode === 'danger-full-access')
      && (parsed.approvalPolicy === 'on-request' || parsed.approvalPolicy === 'never')
    ) {
      return {
        sandboxMode: parsed.sandboxMode,
        approvalPolicy: parsed.approvalPolicy,
        ...((parsed.autonomyMode === 'guided'
          || parsed.autonomyMode === 'workspace-autonomous'
          || parsed.autonomyMode === 'full-local') ? { autonomyMode: parsed.autonomyMode } : {}),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function migrateStoredOwnerPermissionProfile(
  profile: MonarchPermissionProfile | undefined,
  authority: MonarchAuthorityContext,
): MonarchPermissionProfile | undefined {
  if (!profile || authority.tier !== 'owner') return profile;
  if (profile.sandboxMode !== 'danger-full-access' || profile.approvalPolicy !== 'never') return profile;
  return {
    autonomyMode: 'full-local',
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'on-request',
  };
}

function persistPermissionProfile(stateRoot: string, profile: MonarchPermissionProfile): void {
  try {
    const filePath = permissionProfilePath(stateRoot);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ schemaVersion: 2, ...profile }, null, 2)}\n`, 'utf8');
  } catch {
    // The in-memory profile remains active when a read-only workspace cannot persist settings.
  }
}

function normalizeJobTimeout(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 90000;
  return Math.max(5000, Math.min(Math.floor(parsed), 30 * 60 * 1000));
}

class MonarchApplicationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function readBooleanEnvironment(name: string, fallback: boolean): boolean {
  const value = String(process.env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

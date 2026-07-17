import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  createMonarchRuntime,
  type MonarchBootstrapOptions,
  type MonarchRuntime,
} from '../bootstrap';
import {
  type MonarchConfirmationChallenge,
  createMonarchId,
  nowIso,
  type MonarchExecutionRequest,
  type MonarchExecutionResult,
  type MonarchIntent,
  type MonarchIntentResult,
  type MonarchIntentSource,
  type MonarchPlan,
  type MonarchPermissionProfile,
  type MonarchActionProposalInput,
  type MonarchActionProposalV1,
  type MonarchCapabilityLeaseV1,
  type MonarchRisk,
  type MonarchRecentIntentJobNormalizedStatus,
  type MonarchRecentIntentJobQuery,
  type MonarchRecentIntentJobSnapshot,
  type MonarchRouteDecision,
  type MonarchOperationalContext,
  reduceOperationalContext,
  safePreview,
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
import {
  createAgentSystemProfile,
  type MonarchAgentSystemProfile,
} from './system-profile';
import type { TelegramIntentDispatcher } from '../modules/telegram';

export interface MonarchApplicationOptions extends MonarchBootstrapOptions {
  workspaceRoot?: string;
}

export interface MonarchIntentSubmission {
  text: string;
  source?: MonarchIntentSource;
  confirmed?: boolean;
  confirmationToken?: string;
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
  confirmed?: boolean;
  confirmationToken?: string;
  intentId?: string;
}

export interface MonarchActionProposalSubmission {
  proposal: MonarchActionProposalInput | MonarchActionProposalV1;
  originatingUserText?: string;
  requestedBy?: string;
  model?: string;
  skillIds?: string[];
  confirmed?: boolean;
  confirmationToken?: string;
  grantScope?: 'once' | 'task';
  leaseId?: string;
}

export interface MonarchActionProposalResult {
  proposal: MonarchActionProposalV1;
  result: MonarchExecutionResult;
  confirmation?: MonarchConfirmationChallenge;
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
  selectedModel: ReturnType<typeof selectModelForInput>;
  routerPipeline: ReturnType<typeof createRouterPipeline>;

  lastIntent: MonarchIntentResult | null;
  system: MonarchAgentSystemProfile;
  permissions: MonarchPermissionProfile;
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
  readonly workspaceRoot: string;
  readonly runtime: MonarchRuntime;
  private started = false;
  private startedAt: string | null = null;
  private modelCatalog: MonarchModelCatalog | null = null;
  private cachedRuntimeState: CachedRuntimeState | null = null;

  private lastIntent: MonarchIntentResult | null = null;
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly intentJobs = new Map<string, PendingIntentJob>();
  private readonly operationalContexts = new Map<string, MonarchOperationalContext>();
  private intentJobQueue: Promise<void> = Promise.resolve();

  private static readonly STATE_CACHE_TTL_MS = 1500;

  constructor(options: MonarchApplicationOptions = {}) {
    const { workspaceRoot = process.cwd(), ...bootstrapOptions } = options;
    this.workspaceRoot = workspaceRoot;
    const permissionProfile = bootstrapOptions.permissionProfile
      || readStoredPermissionProfile(workspaceRoot);
    this.runtime = createMonarchRuntime({
      ...bootstrapOptions,
      workspaceRoot,
      ...(permissionProfile ? { permissionProfile } : {}),
    });
    this.runtime.kernel.setRecentIntentJobsProvider((query) => this.listRecentIntentJobs(query));
    const telegramDispatcher: TelegramIntentDispatcher = async (request) => this.submitIntent({
      text: request.text,
      source: 'telegram',
      context: request.context,
      ...(request.confirmed !== undefined ? { confirmed: request.confirmed } : {}),
      ...(request.confirmationToken ? { confirmationToken: request.confirmationToken } : {}),
    });
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

    this.modelCatalog = await readModelCatalog(this.workspaceRoot);
    await this.runtime.kernel.start();
    this.started = true;
    this.startedAt = nowIso();

  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

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
        version: '0.1.0',
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
      selectedModel: selectModelForInput(input, modelCatalog),
      routerPipeline: createRouterPipeline(input, modelCatalog, modelRuntime),

      lastIntent: this.lastIntent,
      system: this.getSystemProfile(),
      permissions: this.runtime.kernel.getPermissionProfile(),
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

    if (submission.confirmed) {
      return this.submitConfirmedIntent(submission, text);
    }

    const operationalScope = readOperationalScope(submission.context);
    const context = {
      ...(submission.context || {}),
      confirmed: false,
      ...(operationalScope ? { operationalContext: this.operationalContexts.get(operationalScope) || {} } : {}),
    };

    this.lastIntent = withUserFacingIntentResult(await this.runtime.kernel.submitIntent(
      text,
      submission.source || 'desktop',
      context
    ));
    this.attachIntentConfirmationIfNeeded(this.lastIntent);
    if (operationalScope) {
      this.operationalContexts.set(
        operationalScope,
        reduceOperationalContext(this.operationalContexts.get(operationalScope) || {}, this.lastIntent),
      );
    }
    return this.lastIntent;
  }

  async submitIntentJob(submission: MonarchIntentJobSubmission): Promise<MonarchIntentJobSnapshot> {
    await this.ensureStarted();
    const text = submission.text.trim();
    if (!text) {
      throw new Error('Intent text is required.');
    }

    const timeoutMs = normalizeJobTimeout(submission.timeoutMs);
    const now = nowIso();
    const clientConversationId = readContextString(submission.context, 'clientConversationId');
    const clientSessionId = readContextString(submission.context, 'clientSessionId');
    const job: PendingIntentJob = {
      id: createMonarchId('job'),
      text,
      source: submission.source || 'desktop',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      timeoutMs,
      summary: 'Intent queued.',
      progress: ['queued'],
      result: null,
      error: null,
      cancelled: false,
    };
    if (clientConversationId) {
      job.clientConversationId = clientConversationId;
    }
    if (clientSessionId) {
      job.clientSessionId = clientSessionId;
    }

    this.intentJobs.set(job.id, job);
    this.pruneIntentJobs();
    this.queueIntentJob(job, {
      ...submission,
      text,
      source: job.source,
      context: {
        ...(submission.context || {}),
        timeoutMs,
        jobId: job.id,
      },
    });

    await this.runtime.kernel.getSnapshot();
    return snapshotIntentJob(job);
  }

  listIntentJobs(limit = 20): MonarchIntentJobSnapshot[] {
    const normalizedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    return Array.from(this.intentJobs.values())
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, normalizedLimit)
      .map(snapshotIntentJob);
  }

  listRecentIntentJobs(query: MonarchRecentIntentJobQuery): readonly MonarchRecentIntentJobSnapshot[] {
    const source = readQueryString(query.source);
    const clientConversationId = readQueryString(query.clientConversationId);
    const clientSessionId = readQueryString(query.clientSessionId);
    if (!source || !clientConversationId || !clientSessionId) {
      return [];
    }

    const excludeJobId = readQueryString(query.excludeJobId);
    const limit = normalizeRecentJobLimit(query.limit);
    const maxAgeMs = normalizeRecentJobMaxAge(query.maxAgeMs);
    const now = Date.now();

    return Array.from(this.intentJobs.values())
      .filter((job) => job.source === source)
      .filter((job) => job.clientConversationId === clientConversationId)
      .filter((job) => job.clientSessionId === clientSessionId)
      .filter((job) => !excludeJobId || job.id !== excludeJobId)
      .map(buildRecentIntentJobSnapshot)
      .filter((job) => now - job.updatedAt <= maxAgeMs)
      .filter((job) => isInjectableRecentJobStatus(job.normalizedStatus))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  }

  getIntentJob(id: string): MonarchIntentJobSnapshot | null {
    const job = this.intentJobs.get(id);
    return job ? snapshotIntentJob(job) : null;
  }

  cancelIntentJob(id: string): MonarchIntentJobSnapshot | null {
    const job = this.intentJobs.get(id);
    if (!job) {
      return null;
    }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'timeout') {
      return snapshotIntentJob(job);
    }

    job.cancelled = true;
    job.status = 'cancelled';
    job.finishedAt = nowIso();
    job.summary = job.startedAt
      ? 'Intent job cancellation requested. Active assistant calls will be aborted when possible.'
      : 'Intent job cancelled before execution.';
    job.progress.push('cancelled');
    touchIntentJob(job);
    this.abortActiveAssistantJob(job.id);
    return snapshotIntentJob(job);
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

    if (execution.confirmed) {
      return this.executeConfirmedCapability(execution, moduleId, capabilityId);
    }

    const request: MonarchExecutionRequest = {
      id: createMonarchId('exec_api'),
      intentId: execution.intentId || createMonarchId('intent_api'),
      moduleId,
      capabilityId,
      input: execution.input ?? {},
      createdAt: nowIso(),
      requestedBy: execution.requestedBy || 'api',
      confirmed: false,
    };

    const result = withUserFacingExecutionResult(await this.runtime.kernel.execute(request));
    this.attachExecutionConfirmationIfNeeded(result, request);
    return result;
  }

  async submitActionProposal(submission: MonarchActionProposalSubmission): Promise<MonarchActionProposalResult> {
    await this.ensureStarted();
    const originatingUserText = String(submission.originatingUserText || '').trim().slice(0, 8_000);
    const requestedBy = String(submission.requestedBy || 'api').trim().slice(0, 200) || 'api';

    if (submission.confirmed) {
      const pending = this.consumeConfirmation(submission.confirmationToken, 'proposal');
      if (!pending.proposal) {
        throw new MonarchApplicationError(400, 'invalid-confirmation', 'Confirmation token is not valid for an action proposal.');
      }
      const supplied = this.runtime.kernel.prepareActionProposal(submission.proposal, {
        intentId: pending.proposal.intentId,
        originatingUserText: pending.originatingUserText || '',
        requestedBy,
        ...(submission.model ? { model: submission.model } : {}),
        ...(submission.skillIds ? { skillIds: submission.skillIds } : {}),
      });
      if (supplied.proposalId !== pending.proposal.proposalId
        || supplied.canonicalHash !== pending.proposal.canonicalHash) {
        throw new MonarchApplicationError(400, 'confirmation-target-mismatch', 'Confirmation token belongs to a different canonical action.');
      }
      const grantScope = submission.grantScope === 'task' ? 'task' : 'once';
      if (grantScope === 'task' && !canGrantTaskLease(pending.proposal)) {
        throw new MonarchApplicationError(400, 'task-grant-not-allowed', 'This action cannot be expanded into a task lease.');
      }
      const lease = grantScope === 'task'
        ? this.runtime.kernel.issueTaskLease(pending.proposal)
        : undefined;
      const executed = await this.runtime.kernel.executeActionProposal(pending.proposal, {
        intentId: pending.proposal.intentId,
        originatingUserText: pending.originatingUserText || '',
        requestedBy,
        confirmed: true,
        securityOverrideConfirmed: pending.securityOverride === true,
        ...(lease ? { leaseId: lease.leaseId } : {}),
      });
      return {
        proposal: executed.proposal,
        result: withUserFacingExecutionResult(executed.result),
        ...(lease ? { lease } : {}),
      };
    }

    const executed = await this.runtime.kernel.executeActionProposal(submission.proposal, {
      originatingUserText,
      requestedBy,
      ...(submission.model ? { model: submission.model } : {}),
      ...(submission.skillIds ? { skillIds: submission.skillIds } : {}),
      ...(submission.leaseId ? { leaseId: submission.leaseId } : {}),
    });
    const result = withUserFacingExecutionResult(executed.result);
    if (result.error !== 'confirmation-required') return { proposal: executed.proposal, result };

    const grantTask = canGrantTaskLease(executed.proposal);
    const capability = this.runtime.kernel.getCapability(executed.proposal.capabilityId);
    const target: MonarchConfirmationChallenge['target'] = {
      intentId: executed.proposal.intentId,
      moduleId: capability?.moduleId || 'unknown',
      capabilityId: executed.proposal.capabilityId,
      ...(capability ? { risk: capability.risk } : {}),
    };
    const confirmation = this.createConfirmation({
      mode: 'proposal',
      proposal: executed.proposal,
      originatingUserText,
      securityOverride: result.metadata?.securityOverride === true,
      target,
      grantOptions: grantTask ? ['once', 'task'] : ['once'],
      ...(grantTask ? {
        suggestedLease: {
          capabilities: [executed.proposal.capabilityId],
          ...(executed.proposal.scope.roots ? { roots: executed.proposal.scope.roots } : {}),
          expiresInMs: 30 * 60 * 1000,
          budgets: { maxActions: 80, maxFiles: 50, maxBytesWritten: 5 * 1024 * 1024, maxDeletes: 0, maxNetworkRequests: 0 },
        },
      } : {}),
    });
    result.metadata = { ...(result.metadata || {}), confirmation };
    return { proposal: executed.proposal, result, confirmation };
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
    this.modelCatalog = await readModelCatalog(this.workspaceRoot);
    return this.modelCatalog;
  }

  private queueIntentJob(job: PendingIntentJob, submission: MonarchIntentSubmission): void {
    if (shouldBypassIntentJobQueue(job.text)) {
      void this.runIntentJob(job, submission).catch((error: unknown) => {
        this.failIntentJob(job, error);
      });
      return;
    }

    const run = this.intentJobQueue
      .catch(() => undefined)
      .then(() => this.runIntentJob(job, submission));

    this.intentJobQueue = run.catch((error: unknown) => {
      this.failIntentJob(job, error);
    });
  }

  getPermissionProfile(): MonarchPermissionProfile {
    return this.runtime.kernel.getPermissionProfile();
  }

  setPermissionProfile(profile: MonarchPermissionProfile): MonarchPermissionProfile {
    const updated = this.runtime.kernel.setPermissionProfile(profile);
    persistPermissionProfile(this.workspaceRoot, updated);
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
    const jobs = Array.from(this.intentJobs.values());
    const runningJob = jobs.find((job) => job.status === 'running') || null;
    return {
      generatedAt: nowIso(),
      cache: {
        healthAgeMs: Math.max(0, now - cached.cachedAt),
        modelCatalogAgeMs: Math.max(0, now - cached.cachedAt),
        ttlMs: MonarchApplication.STATE_CACHE_TTL_MS,
      },
      queue: {
        queued: jobs.filter((job) => job.status === 'queued').length,
        running: jobs.filter((job) => job.status === 'running').length,
        terminal: jobs.filter((job) => ['completed', 'failed', 'cancelled', 'timeout'].includes(job.status)).length,
        total: jobs.length,
        activeJobId: runningJob?.id || null,
        activeJobAgeMs: runningJob?.startedAt ? Math.max(0, now - Date.parse(runningJob.startedAt)) : null,
      },
    };
  }

  private failIntentJob(job: PendingIntentJob, error: unknown): void {
    if (job.status === 'cancelled') {
      return;
    }
    job.status = 'failed';
    job.finishedAt = nowIso();
    const diagnostic = error instanceof Error ? error.message : String(error);
    this.runtime.kernel.audit('intent-job', 'Intent job failed.', {
      jobId: job.id,
      error: diagnostic,
    }, 'error');
    job.error = 'internal-error';
    job.summary = 'Monarch столкнулся с внутренней ошибкой. Подробности сохранены в локальном журнале.';
    job.progress.push('failed');
    touchIntentJob(job);
  }

  private async runIntentJob(job: PendingIntentJob, submission: MonarchIntentSubmission): Promise<void> {
    if (job.cancelled) {
      return;
    }

    job.status = 'running';
    job.startedAt = nowIso();
    job.summary = 'Intent is running through Monarch kernel.';
    job.progress.push('running');
    touchIntentJob(job);

    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Intent job timed out after ${job.timeoutMs}ms.`));
      }, job.timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.submitIntent(submission),
        timeoutPromise,
      ]);

      if (job.cancelled) {
        return;
      }

      job.status = 'completed';
      job.result = result;
      job.summary = result.summary;
      job.progress.push(result.execution?.ok ? 'completed:ok' : result.execution?.error || 'completed');
      touchIntentJob(job);
    } catch (error) {
      if (job.cancelled) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed out/i.test(message);
      job.status = timedOut ? 'timeout' : 'failed';
      job.error = timedOut ? 'intent-timeout' : 'internal-error';
      job.summary = timedOut
        ? 'Задача не успела завершиться вовремя. Повтори запрос или сократи его.'
        : 'Monarch столкнулся с внутренней ошибкой. Подробности сохранены в локальном журнале.';
      this.runtime.kernel.audit('intent-job', 'Intent job execution failed.', {
        jobId: job.id,
        timeout: timedOut,
        error: message,
      }, timedOut ? 'warn' : 'error');
      job.progress.push(job.status);
      touchIntentJob(job);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (!job.finishedAt) {
        const finishedAt = nowIso();
        job.finishedAt = finishedAt;
        job.updatedAt = finishedAt;
      }
    }
  }




  private async submitConfirmedIntent(
    submission: MonarchIntentSubmission,
    text: string
  ): Promise<MonarchIntentResult> {
    const pending = this.consumeConfirmation(submission.confirmationToken, 'intent');
    if (pending.mode !== 'intent' || !pending.intent || !pending.route || !pending.plan) {
      throw new MonarchApplicationError(400, 'invalid-confirmation', 'Confirmation token is not valid for an intent.');
    }
    if (pending.text !== text) {
      throw new MonarchApplicationError(400, 'confirmation-target-mismatch', 'Confirmation token belongs to a different intent.');
    }

    const intent: MonarchIntent = {
      ...pending.intent,
      source: submission.source || pending.intent.source,
      context: {
        ...(pending.intent.context || {}),
        ...(submission.context || {}),
        confirmed: true,
      },
    };
    const planExecution = await this.runtime.kernel.executePlan(pending.plan, {
      requestedBy: intent.source,
      confirmed: true,
      securityOverrideConfirmed: pending.securityOverride === true,
    });
    const execution = planExecution.stepResults.at(-1)?.result || null;
    this.lastIntent = withUserFacingIntentResult({
      intent,
      route: pending.route,
      plan: planExecution.plan,
      execution,
      summary: planExecution.summary,
    });

    this.attachIntentConfirmationIfNeeded(this.lastIntent);
    const operationalScope = readOperationalScope(submission.context);
    if (operationalScope) {
      this.operationalContexts.set(
        operationalScope,
        reduceOperationalContext(this.operationalContexts.get(operationalScope) || {}, this.lastIntent),
      );
    }
    return this.lastIntent;
  }

  private async executeConfirmedCapability(
    execution: MonarchCapabilityExecution,
    moduleId: string,
    capabilityId: string
  ): Promise<MonarchExecutionResult> {
    const pending = this.consumeConfirmation(execution.confirmationToken, 'execution');
    if (pending.mode !== 'execution' || !pending.request) {
      throw new MonarchApplicationError(400, 'invalid-confirmation', 'Confirmation token is not valid for direct execution.');
    }
    if (pending.request.moduleId !== moduleId || pending.request.capabilityId !== capabilityId) {
      throw new MonarchApplicationError(400, 'confirmation-target-mismatch', 'Confirmation token belongs to a different capability.');
    }

    const request: MonarchExecutionRequest = {
      ...pending.request,
      id: createMonarchId('exec_api'),
      createdAt: nowIso(),
      requestedBy: execution.requestedBy || pending.request.requestedBy,
      confirmed: true,
      securityOverrideConfirmed: pending.securityOverride === true,
    };
    const result = withUserFacingExecutionResult(await this.runtime.kernel.execute(request));
    this.attachExecutionConfirmationIfNeeded(result, request);
    return result;
  }

  private abortActiveAssistantJob(jobId: string): void {
    void this.runtime.kernel.execute({
      id: createMonarchId('exec_cancel_job'),
      intentId: jobId,
      moduleId: 'assistant',
      capabilityId: 'assistant.cancel',
      input: { intentId: jobId },
      createdAt: nowIso(),
      requestedBy: 'intent-job-cancel',
      confirmed: true,
    }).catch(() => undefined);
  }

  private attachIntentConfirmationIfNeeded(result: MonarchIntentResult): void {
    if (result.execution?.error !== 'confirmation-required' || !result.route || !result.plan) {
      return;
    }
    const step = result.plan.steps.at(-1);
    if (!step) {
      return;
    }

    const confirmation = this.createConfirmation({
      mode: 'intent',
      text: result.intent.text,
      intent: result.intent,
      route: result.route,
      plan: result.plan,
      securityOverride: result.execution.metadata?.securityOverride === true,
      target: {
        intentId: result.intent.id,
        planId: result.plan.id,
        stepId: step.id,
        moduleId: step.moduleId,
        capabilityId: step.capabilityId,
        risk: step.expectedRisk,
      },
    });
    result.confirmation = confirmation;
    result.execution.metadata = {
      ...(result.execution.metadata || {}),
      confirmation,
    };
  }

  private attachExecutionConfirmationIfNeeded(
    result: MonarchExecutionResult,
    request: MonarchExecutionRequest
  ): void {
    if (result.error !== 'confirmation-required') {
      return;
    }

    const risk = typeof result.metadata?.permission === 'object' && result.metadata.permission
      ? (result.metadata.permission as { risk?: unknown }).risk
      : undefined;
    const target: MonarchConfirmationChallenge['target'] = {
      intentId: request.intentId,
      moduleId: request.moduleId,
      capabilityId: request.capabilityId,
    };
    if (request.planId) {
      target.planId = request.planId;
    }
    if (request.stepId) {
      target.stepId = request.stepId;
    }
    if (isMonarchRisk(risk)) {
      target.risk = risk;
    }

    const confirmation = this.createConfirmation({
      mode: 'execution',
      request,
      target,
      securityOverride: result.metadata?.securityOverride === true,
    });
    result.metadata = {
      ...(result.metadata || {}),
      confirmation,
    };
  }

  private createConfirmation(
    options: Omit<PendingConfirmation, 'token' | 'expiresAt' | 'challenge'>
  ): MonarchConfirmationChallenge {
    this.pruneExpiredConfirmations();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const challenge: MonarchConfirmationChallenge = {
      token,
      mode: options.mode,
      expiresAt,
      target: options.target,
      ...(options.grantOptions ? { grantOptions: options.grantOptions } : {}),
      ...(options.suggestedLease ? { suggestedLease: options.suggestedLease } : {}),
    };
    this.pendingConfirmations.set(token, {
      ...options,
      token,
      expiresAt,
      challenge,
    });
    return challenge;
  }

  private consumeConfirmation(
    token: string | undefined,
    mode: PendingConfirmation['mode']
  ): PendingConfirmation {
    this.pruneExpiredConfirmations();
    if (!token) {
      throw new MonarchApplicationError(400, 'missing-confirmation-token', 'Confirmed execution requires a confirmation token.');
    }
    const pending = this.pendingConfirmations.get(token);
    this.pendingConfirmations.delete(token);
    if (!pending || pending.mode !== mode) {
      throw new MonarchApplicationError(400, 'invalid-confirmation-token', 'Confirmation token is invalid or expired.');
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      throw new MonarchApplicationError(400, 'expired-confirmation-token', 'Confirmation token expired.');
    }
    return pending;
  }

  private pruneExpiredConfirmations(): void {
    const now = Date.now();
    for (const [token, pending] of this.pendingConfirmations) {
      if (Date.parse(pending.expiresAt) <= now) {
        this.pendingConfirmations.delete(token);
      }
    }
  }

  private pruneIntentJobs(): void {
    const maxJobs = 50;
    if (this.intentJobs.size <= maxJobs) {
      return;
    }

    const removable = Array.from(this.intentJobs.values())
      .filter((job) => job.status !== 'running' && job.status !== 'queued')
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

    for (const job of removable) {
      if (this.intentJobs.size <= maxJobs) {
        return;
      }
      this.intentJobs.delete(job.id);
    }
  }
}

interface PendingConfirmation {
  token: string;
  mode: 'intent' | 'execution' | 'proposal';
  expiresAt: string;
  challenge: MonarchConfirmationChallenge;
  target: MonarchConfirmationChallenge['target'];
  text?: string;
  intent?: MonarchIntent;
  route?: MonarchRouteDecision;
  plan?: MonarchPlan;
  request?: MonarchExecutionRequest;
  proposal?: MonarchActionProposalV1;
  originatingUserText?: string;
  grantOptions?: Array<'once' | 'task'>;
  suggestedLease?: MonarchConfirmationChallenge['suggestedLease'];
  securityOverride?: boolean;
}

interface PendingIntentJob extends MonarchIntentJobSnapshot {
  cancelled: boolean;
}

function canGrantTaskLease(proposal: MonarchActionProposalV1): boolean {
  return proposal.capabilityId.startsWith('workspace.')
    && proposal.riskVector.effect !== 'delete'
    && proposal.riskVector.effect !== 'network'
    && proposal.riskVector.effect !== 'execute'
    && proposal.riskVector.effect !== 'device'
    && proposal.riskVector.reversibility !== 'irreversible'
    && proposal.riskVector.externality === 'local'
    && proposal.riskVector.privilege === 'user'
    && proposal.riskVector.data !== 'secret';
}

function snapshotIntentJob(job: PendingIntentJob): MonarchIntentJobSnapshot {
  const snapshot: MonarchIntentJobSnapshot = {
    id: job.id,
    text: job.text,
    source: job.source,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    timeoutMs: job.timeoutMs,
    summary: job.summary,
    progress: [...job.progress],
    result: job.result,
    error: job.error,
  };
  if (job.clientConversationId) {
    snapshot.clientConversationId = job.clientConversationId;
  }
  if (job.clientSessionId) {
    snapshot.clientSessionId = job.clientSessionId;
  }
  return snapshot;
}

function permissionProfilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'runtime', 'settings', 'permissions.json');
}

function readStoredPermissionProfile(workspaceRoot: string): MonarchPermissionProfile | undefined {
  const filePath = permissionProfilePath(workspaceRoot);
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

function persistPermissionProfile(workspaceRoot: string, profile: MonarchPermissionProfile): void {
  try {
    const filePath = permissionProfilePath(workspaceRoot);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  } catch {
    // The in-memory profile remains active when a read-only workspace cannot persist settings.
  }
}

function buildRecentIntentJobSnapshot(job: PendingIntentJob): MonarchRecentIntentJobSnapshot {
  const result = job.result;
  const step = result?.plan?.steps.at(-1);
  const execution = result?.execution;
  const executionRecord = execution as (MonarchExecutionResult & { result?: unknown }) | null | undefined;
  const snapshot: MonarchRecentIntentJobSnapshot = {
    jobId: job.id,
    source: job.source,
    createdAt: parseTimestamp(job.createdAt),
    updatedAt: parseTimestamp(job.updatedAt),
    normalizedStatus: normalizeRecentIntentJobStatus(job),
  };

  if (job.clientConversationId) {
    (snapshot as WritableRecentIntentJobSnapshot).clientConversationId = job.clientConversationId;
  }
  if (job.clientSessionId) {
    (snapshot as WritableRecentIntentJobSnapshot).clientSessionId = job.clientSessionId;
  }

  const routeTarget = result?.route?.targetModuleId || step?.moduleId;
  if (routeTarget) {
    (snapshot as WritableRecentIntentJobSnapshot).routeTarget = routeTarget;
  }

  const capability = result?.route?.capabilityId || step?.capabilityId;
  if (capability) {
    (snapshot as WritableRecentIntentJobSnapshot).capability = capability;
  }

  const inputSummary = safePreview(step?.input ?? result?.route?.input ?? { text: job.text });
  if (inputSummary) {
    (snapshot as WritableRecentIntentJobSnapshot).inputSummary = inputSummary;
  }

  const resultSummary = safePreview(execution?.output ?? executionRecord?.result ?? result?.summary ?? job.summary);
  if (resultSummary) {
    (snapshot as WritableRecentIntentJobSnapshot).resultSummary = resultSummary;
  }

  const errorSummary = safePreview(job.error ?? execution?.error);
  if (errorSummary) {
    (snapshot as WritableRecentIntentJobSnapshot).errorSummary = errorSummary;
  }

  return Object.freeze(snapshot);
}

type WritableRecentIntentJobSnapshot = {
  -readonly [Key in keyof MonarchRecentIntentJobSnapshot]: MonarchRecentIntentJobSnapshot[Key];
};

function normalizeRecentIntentJobStatus(job: PendingIntentJob): MonarchRecentIntentJobNormalizedStatus {
  if (job.status === 'queued' || job.status === 'running') {
    return 'running';
  }
  if (job.status === 'cancelled') {
    return 'user_aborted';
  }
  if (job.status === 'failed' || job.status === 'timeout') {
    return 'runtime_failure';
  }
  if (job.status !== 'completed') {
    return 'unknown';
  }

  const execution = job.result?.execution;
  if (execution?.error === 'confirmation-required') {
    return 'paused_at_security_gate';
  }
  if (execution?.ok) {
    return 'success';
  }
  if (execution?.error) {
    return 'execution_failed';
  }
  return 'unknown';
}

function isInjectableRecentJobStatus(status: MonarchRecentIntentJobNormalizedStatus): boolean {
  return status === 'success'
    || status === 'paused_at_security_gate'
    || status === 'user_aborted'
    || status === 'execution_failed'
    || status === 'runtime_failure';
}

function touchIntentJob(job: PendingIntentJob): void {
  job.updatedAt = nowIso();
}

function normalizeJobTimeout(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 90000;
  return Math.max(5000, Math.min(Math.floor(parsed), 30 * 60 * 1000));
}

function shouldBypassIntentJobQueue(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(cancel|abort|status|health|diagnose|diagnostic|audit|logs?|integrity|queue|отмени|прерви|статус|здоров|диагност|аудит|логи|целост|очеред)/i.test(normalized)
    && /(oscar|security|protect|model|runtime|monarch|безопас|защит|модель|рантайм|монарх)/i.test(normalized);
}

function normalizeRecentJobLimit(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  return Math.max(1, Math.min(Math.floor(parsed), 20));
}

function normalizeRecentJobMaxAge(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : 5 * 60 * 1000;
  return Math.max(1000, Math.min(Math.floor(parsed), 30 * 60 * 1000));
}

function readContextString(context: Record<string, unknown> | undefined, key: string): string {
  const value = context?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readOperationalScope(context: Record<string, unknown> | undefined): string {
  const conversationId = readContextString(context, 'clientConversationId');
  const sessionId = readContextString(context, 'clientSessionId');
  return conversationId && sessionId ? `${sessionId}\u0000${conversationId}` : '';
}

function readQueryString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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

function isMonarchRisk(value: unknown): value is MonarchRisk {
  return value === 'none'
    || value === 'read'
    || value === 'write'
    || value === 'delete'
    || value === 'execute'
    || value === 'network'
    || value === 'device-control'
    || value === 'money'
    || value === 'identity'
    || value === 'security-sensitive';
}

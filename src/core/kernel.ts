import type {
  MonarchEvent,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchIntentResult,
  MonarchIntentSource,
  MonarchKernelContext,
  MonarchLlmRouter,
  MonarchModule,
  MonarchPermissionDecision,
  MonarchPlan,
  MonarchPlanExecutionResult,
  MonarchPlanningMemoryReference,
  MonarchRecentIntentJobQuery,
  MonarchRecentIntentJobSnapshot,
  MonarchRouteDecision,
  MonarchAuditSeverity,
  MonarchPermissionProfile,
  MonarchActionProposalInput,
  MonarchActionProposalV1,
  MonarchCapability,
  MonarchCapabilityLeaseV1,
  MonarchActionLedgerRecord,
  MonarchActionRollbackState,
} from './contracts';
import { MonarchAuditLog } from './audit-log';
import { MonarchCapabilityRegistry } from './capability-registry';
import { MonarchEventBus } from './event-bus';
import { MonarchExecutionEngine } from './execution-engine';
import { MonarchHealthMonitor, type MonarchHealthSnapshot } from './health-monitor';
import { MonarchModuleRegistry } from './module-registry';
import { MonarchPermissionGate } from './permission-gate';
import { MonarchPlanner } from './planner';
import { MonarchRouterMesh } from './router-mesh';
import { createMonarchId, normalizeText, nowIso } from './utils';
import { normalizeActionProposal } from './action-protocol';
import { MonarchActionLedger } from './action-ledger';
import { MonarchCapabilityLeaseStore } from './capability-leases';
import { MonarchPolicyKernel } from './policy-kernel';
import { MonarchMutationJournal } from './mutation-journal';
import path from 'node:path';

export interface MonarchKernelSnapshot {
  modules: ReturnType<MonarchModuleRegistry['listRecords']>;
  capabilities: ReturnType<MonarchCapabilityRegistry['list']>;
  events: MonarchEvent[];
  audit: ReturnType<MonarchAuditLog['list']>;
}

export interface MonarchKernelOptions {
  workspaceRoot?: string;
  agencyStateDirectory?: string | false;
  llmRouter?: MonarchLlmRouter;
  recentIntentJobsProvider?: (query: MonarchRecentIntentJobQuery) => readonly MonarchRecentIntentJobSnapshot[];
  permissionProfile?: MonarchPermissionProfile;
}

export class MonarchKernel {
  private readonly auditLog = new MonarchAuditLog();
  private readonly eventBus = new MonarchEventBus();
  private readonly modules = new MonarchModuleRegistry();
  private readonly capabilities = new MonarchCapabilityRegistry();
  private readonly permissions: MonarchPermissionGate;
  private readonly leases: MonarchCapabilityLeaseStore;
  private readonly actionLedger: MonarchActionLedger;
  private readonly mutationJournal: MonarchMutationJournal;
  private readonly policy: MonarchPolicyKernel;
  private readonly router: MonarchRouterMesh;
  private readonly planner = new MonarchPlanner();
  private readonly execution: MonarchExecutionEngine;
  private readonly health = new MonarchHealthMonitor(this.modules);
  private recentIntentJobsProvider: (query: MonarchRecentIntentJobQuery) => readonly MonarchRecentIntentJobSnapshot[];
  private readonly workspaceRoot: string;

  constructor(options: MonarchKernelOptions = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.permissions = new MonarchPermissionGate(options.permissionProfile);
    const agencyRuntimeRoot = options.agencyStateDirectory === false
      ? null
      : options.agencyStateDirectory
        ? path.resolve(this.workspaceRoot, options.agencyStateDirectory)
        : options.workspaceRoot
          ? path.join(this.workspaceRoot, 'runtime', 'agency')
          : null;
    this.leases = new MonarchCapabilityLeaseStore(
      this.workspaceRoot,
      agencyRuntimeRoot ? path.join(agencyRuntimeRoot, 'capability-leases.json') : undefined,
    );
    this.actionLedger = new MonarchActionLedger(
      500,
      agencyRuntimeRoot ? path.join(agencyRuntimeRoot, 'action-ledger.json') : undefined,
    );
    this.mutationJournal = new MonarchMutationJournal(
      this.workspaceRoot,
      agencyRuntimeRoot ? path.join(agencyRuntimeRoot, 'mutation-journal') : undefined,
    );
    this.policy = new MonarchPolicyKernel(this.permissions, this.leases);
    this.execution = new MonarchExecutionEngine(
      this.modules,
      this.capabilities,
      this.policy,
      this.actionLedger,
      this.mutationJournal,
      this.workspaceRoot,
    );
    this.router = new MonarchRouterMesh(options.llmRouter);
    this.recentIntentJobsProvider = options.recentIntentJobsProvider || (() => []);
  }

  registerModule(module: MonarchModule): void {
    const record = this.modules.register(module);
    try {
      this.capabilities.registerModule(record.manifest);
    } catch (error) {
      this.modules.unregister(record.manifest.id);
      throw error;
    }
  }

  subscribeEvent(type: string, listener: (event: MonarchEvent) => void | Promise<void>): () => void {
    return this.eventBus.subscribe(type, listener);
  }

  setRecentIntentJobsProvider(
    provider: (query: MonarchRecentIntentJobQuery) => readonly MonarchRecentIntentJobSnapshot[]
  ): void {
    this.recentIntentJobsProvider = provider;
  }

  async start(): Promise<void> {
    this.modules.validateDependencies();
    const context = this.createContext();
    const traceStartup = /^(1|true|yes)$/i.test(process.env.MONARCH_STARTUP_TRACE || '');

    for (const module of this.modules.listModulesInDependencyOrder()) {
      try {
        if (traceStartup) {
          console.log(`[startup] Activating module ${module.manifest.id}...`);
        }
        await module.activate(context);
        this.modules.setStatus(module.manifest.id, 'active');
        await context.emit('module.started', 'kernel', {
          moduleId: module.manifest.id,
          version: module.manifest.version,
        });
        if (traceStartup) {
          console.log(`[startup] Module ${module.manifest.id} ready.`);
        }
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        this.modules.setStatus(module.manifest.id, 'failed', message);
        await context.emit('module.failed', 'kernel', {
          moduleId: module.manifest.id,
          error: message,
        });
        throw error;
      }
    }
  }

  async stop(): Promise<void> {
    const context = this.createContext();

    for (const module of Array.from(this.modules.listModulesInDependencyOrder()).reverse()) {
      try {
        if (module.deactivate) {
          await module.deactivate(context);
        }
        this.modules.setStatus(module.manifest.id, 'inactive');
        await context.emit('module.stopped', 'kernel', {
          moduleId: module.manifest.id,
        });
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        this.modules.setStatus(module.manifest.id, 'failed', message);
        await context.emit('module.stop_failed', 'kernel', {
          moduleId: module.manifest.id,
          error: message,
        });
      }
    }
  }

  async submitIntent(
    text: string,
    source: MonarchIntentSource = 'desktop',
    contextData: Record<string, unknown> = {}
  ): Promise<MonarchIntentResult> {
    const intent: MonarchIntent = {
      id: typeof contextData.jobId === 'string' && contextData.jobId.trim()
        ? contextData.jobId.trim()
        : createMonarchId('intent'),
      source,
      text: normalizeText(text),
      createdAt: nowIso(),
      context: contextData,
    };

    const context = this.createContext();
    await context.emit('intent.received', source, {
      intentId: intent.id,
      text: intent.text,
      ...(contextData.modelProposed === true ? { modelProposed: true } : {}),
      ...(typeof contextData.originatingUserText === 'string' && contextData.originatingUserText.trim()
        ? { originatingUserText: normalizeText(contextData.originatingUserText).slice(0, 4000) }
        : {}),
      ...(typeof contextData.jobId === 'string' ? { jobId: contextData.jobId } : {}),
    });

    const route = await this.routeIntent(intent);
    if (!route) {
      await context.emit('intent.unrouted', 'router-mesh', {
        intentId: intent.id,
      });

      // Retrieve the last route trace for this intent to check for unresolved reason
      const lastTraceEvent = this.getEvents()
        .slice()
        .reverse()
        .find((e) => e.type === 'router.route_trace' && (e.payload as any)?.intentId === intent.id);

      const tracePayload = lastTraceEvent?.payload as any;
      if (
        tracePayload
        && (tracePayload.unresolvedReason === 'ambiguous' || tracePayload.unresolvedReason === 'missing-input')
      ) {
        const clarificationSummary = formatClarificationSummary(tracePayload);
        return {
          intent,
          route: null,
          plan: null,
          execution: {
            ok: false,
            summary: clarificationSummary,
            error: 'clarification-required',
            output: {
              mode: 'clarification-required',
              clarificationMode: tracePayload.unresolvedReason,
              text: intent.text,
              candidates: tracePayload.candidates?.slice(0, 3).map((c: any) => ({
                targetModuleId: c.targetModuleId,
                capabilityId: c.capabilityId,
                confidence: c.confidence,
                missingInput: c.missingInput || null,
              })) || [],
            },
          },
          summary: clarificationSummary,
        };
      }

      return {
        intent,
        route: null,
        plan: null,
        execution: null,
        summary: 'No module could route this intent yet.',
      };
    }

    await context.emit('intent.routed', 'router-mesh', {
      intentId: intent.id,
      route,
    });

    if (!route.capabilityId) {
      const plan = await this.buildPlan(intent, route);
      return {
        intent,
        route,
        plan,
        execution: null,
        summary: `Intent routed to module ${route.targetModuleId}, but no executable capability was selected.`,
      };
    }

    const capability = this.capabilities.get(route.capabilityId);
    if (!this.planner.requiresPlanning(intent, route, capability)) {
      const execution = await this.execution.execute({
        id: createMonarchId('exec_atomic'),
        intentId: intent.id,
        moduleId: route.targetModuleId,
        capabilityId: route.capabilityId,
        input: route.input ?? { text: intent.text, context: intent.context || {} },
        createdAt: nowIso(),
        requestedBy: intent.source,
        confirmed: Boolean(intent.context?.confirmed),
      }, context);
      if (execution.error !== 'confirmation-required') {
        return {
          intent,
          route,
          plan: null,
          execution,
          summary: execution.summary,
        };
      }
      // A permission/security challenge needs a replayable plan, but ordinary
      // atomic actions never pay the planning/memory cost.
      const confirmationPlan = this.createPlan(intent, route);
      return {
        intent,
        route,
        plan: confirmationPlan,
        execution,
        summary: execution.summary,
      };
    }

    const plan = await this.buildPlan(intent, route);
    const planExecution = await this.executePlan(plan, {
      requestedBy: intent.source,
      confirmed: Boolean(intent.context?.confirmed),
    });
    const execution = planExecution.stepResults.at(-1)?.result || null;

    return {
      intent,
      route,
      plan: planExecution.plan,
      execution,
      summary: planExecution.summary,
    };
  }

  async routeIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    const excludedModuleIds = readExcludedModuleIds(intent.context?.excludedModuleIds);
    const modules = excludedModuleIds.size === 0
      ? this.modules.listModules()
      : this.modules.listModules().filter((module) => !excludedModuleIds.has(module.manifest.id));
    return this.router.route(intent, modules, this.createContext());
  }

  getModule(moduleId: string): MonarchModule | undefined {
    return this.modules.getModule(moduleId);
  }

  async execute(request: MonarchExecutionRequest): Promise<MonarchExecutionResult> {
    return this.execution.execute(request, this.createContext());
  }

  async executeActionProposal(
    input: MonarchActionProposalInput | MonarchActionProposalV1,
    options: {
      intentId?: string;
      originatingUserText?: string;
      requestedBy?: string;
      model?: string;
      skillIds?: string[];
      confirmed?: boolean;
      securityOverrideConfirmed?: boolean;
      leaseId?: string;
      executionMode?: 'coder';
      permissionProfileOverride?: MonarchPermissionProfile;
    } = {},
  ): Promise<{ proposal: MonarchActionProposalV1; result: MonarchExecutionResult }> {
    const proposal = this.prepareActionProposal(input, options);
    const capability = this.capabilities.get(proposal.capabilityId)!;
    const context = this.createContext();
    await context.emit('action.proposal.received', 'action-protocol', {
      proposalId: proposal.proposalId,
      intentId: proposal.intentId,
      capabilityId: proposal.capabilityId,
      canonicalHash: proposal.canonicalHash,
      provenance: proposal.provenance,
    });
    const result = await this.execution.execute({
      id: createMonarchId('exec_proposal'),
      intentId: proposal.intentId,
      moduleId: capability.moduleId,
      capabilityId: proposal.capabilityId,
      input: proposal.args,
      createdAt: nowIso(),
      requestedBy: options.requestedBy || proposal.provenance.source,
      confirmed: options.confirmed === true,
      securityOverrideConfirmed: options.securityOverrideConfirmed === true,
      proposalId: proposal.proposalId,
      proposalHash: proposal.canonicalHash,
      intentHash: proposal.intentHash,
      idempotencyKey: proposal.idempotencyKey,
      riskVector: proposal.riskVector,
      actionScope: proposal.scope,
      ...(proposal.preconditions ? { preconditions: proposal.preconditions } : {}),
      ...(proposal.verification ? { verification: proposal.verification } : {}),
      ...(options.originatingUserText ? { originatingUserText: options.originatingUserText } : {}),
      skillIds: proposal.provenance.skillIds,
      modelId: proposal.provenance.model,
      ...(options.leaseId ? { leaseId: options.leaseId } : {}),
      ...(options.executionMode ? { executionMode: options.executionMode } : {}),
      ...(options.permissionProfileOverride ? { permissionProfileOverride: options.permissionProfileOverride } : {}),
    }, context);
    return { proposal, result };
  }

  prepareActionProposal(
    input: MonarchActionProposalInput | MonarchActionProposalV1,
    options: {
      intentId?: string;
      originatingUserText?: string;
      requestedBy?: string;
      model?: string;
      skillIds?: string[];
    } = {},
  ): MonarchActionProposalV1 {
    const capabilityId = typeof input?.capabilityId === 'string' ? input.capabilityId.trim() : '';
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      throw new Error(`Unknown action proposal capability: ${capabilityId || '(empty)'}`);
    }
    return normalizeActionProposal(input, {
        capability,
        workspaceRoot: this.workspaceRoot,
        ...(options.intentId ? { intentId: options.intentId } : {}),
        ...(options.originatingUserText ? { originatingUserText: options.originatingUserText } : {}),
        ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.skillIds ? { skillIds: options.skillIds } : {}),
        ...(input.provenance?.source ? { source: input.provenance.source } : {}),
      });
  }

  async executePlan(
    plan: MonarchPlan,
    options: { requestedBy: string; confirmed?: boolean; securityOverrideConfirmed?: boolean } = { requestedBy: 'system' }
  ): Promise<MonarchPlanExecutionResult> {
    return this.execution.executePlan(plan, this.createContext(), options);
  }

  async checkHealth(): Promise<MonarchHealthSnapshot> {
    return this.health.check(this.createContext());
  }

  audit(
    category: string,
    message: string,
    data?: unknown,
    severity: MonarchAuditSeverity = 'info'
  ): ReturnType<MonarchAuditLog['append']> {
    return this.auditLog.append(category, message, data, severity);
  }

  getPermissionProfile(): MonarchPermissionProfile {
    return this.permissions.getProfile();
  }

  setPermissionProfile(profile: MonarchPermissionProfile): MonarchPermissionProfile {
    const updated = this.permissions.setProfile(profile);
    this.auditLog.append('permission', 'Permission profile changed.', updated, 'info');
    return updated;
  }

  getCapability(capabilityId: string): MonarchCapability | undefined {
    return this.capabilities.get(capabilityId);
  }

  listCapabilities(moduleId?: string): MonarchCapability[] {
    return moduleId ? this.capabilities.listByModule(moduleId) : this.capabilities.list();
  }

  issueTaskLease(proposal: MonarchActionProposalV1): MonarchCapabilityLeaseV1 {
    const lease = this.leases.issueForProposal(proposal);
    this.auditLog.append('policy', 'Capability task lease issued.', {
      leaseId: lease.leaseId,
      capabilities: lease.capabilities,
      roots: lease.roots,
      expiresAt: lease.expiresAt,
      budgets: lease.budgets,
    }, 'info');
    return lease;
  }

  listCapabilityLeases(activeOnly = false): MonarchCapabilityLeaseV1[] {
    return this.leases.list({ activeOnly });
  }

  revokeCapabilityLease(leaseId: string): MonarchCapabilityLeaseV1 | null {
    const lease = this.leases.revoke(leaseId);
    if (lease) this.auditLog.append('policy', 'Capability task lease revoked.', { leaseId }, 'warn');
    return lease;
  }

  listActionLedger(limit = 100): MonarchActionLedgerRecord[] {
    return this.actionLedger.list(limit);
  }

  async rollbackAction(ledgerId: string): Promise<MonarchActionRollbackState | null> {
    const record = this.actionLedger.getByLedgerId(ledgerId);
    if (!record) return null;
    const rollback = await this.mutationJournal.rollback(ledgerId);
    if (!rollback) return null;
    this.actionLedger.setRollback(record.idempotencyKey, rollback);
    this.auditLog.append('execution', 'Workspace action rollback evaluated.', {
      ledgerId,
      status: rollback.status,
      targetPath: rollback.targetPath,
      reason: rollback.reason,
    }, rollback.status === 'rolled-back' ? 'warn' : 'info');
    return rollback;
  }

  getEvents(): MonarchEvent[] {
    return this.eventBus.getHistory();
  }

  getSnapshot(): MonarchKernelSnapshot {
    return {
      modules: this.modules.listRecords(),
      capabilities: this.capabilities.list(),
      events: this.getEvents(),
      audit: this.auditLog.list(),
    };
  }

  private createPlan(intent: MonarchIntent, route: MonarchRouteDecision): MonarchPlan {
    return this.planner.createPlan(
      intent,
      route,
      route.capabilityId ? this.capabilities.get(route.capabilityId) : undefined
    );
  }

  private async buildPlan(intent: MonarchIntent, route: MonarchRouteDecision): Promise<MonarchPlan> {
    const initialPlan = this.createPlan(intent, route);
    if (!initialPlan.requiresPlanning) {
      return initialPlan;
    }
    const planningMemory = await this.collectPlanningMemory(intent, route);
    if (planningMemory.length === 0) {
      return initialPlan;
    }
    return this.planner.createPlan(
      intent,
      route,
      route.capabilityId ? this.capabilities.get(route.capabilityId) : undefined,
      planningMemory
    );
  }

  private async collectPlanningMemory(
    intent: MonarchIntent,
    route: MonarchRouteDecision
  ): Promise<MonarchPlanningMemoryReference[]> {
    if (route.targetModuleId === 'memory' || !this.capabilities.get('memory.search')) {
      return [];
    }
    try {
      const result = await this.execution.execute({
        id: createMonarchId('exec_plan_memory'),
        intentId: intent.id,
        moduleId: 'memory',
        capabilityId: 'memory.search',
        input: {
          query: intent.text,
          limit: 5,
          localOnly: true,
          types: ['project_decision', 'architecture_note', 'active_bug', 'technical_debt', 'module_state', 'handoff_note', 'diagnostic_note', 'planning_note'],
        },
        createdAt: nowIso(),
        requestedBy: 'planner',
        confirmed: true,
      }, this.createContext());
      if (!result.ok || !result.output || typeof result.output !== 'object') {
        return [];
      }
      const records = (result.output as { records?: unknown }).records;
      if (!Array.isArray(records)) {
        return [];
      }
      return records.map(readPlanningMemoryReference).filter((entry): entry is MonarchPlanningMemoryReference => Boolean(entry));
    } catch (error) {
      await this.auditLog.append(
        'planning',
        'Planning memory lookup failed; continuing without memory context.',
        { intentId: intent.id, error: error instanceof Error ? error.message : String(error) },
        'warn'
      );
      return [];
    }
  }

  private createContext(): MonarchKernelContext {
    return {
      emit: async (type, source, payload) => this.eventBus.emit(type, source, payload),
      audit: async (category, message, data, severity) => this.auditLog.append(category, message, data, severity),
      requestPermission: async (request) => this.requestPermission(request),
      execute: async (request) => this.execute(request),
      getCapability: (capabilityId) => this.capabilities.get(capabilityId),
      listCapabilities: (moduleId) => moduleId
        ? this.capabilities.listByModule(moduleId)
        : this.capabilities.list(),
      listModules: () => this.modules.listRecords(),
      listEvents: () => this.eventBus.getHistory(),
      listAudit: () => this.auditLog.list(),
      listRecentIntentJobs: (query) => this.recentIntentJobsProvider(query),
      getPermissionProfile: () => this.permissions.getProfile(),
    };
  }

  private async requestPermission(
    request: MonarchExecutionRequest
  ): Promise<MonarchPermissionDecision> {
    const capability = this.capabilities.get(request.capabilityId);
    return this.permissions.evaluate(request, capability);
  }
}

function readExcludedModuleIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean));
}

function formatClarificationSummary(tracePayload: any): string {
  if (tracePayload?.unresolvedReason === 'missing-input') {
    const missing = readMissingInputNames(tracePayload);
    return missing.length > 0
      ? `Нужно уточнение: не хватает ${missing.join(', ')}.`
      : 'Нужно уточнение: не хватает данных для безопасного действия.';
  }
  if (tracePayload?.unresolvedReason === 'ambiguous') {
    return 'Нужно уточнение: запрос подходит под несколько действий.';
  }
  return 'Нужно уточнение для безопасного выполнения.';
}

function readMissingInputNames(tracePayload: any): string[] {
  const topCandidate = Array.isArray(tracePayload?.candidates) ? tracePayload.candidates[0] : null;
  const rawNames: string[] = Array.isArray(topCandidate?.missingInput)
    ? topCandidate.missingInput.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const readable = rawNames.map((name) => {
    if (name === 'path') return 'пути или имени файла/папки';
    if (name === 'content') return 'текста';
    if (name === 'targetPath') return 'целевого пути';
    return name;
  });
  return Array.from(new Set(readable));
}

function readPlanningMemoryReference(value: unknown): MonarchPlanningMemoryReference | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = readOptionalString(record.id);
  const text = readOptionalString(record.excerpt)
    || readOptionalString(record.content)
    || readOptionalString(record.text);
  if (!id || !text) {
    return null;
  }
  const type = readOptionalString(record.type) || readOptionalString(record.category) || 'planning_note';
  const reference: MonarchPlanningMemoryReference = {
    id,
    type,
    title: readOptionalString(record.title) || text.slice(0, 80),
    excerpt: text.length > 420 ? `${text.slice(0, 417).trim()}...` : text,
  };
  const source = readOptionalString(record.source);
  if (source) reference.source = source;
  const relevance = readOptionalNumber(record.relevance)
    ?? readOptionalNumber(record.priority)
    ?? readOptionalNumber(record.importance);
  if (relevance !== undefined) reference.relevance = relevance;
  const relatedFiles = readOptionalStringArray(record.relatedFiles).concat(readOptionalStringArray(record.related_files));
  if (relatedFiles.length > 0) reference.relatedFiles = relatedFiles;
  const relatedModules = readOptionalStringArray(record.relatedModules).concat(readOptionalStringArray(record.related_modules));
  if (relatedModules.length > 0) reference.relatedModules = relatedModules;
  return reference;
}

function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 12)
    : [];
}

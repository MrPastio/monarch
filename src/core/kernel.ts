import { traceMonarchStartup } from './startup-timing';
import type {
  MonarchEvent,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchIntent,
  MonarchIntentResult,
  MonarchIntentSource,
  MonarchKernelContext,
  MonarchModule,
  MonarchPermissionDecision,
  MonarchPlan,
  MonarchPlanExecutionResult,
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
  MonarchAuthorityContext,
} from './contracts';
import { MONARCH_PUBLIC_AUTHORITY_CONTEXT } from './contracts';
import { MonarchAuditLog } from './audit-log';
import { MonarchCapabilityRegistry } from './capability-registry';
import { MonarchEventBus } from './event-bus';
import { MonarchExecutionEngine } from './execution-engine';
import { MonarchHealthMonitor, type MonarchHealthSnapshot } from './health-monitor';
import { MonarchModuleRegistry } from './module-registry';
import { MonarchPermissionGate } from './permission-gate';
import { createMonarchId, normalizeText, nowIso } from './utils';
import { normalizeActionProposal } from './action-protocol';
import { MonarchActionLedger } from './action-ledger';
import { MonarchCapabilityLeaseStore } from './capability-leases';
import { MonarchPolicyKernel } from './policy-kernel';
import type { MonarchLocalSettingsPolicyDecision, MonarchLocalSettingsPolicyInput } from './policy-kernel';
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
  recentIntentJobsProvider?: (query: MonarchRecentIntentJobQuery) => readonly MonarchRecentIntentJobSnapshot[];
  permissionProfile?: MonarchPermissionProfile;
  authorityContext?: MonarchAuthorityContext;
}

export class MonarchKernel {
  private readonly instanceGeneration = createMonarchId('kernel_instance');
  private lifecycleRevision = 0;
  private readonly auditLog = new MonarchAuditLog();
  private readonly eventBus = new MonarchEventBus();
  private readonly modules = new MonarchModuleRegistry();
  private readonly capabilities = new MonarchCapabilityRegistry();
  private readonly permissions: MonarchPermissionGate;
  private readonly leases: MonarchCapabilityLeaseStore;
  private readonly actionLedger: MonarchActionLedger;
  private readonly mutationJournal: MonarchMutationJournal;
  private readonly policy: MonarchPolicyKernel;
  private readonly execution: MonarchExecutionEngine;
  private readonly health = new MonarchHealthMonitor(this.modules);
  private recentIntentJobsProvider: (query: MonarchRecentIntentJobQuery) => readonly MonarchRecentIntentJobSnapshot[];
  private readonly workspaceRoot: string;
  private readonly authorityContext: MonarchAuthorityContext;

  constructor(options: MonarchKernelOptions = {}) {
    this.workspaceRoot = options.workspaceRoot || process.cwd();
    this.authorityContext = Object.freeze({ ...(options.authorityContext || MONARCH_PUBLIC_AUTHORITY_CONTEXT) });
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
      // Agent receipts (reads included) now outlive a restart too.
      1000,
      agencyRuntimeRoot ? path.join(agencyRuntimeRoot, 'action-ledger.json') : undefined,
    );
    this.mutationJournal = new MonarchMutationJournal(
      this.workspaceRoot,
      agencyRuntimeRoot ? path.join(agencyRuntimeRoot, 'mutation-journal') : undefined,
    );
    this.policy = new MonarchPolicyKernel(this.permissions, this.leases, this.authorityContext, this.workspaceRoot);
    this.execution = new MonarchExecutionEngine(
      this.modules,
      this.capabilities,
      this.policy,
      this.actionLedger,
      this.mutationJournal,
      this.workspaceRoot,
    );
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

  /** Internal application bridge for local, non-capability runtime controls. */
  emitRuntimeEvent(type: string, source: string, payload?: unknown): Promise<MonarchEvent> {
    return this.eventBus.emit(type, source, payload);
  }

  setRecentIntentJobsProvider(
    provider: (query: MonarchRecentIntentJobQuery) => readonly MonarchRecentIntentJobSnapshot[]
  ): void {
    this.recentIntentJobsProvider = provider;
  }

  setOwnerRedZoneRootsProvider(provider: () => readonly string[]): void {
    this.policy.setOwnerRedZoneRootsProvider(provider);
    this.mutationJournal.setOwnerRedZoneRootsProvider(provider);
  }

  async start(): Promise<void> {
    this.lifecycleRevision += 1;
    this.modules.validateDependencies();
    const context = this.createContext();
    const traceStartup = /^(1|true|yes)$/i.test(process.env.MONARCH_STARTUP_TRACE || '');

    // One module that cannot start (a damaged settings file, a missing
    // runtime) used to fail the whole Kernel: the server exited, desktop
    // recovery ran out and Monarch closed. It is marked failed instead, its
    // dependants are not started, and the dispatcher refuses its capabilities
    // (module-unavailable); everything else starts normally.
    const failedModules = new Set<string>();
    for (const module of this.modules.listModulesInDependencyOrder()) {
      const missing = (module.manifest.dependencies ?? []).find((dependency) => failedModules.has(dependency));
      if (missing) {
        failedModules.add(module.manifest.id);
        this.modules.setStatus(module.manifest.id, 'failed', `Dependency ${missing} is unavailable.`);
        console.error(JSON.stringify({ diagnostic: 'monarch-module-failed', moduleId: module.manifest.id, code: 'dependency-unavailable' }));
        continue;
      }
      try {
        traceMonarchStartup('module-start:' + module.manifest.id);
        if (traceStartup) {
          console.log(`[startup] Activating module ${module.manifest.id}...`);
        }
        await module.activate(context);
        traceMonarchStartup('module-ready:' + module.manifest.id);
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
        failedModules.add(module.manifest.id);
        console.error(JSON.stringify({ diagnostic: 'monarch-module-failed', moduleId: module.manifest.id,
          code: error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code : error instanceof Error ? error.name : 'error' }));
        await context.emit('module.failed', 'kernel', {
          moduleId: module.manifest.id,
          error: message,
        }).catch(() => undefined);
      }
    }
  }

  async stop(): Promise<void> {
    this.lifecycleRevision += 1;
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

    const summary = 'Legacy text-to-capability routing is retired. Submit an Oscar Turn/Astra V3 task or an exact typed capability proposal.';
    await context.emit('intent.rejected', 'kernel', {
      intentId: intent.id,
      reason: 'legacy-text-router-retired',
    });
    await context.audit('routing', summary, {
      intentId: intent.id,
      source,
    }, 'warn');
    return {
      intent,
      route: null,
      plan: null,
      execution: {
        ok: false,
        summary,
        error: 'legacy-text-router-retired',
        output: { mode: 'astra-v3-required' },
      },
      summary,
    };
  }

  async routeIntent(intent: MonarchIntent): Promise<MonarchRouteDecision | null> {
    await this.auditLog.append('routing', 'Legacy text route request rejected.', {
      intentId: intent.id,
      source: intent.source,
      reason: 'legacy-text-router-retired',
    }, 'warn');
    return null;
  }

  getModule(moduleId: string): MonarchModule | undefined {
    return this.modules.getModule(moduleId);
  }

  async execute(
    request: MonarchExecutionRequest,
    control: import('./contracts').MonarchExecutionControl = {},
  ): Promise<MonarchExecutionResult> {
    return this.execution.execute(request, this.createContext(), control);
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
      requireExactConfirmation?: true;
      approvalPolicyDecisionHash?: string;
      approvalPurpose?: 'policy' | 'owner-security-override';
      authorityTierAtApproval?: import('./contracts').MonarchAuthorityTier;
      leaseId?: string;
      source?: import('./contracts').MonarchAgentCapabilitySource;
      executionMode?: 'coder' | 'agent-runtime';
      permissionProfileOverride?: MonarchPermissionProfile;
      signal?: AbortSignal;
      dispatchGuard?: () => boolean;
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
      ...(options.source ? { source: options.source } : {}),
      confirmed: options.confirmed === true,
      securityOverrideConfirmed: options.securityOverrideConfirmed === true,
      ...(options.requireExactConfirmation === true ? { requireExactConfirmation: true as const } : {}),
      ...(options.approvalPolicyDecisionHash ? { approvalPolicyDecisionHash: options.approvalPolicyDecisionHash } : {}),
      ...(options.approvalPurpose ? { approvalPurpose: options.approvalPurpose } : {}),
      ...(options.authorityTierAtApproval ? { authorityTierAtApproval: options.authorityTierAtApproval } : {}),
      proposalId: proposal.proposalId,
      proposalHash: proposal.canonicalHash,
      proposalSource: proposal.provenance.source,
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
    }, context, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.dispatchGuard ? { dispatchGuard: options.dispatchGuard } : {}),
    });
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
        allowExternalPaths: this.permissions.getProfile().sandboxMode === 'danger-full-access',
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

  getAuthorityContext(): MonarchAuthorityContext {
    return this.authorityContext;
  }

  evaluateLocalSettingsCommand(input: MonarchLocalSettingsPolicyInput): MonarchLocalSettingsPolicyDecision {
    return this.policy.evaluateLocalSettingsCommand(input);
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

  /** Exact lifecycle facts only; no audit/history enumeration or execution grant. */
  getCapabilityReadiness(capabilityId: string): { instanceGeneration: string; lifecycleRevision: number;
    capabilityId: string; moduleId: string; moduleVersion: string; status: import('./contracts').MonarchModuleStatus } | null {
    const capability = this.capabilities.get(capabilityId);
    const module = capability ? this.modules.getRecord(capability.moduleId) : undefined;
    if (!capability || !module) return null;
    return { instanceGeneration: this.instanceGeneration, lifecycleRevision: this.lifecycleRevision,
      capabilityId: capability.id, moduleId: capability.moduleId, moduleVersion: module.manifest.version, status: module.status };
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

  /** Exact internal recovery lookup; not a renderer endpoint or an execution grant. */
  getActionLedgerRecord(idempotencyKey: string): MonarchActionLedgerRecord | null {
    const record = this.actionLedger.getByIdempotencyKey(idempotencyKey);
    return record ? structuredClone(record) : null;
  }

  /** Exact internal certification lookup; read-only and never an execution or
   * rollback grant. Ledger identity is what terminal Agent archives retain. */
  getActionLedgerRecordById(ledgerId: string): MonarchActionLedgerRecord | null {
    const record = this.actionLedger.getByLedgerId(ledgerId);
    return record ? structuredClone(record) : null;
  }

  async rollbackAction(ledgerId: string): Promise<MonarchActionRollbackState | null> {
    const record = this.actionLedger.getByLedgerId(ledgerId);
    if (!record) return null;
    const rollback = await this.mutationJournal.rollback(ledgerId, record.capabilityId);
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

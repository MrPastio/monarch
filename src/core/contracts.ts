export type MonarchModuleKind =
  | 'system'
  | 'interface'
  | 'domain'
  | 'runtime'
  | 'tooling';

export type MonarchRisk =
  | 'none'
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'network'
  | 'device-control'
  | 'money'
  | 'identity'
  | 'security-sensitive';

export type MonarchPermissionMode = 'allow' | 'confirm' | 'deny';
export type MonarchSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type MonarchApprovalPolicy = 'on-request' | 'never';
export type MonarchAutonomyMode = 'guided' | 'workspace-autonomous' | 'full-local';

export interface MonarchPermissionProfile {
  sandboxMode: MonarchSandboxMode;
  approvalPolicy: MonarchApprovalPolicy;
  autonomyMode?: MonarchAutonomyMode;
}

export type MonarchModuleStatus =
  | 'registered'
  | 'active'
  | 'inactive'
  | 'failed';

export const MONARCH_CORE_API_VERSION = '0.1.0';

export type MonarchIntentSource = 'desktop' | 'voice' | 'telegram' | 'api' | 'system' | 'smoke';

export interface MonarchModuleFactoryContext {
  workspaceRoot?: string;
}

export type MonarchModuleFactory = (context?: MonarchModuleFactoryContext) => MonarchModule;

export type MonarchCapabilityHandler = (
  request: MonarchExecutionRequest,
  context: MonarchKernelContext
) => Promise<MonarchExecutionResult>;

export interface MonarchCoreCompatibility {
  minVersion?: string;
  maxVersion?: string;
}

export interface MonarchModulePackage {
  id: string;
  version: string;
  factory: MonarchModuleFactory;
  moduleId?: string;
  description?: string;
  enabled?: boolean;
  core?: MonarchCoreCompatibility;
}

export type MonarchModuleLoadStatus = 'loaded' | 'skipped' | 'failed';

export interface MonarchModuleLoadRecord {
  packageId: string;
  version: string;
  status: MonarchModuleLoadStatus;
  reason: string;
  moduleId?: string;
}

export interface MonarchJsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface MonarchCapability {
  id: string;
  moduleId: string;
  title: string;
  description?: string;
  risk: MonarchRisk;
  inputSchema?: MonarchJsonSchema;
  outputSchema?: MonarchJsonSchema;
  examples?: unknown[];
  routing?: MonarchCapabilityRoutingMetadata;
}

export interface MonarchCapabilityRoutingMetadata {
  aliases?: string[];
  keywords?: string[];
  examples?: string[];
  intentKinds?: string[];
}

export interface MonarchModuleManifest {
  id: string;
  name: string;
  version: string;
  kind: MonarchModuleKind;
  description: string;
  owns: string[];
  capabilities: MonarchCapability[];
  permissions: MonarchRisk[];
  dependencies?: string[];
  events?: string[];
}

export interface MonarchIntent {
  id: string;
  source: MonarchIntentSource;
  text: string;
  createdAt: string;
  context?: Record<string, unknown>;
}

export type MonarchIntentKind =
  | 'assistant_identity'
  | 'project_identity'
  | 'capabilities_question'
  | 'model_status_question'
  | 'text_generation'
  | 'explanation'
  | 'chat'
  | 'code'
  | 'file_generation'
  | 'file_operation'
  | 'system_action'
  | 'tool_use'
  | 'search'
  | 'multimodal'
  | 'unknown';

export type MonarchRoutingPreference =
  | 'chat'
  | 'model'
  | 'tools'
  | 'search'
  | 'multimodal';

export type MonarchSearchScope =
  | 'none'
  | 'local'
  | 'web_optional'
  | 'web_required';

export type MonarchResponseFormatHint =
  | 'plain'
  | 'json'
  | 'code'
  | 'artifact';

export type MonarchFileIntentMode =
  | 'none'
  | 'authoring'
  | 'operation';

export type MonarchFileOperation =
  | 'none'
  | 'read'
  | 'list'
  | 'create'
  | 'write'
  | 'edit'
  | 'delete'
  | 'move'
  | 'rename';

export type MonarchModelRouteRole =
  | 'router'
  | 'weak'
  | 'medium'
  | 'powerful'
  | 'vision'
  | 'gemma4-fast'
  | 'gemma4-balanced'
  | 'gemma4-deepthinking';

export interface MonarchIntentClassification {
  kind: MonarchIntentKind;
  confidence: number;
  reason: string;
  routingPreference: MonarchRoutingPreference;
  searchScope: MonarchSearchScope;
  responseFormat: MonarchResponseFormatHint;
  fileIntentMode: MonarchFileIntentMode;
  fileOperation: MonarchFileOperation;
  toolRoutingAllowed: boolean;
  riskHint: MonarchRisk;
  modelRolePreference: MonarchModelRouteRole;
  modelTierBoost: number;
  signals: string[];
  rankedKinds: Array<{
    kind: MonarchIntentKind;
    score: number;
  }>;
}

export type MonarchParentRouteAction =
  | 'direct_reply'
  | 'model_generation'
  | 'tool_plan'
  | 'action_plan'
  | 'web_search'
  | 'multimodal'
  | 'unknown';

export type MonarchParentRouteDelegate =
  | 'chat'
  | 'research'
  | 'coder'
  | 'file_author'
  | 'file_operator'
  | 'system_operator'
  | 'tool_operator'
  | 'multimodal_analyst'
  | 'unknown';

export interface MonarchParentRouteDecision {
  action: MonarchParentRouteAction;
  delegate: MonarchParentRouteDelegate;
  route: MonarchRoutingPreference;
  risk: MonarchRisk;
  confidence: number;
  preferredModelRole: MonarchModelRouteRole;
  responseFormat: MonarchResponseFormatHint;
  toolRoutingAllowed: boolean;
  needsApproval: boolean;
  needsInternet: boolean;
  needsFiles: boolean;
  reason: string;
}

export interface MonarchModelRouteDecision {
  selectedRole: MonarchModelRouteRole;
  confidence: number;
  reason: string;
  fallbackRoles: MonarchModelRouteRole[];
  forcedBy?: string;
}

export interface MonarchRoutingAnalysis {
  classification: MonarchIntentClassification;
  parentRouter: MonarchParentRouteDecision;
  modelRouter: MonarchModelRouteDecision;
}

export interface MonarchRouteDecision {
  intentId: string;
  targetModuleId: string;
  capabilityId?: string;
  confidence: number;
  reason: string;
  permissionMode: MonarchPermissionMode;
  input?: unknown;
}

export type MonarchRouteCandidateSource =
  | 'module'
  | 'fallback'
  | 'keyword'
  | 'alias'
  | 'semantic'
  | 'llm';

export interface MonarchRouteCandidate {
  intentId: string;
  targetModuleId: string;
  capabilityId: string;
  confidence: number;
  reason: string;
  source: MonarchRouteCandidateSource;
  permissionMode: MonarchPermissionMode;
  input?: unknown;
  missingInput?: string[];
  scoreParts?: Record<string, number>;
}

export interface MonarchRouteTrace {
  version?: string;
  intentId: string;
  originalText: string;
  classification?: MonarchIntentClassification;
  parentRouter?: MonarchParentRouteDecision;
  modelRouter?: MonarchModelRouteDecision;
  candidates: MonarchRouteCandidate[];
  llmRouter?: MonarchLlmRouterStageSummary;
  selected?: MonarchRouteDecision;
  rejected: Array<{
    targetModuleId: string;
    capabilityId: string;
    reason: string;
  }>;
  unresolvedReason?: MonarchUnresolvedRouteReason;
  resolverReason: string;
}

export type MonarchUnresolvedRouteReason =
  | 'no-candidates'
  | 'risk-threshold'
  | 'ambiguous'
  | 'missing-input';

export type MonarchLlmRouterStageStatus =
  | 'ready'
  | 'skipped'
  | 'blocked'
  | 'failed';

export interface MonarchLlmRouterStageSummary {
  status: MonarchLlmRouterStageStatus;
  reason: string;
  model?: string;
  adapter?: string;
  endpoint?: string;
  candidates: number;
}

export interface MonarchLlmRouterStageResult {
  summary: MonarchLlmRouterStageSummary;
  candidates: MonarchRouteCandidate[];
}

export interface MonarchLlmRouter {
  route(
    intent: MonarchIntent,
    modules: MonarchModule[],
    context: MonarchKernelContext,
    analysis?: MonarchRoutingAnalysis
  ): Promise<MonarchLlmRouterStageResult>;
}

export interface MonarchIntentResult {
  intent: MonarchIntent;
  route: MonarchRouteDecision | null;
  plan: MonarchPlan | null;
  execution: MonarchExecutionResult | null;
  summary: string;
  confirmation?: MonarchConfirmationChallenge;
}

export type MonarchRecentIntentJobNormalizedStatus =
  | 'success'
  | 'paused_at_security_gate'
  | 'user_aborted'
  | 'execution_failed'
  | 'runtime_failure'
  | 'running'
  | 'unknown';

export interface MonarchRecentIntentJobQuery {
  readonly limit?: number;
  readonly maxAgeMs?: number;
  readonly source?: string;
  readonly clientConversationId?: string;
  readonly clientSessionId?: string;
  readonly excludeJobId?: string;
}

export interface MonarchRecentIntentJobSnapshot {
  readonly jobId: string;
  readonly source: string;
  readonly clientConversationId?: string;
  readonly clientSessionId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly routeTarget?: string;
  readonly capability?: string;
  readonly normalizedStatus: MonarchRecentIntentJobNormalizedStatus;
  readonly inputSummary?: string;
  readonly resultSummary?: string;
  readonly errorSummary?: string;
}

export interface MonarchConfirmationChallenge {
  token: string;
  mode: 'intent' | 'execution' | 'proposal';
  expiresAt: string;
  target: {
    intentId?: string;
    planId?: string;
    stepId?: string;
    moduleId: string;
    capabilityId: string;
    risk?: MonarchRisk;
  };
  grantOptions?: Array<'once' | 'task'>;
  suggestedLease?: {
    capabilities: string[];
    roots?: string[];
    expiresInMs: number;
    budgets: MonarchCapabilityLeaseBudgets;
  };
}

export type MonarchActionReversibility = 'read-only' | 'reversible' | 'compensatable' | 'irreversible';
export type MonarchActionScopeLevel = 'single-object' | 'bounded-set' | 'workspace' | 'system' | 'external';
export type MonarchActionExternality = 'local' | 'localhost' | 'trusted-origin' | 'new-origin' | 'public';
export type MonarchActionPrivilege = 'user' | 'elevated' | 'security-control';
export type MonarchActionDataSensitivity = 'public' | 'workspace' | 'personal' | 'secret';
export type MonarchActionNovelty = 'known-capability' | 'new-args' | 'arbitrary-code';

export interface MonarchActionScope {
  level: MonarchActionScopeLevel;
  roots?: string[];
  paths?: string[];
  origins?: string[];
}

export interface MonarchRiskVector {
  effect: 'none' | 'read' | 'write' | 'delete' | 'execute' | 'network' | 'device';
  scope: MonarchActionScopeLevel;
  reversibility: MonarchActionReversibility;
  externality: MonarchActionExternality;
  privilege: MonarchActionPrivilege;
  data: MonarchActionDataSensitivity;
  novelty: MonarchActionNovelty;
}

export interface MonarchActionPredicate {
  kind: 'exists' | 'not-exists' | 'equals' | 'contains' | 'status';
  target: string;
  value?: unknown;
}

export interface MonarchActionProposalProvenance {
  model: string;
  skillIds: string[];
  source: 'model-tool-call' | 'runtime-grammar' | 'deterministic-router' | 'api';
}

export interface MonarchActionProposalV1 {
  version: 1;
  proposalId: string;
  intentId: string;
  intentHash: string;
  capabilityId: string;
  args: Record<string, unknown>;
  reason: string;
  expectedEffect: string;
  reversibility: MonarchActionReversibility;
  scope: MonarchActionScope;
  riskVector: MonarchRiskVector;
  idempotencyKey: string;
  canonicalHash: string;
  preconditions?: MonarchActionPredicate[];
  verification?: MonarchActionPredicate[];
  provenance: MonarchActionProposalProvenance;
}

export interface MonarchActionObservationV1 {
  version: 1;
  phase: 'precondition' | 'verification';
  predicate: MonarchActionPredicate;
  ok: boolean;
  observed?: unknown;
  code: string;
  message: string;
}

export interface MonarchActionProposalInput {
  version?: 1;
  proposalId?: string;
  intentId?: string;
  capabilityId: string;
  args?: unknown;
  input?: unknown;
  parameters?: unknown;
  reason?: string;
  expectedEffect?: string;
  reversibility?: MonarchActionReversibility;
  scope?: Partial<MonarchActionScope>;
  idempotencyKey?: string;
  preconditions?: MonarchActionPredicate[];
  verification?: MonarchActionPredicate[];
  provenance?: Partial<MonarchActionProposalProvenance>;
}

export interface MonarchPolicyEvidence {
  source: 'permission' | 'lease' | 'filesystem' | 'security' | 'provenance' | 'runtime';
  code: string;
  severity: 'info' | 'warn' | 'block';
  message: string;
  hard?: boolean;
}

export interface MonarchPolicyDecision {
  outcome: MonarchPermissionMode;
  policyId: string;
  reason: string;
  risk: MonarchRisk;
  riskVector: MonarchRiskVector;
  canonicalProposalHash?: string;
  evidence: MonarchPolicyEvidence[];
  requiresSecurityReview: boolean;
  leaseId?: string;
  securityOverride?: boolean;
}

export interface MonarchCapabilityLeaseBudgets {
  maxActions: number;
  maxFiles?: number;
  maxBytesWritten?: number;
  maxDeletes?: number;
  maxNetworkRequests?: number;
}

export interface MonarchCapabilityLeaseUsage {
  actions: number;
  files: number;
  bytesWritten: number;
  deletes: number;
  networkRequests: number;
}

export interface MonarchCapabilityLeaseV1 {
  version: 1;
  leaseId: string;
  intentHash: string;
  capabilities: string[];
  roots: string[];
  pathGlobs: string[];
  origins: string[];
  issuedAt: string;
  expiresAt: string;
  budgets: MonarchCapabilityLeaseBudgets;
  usage: MonarchCapabilityLeaseUsage;
  allowEffects: string[];
  denyEffects: string[];
  modelId: string;
  skillIds: string[];
  revocable: true;
  status: 'active' | 'revoked' | 'expired' | 'exhausted';
}

export interface MonarchActionLedgerRecord {
  ledgerId: string;
  idempotencyKey: string;
  proposalId?: string;
  proposalHash?: string;
  intentId: string;
  capabilityId: string;
  moduleId: string;
  leaseId?: string;
  modelId?: string;
  skillIds?: string[];
  durable?: boolean;
  status: 'authorized' | 'executing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
  result?: MonarchExecutionResult;
  rollback?: MonarchActionRollbackState;
}

export interface MonarchActionRollbackState {
  status: 'available' | 'rolled-back' | 'blocked' | 'unavailable';
  targetPath: string;
  capturedAt: string;
  updatedAt: string;
  reason?: string;
}

export type MonarchPlanStatus =
  | 'planned'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed';

export interface MonarchPlanStep {
  id: string;
  moduleId: string;
  capabilityId: string;
  input: unknown;
  reason: string;
  expectedRisk: MonarchRisk;
  dependsOn?: string[];
}

export type MonarchPlanningRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type MonarchMemoryEntryType =
  | 'user_preference'
  | 'project_decision'
  | 'architecture_note'
  | 'active_bug'
  | 'fixed_bug'
  | 'technical_debt'
  | 'temporary_task'
  | 'module_state'
  | 'handoff_note'
  | 'diagnostic_note'
  | 'planning_note';

export interface MonarchPlanningMemoryReference {
  id: string;
  type: MonarchMemoryEntryType | string;
  title: string;
  excerpt: string;
  source?: string;
  relevance?: number;
  relatedFiles?: string[];
  relatedModules?: string[];
}

export interface MonarchPlan {
  id: string;
  intentId: string;
  createdAt: string;
  status: MonarchPlanStatus;
  summary: string;
  requiresPlanning?: boolean;
  taskSummary?: string;
  affectedModules?: string[];
  dependencies?: string[];
  riskLevel?: MonarchPlanningRiskLevel;
  possibleSideEffects?: string[];
  requiredCapabilities?: string[];
  executionSteps?: string[];
  validationPlan?: string[];
  notes?: string[];
  relevantMemory?: MonarchPlanningMemoryReference[];
  steps: MonarchPlanStep[];
}

export interface MonarchPlanExecutionResult {
  ok: boolean;
  plan: MonarchPlan;
  stepResults: Array<{
    stepId: string;
    request: MonarchExecutionRequest;
    result: MonarchExecutionResult;
  }>;
  summary: string;
  error?: string;
}

export interface MonarchExecutionRequest {
  id: string;
  intentId: string;
  planId?: string;
  stepId?: string;
  moduleId: string;
  capabilityId: string;
  input: unknown;
  createdAt: string;
  requestedBy: string;
  confirmed?: boolean;
  securityOverrideConfirmed?: boolean;
  proposalId?: string;
  proposalHash?: string;
  intentHash?: string;
  idempotencyKey?: string;
  leaseId?: string;
  riskVector?: MonarchRiskVector;
  actionScope?: MonarchActionScope;
  preconditions?: MonarchActionPredicate[];
  verification?: MonarchActionPredicate[];
  originatingUserText?: string;
  skillIds?: string[];
  modelId?: string;
  /** Internal-only execution lane. HTTP callers cannot set this field. */
  executionMode?: 'coder';
  /** Internal-only scoped profile used by trusted controllers, never copied from API input. */
  permissionProfileOverride?: MonarchPermissionProfile;
}

export interface MonarchExecutionResult {
  ok: boolean;
  summary: string;
  output?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  userFacing?: MonarchUserFacingFailure;
}

export interface MonarchUserFacingFailure {
  code: string;
  message: string;
  fields?: string[];
  action?: string;
}

export interface MonarchEvent {
  id: string;
  type: string;
  source: string;
  createdAt: string;
  payload?: unknown;
}

export type MonarchAuditSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface MonarchAuditEntry {
  id: string;
  createdAt: string;
  severity: MonarchAuditSeverity;
  category: string;
  message: string;
  data?: unknown;
}

export interface MonarchPermissionDecision {
  mode: MonarchPermissionMode;
  reason: string;
  risk: MonarchRisk;
  requiresUserConfirmation: boolean;
}

export interface MonarchModuleRecord {
  manifest: MonarchModuleManifest;
  status: MonarchModuleStatus;
  registeredAt: string;
  activatedAt?: string;
  failedAt?: string;
  lastError?: string;
}

export interface MonarchKernelContext {
  emit(type: string, source: string, payload?: unknown): Promise<MonarchEvent>;
  audit(category: string, message: string, data?: unknown, severity?: MonarchAuditSeverity): Promise<MonarchAuditEntry>;
  requestPermission(request: MonarchExecutionRequest): Promise<MonarchPermissionDecision>;
  execute(request: MonarchExecutionRequest): Promise<MonarchExecutionResult>;
  getCapability(capabilityId: string): MonarchCapability | undefined;
  listCapabilities(moduleId?: string): MonarchCapability[];
  listModules(): MonarchModuleRecord[];
  listEvents(): MonarchEvent[];
  listAudit(): MonarchAuditEntry[];
  listRecentIntentJobs(query: MonarchRecentIntentJobQuery): readonly MonarchRecentIntentJobSnapshot[];
  getPermissionProfile(): MonarchPermissionProfile;
}

export interface MonarchModule {
  manifest: MonarchModuleManifest;
  activate(context: MonarchKernelContext): Promise<void>;
  deactivate?(context: MonarchKernelContext): Promise<void>;
  health?(context: MonarchKernelContext): Promise<MonarchExecutionResult>;
  resolveCapabilityRisk?(
    request: MonarchExecutionRequest,
    capability: MonarchCapability,
    context: MonarchKernelContext
  ): Promise<MonarchRisk | undefined> | MonarchRisk | undefined;
  handleIntent?(
    intent: MonarchIntent,
    context: MonarchKernelContext
  ): Promise<MonarchRouteDecision | null>;
  executeCapability?(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext
  ): Promise<MonarchExecutionResult>;
}

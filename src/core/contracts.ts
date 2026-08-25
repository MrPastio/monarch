import type { MonarchRuntimePaths } from './runtime-paths';

export type MonarchModuleKind =
  | 'suite'
  | 'system'
  | 'interface'
  | 'domain'
  | 'runtime'
  | 'tooling';

export type MonarchModuleStage = 'alpha' | 'beta' | 'stable';

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
export type MonarchActionGuardReaction = 'observe' | 'guard' | 'confirm-all';
export type MonarchAgentSecurityMode = 'off' | 'observe' | 'guard' | 'strict';
export type MonarchAgentDangerBand = 'minimal' | 'low' | 'elevated' | 'high' | 'critical';
export type MonarchAgentDangerResponse = 'allow' | 'observe' | 'enhanced-readback' | 'confirm' | 'block' | 'owner-override';
export type MonarchOwnerOverrideLifetime = 'task' | 'session' | 'persistent';
export type MonarchShellApprovalPolicy = 'always' | 'risk-based' | 'never';

export interface MonarchAgentDangerFactorV1 {
  score: number;
  reason: string;
}

export interface AgentDangerAssessmentV1 {
  schemaVersion: 'monarch.agent-danger-assessment.v1';
  dangerProbability: number;
  assessmentConfidence: number;
  band: MonarchAgentDangerBand;
  factors: {
    effect: MonarchAgentDangerFactorV1;
    scope: MonarchAgentDangerFactorV1;
    reversibility: MonarchAgentDangerFactorV1;
    privilege: MonarchAgentDangerFactorV1;
    dataSensitivity: MonarchAgentDangerFactorV1;
    externality: MonarchAgentDangerFactorV1;
    novelty: MonarchAgentDangerFactorV1;
    ambiguity: MonarchAgentDangerFactorV1;
    blastRadius: MonarchAgentDangerFactorV1;
    targetFreshness: MonarchAgentDangerFactorV1;
    requestAlignment: MonarchAgentDangerFactorV1;
  };
}

/** Runtime-owned state. It is never accepted from a model/tool/API payload. */
export interface MonarchOwnerUnrestrictedOverride {
  enabled: boolean;
  lifetime: MonarchOwnerOverrideLifetime;
  taskId?: string;
  shellApprovalPolicy: MonarchShellApprovalPolicy;
  activatedAt?: string;
}

export interface MonarchPermissionProfile {
  sandboxMode: MonarchSandboxMode;
  approvalPolicy: MonarchApprovalPolicy;
  autonomyMode?: MonarchAutonomyMode;
}

export type MonarchAuthorityTier = 'public' | 'owner';
export type MonarchAuthoritySource = 'default' | 'signed-device-entitlement';

export interface MonarchAuthorityContext {
  tier: MonarchAuthorityTier;
  source: MonarchAuthoritySource;
  entitlementId: string | null;
  keyId: string | null;
  verifiedAt: string | null;
  deviceIdPrefix: string | null;
  diagnostic: string | null;
}

export const MONARCH_PUBLIC_AUTHORITY_CONTEXT: MonarchAuthorityContext = Object.freeze({
  tier: 'public',
  source: 'default',
  entitlementId: null,
  keyId: null,
  verifiedAt: null,
  deviceIdPrefix: null,
  diagnostic: 'owner-entitlement-absent',
});

export type MonarchModuleStatus =
  | 'registered'
  | 'active'
  | 'inactive'
  | 'failed';

export const MONARCH_CORE_API_VERSION = '0.1.0';

export type MonarchIntentSource = 'desktop' | 'voice' | 'telegram' | 'api' | 'system' | 'smoke';

export interface MonarchModuleFactoryContext {
  workspaceRoot?: string;
  userWorkspaceRoot?: string;
  runtimePaths?: MonarchRuntimePaths;
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

export type MonarchAgentCapabilityIdempotency = 'idempotent' | 'conditional' | 'non-idempotent';
export type MonarchAgentCapabilityReversibility = 'automatic' | 'manual' | 'irreversible';
export type MonarchAgentCapabilityCancellation = 'supported' | 'best-effort' | 'unsupported';
export type MonarchAgentCapabilityLatency = 'instant' | 'short' | 'long' | 'unbounded';
export type MonarchAgentCapabilityComputeClass = 'light' | 'medium' | 'heavy';
export type MonarchAgentCapabilitySource = MonarchIntentSource | 'coder';
export type MonarchAgentRuntimeState =
  | 'registered'
  | 'configured'
  | 'reachable'
  | 'starting'
  | 'running'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'unavailable';

export interface MonarchAgentCapabilityPrecondition {
  kind: string;
  description: string;
}

export interface MonarchAgentCapabilityEffect {
  kind: string;
  description: string;
  targetScope?: MonarchCapabilityEffectProfile['targetScope'];
}

export interface MonarchAgentCapabilityVerificationDescriptor {
  kind: 'predicate' | 'read-after-write' | 'schema' | 'runtime-status' | 'external-receipt';
  description: string;
  required?: boolean;
  predicate?: MonarchActionPredicate;
}

export type MonarchAgentCapabilityReconciliationAssertion =
  | 'equals-source-input'
  | 'equals-baseline-plus-source-input'
  | 'ends-with-source-input'
  | 'contains-source-input';

/**
 * Capability-owned recovery contract for an indeterminate mutation result.
 * The Agent Runtime may execute only the declared read-only capability, with
 * inputs compiled from the original action input, before it considers any
 * repeat of the mutation.
 */
export interface MonarchAgentCapabilityReconciliationDescriptor {
  capabilityId: string;
  inputBindings: Record<string, string>;
  constantInput?: Record<string, string | number | boolean>;
  requiresPreActionBaseline?: boolean;
  targetInputKey: string;
  observationTargetPath: string;
  assertion: {
    kind: MonarchAgentCapabilityReconciliationAssertion;
    observationPath: string;
    sourceInputKey: string;
  };
}

export interface MonarchCapabilityEffectProfile {
  mutation: 'none' | 'temporary' | 'persistent';
  targetScope: 'agent-state' | 'workspace' | 'project' | 'application' | 'device' | 'external-service';
  reversibility: MonarchAgentCapabilityReversibility;
  privilege: 'normal' | 'elevated' | 'security-critical';
  dataSensitivity: 'public' | 'private' | 'secret';
  communication: 'none' | 'loopback' | 'lan' | 'internet' | 'third-party';
  financialImpact: boolean;
  identityImpact: boolean;
  securityImpact: boolean;
}

/** Optional manifest input. Missing fields receive conservative legacy-risk defaults. */
export interface MonarchAgentCapabilityMetadataInput {
  tags?: string[];
  preconditions?: MonarchAgentCapabilityPrecondition[];
  effects?: MonarchAgentCapabilityEffect[];
  idempotency?: MonarchAgentCapabilityIdempotency;
  reversibility?: MonarchAgentCapabilityReversibility;
  effectProfile?: Partial<MonarchCapabilityEffectProfile>;
  requiredRuntime?: string[];
  requiredCredentials?: string[];
  supportedSources?: MonarchAgentCapabilitySource[];
  estimatedLatency?: MonarchAgentCapabilityLatency;
  computeClass?: MonarchAgentCapabilityComputeClass;
  cancellation?: MonarchAgentCapabilityCancellation;
  verification?: MonarchAgentCapabilityVerificationDescriptor[];
  reconciliation?: MonarchAgentCapabilityReconciliationDescriptor;
  examples?: unknown[];
}

export interface MonarchResolvedAgentCapabilityMetadata {
  tags: string[];
  preconditions: MonarchAgentCapabilityPrecondition[];
  effects: MonarchAgentCapabilityEffect[];
  idempotency: MonarchAgentCapabilityIdempotency;
  reversibility: MonarchAgentCapabilityReversibility;
  effectProfile: MonarchCapabilityEffectProfile;
  requiredRuntime: string[];
  requiredCredentials: string[];
  supportedSources: MonarchAgentCapabilitySource[];
  estimatedLatency: MonarchAgentCapabilityLatency;
  computeClass: MonarchAgentCapabilityComputeClass;
  cancellation: MonarchAgentCapabilityCancellation;
  verification: MonarchAgentCapabilityVerificationDescriptor[];
  reconciliation?: MonarchAgentCapabilityReconciliationDescriptor;
  examples: unknown[];
  source: 'explicit' | 'legacy-default';
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
  agent?: MonarchAgentCapabilityMetadataInput;
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
  stage?: MonarchModuleStage;
  kind: MonarchModuleKind;
  description: string;
  owns: string[];
  capabilities: MonarchCapability[];
  permissions: MonarchRisk[];
  parentSuiteId?: string;
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
  | 'gemma4-deepthinking'
  | 'qwen3.8-27b-pro';

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

export type MonarchActionPredicateJsonValue =
  | string
  | number
  | boolean
  | null
  | MonarchActionPredicateJsonValue[]
  | { [key: string]: MonarchActionPredicateJsonValue };

/**
 * Kernel-owned, JSON-safe context resolved from live module state immediately
 * before Security reviews an action. It is never accepted from a model action
 * proposal and is intentionally kept outside the canonical action input.
 */
export interface MonarchTrustedActionContext {
  schemaVersion: 1;
  sourceModuleId: string;
  target: { [key: string]: MonarchActionPredicateJsonValue };
}

export type MonarchActionPredicate =
  | { kind: 'exists' | 'not-exists'; target: string; value?: never }
  | { kind: 'equals'; target: string; value: MonarchActionPredicateJsonValue }
  | { kind: 'contains'; target: string; value: MonarchActionPredicateJsonValue }
  | { kind: 'status'; target: string; value: string | number | boolean };

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
  /** A hidden local Owner override was active for this exact request. */
  ownerUnrestrictedOverride?: boolean;
  dangerAssessment?: AgentDangerAssessmentV1;
  dangerResponse?: MonarchAgentDangerResponse;
  authorityTier: MonarchAuthorityTier;
  policyDecisionHash: string;
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
  /** Authoritative request surface used for capability source enforcement. */
  source?: MonarchAgentCapabilitySource;
  confirmed?: boolean;
  securityOverrideConfirmed?: boolean;
  /** Internal durable approval policy binding; never accepted from HTTP JSON. */
  approvalPolicyDecisionHash?: string;
  /** Internal durable approval purpose; never accepted from HTTP JSON. */
  approvalPurpose?: 'policy' | 'owner-security-override';
  /** Authority tier captured by the durable approval. */
  authorityTierAtApproval?: MonarchAuthorityTier;
  proposalId?: string;
  proposalHash?: string;
  /** Kernel-authored proposal provenance. HTTP callers never populate this field directly. */
  proposalSource?: MonarchActionProposalProvenance['source'];
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
  executionMode?: 'coder' | 'agent-runtime';
  /** Internal-only scoped profile used by trusted controllers, never copied from API input. */
  permissionProfileOverride?: MonarchPermissionProfile;
  /** Ephemeral Kernel-authored dispatch flag; never accepted from HTTP, tools, or model output. */
  ownerUnrestrictedExecution?: boolean;
}

/**
 * Ephemeral execution control. This object is never part of the durable request,
 * action proposal, ledger, journal, audit payload, or model context.
 */
export interface MonarchExecutionControl {
  signal?: AbortSignal;
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
  resolveSecurityActionContext?(
    request: MonarchExecutionRequest,
    capability: MonarchCapability,
    context: MonarchKernelContext
  ): Promise<MonarchTrustedActionContext | undefined> | MonarchTrustedActionContext | undefined;
  handleIntent?(
    intent: MonarchIntent,
    context: MonarchKernelContext
  ): Promise<MonarchRouteDecision | null>;
  executeCapability?(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    control?: MonarchExecutionControl,
  ): Promise<MonarchExecutionResult>;
}

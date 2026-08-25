export const AGENT_TASK_SCHEMA_VERSION = 'monarch.agent-task.v3' as const;
export const AGENT_TASK_EVENT_SCHEMA_VERSION = 'monarch.agent-task-event.v2' as const;
export const AGENT_OBSERVATION_SCHEMA_VERSION = 'monarch.agent-observation.v2' as const;
export const AGENT_APPROVAL_SCHEMA_VERSION = 'monarch.agent-approval.v2' as const;
export const AGENT_CHECKPOINT_SCHEMA_VERSION = 'monarch.agent-checkpoint.v3' as const;
export const AGENT_RUNNER_CLAIM_SCHEMA_VERSION = 'monarch.agent-runner-claim.v2' as const;
export const AGENT_EXECUTION_PROFILE_SCHEMA_VERSION = 'monarch.agent-execution-profile.v1' as const;
export const AGENT_COGNITIVE_PROFILE_SCHEMA_VERSION = 'monarch.agent-cognitive-profile.v2' as const;
export const AGENT_WORKING_STATE_SCHEMA_VERSION = 'monarch.agent-working-state.v1' as const;

export type AgentJsonPrimitive = string | number | boolean | null;
export type AgentJsonValue =
  | AgentJsonPrimitive
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };
export type AgentJsonObject = { [key: string]: AgentJsonValue };

export type AgentTaskStatus =
  | 'created'
  | 'preparing'
  | 'running'
  | 'waiting-for-user'
  | 'waiting-for-approval'
  | 'waiting-for-runtime'
  | 'paused'
  | 'cancelling'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentPlanningMode = 'adaptive' | 'model-first';

export type AgentDecisionModelRole =
  | 'gemma4-fast'
  | 'gemma4-balanced'
  | 'gemma4-deepthinking'
  | 'gemma4-31b'
  | 'qwen3.8-27b-pro'
  | 'qwen3-coder-30b-a3b-instruct'
  | 'deepseek-coder-v2-lite-instruct';

export interface AgentDecisionModelPolicy {
  requestedRole: AgentDecisionModelRole;
  selectionSource: 'user-explicit';
  /** Explicit UI choices remain exact; a silent tier downgrade would misrepresent the selection. */
  fallback: 'exact';
}

export type AgentTaskSurface =
  | 'desktop'
  | 'telegram'
  | 'voice'
  | 'api'
  | 'coder'
  | 'system'
  | 'smoke';

export interface AgentTaskSource {
  surface: AgentTaskSurface;
  requestId?: string;
  conversationId?: string;
  remote?: boolean;
}

/**
 * Trusted runtime-owned execution context. It is created by the local surface,
 * persisted with the task, and never accepted from a model decision or public
 * Agent Task HTTP body.
 */
export interface AgentTaskExecutionProfile {
  schemaVersion: typeof AGENT_EXECUTION_PROFILE_SCHEMA_VERSION;
  kind: 'coder-project';
  projectId: string;
  projectRoot: string;
  permissionProfile: {
    sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
    approvalPolicy: 'on-request' | 'never';
    autonomyMode?: 'guided' | 'workspace-autonomous' | 'full-local';
  };
}

export type AgentSource = AgentTaskSource;

export interface AgentExpectedOutput {
  id: string;
  description: string;
  kind?: 'answer' | 'artifact' | 'state-change' | 'verification' | 'other';
  required?: boolean;
}

export interface AgentGoalConstraint {
  id: string;
  description: string;
  kind?: 'safety' | 'permission' | 'scope' | 'format' | 'resource' | 'other';
}

export interface AgentSuccessCriterion {
  id: string;
  description: string;
  verificationHint?: string;
}

export interface AgentGoal {
  originalRequest: string;
  normalizedObjective: string;
  expectedOutputs: AgentExpectedOutput[];
  constraints: AgentGoalConstraint[];
  successCriteria: AgentSuccessCriterion[];
  userPreferences?: string[];
}

export type AgentPlanStepStatus =
  | 'proposed'
  | 'ready'
  | 'blocked'
  | 'waiting-approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface AgentExpectedEffect {
  kind: 'read' | 'write' | 'execute' | 'network' | 'state-change' | 'artifact' | 'other';
  description: string;
  target?: string;
}

export interface AgentVerificationRequest {
  kind: 'exists' | 'contains' | 'equals' | 'command' | 'test' | 'schema' | 'manual' | 'other';
  description: string;
  target?: string;
  expected?: AgentJsonValue;
}

export interface AgentVerificationResult {
  status: 'verified' | 'failed' | 'inconclusive' | 'not-run';
  summary: string;
  evidence?: AgentEvidenceReference[];
  verifiedAt?: string;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  status: AgentPlanStepStatus;
  dependsOn: string[];
  expectedEffects: AgentExpectedEffect[];
  verification: AgentVerificationRequest[];
  capabilityHints?: string[];
  selectedCapabilityId?: string;
  attemptCount?: number;
  verificationResult?: AgentVerificationResult;
  startedAt?: string;
  completedAt?: string;
}

export interface AgentPlan {
  id: string;
  revision: number;
  goalSummary: string;
  steps: AgentPlanStep[];
  createdAt: string;
  revisedAt?: string;
}

export interface AgentEvidenceReference {
  kind: 'file' | 'command' | 'test' | 'runtime' | 'api' | 'user' | 'other';
  evidenceClass:
    | 'model-generated'
    | 'external-source'
    | 'kernel-observation'
    | 'kernel-verification'
    | 'user-assertion';
  reference: string;
  summary?: string;
  checksum?: string;
}

export interface AgentArtifactReference {
  id: string;
  kind: 'file' | 'directory' | 'url' | 'report' | 'image' | 'other';
  label: string;
  reference: string;
  checksum?: string;
  createdAt?: string;
}

export type AgentObservationStatus = 'success' | 'partial' | 'failed' | 'cancelled';

export interface AgentObservation {
  schemaVersion: typeof AGENT_OBSERVATION_SCHEMA_VERSION;
  id: string;
  taskId: string;
  stepId?: string;
  capabilityId: string;
  status: AgentObservationStatus;
  summary: string;
  structuredData?: AgentJsonValue;
  evidence: AgentEvidenceReference[];
  artifacts: AgentArtifactReference[];
  warnings: string[];
  retryable: boolean;
  stateDelta?: AgentJsonObject;
  occurredAt: string;
}

export interface AgentObservationReference {
  id: string;
  taskId: string;
  stepId?: string;
  status: AgentObservationStatus;
  summary: string;
  occurredAt: string;
}

export type AgentApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'revoked';

export interface AgentApprovalArm {
  canonicalProposalHash: string;
  capabilityId: string;
  armedAt: string;
  expiresAt: string;
  armedBySurface: AgentTaskSurface;
}

export interface AgentApproval {
  schemaVersion: typeof AGENT_APPROVAL_SCHEMA_VERSION;
  id: string;
  taskId: string;
  stepId?: string;
  capabilityId: string;
  canonicalProposalHash: string;
  purpose?: 'policy' | 'owner-security-override';
  policyDecisionHash?: string;
  authorityTierAtRequest?: 'public' | 'owner';
  proposal: AgentJsonObject;
  status: AgentApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  expiresAt?: string;
  grantScope?: 'once' | 'task';
  decision?: AgentApprovalDecision;
  reason?: string;
  externalApprovalId?: string;
  arm?: AgentApprovalArm;
}

export interface AgentApprovalDecision {
  outcome: Exclude<AgentApprovalStatus, 'pending'>;
  decidedAt: string;
  decidedBy: 'user' | 'policy' | 'system';
  reason?: string;
}

export interface AgentApprovalReference {
  id: string;
  taskId: string;
  stepId?: string;
  status: AgentApprovalStatus;
  capabilityId: string;
  canonicalProposalHash: string;
  purpose?: 'policy' | 'owner-security-override';
  policyDecisionHash?: string;
  authorityTierAtRequest?: 'public' | 'owner';
}

export type AgentComputeClass = 'light' | 'medium' | 'heavy';

export interface AgentBudgetLimits {
  maxSteps: number;
  maxModelTurns: number;
  maxToolCalls: number;
  maxWallTimeMs: number;
  maxFailures: number;
  maxConsecutiveNoProgress: number;
  maxComputeClass?: AgentComputeClass;
}

export interface AgentBudgetUsage {
  steps: number;
  modelTurns: number;
  toolCalls: number;
  failures: number;
  consecutiveNoProgress: number;
  startedAt: string;
  updatedAt: string;
  lastProgressAt?: string;
  computeClass?: AgentComputeClass;
}

export interface AgentContextSnapshotReference {
  id: string;
  version: number;
  checksum: string;
  createdAt: string;
}

export interface AgentTerminalReason {
  code:
    | 'completed'
    | 'cancelled-by-user'
    | 'budget-exhausted'
    | 'unrecoverable-error'
    | 'permission-denied'
    | 'verification-failed'
    | 'runtime-unavailable'
    | 'other';
  summary: string;
  detail?: AgentJsonObject;
}

export interface AgentTaskRecovery {
  reason: 'runner-claim-expired' | 'process-restart' | 'manual-recovery';
  previousStatus: AgentTaskStatus;
  interruptedAt: string;
}

export interface AgentRunnerClaim {
  schemaVersion: typeof AGENT_RUNNER_CLAIM_SCHEMA_VERSION;
  claimId: string;
  runnerId: string;
  claimedAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface AgentTaskMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'request' | 'clarification' | 'progress' | 'result' | 'status' | 'reference';
  createdAt: string;
  content?: string;
  referenceId?: string;
}

export interface AgentPendingAction {
  actionAttemptId: string;
  stepId?: string;
  proposal: AgentJsonObject;
  canonicalProposalHash: string;
  status: 'prepared' | 'dispatched' | 'waiting-approval' | 'settled';
  createdAt: string;
  dispatchedAt?: string;
}

export interface AgentToolDiscoveryState {
  query: string;
  reason: string;
  revision: number;
  requestedAt: string;
}

export interface AgentCognitiveProfileV1 {
  schemaVersion: typeof AGENT_COGNITIVE_PROFILE_SCHEMA_VERSION;
  mode: 'adaptive-local' | 'small-local' | 'full-local';
  activeTier: 'unknown' | 'fast' | 'balanced';
  maxDecisionSchemas: number;
  maxObservationFacts: number;
  agentCapabilityClass: 'basic' | 'full';
  planningAuthority: 'runtime-only' | 'model-adaptive';
  maxPlanSteps: number;
  runtimeDecomposition: true;
  runtimeRecovery: true;
  updatedAt: string;
}

export interface AgentWorkingStateV1 {
  schemaVersion: typeof AGENT_WORKING_STATE_SCHEMA_VERSION;
  revision: number;
  phase: 'decide' | 'inspect' | 'act' | 'verify' | 'recover' | 'synthesize' | 'complete';
  activeStepId?: string;
  goalTargetIds: string[];
  causalObservationIds: string[];
  failedActionFingerprints: string[];
  lastFailure?: {
    capabilityId: string;
    observationId: string;
    failureClass: 'runtime' | 'permission' | 'verification' | 'tool' | 'cancelled' | 'unknown';
    retryable: boolean;
  };
  updatedAt: string;
}

export interface AgentTask {
  schemaVersion: typeof AGENT_TASK_SCHEMA_VERSION;
  id: string;
  traceId: string;
  clientRequestId?: string;
  source: AgentTaskSource;
  conversationId?: string;
  parentTaskId?: string;
  /**
   * `all-effects` is a durable trust-boundary rule: every non-read proposal
   * must stop on an exact action-card even when the ambient Kernel profile
   * would otherwise allow it. It is used for arguments influenced by
   * model-generated attachment observations.
   */
  actionApprovalPolicy?: 'kernel' | 'all-effects';
  /**
   * `model-first` requires a validated model-authored plan revision before
   * any inspect/act decision can reach a capability. The only exception is a
   * runtime-owned, read-only exact-window Computer Use preflight; the model
   * still authors every effectful input atom.
   */
  planningMode?: AgentPlanningMode;
  /** Durable model selection inherited from the Oscar Turn that created this task. */
  decisionModelPolicy?: AgentDecisionModelPolicy;
  /** Runtime-owned project/sandbox binding; model output cannot alter it. */
  executionProfile?: AgentTaskExecutionProfile;
  goal: AgentGoal;
  status: AgentTaskStatus;
  plan?: AgentPlan;
  currentStepId?: string;
  activeApprovalId?: string;
  activeLeaseId?: string;
  pendingAction?: AgentPendingAction;
  /** Latest non-authoritative relevance expansion requested by the model. */
  toolDiscovery?: AgentToolDiscoveryState;
  /** Runtime-owned limits and adaptation state; model output cannot edit it. */
  cognitiveProfile?: AgentCognitiveProfileV1;
  /** Persisted causal state used to keep weak-model turns atomic and recoverable. */
  workingState?: AgentWorkingStateV1;
  pauseRequested?: boolean;
  cancellationRequested?: boolean;
  messages: AgentTaskMessage[];
  observations: AgentObservationReference[];
  artifacts: AgentArtifactReference[];
  approvals: AgentApprovalReference[];
  budgets: AgentBudgetLimits;
  usage: AgentBudgetUsage;
  contextSnapshot?: AgentContextSnapshotReference;
  checkpointVersion: number;
  eventSequence: number;
  runnerClaim?: AgentRunnerClaim;
  recovery?: AgentTaskRecovery;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  terminalReason?: AgentTerminalReason;
  /** Migrated v2 terminal evidence is readable/repeatable but never mutated in place. */
  legacyReadOnly?: boolean;
}

export type AgentTaskEventType =
  | 'task.created'
  | 'task.status.changed'
  | 'plan.created'
  | 'plan.revised'
  | 'resolver.completed'
  | 'resolver.discovery.requested'
  | 'model.started'
  | 'model.completed'
  | 'step.started'
  | 'approval.required'
  | 'approval.armed'
  | 'approval.resolved'
  | 'tool.started'
  | 'tool.completed'
  | 'observation.created'
  | 'verification.completed'
  | 'artifact.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.interrupted'
  | 'runner.claimed'
  | 'runner.renewed'
  | 'runner.released';

export interface AgentTaskEvent {
  schemaVersion: typeof AGENT_TASK_EVENT_SCHEMA_VERSION;
  id: string;
  taskId: string;
  traceId: string;
  sequence: number;
  type: AgentTaskEventType;
  createdAt: string;
  payload?: AgentJsonObject;
}

export interface AgentTaskEventDraft {
  type: AgentTaskEventType;
  createdAt?: string;
  payload?: AgentJsonObject;
}

export interface AgentClientRequestReceipt {
  clientRequestId: string;
  requestFingerprint: string;
  taskId: string;
  checkpointVersion: number;
  eventSequenceStart: number;
  eventSequence: number;
  createdAt: string;
}

export interface AgentTaskCheckpoint {
  schemaVersion: typeof AGENT_CHECKPOINT_SCHEMA_VERSION;
  task: AgentTask;
  events: AgentTaskEvent[];
  observations: AgentObservation[];
  approvals: AgentApproval[];
  savedAt: string;
}

export interface AgentTaskStoreCommit {
  task: AgentTask;
  appendedEvents: AgentTaskEvent[];
  checkpoint: AgentTaskCheckpoint;
  replayed: boolean;
}

export type StoreCommit = AgentTaskStoreCommit;

export interface AgentTaskMutationOptions {
  clientRequestId?: string;
  events?: AgentTaskEventDraft[];
  observations?: AgentObservation[];
  approvals?: AgentApproval[];
}

export interface AgentTaskSaveOptions extends AgentTaskMutationOptions {
  expectedCheckpointVersion: number;
  expectedRunnerClaimId?: string;
  idempotencyPayload?: AgentJsonValue;
}

export type AgentTaskStoreListener = (commit: AgentTaskStoreCommit) => void;

export interface AgentTaskStore {
  createTask(task: AgentTask, options?: AgentTaskMutationOptions): Promise<AgentTaskStoreCommit>;
  getTask(taskId: string): Promise<AgentTaskCheckpoint | null>;
  getTaskState(taskId: string): Promise<AgentTask | null>;
  listTasks(): Promise<AgentTask[]>;
  saveTask(task: AgentTask, options: AgentTaskSaveOptions): Promise<AgentTaskStoreCommit>;
  claimRunner(
    taskId: string,
    runnerId: string,
    ttlMs: number,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ): Promise<AgentTaskStoreCommit>;
  renewRunner(
    taskId: string,
    claimId: string,
    ttlMs: number,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ): Promise<AgentTaskStoreCommit>;
  releaseRunner(
    taskId: string,
    claimId: string,
    expectedCheckpointVersion: number,
    clientRequestId?: string,
  ): Promise<AgentTaskStoreCommit>;
  reconcileLegacyCompletedPlans(): Promise<AgentTaskStoreCommit[]>;
  recoverExpiredClaims(now?: Date | string | number): Promise<AgentTaskStoreCommit[]>;
  subscribe(taskId: string | '*', listener: AgentTaskStoreListener): () => void;
  /** Available only to explicitly volatile stores; durable stores keep audit history. */
  discardTask?(taskId: string): Promise<boolean>;
}

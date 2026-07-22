export const AGENT_TASK_SCHEMA_VERSION = 'monarch.agent-task.v2' as const;
export const AGENT_TASK_EVENT_SCHEMA_VERSION = 'monarch.agent-task-event.v2' as const;
export const AGENT_OBSERVATION_SCHEMA_VERSION = 'monarch.agent-observation.v2' as const;
export const AGENT_APPROVAL_SCHEMA_VERSION = 'monarch.agent-approval.v2' as const;
export const AGENT_CHECKPOINT_SCHEMA_VERSION = 'monarch.agent-checkpoint.v2' as const;
export const AGENT_RUNNER_CLAIM_SCHEMA_VERSION = 'monarch.agent-runner-claim.v2' as const;

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

export interface AgentApproval {
  schemaVersion: typeof AGENT_APPROVAL_SCHEMA_VERSION;
  id: string;
  taskId: string;
  stepId?: string;
  capabilityId: string;
  canonicalProposalHash: string;
  proposal: AgentJsonObject;
  status: AgentApprovalStatus;
  requestedAt: string;
  resolvedAt?: string;
  expiresAt?: string;
  grantScope?: 'once' | 'task';
  decision?: AgentApprovalDecision;
  reason?: string;
  externalApprovalId?: string;
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

export interface AgentTask {
  schemaVersion: typeof AGENT_TASK_SCHEMA_VERSION;
  id: string;
  traceId: string;
  clientRequestId?: string;
  source: AgentTaskSource;
  conversationId?: string;
  parentTaskId?: string;
  goal: AgentGoal;
  status: AgentTaskStatus;
  plan?: AgentPlan;
  currentStepId?: string;
  activeApprovalId?: string;
  activeLeaseId?: string;
  pendingAction?: AgentPendingAction;
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
}

export type AgentTaskEventType =
  | 'task.created'
  | 'task.status.changed'
  | 'plan.created'
  | 'plan.revised'
  | 'resolver.completed'
  | 'model.started'
  | 'model.completed'
  | 'step.started'
  | 'approval.required'
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
  recoverExpiredClaims(now?: Date | string | number): Promise<AgentTaskStoreCommit[]>;
  subscribe(taskId: string | '*', listener: AgentTaskStoreListener): () => void;
}

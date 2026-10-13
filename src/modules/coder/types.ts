import type { MonarchPersonalityContextV2 } from '../../settings';
import { parseCloudRole, type MaxCloudRole } from '../../agent-v3/max-cloud-catalog';
import { isAstraLocalAgentModelChoice, type AstraLocalAgentModelChoice } from '../../agent-v3/source-goal-contract';

export type CoderProjectSource = 'created' | 'imported';

export interface CoderProject {
  id: string;
  name: string;
  root: string;
  source: CoderProjectSource;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
}

export interface CoderProjectRegistryV1 {
  version: 1;
  activeProjectId: string | null;
  projects: CoderProject[];
}

export type CoderModelId =
  | AstraLocalAgentModelChoice
  | 'max-gpt-oss-120b'
  | 'max-qwen-3.8-27b'
  | MaxCloudRole;

export function isCoderModelId(value: unknown): value is CoderModelId {
  return isAstraLocalAgentModelChoice(value)
    || value === 'max-gpt-oss-120b'
    || value === 'max-qwen-3.8-27b'
    || parseCloudRole(value) !== null;
}

export function isCoderMaxModelId(value: CoderModelId): boolean {
  return value === 'max-gpt-oss-120b' || value === 'max-qwen-3.8-27b' || parseCloudRole(value) !== null;
}

export type CoderRunStatus =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CoderRunEventKind =
  | 'status'
  | 'model'
  | 'assistant'
  | 'tool-start'
  | 'tool-result'
  | 'context-compacted'
  | 'error';

export interface CoderRunEvent {
  id: string;
  sequence: number;
  kind: CoderRunEventKind;
  createdAt: string;
  title: string;
  detail: string;
  capabilityId?: string;
  ok?: boolean;
  output?: unknown;
  error?: string;
}

export interface CoderContextSummary {
  goal: string;
  decisions: string[];
  modifiedFiles: string[];
  commands: string[];
  tests: string[];
  failures: string[];
  pending: string[];
  activeSkills: string[];
  lastAssistantSummary: string;
  compactedThroughSequence: number;
}

export interface CoderContextMetrics {
  budgetTokens: number;
  estimatedPromptTokens: number;
  reservedOutputTokens: number;
  retainedRecentEvents: number;
  totalEvents: number;
  compactions: number;
  modelCalls: number;
  modelInputTokens: number;
  modelOutputTokens: number;
  modelTotalTokens: number;
}

export interface CoderRun {
  id: string;
  projectId: string;
  projectName?: string;
  projectRoot?: string;
  clientRequestId?: string;
  /** Conversation the run continues. Legacy runs without it are their own session. */
  sessionId?: string;
  runtimeStatus?: string;
  completionEvidence?: 'succeeded' | 'none' | 'mixed' | 'failed';
  /** Common Oscar Turn and AgentTask identities for Agent-First runs. */
  oscarTurnId?: string;
  agentTaskId?: string;
  agentRuntimeVersion?: 'v2' | 'v3';
  agentEventSequence?: number;
  astraActivityRound?: number;
  astraActivityStates?: Record<string, 'proposed' | 'observed' | 'failed'>;
  prompt: string;
  model: CoderModelId;
  status: CoderRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  answer: string;
  error: string;
  iteration: number;
  maxIterations: number;
  cancelled: boolean;
  /** Immutable project-scoped style snapshot. Missing only on legacy/pending runs. */
  personality?: MonarchPersonalityContextV2 | null;
  events: CoderRunEvent[];
  summary: CoderContextSummary;
  context: CoderContextMetrics;
  /** Exact durable action-card projected from the linked AgentTask. */
  agentApproval?: {
    id: string;
    capabilityId: string;
    canonicalProposalHash: string;
    reason: string;
    expiresAt?: string;
    purpose?: 'policy' | 'owner-security-override';
    proposal: Record<string, unknown>;
  };
  /** Exact durable ask-user binding projected from the linked Astra V3 task. */
  agentQuestion?: {
    id: string;
    digest: string;
    text: string;
    predecessorMessageId: string;
    expiresAt: string;
  };
}

export interface CoderAstraTaskProjection {
  taskId: string;
  status: CoderRunStatus;
  modelTurns: number;
  capabilityCalls: number;
  runtimeStatus?: string;
  completionEvidence?: CoderRun['completionEvidence'];
  answer?: string;
  error?: string;
  approval?: CoderRun['agentApproval'];
  question?: CoderRun['agentQuestion'];
  activities: Array<{ round: number; capabilityId: string; reason: string; thought?: string;
    state: 'proposed' | 'observed' | 'failed'; summary?: string; ok?: boolean; output?: unknown }>;
}

export interface CoderProjectSnapshot {
  project: CoderProject;
  entries: Array<{ path: string; type: 'file' | 'directory'; sizeBytes?: number }>;
  git: {
    available: boolean;
    repository: boolean;
    branch: string;
    status: string[];
  };
}

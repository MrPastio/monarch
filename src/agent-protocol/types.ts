/** Surface-neutral contracts shared by Oscar Turn, Astra V3 and archived
 * Agent records. This module owns no runtime, scheduler, model or Kernel path. */

export type AgentJsonPrimitive = string | number | boolean | null;
export type AgentJsonValue =
  | AgentJsonPrimitive
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };
export type AgentJsonObject = { [key: string]: AgentJsonValue };

export const AGENT_EXECUTION_PROFILE_SCHEMA_VERSION = 'monarch.agent-execution-profile.v1' as const;

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
  telegram?: {
    ownerUserId: number;
    controlChatId: number;
    botId: number;
    threadId: number;
    pairingEpoch: string;
  };
}

/** Trusted host-owned execution context. Public/model payloads cannot create it. */
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

export interface AgentExpectedOutput {
  id: string;
  description: string;
  kind?: 'answer' | 'artifact' | 'state-change' | 'verification' | 'other';
  grounding?: 'kernel-observations';
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

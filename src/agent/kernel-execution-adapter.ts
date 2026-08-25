import type {
  MonarchAgentCapabilitySource,
  MonarchActionProposalInput,
  MonarchActionProposalV1,
  MonarchCapabilityLeaseV1,
  MonarchExecutionResult,
  MonarchPermissionProfile,
} from '../core/contracts';

export interface AgentActionGatewaySubmission {
  proposal: MonarchActionProposalInput | MonarchActionProposalV1;
  originatingUserText?: string;
  requestedBy?: string;
  source?: MonarchAgentCapabilitySource;
  model?: string;
  skillIds?: string[];
  confirmed?: boolean;
  grantScope?: 'once' | 'task';
  leaseId?: string;
  executionMode?: 'agent-runtime';
  /** Trusted task-owned profile; never accepted from model output or HTTP. */
  permissionProfileOverride?: MonarchPermissionProfile;
  agentApprovalBinding?: AgentActionGatewayApprovalBinding;
  signal?: AbortSignal;
}

export interface AgentActionGatewayApprovalBinding {
  taskId: string;
  approvalId: string;
  capabilityId: string;
  canonicalProposalHash: string;
  purpose?: 'policy' | 'owner-security-override';
  policyDecisionHash?: string;
  authorityTierAtRequest?: 'public' | 'owner';
}

export interface AgentActionGatewayResult {
  proposal: MonarchActionProposalV1;
  result: MonarchExecutionResult;
  lease?: MonarchCapabilityLeaseV1;
}

export type AgentActionGatewaySubmitter = (
  submission: AgentActionGatewaySubmission,
) => Promise<AgentActionGatewayResult>;

export type AgentActionGatewayPreparer = (
  submission: AgentActionGatewaySubmission,
) => Promise<MonarchActionProposalV1> | MonarchActionProposalV1;

export interface ExecuteAgentActionInput {
  proposal: MonarchActionProposalInput | MonarchActionProposalV1;
  originatingUserText: string;
  requestedBy: string;
  source: MonarchAgentCapabilitySource;
  model?: string;
  skillIds?: string[];
  leaseId?: string;
  permissionProfileOverride?: MonarchPermissionProfile;
  signal?: AbortSignal;
}

export interface ExecuteApprovedAgentActionInput extends ExecuteAgentActionInput {
  expectedCanonicalHash: string;
  taskId: string;
  approvalId: string;
  grantScope?: 'once' | 'task';
  purpose?: 'policy' | 'owner-security-override';
  policyDecisionHash?: string;
  authorityTierAtRequest?: 'public' | 'owner';
}

/**
 * The adapter intentionally has no Kernel/ExecutionEngine handle. Every action
 * traverses the Application proposal gateway and its schema, policy, Security,
 * confirmation, ledger, journal and predicate verification chain.
 */
export class AgentKernelExecutionAdapter {
  constructor(
    private readonly submit: AgentActionGatewaySubmitter,
    private readonly prepareSubmission?: AgentActionGatewayPreparer,
  ) {}

  async prepare(input: ExecuteAgentActionInput): Promise<MonarchActionProposalV1> {
    if (!this.prepareSubmission) {
      throw new AgentActionGatewayError(
        'proposal-preparer-unavailable',
        'Application action proposal preparation is not configured.',
      );
    }
    return this.prepareSubmission({
      proposal: input.proposal,
      originatingUserText: input.originatingUserText,
      requestedBy: input.requestedBy,
      source: input.source,
      ...(input.model ? { model: input.model } : {}),
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      ...(input.permissionProfileOverride ? { permissionProfileOverride: input.permissionProfileOverride } : {}),
      executionMode: 'agent-runtime',
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  execute(input: ExecuteAgentActionInput): Promise<AgentActionGatewayResult> {
    return this.submit({
      proposal: input.proposal,
      originatingUserText: input.originatingUserText,
      requestedBy: input.requestedBy,
      source: input.source,
      ...(input.model ? { model: input.model } : {}),
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      ...(input.permissionProfileOverride ? { permissionProfileOverride: input.permissionProfileOverride } : {}),
      executionMode: 'agent-runtime',
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async executeApproved(input: ExecuteApprovedAgentActionInput): Promise<AgentActionGatewayResult> {
    // Re-preflight the exact durable proposal, then let Application validate the
    // durable Agent approval binding. Model text and ephemeral tokens never
    // become execution authority.
    const canonical = await this.prepare(input);
    if (canonical.canonicalHash !== input.expectedCanonicalHash) {
      throw new AgentActionGatewayError(
        'approval-target-mismatch',
        'Stored approval no longer matches the canonical action proposal.',
      );
    }
    const executed = await this.submit({
      proposal: canonical,
      originatingUserText: input.originatingUserText,
      requestedBy: input.requestedBy,
      source: input.source,
      ...(input.model ? { model: input.model } : {}),
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      confirmed: true,
      grantScope: input.grantScope || 'once',
      executionMode: 'agent-runtime',
      ...(input.permissionProfileOverride ? { permissionProfileOverride: input.permissionProfileOverride } : {}),
      agentApprovalBinding: {
        taskId: input.taskId,
        approvalId: input.approvalId,
        capabilityId: canonical.capabilityId,
        canonicalProposalHash: input.expectedCanonicalHash,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.policyDecisionHash ? { policyDecisionHash: input.policyDecisionHash } : {}),
        ...(input.authorityTierAtRequest ? { authorityTierAtRequest: input.authorityTierAtRequest } : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (executed.proposal.canonicalHash !== input.expectedCanonicalHash) {
      throw new AgentActionGatewayError(
        'approval-target-mismatch',
        'Application executed a proposal that does not match the durable approval.',
      );
    }
    return executed;
  }
}

export class AgentActionGatewayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentActionGatewayError';
  }
}

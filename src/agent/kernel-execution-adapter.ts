import type {
  MonarchActionProposalInput,
  MonarchActionProposalV1,
  MonarchCapabilityLeaseV1,
  MonarchConfirmationChallenge,
  MonarchExecutionResult,
} from '../core/contracts';

export interface AgentActionGatewaySubmission {
  proposal: MonarchActionProposalInput | MonarchActionProposalV1;
  originatingUserText?: string;
  requestedBy?: string;
  model?: string;
  skillIds?: string[];
  confirmed?: boolean;
  confirmationToken?: string;
  grantScope?: 'once' | 'task';
  leaseId?: string;
  signal?: AbortSignal;
}

export interface AgentActionGatewayResult {
  proposal: MonarchActionProposalV1;
  result: MonarchExecutionResult;
  confirmation?: MonarchConfirmationChallenge;
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
  model?: string;
  skillIds?: string[];
  leaseId?: string;
  signal?: AbortSignal;
}

export interface ExecuteApprovedAgentActionInput extends ExecuteAgentActionInput {
  expectedCanonicalHash: string;
  grantScope?: 'once' | 'task';
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
      ...(input.model ? { model: input.model } : {}),
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  execute(input: ExecuteAgentActionInput): Promise<AgentActionGatewayResult> {
    return this.submit({
      proposal: input.proposal,
      originatingUserText: input.originatingUserText,
      requestedBy: input.requestedBy,
      ...(input.model ? { model: input.model } : {}),
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  async executeApproved(input: ExecuteApprovedAgentActionInput): Promise<AgentActionGatewayResult> {
    // Re-preflight the exact durable proposal. The fresh challenge is kept only
    // in memory and consumed immediately; no confirmation token is persisted.
    const canonical = await this.prepare(input);
    if (canonical.canonicalHash !== input.expectedCanonicalHash) {
      throw new AgentActionGatewayError(
        'approval-target-mismatch',
        'Stored approval no longer matches the canonical action proposal.',
      );
    }
    const prepared = await this.execute({ ...input, proposal: canonical });
    if (prepared.proposal.canonicalHash !== input.expectedCanonicalHash) {
      throw new AgentActionGatewayError(
        'approval-target-mismatch',
        'Stored approval no longer matches the canonical action proposal.',
      );
    }
    if (prepared.result.error !== 'confirmation-required') {
      return prepared;
    }
    if (!prepared.confirmation?.token) {
      throw new AgentActionGatewayError(
        'fresh-confirmation-missing',
        'Action requires confirmation but the Application gateway did not issue a fresh challenge.',
      );
    }
    const executed = await this.submit({
      proposal: prepared.proposal,
      originatingUserText: input.originatingUserText,
      requestedBy: input.requestedBy,
      ...(input.model ? { model: input.model } : {}),
      ...(input.skillIds ? { skillIds: input.skillIds } : {}),
      confirmed: true,
      confirmationToken: prepared.confirmation.token,
      grantScope: input.grantScope || 'once',
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

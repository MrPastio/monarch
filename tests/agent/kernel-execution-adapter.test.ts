import { describe, expect, it, vi } from 'vitest';
import { AgentKernelExecutionAdapter } from '../../src/agent/kernel-execution-adapter';

const proposal = {
  version: 1 as const, proposalId: 'proposal_1', intentId: 'task_1', intentHash: 'i',
  capabilityId: 'workspace.files.write', args: { path: 'report.md', content: 'ok' },
  reason: 'write', expectedEffect: 'exists', reversibility: 'reversible' as const,
  scope: { level: 'single-object' as const },
  riskVector: { effect: 'write' as const, scope: 'single-object' as const, reversibility: 'reversible' as const, externality: 'local' as const, privilege: 'user' as const, data: 'workspace' as const, novelty: 'known-capability' as const },
  idempotencyKey: 'action:1', canonicalHash: 'canonical-1',
  provenance: { model: 'fixture', skillIds: [], source: 'model-tool-call' as const },
};

describe('agent Kernel execution adapter', () => {
  it('re-preflights a durable approved proposal and submits one exact structured approval binding', async () => {
    const submit = vi.fn().mockResolvedValue({ proposal, result: { ok: true, summary: 'done' } });
    const adapter = new AgentKernelExecutionAdapter(submit, () => proposal);
    await expect(adapter.executeApproved({
      proposal, expectedCanonicalHash: proposal.canonicalHash,
      taskId: 'task_1', approvalId: 'approval_1', source: 'api',
      originatingUserText: 'write', requestedBy: 'agent:task_1',
    })).resolves.toMatchObject({ result: { ok: true } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      confirmed: true,
      executionMode: 'agent-runtime',
      agentApprovalBinding: {
        taskId: 'task_1',
        approvalId: 'approval_1',
        capabilityId: proposal.capabilityId,
        canonicalProposalHash: proposal.canonicalHash,
      },
    });
    expect(submit.mock.calls[0]?.[0]).not.toHaveProperty('confirmationToken');
  });

  it('fails closed before submission if canonicalization changes after approval', async () => {
    const submit = vi.fn().mockResolvedValue({
      proposal: { ...proposal, canonicalHash: 'changed' }, result: { ok: true, summary: 'done' },
    });
    const prepare = vi.fn().mockResolvedValue({ ...proposal, canonicalHash: 'changed' });
    await expect(new AgentKernelExecutionAdapter(submit, prepare).executeApproved({
      proposal, expectedCanonicalHash: proposal.canonicalHash,
      taskId: 'task_1', approvalId: 'approval_1', source: 'api',
      originatingUserText: 'write', requestedBy: 'agent:task_1',
    })).rejects.toMatchObject({ code: 'approval-target-mismatch' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it('forwards the ephemeral cancellation signal without persisting it in the proposal', async () => {
    const controller = new AbortController();
    const submit = vi.fn().mockResolvedValue({ proposal, result: { ok: false, summary: 'cancelled', error: 'cancelled' } });
    const adapter = new AgentKernelExecutionAdapter(submit);

    await adapter.execute({
      proposal,
      originatingUserText: 'write',
      requestedBy: 'agent:task_1',
      signal: controller.signal,
    });

    expect(submit.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(proposal).not.toHaveProperty('signal');
  });
});

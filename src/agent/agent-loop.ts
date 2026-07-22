import { createMonarchId, nowIso } from '../core/utils';
import type {
  MonarchActionProposalInput,
  MonarchActionProposalV1,
  MonarchCapability,
  MonarchPermissionProfile,
} from '../core/contracts';
import { resolveAgentCapabilityMetadata, supportsBoundedAgentExecution } from '../core/capability-metadata';
import { canConsumeAgentBudget, evaluateAgentBudget, recordAgentBudgetUsage } from './budget-manager';
import { resolveAgentCapabilities } from './capability-resolver';
import { compileAgentContext, redactAgentContextValue } from './context-compiler';
import {
  AgentDecisionValidationError,
  parseAgentDecision,
  type AgentDecision,
  type AgentExecutableDecision,
} from './decision-schema';
import type { AgentDecisionProvider } from './model-decision-provider';
import { AgentKernelExecutionAdapter, type AgentActionGatewayResult } from './kernel-execution-adapter';
import { normalizeAgentObservation } from './observation-normalizer';
import { currentAgentPlanStep, reviseAgentPlan, settleAgentPlanStep, startAgentPlanStep } from './plan-manager';
import { decideAgentRecovery } from './recovery-policy';
import { verifyAgentCompletion, type AgentVerificationRecord } from './result-verifier';
import type { AgentRuntimeAvailabilitySnapshot } from './runtime-availability';
import { AgentTaskRunnerClaimError, AgentTaskStoreConflictError } from './agent-task-store';
import type {
  AgentApproval,
  AgentArtifactReference,
  AgentJsonObject,
  AgentObservation,
  AgentPlan,
  AgentPlanStep,
  AgentTask,
  AgentTaskCheckpoint,
  AgentTaskEventDraft,
  AgentTaskStore,
  AgentTaskStoreCommit,
} from './types';
import {
  AGENT_APPROVAL_SCHEMA_VERSION,
  AGENT_TASK_SCHEMA_VERSION,
} from './types';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface AgentLoopDependencies {
  store: AgentTaskStore;
  decisionProvider: AgentDecisionProvider;
  executionAdapter: AgentKernelExecutionAdapter;
  listCapabilities: () => readonly MonarchCapability[];
  getPermissionProfile: () => MonarchPermissionProfile;
  getModuleStates?: () => Readonly<Record<string, 'active' | 'degraded' | 'inactive' | 'failed' | 'unavailable'>>;
  getRuntimeAvailability?: () => Promise<readonly AgentRuntimeAvailabilitySnapshot[]> | readonly AgentRuntimeAvailabilitySnapshot[];
  availableCredentialRefs?: () => ReadonlySet<string>;
  runnerId: string;
  runnerClaimTtlMs?: number;
}

export class AgentLoop {
  private readonly claimTtlMs: number;

  constructor(private readonly dependencies: AgentLoopDependencies) {
    this.claimTtlMs = Math.max(300, Math.min(dependencies.runnerClaimTtlMs || 5 * 60_000, 30 * 60_000));
  }

  async run(taskId: string, signal: AbortSignal): Promise<AgentTask | null> {
    let checkpoint: AgentTaskCheckpoint | null = null;
    let claimId = '';
    try {
      while (true) {
        checkpoint = await this.dependencies.store.getTask(taskId);
        if (!checkpoint || TERMINAL.has(checkpoint.task.status)) return checkpoint?.task || null;
        if (checkpoint.task.status === 'waiting-for-approval' && pendingApproval(checkpoint)) return checkpoint.task;
        if (
          checkpoint.task.status === 'waiting-for-user'
          || checkpoint.task.status === 'waiting-for-runtime'
          || checkpoint.task.status === 'paused'
        ) return checkpoint.task;
        try {
          const claimed = await this.dependencies.store.claimRunner(
            taskId,
            this.dependencies.runnerId,
            this.claimTtlMs,
            checkpoint.task.checkpointVersion,
          );
          checkpoint = claimed.checkpoint;
          break;
        } catch (error) {
          if (error instanceof AgentTaskStoreConflictError) continue;
          if (error instanceof AgentTaskRunnerClaimError) {
            return (await this.dependencies.store.getTask(taskId))?.task || null;
          }
          throw error;
        }
      }
      claimId = checkpoint.task.runnerClaim?.claimId || '';
      checkpoint = await this.enterRunning(checkpoint);

      while (!TERMINAL.has(checkpoint.task.status)) {
        checkpoint = await this.reload(taskId, checkpoint);
        const control = await this.handleControl(checkpoint, signal);
        checkpoint = control.checkpoint;
        if (control.stop) return checkpoint.task;

        const approved = findApprovedActiveApproval(checkpoint);
        if (approved) {
          checkpoint = await this.executeApprovedAction(checkpoint, approved, signal, claimId);
          if (checkpoint.task.status === 'waiting-for-approval' || TERMINAL.has(checkpoint.task.status)) return checkpoint.task;
          checkpoint = await this.renew(checkpoint, claimId);
          continue;
        }
        const rejected = findRejectedActiveApproval(checkpoint);
        if (rejected) {
          checkpoint = await this.handleRejectedApproval(checkpoint, rejected);
          checkpoint = await this.renew(checkpoint, claimId);
          continue;
        }
        if (checkpoint.task.status === 'waiting-for-approval') return checkpoint.task;

        const budget = evaluateAgentBudget(checkpoint.task.budgets, checkpoint.task.usage);
        if (!budget.allowed) {
          checkpoint = await this.failTask(checkpoint, 'budget-exhausted', budget.summary, {
            exhaustedBy: budget.exhaustedBy,
          });
          return checkpoint.task;
        }

        const capabilities = [...this.dependencies.listCapabilities()];
        const runtimeAvailability = this.dependencies.getRuntimeAvailability
          ? await this.dependencies.getRuntimeAvailability()
          : [];
        const step = ensureCurrentStep(checkpoint.task);
        if (step.changed) checkpoint = (await this.save(checkpoint, step.task, [{
          type: 'plan.revised',
          payload: jsonObject({ reason: 'runtime-next-step', revision: step.task.plan?.revision || 1 }),
        }])).checkpoint;
        const currentStep = currentAgentPlanStep(checkpoint.task.plan, checkpoint.task.currentStepId);
        const moduleStates = this.dependencies.getModuleStates?.();
        const availableCredentialRefs = this.dependencies.availableCredentialRefs?.();
        const resolver = resolveAgentCapabilities({
          goal: checkpoint.task.goal.normalizedObjective,
          currentStep: currentStep?.title || '',
          recentObservationSummaries: checkpoint.observations.slice(-4).map((entry) => entry.summary),
          source: checkpoint.task.source.surface,
          capabilities,
          ...(moduleStates ? { moduleStates } : {}),
          runtimeAvailability,
          ...(availableCredentialRefs ? { availableCredentialRefs } : {}),
          permissionProfile: this.dependencies.getPermissionProfile(),
        });
        checkpoint = (await this.save(checkpoint, checkpoint.task, [{
          type: 'resolver.completed',
          payload: jsonObject({
            candidates: resolver.diagnostics.included.map((entry) => ({
              capabilityId: entry.capabilityId,
              score: entry.score,
              reasons: entry.reasons,
              warnings: entry.warnings,
            })),
            excluded: resolver.diagnostics.excluded.slice(0, 64),
            policy: resolver.diagnostics.policy,
          }),
        }])).checkpoint;
        if (resolver.capabilities.length === 0) {
          checkpoint = await this.failTask(checkpoint, 'runtime-unavailable', 'No available capabilities can advance this task.');
          return checkpoint.task;
        }

        const decisionResult = await this.requestDecision(checkpoint, resolver.cards, resolver.capabilities, signal, claimId);
        checkpoint = decisionResult.checkpoint;
        if (!decisionResult.decision) {
          if (abortKind(signal) === 'shutdown') {
            checkpoint = await this.interruptTask(checkpoint, 'Agent runtime stopped during a model stage.');
            return checkpoint.task;
          }
          if (abortKind(signal) === 'pause') {
            checkpoint = (await this.handleControl(checkpoint, signal)).checkpoint;
            return checkpoint.task;
          }
          checkpoint = await this.failTask(
            checkpoint,
            signal.aborted ? 'cancelled-by-user' : 'unrecoverable-error',
            decisionResult.error || 'Local model did not return a valid bounded decision.',
          );
          return checkpoint.task;
        }

        checkpoint = await this.handleDecision(
          checkpoint,
          decisionResult.decision,
          resolver.capabilities,
          decisionResult.model,
          signal,
          claimId,
        );
        if (
          TERMINAL.has(checkpoint.task.status)
          || checkpoint.task.status === 'waiting-for-user'
          || checkpoint.task.status === 'waiting-for-runtime'
          || checkpoint.task.status === 'waiting-for-approval'
          || checkpoint.task.status === 'paused'
        ) return checkpoint.task;
        checkpoint = await this.renew(checkpoint, claimId);
      }
      return checkpoint.task;
    } catch (error) {
      const latest = await this.dependencies.store.getTask(taskId).catch(() => null);
      if (!latest || TERMINAL.has(latest.task.status)) return latest?.task || null;
      if (
        error instanceof AgentRunnerClaimLostError
        || latest.task.runnerClaim?.claimId !== claimId
        || latest.task.runnerClaim?.runnerId !== this.dependencies.runnerId
      ) return latest.task;
      if (error instanceof AgentTaskWallTimeExceededError) {
        return (await this.failTask(
          latest,
          'budget-exhausted',
          'Agent task wall-time budget expired during an active stage.',
          { exhaustedBy: 'max-wall-time' },
        )).task;
      }
      if (abortKind(signal) === 'shutdown') {
        return (await this.interruptTask(latest, 'Agent runtime stopped during an active stage.')).task;
      }
      if (latest.task.cancellationRequested || latest.task.status === 'cancelling') {
        return (await this.cancelTask(latest, 'Cancellation settled after the active stage.')).task;
      }
      if (abortKind(signal) === 'pause' || latest.task.pauseRequested || latest.task.status === 'paused') {
        return (await this.handleControl(latest, signal)).checkpoint.task;
      }
      if (signal.aborted) {
        return (await this.cancelTask(latest, 'Cancellation settled after the active stage.')).task;
      }
      const message = sanitizeError(error);
      return (await this.failTask(latest, 'unrecoverable-error', message)).task;
    } finally {
      if (claimId) {
        await this.releaseClaim(taskId, claimId).catch(() => undefined);
      }
    }
  }

  private async enterRunning(checkpoint: AgentTaskCheckpoint): Promise<AgentTaskCheckpoint> {
    const task = checkpoint.task;
    if (task.status === 'interrupted' && task.pendingAction?.status === 'dispatched') {
      const capability = this.dependencies.listCapabilities().find((entry) => entry.id === task.pendingAction?.proposal.capabilityId);
      const metadata = capability ? resolveAgentCapabilityMetadata(capability) : null;
      if (!metadata || metadata.idempotency !== 'idempotent') {
        return (await this.save(checkpoint, {
          ...task,
          status: 'waiting-for-user',
          messages: appendMessage(task, 'assistant', 'status', 'A previously dispatched action needs explicit recovery review before any repeat.'),
        }, [{
          type: 'task.status.changed',
          payload: jsonObject({ from: 'interrupted', to: 'waiting-for-user', reason: 'non-idempotent-recovery-review' }),
        }])).checkpoint;
      }
    }
    if (task.status === 'waiting-for-approval') return checkpoint;
    if (task.status === 'created' || task.status === 'preparing' || task.status === 'interrupted') {
      return (await this.save(checkpoint, {
        ...task,
        status: 'running',
      }, [{
        type: 'task.status.changed',
        payload: jsonObject({ from: task.status, to: 'running' }),
      }])).checkpoint;
    }
    return checkpoint;
  }

  private async handleControl(
    checkpoint: AgentTaskCheckpoint,
    signal: AbortSignal,
    beforeDispatch = false,
  ): Promise<{ checkpoint: AgentTaskCheckpoint; stop: boolean }> {
    const settlementCheckpoint = beforeDispatch
      ? { ...checkpoint, task: clearActionState(checkpoint.task) }
      : checkpoint;
    if (abortKind(signal) === 'shutdown') {
      return { checkpoint: await this.interruptTask(settlementCheckpoint, 'Agent runtime stopped.'), stop: true };
    }
    if (checkpoint.task.cancellationRequested || checkpoint.task.status === 'cancelling') {
      return { checkpoint: await this.cancelTask(settlementCheckpoint, 'Task was cancelled by the user.'), stop: true };
    }
    if (abortKind(signal) === 'pause' || checkpoint.task.pauseRequested) {
      const commit = await this.save(settlementCheckpoint, {
        ...settlementCheckpoint.task,
        status: 'paused',
        pauseRequested: false,
      }, [{
        type: 'task.status.changed',
        payload: jsonObject({ from: checkpoint.task.status, to: 'paused' }),
      }]);
      return { checkpoint: commit.checkpoint, stop: true };
    }
    if (signal.aborted) {
      return { checkpoint: await this.cancelTask(settlementCheckpoint, 'Task was cancelled by the user.'), stop: true };
    }
    return { checkpoint, stop: false };
  }

  private async requestDecision(
    checkpointInput: AgentTaskCheckpoint,
    cards: ReturnType<typeof resolveAgentCapabilities>['cards'],
    capabilities: MonarchCapability[],
    signal: AbortSignal,
    claimId: string,
  ): Promise<{ checkpoint: AgentTaskCheckpoint; decision?: AgentDecision; model?: string; error?: string }> {
    let checkpoint = checkpointInput;
    let lastValidation: AgentDecisionValidationError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const consumption = canConsumeAgentBudget(checkpoint.task.budgets, checkpoint.task.usage, {
        steps: attempt === 0 ? 1 : 0,
        modelTurns: 1,
        ...(attempt === 1 ? { meaningfulProgress: false } : {}),
      });
      if (!consumption.allowed) return { checkpoint, error: consumption.summary };
      checkpoint = (await this.save(checkpoint, { ...checkpoint.task, usage: consumption.usage }, [{
        type: 'model.started',
        payload: jsonObject({
          attempt: attempt + 1,
          repair: attempt === 1,
          candidateCapabilityIds: cards.map((card) => card.id),
        }),
      }])).checkpoint;
      const compiled = compileAgentContext({
        taskId: checkpoint.task.id,
        taskRevision: checkpoint.task.checkpointVersion,
        goal: checkpoint.task.goal,
        ...(checkpoint.task.plan ? { plan: checkpoint.task.plan } : {}),
        observations: checkpoint.observations,
        messages: checkpoint.task.messages,
        artifacts: checkpoint.task.artifacts,
        capabilities: cards,
        budget: { limits: checkpoint.task.budgets, usage: checkpoint.task.usage },
        surface: checkpoint.task.source,
      });
      const modelStartedAt = Date.now();
      const stage = await this.runClaimedStage(
        checkpoint.task.id,
        claimId,
        signal,
        taskWallDeadline(checkpoint.task),
        (stageSignal) => this.dependencies.decisionProvider.decide({
          taskId: checkpoint.task.id,
          traceId: checkpoint.task.traceId,
          compiledContext: compiled,
          capabilities: cards,
          signal: stageSignal,
          ...(attempt === 1 && lastValidation ? {
            repair: {
              attempt: 1,
              code: lastValidation.code,
              errors: [lastValidation.message, ...lastValidation.details],
            },
          } : {}),
        }),
        true,
      );
      checkpoint = stage.checkpoint;
      const response = stage.value;
      if (!response.ok || !response.rawText) {
        const safeError = sanitizeError(response.error || 'model-decision-failed');
        checkpoint = (await this.save(checkpoint, checkpoint.task, [{
          type: 'model.completed',
          payload: jsonObject({
            attempt: attempt + 1,
            repair: attempt === 1,
            ok: false,
            valid: false,
            error: safeError,
            durationMs: response.latencyMs ?? Date.now() - modelStartedAt,
            ...(response.role ? { role: boundedDiagnostic(response.role) } : {}),
            ...(response.model ? { model: boundedDiagnostic(response.model) } : {}),
            ...(response.adapter ? { adapter: boundedDiagnostic(response.adapter) } : {}),
            ...(response.degraded !== undefined ? { degraded: response.degraded } : {}),
          }),
        }])).checkpoint;
        return { checkpoint, error: safeError };
      }
      try {
        const decision = parseAgentDecision(response.rawText, { candidates: capabilities });
        checkpoint = (await this.save(checkpoint, checkpoint.task, [{
          type: 'model.completed',
          payload: jsonObject({
            attempt: attempt + 1,
            repair: attempt === 1,
            ok: true,
            valid: true,
            decisionKind: decision.kind,
            durationMs: response.latencyMs ?? Date.now() - modelStartedAt,
            ...(response.role ? { role: boundedDiagnostic(response.role) } : {}),
            ...(response.model ? { model: boundedDiagnostic(response.model) } : {}),
            ...(response.adapter ? { adapter: boundedDiagnostic(response.adapter) } : {}),
            ...(response.degraded !== undefined ? { degraded: response.degraded } : {}),
          }),
        }])).checkpoint;
        return {
          checkpoint,
          decision,
          ...(response.model || response.role ? { model: response.model || response.role } : {}),
        };
      } catch (error) {
        lastValidation = error instanceof AgentDecisionValidationError
          ? error
          : new AgentDecisionValidationError('invalid-decision', sanitizeError(error));
        checkpoint = (await this.save(checkpoint, checkpoint.task, [{
          type: 'model.completed',
          payload: jsonObject({
            attempt: attempt + 1,
            repair: attempt === 1,
            ok: true,
            valid: false,
            error: sanitizeError(lastValidation),
            durationMs: response.latencyMs ?? Date.now() - modelStartedAt,
            ...(response.role ? { role: boundedDiagnostic(response.role) } : {}),
            ...(response.model ? { model: boundedDiagnostic(response.model) } : {}),
            ...(response.adapter ? { adapter: boundedDiagnostic(response.adapter) } : {}),
            ...(response.degraded !== undefined ? { degraded: response.degraded } : {}),
          }),
        }])).checkpoint;
      }
    }
    return { checkpoint, error: sanitizeError(lastValidation?.message || 'invalid-model-decision') };
  }

  private async handleDecision(
    checkpoint: AgentTaskCheckpoint,
    decision: AgentDecision,
    candidates: MonarchCapability[],
    model: string | undefined,
    signal: AbortSignal,
    claimId: string,
  ): Promise<AgentTaskCheckpoint> {
    switch (decision.kind) {
    case 'ask-user':
      return (await this.save(checkpoint, {
        ...checkpoint.task,
        status: 'waiting-for-user',
        messages: appendMessage(checkpoint.task, 'assistant', 'clarification', decision.question),
      }, [{
        type: 'task.status.changed',
        payload: jsonObject({ from: checkpoint.task.status, to: 'waiting-for-user', reason: decision.reason }),
      }])).checkpoint;
    case 'wait-runtime':
      return (await this.save(checkpoint, {
        ...checkpoint.task,
        status: 'waiting-for-runtime',
        messages: appendMessage(checkpoint.task, 'assistant', 'status', decision.reason),
      }, [{
        type: 'task.status.changed',
        payload: jsonObject({ from: checkpoint.task.status, to: 'waiting-for-runtime', runtimeId: decision.runtimeId }),
      }])).checkpoint;
    case 'revise-plan': {
      const plan = checkpoint.task.plan
        ? reviseAgentPlan(checkpoint.task.plan, decision)
        : undefined;
      if (!plan) return this.failTask(checkpoint, 'unrecoverable-error', 'Task has no plan to revise.');
      const currentStepId = currentAgentPlanStep(plan)?.id;
      return (await this.save(checkpoint, withCurrentStep({
        ...checkpoint.task,
        plan,
      }, currentStepId), [{ type: 'plan.revised', payload: jsonObject({ revision: plan.revision, reason: decision.reason }) }])).checkpoint;
    }
    case 'complete':
      return this.completeTask(checkpoint, decision);
    case 'fail':
      return this.failTask(checkpoint, 'unrecoverable-error', `${decision.code}: ${decision.reason}`);
    case 'inspect':
    case 'act': {
      const capability = candidates.find((entry) => entry.id === decision.capabilityId);
      if (!capability) return this.failTask(checkpoint, 'unrecoverable-error', 'Selected capability left the resolver window.');
      return this.executeDecision(checkpoint, decision, capability, model, signal, claimId);
    }
    }
  }

  private async executeDecision(
    checkpointInput: AgentTaskCheckpoint,
    decision: AgentExecutableDecision,
    capability: MonarchCapability,
    model: string | undefined,
    signal: AbortSignal,
    claimId: string,
  ): Promise<AgentTaskCheckpoint> {
    let checkpoint = checkpointInput;
    const step = currentAgentPlanStep(checkpoint.task.plan, checkpoint.task.currentStepId);
    if (!step || !checkpoint.task.plan) return this.failTask(checkpoint, 'unrecoverable-error', 'No executable plan step exists.');
    const metadata = resolveAgentCapabilityMetadata(capability);
    if (!supportsBoundedAgentExecution(metadata)) {
      return this.failTask(
        checkpoint,
        'runtime-unavailable',
        'Effectful capability cannot be agent-dispatched without supported cooperative cancellation.',
      );
    }
    const budget = canConsumeAgentBudget(checkpoint.task.budgets, checkpoint.task.usage, {
      toolCalls: 1,
      computeClass: metadata.computeClass,
    });
    if (!budget.allowed) return this.failTask(checkpoint, 'budget-exhausted', budget.summary, { exhaustedBy: budget.exhaustedBy });

    const proposalInput: MonarchActionProposalInput = {
      version: 1,
      intentId: checkpoint.task.id,
      capabilityId: decision.capabilityId,
      args: decision.input,
      reason: decision.reason,
      expectedEffect: decision.expectedEffect,
      ...(decision.preconditions ? { preconditions: decision.preconditions } : {}),
      ...(decision.verification ? { verification: decision.verification } : {}),
      provenance: {
        source: 'model-tool-call',
        ...(model ? { model } : {}),
        skillIds: [],
      },
    };
    const request = {
      proposal: proposalInput,
      originatingUserText: checkpoint.task.goal.originalRequest,
      requestedBy: `agent:${checkpoint.task.id}`,
      ...(model ? { model } : {}),
      ...(checkpoint.task.activeLeaseId ? { leaseId: checkpoint.task.activeLeaseId } : {}),
      signal,
    };
    const proposal = await this.dependencies.executionAdapter.prepare(request);
    const actionAttemptId = createMonarchId('agent_action');
    const startedAt = nowIso();
    const plan = startAgentPlanStep(checkpoint.task.plan, step.id, capability.id, startedAt);
    checkpoint = (await this.save(checkpoint, {
      ...checkpoint.task,
      plan,
      currentStepId: step.id,
      usage: budget.usage,
      pendingAction: {
        actionAttemptId,
        stepId: step.id,
        proposal: jsonObject(proposal),
        canonicalProposalHash: proposal.canonicalHash,
        status: 'prepared',
        createdAt: startedAt,
      },
    }, [{
      type: 'step.started',
      payload: jsonObject({ stepId: step.id, capabilityId: capability.id }),
    }])).checkpoint;

    const control = await this.handleControl(await this.reload(checkpoint.task.id, checkpoint), signal);
    checkpoint = control.checkpoint;
    if (control.stop) return checkpoint;
    checkpoint = (await this.save(checkpoint, {
      ...checkpoint.task,
      pendingAction: {
        ...checkpoint.task.pendingAction!,
        status: 'dispatched',
        dispatchedAt: nowIso(),
      },
    }, [{
      type: 'tool.started',
      payload: jsonObject({ actionAttemptId, stepId: step.id, capabilityId: capability.id, proposalId: proposal.proposalId }),
    }])).checkpoint;

    const dispatchControl = await this.handleControl(
      await this.reload(checkpoint.task.id, checkpoint),
      signal,
      true,
    );
    checkpoint = dispatchControl.checkpoint;
    if (dispatchControl.stop) return checkpoint;

    const stage = await this.runClaimedStage(
      checkpoint.task.id,
      claimId,
      signal,
      taskWallDeadline(checkpoint.task),
      (stageSignal) => this.dependencies.executionAdapter.execute({ ...request, proposal, signal: stageSignal }),
      true,
      50,
    );
    const result = stage.value;
    checkpoint = stage.checkpoint;
    if (result.result.error === 'confirmation-required') {
      return this.waitForApproval(checkpoint, result, step.id, actionAttemptId);
    }
    const recorded = await this.recordActionResult(checkpoint, decision, capability, result, step.id, actionAttemptId, startedAt);
    return (await this.handleControl(recorded, signal)).checkpoint;
  }

  private async waitForApproval(
    checkpoint: AgentTaskCheckpoint,
    result: AgentActionGatewayResult,
    stepId: string,
    actionAttemptId: string,
  ): Promise<AgentTaskCheckpoint> {
    const approvalId = createMonarchId('agent_approval');
    const requestedAt = nowIso();
    const approval: AgentApproval = {
      schemaVersion: AGENT_APPROVAL_SCHEMA_VERSION,
      id: approvalId,
      taskId: checkpoint.task.id,
      stepId,
      capabilityId: result.proposal.capabilityId,
      canonicalProposalHash: result.proposal.canonicalHash,
      proposal: jsonObject(result.proposal),
      status: 'pending',
      requestedAt,
      ...(result.confirmation?.expiresAt ? { expiresAt: result.confirmation.expiresAt } : {}),
      reason: result.result.summary,
    };
    const approvals = [...checkpoint.approvals, approval];
    const waitingPlan = markStepWaiting(checkpoint.task.plan, stepId);
    const task: AgentTask = {
      ...checkpoint.task,
      status: 'waiting-for-approval',
      activeApprovalId: approvalId,
      pendingAction: {
        actionAttemptId,
        stepId,
        proposal: jsonObject(result.proposal),
        canonicalProposalHash: result.proposal.canonicalHash,
        status: 'waiting-approval',
        createdAt: checkpoint.task.pendingAction?.createdAt || requestedAt,
        ...(checkpoint.task.pendingAction?.dispatchedAt ? { dispatchedAt: checkpoint.task.pendingAction.dispatchedAt } : {}),
      },
      approvals: [...checkpoint.task.approvals, approvalReference(approval)],
      ...(waitingPlan ? { plan: waitingPlan } : {}),
    };
    delete task.activeLeaseId;
    return (await this.save(checkpoint, task, [
      { type: 'tool.completed', payload: jsonObject({ actionAttemptId, ok: false, error: 'confirmation-required' }) },
      { type: 'approval.required', payload: jsonObject({ approvalId, stepId, capabilityId: approval.capabilityId, canonicalProposalHash: approval.canonicalProposalHash }) },
      { type: 'task.status.changed', payload: jsonObject({ from: 'running', to: 'waiting-for-approval' }) },
    ], { approvals })).checkpoint;
  }

  private async executeApprovedAction(
    checkpointInput: AgentTaskCheckpoint,
    approval: AgentApproval,
    signal: AbortSignal,
    claimId: string,
  ): Promise<AgentTaskCheckpoint> {
    let checkpoint = checkpointInput;
    if (signal.aborted || checkpoint.task.cancellationRequested) return this.cancelTask(checkpoint, 'Cancelled before approved action dispatch.');
    const proposal = approval.proposal as unknown as MonarchActionProposalV1;
    const capability = this.dependencies.listCapabilities().find((entry) => entry.id === proposal.capabilityId);
    if (!capability) {
      return this.failTask(
        { ...checkpoint, task: clearActionState(checkpoint.task) },
        'runtime-unavailable',
        'Approved capability is no longer registered.',
      );
    }
    if (!supportsBoundedAgentExecution(resolveAgentCapabilityMetadata(capability))) {
      return this.failTask(
        { ...checkpoint, task: clearActionState(checkpoint.task) },
        'runtime-unavailable',
        'Approved effectful capability no longer has supported cooperative cancellation.',
      );
    }
    const stepId = approval.stepId || checkpoint.task.currentStepId || '';
    const actionAttemptId = checkpoint.task.pendingAction?.actionAttemptId || createMonarchId('agent_action');
    checkpoint = (await this.save(checkpoint, {
      ...checkpoint.task,
      status: 'running',
      pendingAction: {
        actionAttemptId,
        ...(stepId ? { stepId } : {}),
        proposal: approval.proposal,
        canonicalProposalHash: approval.canonicalProposalHash,
        status: 'dispatched',
        createdAt: checkpoint.task.pendingAction?.createdAt || nowIso(),
        dispatchedAt: nowIso(),
      },
    }, [{
      type: 'task.status.changed',
      payload: jsonObject({ from: 'waiting-for-approval', to: 'running', approvalId: approval.id }),
    }])).checkpoint;
    const dispatchControl = await this.handleControl(
      await this.reload(checkpoint.task.id, checkpoint),
      signal,
      true,
    );
    checkpoint = dispatchControl.checkpoint;
    if (dispatchControl.stop) return checkpoint;
    const startedAt = nowIso();
    const stage = await this.runClaimedStage(
      checkpoint.task.id,
      claimId,
      signal,
      taskWallDeadline(checkpoint.task),
      (stageSignal) => this.dependencies.executionAdapter.executeApproved({
        proposal,
        expectedCanonicalHash: approval.canonicalProposalHash,
        originatingUserText: checkpoint.task.goal.originalRequest,
        requestedBy: `agent:${checkpoint.task.id}`,
        grantScope: approval.grantScope || 'once',
        signal: stageSignal,
      }),
      true,
      50,
    );
    const result = stage.value;
    checkpoint = stage.checkpoint;
    const decision: AgentExecutableDecision = {
      kind: capability.risk === 'read' ? 'inspect' : 'act',
      capabilityId: proposal.capabilityId,
      input: proposal.args,
      reason: proposal.reason,
      expectedEffect: proposal.expectedEffect,
      ...(proposal.preconditions ? { preconditions: proposal.preconditions } : {}),
      ...(proposal.verification ? { verification: proposal.verification } : {}),
    };
    const recorded = await this.recordActionResult(checkpoint, decision, capability, result, stepId, actionAttemptId, startedAt);
    return (await this.handleControl(recorded, signal)).checkpoint;
  }

  private async handleRejectedApproval(
    checkpoint: AgentTaskCheckpoint,
    approval: AgentApproval,
  ): Promise<AgentTaskCheckpoint> {
    const stepId = approval.stepId || checkpoint.task.currentStepId || '';
    const plan = checkpoint.task.plan && stepId
      ? settleAgentPlanStep(checkpoint.task.plan, stepId, {
        status: 'failed',
        summary: `Approval ${approval.status}: ${approval.decision?.reason || 'Action was not approved.'}`,
        verifiedAt: approval.resolvedAt || nowIso(),
      })
      : checkpoint.task.plan;
    const nextPlan = appendRecoveryStep(plan, approval.capabilityId, 'Choose a permitted alternative after approval was not granted.');
    const task = withCurrentStep(clearActionState({
      ...checkpoint.task,
      status: 'running',
      ...(nextPlan ? { plan: nextPlan } : {}),
      usage: recordAgentBudgetUsage(checkpoint.task.usage, { failures: 1, meaningfulProgress: false }),
    }), nextPlan ? currentAgentPlanStep(nextPlan)?.id : undefined);
    return (await this.save(checkpoint, task, [{
      type: 'plan.revised',
      payload: jsonObject({ revision: nextPlan?.revision || 1, reason: 'approval-not-granted' }),
    }])).checkpoint;
  }

  private async recordActionResult(
    checkpoint: AgentTaskCheckpoint,
    decision: AgentExecutableDecision,
    capability: MonarchCapability,
    gateway: AgentActionGatewayResult,
    stepId: string,
    actionAttemptId: string,
    startedAt: string,
  ): Promise<AgentTaskCheckpoint> {
    const completedAt = nowIso();
    const metadata = resolveAgentCapabilityMetadata(capability);
    const ledgerId = readNestedString(gateway.result.metadata, ['ledger', 'ledgerId']);
    const observation = normalizeAgentObservation({
      taskId: checkpoint.task.id,
      ...(stepId ? { stepId } : {}),
      actionAttemptId,
      ...(readActionTarget(decision.input) ? { actionTarget: readActionTarget(decision.input) } : {}),
      executionId: gateway.proposal.proposalId,
      capabilityId: capability.id,
      moduleId: capability.moduleId,
      ...(ledgerId ? { ledgerId } : {}),
      startedAt,
      completedAt,
      result: gateway.result,
      ...(capability.outputSchema ? { outputSchema: capability.outputSchema } : {}),
      mutation: metadata.effectProfile.mutation,
    });
    const kernelVerified = gateway.result.ok && hasSuccessfulKernelVerification(gateway.result.metadata, decision.verification?.length || 0);
    const artifacts = deriveVerifiedArtifacts(observation, decision, capability, kernelVerified);
    const enrichedObservation: AgentObservation = artifacts.length > 0
      ? { ...observation, artifacts: [...observation.artifacts, ...artifacts] }
      : observation;
    const observations = [...checkpoint.observations, enrichedObservation];
    const evidence = enrichedObservation.evidence.map((entry) => entry.reference);
    const verificationResult = {
      status: gateway.result.ok && (metadata.effectProfile.mutation === 'none' || kernelVerified)
        ? 'verified' as const
        : gateway.result.error === 'verification-failed' ? 'failed' as const : 'inconclusive' as const,
      summary: gateway.result.ok && (metadata.effectProfile.mutation === 'none' || kernelVerified)
        ? 'Kernel result and required effects were verified.'
        : gateway.result.summary,
      ...(evidence.length > 0 ? { evidence: enrichedObservation.evidence } : {}),
      verifiedAt: completedAt,
    };
    const plan = checkpoint.task.plan && stepId
      ? settleAgentPlanStep(checkpoint.task.plan, stepId, verificationResult, completedAt)
      : checkpoint.task.plan;
    const meaningful = verificationResult.status === 'verified';
    let usage = recordAgentBudgetUsage(checkpoint.task.usage, {
      ...(gateway.result.ok ? {} : { failures: 1 }),
      meaningfulProgress: meaningful,
    }, completedAt);
    const attemptsForAction = checkpoint.task.plan?.steps.find((entry) => entry.id === stepId)?.attemptCount || 1;
    const recovery = decideAgentRecovery({
      ok: gateway.result.ok,
      verified: meaningful,
      ...(gateway.result.error ? { error: gateway.result.error } : {}),
      retryable: enrichedObservation.retryable,
      attemptsForAction,
      totalFailures: usage.failures,
      maxFailures: checkpoint.task.budgets.maxFailures,
      capability: metadata,
    });
    if (!gateway.result.ok && usage.consecutiveNoProgress === 0) {
      usage = recordAgentBudgetUsage(usage, { meaningfulProgress: false }, completedAt);
    }
    const nextPlan = recovery.action === 'replan' || recovery.action === 'retry'
      ? appendRecoveryStep(plan, capability.id, recovery.reason, recovery.action === 'retry' ? attemptsForAction : 0)
      : plan;
    const task: AgentTask = withCurrentStep(clearActionState({
      ...checkpoint.task,
      status: recovery.action === 'wait-runtime' ? 'waiting-for-runtime' : 'running',
      ...(nextPlan ? { plan: nextPlan } : {}),
      observations: [...checkpoint.task.observations, observationReference(enrichedObservation)],
      artifacts: mergeArtifacts(checkpoint.task.artifacts, artifacts),
      ...(gateway.lease?.status === 'active' ? { activeLeaseId: gateway.lease.leaseId } : {}),
      usage,
    }), nextPlan ? currentAgentPlanStep(nextPlan)?.id : undefined);
    const events: AgentTaskEventDraft[] = [
      { type: 'tool.completed', payload: jsonObject({ actionAttemptId, capabilityId: capability.id, ok: gateway.result.ok, error: gateway.result.error || null }) },
      { type: 'observation.created', payload: jsonObject({ observationId: enrichedObservation.id, actionAttemptId, status: enrichedObservation.status }) },
      { type: 'verification.completed', payload: jsonObject({ actionAttemptId, status: verificationResult.status, evidence }) },
      ...artifacts.map((artifact): AgentTaskEventDraft => ({ type: 'artifact.created', payload: jsonObject({ artifactId: artifact.id, kind: artifact.kind, reference: artifact.reference }) })),
      ...(recovery.action === 'replan' || recovery.action === 'retry'
        ? [{ type: 'plan.revised' as const, payload: jsonObject({ revision: nextPlan?.revision || 1, reason: recovery.reason }) }]
        : []),
    ];
    return (await this.save(checkpoint, task, events, { observations })).checkpoint;
  }

  private async completeTask(
    checkpoint: AgentTaskCheckpoint,
    decision: Extract<AgentDecision, { kind: 'complete' }>,
  ): Promise<AgentTaskCheckpoint> {
    const verifications: AgentVerificationRecord[] = [];
    const declaredObservationIds = new Set(decision.evidenceObservationIds);
    const declaredArtifactIds = new Set(decision.artifactIds);
    for (const output of checkpoint.task.goal.expectedOutputs) {
      if (output.required === false) continue;
      verifications.push(buildBoundGoalVerification(
        checkpoint,
        decision,
        'expected-output',
        output.id,
        output.kind === 'artifact',
        output.kind === 'answer',
        output.description,
        declaredObservationIds,
        declaredArtifactIds,
      ));
    }
    for (const criterion of checkpoint.task.goal.successCriteria) {
      verifications.push(buildBoundGoalVerification(
        checkpoint,
        decision,
        'success-criterion',
        criterion.id,
        false,
        false,
        criterion.description,
        declaredObservationIds,
        declaredArtifactIds,
      ));
    }
    const capabilities = new Map(this.dependencies.listCapabilities().map((entry) => [entry.id, entry]));
    const mutationObservations = latestRelevantMutationObservations(checkpoint.observations, capabilities);
    const actions = mutationObservations.map((entry) => {
      const capability = capabilities.get(entry.capabilityId);
      const mutation = capability ? resolveAgentCapabilityMetadata(capability).effectProfile.mutation : 'persistent';
      return {
        actionAttemptId: observationActionAttemptId(entry) || entry.id,
        capabilityId: entry.capabilityId,
        mutation,
        executionStatus: entry.status,
      } as const;
    });
    for (const action of actions) {
      const observation = mutationObservations.find((entry) => observationActionAttemptId(entry) === action.actionAttemptId);
      const strongEvidence = observation?.evidence.filter((entry) => /:verification:/i.test(entry.reference)) || [];
      verifications.push({
        id: createMonarchId('agent_verification'), targetType: 'action', targetId: action.actionAttemptId,
        status: action.executionStatus === 'success' && strongEvidence.length > 0 ? 'verified' : 'failed',
        method: 'kernel-predicate', summary: observation?.summary || 'Missing action observation.',
        evidenceIds: strongEvidence.map((entry) => entry.reference),
      });
    }
    const completion = verifyAgentCompletion({
      expectedOutputs: checkpoint.task.goal.expectedOutputs,
      successCriteria: checkpoint.task.goal.successCriteria,
      actions,
      verifications,
    });
    if (!completion.complete) {
      const plan = appendRecoveryStep(checkpoint.task.plan, 'completion-verifier', completion.summary);
      const currentStepId = plan ? currentAgentPlanStep(plan)?.id : undefined;
      return (await this.save(checkpoint, withCurrentStep({
        ...checkpoint.task,
        ...(plan ? { plan } : {}),
        usage: recordAgentBudgetUsage(checkpoint.task.usage, { failures: 1, meaningfulProgress: false }),
      }, currentStepId), [
        { type: 'verification.completed', payload: jsonObject({ status: completion.status, missing: completion.missing, failed: completion.failed }) },
        ...(plan ? [{ type: 'plan.revised' as const, payload: jsonObject({ revision: plan.revision, reason: completion.summary }) }] : []),
      ])).checkpoint;
    }
    const completedAt = nowIso();
    const completionSummary = groundedAnswerCompletionSummary(checkpoint, decision) || decision.summary;
    return (await this.save(checkpoint, clearActionState({
      ...checkpoint.task,
      status: 'completed',
      completedAt,
      terminalReason: { code: 'completed', summary: completionSummary },
      messages: appendMessage(checkpoint.task, 'assistant', 'result', completionSummary),
    }), [
      { type: 'verification.completed', payload: jsonObject({ status: 'verified', evidenceIds: completion.verifiedEvidenceIds }) },
      { type: 'task.status.changed', payload: jsonObject({ from: checkpoint.task.status, to: 'completed' }) },
      { type: 'task.completed', payload: jsonObject({ summary: completionSummary, artifactIds: decision.artifactIds }) },
    ])).checkpoint;
  }

  private async failTask(
    checkpoint: AgentTaskCheckpoint,
    code: AgentTask['terminalReason'] extends infer _ ? 'budget-exhausted' | 'unrecoverable-error' | 'runtime-unavailable' | 'cancelled-by-user' : never,
    summary: string,
    detail?: AgentJsonObject,
  ): Promise<AgentTaskCheckpoint> {
    if (code === 'cancelled-by-user') return this.cancelTask(checkpoint, summary);
    const safeSummary = sanitizeError(summary);
    const completedAt = nowIso();
    return (await this.save(checkpoint, {
      ...checkpoint.task,
      status: 'failed',
      completedAt,
      terminalReason: { code, summary: safeSummary, ...(detail ? { detail } : {}) },
      messages: appendMessage(checkpoint.task, 'assistant', 'status', safeSummary),
    }, [
      { type: 'task.status.changed', payload: jsonObject({ from: checkpoint.task.status, to: 'failed', reason: code }) },
      { type: 'task.failed', payload: jsonObject({ code, summary: safeSummary }) },
    ])).checkpoint;
  }

  private async cancelTask(checkpoint: AgentTaskCheckpoint, summary: string): Promise<AgentTaskCheckpoint> {
    if (checkpoint.task.status === 'cancelled') return checkpoint;
    const completedAt = nowIso();
    return (await this.save(checkpoint, {
      ...checkpoint.task,
      status: 'cancelled',
      cancellationRequested: true,
      completedAt,
      terminalReason: { code: 'cancelled-by-user', summary },
      messages: appendMessage(checkpoint.task, 'assistant', 'status', summary),
    }, [
      { type: 'task.status.changed', payload: jsonObject({ from: checkpoint.task.status, to: 'cancelled' }) },
      { type: 'task.cancelled', payload: jsonObject({ summary }) },
    ])).checkpoint;
  }

  private async interruptTask(checkpoint: AgentTaskCheckpoint, summary: string): Promise<AgentTaskCheckpoint> {
    if (TERMINAL.has(checkpoint.task.status) || checkpoint.task.status === 'interrupted') return checkpoint;
    const interruptedAt = nowIso();
    return (await this.save(checkpoint, {
      ...checkpoint.task,
      status: 'interrupted',
      recovery: {
        reason: 'process-restart',
        previousStatus: checkpoint.task.status,
        interruptedAt,
      },
      messages: appendMessage(checkpoint.task, 'assistant', 'status', summary),
    }, [
      { type: 'task.status.changed', payload: jsonObject({ from: checkpoint.task.status, to: 'interrupted' }) },
      { type: 'task.interrupted', payload: jsonObject({ summary }) },
    ])).checkpoint;
  }

  private async renew(checkpoint: AgentTaskCheckpoint, claimId: string): Promise<AgentTaskCheckpoint> {
    let current = checkpoint;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!claimId || !current.task.runnerClaim || TERMINAL.has(current.task.status)) return current;
      try {
        return (await this.dependencies.store.renewRunner(
          current.task.id,
          claimId,
          this.claimTtlMs,
          current.task.checkpointVersion,
        )).checkpoint;
      } catch (error) {
        if (error instanceof AgentTaskRunnerClaimError) {
          throw new AgentRunnerClaimLostError(error.message);
        }
        if (!(error instanceof AgentTaskStoreConflictError)) throw error;
        const latest = await this.dependencies.store.getTask(current.task.id);
        if (!ownedClaim(latest, claimId, this.dependencies.runnerId, true)) {
          throw new AgentRunnerClaimLostError('Agent runner claim changed during renewal conflict recovery.');
        }
        current = latest;
      }
    }
    throw new AgentRunnerClaimLostError('Agent runner claim could not be renewed after repeated checkpoint conflicts.');
  }

  private async runClaimedStage<T>(
    taskId: string,
    claimId: string,
    parentSignal: AbortSignal,
    deadlineAt: number,
    work: (signal: AbortSignal) => Promise<T>,
    detachOnAbort = false,
    detachGraceMs = 0,
  ): Promise<{ value: T; checkpoint: AgentTaskCheckpoint }> {
    const stageController = new AbortController();
    const forwardAbort = () => stageController.abort(parentSignal.reason);
    if (parentSignal.aborted) forwardAbort();
    else parentSignal.addEventListener('abort', forwardAbort, { once: true });
    const remainingWallTimeMs = deadlineAt - Date.now();
    if (remainingWallTimeMs <= 0) {
      parentSignal.removeEventListener('abort', forwardAbort);
      throw new AgentTaskWallTimeExceededError();
    }
    const wallTimer = setTimeout(() => stageController.abort('budget-wall-time'), remainingWallTimeMs);
    wallTimer.unref?.();

    const intervalMs = Math.max(100, Math.min(500, Math.floor(this.claimTtlMs / 3)));
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatInFlight: Promise<void> | null = null;
    let lost: AgentRunnerClaimLostError | null = null;
    const markLost = (message: string) => {
      if (lost) return;
      lost = new AgentRunnerClaimLostError(message);
      stageController.abort('runner-claim-lost');
    };
    const schedule = () => {
      if (active && !lost) timer = setTimeout(tick, intervalMs);
    };
    const tick = () => {
      heartbeatInFlight = (async () => {
        const current = await this.dependencies.store.getTask(taskId).catch(() => null);
        if (!ownedClaim(current, claimId, this.dependencies.runnerId, true)) {
          markLost('Agent runner claim was lost during an active stage.');
          return;
        }
        if (current.task.cancellationRequested || current.task.status === 'cancelling') {
          stageController.abort('cancel');
          return;
        }
        if (current.task.pauseRequested || current.task.status === 'paused') {
          stageController.abort('pause');
          return;
        }
        try {
          await this.dependencies.store.renewRunner(
            taskId,
            claimId,
            this.claimTtlMs,
            current.task.checkpointVersion,
          );
        } catch {
          const latest = await this.dependencies.store.getTask(taskId).catch(() => null);
          if (!ownedClaim(latest, claimId, this.dependencies.runnerId, true)) {
            markLost('Agent runner claim could not be renewed and ownership changed.');
          }
        }
      })().finally(() => {
        heartbeatInFlight = null;
        schedule();
      });
    };
    schedule();

    let detachAbortListener: (() => void) | undefined;
    let detachGraceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      let value: T;
      try {
        const workPromise = Promise.resolve().then(() => work(stageController.signal));
        if (detachOnAbort) {
          const abortPromise = new Promise<never>((_resolve, reject) => {
            const rejectForAbort = () => {
              const rejectStage = () => {
                if (stageController.signal.reason === 'budget-wall-time') {
                  reject(new AgentTaskWallTimeExceededError());
                } else if (lost) {
                  reject(lost);
                } else {
                  reject(new Error('Agent stage aborted.'));
                }
              };
              if (detachGraceMs > 0) {
                detachGraceTimer = setTimeout(rejectStage, detachGraceMs);
                detachGraceTimer.unref?.();
                return;
              }
              rejectStage();
            };
            detachAbortListener = () => stageController.signal.removeEventListener('abort', rejectForAbort);
            if (stageController.signal.aborted) rejectForAbort();
            else stageController.signal.addEventListener('abort', rejectForAbort, { once: true });
          });
          value = await Promise.race([workPromise, abortPromise]);
        } else {
          value = await workPromise;
        }
      } catch (error) {
        if (stageController.signal.reason === 'budget-wall-time') throw new AgentTaskWallTimeExceededError();
        throw error;
      }
      active = false;
      if (timer) clearTimeout(timer);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (lost) throw lost;
      if (stageController.signal.reason === 'budget-wall-time') throw new AgentTaskWallTimeExceededError();
      const checkpoint = await this.dependencies.store.getTask(taskId);
      if (!ownedClaim(checkpoint, claimId, this.dependencies.runnerId, true)) {
        throw new AgentRunnerClaimLostError('Agent runner claim expired or changed before stage settlement.');
      }
      return { value, checkpoint };
    } finally {
      active = false;
      if (timer) clearTimeout(timer);
      clearTimeout(wallTimer);
      if (detachGraceTimer) clearTimeout(detachGraceTimer);
      detachAbortListener?.();
      parentSignal.removeEventListener('abort', forwardAbort);
    }
  }

  private async releaseClaim(taskId: string, claimId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const latest = await this.dependencies.store.getTask(taskId);
      if (!latest || latest.task.runnerClaim?.claimId !== claimId) return;
      try {
        await this.dependencies.store.releaseRunner(taskId, claimId, latest.task.checkpointVersion);
        return;
      } catch (error) {
        if (error instanceof AgentTaskStoreConflictError) continue;
        if (error instanceof AgentTaskRunnerClaimError) return;
        throw error;
      }
    }
  }

  private async reload(taskId: string, fallback: AgentTaskCheckpoint): Promise<AgentTaskCheckpoint> {
    return await this.dependencies.store.getTask(taskId) || fallback;
  }

  private async save(
    checkpoint: AgentTaskCheckpoint,
    task: AgentTask,
    events: AgentTaskEventDraft[],
    records: { observations?: AgentObservation[]; approvals?: AgentApproval[] } = {},
  ): Promise<AgentTaskStoreCommit> {
    const claimId = checkpoint.task.runnerClaim?.claimId || '';
    if (!ownedClaim(checkpoint, claimId, this.dependencies.runnerId, true)) {
      throw new AgentRunnerClaimLostError('Agent runner cannot mutate a task without its current durable claim.');
    }
    const observationAdditions = records.observations
      ? records.observations.filter((entry) => !checkpoint.observations.some((current) => current.id === entry.id))
      : undefined;
    const approvalUpdates = records.approvals
      ? records.approvals.filter((entry) => {
        const current = checkpoint.approvals.find((candidate) => candidate.id === entry.id);
        return !current || JSON.stringify(current) !== JSON.stringify(entry);
      })
      : undefined;
    let base = checkpoint;
    let candidate = task;
    let candidateEvents = events;
    let candidateObservations = records.observations;
    let candidateApprovals = records.approvals;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!ownedClaim(base, claimId, this.dependencies.runnerId, true)) {
        throw new AgentRunnerClaimLostError('Agent runner lost its durable claim before checkpoint commit.');
      }
      try {
        return await this.dependencies.store.saveTask({
          ...candidate,
          runnerClaim: base.task.runnerClaim!,
          schemaVersion: AGENT_TASK_SCHEMA_VERSION,
          checkpointVersion: base.task.checkpointVersion,
          eventSequence: base.task.eventSequence,
        }, {
          expectedCheckpointVersion: base.task.checkpointVersion,
          expectedRunnerClaimId: claimId,
          events: candidateEvents,
          ...(candidateObservations ? { observations: candidateObservations } : {}),
          ...(candidateApprovals ? { approvals: candidateApprovals } : {}),
        });
      } catch (error) {
        if (error instanceof AgentTaskRunnerClaimError) {
          throw new AgentRunnerClaimLostError(error.message);
        }
        if (!(error instanceof AgentTaskStoreConflictError)) throw error;
        const latest = await this.dependencies.store.getTask(checkpoint.task.id);
        if (!ownedClaim(latest, claimId, this.dependencies.runnerId, true)) {
          throw new AgentRunnerClaimLostError('Agent runner claim changed during checkpoint conflict recovery.');
        }
        const rebased = rebaseConcurrentAgentSave(checkpoint.task, candidate, candidateEvents, latest.task);
        base = latest;
        candidate = rebased.task;
        candidateEvents = rebased.events;
        candidateObservations = observationAdditions
          ? mergeRecordsById(latest.observations, observationAdditions)
          : undefined;
        candidateApprovals = approvalUpdates
          ? mergeApprovalRecords(latest.approvals, approvalUpdates, latest.task.cancellationRequested === true)
          : undefined;
      }
    }
    throw new AgentRunnerClaimLostError('Agent checkpoint could not be rebased after repeated concurrent updates.');
  }
}

function pendingApproval(checkpoint: AgentTaskCheckpoint): AgentApproval | null {
  return checkpoint.approvals.find((entry) => entry.id === checkpoint.task.activeApprovalId && entry.status === 'pending') || null;
}

function findApprovedActiveApproval(checkpoint: AgentTaskCheckpoint): AgentApproval | null {
  return checkpoint.approvals.find((entry) => entry.id === checkpoint.task.activeApprovalId && entry.status === 'approved') || null;
}

function findRejectedActiveApproval(checkpoint: AgentTaskCheckpoint): AgentApproval | null {
  return checkpoint.approvals.find((entry) => (
    entry.id === checkpoint.task.activeApprovalId
    && (entry.status === 'denied' || entry.status === 'expired' || entry.status === 'revoked')
  )) || null;
}

function ensureCurrentStep(task: AgentTask): { task: AgentTask; changed: boolean } {
  const current = currentAgentPlanStep(task.plan, task.currentStepId);
  if (current) return { task: task.currentStepId === current.id ? task : { ...task, currentStepId: current.id }, changed: task.currentStepId !== current.id };
  const plan = appendRecoveryStep(task.plan, 'runtime', 'Continue toward verified completion.');
  const nextStepId = plan ? currentAgentPlanStep(plan)?.id : undefined;
  return plan
    ? { task: withCurrentStep({ ...task, plan }, nextStepId), changed: true }
    : { task, changed: false };
}

function appendRecoveryStep(
  plan: AgentPlan | undefined,
  capabilityId: string,
  reason: string,
  previousAttemptCount = 0,
): AgentPlan | undefined {
  if (!plan) return undefined;
  const step: AgentPlanStep = {
    id: createMonarchId('agent_step'),
    title: `Replan after ${capabilityId}`.slice(0, 500),
    status: 'ready',
    dependsOn: [],
    expectedEffects: [{ kind: 'other', description: reason.slice(0, 1_000) }],
    verification: [{ kind: 'other', description: 'Require a new factual observation and deterministic evidence.' }],
    attemptCount: previousAttemptCount,
  };
  return { ...plan, revision: plan.revision + 1, steps: [...plan.steps, step], revisedAt: nowIso() };
}

function markStepWaiting(plan: AgentPlan | undefined, stepId: string): AgentPlan | undefined {
  if (!plan) return undefined;
  return { ...plan, steps: plan.steps.map((step) => step.id === stepId ? { ...step, status: 'waiting-approval' } : step) };
}

function appendMessage(
  task: AgentTask,
  role: 'user' | 'assistant',
  kind: 'request' | 'clarification' | 'progress' | 'result' | 'status' | 'reference',
  content: string,
): AgentTask['messages'] {
  return [...task.messages, {
    id: createMonarchId('agent_message'), role, kind, createdAt: nowIso(), content: sanitizeError(content).slice(0, 16_000),
  }].slice(-200);
}

function approvalReference(approval: AgentApproval): AgentTask['approvals'][number] {
  return {
    id: approval.id,
    taskId: approval.taskId,
    ...(approval.stepId ? { stepId: approval.stepId } : {}),
    status: approval.status,
    capabilityId: approval.capabilityId,
    canonicalProposalHash: approval.canonicalProposalHash,
  };
}

function observationReference(observation: AgentObservation): AgentTask['observations'][number] {
  return {
    id: observation.id,
    taskId: observation.taskId,
    ...(observation.stepId ? { stepId: observation.stepId } : {}),
    status: observation.status,
    summary: observation.summary,
    occurredAt: observation.occurredAt,
  };
}

function deriveVerifiedArtifacts(
  observation: AgentObservation,
  decision: AgentExecutableDecision,
  capability: MonarchCapability,
  kernelVerified: boolean,
): AgentArtifactReference[] {
  if (!observation.status.startsWith('success') || !kernelVerified) return [];
  if (capability.id !== 'workspace.files.write' || typeof decision.input.path !== 'string') return [];
  return [{
    id: createMonarchId('agent_artifact'),
    kind: 'report',
    label: decision.input.path.split(/[\\/]/).at(-1) || 'workspace report',
    reference: decision.input.path,
    createdAt: observation.occurredAt,
  }];
}

function mergeArtifacts(current: AgentArtifactReference[], additions: AgentArtifactReference[]): AgentArtifactReference[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of additions) merged.set(entry.id, entry);
  return [...merged.values()];
}

function hasSuccessfulKernelVerification(metadata: Record<string, unknown> | undefined, requiredCount: number): boolean {
  if (requiredCount === 0) return true;
  const observations = metadata?.observations;
  if (!Array.isArray(observations)) return false;
  const verification = observations.filter((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return record.phase === 'verification' && record.ok === true;
  });
  return verification.length >= requiredCount;
}

function observationActionAttemptId(observation: AgentObservation): string {
  const structured = observation.structuredData;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return '';
  const provenance = structured.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return '';
  return typeof provenance.actionAttemptId === 'string' ? provenance.actionAttemptId : '';
}

function buildBoundGoalVerification(
  checkpoint: AgentTaskCheckpoint,
  decision: Extract<AgentDecision, { kind: 'complete' }>,
  targetType: AgentVerificationRecord['targetType'],
  targetId: string,
  artifactRequired: boolean,
  answerRequired: boolean,
  targetDescription: string,
  declaredObservationIds: ReadonlySet<string>,
  declaredArtifactIds: ReadonlySet<string>,
): AgentVerificationRecord {
  const bindings = decision.evidenceBindings.filter((entry) => (
    entry.targetType === targetType && entry.targetId === targetId
  ));
  const base = {
    id: createMonarchId('agent_verification'),
    targetType,
    targetId,
    method: 'deterministic' as const,
  };
  if (bindings.length !== 1) {
    return {
      ...base,
      status: 'inconclusive',
      summary: bindings.length === 0
        ? 'The completion decision did not bind evidence to this required target.'
        : 'The completion decision supplied ambiguous duplicate evidence bindings.',
      evidenceIds: [],
    };
  }
  const binding = bindings[0]!;
  const observations = binding.observationIds.map((id) => checkpoint.observations.find((entry) => entry.id === id));
  const artifacts = binding.artifactIds.map((id) => checkpoint.task.artifacts.find((entry) => entry.id === id));
  const referencesDeclared = binding.observationIds.every((id) => declaredObservationIds.has(id))
    && binding.artifactIds.every((id) => declaredArtifactIds.has(id));
  const observationsValid = observations.length > 0
    && observations.every((entry) => entry?.status === 'success' && entry.evidence.length > 0);
  const artifactsValid = artifacts.every(Boolean)
    && binding.artifactIds.every((id) => observations.some((entry) => entry?.artifacts.some((artifact) => artifact.id === id)));
  const artifactTargetValid = !artifactRequired || (
    artifacts.length > 0
    && artifacts.every((artifact) => artifactMatchesGoalDescription(artifact!, targetDescription))
  );
  const targetObservations = observations.filter((observation): observation is AgentObservation => Boolean(
    observation && observationMatchesGoalTarget(checkpoint, targetType, targetDescription, observation),
  ));
  const evidenceTargetValid = targetObservations.length > 0;
  const answerGrounded = !answerRequired
    || completionSummaryMatchesObservedAnswer(decision.summary, targetObservations, targetDescription);
  const verified = referencesDeclared
    && observationsValid
    && artifactsValid
    && artifactTargetValid
    && evidenceTargetValid
    && answerGrounded;
  return {
    ...base,
    status: verified ? 'verified' : 'failed',
    summary: verified
      ? 'Successful factual observations are explicitly bound to this required target.'
      : answerRequired && !answerGrounded
        ? 'The completion summary does not state a factual answer value from the bound successful observation.'
        : 'The bound evidence is missing, unsuccessful, undeclared, or unrelated to the required target or effect.',
    evidenceIds: verified
      ? observations.flatMap((entry) => entry!.evidence.map((evidence) => evidence.reference))
      : [],
  };
}

const ANSWER_IDENTITY_KEYS = new Set([
  'path',
  'targetpath',
  'url',
  'resourceid',
  'id',
  'file',
  'filename',
  'directory',
  'target',
]);

const ANSWER_PRIMARY_KEYS = new Set([
  'answer',
  'body',
  'content',
  'data',
  'entries',
  'items',
  'matches',
  'result',
  'results',
  'status',
  'text',
  'value',
  'values',
  'version',
]);

const ANSWER_INCIDENTAL_KEYS = new Set([
  'bytes',
  'durationms',
  'elapsedms',
  'encoding',
  'limit',
  'maxbytes',
  'offset',
  'page',
  'pages',
  'partial',
  'sizebytes',
  'truncated',
]);

function completionSummaryMatchesObservedAnswer(
  summary: string,
  observations: readonly AgentObservation[],
  targetDescription: string,
): boolean {
  const normalizedSummary = normalizeAnswerText(summary);
  if (!normalizedSummary) return false;
  const facts = observations.flatMap((observation) => observationAnswerFacts(observation, targetDescription));
  return facts.some((fact) => summaryContainsObservedFact(normalizedSummary, fact));
}

function observationAnswerFacts(observation: AgentObservation, targetDescription: string): string[] {
  const structured = observation.structuredData;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return [];
  const output = structured.output;
  const facts: string[] = [];
  collectAnswerFacts(output, facts, 0, targetDescription);
  return [...new Set(facts)].slice(0, 128);
}

function collectAnswerFacts(value: unknown, facts: string[], depth: number, targetDescription: string): void {
  if (facts.length >= 128 || depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed && !/^\[REDACTED(?:_[A-Z]+)?\]$/u.test(trimmed)) facts.push(trimmed.slice(0, 4_000));
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    facts.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 128)) collectAnswerFacts(entry, facts, depth + 1, targetDescription);
    return;
  }
  if (typeof value !== 'object') return;
  const entries = selectAnswerFactEntries(value as Record<string, unknown>, targetDescription);
  for (const [, entry] of entries.slice(0, 128)) {
    collectAnswerFacts(entry, facts, depth + 1, targetDescription);
  }
}

function selectAnswerFactEntries(
  value: Record<string, unknown>,
  targetDescription: string,
): Array<[string, unknown]> {
  const entries = Object.entries(value);
  const described = entries.filter(([key]) => (
    !ANSWER_IDENTITY_KEYS.has(normalizeAnswerKey(key))
    && targetDescriptionMentionsAnswerKey(targetDescription, key)
  ));
  if (described.length > 0) return described;
  const primary = entries.filter(([key]) => ANSWER_PRIMARY_KEYS.has(normalizeAnswerKey(key)));
  if (primary.length > 0) return primary;
  return entries.filter(([key]) => {
    const normalizedKey = normalizeAnswerKey(key);
    if (ANSWER_IDENTITY_KEYS.has(normalizedKey)) return false;
    return !ANSWER_INCIDENTAL_KEYS.has(normalizedKey) || targetDescriptionMentionsAnswerKey(targetDescription, key);
  });
}

function normalizeAnswerKey(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '');
}

function targetDescriptionMentionsAnswerKey(description: string, key: string): boolean {
  const normalizedDescription = normalizeAnswerText(description);
  const compactDescription = normalizeAnswerKey(description);
  const compactKey = normalizeAnswerKey(key);
  if (compactKey.length >= 3 && compactDescription.includes(compactKey)) return true;
  const keyTokens = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/g)
    .filter((entry) => entry.length >= 3);
  return keyTokens.some((token) => (` ${normalizedDescription} `).includes(` ${token} `));
}

function summaryContainsObservedFact(normalizedSummary: string, fact: string): boolean {
  const normalizedFact = normalizeAnswerText(fact);
  if (!normalizedFact) return false;
  return (` ${normalizedSummary} `).includes(` ${normalizedFact} `);
}

function normalizeAnswerText(value: string): string {
  return normalizeEvidenceText(value).replace(/[.]+(?=\s|$)/gu, '').replace(/\s+/g, ' ').trim();
}

function groundedAnswerCompletionSummary(
  checkpoint: AgentTaskCheckpoint,
  decision: Extract<AgentDecision, { kind: 'complete' }>,
): string | undefined {
  const requiredAnswers = checkpoint.task.goal.expectedOutputs.filter((output) => (
    output.required !== false && output.kind === 'answer'
  ));
  if (requiredAnswers.length === 0) return undefined;
  const sections: string[] = [];
  for (const output of requiredAnswers) {
    const binding = decision.evidenceBindings.find((entry) => (
      entry.targetType === 'expected-output' && entry.targetId === output.id
    ));
    if (!binding) continue;
    const facts = binding.observationIds.flatMap((id) => {
      const observation = checkpoint.observations.find((entry) => entry.id === id);
      if (
        !observation
        || observation.status !== 'success'
        || !observationMatchesGoalTarget(checkpoint, 'expected-output', output.description, observation)
      ) return [];
      return observationAnswerFacts(observation, output.description);
    });
    const uniqueFacts = [...new Set(facts)].slice(0, 16);
    if (uniqueFacts.length === 0) continue;
    const value = uniqueFacts.join('; ');
    sections.push(requiredAnswers.length === 1 ? value : `${output.description}: ${value}`);
  }
  if (sections.length !== requiredAnswers.length) return undefined;
  return sanitizeError(sections.join('\n'));
}

function observationMatchesGoalTarget(
  checkpoint: AgentTaskCheckpoint,
  targetType: AgentVerificationRecord['targetType'],
  targetDescription: string,
  observation: AgentObservation,
): boolean {
  const evidenceDescription = targetType === 'success-criterion'
    ? [
        targetDescription,
        ...checkpoint.task.goal.expectedOutputs
          .filter((entry) => entry.required !== false)
          .map((entry) => entry.description),
      ].join(' ')
    : targetDescription;
  const capabilityId = normalizeEvidenceText(observation.capabilityId);
  const resourceAnchors = extractEvidenceResourceAnchors(evidenceDescription)
    .filter((entry) => entry !== capabilityId);
  const primaryActionTarget = readObservationActionTarget(observation);
  const observedTargets = primaryActionTarget ? [primaryActionTarget] : observationResourceTargets(observation);
  if (resourceAnchors.length > 0) {
    return resourceAnchors.some((anchor) => observedTargets.some((target) => evidenceTargetMatches(anchor, target)));
  }

  const normalizedDescription = normalizeEvidenceText(evidenceDescription);
  if (capabilityId.length >= 3 && containsEvidenceToken(normalizedDescription, capabilityId)) return true;
  return observation.artifacts.some((artifact) => artifactMatchesGoalDescription(artifact, evidenceDescription));
}

function extractEvidenceResourceAnchors(value: string): string[] {
  const matches = String(value || '').match(
    /https?:\/\/[^\s"'<>]+|(?:[A-Za-z]:)?(?:[\\/][\p{L}\p{N}._~:@%+,=-]+)+|[\p{L}\p{N}_-]+(?:[\\/][\p{L}\p{N}._~:@%+,=-]+)+|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu,
  ) || [];
  return [...new Set(matches
    .map((entry) => normalizeEvidenceText(entry).replace(/^[.,;:!?]+|[.,;:!?]+$/g, ''))
    .filter((entry) => entry.length >= 3))];
}

function observationResourceTargets(observation: AgentObservation): string[] {
  const values: string[] = [];
  const structured = observation.structuredData;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const provenance = structured.provenance;
    if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
      if (typeof provenance.actionTarget === 'string') values.push(provenance.actionTarget);
    }
    for (const sideEffect of observationSideEffects(observation)) {
      if (typeof sideEffect.target === 'string') values.push(sideEffect.target);
    }
    const output = structured.output;
    if (output && typeof output === 'object' && !Array.isArray(output)) {
      for (const key of ['path', 'targetPath', 'url', 'resourceId', 'id']) {
        const candidate = output[key];
        if (typeof candidate === 'string') values.push(candidate);
      }
    }
  }
  for (const artifact of observation.artifacts) values.push(artifact.reference, artifact.label);
  return [...new Set(values.map(normalizeEvidenceText).filter((entry) => entry.length >= 3))];
}

function evidenceTargetMatches(expected: string, actual: string): boolean {
  const expectedPath = expected.replace(/^\.\//, '').replace(/^\//, '');
  const actualPath = actual.replace(/^\.\//, '').replace(/^\//, '');
  return expectedPath === actualPath;
}

function containsEvidenceToken(haystack: string, needle: string): boolean {
  return (` ${haystack} `).includes(` ${needle} `);
}

function artifactMatchesGoalDescription(artifact: AgentArtifactReference, description: string): boolean {
  const normalizedDescription = normalizeEvidenceText(description);
  const reference = normalizeEvidenceText(artifact.reference);
  const label = normalizeEvidenceText(artifact.label.replace(/\.[^.]+$/u, ''));
  return (reference.length >= 3 && normalizedDescription.includes(reference))
    || (label.length >= 3 && normalizedDescription.includes(label));
}

function normalizeEvidenceText(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}._/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function latestRelevantMutationObservations(
  observations: readonly AgentObservation[],
  capabilities: ReadonlyMap<string, MonarchCapability>,
): AgentObservation[] {
  const latest = new Map<string, AgentObservation>();
  for (const observation of observations) {
    const capability = capabilities.get(observation.capabilityId);
    const mutation = capability ? resolveAgentCapabilityMetadata(capability).effectProfile.mutation : 'persistent';
    if (mutation === 'none') continue;
    const sideEffects = observationSideEffects(observation);
    const mutationTruth = observationMutationTruth(observation);
    if ((observation.status === 'failed' || observation.status === 'cancelled')
      && sideEffects.length === 0
      && mutationTruth === 'no-effect') continue;
    const target = readObservationActionTarget(observation);
    const key = `${observation.capabilityId}:${target || observationActionAttemptId(observation) || observation.id}`;
    latest.set(key, observation);
  }
  return [...latest.values()];
}

function observationMutationTruth(observation: AgentObservation): string {
  const structured = observation.structuredData;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return 'unknown';
  const truth = structured.mutationTruth;
  if (!truth || typeof truth !== 'object' || Array.isArray(truth)) return 'unknown';
  return typeof truth.state === 'string' ? truth.state : 'unknown';
}

function observationSideEffects(observation: AgentObservation): AgentJsonObject[] {
  const structured = observation.structuredData;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return [];
  const values = structured.sideEffects;
  if (!Array.isArray(values)) return [];
  return values.filter((entry): entry is AgentJsonObject => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
}

function readObservationActionTarget(observation: AgentObservation): string {
  const structured = observation.structuredData;
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return '';
  const provenance = structured.provenance;
  if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
    const target = provenance.actionTarget;
    if (typeof target === 'string' && target.trim()) return normalizeEvidenceText(target);
  }
  const sideEffectTarget = observationSideEffects(observation)
    .map((entry) => entry.target)
    .find((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
  return sideEffectTarget ? normalizeEvidenceText(sideEffectTarget) : '';
}

function readActionTarget(input: Record<string, unknown>): string {
  for (const key of ['path', 'targetPath', 'url', 'resourceId', 'id']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function readNestedString(value: unknown, keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current ? current : undefined;
}

function jsonObject(value: unknown): AgentJsonObject {
  return JSON.parse(JSON.stringify(value)) as AgentJsonObject;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactAgentContextValue(message, { maxStringChars: 4_000 }).value).slice(0, 4_000);
}

function boundedDiagnostic(value: string): string {
  return sanitizeError(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
}

function abortKind(signal: AbortSignal): 'cancel' | 'pause' | 'shutdown' | null {
  if (!signal.aborted) return null;
  return signal.reason === 'shutdown' ? 'shutdown' : signal.reason === 'pause' ? 'pause' : 'cancel';
}

function clearActionState(task: AgentTask): AgentTask {
  const copy = { ...task };
  delete copy.pendingAction;
  delete copy.activeApprovalId;
  return copy;
}

function withCurrentStep(task: AgentTask, stepId: string | undefined): AgentTask {
  const copy = { ...task };
  delete copy.currentStepId;
  if (stepId) copy.currentStepId = stepId;
  return copy;
}

class AgentRunnerClaimLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunnerClaimLostError';
  }
}

class AgentTaskWallTimeExceededError extends Error {
  constructor() {
    super('Agent task wall-time budget expired during an active stage.');
    this.name = 'AgentTaskWallTimeExceededError';
  }
}

function taskWallDeadline(task: AgentTask): number {
  return Date.parse(task.usage.startedAt) + task.budgets.maxWallTimeMs;
}

function rebaseConcurrentAgentSave(
  original: AgentTask,
  desired: AgentTask,
  events: AgentTaskEventDraft[],
  latest: AgentTask,
): { task: AgentTask; events: AgentTaskEventDraft[] } {
  const cancellationChanged = latest.cancellationRequested === true
    || latest.status === 'cancelling'
    || jsonChanged(original.cancellationRequested, latest.cancellationRequested);
  const pauseChanged = latest.pauseRequested === true
    || latest.status === 'paused'
    || jsonChanged(original.pauseRequested, latest.pauseRequested);
  const merged: AgentTask = {
    ...desired,
    runnerClaim: latest.runnerClaim!,
    messages: mergeMessages(latest.messages, desired.messages),
    observations: mergeRecordsById(latest.observations, desired.observations),
    artifacts: mergeRecordsById(latest.artifacts, desired.artifacts),
    approvals: cancellationChanged
      ? latest.approvals
      : mergeRecordsById(latest.approvals, desired.approvals),
    checkpointVersion: latest.checkpointVersion,
    eventSequence: latest.eventSequence,
    updatedAt: latest.updatedAt,
  };

  for (const key of [
    'status',
    'pauseRequested',
    'cancellationRequested',
    'activeApprovalId',
    'pendingAction',
    'activeLeaseId',
    'completedAt',
    'terminalReason',
    'recovery',
  ] as const) {
    if (jsonChanged(original[key], latest[key])) copyOptionalField(merged, latest, key);
  }

  const controlChanged = cancellationChanged || pauseChanged;
  return {
    task: merged,
    events: controlChanged
      ? events.filter((event) => (
        event.type !== 'task.status.changed'
        && event.type !== 'approval.required'
        && event.type !== 'task.completed'
        && event.type !== 'task.failed'
      ))
      : events,
  };
}

function mergeMessages(left: AgentTask['messages'], right: AgentTask['messages']): AgentTask['messages'] {
  return mergeRecordsById(left, right)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-200);
}

function mergeRecordsById<T extends { id: string }>(left: readonly T[], right: readonly T[]): T[] {
  const merged = left.map((entry) => ({ ...entry }));
  const seen = new Set(merged.map((entry) => entry.id));
  for (const entry of right) {
    if (seen.has(entry.id)) continue;
    merged.push({ ...entry });
    seen.add(entry.id);
  }
  return merged;
}

function mergeApprovalRecords(
  current: readonly AgentApproval[],
  updates: readonly AgentApproval[],
  cancellationRequested: boolean,
): AgentApproval[] {
  if (cancellationRequested) return current.map((entry) => ({ ...entry }));
  const byId = new Map(current.map((entry) => [entry.id, { ...entry }]));
  for (const update of updates) byId.set(update.id, { ...update });
  return [...byId.values()];
}

function copyOptionalField<K extends keyof AgentTask>(target: AgentTask, source: AgentTask, key: K): void {
  if (source[key] === undefined) delete target[key];
  else target[key] = source[key];
}

function jsonChanged(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function ownedClaim(
  checkpoint: AgentTaskCheckpoint | null,
  claimId: string,
  runnerId: string,
  requireUnexpired: boolean,
): checkpoint is AgentTaskCheckpoint {
  const claim = checkpoint?.task.runnerClaim;
  if (!claim || !claimId || claim.claimId !== claimId || claim.runnerId !== runnerId) return false;
  return !requireUnexpired || Date.parse(claim.expiresAt) > Date.now();
}

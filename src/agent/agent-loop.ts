import { createHash } from 'node:crypto';
import path from 'node:path';
import { createMonarchId, nowIso } from '../core/utils';
import { canonicalizeActionIdentityArgs, canonicalProposalHash } from '../core/action-protocol';
import { classifyOscarRequestDisposition } from '../core/intent-classifier';
import type {
  MonarchActionProposalInput,
  MonarchActionProposalV1,
  MonarchActionPredicate,
  MonarchCapability,
  MonarchPermissionProfile,
} from '../core/contracts';
import { resolveAgentCapabilityMetadata, supportsBoundedAgentExecution } from '../core/capability-metadata';
import {
  knownFolderWriteInputMatchesRequest,
  knownFolderWriteOutputMatchesRequest,
  parseKnownFolderFileRequest,
  resolveKnownFolderRequestTarget,
  sameCanonicalFilesystemPath,
} from '../core/known-folder-target';
import { canConsumeAgentBudget, evaluateAgentBudget, recordAgentBudgetUsage } from './budget-manager';
import { resolveAgentCapabilities } from './capability-resolver';
import {
  parseTrustedComputerUseWindowGoal,
  parseTrustedExactComputerUseGoal,
  type TrustedComputerUseWindowGoal,
} from './computer-use-goal';
import {
  parseTrustedComputerUseWorkflow,
  type TrustedComputerUseWorkflowGoal,
} from './computer-use-workflow';
import { computerWindowMatchesQuery } from '../modules/computer/window-query';
import { compileAgentContext, redactAgentContextValue } from './context-compiler';
import {
  AGENT_DECISION_SCHEMA_VERSION,
  AgentDecisionValidationError,
  parseAgentDecision,
  rebindAgentExecutableDecisionInput,
  type AgentDecision,
  type AgentExecutableDecision,
} from './decision-schema';
import {
  DEFAULT_AGENT_DECISION_TIMEOUT_MS,
  type AgentDecisionProvider,
  type AgentModelDecisionRequest,
  type AgentModelDecisionResponse,
} from './model-decision-provider';
import { AgentKernelExecutionAdapter, type AgentActionGatewayResult } from './kernel-execution-adapter';
import { normalizeAgentObservation } from './observation-normalizer';
import {
  inferAgentBlockingInput,
  inferOperationalGoalKind,
  isNonExecutingMutationDiscussion,
} from './goal-normalizer';
import {
  operationalRequirementInputMatches,
  operationalRequirementMatches,
  resolveAgentOperationalRequirements,
} from './operational-goal-binding';
import {
  currentAgentPlanStep,
  reconcileAgentPlanAfterVerifiedGoal,
  reviseAgentPlan,
  settleAgentPlanStep,
  startAgentPlanStep,
} from './plan-manager';
import { decideAgentRecovery } from './recovery-policy';
import { updateAgentCognitiveProfile } from './cognitive-profile';
import { advanceAgentWorkingState } from './working-state';
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
  AGENT_OBSERVATION_SCHEMA_VERSION,
  AGENT_TASK_SCHEMA_VERSION,
} from './types';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// One decision cycle includes the initial model response and one bounded repair
// response. Reserve a full provider timeout for each; otherwise a slow invalid
// first response leaves the repair path with only a few seconds and turns a
// recoverable formatting error into a terminal task failure.
export const DEFAULT_AGENT_DECISION_CYCLE_BUDGET_MS = (DEFAULT_AGENT_DECISION_TIMEOUT_MS * 2) + 10_000;

export interface AgentRunnerHeartbeatCadence {
  controlPollMs: number;
  leaseRenewMs: number;
}

export function agentRunnerHeartbeatCadence(claimTtlMsInput: number): AgentRunnerHeartbeatCadence {
  const claimTtlMs = Math.max(
    300,
    Math.min(Number.isFinite(claimTtlMsInput) ? Math.floor(claimTtlMsInput) : 5 * 60_000, 30 * 60_000),
  );
  return {
    // Same-process cancellation is forwarded immediately by parentSignal. This
    // poll keeps cross-process pause/cancel and ownership loss responsive
    // without rewriting the whole durable task document on every poll.
    controlPollMs: Math.max(100, Math.min(1_000, Math.floor(claimTtlMs / 6))),
    // A five-minute lease needs durable renewal, not two writes per second.
    // Keep two thirds of the lease as recovery margin and cap long leases at
    // 30 seconds so a suspended/stalled runner remains safely recoverable.
    leaseRenewMs: Math.max(100, Math.min(30_000, Math.floor(claimTtlMs / 3))),
  };
}

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
  decisionCycleBudgetMs?: number;
}

export class AgentLoop {
  private readonly claimTtlMs: number;
  private readonly decisionCycleBudgetMs: number;

  constructor(private readonly dependencies: AgentLoopDependencies) {
    this.claimTtlMs = Math.max(300, Math.min(dependencies.runnerClaimTtlMs || 5 * 60_000, 30 * 60_000));
    this.decisionCycleBudgetMs = normalizeDecisionCycleBudget(dependencies.decisionCycleBudgetMs);
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
        const requiredCapabilityIds = requiredCapabilitiesForTask(checkpoint);
        const resolver = resolveAgentCapabilities({
          goal: checkpoint.task.goal.normalizedObjective,
          requiredCapabilityIds,
          ...(checkpoint.task.toolDiscovery?.query
            ? { discoveryQuery: checkpoint.task.toolDiscovery.query }
            : {}),
          currentStep: currentStep?.title || '',
          recentObservationSummaries: checkpoint.observations.slice(-4).map((entry) => entry.summary),
          source: checkpoint.task.source.surface,
          capabilities,
          ...(moduleStates ? { moduleStates } : {}),
          runtimeAvailability,
          ...(availableCredentialRefs ? { availableCredentialRefs } : {}),
          permissionProfile: effectiveTaskPermissionProfile(
            checkpoint.task,
            this.dependencies.getPermissionProfile(),
          ),
        });
        checkpoint = (await this.save(checkpoint, checkpoint.task, [{
          type: 'resolver.completed',
          payload: jsonObject({
            candidates: resolver.diagnostics.included.slice(0, 16).map((entry) => ({
              capabilityId: entry.capabilityId,
              score: entry.score,
              reasons: entry.reasons,
              warnings: entry.warnings,
            })),
            candidateCount: resolver.diagnostics.included.length,
            excludedCount: resolver.diagnostics.excluded.length,
            excludedReasonCounts: Object.fromEntries(
              [...new Set(resolver.diagnostics.excluded.map((entry) => entry.reason))]
                .slice(0, 24)
                .map((reason) => [
                  reason,
                  resolver.diagnostics.excluded.filter((entry) => entry.reason === reason).length,
                ]),
            ),
            excluded: resolver.diagnostics.excluded.slice(0, 8),
            groups: resolver.groups,
            policy: resolver.diagnostics.policy,
          }),
        }])).checkpoint;
        if (resolver.capabilities.length === 0) {
          checkpoint = await this.failTask(checkpoint, 'runtime-unavailable', 'No available capabilities can advance this task.');
          return checkpoint.task;
        }

        const decisionCandidates = withoutImmediateComputerUseReadReplay(
          checkpoint,
          resolver.cards,
          resolver.capabilities,
        );
        const runtimeDecision = trustedApplicationOpenFailureDecision(
          checkpoint,
        ) || trustedApplicationSearchResultDecision(
          checkpoint,
        ) || trustedRequiredCapabilityDiscoveryDecision(
          checkpoint,
          requiredCapabilityIds,
          capabilities,
        ) || trustedBlockingInputDecision(
          checkpoint,
        ) || trustedMutationReconciliationDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedBoundedRetryDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedApplicationDiscoveryDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedWorkspaceKnownFolderPreludeDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedWorkspaceBatchStartDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedWorkspaceBatchContinuationDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedWorkspaceBatchSynthesisDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedGroundedSynthesisDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedOperationalSequenceContinuationDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedDirectOperationalRuntimeDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedComputerUseWorkflowRuntimeDecision(
          checkpoint,
          decisionCandidates.capabilities,
        ) || trustedComputerUseRuntimeDecision(
          checkpoint,
          decisionCandidates.capabilities,
        );
        if (runtimeDecision) {
          checkpoint = await this.handleDecision(
            checkpoint,
            runtimeDecision,
            resolver.capabilities,
            undefined,
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
          continue;
        }
        const oneShotComputerUseCandidates = trustedComputerUseEffectCandidates(
          checkpoint,
          decisionCandidates.cards,
          decisionCandidates.capabilities,
        );
        const modelDecisionCandidates = trustedComputerUseWorkflowEffectCandidates(
          checkpoint,
          oneShotComputerUseCandidates.cards,
          oneShotComputerUseCandidates.capabilities,
        );
        const decisionResult = await this.requestDecision(
          checkpoint,
          modelDecisionCandidates.cards,
          modelDecisionCandidates.capabilities,
          resolver.groups,
          signal,
          claimId,
        );
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
          const decisionBudgetExhausted = decisionResult.error === 'agent-decision-time-budget-exhausted';
          checkpoint = await this.failTask(
            checkpoint,
            signal.aborted
              ? 'cancelled-by-user'
              : decisionBudgetExhausted ? 'budget-exhausted' : 'unrecoverable-error',
            decisionBudgetExhausted
              ? 'Agent decision cycle exceeded its bounded time budget.'
              : decisionResult.error || 'Local model did not return a valid bounded decision.',
            decisionBudgetExhausted ? { exhaustedBy: 'decision-cycle' } : undefined,
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
        return (await this.cancelTask(latest, 'Задача остановлена после завершения активного шага.')).task;
      }
      if (abortKind(signal) === 'pause' || latest.task.pauseRequested || latest.task.status === 'paused') {
        return (await this.handleControl(latest, signal)).checkpoint.task;
      }
      if (signal.aborted) {
        return (await this.cancelTask(latest, 'Задача остановлена после завершения активного шага.')).task;
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
    capabilityGroups: ReturnType<typeof resolveAgentCapabilities>['groups'],
    signal: AbortSignal,
    claimId: string,
  ): Promise<{ checkpoint: AgentTaskCheckpoint; decision?: AgentDecision; model?: string; error?: string }> {
    let checkpoint = checkpointInput;
    let lastValidation: AgentDecisionValidationError | null = null;
    let lastInvalidDecision = '';
    const decisionDeadlineAt = Math.min(
      taskWallDeadline(checkpoint.task),
      Date.now() + this.decisionCycleBudgetMs,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const executionPhase = requiresModelFirstPlan(checkpoint.task) ? 'planning' as const : 'execution' as const;
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
          phase: executionPhase,
          candidateCapabilityIds: cards.map((card) => card.id),
          ...(checkpoint.task.decisionModelPolicy
            ? { requestedRole: checkpoint.task.decisionModelPolicy.requestedRole, selectionSource: 'user-explicit' }
            : {}),
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
        capabilityGroups,
        ...(checkpoint.task.cognitiveProfile ? { cognitiveProfile: checkpoint.task.cognitiveProfile } : {}),
        ...(checkpoint.task.workingState ? { workingState: checkpoint.task.workingState } : {}),
        ...(checkpoint.task.toolDiscovery ? { toolDiscovery: checkpoint.task.toolDiscovery } : {}),
        ...(checkpoint.task.executionProfile ? {
          executionProfile: {
            ...checkpoint.task.executionProfile,
            trust: 'runtime-owned',
            instructionsAllowed: false,
          },
        } : {}),
        budget: { limits: checkpoint.task.budgets, usage: checkpoint.task.usage },
        surface: checkpoint.task.source,
        executionPhase,
      });
      const modelStartedAt = Date.now();
      const remainingDecisionMs = Math.max(1, Math.floor(decisionDeadlineAt - modelStartedAt));
      const stage = await this.runClaimedStage(
        checkpoint.task.id,
        claimId,
        signal,
        taskWallDeadline(checkpoint.task),
        (stageSignal) => decideAgentModelWithinBudget(this.dependencies.decisionProvider, {
          taskId: checkpoint.task.id,
          traceId: checkpoint.task.traceId,
          compiledContext: compiled,
          capabilities: cards,
          ...(checkpoint.task.decisionModelPolicy
            ? { modelPolicy: checkpoint.task.decisionModelPolicy }
            : {}),
          ...(attempt === 1 && lastValidation ? {
            repair: {
              attempt: 1,
              code: lastValidation.code,
              errors: [lastValidation.message, ...lastValidation.details],
              ...(lastInvalidDecision ? { invalidDecision: lastInvalidDecision } : {}),
            },
          } : {}),
        }, stageSignal, remainingDecisionMs),
        true,
      );
      checkpoint = stage.checkpoint;
      const response = stage.value;
      const profiledTask: AgentTask = {
        ...checkpoint.task,
        cognitiveProfile: updateAgentCognitiveProfile(
          checkpoint.task.cognitiveProfile,
          response,
          nowIso(),
        ),
      };
      if (!response.ok || !response.rawText) {
        const safeError = sanitizeError(response.error || 'model-decision-failed');
        checkpoint = (await this.save(checkpoint, profiledTask, [{
          type: 'model.completed',
          payload: jsonObject({
            attempt: attempt + 1,
            repair: attempt === 1,
            phase: executionPhase,
            decisionSchemaVersion: AGENT_DECISION_SCHEMA_VERSION,
            ok: false,
            valid: false,
            error: safeError,
            durationMs: response.latencyMs ?? Date.now() - modelStartedAt,
            ...(response.role ? { role: boundedDiagnostic(response.role) } : {}),
            ...(response.model ? { model: boundedDiagnostic(response.model) } : {}),
            ...(response.adapter ? { adapter: boundedDiagnostic(response.adapter) } : {}),
            ...(response.degraded !== undefined ? { degraded: response.degraded } : {}),
            ...decisionTelemetry(response),
          }),
        }])).checkpoint;
        if (attempt === 0 && safeError === 'agent-decision-untrusted-context-copied') {
          // The provenance gate rejected executable input before it reached the
          // Kernel. Give the bounded repair path one chance to derive a fresh
          // input from the trusted original request; never persist or replay
          // the rejected model envelope itself.
          lastInvalidDecision = '';
          lastValidation = new AgentDecisionValidationError(
            safeError,
            'Executable input copied explicitly untrusted context. Rebuild it only from the original user request.',
          );
          continue;
        }
        return { checkpoint, error: safeError };
      }
      try {
        const serializedCandidates = Array.isArray(response.candidateCapabilityIds)
          ? capabilities.filter((entry) => response.candidateCapabilityIds!.includes(entry.id))
          : capabilities;
        const parsedDecision = parseAgentDecision(response.rawText, { candidates: serializedCandidates });
        const decision = bindRuntimeOwnedOperationalInput(checkpoint, parsedDecision, serializedCandidates);
        if (executionPhase === 'planning' && !isPlanningDecision(decision)) {
          throw new AgentDecisionValidationError(
            'model-plan-required',
            'This operational task requires a model-authored revise-plan decision before any capability can run.',
          );
        }
        assertPlanRevisionFollowsNewEvidence(checkpoint, decision, executionPhase);
        assertNoImmediateDuplicateInspection(checkpoint, decision, serializedCandidates);
        assertNoKnownFailedActionReplay(checkpoint, decision, serializedCandidates);
        assertNoRepeatedComputerUseTypeEffect(checkpoint, decision);
        assertFreshObservationAfterComputerUseFailure(checkpoint, decision);
        assertTrustedComputerUseWorkflowDecision(checkpoint, decision);
        assertOperationalDecisionTarget(checkpoint, decision, serializedCandidates);
        checkpoint = (await this.save(checkpoint, profiledTask, [{
          type: 'model.completed',
          payload: jsonObject({
            attempt: attempt + 1,
            repair: attempt === 1,
            phase: executionPhase,
            decisionSchemaVersion: AGENT_DECISION_SCHEMA_VERSION,
            ok: true,
            valid: true,
            decisionKind: decision.kind,
            durationMs: response.latencyMs ?? Date.now() - modelStartedAt,
            ...(response.role ? { role: boundedDiagnostic(response.role) } : {}),
            ...(response.model ? { model: boundedDiagnostic(response.model) } : {}),
            ...(response.adapter ? { adapter: boundedDiagnostic(response.adapter) } : {}),
            ...(response.degraded !== undefined ? { degraded: response.degraded } : {}),
            ...decisionTelemetry(response),
          }),
        }])).checkpoint;
        return {
          checkpoint,
          decision,
          ...(response.model || response.role ? { model: response.model || response.role } : {}),
        };
      } catch (error) {
        lastInvalidDecision = response.rawText;
        lastValidation = error instanceof AgentDecisionValidationError
          ? error
          : new AgentDecisionValidationError('invalid-decision', sanitizeError(error));
        checkpoint = (await this.save(checkpoint, profiledTask, [{
          type: 'model.completed',
          payload: jsonObject({
            attempt: attempt + 1,
            repair: attempt === 1,
            phase: executionPhase,
            decisionSchemaVersion: AGENT_DECISION_SCHEMA_VERSION,
            ok: true,
            valid: false,
            error: sanitizeError(lastValidation),
            validationCode: boundedDiagnostic(lastValidation.code),
            validationDetails: lastValidation.details.slice(0, 8).map((entry) => boundedDiagnostic(entry)),
            durationMs: response.latencyMs ?? Date.now() - modelStartedAt,
            ...(response.role ? { role: boundedDiagnostic(response.role) } : {}),
            ...(response.model ? { model: boundedDiagnostic(response.model) } : {}),
            ...(response.adapter ? { adapter: boundedDiagnostic(response.adapter) } : {}),
            ...(response.degraded !== undefined ? { degraded: response.degraded } : {}),
            ...decisionTelemetry(response),
          }),
        }])).checkpoint;
        const runtimeRecovery = trustedApplicationDiscoveryDecision(checkpoint, capabilities);
        if (runtimeRecovery) {
          return { checkpoint, decision: runtimeRecovery };
        }
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
    case 'discover-tools': {
      const previous = checkpoint.task.toolDiscovery;
      if (previous?.query.trim().toLocaleLowerCase('en-US') === decision.query.trim().toLocaleLowerCase('en-US')) {
        return this.failTask(
          checkpoint,
          'unrecoverable-error',
          'Tool discovery repeated the same query without producing a new candidate window.',
        );
      }
      const requestedAt = new Date().toISOString();
      return (await this.save(checkpoint, {
        ...checkpoint.task,
        toolDiscovery: {
          query: decision.query,
          reason: decision.reason,
          revision: (previous?.revision || 0) + 1,
          requestedAt,
        },
      }, [{
        type: 'resolver.discovery.requested',
        payload: jsonObject({
          query: decision.query,
          reason: decision.reason,
          revision: (previous?.revision || 0) + 1,
        }),
      }])).checkpoint;
    }
    case 'revise-plan': {
      const plan = checkpoint.task.plan
        ? reviseAgentPlan(checkpoint.task.plan, decision)
        : undefined;
      if (!plan) return this.failTask(checkpoint, 'unrecoverable-error', 'Task has no plan to revise.');
      const currentStepId = currentAgentPlanStep(plan)?.id;
      return (await this.save(checkpoint, withCurrentStep({
        ...checkpoint.task,
        plan,
      }, currentStepId), [{
        type: 'plan.revised',
        payload: jsonObject({
          revision: plan.revision,
          reason: decision.reason,
          summary: decision.summary,
          steps: decision.steps.map((step) => ({ title: step.title, expectedEffect: step.expectedEffect })),
        }),
      }])).checkpoint;
    }
    case 'complete':
      return this.completeTask(checkpoint, decision, {
        reconcileVerifiedPlan: isVerifiedTrustedComputerUseCompletion(checkpoint, decision),
      });
    case 'respond':
      return this.completeDirectResponse(checkpoint, decision.answer, model);
    case 'fail':
      return this.failTask(checkpoint, 'unrecoverable-error', `${decision.code}: ${decision.reason}`);
    case 'inspect':
    case 'act': {
      const capability = candidates.find((entry) => entry.id === decision.capabilityId);
      if (!capability) return this.failTask(checkpoint, 'unrecoverable-error', 'Selected capability left the resolver window.');
      const baseline = decision.kind === 'act'
        ? trustedMutationBaselineExecution(
            checkpoint,
            decision,
            capability,
            this.dependencies.listCapabilities(),
          )
        : null;
      if (baseline) {
        const afterBaseline = await this.executeDecision(
          checkpoint,
          baseline.decision,
          baseline.capability,
          model,
          signal,
          claimId,
          {
            runtimeOwned: true,
            runtimeBindingFactory: (output) => buildMutationBaselineRuntimeBinding(
              checkpoint,
              decision,
              baseline.descriptor,
              output,
            ),
          },
        );
        if (!findMutationBaselineObservation(afterBaseline, decision, baseline.descriptor)) {
          return afterBaseline;
        }
        return this.executeDecision(afterBaseline, decision, capability, model, signal, claimId);
      }
      return this.executeDecision(checkpoint, decision, capability, model, signal, claimId);
    }
    }
  }

  private async completeDirectResponse(
    checkpoint: AgentTaskCheckpoint,
    answer: string,
    model: string | undefined,
  ): Promise<AgentTaskCheckpoint> {
    const step = currentAgentPlanStep(checkpoint.task.plan, checkpoint.task.currentStepId);
    if (!step || !checkpoint.task.plan) {
      return this.failTask(checkpoint, 'unrecoverable-error', 'Direct response has no active durable plan step.');
    }
    const occurredAt = nowIso();
    const observationId = createMonarchId('observation');
    const evidence = {
      kind: 'runtime' as const,
      evidenceClass: 'model-generated' as const,
      reference: `model-decision:${checkpoint.task.id}:${observationId}`,
      summary: 'The decision model produced an ordinary answer; this receipt proves no current local state.',
    };
    const observation: AgentObservation = {
      schemaVersion: AGENT_OBSERVATION_SCHEMA_VERSION,
      id: observationId,
      taskId: checkpoint.task.id,
      stepId: step.id,
      capabilityId: 'models.agent.respond',
      status: 'success',
      summary: 'Local conversational answer composed in the decision turn.',
      structuredData: {
        output: {
          ok: true,
          rawText: answer,
          role: model || 'agent-decision-model',
          adapter: 'agent-decision-direct-response',
        },
        provenance: {
          source: 'agent-decision',
          currentLocalStateAuthority: false,
        },
      },
      evidence: [evidence],
      artifacts: [],
      warnings: [],
      retryable: false,
      occurredAt,
    };
    const startedPlan = step.status === 'running'
      ? checkpoint.task.plan
      : startAgentPlanStep(checkpoint.task.plan, step.id, 'models.agent.respond', occurredAt);
    const settledPlan = settleAgentPlanStep(startedPlan, step.id, {
      status: 'verified',
      summary: 'A non-operational model response was produced in the current decision turn.',
      evidence: [evidence],
      verifiedAt: occurredAt,
    }, occurredAt);
    const saved = (await this.save(checkpoint, {
      ...checkpoint.task,
      plan: settledPlan,
      observations: [...checkpoint.task.observations, observationReference(observation)],
    }, [
      ...(step.status === 'running' ? [] : [{
        type: 'step.started' as const,
        payload: jsonObject({ stepId: step.id, capabilityId: 'models.agent.respond', direct: true }),
      }]),
      {
        type: 'observation.created',
        payload: jsonObject({ observationId, status: 'success', source: 'agent-decision' }),
      },
    ], { observations: [observation] })).checkpoint;
    const bindings = [
      ...saved.task.goal.expectedOutputs
        .filter((entry) => entry.required !== false)
        .map((entry) => ({
          targetType: 'expected-output' as const,
          targetId: entry.id,
          observationIds: [observationId],
          artifactIds: [],
        })),
      ...saved.task.goal.successCriteria.map((entry) => ({
        targetType: 'success-criterion' as const,
        targetId: entry.id,
        observationIds: [observationId],
        artifactIds: [],
      })),
    ];
    return this.completeTask(saved, {
      kind: 'complete',
      summary: answer,
      evidenceObservationIds: [observationId],
      artifactIds: [],
      evidenceBindings: bindings,
    });
  }

  private async executeDecision(
    checkpointInput: AgentTaskCheckpoint,
    decision: AgentExecutableDecision,
    capability: MonarchCapability,
    model: string | undefined,
    signal: AbortSignal,
    claimId: string,
    options: {
      runtimeOwned?: boolean;
      runtimeBindingFactory?: (output: unknown) => AgentJsonObject | null;
    } = {},
  ): Promise<AgentTaskCheckpoint> {
    let checkpoint = checkpointInput;
    decision = bindRuntimeOwnedOperationalInput(checkpoint, decision, [capability]) as AgentExecutableDecision;
    let step = currentAgentPlanStep(checkpoint.task.plan, checkpoint.task.currentStepId);
    if (!step) {
      const plan = appendRecoveryStep(
        checkpoint.task.plan,
        capability.id,
        decision.expectedEffect || 'Continue toward verified completion.',
      );
      step = currentAgentPlanStep(plan);
      if (!plan || !step) return this.failTask(checkpoint, 'unrecoverable-error', 'No executable plan step exists.');
      checkpoint = (await this.save(checkpoint, withCurrentStep({
        ...checkpoint.task,
        plan,
      }, step.id), [{
        type: 'plan.revised',
        payload: jsonObject({ revision: plan.revision, reason: 'action-required-after-settled-plan' }),
      }])).checkpoint;
    }
    if (!checkpoint.task.plan) return this.failTask(checkpoint, 'unrecoverable-error', 'No executable plan exists.');
    if (decision.capabilityId === 'computer.window.observe') {
      // A fresh window capture is observationally different even when its
      // exact HWND is unchanged. Bind the current plan-step identity into the
      // proposal so the action ledger cannot replay an older screenshot/UIA
      // result during recovery or a later screenshot/action cycle.
      decision = {
        ...decision,
        input: { ...decision.input, captureNonce: step.id },
      };
    }
    const metadata = resolveAgentCapabilityMetadata(capability);
    decision = bindCapabilityOwnedVerification(decision, metadata.verification);
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
      ...(checkpoint.task.executionProfile ? {
        scope: {
          level: 'workspace',
          roots: [checkpoint.task.executionProfile.projectRoot],
        },
      } : {}),
        provenance: {
          source: options.runtimeOwned === true
            || isRuntimeOwnedKnownFolderDecision(checkpoint.task, decision)
            || isRuntimeOwnedWorkspaceKnownFolderPreludeDecision(checkpoint, decision)
            || isRuntimeOwnedWorkspaceBatchStartDecision(checkpoint, decision)
            || isRuntimeOwnedApplicationDiscoveryDecision(checkpoint, decision)
            || isRuntimeOwnedMutationReconciliationDecision(checkpoint, decision)
            || isRuntimeOwnedBoundedRetryDecision(checkpoint, decision)
            || isRuntimeOwnedExactWorkspaceWriteDecision(checkpoint, decision)
            || isRuntimeOwnedDirectOperationalDecision(checkpoint, decision)
            || isRuntimeOwnedWorkspaceBatchContinuationDecision(checkpoint, decision)
            || isRuntimeOwnedWorkspaceBatchSynthesisDecision(checkpoint, decision)
            || isRuntimeOwnedGroundedSynthesisDecision(checkpoint, decision)
            || isRuntimeOwnedComputerUseDecision(checkpoint, decision)
            || isRuntimeOwnedComputerUseWorkflowDecision(checkpoint, decision)
            ? 'runtime-grammar'
            : 'model-tool-call',
        ...(model ? { model } : {}),
        skillIds: [],
      },
    };
    const request = {
      proposal: proposalInput,
      originatingUserText: checkpoint.task.goal.originalRequest,
      requestedBy: `agent:${checkpoint.task.id}`,
      source: checkpoint.task.source.surface,
      ...(model ? { model } : {}),
      ...(checkpoint.task.activeLeaseId ? { leaseId: checkpoint.task.activeLeaseId } : {}),
      ...(checkpoint.task.executionProfile ? {
        permissionProfileOverride: effectiveTaskPermissionProfile(
          checkpoint.task,
          this.dependencies.getPermissionProfile(),
        ),
      } : {}),
      signal,
    };
    const proposal = await this.dependencies.executionAdapter.prepare(request);
    const actionAttemptId = createMonarchId('agent_action');
    const startedAt = nowIso();
    const plan = startAgentPlanStep(checkpoint.task.plan, step.id, capability.id, startedAt);
    const workingPhase = capability.id === 'models.agent.synthesize'
      ? 'synthesize' as const
      : metadata.effectProfile.mutation === 'none'
        ? 'inspect' as const
        : 'act' as const;
    const startedWorkingState = advanceAgentWorkingState(checkpoint.task.workingState, {
      phase: workingPhase,
      activeStepId: step.id,
      updatedAt: startedAt,
    });
    checkpoint = (await this.save(checkpoint, {
      ...checkpoint.task,
      plan,
      currentStepId: step.id,
      ...(startedWorkingState ? { workingState: startedWorkingState } : {}),
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
    if (requiresTaskBoundApproval(checkpoint.task, decision, capability)) {
      return this.waitForApproval(checkpoint, {
        proposal,
        result: {
          ok: false,
          error: 'confirmation-required',
          summary: 'This action is influenced by model-generated attachment evidence and requires an exact action-card.',
        },
      }, step.id, actionAttemptId, false);
    }
    checkpoint = (await this.save(checkpoint, {
      ...checkpoint.task,
      pendingAction: {
        ...checkpoint.task.pendingAction!,
        status: 'dispatched',
        dispatchedAt: nowIso(),
      },
    }, [{
      type: 'tool.started',
      payload: jsonObject({
        actionAttemptId,
        stepId: step.id,
        capabilityId: capability.id,
        decisionFingerprint: executableDecisionFingerprint(decision, agentActionIdentityRoot(checkpoint)),
        ...(computerUseEffectFingerprint(decision)
          ? { effectFingerprint: computerUseEffectFingerprint(decision) }
          : {}),
        proposalId: proposal.proposalId,
        activity: agentToolActivity(capability.id, decision.input),
      }),
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
    const recorded = await this.recordActionResult(
      checkpoint,
      decision,
      capability,
      result,
      step.id,
      actionAttemptId,
      startedAt,
      options.runtimeBindingFactory,
    );
    return (await this.handleControl(recorded, signal)).checkpoint;
  }

  private async waitForApproval(
    checkpoint: AgentTaskCheckpoint,
    result: AgentActionGatewayResult,
    stepId: string,
    actionAttemptId: string,
    toolAttempted = true,
  ): Promise<AgentTaskCheckpoint> {
    const approvalId = createMonarchId('agent_approval');
    const requestedAt = nowIso();
    const policy = approvalPolicyMetadata(result);
    const approval: AgentApproval = {
      schemaVersion: AGENT_APPROVAL_SCHEMA_VERSION,
      id: approvalId,
      taskId: checkpoint.task.id,
      stepId,
      capabilityId: result.proposal.capabilityId,
      canonicalProposalHash: result.proposal.canonicalHash,
      purpose: policy.purpose,
      ...(policy.policyDecisionHash ? { policyDecisionHash: policy.policyDecisionHash } : {}),
      ...(policy.authorityTierAtRequest ? { authorityTierAtRequest: policy.authorityTierAtRequest } : {}),
      proposal: jsonObject(result.proposal),
      status: 'pending',
      requestedAt,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
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
      ...(toolAttempted ? [{
        type: 'tool.completed' as const,
        payload: jsonObject({ actionAttemptId, ok: false, error: 'confirmation-required' }),
      }] : []),
      { type: 'approval.required', payload: jsonObject({
        approvalId,
        stepId,
        capabilityId: approval.capabilityId,
        canonicalProposalHash: approval.canonicalProposalHash,
        purpose: approval.purpose || 'policy',
        policyDecisionHash: approval.policyDecisionHash || null,
        authorityTierAtRequest: approval.authorityTierAtRequest || 'public',
      }) },
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
        taskId: checkpoint.task.id,
        approvalId: approval.id,
        originatingUserText: checkpoint.task.goal.originalRequest,
        requestedBy: `agent:${checkpoint.task.id}`,
        source: checkpoint.task.source.surface,
        grantScope: approval.grantScope || 'once',
        ...(approval.purpose ? { purpose: approval.purpose } : {}),
        ...(approval.policyDecisionHash ? { policyDecisionHash: approval.policyDecisionHash } : {}),
        ...(approval.authorityTierAtRequest ? { authorityTierAtRequest: approval.authorityTierAtRequest } : {}),
        ...(checkpoint.task.executionProfile ? {
          permissionProfileOverride: effectiveTaskPermissionProfile(
            checkpoint.task,
            this.dependencies.getPermissionProfile(),
          ),
        } : {}),
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
    runtimeBindingFactory?: (output: unknown) => AgentJsonObject | null,
  ): Promise<AgentTaskCheckpoint> {
    const completedAt = nowIso();
    const metadata = resolveAgentCapabilityMetadata(capability);
    const ledgerId = readNestedString(gateway.result.metadata, ['ledger', 'ledgerId']);
    const normalizedObservation = normalizeAgentObservation({
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
    const computerUseBinding = buildComputerUseRuntimeBinding(
      checkpoint,
      decision,
      gateway.result.output,
    );
    const runtimeBinding = runtimeBindingFactory?.(gateway.result.output)
      || computerUseBinding
      || buildWorkspaceInspectBatchRuntimeBinding(decision, gateway.result.output)
      || buildMutationReconciliationRuntimeBinding(checkpoint, decision, gateway.result.output)
      || buildGroundedSynthesisRuntimeBinding(checkpoint, decision, gateway.result.output);
    const verificationReceipt = buildKernelVerificationReceipt(
      gateway.result.metadata,
      decision.verification || [],
      gateway.proposal.canonicalHash,
    );
    const observation: AgentObservation = {
      ...normalizedObservation,
      structuredData: {
        ...(objectRecord(normalizedObservation.structuredData) || {}),
        ...(runtimeBinding ? { runtimeBinding: jsonObject(runtimeBinding) } : {}),
        verificationReceipt: jsonObject(verificationReceipt),
      },
    };
    const kernelVerified = gateway.result.ok
      && normalizedObservation.status === 'success'
      && verificationReceipt.exact;
    const artifacts = deriveVerifiedArtifacts(observation, decision, capability, kernelVerified);
    const enrichedObservation: AgentObservation = artifacts.length > 0
      ? { ...observation, artifacts: [...observation.artifacts, ...artifacts] }
      : observation;
    const evidence = enrichedObservation.evidence.map((entry) => entry.reference);
    const verificationResult = {
      status: normalizedObservation.status === 'success'
        && gateway.result.ok
        && (metadata.effectProfile.mutation === 'none' || kernelVerified)
        ? 'verified' as const
        : gateway.result.error === 'verification-failed' ? 'failed' as const : 'inconclusive' as const,
      summary: normalizedObservation.status === 'success'
        && gateway.result.ok
        && (metadata.effectProfile.mutation === 'none' || kernelVerified)
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
    const mutationTruth = observationMutationTruth(enrichedObservation);
    const reconciliationObservation = !meaningful
      && metadata.reconciliation
      && (mutationTruth === 'unknown' || mutationTruth === 'occurred')
      ? withRuntimeMutationReconciliationBinding(
        enrichedObservation,
        decision,
        metadata.reconciliation,
        gateway.proposal.canonicalHash,
        checkpoint,
      )
      : enrichedObservation;
    const persistedObservation = recovery.action === 'retry'
      ? withRuntimeRetryBinding(
        reconciliationObservation,
        decision,
        gateway.proposal.canonicalHash,
        checkpoint,
      )
      : reconciliationObservation;
    const observations = [...checkpoint.observations, persistedObservation];
    if (!gateway.result.ok && usage.consecutiveNoProgress === 0) {
      usage = recordAgentBudgetUsage(usage, { meaningfulProgress: false }, completedAt);
    }
    const recoveryCapabilityId = computerUseRecoveryCapabilityId(capability.id, gateway.result.output);
    const workflowRecoveryPlan = recoveryCapabilityId === 'computer.window.observe'
      && (recovery.action === 'replan' || recovery.action === 'retry')
      ? trustedComputerUseWorkflowRecoveryPlan(checkpoint.task, plan, stepId, recovery.reason)
      : undefined;
    const nextPlan = workflowRecoveryPlan || (
      recovery.action === 'replan' || recovery.action === 'retry'
        ? appendRecoveryStep(plan, recoveryCapabilityId || capability.id, recovery.reason, recovery.action === 'retry' ? attemptsForAction : 0)
        : plan
    );
    const nextWorkingStepId = nextPlan ? currentAgentPlanStep(nextPlan)?.id : undefined;
    const nextWorkingState = advanceAgentWorkingState(checkpoint.task.workingState, {
      phase: meaningful
        ? 'verify'
        : recovery.action === 'replan' || recovery.action === 'retry' || recovery.action === 'wait-runtime'
          ? 'recover'
          : 'decide',
      ...(nextWorkingStepId ? { activeStepId: nextWorkingStepId } : {}),
      observation: persistedObservation,
      actionFingerprint: executableDecisionFingerprint(decision, agentActionIdentityRoot(checkpoint)),
      capabilityId: capability.id,
      ...(gateway.result.error ? { error: gateway.result.error } : {}),
      verified: meaningful,
      updatedAt: completedAt,
    });
    const task: AgentTask = withCurrentStep(clearActionState({
      ...checkpoint.task,
      status: recovery.action === 'wait-runtime' ? 'waiting-for-runtime' : 'running',
      ...(nextPlan ? { plan: nextPlan } : {}),
      ...(nextWorkingState ? { workingState: nextWorkingState } : {}),
      observations: [...checkpoint.task.observations, observationReference(persistedObservation)],
      artifacts: mergeArtifacts(checkpoint.task.artifacts, artifacts),
      ...(gateway.lease?.status === 'active' ? { activeLeaseId: gateway.lease.leaseId } : {}),
      usage,
    }), nextPlan ? currentAgentPlanStep(nextPlan)?.id : undefined);
    const events: AgentTaskEventDraft[] = [
      { type: 'tool.completed', payload: jsonObject({ actionAttemptId, capabilityId: capability.id, ok: gateway.result.ok, error: gateway.result.error || null }) },
      { type: 'observation.created', payload: jsonObject({ observationId: persistedObservation.id, actionAttemptId, status: persistedObservation.status }) },
      { type: 'verification.completed', payload: jsonObject({ actionAttemptId, status: verificationResult.status, evidence }) },
      ...artifacts.map((artifact): AgentTaskEventDraft => ({ type: 'artifact.created', payload: jsonObject({ artifactId: artifact.id, kind: artifact.kind, reference: artifact.reference }) })),
      ...(recovery.action === 'replan' || recovery.action === 'retry'
        ? [{ type: 'plan.revised' as const, payload: jsonObject({ revision: nextPlan?.revision || 1, reason: recovery.reason }) }]
        : []),
    ];
    const saved = (await this.save(checkpoint, task, events, { observations })).checkpoint;
    if (meaningful && recovery.action === 'continue') {
      const completionDecision = buildVerifiedActionCompletionDecision(
        saved,
        enrichedObservation,
        artifacts,
        this.dependencies.listCapabilities().some((entry) => entry.id === 'models.agent.synthesize'),
      );
      if (completionDecision && !blocksTrustedComputerUseWorkflowAutoCompletion(saved, enrichedObservation)) {
        return this.completeTask(saved, completionDecision, {
          reconcileVerifiedPlan: metadata.effectProfile.mutation !== 'none'
            || observationProvesVerifiedGoalMutation(saved, enrichedObservation),
        });
      }
    }
    return saved;
  }

  private async completeTask(
    checkpoint: AgentTaskCheckpoint,
    decision: Extract<AgentDecision, { kind: 'complete' }>,
    options: { reconcileVerifiedPlan?: boolean } = {},
  ): Promise<AgentTaskCheckpoint> {
    const canonicalDecision = canonicalizeCompletionEvidence(checkpoint, decision);
    const groundedSummary = plainAgentResponseCompletionSummary(checkpoint, canonicalDecision)
      || groundedSynthesisCompletionSummary(checkpoint, canonicalDecision)
      || groundedAnswerCompletionSummary(checkpoint, canonicalDecision);
    const verificationDecision = groundedSummary
      ? { ...canonicalDecision, summary: groundedSummary }
      : canonicalDecision;
    const verifications: AgentVerificationRecord[] = [];
    const declaredObservationIds = new Set(decision.evidenceObservationIds);
    const declaredArtifactIds = new Set(decision.artifactIds);
    for (const output of checkpoint.task.goal.expectedOutputs) {
      if (output.required === false) continue;
      verifications.push(buildBoundGoalVerification(
        checkpoint,
        verificationDecision,
        'expected-output',
        output.id,
        output.kind,
        output.description,
        declaredObservationIds,
        declaredArtifactIds,
      ));
    }
    for (const criterion of checkpoint.task.goal.successCriteria) {
      verifications.push(buildBoundGoalVerification(
        checkpoint,
        verificationDecision,
        'success-criterion',
        criterion.id,
        undefined,
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
      const strongEvidence = observation?.evidence.filter((entry) => (
        entry.evidenceClass === 'kernel-verification' && /:verification:/i.test(entry.reference)
      )) || [];
      verifications.push({
        id: createMonarchId('agent_verification'), targetType: 'action', targetId: action.actionAttemptId,
        status: action.executionStatus === 'success' && strongEvidence.length > 0 ? 'verified' : 'failed',
        method: 'kernel-predicate', summary: observation?.summary || 'Missing action observation.',
        evidenceIds: strongEvidence.map((entry) => entry.reference),
      });
    }
    const verifiedCompletion = verifyAgentCompletion({
      expectedOutputs: checkpoint.task.goal.expectedOutputs,
      successCriteria: checkpoint.task.goal.successCriteria,
      actions,
      verifications,
    });
    const operationalBlocker = !agentOperationalRequirementsSatisfied(checkpoint)
      ? 'Completion is blocked until every runtime-owned operational requirement has matching Kernel evidence.'
      : null;
    const originalPlanBlocker = agentPlanCompletionBlocker(checkpoint.task.plan);
    const shouldReconcilePlan = options.reconcileVerifiedPlan === true
      && verifiedCompletion.complete
      && operationalBlocker === null
      && originalPlanBlocker !== null
      && checkpoint.task.plan !== undefined;
    const effectivePlan = shouldReconcilePlan
      ? reconcileAgentPlanAfterVerifiedGoal(checkpoint.task.plan!, nowIso())
      : checkpoint.task.plan;
    const planBlocker = agentPlanCompletionBlocker(effectivePlan) || operationalBlocker;
    const completion = planBlocker
      ? {
        ...verifiedCompletion,
        complete: false,
        status: verifiedCompletion.status === 'failed' ? 'failed' as const : 'incomplete' as const,
        summary: planBlocker,
        missing: [...new Set([...verifiedCompletion.missing, 'plan:required-steps-incomplete'])],
      }
      : verifiedCompletion;
    if (!completion.complete) {
      const plan = planBlocker
        ? checkpoint.task.plan
        : appendRecoveryStep(checkpoint.task.plan, 'completion-verifier', completion.summary);
      const currentStepId = plan ? currentAgentPlanStep(plan)?.id : undefined;
      const recoveryWorkingState = advanceAgentWorkingState(checkpoint.task.workingState, {
        phase: 'recover',
        ...(currentStepId ? { activeStepId: currentStepId } : {}),
        updatedAt: nowIso(),
      });
      return (await this.save(checkpoint, withCurrentStep({
        ...checkpoint.task,
        ...(plan ? { plan } : {}),
        ...(recoveryWorkingState ? { workingState: recoveryWorkingState } : {}),
        usage: recordAgentBudgetUsage(checkpoint.task.usage, { failures: 1, meaningfulProgress: false }),
      }, currentStepId), [
        {
          type: 'verification.completed',
          payload: jsonObject({
            status: completion.status,
            missing: completion.missing,
            failed: completion.failed,
            records: verifications.map((entry) => ({
              targetType: entry.targetType,
              targetId: entry.targetId,
              status: entry.status,
              summary: entry.summary,
            })),
          }),
        },
        ...(!planBlocker && plan
          ? [{ type: 'plan.revised' as const, payload: jsonObject({ revision: plan.revision, reason: completion.summary }) }]
          : []),
      ])).checkpoint;
    }
    const completedAt = nowIso();
    const completionSummary = groundedSummary || decision.summary;
    const completedWorkingState = advanceAgentWorkingState(checkpoint.task.workingState, {
      phase: 'complete',
      verified: true,
      updatedAt: completedAt,
    });
    return (await this.save(checkpoint, withCurrentStep(clearActionState({
      ...checkpoint.task,
      ...(effectivePlan ? { plan: effectivePlan } : {}),
      ...(completedWorkingState ? { workingState: completedWorkingState } : {}),
      status: 'completed',
      completedAt,
      terminalReason: { code: 'completed', summary: completionSummary },
      messages: appendMessage(checkpoint.task, 'assistant', 'result', completionSummary),
    }), undefined), [
      ...(shouldReconcilePlan ? [{
        type: 'plan.revised' as const,
        payload: jsonObject({
          revision: effectivePlan?.revision || checkpoint.task.plan?.revision || 1,
          reason: 'goal-verified-runtime-reconciliation',
          skippedStepIds: effectivePlan?.steps
            .filter((step) => step.status === 'skipped' && checkpoint.task.plan?.steps.some((before) => (
              before.id === step.id && before.status !== 'skipped'
            )))
            .map((step) => step.id) || [],
        }),
      }] : []),
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

    const cadence = agentRunnerHeartbeatCadence(this.claimTtlMs);
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
      if (active && !lost) timer = setTimeout(tick, cadence.controlPollMs);
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
        const runnerClaim = current.task.runnerClaim;
        if (!runnerClaim) {
          markLost('Agent runner claim disappeared during an active stage.');
          return;
        }
        const renewedAt = Date.parse(runnerClaim.renewedAt);
        const expiresAt = Date.parse(runnerClaim.expiresAt);
        const now = Date.now();
        const renewalDue = !Number.isFinite(renewedAt)
          || !Number.isFinite(expiresAt)
          || now - renewedAt >= cadence.leaseRenewMs
          || expiresAt - now <= cadence.leaseRenewMs;
        if (!renewalDue) return;
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

function isVerifiedTrustedComputerUseCompletion(
  checkpoint: AgentTaskCheckpoint,
  decision: Extract<AgentDecision, { kind: 'complete' }>,
): boolean {
  const goal = parseTrustedComputerUseWindowGoal(checkpoint.task.goal.originalRequest);
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  const oneShotPlan = Boolean(goal && checkpoint.task.plan && isTrustedComputerUseRuntimePlan(checkpoint.task.plan));
  const workflowPlan = Boolean(workflow && checkpoint.task.plan && isTrustedComputerUseWorkflowPlan(checkpoint.task.plan, workflow));
  if (!oneShotPlan && !workflowPlan) return false;
  return decision.evidenceObservationIds.some((id) => {
    const observation = checkpoint.observations.find((entry) => entry.id === id);
    const binding = objectRecord(objectRecord(observation?.structuredData)?.runtimeBinding);
    return observation?.status === 'success'
      && (
        (oneShotPlan && binding?.kind === 'computer-window-close')
        || (workflowPlan && binding?.kind === 'computer-window-text-verification')
      )
      && binding.exactReceipt === true
      && binding.safeAutoCompletion === true;
  });
}

function requiresModelFirstPlan(task: AgentTask): boolean {
  return task.planningMode === 'model-first' && (task.plan?.revision || 1) <= 1;
}

function requiredCapabilitiesForTask(checkpoint: AgentTaskCheckpoint): string[] {
  const task = checkpoint.task;
  const operationalCapabilityIds = resolveAgentOperationalRequirements(task.goal.originalRequest)
    .map((entry) => entry.capabilityId);
  const reconciliationCapabilityIds = checkpoint.observations.flatMap((observation) => {
    const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeReconciliationBinding);
    return typeof binding?.capabilityId === 'string' ? [binding.capabilityId] : [];
  });
  const requiredOutputs = task.goal.expectedOutputs.filter((output) => output.required !== false);
  if (requiredOutputs.length === 0 || requiredOutputs.some((output) => output.kind !== 'answer')) {
    return [...new Set([...operationalCapabilityIds, ...reconciliationCapabilityIds])];
  }
  if (requestRequiresWorkspaceBatchSynthesis(task.goal.originalRequest) && requestedBatchKnownFolder(task.goal.originalRequest)) {
    return [...new Set([
      ...reconciliationCapabilityIds,
      ...operationalCapabilityIds,
      'workspace.known-folder.resolve',
      'workspace.files.inspect-batch',
      'models.agent.synthesize',
    ])];
  }
  return [...new Set([
    ...operationalCapabilityIds,
    ...reconciliationCapabilityIds,
    requestRequiresKernelObservation(task.goal.originalRequest)
    ? 'models.agent.synthesize'
    : 'models.agent.respond',
  ])];
}

const TRUSTED_DIRECT_OPERATIONAL_PLAN_SUMMARY = 'Execute one exact runtime-owned operation derived from the original user request.';
const TRUSTED_DIRECT_OPERATIONAL_STEP = 'Complete the exact requested local operation.';

function trustedRequiredCapabilityDiscoveryDecision(
  checkpoint: AgentTaskCheckpoint,
  requiredCapabilityIds: readonly string[],
  availableCapabilities: readonly MonarchCapability[],
): AgentDecision | null {
  if (checkpoint.task.toolDiscovery || requiredCapabilityIds.length === 0) return null;
  const availableIds = new Set(availableCapabilities.map((entry) => entry.id));
  // Response/synthesis capabilities are runtime plumbing, not user tools. A
  // fixture or reduced provider may complete with explicit evidence without
  // registering them, so only missing executable/inspectable tools trigger a
  // discovery window here.
  const missing = requiredCapabilityIds.filter((id) => (
    !id.startsWith('models.agent.') && !availableIds.has(id)
  ));
  if (missing.length === 0) return null;
  return {
    kind: 'discover-tools',
    query: [...new Set(missing.flatMap((id) => [id, id.split('.')[0] || id]))].join(' '),
    reason: 'A capability required by the typed goal contract is not registered in the current provider window.',
  };
}

function trustedBlockingInputDecision(checkpoint: AgentTaskCheckpoint): AgentDecision | null {
  if (checkpoint.task.messages.some((entry) => entry.role === 'user' && entry.kind === 'clarification')) {
    return null;
  }
  const missing = inferAgentBlockingInput(checkpoint.task.goal.originalRequest);
  return missing ? {
    kind: 'ask-user',
    question: missing.question,
    reason: missing.reason,
  } : null;
}

function trustedApplicationOpenFailureDecision(checkpoint: AgentTaskCheckpoint): AgentDecision | null {
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  const requirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  const appRequirement = requirements.find((entry) => entry.capabilityId === 'device.app.open');
  const requestedApp = typeof appRequirement?.input.app === 'string'
    ? appRequirement.input.app
    : workflow?.application || '';
  if (!requestedApp) return null;
  const latest = [...checkpoint.observations].reverse().find((observation) => {
    if (observation.capabilityId !== 'device.app.open') return false;
    const output = objectRecord(observationOutput(observation));
    return typeof output?.app === 'string' && output.app === requestedApp;
  });
  if (!latest || latest.status === 'success') return null;
  const output = objectRecord(observationOutput(latest)) || {};
  const error = typeof output.error === 'string' ? output.error : '';
  const candidateNames = Array.isArray(output.candidates)
    ? output.candidates.map((entry) => {
      const record = objectRecord(entry);
      return typeof entry === 'string'
        ? boundedDiagnostic(entry)
        : typeof record?.name === 'string'
          ? boundedDiagnostic(record.name)
          : '';
    }).filter(Boolean).slice(0, 5)
    : [];
  if (error === 'app-ambiguous') {
    const suffix = candidateNames.length ? `: ${candidateNames.join(', ')}` : '';
    return {
      kind: 'ask-user',
      question: `Нашёл несколько одинаково подходящих приложений${suffix}. Напиши точное название нужного — ничего не запускалось.`,
      reason: 'The trusted Windows catalog produced an ambiguous application resolution and must not be guessed by the model.',
    };
  }
  if (error === 'app-not-found') {
    const suffix = candidateNames.length ? ` Ближайшие варианты: ${candidateNames.join(', ')}.` : '';
    return {
      kind: 'ask-user',
      question: `Не нашёл установленное приложение по названию «${boundedDiagnostic(requestedApp)}».${suffix} Уточни его точное имя — ничего не запускалось.`,
      reason: 'The complete trusted Windows application catalog did not produce one safe launch target.',
    };
  }
  if (error === 'app-catalog-unavailable') {
    return {
      kind: 'ask-user',
      question: 'Windows не вернул каталог установленных приложений. Ничего не запускалось; повтори задачу после перезапуска Проводника или системы.',
      reason: 'The trusted Windows application catalog was unavailable, so neither the runtime nor the model may guess a launch target.',
    };
  }
  if (error === 'app-open-unverified' || error === 'app-launch-rejected') {
    return {
      kind: 'ask-user',
      question: `Windows не подтвердил видимое окно «${boundedDiagnostic(requestedApp)}». Неподтверждённый запуск не считается выполненным; уточни, появилось ли приложение или оно осталось в трее.`,
      reason: 'An exact launch was dispatched or rejected without a verified application window, so completion must remain unresolved.',
    };
  }
  return null;
}

function trustedApplicationDiscoveryDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  if (
    !applicationDiscoveryRecoveryTriggered(checkpoint)
    || !capabilities.some((entry) => entry.id === 'device.apps.search')
    || checkpoint.observations.some((entry) => entry.capabilityId === 'device.apps.search')
  ) return null;
  const requirement = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest)
    .find((entry) => entry.capabilityId === 'device.app.open');
  const requestedApp = typeof requirement?.input.app === 'string'
    ? requirement.input.app.trim()
    : '';
  if (!requestedApp) return null;
  return {
    kind: 'inspect',
    capabilityId: 'device.apps.search',
    input: { query: requestedApp, limit: 5 },
    reason: 'runtime-owned-application-discovery',
    expectedEffect: 'Inspect the trusted installed-application catalog after model-requested tool discovery.',
  };
}

function trustedMutationReconciliationDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  const sourceObservation = [...checkpoint.observations].reverse().find((observation) => {
    const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeReconciliationBinding);
    if (binding?.schemaVersion !== 1 || binding.kind !== 'mutation-postcondition-reconciliation') return false;
    return !checkpoint.observations.some((candidate) => {
      const result = objectRecord(objectRecord(candidate.structuredData)?.runtimeBinding);
      return result?.kind === 'mutation-postcondition-reconciliation'
        && result.sourceObservationId === observation.id;
    });
  });
  if (!sourceObservation) return null;
  const binding = objectRecord(objectRecord(sourceObservation.structuredData)?.runtimeReconciliationBinding);
  const capabilityId = typeof binding?.capabilityId === 'string' ? binding.capabilityId : '';
  const input = objectRecord(binding?.input);
  const capability = capabilities.find((entry) => entry.id === capabilityId);
  if (!binding || !input || !capability) return null;
  const metadata = resolveAgentCapabilityMetadata(capability);
  if (metadata.effectProfile.mutation !== 'none' || metadata.idempotency !== 'idempotent') return null;
  const canonicalInputHash = canonicalProposalHash(canonicalizeActionIdentityArgs(
    input,
    agentActionIdentityRoot(checkpoint),
  ));
  if (
    binding.inputCanonicalHash !== canonicalInputHash
    || binding.sourceObservationId !== sourceObservation.id
    || typeof binding.reconciliationSpecHash !== 'string'
  ) return null;
  return rebindAgentExecutableDecisionInput({
    kind: 'inspect',
    capabilityId,
    input,
    reason: 'runtime-owned-mutation-reconciliation',
    expectedEffect: 'Read the exact target once to reconcile an indeterminate mutation outcome before any repeat.',
  }, capability, input);
}

function trustedMutationBaselineExecution(
  checkpoint: AgentTaskCheckpoint,
  sourceDecision: AgentExecutableDecision,
  sourceCapability: MonarchCapability,
  capabilities: readonly MonarchCapability[],
): {
  decision: AgentExecutableDecision;
  capability: MonarchCapability;
  descriptor: NonNullable<ReturnType<typeof resolveAgentCapabilityMetadata>['reconciliation']>;
} | null {
  const descriptor = resolveAgentCapabilityMetadata(sourceCapability).reconciliation;
  if (!descriptor?.requiresPreActionBaseline) return null;
  if (findMutationBaselineObservation(checkpoint, sourceDecision, descriptor)) return null;
  const capability = capabilities.find((entry) => entry.id === descriptor.capabilityId);
  if (!capability) return null;
  const metadata = resolveAgentCapabilityMetadata(capability);
  if (metadata.effectProfile.mutation !== 'none' || metadata.idempotency !== 'idempotent') return null;
  const input = buildMutationReconciliationInput(sourceDecision.input, descriptor);
  if (!input) return null;
  const decision = rebindAgentExecutableDecisionInput({
    kind: 'inspect',
    capabilityId: capability.id,
    input,
    reason: 'runtime-owned-mutation-baseline',
    expectedEffect: 'Capture the exact pre-action target state required to verify a non-idempotent transition.',
  }, capability, input);
  return { decision, capability, descriptor };
}

function buildMutationReconciliationInput(
  sourceInputValue: Record<string, unknown>,
  descriptor: NonNullable<ReturnType<typeof resolveAgentCapabilityMetadata>['reconciliation']>,
): Record<string, unknown> | null {
  const sourceInput = jsonObject(sourceInputValue);
  const input: Record<string, unknown> = { ...(descriptor.constantInput || {}) };
  for (const [targetKey, sourceKey] of Object.entries(descriptor.inputBindings)) {
    if (!Object.prototype.hasOwnProperty.call(sourceInput, sourceKey)) return null;
    input[targetKey] = sourceInput[sourceKey];
  }
  return input;
}

function findMutationBaselineObservation(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  descriptor: NonNullable<ReturnType<typeof resolveAgentCapabilityMetadata>['reconciliation']>,
): AgentObservation | null {
  if (!descriptor.requiresPreActionBaseline) return null;
  const fingerprint = executableDecisionFingerprint(decision, agentActionIdentityRoot(checkpoint));
  const specHash = canonicalProposalHash(descriptor);
  for (let index = checkpoint.observations.length - 1; index >= 0; index -= 1) {
    const observation = checkpoint.observations[index];
    if (!observation || observation.status !== 'success') continue;
    const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeBinding);
    if (
      binding?.schemaVersion !== 1
      || binding.kind !== 'mutation-precondition-baseline'
      || binding.sourceCapabilityId !== decision.capabilityId
      || binding.sourceDecisionFingerprint !== fingerprint
      || binding.reconciliationSpecHash !== specHash
      || binding.exactTarget !== true
    ) continue;
    if (checkpoint.observations.slice(index + 1).some((entry) => entry.capabilityId === decision.capabilityId)) {
      return null;
    }
    return observation;
  }
  return null;
}

function trustedBoundedRetryDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  const observation = checkpoint.observations.at(-1);
  if (!observation || observation.status === 'success' || !observation.retryable) return null;
  const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeRetryBinding);
  const input = objectRecord(binding?.input);
  const capabilityId = typeof binding?.capabilityId === 'string' ? binding.capabilityId : '';
  const capability = capabilities.find((entry) => entry.id === capabilityId);
  if (
    binding?.schemaVersion !== 1
    || binding.kind !== 'bounded-idempotent-observation-retry'
    || binding.sourceObservationId !== observation.id
    || binding.remainingAttempts !== 1
    || !input
    || !capability
  ) return null;
  const metadata = resolveAgentCapabilityMetadata(capability);
  if (metadata.idempotency !== 'idempotent' || metadata.effectProfile.mutation !== 'none') return null;
  const inputHash = canonicalProposalHash(canonicalizeActionIdentityArgs(input, agentActionIdentityRoot(checkpoint)));
  if (binding.inputCanonicalHash !== inputHash) return null;
  return rebindAgentExecutableDecisionInput({
    kind: 'inspect',
    capabilityId,
    input,
    reason: 'runtime-owned-bounded-retry',
    expectedEffect: 'Repeat the exact idempotent observation once after a retryable failure.',
  }, capability, input);
}

function withRuntimeRetryBinding(
  observation: AgentObservation,
  decision: AgentExecutableDecision,
  proposalCanonicalHash: string,
  checkpoint: AgentTaskCheckpoint,
): AgentObservation {
  const input = jsonObject(decision.input);
  return {
    ...observation,
    structuredData: {
      ...(objectRecord(observation.structuredData) || {}),
      runtimeRetryBinding: jsonObject({
        schemaVersion: 1,
        kind: 'bounded-idempotent-observation-retry',
        sourceObservationId: observation.id,
        capabilityId: decision.capabilityId,
        input,
        inputCanonicalHash: canonicalProposalHash(canonicalizeActionIdentityArgs(input, agentActionIdentityRoot(checkpoint))),
        proposalCanonicalHash,
        remainingAttempts: 1,
      }),
    },
  };
}

function withRuntimeMutationReconciliationBinding(
  observation: AgentObservation,
  decision: AgentExecutableDecision,
  descriptor: NonNullable<ReturnType<typeof resolveAgentCapabilityMetadata>['reconciliation']>,
  proposalCanonicalHash: string,
  checkpoint: AgentTaskCheckpoint,
): AgentObservation {
  const sourceInput = jsonObject(decision.input);
  const reconciliationInput = buildMutationReconciliationInput(sourceInput, descriptor);
  if (!reconciliationInput) return observation;
  const targetSourceKey = descriptor.inputBindings[descriptor.targetInputKey];
  const sourceTarget = targetSourceKey ? sourceInput[targetSourceKey] : undefined;
  const expectedValue = sourceInput[descriptor.assertion.sourceInputKey];
  if (typeof sourceTarget !== 'string' || !sourceTarget.trim() || expectedValue === undefined) return observation;
  const baselineObservation = descriptor.requiresPreActionBaseline
    ? findMutationBaselineObservation(checkpoint, decision, descriptor)
    : null;
  if (descriptor.requiresPreActionBaseline && !baselineObservation) return observation;
  const baselineBinding = objectRecord(objectRecord(baselineObservation?.structuredData)?.runtimeBinding);
  const input = jsonObject(reconciliationInput);
  return {
    ...observation,
    structuredData: {
      ...(objectRecord(observation.structuredData) || {}),
      runtimeReconciliationBinding: jsonObject({
        schemaVersion: 1,
        kind: 'mutation-postcondition-reconciliation',
        sourceObservationId: observation.id,
        sourceActionAttemptId: observationActionAttemptId(observation),
        sourceCapabilityId: decision.capabilityId,
        sourceProposalCanonicalHash: proposalCanonicalHash,
        sourceDecisionFingerprint: executableDecisionFingerprint(decision, agentActionIdentityRoot(checkpoint)),
        sourceTarget,
        sourceInput,
        capabilityId: descriptor.capabilityId,
        input,
        inputCanonicalHash: canonicalProposalHash(canonicalizeActionIdentityArgs(
          input,
          agentActionIdentityRoot(checkpoint),
        )),
        reconciliationSpecHash: canonicalProposalHash(descriptor),
        descriptor: jsonObject(descriptor),
        ...(baselineObservation && typeof baselineBinding?.baselineValueSha256 === 'string' ? {
          baselineObservationId: baselineObservation.id,
          baselineValueSha256: baselineBinding.baselineValueSha256,
        } : {}),
      }),
    },
  };
}

function applicationDiscoveryRecoveryTriggered(checkpoint: AgentTaskCheckpoint): boolean {
  if (checkpoint.task.toolDiscovery) return true;
  const latestModelEvent = [...checkpoint.events].reverse().find((entry) => entry.type === 'model.completed');
  return latestModelEvent?.payload?.valid === false
    && latestModelEvent.payload?.validationCode === 'operational-target-mismatch';
}

function trustedApplicationSearchResultDecision(checkpoint: AgentTaskCheckpoint): AgentDecision | null {
  const requirement = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest)
    .find((entry) => entry.capabilityId === 'device.app.open');
  const requestedApp = typeof requirement?.input.app === 'string'
    ? requirement.input.app.trim()
    : '';
  if (!requestedApp) return null;
  const observation = [...checkpoint.observations].reverse().find((entry) => (
    entry.capabilityId === 'device.apps.search' && entry.status === 'success'
  ));
  if (!observation) return null;
  const output = objectRecord(observationOutput(observation));
  if (!output || normalizeLiteralFact(String(output.query || '')) !== normalizeLiteralFact(requestedApp)) return null;
  const matches = Array.isArray(output.matches) ? output.matches.map(objectRecord).filter(Boolean) : [];
  if (matches.length === 1) return null;
  const names = matches.flatMap((entry) => {
    const name = typeof entry?.displayName === 'string'
      ? entry.displayName
      : typeof entry?.name === 'string' ? entry.name : '';
    return name ? [boundedDiagnostic(name)] : [];
  }).slice(0, 5);
  if (matches.length === 0) {
    return {
      kind: 'ask-user',
      question: `Не нашёл установленное приложение по запросу «${boundedDiagnostic(requestedApp)}». Уточни точное название — ничего не запускалось.`,
      reason: 'Trusted application discovery returned no installed match.',
    };
  }
  return {
    kind: 'ask-user',
    question: `Нашёл несколько подходящих приложений${names.length ? `: ${names.join(', ')}` : ''}. Напиши точное название нужного — ничего не запускалось.`,
    reason: 'Trusted application discovery remained ambiguous and the model may not guess the launch target.',
  };
}

function trustedWorkspaceKnownFolderPreludeDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  const knownFolder = requestedBatchKnownFolder(checkpoint.task.goal.originalRequest);
  if (
    !knownFolder
    || !requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
    || !capabilities.some((entry) => entry.id === 'workspace.known-folder.resolve')
    || checkpoint.observations.some((entry) => entry.capabilityId === 'workspace.known-folder.resolve')
  ) return null;
  return {
    kind: 'inspect',
    capabilityId: 'workspace.known-folder.resolve',
    input: { knownFolder },
    reason: 'runtime-owned-known-folder-prelude',
    expectedEffect: 'Resolve and policy-check the exact current Windows known-folder path before paginated inspection.',
  };
}

function trustedWorkspaceBatchStartDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  const knownFolder = requestedBatchKnownFolder(checkpoint.task.goal.originalRequest);
  if (
    !knownFolder
    || !requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
    || !capabilities.some((entry) => entry.id === 'workspace.files.inspect-batch')
    || checkpoint.observations.some((entry) => entry.capabilityId === 'workspace.files.inspect-batch')
  ) return null;
  const resolution = [...checkpoint.observations].reverse().find((observation) => {
    if (observation.capabilityId !== 'workspace.known-folder.resolve' || observation.status !== 'success') return false;
    const output = objectRecord(objectRecord(observation.structuredData)?.output);
    return output?.knownFolder === knownFolder
      && output.exists === true
      && output.directory === true;
  });
  if (!resolution) return null;
  return {
    kind: 'inspect',
    capabilityId: 'workspace.files.inspect-batch',
    input: { knownFolder },
    reason: 'runtime-owned-pagination-start',
    expectedEffect: 'Inspect the first deterministic page of the trusted known folder without copying tool output into executable input.',
  };
}

function trustedWorkspaceBatchContinuationDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  if (!capabilities.some((entry) => entry.id === 'workspace.files.inspect-batch')) return null;
  const latest = [...checkpoint.observations].reverse().find((observation) => (
    observation.capabilityId === 'workspace.files.inspect-batch'
    && (observation.status === 'success' || observation.status === 'partial')
  ));
  const binding = objectRecord(objectRecord(latest?.structuredData)?.runtimeBinding);
  const continuationInput = objectRecord(binding?.continuationInput);
  if (
    binding?.kind !== 'workspace-files-inspect-batch'
    || binding.exactReceipt !== true
    || binding.complete !== false
    || !continuationInput
    || typeof continuationInput.cursor !== 'string'
    || !continuationInput.cursor
  ) return null;
  return {
    kind: 'inspect',
    capabilityId: 'workspace.files.inspect-batch',
    input: { ...continuationInput },
    reason: 'runtime-owned-pagination-continuation',
    expectedEffect: 'Inspect the next freshness-bound page until the batch reports complete coverage.',
  };
}

function trustedWorkspaceBatchSynthesisDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  if (
    !requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
    || !capabilities.some((entry) => entry.id === 'models.agent.synthesize')
    || checkpoint.observations.some((entry) => entry.capabilityId === 'models.agent.synthesize')
  ) return null;
  const pages = checkpoint.observations.filter((observation) => (
    observation.capabilityId === 'workspace.files.inspect-batch'
    && (observation.status === 'success' || observation.status === 'partial')
  ));
  if (pages.length === 0 || pages.length > 128) return null;
  const bindings = pages.map((observation) => (
    objectRecord(objectRecord(observation.structuredData)?.runtimeBinding)
  ));
  const last = bindings.at(-1);
  const root = typeof last?.root === 'string' ? last.root : '';
  const snapshotId = typeof last?.snapshotId === 'string' ? last.snapshotId : '';
  if (
    last?.kind !== 'workspace-files-inspect-batch'
    || last.exactReceipt !== true
    || last.complete !== true
    || !root
    || !snapshotId
    || bindings.some((binding) => (
      binding?.kind !== 'workspace-files-inspect-batch'
      || binding.exactReceipt !== true
      || binding.root !== root
      || binding.snapshotId !== snapshotId
    ))
  ) return null;
  return {
    kind: 'inspect',
    capabilityId: 'models.agent.synthesize',
    input: { observationIds: pages.map((entry) => entry.id) },
    reason: 'runtime-owned-grounded-batch-synthesis',
    expectedEffect: 'Generate one user-facing summary bound to every page in the complete batch snapshot.',
  };
}

function trustedGroundedSynthesisDecision(
  checkpoint: AgentTaskCheckpoint,
  capabilities: readonly MonarchCapability[],
): AgentDecision | null {
  if (!capabilities.some((entry) => entry.id === 'models.agent.synthesize')) return null;
  const observationIds = groundedSynthesisObservationIds(checkpoint);
  if (observationIds.length === 0) return null;
  return {
    kind: 'inspect',
    capabilityId: 'models.agent.synthesize',
    input: { observationIds },
    reason: 'runtime-owned-grounded-synthesis',
    expectedEffect: 'Generate one user-facing answer bound only to the exact successful Kernel observations.',
  };
}

function groundedSynthesisObservationIds(checkpoint: AgentTaskCheckpoint): string[] {
  if (
    requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
    || checkpoint.observations.some((entry) => entry.capabilityId === 'models.agent.synthesize')
    || !agentOperationalRequirementsSatisfied(checkpoint)
  ) return [];
  const requiredOutputs = checkpoint.task.goal.expectedOutputs.filter((entry) => entry.required !== false);
  const requiredAnswers = requiredOutputs.filter((entry) => entry.kind === 'answer');
  if (requiredAnswers.length === 0) return [];
  const sources = checkpoint.observations.filter((entry) => (
    entry.status === 'success'
    && entry.capabilityId !== 'models.agent.respond'
    && entry.capabilityId !== 'models.agent.synthesize'
    && hasKernelEvidence(entry)
  ));
  if (sources.length === 0) return [];
  const selected = new Set<string>();
  for (const output of requiredOutputs) {
    const matches = sources.filter((entry) => observationMatchesGoalTarget(
      checkpoint,
      'expected-output',
      output.description,
      entry,
    ));
    if (
      matches.length === 0
      || !observationsCoverEveryResourceAnchor(checkpoint, output.description, matches)
    ) return [];
    matches.forEach((entry) => selected.add(entry.id));
  }
  for (const criterion of checkpoint.task.goal.successCriteria) {
    const matches = sources.filter((entry) => observationMatchesVerificationTarget(
      checkpoint,
      'success-criterion',
      criterion.description,
      entry,
    ));
    if (
      matches.length === 0
      || !observationsCoverEveryResourceAnchor(checkpoint, criterion.description, matches)
    ) return [];
    matches.forEach((entry) => selected.add(entry.id));
  }
  return sources.filter((entry) => selected.has(entry.id)).map((entry) => entry.id);
}

function trustedDirectOperationalRuntimeDecision(
  checkpoint: AgentTaskCheckpoint,
  candidates: readonly MonarchCapability[],
): AgentDecision | null {
  const task = checkpoint.task;
  const requirements = resolveAgentOperationalRequirements(task.goal.originalRequest);
  if (requirements.length !== 1) return null;
  const requirement = requirements[0]!;
  const capability = candidates.find((entry) => entry.id === requirement.capabilityId);
  if (!capability) return null;

  const matchingObservation = [...checkpoint.observations].reverse().find((observation) => (
    observation.status === 'success'
    && operationalRequirementMatches(
      requirement,
      observation.capabilityId,
      observationOutput(observation),
    )
    && (!requirement.effectful || observationProvesVerifiedMutation(observation))
  ));
  if (matchingObservation) {
    const observationIds = [matchingObservation.id];
    const artifactIds = matchingObservation.artifacts.map((artifact) => artifact.id);
    const outputBindings = task.goal.expectedOutputs
      .filter((entry) => entry.required !== false)
      .map((entry) => observationMatchesGoalTarget(
        checkpoint,
        'expected-output',
        entry.description,
        matchingObservation,
      ) && (!requiresVerifiedMutation(entry.kind) || observationProvesVerifiedGoalMutation(checkpoint, matchingObservation))
        ? {
            targetType: 'expected-output' as const,
            targetId: entry.id,
            observationIds,
            artifactIds,
          }
        : null);
    const criterionBindings = task.goal.successCriteria.map((entry) => (
      observationMatchesVerificationTarget(
        checkpoint,
        'success-criterion',
        entry.description,
        matchingObservation,
      ) ? {
        targetType: 'success-criterion' as const,
        targetId: entry.id,
        observationIds,
        artifactIds,
      } : null
    ));
    if ([...outputBindings, ...criterionBindings].some((entry) => entry === null)) return null;
    return {
      kind: 'complete',
      summary: matchingObservation.summary,
      evidenceObservationIds: observationIds,
      artifactIds,
      evidenceBindings: [...outputBindings, ...criterionBindings]
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    };
  }

  // Adaptive atomic tasks deliberately let the model choose the capability on
  // the first turn. Once the exact Kernel observation exists, the runtime may
  // complete it above without paying for another model turn. The legacy
  // model-first profile still receives its explicit one-step plan here.
  if (task.planningMode !== 'model-first' || !task.plan) return null;
  if (task.plan.revision <= 1) {
    return {
      kind: 'revise-plan',
      summary: TRUSTED_DIRECT_OPERATIONAL_PLAN_SUMMARY,
      reason: 'The runtime compiled one schema-valid operation from the trusted original request.',
      steps: [{
        title: TRUSTED_DIRECT_OPERATIONAL_STEP,
        expectedEffect: requirement.effectful
          ? 'Kernel verifies the exact requested state change.'
          : 'Kernel returns the exact requested factual observation.',
      }],
    };
  }
  if (!isTrustedDirectOperationalRuntimePlan(task.plan)) return null;

  const attempted = checkpoint.observations.some((observation) => (
    observation.capabilityId === requirement.capabilityId
  ));
  if (attempted) return null;
  const mutating = resolveAgentCapabilityMetadata(capability).effectProfile.mutation !== 'none';
  return {
    kind: mutating ? 'act' : 'inspect',
    capabilityId: requirement.capabilityId,
    input: { ...requirement.input },
    reason: 'Use only the exact schema-valid input compiled from the trusted original request.',
    expectedEffect: requirement.effectful
      ? 'Kernel verifies the exact requested state change.'
      : 'Kernel returns the exact requested factual observation.',
  };
}

function trustedOperationalSequenceContinuationDecision(
  checkpoint: AgentTaskCheckpoint,
  candidates: readonly MonarchCapability[],
): AgentDecision | null {
  const requirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  if (requirements.length < 2) return null;
  const satisfied = requirements.map((requirement) => (
    operationalRequirementIsSatisfied(checkpoint, requirement)
  ));
  const nextIndex = satisfied.findIndex((entry) => !entry);
  if (nextIndex <= 0 || !satisfied.slice(0, nextIndex).every(Boolean)) return null;
  const requirement = requirements[nextIndex]!;
  // Do not silently retry a failed action or disambiguate repeated uses of the
  // same capability. Only continue an ordered sequence whose prior, distinct
  // clauses have exact Kernel evidence.
  if (
    requirements.slice(0, nextIndex).some((entry) => entry.capabilityId === requirement.capabilityId)
    || checkpoint.observations.some((entry) => entry.capabilityId === requirement.capabilityId)
  ) return null;
  const capability = candidates.find((entry) => entry.id === requirement.capabilityId);
  if (!capability) return null;
  const mutating = resolveAgentCapabilityMetadata(capability).effectProfile.mutation !== 'none';
  return {
    kind: mutating ? 'act' : 'inspect',
    capabilityId: requirement.capabilityId,
    input: { ...requirement.input },
    reason: 'Continue the next exact ordered clause compiled from the trusted original request.',
    expectedEffect: requirement.effectful
      ? 'Kernel verifies the next exact requested state change.'
      : 'Kernel returns the next exact requested factual observation.',
  };
}

function isTrustedDirectOperationalRuntimePlan(plan: AgentPlan): boolean {
  const activeSteps = plan.steps.filter((step) => step.status !== 'skipped');
  return plan.goalSummary === TRUSTED_DIRECT_OPERATIONAL_PLAN_SUMMARY
    && activeSteps.length === 1
    && activeSteps[0]?.title === TRUSTED_DIRECT_OPERATIONAL_STEP;
}

const TRUSTED_COMPUTER_USE_WORKFLOW_PLAN_SUMMARY = 'Open one trusted application, bind one exact window, then repeat screenshot-bound input atoms until a runtime-verifiable postcondition is observed.';
const TRUSTED_COMPUTER_USE_WORKFLOW_LAUNCH_STEP = 'Launch the exact application named in the Computer Use request.';
const TRUSTED_COMPUTER_USE_WORKFLOW_RESOLVE_STEP = 'Resolve exactly one window owned by the launched application.';
const TRUSTED_COMPUTER_USE_WORKFLOW_OBSERVE_STEP = 'Capture a fresh workflow observation of the exact application window.';
const TRUSTED_COMPUTER_USE_WORKFLOW_INTERACT_STEP = 'Perform one screenshot-bound Computer Use input atom toward the requested objective.';
const TRUSTED_COMPUTER_USE_WORKFLOW_VERIFY_STEP = 'Verify the trusted exact text postcondition in the latest fresh observation.';
const TRUSTED_COMPUTER_USE_WORKFLOW_KEY_PREFIX = 'Dispatch trusted calculator key';
const TRUSTED_COMPUTER_USE_WORKFLOW_MAX_RESOLUTION_ATTEMPTS = 4;
const TRUSTED_COMPUTER_USE_WORKFLOW_MAX_INTERACTION_CYCLES = 8;
const TRUSTED_COMPUTER_USE_WORKFLOW_MAX_FINAL_VERIFY_ATTEMPTS = 3;

function trustedComputerUseWorkflowRuntimeDecision(
  checkpoint: AgentTaskCheckpoint,
  candidates: readonly MonarchCapability[],
): AgentDecision | null {
  const task = checkpoint.task;
  const workflow = parseTrustedComputerUseWorkflow(task.goal.originalRequest);
  if (!workflow || task.planningMode !== 'model-first' || !task.plan) return null;
  if (!workflow.expectedText) {
    if (workflowRequiresExactCommunicationDetails(workflow)) {
      return {
        kind: 'ask-user',
        question: 'Укажи точное название чата или получателя и точный текст сообщения в кавычках. Без этого Oscar не будет угадывать адресата или содержание.',
        reason: 'A communication workflow needs an exact user-authored recipient and message before any application action is allowed.',
      };
    }
    return null;
  }
  const candidateIds = new Set(candidates.map((entry) => entry.id));
  const applicationQuery = trustedComputerUseWorkflowApplicationQuery(checkpoint, workflow);

  if (task.plan.revision <= 1) {
    if (!candidateIds.has('device.app.open')) return null;
    return {
      kind: 'revise-plan',
      summary: TRUSTED_COMPUTER_USE_WORKFLOW_PLAN_SUMMARY,
      reason: 'Runtime compiled the application, exact trusted inputs, bounded action cycles, and final postcondition from the explicit Computer Use request.',
      steps: trustedComputerUseWorkflowSteps(workflow, 'full'),
    };
  }
  if (!isTrustedComputerUseWorkflowPlan(task.plan, workflow)) return null;

  const matched = trustedComputerUseWorkflowMatchedObservation(checkpoint, workflow);
  if (matched) return trustedComputerUseCompletion(task, matched);

  const step = currentAgentPlanStep(task.plan, task.currentStepId);
  if (!step) {
    const verificationAttempts = checkpoint.observations.filter((entry) => (
      entry.capabilityId === 'computer.window.verify-text'
      && objectRecord(objectRecord(entry.structuredData)?.output)?.expectedText === workflow.expectedText
    )).length;
    if (workflow.kind === 'calculator') {
      if (verificationAttempts >= TRUSTED_COMPUTER_USE_WORKFLOW_MAX_FINAL_VERIFY_ATTEMPTS) {
        return {
          kind: 'fail',
          code: 'computer-use-postcondition-not-observed',
          reason: `Calculator input receipts succeeded, but the exact result ${JSON.stringify(workflow.expectedText)} was not visible after ${verificationAttempts} fresh checks.`,
        };
      }
      return {
        kind: 'revise-plan',
        summary: TRUSTED_COMPUTER_USE_WORKFLOW_PLAN_SUMMARY,
        reason: 'The final calculator result was not yet visible; capture a fresh observation and verify again without repeating the input sequence.',
        steps: trustedComputerUseWorkflowSteps(workflow, 'reverify'),
      };
    }

    const cycles = trustedComputerUseWorkflowInteractionCycleCount(task.plan);
    if (cycles >= TRUSTED_COMPUTER_USE_WORKFLOW_MAX_INTERACTION_CYCLES) {
      return {
        kind: 'ask-user',
        question: `Не удалось надежно подтвердить результат после ${cycles} действий в ${workflow.application}. Уточни текущий экран или следующий шаг — неподтвержденное действие завершенным не считается.`,
        reason: 'The bounded screenshot/action loop reached its interaction limit without the trusted exact postcondition.',
      };
    }
    return {
      kind: 'revise-plan',
      summary: TRUSTED_COMPUTER_USE_WORKFLOW_PLAN_SUMMARY,
      reason: 'The trusted postcondition is not visible yet; continue with one more screenshot-bound action atom, then verify again.',
      steps: trustedComputerUseWorkflowSteps(workflow, 'continue'),
    };
  }

  if (step.title === TRUSTED_COMPUTER_USE_WORKFLOW_LAUNCH_STEP) {
    if (!candidateIds.has('device.app.open')) return null;
    return {
      kind: 'act',
      capabilityId: 'device.app.open',
      input: { app: workflow.application },
      reason: 'Launch only the normalized application compiled from the trusted Computer Use request.',
      expectedEffect: 'Kernel verifies that Windows accepted the exact application launch target.',
    };
  }

  if (step.title === TRUSTED_COMPUTER_USE_WORKFLOW_RESOLVE_STEP) {
    if (!candidateIds.has('computer.windows.list')) return null;
    return {
      kind: 'inspect',
      capabilityId: 'computer.windows.list',
      input: { titleQuery: applicationQuery, limit: 1 },
      reason: 'Resolve the topmost matching window created or raised by the immediately preceding authoritative application launch.',
      expectedEffect: 'Kernel returns at most one topmost opaque window reference for the application launched in this workflow.',
    };
  }

  const resolution = trustedComputerUseWorkflowWindowResolution(checkpoint, workflow);
  if (step.title === TRUSTED_COMPUTER_USE_WORKFLOW_OBSERVE_STEP) {
    if (resolution.status === 'missing') {
      const attempts = trustedComputerUseWorkflowResolutionAttemptCount(checkpoint, workflow);
      if (attempts >= TRUSTED_COMPUTER_USE_WORKFLOW_MAX_RESOLUTION_ATTEMPTS) {
        return {
          kind: 'ask-user',
          question: `Windows принял запуск ${workflow.application}, но его окно так и не появилось. Проверь, не скрыто ли приложение в трее, и повтори задачу.`,
          reason: 'The launched application did not expose a controllable top-level window after bounded native enumeration retries.',
        };
      }
      return {
        kind: 'revise-plan',
        summary: TRUSTED_COMPUTER_USE_WORKFLOW_PLAN_SUMMARY,
        reason: 'The application may still be starting; retry exact window resolution without launching a duplicate process.',
        steps: trustedComputerUseWorkflowSteps(workflow, 'resolve-retry'),
      };
    }
    if (resolution.status === 'ambiguous') {
      return {
        kind: 'ask-user',
        question: `Найдено несколько окон ${workflow.application}. Уточни нужное окно — Oscar не будет выбирать наугад.`,
        reason: 'Multiple windows matched the trusted application query.',
      };
    }
    if (resolution.status !== 'unique') {
      return {
        kind: 'fail',
        code: 'computer-use-workflow-window-invalid',
        reason: 'The native window list did not preserve the exact trusted application binding.',
      };
    }
    if (!candidateIds.has('computer.window.observe')) return null;
    return {
      kind: 'inspect',
      capabilityId: 'computer.window.observe',
      input: { windowRef: resolution.windowRef, captureNonce: step.id },
      reason: 'Capture a fresh screenshot and UI Automation tree for the uniquely resolved application window.',
      expectedEffect: 'Kernel returns one fresh observation bound to the exact opaque window reference.',
    };
  }

  if (resolution.status !== 'unique') {
    return {
      kind: 'fail',
      code: 'computer-use-workflow-window-lost',
      reason: 'The exact application window binding was lost before the next Computer Use cycle.',
    };
  }
  const latest = trustedComputerUseWorkflowLatestObservation(checkpoint, resolution.windowRef);
  if (!latest) {
    return {
      kind: 'fail',
      code: 'computer-use-workflow-observation-missing',
      reason: 'No fresh exact-window observation is available for the next one-shot action.',
    };
  }

  const calculatorKeyIndex = trustedComputerUseWorkflowCalculatorKeyIndex(step.title);
  if (calculatorKeyIndex >= 0 && workflow.calculation) {
    const key = workflow.calculation.keySequence[calculatorKeyIndex];
    if (!key) {
      return { kind: 'fail', code: 'computer-use-calculator-plan-invalid', reason: 'The calculator key plan no longer matches the trusted expression compiler.' };
    }
    if (!candidateIds.has('computer.window.key')) return null;
    return {
      kind: 'act',
      capabilityId: 'computer.window.key',
      input: { windowRef: resolution.windowRef, observationId: latest.observationId, key, modifiers: [] },
      reason: `Dispatch calculator key atom ${calculatorKeyIndex + 1} of ${workflow.calculation.keySequence.length} from the trusted expression compiler.`,
      expectedEffect: 'Kernel verifies this one key and captures a new exact-window observation before the next atom.',
    };
  }

  if (step.title === TRUSTED_COMPUTER_USE_WORKFLOW_VERIFY_STEP) {
    if (!candidateIds.has('computer.window.verify-text')) return null;
    return {
      kind: 'inspect',
      capabilityId: 'computer.window.verify-text',
      input: {
        windowRef: resolution.windowRef,
        observationId: latest.observationId,
        expectedText: workflow.expectedText,
      },
      reason: 'Verify only the exact postcondition compiled from the trusted original request.',
      expectedEffect: 'Kernel checks the trusted text against the latest exact UI Automation observation without changing Windows state.',
    };
  }

  // The interactive step intentionally belongs to the model: it chooses one
  // semantic/visual target from the latest screenshot, while runtime and
  // Kernel constrain the exact window, observation, trusted text, and action.
  return null;
}

function trustedComputerUseWorkflowSteps(
  workflow: TrustedComputerUseWorkflowGoal,
  phase: 'full' | 'resolve-retry' | 'continue' | 'reverify',
): Array<{ title: string; expectedEffect: string }> {
  const steps: Array<{ title: string; expectedEffect: string }> = [];
  if (phase === 'full') {
    steps.push({
      title: TRUSTED_COMPUTER_USE_WORKFLOW_LAUNCH_STEP,
      expectedEffect: `Windows accepts the exact normalized application target ${JSON.stringify(workflow.application)}.`,
    });
  }
  if (phase === 'full' || phase === 'resolve-retry') {
    steps.push({
      title: TRUSTED_COMPUTER_USE_WORKFLOW_RESOLVE_STEP,
      expectedEffect: 'Exactly one opaque top-level window reference matches the launched application.',
    });
  }
  if (phase !== 'continue') {
    steps.push({
      title: TRUSTED_COMPUTER_USE_WORKFLOW_OBSERVE_STEP,
      expectedEffect: 'A fresh screenshot and UI Automation tree are bound to that exact application window.',
    });
  }
  if ((phase === 'full' || phase === 'resolve-retry') && workflow.calculation) {
    workflow.calculation.keySequence.forEach((_key, index) => {
      steps.push({
        title: `${TRUSTED_COMPUTER_USE_WORKFLOW_KEY_PREFIX} ${index + 1}/${workflow.calculation!.keySequence.length}.`,
        expectedEffect: 'Exactly one trusted calculator key is dispatched and followed by a new native observation.',
      });
    });
  } else if (workflow.kind === 'interactive' && phase !== 'reverify') {
    steps.push({
      title: TRUSTED_COMPUTER_USE_WORKFLOW_INTERACT_STEP,
      expectedEffect: 'One model-selected input atom is bound to the latest exact screenshot and receives a native read-after-action receipt.',
    });
  }
  steps.push({
    title: TRUSTED_COMPUTER_USE_WORKFLOW_VERIFY_STEP,
    expectedEffect: `The latest exact-window observation contains the trusted postcondition ${JSON.stringify(workflow.expectedText)}.`,
  });
  return steps;
}

function trustedComputerUseWorkflowRecoveryPlan(
  task: AgentTask,
  plan: AgentPlan | undefined,
  failedStepId: string,
  reason: string,
): AgentPlan | undefined {
  const workflow = parseTrustedComputerUseWorkflow(task.goal.originalRequest);
  if (!workflow || !plan || !isTrustedComputerUseWorkflowPlan(plan, workflow)) return undefined;
  const failedStep = plan.steps.find((step) => step.id === failedStepId);
  if (!failedStep) return undefined;
  const steps: Array<{ title: string; expectedEffect: string }> = [{
    title: TRUSTED_COMPUTER_USE_WORKFLOW_OBSERVE_STEP,
    expectedEffect: 'Capture a new exact-window observation because the previous one-shot authority was consumed without a verified dispatch.',
  }];
  const failedKeyIndex = trustedComputerUseWorkflowCalculatorKeyIndex(failedStep.title);
  if (workflow.calculation && failedKeyIndex >= 0) {
    for (let index = failedKeyIndex; index < workflow.calculation.keySequence.length; index += 1) {
      steps.push({
        title: `${TRUSTED_COMPUTER_USE_WORKFLOW_KEY_PREFIX} ${index + 1}/${workflow.calculation.keySequence.length}.`,
        expectedEffect: 'Exactly one remaining trusted calculator key is dispatched and followed by a new native observation.',
      });
    }
  } else if (workflow.kind === 'interactive') {
    steps.push({
      title: TRUSTED_COMPUTER_USE_WORKFLOW_INTERACT_STEP,
      expectedEffect: 'Retry one model-selected action only after a new exact screenshot and UI Automation receipt.',
    });
  } else {
    return undefined;
  }
  steps.push({
    title: TRUSTED_COMPUTER_USE_WORKFLOW_VERIFY_STEP,
    expectedEffect: `The latest exact-window observation contains the trusted postcondition ${JSON.stringify(workflow.expectedText)}.`,
  });
  return reviseAgentPlan(plan, {
    kind: 'revise-plan',
    summary: TRUSTED_COMPUTER_USE_WORKFLOW_PLAN_SUMMARY,
    reason: `Computer Use recovered fail-closed from a consumed one-shot observation: ${reason}`,
    steps,
  });
}

function isTrustedComputerUseWorkflowPlan(plan: AgentPlan, workflow: TrustedComputerUseWorkflowGoal): boolean {
  if (plan.goalSummary !== TRUSTED_COMPUTER_USE_WORKFLOW_PLAN_SUMMARY) return false;
  const titles = plan.steps.map((step) => step.title);
  if (!titles.includes(TRUSTED_COMPUTER_USE_WORKFLOW_LAUNCH_STEP)) return false;
  if (!titles.includes(TRUSTED_COMPUTER_USE_WORKFLOW_RESOLVE_STEP)) return false;
  if (!titles.includes(TRUSTED_COMPUTER_USE_WORKFLOW_OBSERVE_STEP)) return false;
  if (!titles.includes(TRUSTED_COMPUTER_USE_WORKFLOW_VERIFY_STEP)) return false;
  if (workflow.calculation) {
    return workflow.calculation.keySequence.every((_key, index) => (
      titles.includes(`${TRUSTED_COMPUTER_USE_WORKFLOW_KEY_PREFIX} ${index + 1}/${workflow.calculation!.keySequence.length}.`)
    ));
  }
  return titles.includes(TRUSTED_COMPUTER_USE_WORKFLOW_INTERACT_STEP);
}

type TrustedComputerUseWorkflowWindowResolution =
  | { status: 'absent' | 'missing' | 'ambiguous' | 'invalid' }
  | { status: 'unique'; windowRef: string };

function trustedComputerUseWorkflowApplicationQuery(
  checkpoint: AgentTaskCheckpoint,
  workflow: TrustedComputerUseWorkflowGoal,
): string {
  const launch = [...checkpoint.observations].reverse().find((entry) => {
    if (entry.capabilityId !== 'device.app.open' || entry.status !== 'success') return false;
    const output = objectRecord(observationOutput(entry));
    return output?.opened === true && output.verified === true && output.app === workflow.application;
  });
  if (!launch) return workflow.applicationQuery;
  const output = objectRecord(observationOutput(launch)) || {};
  const resolved = String(output.resolvedName || output.displayName || '')
    .replace(/[\u0000-\u001F\u007F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
  return resolved && /^[\p{L}\p{N} ._+&()-]+$/u.test(resolved)
    ? resolved
    : workflow.applicationQuery;
}

function trustedComputerUseWorkflowWindowResolution(
  checkpoint: AgentTaskCheckpoint,
  workflow: TrustedComputerUseWorkflowGoal,
): TrustedComputerUseWorkflowWindowResolution {
  const applicationQuery = trustedComputerUseWorkflowApplicationQuery(checkpoint, workflow);
  const observation = [...checkpoint.observations].reverse().find((entry) => {
    if (entry.capabilityId !== 'computer.windows.list' || entry.status !== 'success') return false;
    const output = objectRecord(objectRecord(entry.structuredData)?.output);
    return output?.titleQuery === applicationQuery;
  });
  if (!observation) return { status: 'absent' };
  const output = objectRecord(objectRecord(observation.structuredData)?.output);
  if (output?.verified !== true || output.titleQuery !== applicationQuery || !Array.isArray(output.windows)) {
    return { status: 'invalid' };
  }
  if (output.windows.length === 0) return { status: 'missing' };
  if (output.windows.length !== 1) return { status: 'ambiguous' };
  const window = objectRecord(output.windows[0]);
  const windowRef = typeof window?.windowRef === 'string' ? window.windowRef : '';
  const title = typeof window?.title === 'string' ? window.title : '';
  const processName = typeof window?.processName === 'string' ? window.processName : '';
  return windowRef && computerWindowMatchesQuery({ title, processName }, applicationQuery)
    ? { status: 'unique', windowRef }
    : { status: 'invalid' };
}

function trustedComputerUseWorkflowLatestObservation(
  checkpoint: AgentTaskCheckpoint,
  windowRef: string,
): { observationId: string; windowRef: string } | null {
  for (let index = checkpoint.observations.length - 1; index >= 0; index -= 1) {
    const observation = checkpoint.observations[index];
    if (observation?.status !== 'success') continue;
    const output = objectRecord(objectRecord(observation.structuredData)?.output);
    const candidates = [
      output,
      objectRecord(output?.after),
      output?.afterObservationId && output.windowRef
        ? { ...objectRecord(output.after), observationId: output.afterObservationId, windowRef: output.windowRef }
        : null,
    ];
    for (const candidate of candidates) {
      const record = objectRecord(candidate);
      if (record?.windowRef === windowRef && typeof record.observationId === 'string') {
        return { windowRef, observationId: record.observationId };
      }
    }
  }
  return null;
}

function trustedComputerUseWorkflowObservationOutput(
  checkpoint: AgentTaskCheckpoint,
  windowRef: string,
  observationId: string,
): Record<string, unknown> | null {
  let fallback: Record<string, unknown> | null = null;
  for (let index = checkpoint.observations.length - 1; index >= 0; index -= 1) {
    const observation = checkpoint.observations[index];
    if (observation?.status !== 'success') continue;
    const output = objectRecord(objectRecord(observation.structuredData)?.output);
    const candidates = [
      output,
      objectRecord(output?.after),
      output?.afterObservationId && output.windowRef
        ? { ...objectRecord(output.after), observationId: output.afterObservationId, windowRef: output.windowRef }
        : null,
    ];
    for (const candidate of candidates) {
      const record = objectRecord(candidate);
      if (record?.windowRef !== windowRef || record.observationId !== observationId) continue;
      if (Array.isArray(record.elements)) return record;
      fallback ||= record;
    }
  }
  return fallback;
}

function trustedComputerUseCommunicationDispatchObserved(
  checkpoint: AgentTaskCheckpoint,
  workflow: TrustedComputerUseWorkflowGoal,
): boolean {
  let trustedMessageTyped = false;
  for (const observation of checkpoint.observations) {
    if (observation.status !== 'success') continue;
    const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeBinding);
    if (
      binding?.kind !== 'computer-window-workflow-action'
      || binding.exactReceipt !== true
    ) continue;
    if (
      binding.capabilityId === 'computer.window.type'
      && binding.typedExpectedText === true
      && binding.communicationField === true
      && typeof binding.effectValueSha256 === 'string'
      && binding.effectValueSha256 === sha256Text(workflow.expectedText || '')
    ) {
      trustedMessageTyped = true;
      continue;
    }
    if (trustedMessageTyped && binding.communicationDispatch === true) return true;
  }
  return false;
}

function trustedComputerUseWorkflowMatchedObservation(
  checkpoint: AgentTaskCheckpoint,
  workflow: TrustedComputerUseWorkflowGoal,
): AgentObservation | null {
  return [...checkpoint.observations].reverse().find((entry) => {
    if (entry.capabilityId !== 'computer.window.verify-text' || entry.status !== 'success') return false;
    const output = objectRecord(objectRecord(entry.structuredData)?.output);
    const binding = objectRecord(objectRecord(entry.structuredData)?.runtimeBinding);
    return output?.expectedText === workflow.expectedText
      && output?.verified === true
      && output?.matched === true
      && binding?.kind === 'computer-window-text-verification'
      && binding.exactReceipt === true;
  }) || null;
}

function trustedComputerUseWorkflowCalculatorKeyIndex(title: string): number {
  const match = title.match(new RegExp(`^${TRUSTED_COMPUTER_USE_WORKFLOW_KEY_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} (\\d+)\\/(\\d+)\\.$`, 'u'));
  if (!match) return -1;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 1 ? index - 1 : -1;
}

function trustedComputerUseWorkflowResolutionAttemptCount(
  checkpoint: AgentTaskCheckpoint,
  workflow: TrustedComputerUseWorkflowGoal,
): number {
  const applicationQuery = trustedComputerUseWorkflowApplicationQuery(checkpoint, workflow);
  return checkpoint.observations.filter((entry) => {
    if (entry.capabilityId !== 'computer.windows.list') return false;
    return objectRecord(objectRecord(entry.structuredData)?.output)?.titleQuery === applicationQuery;
  }).length;
}

function trustedComputerUseWorkflowInteractionCycleCount(plan: AgentPlan): number {
  return plan.steps.filter((step) => (
    step.title === TRUSTED_COMPUTER_USE_WORKFLOW_INTERACT_STEP
    && step.status === 'completed'
  )).length;
}

function workflowRequiresExactCommunicationDetails(workflow: TrustedComputerUseWorkflowGoal): boolean {
  return /(?:telegram|whatsapp|discord|signal|messenger)/iu.test(workflow.application)
    || /(?:сообщени|напиши|отправ|send|message|write\s+to)/iu.test(workflow.objective);
}

const TRUSTED_COMPUTER_USE_PLAN_SUMMARY = 'Resolve one exact window, capture fresh one-shot evidence, then perform one model-selected input atom.';
const TRUSTED_COMPUTER_USE_RESOLVE_STEP = 'Resolve the exact requested Computer Use window.';
const TRUSTED_COMPUTER_USE_OBSERVE_STEP = 'Capture a fresh one-shot observation of the exact window.';
const TRUSTED_COMPUTER_USE_EFFECT_STEP = 'Perform the explicitly requested Computer Use action and verify its native postcondition.';
const TRUSTED_COMPUTER_USE_EFFECT_CAPABILITIES = {
  click: 'computer.window.click',
  close: 'computer.window.close',
  type: 'computer.window.type',
  key: 'computer.window.key',
  scroll: 'computer.window.scroll',
} as const;

function trustedComputerUseRuntimeDecision(
  checkpoint: AgentTaskCheckpoint,
  candidates: readonly MonarchCapability[],
): AgentDecision | null {
  const task = checkpoint.task;
  const goal = parseTrustedComputerUseWindowGoal(task.goal.originalRequest);
  if (!goal || task.planningMode !== 'model-first' || !task.plan) return null;
  const candidateIds = new Set(candidates.map((entry) => entry.id));

  if (task.plan.revision <= 1) {
    if (
      !candidateIds.has('computer.windows.list')
      || !candidateIds.has('computer.window.observe')
      || !candidateIds.has(TRUSTED_COMPUTER_USE_EFFECT_CAPABILITIES[goal.effectKind])
    ) return null;
    return {
      kind: 'revise-plan',
      summary: TRUSTED_COMPUTER_USE_PLAN_SUMMARY,
      reason: goal.effectKind === 'close'
        ? 'Runtime compiled one exact close workflow from the trusted function invocation; Kernel still owns native authority and verification.'
        : 'Runtime compiled a read-only exact-window preflight from the trusted original request; the model still owns the input atom.',
      steps: [
        {
          title: TRUSTED_COMPUTER_USE_RESOLVE_STEP,
          expectedEffect: `Exactly one opaque window reference matches the trusted ${goal.targetKind === 'exact-title' ? 'exact title' : 'window query'} ${JSON.stringify(goal.target)}.`,
        },
        {
          title: TRUSTED_COMPUTER_USE_OBSERVE_STEP,
          expectedEffect: 'A fresh screenshot and bounded UI Automation tree are bound to that exact window.',
        },
        {
          title: TRUSTED_COMPUTER_USE_EFFECT_STEP,
          expectedEffect: 'Kernel verifies one model-selected input atom and its read-after-action observation.',
        },
      ],
    };
  }

  if (!isTrustedComputerUseRuntimePlan(task.plan)) return null;
  if (goal.effectKind === 'close') {
    const closed = [...checkpoint.observations].reverse().find((observation) => {
      if (observation.status !== 'success' || observation.capabilityId !== 'computer.window.close') return false;
      const output = objectRecord(objectRecord(observation.structuredData)?.output);
      return output?.performed === true && output.verified === true && output.closed === true;
    });
    if (closed) return trustedComputerUseCompletion(task, closed);
  }
  const step = currentAgentPlanStep(task.plan, task.currentStepId);
  if (step?.title === TRUSTED_COMPUTER_USE_RESOLVE_STEP) {
    if (!candidateIds.has('computer.windows.list')) return null;
    return {
      kind: 'inspect',
      capabilityId: 'computer.windows.list',
      input: goal.targetKind === 'exact-title'
        ? { exactTitle: goal.target, limit: 2 }
        : { titleQuery: goal.target, limit: 2 },
      reason: goal.targetKind === 'exact-title'
        ? 'Resolve only the exact title copied from the trusted original request.'
        : 'Resolve only the bounded application/window name copied from the trusted function invocation.',
      expectedEffect: 'Kernel returns zero, one, or two opaque references so ambiguity is detected before any effect.',
    };
  }
  if (step?.title === TRUSTED_COMPUTER_USE_EFFECT_STEP && goal.effectKind === 'close') {
    const resolution = trustedComputerUseWindowResolution(checkpoint, goal);
    if (resolution.status !== 'unique') return null;
    const observationId = trustedComputerUseObservationId(checkpoint, resolution.windowRef);
    if (!observationId || !candidateIds.has('computer.window.close')) return null;
    return {
      kind: 'act',
      capabilityId: 'computer.window.close',
      input: { windowRef: resolution.windowRef, observationId },
      reason: 'Close the uniquely resolved window using exactly one fresh observation and verify that the native handle disappears.',
      expectedEffect: 'Kernel verifies that the exact observed top-level window is no longer visible.',
    };
  }
  if (step?.title !== TRUSTED_COMPUTER_USE_OBSERVE_STEP) return null;

  const resolution = trustedComputerUseWindowResolution(checkpoint, goal);
  if (resolution.status === 'missing') {
    return {
      kind: 'ask-user',
      question: `Не вижу открытого окна «${goal.target}». Открой его и повтори задачу — никакого действия не выполнялось.`,
      reason: 'Window preflight returned no target and must fail closed before native input.',
    };
  }
  if (resolution.status === 'ambiguous') {
    return {
      kind: 'ask-user',
      question: `Найдено несколько подходящих окон «${goal.target}». Уточни название — никакого действия не выполнялось.`,
      reason: 'Window preflight is ambiguous and must fail closed before native input.',
    };
  }
  if (resolution.status === 'invalid') {
    return {
      kind: 'fail',
      code: 'computer-window-resolution-invalid',
      reason: 'Kernel window enumeration was not exactly bound to the trusted title; no native input was attempted.',
    };
  }
  if (resolution.status === 'absent') {
    return {
      kind: 'fail',
      code: 'computer-window-resolution-missing-evidence',
      reason: 'The runtime preflight reached observation without a successful exact-title Kernel receipt; no native input was attempted.',
    };
  }
  if (resolution.status !== 'unique') {
    return {
      kind: 'fail',
      code: 'computer-window-resolution-unhandled',
      reason: 'Exact-window resolution did not produce one trusted target; no native input was attempted.',
    };
  }
  if (!candidateIds.has('computer.window.observe')) {
    return {
      kind: 'wait-runtime',
      runtimeId: 'computer',
      reason: 'The exact window was resolved, but fresh screenshot/UIA observation is temporarily unavailable.',
    };
  }
  return {
    kind: 'inspect',
    capabilityId: 'computer.window.observe',
    input: { windowRef: resolution.windowRef, captureNonce: step.id },
    reason: 'Capture a fresh one-shot screenshot and UI Automation tree for the uniquely resolved window.',
    expectedEffect: 'Kernel returns a fresh observation bound to the exact opaque window reference.',
  };
}

function trustedComputerUseEffectCandidates(
  checkpoint: AgentTaskCheckpoint,
  cards: ReturnType<typeof resolveAgentCapabilities>['cards'],
  capabilities: ReturnType<typeof resolveAgentCapabilities>['capabilities'],
): {
  cards: ReturnType<typeof resolveAgentCapabilities>['cards'];
  capabilities: ReturnType<typeof resolveAgentCapabilities>['capabilities'];
} {
  const task = checkpoint.task;
  const goal = parseTrustedExactComputerUseGoal(task.goal.originalRequest);
  const step = currentAgentPlanStep(task.plan, task.currentStepId);
  if (
    !goal
    || !task.plan
    || !isTrustedComputerUseRuntimePlan(task.plan)
    || step?.title !== TRUSTED_COMPUTER_USE_EFFECT_STEP
  ) return { cards, capabilities };
  const capabilityId = TRUSTED_COMPUTER_USE_EFFECT_CAPABILITIES[goal.effectKind];
  const selectedCards = cards.filter((entry) => entry.id === capabilityId);
  const selectedCapabilities = capabilities.filter((entry) => entry.id === capabilityId);
  return selectedCards.length === 1 && selectedCapabilities.length === 1
    ? { cards: selectedCards, capabilities: selectedCapabilities }
    : { cards, capabilities };
}

function trustedComputerUseWorkflowEffectCandidates(
  checkpoint: AgentTaskCheckpoint,
  cards: ReturnType<typeof resolveAgentCapabilities>['cards'],
  capabilities: ReturnType<typeof resolveAgentCapabilities>['capabilities'],
): {
  cards: ReturnType<typeof resolveAgentCapabilities>['cards'];
  capabilities: ReturnType<typeof resolveAgentCapabilities>['capabilities'];
} {
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  const step = currentAgentPlanStep(checkpoint.task.plan, checkpoint.task.currentStepId);
  if (
    !workflow
    || !checkpoint.task.plan
    || !isTrustedComputerUseWorkflowPlan(checkpoint.task.plan, workflow)
    || step?.title !== TRUSTED_COMPUTER_USE_WORKFLOW_INTERACT_STEP
  ) return { cards, capabilities };
  const allowed = new Set([
    'computer.window.analyze',
    'computer.window.click',
    'computer.window.type',
    'computer.window.key',
    'computer.window.scroll',
  ]);
  const selectedCards = cards.filter((entry) => allowed.has(entry.id));
  const selectedCapabilities = capabilities.filter((entry) => allowed.has(entry.id));
  return selectedCards.length > 0 && selectedCapabilities.length > 0
    ? { cards: selectedCards, capabilities: selectedCapabilities }
    : { cards, capabilities };
}

function isTrustedComputerUseRuntimePlan(plan: AgentPlan): boolean {
  if (plan.goalSummary !== TRUSTED_COMPUTER_USE_PLAN_SUMMARY) return false;
  const titles = new Set(plan.steps.map((step) => step.title));
  return titles.has(TRUSTED_COMPUTER_USE_RESOLVE_STEP)
    && titles.has(TRUSTED_COMPUTER_USE_OBSERVE_STEP)
    && titles.has(TRUSTED_COMPUTER_USE_EFFECT_STEP);
}

type TrustedComputerUseWindowResolution =
  | { status: 'absent' | 'missing' | 'ambiguous' | 'invalid' }
  | { status: 'unique'; windowRef: string };

function trustedComputerUseWindowResolution(
  checkpoint: AgentTaskCheckpoint,
  goal: TrustedComputerUseWindowGoal,
): TrustedComputerUseWindowResolution {
  const listStep = [...(checkpoint.task.plan?.steps || [])]
    .reverse()
    .find((step) => step.title === TRUSTED_COMPUTER_USE_RESOLVE_STEP);
  if (!listStep) return { status: 'absent' };
  const observation = [...checkpoint.observations].reverse().find((entry) => (
    entry.stepId === listStep.id
    && entry.capabilityId === 'computer.windows.list'
    && entry.status === 'success'
  ));
  if (!observation) return { status: 'absent' };
  const output = objectRecord(objectRecord(observation.structuredData)?.output);
  if (output?.verified !== true || !Array.isArray(output.windows)) return { status: 'invalid' };
  if (goal.targetKind === 'exact-title' && output.exactTitle !== undefined && output.exactTitle !== goal.target) {
    return { status: 'invalid' };
  }
  if (goal.targetKind === 'title-query' && output.titleQuery !== undefined && output.titleQuery !== goal.target) {
    return { status: 'invalid' };
  }
  if (output.windows.length === 0) return { status: 'missing' };
  if (output.windows.length !== 1) return { status: 'ambiguous' };
  const window = objectRecord(output.windows[0]);
  const windowRef = typeof window?.windowRef === 'string' ? window.windowRef : '';
  const title = typeof window?.title === 'string' ? window.title : '';
  const processName = typeof window?.processName === 'string' ? window.processName : '';
  const targetMatches = goal.targetKind === 'exact-title'
    ? title === goal.target
    : computerWindowMatchesQuery({ title, processName }, goal.target);
  if (!windowRef || !targetMatches) return { status: 'invalid' };
  return { status: 'unique', windowRef };
}

function trustedComputerUseObservationId(
  checkpoint: AgentTaskCheckpoint,
  windowRef: string,
): string {
  for (let index = checkpoint.observations.length - 1; index >= 0; index -= 1) {
    const observation = checkpoint.observations[index];
    if (observation?.status !== 'success' || observation.capabilityId !== 'computer.window.observe') continue;
    const output = objectRecord(objectRecord(observation.structuredData)?.output);
    if (output?.windowRef === windowRef && typeof output.observationId === 'string') return output.observationId;
  }
  return '';
}

function trustedComputerUseCompletion(
  task: AgentTask,
  observation: AgentObservation,
): Extract<AgentDecision, { kind: 'complete' }> {
  const observationIds = [observation.id];
  return {
    kind: 'complete',
    summary: observation.summary,
    evidenceObservationIds: observationIds,
    artifactIds: [],
    evidenceBindings: [
      ...task.goal.expectedOutputs.filter((entry) => entry.required !== false).map((entry) => ({
        targetType: 'expected-output' as const,
        targetId: entry.id,
        observationIds,
        artifactIds: [],
      })),
      ...task.goal.successCriteria.map((entry) => ({
        targetType: 'success-criterion' as const,
        targetId: entry.id,
        observationIds,
        artifactIds: [],
      })),
    ],
  };
}

function isPlanningDecision(decision: AgentDecision): boolean {
  return decision.kind === 'revise-plan'
    || decision.kind === 'discover-tools'
    || decision.kind === 'ask-user'
    || decision.kind === 'wait-runtime'
    || decision.kind === 'fail';
}

function assertPlanRevisionFollowsNewEvidence(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
  executionPhase: 'planning' | 'execution',
): void {
  if (executionPhase !== 'execution' || decision.kind !== 'revise-plan') return;
  const latestPlanRevision = [...checkpoint.events].reverse().find((event) => event.type === 'plan.revised');
  if (!latestPlanRevision) return;
  const latestObservation = [...checkpoint.events].reverse().find((event) => event.type === 'observation.created');
  if (latestObservation && latestObservation.sequence > latestPlanRevision.sequence) return;
  throw new AgentDecisionValidationError(
    'plan-revision-requires-new-evidence',
    'Execution cannot revise the plan again until a new tool observation changes the known state. Select the next concrete inspect/act capability instead.',
  );
}

function assertNoImmediateDuplicateInspection(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
  capabilities: readonly MonarchCapability[],
): void {
  if (decision.kind !== 'inspect') return;
  const capability = capabilities.find((entry) => entry.id === decision.capabilityId);
  if (!capability || resolveAgentCapabilityMetadata(capability).effectProfile.mutation !== 'none') return;
  const latestToolStart = [...checkpoint.events].reverse().find((event) => event.type === 'tool.started');
  const latestPayload = latestToolStart?.payload;
  if (
    !latestPayload
    || latestPayload.decisionFingerprint !== executableDecisionFingerprint(decision, agentActionIdentityRoot(checkpoint))
  ) return;
  const actionAttemptId = typeof latestPayload.actionAttemptId === 'string'
    ? latestPayload.actionAttemptId
    : '';
  const completed = [...checkpoint.events].reverse().find((event) => (
    event.type === 'tool.completed'
    && event.payload?.actionAttemptId === actionAttemptId
  ));
  if (completed?.payload?.ok !== true) return;
  throw new AgentDecisionValidationError(
    'duplicate-inspection-without-state-change',
    'This exact read-only inspection already succeeded and no intervening action, runtime wait, or user event changed the state. Select a different concrete capability; use wait-runtime before intentional polling.',
  );
}

function assertNoKnownFailedActionReplay(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
  capabilities: readonly MonarchCapability[],
): void {
  if (decision.kind !== 'inspect' && decision.kind !== 'act') return;
  const workingState = checkpoint.task.workingState;
  const lastFailure = workingState?.lastFailure;
  if (!workingState || !lastFailure || lastFailure.capabilityId !== decision.capabilityId) return;
  const fingerprint = executableDecisionFingerprint(decision, agentActionIdentityRoot(checkpoint));
  if (!workingState.failedActionFingerprints.includes(fingerprint)) return;
  const failureObservation = checkpoint.observations.find((entry) => entry.id === lastFailure.observationId);
  if (!failureObservation) return;
  const capability = capabilities.find((entry) => entry.id === decision.capabilityId);
  if (capability) {
    const metadata = resolveAgentCapabilityMetadata(capability);
    const mutationTruth = observationMutationTruth(failureObservation);
    if (
      metadata.effectProfile.mutation !== 'none'
      && metadata.idempotency !== 'idempotent'
      && mutationTruth !== 'no-effect'
    ) {
      throw new AgentDecisionValidationError(
        'mutation-reconciliation-required',
        'This mutation may already have changed state. Reconcile its exact postcondition with a capability-owned readback before any repeat.',
      );
    }
  }
  const failureAt = Date.parse(failureObservation.occurredAt);
  const freshAuthority = checkpoint.observations.some((entry) => (
    entry.status === 'success'
    && Date.parse(entry.occurredAt) > failureAt
  )) || checkpoint.task.messages.some((message) => (
    message.role === 'user'
    && Date.parse(message.createdAt) > failureAt
  )) || checkpoint.events.some((event) => (
    event.type === 'task.status.changed'
    && Date.parse(event.createdAt) > failureAt
    && (event.payload?.reason === 'user-message' || event.payload?.reason === 'runtime-resumed')
  ));
  if (freshAuthority) return;

  const latestResetAt = Math.max(
    0,
    ...checkpoint.observations
      .filter((entry) => entry.status === 'success' && Date.parse(entry.occurredAt) <= failureAt)
      .map((entry) => Date.parse(entry.occurredAt)),
    ...checkpoint.task.messages
      .filter((message) => message.role === 'user' && Date.parse(message.createdAt) <= failureAt)
      .map((message) => Date.parse(message.createdAt)),
  );
  const consecutiveAttempts = checkpoint.events.filter((event) => (
    event.type === 'tool.started'
    && event.payload?.decisionFingerprint === fingerprint
    && Date.parse(event.createdAt) >= latestResetAt
  )).length;
  // One identical retry is the bounded recovery allowance. Kernel metadata
  // still decides whether that retry is safe to dispatch; this guard only
  // prevents the model from entering a third unchanged attempt loop.
  if (consecutiveAttempts < 2) return;
  throw new AgentDecisionValidationError(
    'failed-action-replay',
    'This exact action already failed twice without new evidence or user/runtime state. Select a different recovery action.',
  );
}

function assertNoRepeatedComputerUseTypeEffect(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
): void {
  const fingerprint = computerUseEffectFingerprint(decision);
  if (!fingerprint) return;
  const completed = [...checkpoint.events].reverse().find((event) => (
    event.type === 'tool.completed'
    && event.payload?.ok === true
    && typeof event.payload?.actionAttemptId === 'string'
  ));
  const actionAttemptId = typeof completed?.payload?.actionAttemptId === 'string'
    ? completed.payload.actionAttemptId
    : '';
  if (!actionAttemptId) return;
  const started = [...checkpoint.events].reverse().find((event) => (
    event.type === 'tool.started'
    && event.payload?.actionAttemptId === actionAttemptId
  ));
  if (started?.payload?.effectFingerprint !== fingerprint) return;
  throw new AgentDecisionValidationError(
    'duplicate-computer-use-type-effect',
    'This exact Computer Use text effect already completed successfully. Use its fresh read-after-action receipt to complete the task; never type the same text into the same element twice.',
  );
}

const COMPUTER_USE_EFFECT_CAPABILITY_IDS = new Set([
  'computer.window.click',
  'computer.window.close',
  'computer.window.type',
  'computer.window.key',
  'computer.window.scroll',
]);

const COMPUTER_USE_ONE_SHOT_READ_CAPABILITY_IDS = new Set([
  'computer.windows.list',
  'computer.window.observe',
  'computer.window.analyze',
]);

function withoutImmediateComputerUseReadReplay(
  checkpoint: AgentTaskCheckpoint,
  cards: ReturnType<typeof resolveAgentCapabilities>['cards'],
  capabilities: ReturnType<typeof resolveAgentCapabilities>['capabilities'],
): {
  cards: ReturnType<typeof resolveAgentCapabilities>['cards'];
  capabilities: ReturnType<typeof resolveAgentCapabilities>['capabilities'];
} {
  const latestObservation = checkpoint.observations.at(-1);
  if (
    !latestObservation
    || latestObservation.status !== 'success'
    || !COMPUTER_USE_ONE_SHOT_READ_CAPABILITY_IDS.has(latestObservation.capabilityId)
  ) return { cards, capabilities };
  const observedAt = Date.parse(latestObservation.occurredAt);
  const authorityChanged = checkpoint.task.messages.some((message) => (
    message.role === 'user'
    && Date.parse(message.createdAt) > observedAt
  )) || checkpoint.events.some((event) => (
    event.type === 'task.status.changed'
    && Date.parse(event.createdAt) > observedAt
    && (event.payload?.reason === 'user-message' || event.payload?.reason === 'runtime-resumed')
  ));
  if (authorityChanged) return { cards, capabilities };
  const blockedCapabilityIds = new Set<string>();
  for (let index = checkpoint.observations.length - 1; index >= 0; index -= 1) {
    const observation = checkpoint.observations[index];
    if (
      !observation
      || observation.status !== 'success'
      || !COMPUTER_USE_ONE_SHOT_READ_CAPABILITY_IDS.has(observation.capabilityId)
    ) break;
    blockedCapabilityIds.add(observation.capabilityId);
  }
  return {
    cards: cards.filter((entry) => !blockedCapabilityIds.has(entry.id)),
    capabilities: capabilities.filter((entry) => !blockedCapabilityIds.has(entry.id)),
  };
}

function assertFreshObservationAfterComputerUseFailure(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
): void {
  if (
    decision.kind !== 'act'
    || !COMPUTER_USE_EFFECT_CAPABILITY_IDS.has(decision.capabilityId)
  ) return;
  let failedEffectIndex = -1;
  for (let index = checkpoint.observations.length - 1; index >= 0; index -= 1) {
    const observation = checkpoint.observations[index];
    if (!observation) continue;
    if (!COMPUTER_USE_EFFECT_CAPABILITY_IDS.has(observation.capabilityId)) continue;
    const output = objectRecord(objectRecord(observation.structuredData)?.output);
    if (
      (observation.status === 'failed' || observation.status === 'cancelled')
      && output?.requiresFreshObservation === true
    ) failedEffectIndex = index;
    break;
  }
  if (failedEffectIndex < 0) return;
  const freshObservationExists = checkpoint.observations
    .slice(failedEffectIndex + 1)
    .some((observation) => (
      observation.capabilityId === 'computer.window.observe'
      && observation.status === 'success'
    ));
  if (freshObservationExists) return;
  throw new AgentDecisionValidationError(
    'computer-use-fresh-observation-required',
    'The previous Computer Use input consumed its one-shot observation authority and failed. Select computer.window.observe and use its new observationId before any other Computer Use input; never reuse the old observationId.',
  );
}

function computerUseRecoveryCapabilityId(capabilityId: string, outputValue: unknown): string {
  if (!COMPUTER_USE_EFFECT_CAPABILITY_IDS.has(capabilityId)) return '';
  const output = objectRecord(outputValue);
  return output?.requiresFreshObservation === true
    && output.recoveryCapabilityId === 'computer.window.observe'
    ? 'computer.window.observe'
    : '';
}

function executableDecisionFingerprint(decision: AgentExecutableDecision, workspaceRoot = process.cwd()): string {
  return canonicalProposalHash({
    capabilityId: decision.capabilityId,
    input: canonicalizeActionIdentityArgs(decision.input, workspaceRoot),
  });
}

function agentActionIdentityRoot(checkpoint: AgentTaskCheckpoint): string {
  return checkpoint.task.executionProfile?.projectRoot || process.cwd();
}

function computerUseEffectFingerprint(decision: AgentDecision): string {
  if (decision.kind !== 'act' || decision.capabilityId !== 'computer.window.type') return '';
  const { observationId: _observationId, ...effectInput } = decision.input;
  return canonicalProposalHash({ capabilityId: decision.capabilityId, input: effectInput });
}

function assertTrustedComputerUseWorkflowDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
): void {
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  const plan = checkpoint.task.plan;
  const step = currentAgentPlanStep(plan, checkpoint.task.currentStepId);
  if (
    !workflow
    || !plan
    || !isTrustedComputerUseWorkflowPlan(plan, workflow)
    || step?.title !== TRUSTED_COMPUTER_USE_WORKFLOW_INTERACT_STEP
    || (decision.kind !== 'act' && decision.kind !== 'inspect')
  ) return;
  const allowed = new Set([
    'computer.window.analyze',
    'computer.window.click',
    'computer.window.type',
    'computer.window.key',
    'computer.window.scroll',
  ]);
  if (!allowed.has(decision.capabilityId)) {
    throw new AgentDecisionValidationError(
      'computer-use-workflow-capability-invalid',
      'The interactive workflow may select only one screenshot-bound Computer Use analyze/input atom.',
    );
  }
  const resolution = trustedComputerUseWorkflowWindowResolution(checkpoint, workflow);
  if (resolution.status !== 'unique') {
    throw new AgentDecisionValidationError(
      'computer-use-workflow-window-unbound',
      'The trusted workflow does not currently have exactly one native window target.',
    );
  }
  const latest = trustedComputerUseWorkflowLatestObservation(checkpoint, resolution.windowRef);
  if (
    !latest
    || decision.input.windowRef !== resolution.windowRef
    || decision.input.observationId !== latest.observationId
  ) {
    throw new AgentDecisionValidationError(
      'computer-use-workflow-observation-stale',
      'Use only the latest observationId and exact windowRef exposed for this workflow cycle.',
    );
  }
  if (
    decision.capabilityId === 'computer.window.analyze'
    && decision.input.objective !== workflow.objective
  ) {
    throw new AgentDecisionValidationError(
      'computer-use-workflow-objective-mismatch',
      'Visual analysis must use the exact trusted workflow objective, not model-authored instructions.',
    );
  }
  if (decision.capabilityId === 'computer.window.type') {
    const text = typeof decision.input.text === 'string' ? decision.input.text : '';
    if (!workflow.trustedTextInputs.includes(text)) {
      throw new AgentDecisionValidationError(
        'computer-use-workflow-text-untrusted',
        'Typed text must exactly match one quoted user-authored literal from the original Computer Use request.',
      );
    }
    if (text === workflow.expectedText && checkpoint.observations.some((entry) => {
      const binding = objectRecord(objectRecord(entry.structuredData)?.runtimeBinding);
      return binding?.kind === 'computer-window-workflow-action'
        && binding.capabilityId === 'computer.window.type'
        && binding.exactReceipt === true
        && binding.typedExpectedText === true;
    })) {
      throw new AgentDecisionValidationError(
        'computer-use-workflow-message-already-typed',
        'The exact requested message was already typed. Select the observed send control or Enter; never type it twice.',
      );
    }
  }
}

function buildComputerUseRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  outputValue: unknown,
): AgentJsonObject | null {
  const task = checkpoint.task;
  if (decision.capabilityId === 'computer.window.verify-text') {
    return buildComputerUseTextVerificationRuntimeBinding(checkpoint, decision, outputValue);
  }
  const workflowBinding = buildComputerUseWorkflowActionRuntimeBinding(checkpoint, decision, outputValue);
  if (workflowBinding) return workflowBinding;
  if (decision.capabilityId === 'computer.window.close') {
    return buildComputerUseCloseRuntimeBinding(checkpoint, decision, outputValue);
  }
  if (decision.capabilityId === 'computer.window.click') {
    return buildComputerUseClickRuntimeBinding(checkpoint, decision, outputValue);
  }
  if (decision.capabilityId !== 'computer.window.type') return null;
  const text = typeof decision.input.text === 'string' ? decision.input.text : '';
  const windowRef = typeof decision.input.windowRef === 'string' ? decision.input.windowRef : '';
  const elementId = typeof decision.input.elementId === 'string' ? decision.input.elementId : '';
  if (text.length < 3 || !windowRef || !elementId) return null;
  const output = objectRecord(outputValue);
  const after = objectRecord(output?.after);
  const afterWindow = objectRecord(after?.window);
  const afterWindowRef = typeof after?.windowRef === 'string' ? after.windowRef : '';
  const afterTitle = typeof afterWindow?.title === 'string' ? afterWindow.title : '';
  const exactReceipt = output?.performed === true
    && output.verified === true
    && after?.verified === true
    && output.windowRef === windowRef
    && afterWindowRef === windowRef;
  const requestBound = task.goal.originalRequest.includes(text)
    && afterTitle.length > 0
    && task.goal.originalRequest.includes(afterTitle);
  const postconditionObserved = exactReceipt && deepContainsExactText(after, text);
  const safeAutoCompletion = requestBound && postconditionObserved;
  const goalDescriptions = [
    ...task.goal.expectedOutputs
      .filter((entry) => entry.required !== false)
      .map((entry) => entry.description),
    ...task.goal.successCriteria.map((entry) => entry.description),
  ];
  const targetHashes = safeAutoCompletion
    ? goalDescriptions.filter((description) => description.includes(text)).map(sha256Text)
    : [];
  return jsonObject({
    schemaVersion: 1,
    kind: 'computer-window-type',
    capabilityId: decision.capabilityId,
    windowRef,
    elementId,
    effectValueSha256: sha256Text(text),
    effectValueLength: text.length,
    exactReceipt,
    requestBound,
    postconditionObserved,
    safeAutoCompletion,
    goalTargetDescriptionHashes: [...new Set(targetHashes)],
  });
}

function buildWorkspaceInspectBatchRuntimeBinding(
  decision: AgentExecutableDecision,
  outputValue: unknown,
): AgentJsonObject | null {
  if (decision.capabilityId !== 'workspace.files.inspect-batch') return null;
  const output = objectRecord(outputValue);
  const root = typeof output?.root === 'string' ? output.root : '';
  const snapshotId = typeof output?.snapshotId === 'string' ? output.snapshotId : '';
  const complete = output?.complete === true;
  const nextCursor = typeof output?.nextCursor === 'string' ? output.nextCursor : '';
  const knownFolder = typeof decision.input.knownFolder === 'string' ? decision.input.knownFolder : '';
  const targetPath = typeof decision.input.path === 'string' ? decision.input.path : '';
  if (!root || !snapshotId || Boolean(knownFolder) === Boolean(targetPath)) return null;
  if (!complete && !nextCursor) return null;
  const baseInput = { ...decision.input };
  delete baseInput.cursor;
  return jsonObject({
    schemaVersion: 1,
    kind: 'workspace-files-inspect-batch',
    capabilityId: decision.capabilityId,
    root,
    snapshotId,
    complete,
    exactReceipt: true,
    ...(nextCursor ? {
      continuationInput: {
        ...baseInput,
        cursor: nextCursor,
      },
    } : {}),
  });
}

function buildMutationBaselineRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  sourceDecision: AgentExecutableDecision,
  descriptor: NonNullable<ReturnType<typeof resolveAgentCapabilityMetadata>['reconciliation']>,
  outputValue: unknown,
): AgentJsonObject | null {
  if (!descriptor.requiresPreActionBaseline) return null;
  const output = objectRecord(outputValue);
  if (!output) return null;
  const targetSourceKey = descriptor.inputBindings[descriptor.targetInputKey];
  const sourceTarget = targetSourceKey ? sourceDecision.input[targetSourceKey] : undefined;
  const observedTarget = readDottedObjectValue(output, descriptor.observationTargetPath);
  const baselineValue = readDottedObjectValue(output, descriptor.assertion.observationPath);
  const exactTarget = typeof sourceTarget === 'string'
    && typeof observedTarget === 'string'
    && reconciliationTargetsMatch(
      sourceTarget,
      observedTarget,
      checkpoint.task.executionProfile?.projectRoot,
    );
  if (!exactTarget || baselineValue === undefined) return null;
  return jsonObject({
    schemaVersion: 1,
    kind: 'mutation-precondition-baseline',
    sourceCapabilityId: sourceDecision.capabilityId,
    sourceDecisionFingerprint: executableDecisionFingerprint(
      sourceDecision,
      agentActionIdentityRoot(checkpoint),
    ),
    reconciliationSpecHash: canonicalProposalHash(descriptor),
    exactTarget: true,
    targetSha256: sha256Text(observedTarget),
    baselineValueSha256: canonicalProposalHash(baselineValue),
  });
}

function buildMutationReconciliationRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  outputValue: unknown,
): Record<string, unknown> | null {
  const sourceObservation = [...checkpoint.observations].reverse().find((observation) => {
    const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeReconciliationBinding);
    return binding?.schemaVersion === 1
      && binding.kind === 'mutation-postcondition-reconciliation'
      && binding.capabilityId === decision.capabilityId;
  });
  if (!sourceObservation) return null;
  const binding = objectRecord(objectRecord(sourceObservation.structuredData)?.runtimeReconciliationBinding);
  const expectedInput = objectRecord(binding?.input);
  const sourceInput = objectRecord(binding?.sourceInput);
  const descriptor = objectRecord(binding?.descriptor);
  const assertion = objectRecord(descriptor?.assertion);
  const output = objectRecord(outputValue);
  if (!binding || !expectedInput || !sourceInput || !descriptor || !assertion || !output) return null;
  if (
    binding.inputCanonicalHash !== canonicalProposalHash(canonicalizeActionIdentityArgs(
      expectedInput,
      agentActionIdentityRoot(checkpoint),
    ))
    || binding.reconciliationSpecHash !== canonicalProposalHash(descriptor)
    || canonicalProposalHash(canonicalizeActionIdentityArgs(
      decision.input,
      agentActionIdentityRoot(checkpoint),
    )) !== binding.inputCanonicalHash
  ) return null;
  const observationTargetPath = typeof descriptor.observationTargetPath === 'string'
    ? descriptor.observationTargetPath
    : '';
  const observationPath = typeof assertion.observationPath === 'string'
    ? assertion.observationPath
    : '';
  const sourceInputKey = typeof assertion.sourceInputKey === 'string'
    ? assertion.sourceInputKey
    : '';
  const sourceTarget = typeof binding.sourceTarget === 'string' ? binding.sourceTarget : '';
  const observedTarget = readDottedObjectValue(output, observationTargetPath);
  const observedValue = readDottedObjectValue(output, observationPath);
  const expectedValue = sourceInput[sourceInputKey];
  const baselineObservationId = typeof binding.baselineObservationId === 'string'
    ? binding.baselineObservationId
    : '';
  const baselineObservation = baselineObservationId
    ? checkpoint.observations.find((entry) => entry.id === baselineObservationId)
    : undefined;
  const baselineRuntimeBinding = objectRecord(objectRecord(baselineObservation?.structuredData)?.runtimeBinding);
  const baselineOutput = objectRecord(objectRecord(baselineObservation?.structuredData)?.output);
  const baselineValue = baselineOutput
    ? readDottedObjectValue(baselineOutput, observationPath)
    : undefined;
  const baselineValid = descriptor.requiresPreActionBaseline !== true || Boolean(
    baselineObservation
    && baselineObservation.status === 'success'
    && baselineRuntimeBinding?.kind === 'mutation-precondition-baseline'
    && baselineRuntimeBinding.sourceCapabilityId === binding.sourceCapabilityId
    && baselineRuntimeBinding.sourceDecisionFingerprint === binding.sourceDecisionFingerprint
    && baselineRuntimeBinding.reconciliationSpecHash === binding.reconciliationSpecHash
    && baselineRuntimeBinding.exactTarget === true
    && typeof binding.baselineValueSha256 === 'string'
    && binding.baselineValueSha256 === canonicalProposalHash(baselineValue)
    && baselineRuntimeBinding.baselineValueSha256 === binding.baselineValueSha256
  );
  const exactTarget = typeof observedTarget === 'string'
    && sourceTarget.length > 0
    && reconciliationTargetsMatch(sourceTarget, observedTarget, checkpoint.task.executionProfile?.projectRoot);
  const assertionKind = String(assertion.kind || '');
  const stateSatisfied = exactTarget && baselineValid && reconciliationAssertionMatches(
    assertionKind,
    observedValue,
    expectedValue,
    baselineValue,
  );
  return {
    schemaVersion: 1,
    kind: 'mutation-postcondition-reconciliation',
    sourceObservationId: sourceObservation.id,
    sourceActionAttemptId: binding.sourceActionAttemptId,
    sourceCapabilityId: binding.sourceCapabilityId,
    sourceProposalCanonicalHash: binding.sourceProposalCanonicalHash,
    sourceDecisionFingerprint: binding.sourceDecisionFingerprint,
    reconciliationCapabilityId: decision.capabilityId,
    exactTarget,
    stateSatisfied,
    assertionKind,
    targetSha256: sha256Text(String(observedTarget ?? '')),
    observedValueSha256: canonicalProposalHash(observedValue),
    expectedValueSha256: canonicalProposalHash(expectedValue),
    ...(baselineObservationId ? {
      baselineObservationId,
      baselineValueSha256: canonicalProposalHash(baselineValue),
    } : {}),
  };
}

function buildGroundedSynthesisRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  outputValue: unknown,
): AgentJsonObject | null {
  if (decision.capabilityId !== 'models.agent.synthesize') return null;
  const requestedIds = Array.isArray(decision.input.observationIds)
    ? [...new Set(decision.input.observationIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
    : [];
  const output = objectRecord(outputValue);
  const rawText = typeof output?.rawText === 'string' ? output.rawText.trim() : '';
  const sourceIds = Array.isArray(output?.sourceObservationIds)
    ? [...new Set(output.sourceObservationIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
    : [];
  const sourceObservations = sourceIds.map((id) => checkpoint.observations.find((entry) => entry.id === id));
  const exactSourceSet = requestedIds.length > 0
    && requestedIds.length === sourceIds.length
    && requestedIds.every((id) => sourceIds.includes(id));
  const sourcesGrounded = sourceObservations.length === sourceIds.length
    && sourceObservations.every((entry) => entry
      && (entry.status === 'success' || entry.status === 'partial')
      && hasKernelEvidence(entry));
  const allBatchObservations = checkpoint.observations.filter((entry) => (
    entry.capabilityId === 'workspace.files.inspect-batch'
    && (entry.status === 'success' || entry.status === 'partial')
  ));
  const batchCoverageComplete = allBatchObservations.length === 0 || (
    allBatchObservations.every((entry) => sourceIds.includes(entry.id))
    && allBatchObservations.some((entry) => (
      objectRecord(objectRecord(entry.structuredData)?.runtimeBinding)?.complete === true
    ))
  );
  const exactSourceBinding = rawText.length > 0
    && exactSourceSet
    && sourcesGrounded
    && batchCoverageComplete;
  return jsonObject({
    schemaVersion: 1,
    kind: 'grounded-synthesis',
    capabilityId: decision.capabilityId,
    exactSourceBinding,
    sourceObservationIds: sourceIds,
    rawTextSha256: rawText ? sha256Text(rawText) : '',
    batchCoverageComplete,
  });
}

function buildComputerUseWorkflowActionRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  outputValue: unknown,
): AgentJsonObject | null {
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  if (!workflow || ![
    'computer.window.click',
    'computer.window.type',
    'computer.window.key',
    'computer.window.scroll',
  ].includes(decision.capabilityId)) return null;
  const windowRef = typeof decision.input.windowRef === 'string' ? decision.input.windowRef : '';
  const observationId = typeof decision.input.observationId === 'string' ? decision.input.observationId : '';
  const output = objectRecord(outputValue);
  const after = objectRecord(output?.after);
  const afterObservationId = typeof output?.afterObservationId === 'string' ? output.afterObservationId : '';
  const exactReceipt = Boolean(
    windowRef
    && observationId
    && afterObservationId
    && output?.performed === true
    && output.verified === true
    && output.windowRef === windowRef
    && output.beforeObservationId === observationId
    && after?.verified === true
    && after.windowRef === windowRef
    && after.observationId === afterObservationId
  );
  const source = trustedComputerUseWorkflowObservationOutput(checkpoint, windowRef, observationId);
  const elementId = typeof decision.input.elementId === 'string' ? decision.input.elementId : '';
  const sourceElement = Array.isArray(source?.elements)
    ? source.elements.map(objectRecord).find((entry) => entry?.elementId === elementId)
    : null;
  const elementName = typeof sourceElement?.name === 'string' ? sourceElement.name.trim() : '';
  const automationId = typeof sourceElement?.automationId === 'string' ? sourceElement.automationId.trim() : '';
  const controlType = typeof sourceElement?.controlType === 'string' ? sourceElement.controlType.trim() : '';
  const text = typeof decision.input.text === 'string' ? decision.input.text : '';
  const key = typeof decision.input.key === 'string' ? decision.input.key : '';
  const typedExpectedText = decision.capabilityId === 'computer.window.type'
    && Boolean(workflow.expectedText)
    && text === workflow.expectedText;
  const communicationField = typedExpectedText && /(?:message|сообщени|compose|write|input|edit|textbox)/iu.test(
    `${elementName} ${automationId} ${controlType}`,
  );
  const communicationDispatch = exactReceipt && (
    decision.capabilityId === 'computer.window.key' && key === 'enter'
    || decision.capabilityId === 'computer.window.click' && /(?:send|отправ)/iu.test(`${elementName} ${automationId}`)
  );
  return jsonObject({
    schemaVersion: 1,
    kind: 'computer-window-workflow-action',
    capabilityId: decision.capabilityId,
    windowRef,
    observationId,
    afterObservationId,
    exactReceipt,
    requestBound: true,
    postconditionObserved: false,
    safeAutoCompletion: false,
    goalTargetDescriptionHashes: [],
    ...(elementId ? { elementId, targetElementNameSha256: sha256Text(elementName) } : {}),
    ...(text ? { effectValueSha256: sha256Text(text), typedExpectedText, communicationField } : {}),
    ...(key ? { key, communicationDispatch } : {}),
    ...(decision.capabilityId === 'computer.window.click' ? { communicationDispatch } : {}),
  });
}

function buildComputerUseTextVerificationRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  outputValue: unknown,
): AgentJsonObject | null {
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  const expectedText = typeof decision.input.expectedText === 'string' ? decision.input.expectedText : '';
  const windowRef = typeof decision.input.windowRef === 'string' ? decision.input.windowRef : '';
  const observationId = typeof decision.input.observationId === 'string' ? decision.input.observationId : '';
  const output = objectRecord(outputValue);
  const communicationReady = !workflow
    || !workflowRequiresExactCommunicationDetails(workflow)
    || trustedComputerUseCommunicationDispatchObserved(checkpoint, workflow);
  const exactReceipt = Boolean(
    workflow?.expectedText
    && workflow.expectedText === expectedText
    && windowRef
    && observationId
    && output?.verified === true
    && output?.matched === true
    && output.expectedText === expectedText
    && output.windowRef === windowRef
    && output.observationId === observationId
    && communicationReady
  );
  const goalDescriptions = [
    ...checkpoint.task.goal.expectedOutputs
      .filter((entry) => entry.required !== false)
      .map((entry) => entry.description),
    ...checkpoint.task.goal.successCriteria.map((entry) => entry.description),
  ];
  return jsonObject({
    schemaVersion: 1,
    kind: 'computer-window-text-verification',
    capabilityId: decision.capabilityId,
    windowRef,
    observationId,
    expectedTextSha256: expectedText ? sha256Text(expectedText) : '',
    exactReceipt,
    requestBound: Boolean(workflow?.expectedText && workflow.expectedText === expectedText),
    postconditionObserved: exactReceipt,
    safeAutoCompletion: exactReceipt,
    communicationDispatchObserved: communicationReady,
    goalTargetDescriptionHashes: exactReceipt ? goalDescriptions.map(sha256Text) : [],
  });
}

function buildComputerUseCloseRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  outputValue: unknown,
): AgentJsonObject | null {
  const goal = parseTrustedComputerUseWindowGoal(checkpoint.task.goal.originalRequest);
  const windowRef = typeof decision.input.windowRef === 'string' ? decision.input.windowRef : '';
  const observationId = typeof decision.input.observationId === 'string' ? decision.input.observationId : '';
  const output = objectRecord(outputValue);
  const exactReceipt = Boolean(
    goal?.effectKind === 'close'
    && windowRef
    && observationId
    && output?.performed === true
    && output?.verified === true
    && output?.closed === true
    && output.windowRef === windowRef
    && output.beforeObservationId === observationId
  );
  const goalDescriptions = [
    ...checkpoint.task.goal.expectedOutputs
      .filter((entry) => entry.required !== false)
      .map((entry) => entry.description),
    ...checkpoint.task.goal.successCriteria.map((entry) => entry.description),
  ];
  return jsonObject({
    schemaVersion: 1,
    kind: 'computer-window-close',
    capabilityId: decision.capabilityId,
    windowRef,
    exactReceipt,
    requestBound: Boolean(goal),
    postconditionObserved: exactReceipt,
    safeAutoCompletion: exactReceipt,
    goalTargetDescriptionHashes: exactReceipt ? goalDescriptions.map(sha256Text) : [],
  });
}

function buildComputerUseClickRuntimeBinding(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
  outputValue: unknown,
): AgentJsonObject | null {
  const windowRef = typeof decision.input.windowRef === 'string' ? decision.input.windowRef : '';
  const observationId = typeof decision.input.observationId === 'string' ? decision.input.observationId : '';
  const elementId = typeof decision.input.elementId === 'string' ? decision.input.elementId : '';
  if (!windowRef || !observationId || !elementId) {
    return unresolvedComputerUseClickRuntimeBinding('invalid-action-target');
  }
  const requestedObservationPairHash = sha256Text(`${observationId}\u0000${windowRef}`);
  const availableObservationPairHashes = checkpoint.observations
    .filter((entry) => entry.capabilityId === 'computer.window.observe' && entry.status === 'success')
    .flatMap((entry) => {
      const sourceOutput = objectRecord(objectRecord(entry.structuredData)?.output);
      return typeof sourceOutput?.observationId === 'string' && typeof sourceOutput.windowRef === 'string'
        ? [sha256Text(`${sourceOutput.observationId}\u0000${sourceOutput.windowRef}`)]
        : [];
    });
  const sourceObservation = checkpoint.observations.find((entry) => {
    if (entry.capabilityId !== 'computer.window.observe' || entry.status !== 'success') return false;
    const sourceOutput = objectRecord(objectRecord(entry.structuredData)?.output);
    return sourceOutput?.observationId === observationId && sourceOutput.windowRef === windowRef;
  });
  if (!sourceObservation) {
    return unresolvedComputerUseClickRuntimeBinding('source-observation-unbound', {
      requestedObservationPairHash,
      availableObservationPairHashes,
    });
  }
  const before = objectRecord(objectRecord(sourceObservation?.structuredData)?.output);
  const sourceElements = Array.isArray(before?.elements) ? before.elements : [];
  const sourceElement = sourceElements
    .map(objectRecord)
    .find((entry) => entry?.elementId === elementId);
  const elementName = typeof sourceElement?.name === 'string' ? sourceElement.name.trim() : '';
  if (!before || elementName.length < 2 || elementName.length > 256) {
    return unresolvedComputerUseClickRuntimeBinding('source-element-unbound');
  }

  const output = objectRecord(outputValue);
  const after = objectRecord(output?.after);
  const beforeWindow = objectRecord(before.window);
  const afterWindow = objectRecord(after?.window);
  const afterWindowRef = typeof after?.windowRef === 'string' ? after.windowRef : '';
  const beforeTitle = typeof beforeWindow?.title === 'string' ? beforeWindow.title : '';
  const afterTitle = typeof afterWindow?.title === 'string' ? afterWindow.title : '';
  const exactReceipt = output?.performed === true
    && output.verified === true
    && after?.verified === true
    && output.windowRef === windowRef
    && afterWindowRef === windowRef
    && beforeTitle.length > 0
    && beforeTitle === afterTitle;
  const beforeFacts = new Set(computerObservationElementFacts(before).map(normalizeLiteralFact));
  const changedFacts = computerObservationElementFacts(after)
    .filter((fact) => !beforeFacts.has(normalizeLiteralFact(fact)))
    .filter((fact) => containsLiteralFact(checkpoint.task.goal.originalRequest, fact));
  const requestBound = containsLiteralFact(checkpoint.task.goal.originalRequest, beforeTitle)
    && containsLiteralFact(checkpoint.task.goal.originalRequest, elementName)
    && changedFacts.length > 0;
  const postconditionObserved = exactReceipt && changedFacts.length > 0;
  const safeAutoCompletion = requestBound && postconditionObserved;
  const goalDescriptions = [
    ...checkpoint.task.goal.expectedOutputs
      .filter((entry) => entry.required !== false)
      .map((entry) => entry.description),
    ...checkpoint.task.goal.successCriteria.map((entry) => entry.description),
  ];
  const targetHashes = safeAutoCompletion
    ? goalDescriptions
      .filter((description) => changedFacts.some((fact) => containsLiteralFact(description, fact)))
      .map(sha256Text)
    : [];
  return jsonObject({
    schemaVersion: 1,
    kind: 'computer-window-click',
    capabilityId: decision.capabilityId,
    bindingStatus: safeAutoCompletion ? 'verified-postcondition' : 'postcondition-unbound',
    windowRef,
    elementId,
    targetElementNameSha256: sha256Text(elementName),
    postconditionFactSha256s: [...new Set(changedFacts.map(sha256Text))],
    exactReceipt,
    requestBound,
    postconditionObserved,
    safeAutoCompletion,
    goalTargetDescriptionHashes: [...new Set(targetHashes)],
  });
}

function unresolvedComputerUseClickRuntimeBinding(
  bindingStatus: string,
  diagnostics: AgentJsonObject = {},
): AgentJsonObject {
  return jsonObject({
    schemaVersion: 1,
    kind: 'computer-window-click',
    capabilityId: 'computer.window.click',
    bindingStatus,
    exactReceipt: false,
    requestBound: false,
    postconditionObserved: false,
    safeAutoCompletion: false,
    goalTargetDescriptionHashes: [],
    ...diagnostics,
  });
}

function computerUseRuntimeBindingProvesTarget(
  observation: AgentObservation,
  targetDescription: string,
): boolean {
  const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeBinding);
  const bindingMatchesCapability = (
    binding?.kind === 'computer-window-type'
    && binding.capabilityId === 'computer.window.type'
  ) || (
    binding?.kind === 'computer-window-click'
    && binding.capabilityId === 'computer.window.click'
  ) || (
    binding?.kind === 'computer-window-close'
    && binding.capabilityId === 'computer.window.close'
  ) || (
    binding?.kind === 'computer-window-text-verification'
    && binding.capabilityId === 'computer.window.verify-text'
  );
  if (
    !bindingMatchesCapability
    || binding.exactReceipt !== true
    || binding.requestBound !== true
    || binding.postconditionObserved !== true
    || binding.safeAutoCompletion !== true
  ) return false;
  const hashes = Array.isArray(binding.goalTargetDescriptionHashes)
    ? binding.goalTargetDescriptionHashes
    : [];
  return hashes.includes(sha256Text(targetDescription));
}

function computerObservationElementFacts(value: unknown): string[] {
  const observation = objectRecord(value);
  const elements = Array.isArray(observation?.elements) ? observation.elements : [];
  const facts: string[] = [];
  for (const rawElement of elements.slice(0, 1_024)) {
    const element = objectRecord(rawElement);
    for (const key of ['name', 'value'] as const) {
      const fact = typeof element?.[key] === 'string' ? element[key].trim() : '';
      if (fact.length >= 2 && fact.length <= 256) facts.push(fact);
    }
  }
  return [...new Set(facts)];
}

function containsLiteralFact(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeLiteralFact(needle);
  return normalizedNeedle.length >= 2
    && normalizeLiteralFact(haystack).includes(normalizedNeedle);
}

function normalizeLiteralFact(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function deepContainsExactText(value: unknown, expected: string): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && visited < 4_096) {
    const current = stack.pop()!;
    visited += 1;
    if (typeof current.value === 'string') {
      if (current.value.includes(expected)) return true;
      continue;
    }
    if (!current.value || typeof current.value !== 'object' || current.depth >= 8) continue;
    const values = Array.isArray(current.value)
      ? current.value.slice(0, 256)
      : Object.values(current.value as Record<string, unknown>).slice(0, 256);
    for (const entry of values) stack.push({ value: entry, depth: current.depth + 1 });
  }
  return false;
}

function readDottedObjectValue(value: unknown, dottedPath: string): unknown {
  if (!dottedPath) return undefined;
  let current: unknown = value;
  for (const segment of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function reconciliationTargetsMatch(left: string, right: string, workspaceRoot = process.cwd()): boolean {
  if (/^[A-Za-z]:[\\/]|[\\/]/u.test(left) || /^[A-Za-z]:[\\/]|[\\/]/u.test(right)) {
    const resolveTarget = (value: string): string => path.resolve(workspaceRoot, value);
    return sameCanonicalFilesystemPath(resolveTarget(left), resolveTarget(right));
  }
  return left === right;
}

function reconciliationAssertionMatches(
  kind: string,
  observed: unknown,
  expected: unknown,
  baseline?: unknown,
): boolean {
  if (kind === 'equals-source-input') return canonicalProposalHash(observed) === canonicalProposalHash(expected);
  if (typeof observed !== 'string' || typeof expected !== 'string') return false;
  if (kind === 'equals-baseline-plus-source-input') {
    return typeof baseline === 'string' && observed === `${baseline}${expected}`;
  }
  if (kind === 'ends-with-source-input') return observed.endsWith(expected);
  if (kind === 'contains-source-input') return observed.includes(expected);
  return false;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalizeCompletionEvidence(
  checkpoint: AgentTaskCheckpoint,
  decision: Extract<AgentDecision, { kind: 'complete' }>,
): Extract<AgentDecision, { kind: 'complete' }> {
  const observationIds = [...new Set([
    ...decision.evidenceObservationIds,
    ...decision.evidenceBindings.flatMap((entry) => entry.observationIds),
  ])].filter((id) => checkpoint.observations.some((entry) => entry.id === id));
  const artifactIds = [...new Set([
    ...decision.artifactIds,
    ...decision.evidenceBindings.flatMap((entry) => entry.artifactIds),
  ])].filter((id) => checkpoint.task.artifacts.some((entry) => entry.id === id));
  const bindings = [...decision.evidenceBindings];
  return {
    ...decision,
    evidenceObservationIds: observationIds,
    artifactIds,
    evidenceBindings: bindings,
  };
}

function agentPlanCompletionBlocker(plan: AgentPlan | undefined): string | null {
  if (!plan) return 'Completion is blocked because the task has no durable execution plan.';
  const required = plan.steps.filter((step) => step.status !== 'skipped');
  const unfinished = required.filter((step) => step.status !== 'completed' && step.status !== 'failed');
  if (unfinished.length > 0) {
    return `Completion is blocked while required plan steps remain unfinished: ${unfinished
      .slice(0, 6)
      .map((step) => `${step.title} (${step.status})`)
      .join(', ')}.`;
  }
  if (!required.some((step) => step.status === 'completed')) {
    return 'Completion is blocked until at least one required plan step is completed.';
  }
  return null;
}

function requiresVerifiedMutation(kind: AgentTask['goal']['expectedOutputs'][number]['kind'] | undefined): boolean {
  return kind === 'artifact' || kind === 'state-change';
}

function inferredLegacyEffectKind(task: AgentTask): 'artifact' | 'state-change' | null {
  const requiredOutputs = task.goal.expectedOutputs.filter((output) => output.required !== false);
  if (requiredOutputs.some((output) => requiresVerifiedMutation(output.kind))) return null;
  const inferred = inferOperationalGoalKind(task.goal.originalRequest);
  return inferred === 'artifact' || inferred === 'state-change' ? inferred : null;
}

function taskRequiresVerifiedMutation(task: AgentTask): boolean {
  return task.goal.expectedOutputs.some((output) => (
    output.required !== false && requiresVerifiedMutation(output.kind)
  )) || inferredLegacyEffectKind(task) !== null;
}

function assertOperationalDecisionTarget(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
  capabilities: readonly MonarchCapability[],
): void {
  const task = checkpoint.task;
  if (decision.kind === 'respond') {
    const requiredOutputs = task.goal.expectedOutputs.filter((entry) => entry.required !== false);
    if (
      requiredOutputs.length === 0
      || requiredOutputs.some((entry) => entry.kind !== 'answer')
      || taskRequiresVerifiedMutation(task)
      || resolveAgentOperationalRequirements(task.goal.originalRequest).length > 0
      || requestRequiresKernelObservation(task.goal.originalRequest)
    ) {
      throw new AgentDecisionValidationError(
        'kernel-observation-required',
        'Direct respond is allowed only for an ordinary answer with no requested local fact or real-world effect.',
      );
    }
    return;
  }
  if (decision.kind !== 'act' && decision.kind !== 'inspect') return;
  const capability = capabilities.find((entry) => entry.id === decision.capabilityId);
  if (!capability) return;
  if (decision.capabilityId === 'models.agent.synthesize') return;
  if (
    decision.capabilityId === 'models.agent.respond'
    && requestRequiresKernelObservation(task.goal.originalRequest)
    && !mixedTaskMayUsePlainResponse(checkpoint)
  ) {
    throw new AgentDecisionValidationError(
      'kernel-observation-required',
      'A request about current local state cannot be answered with models.agent.respond. Inspect it with a supplied Kernel capability and then use models.agent.synthesize.',
    );
  }
  const mutating = resolveAgentCapabilityMetadata(capability).effectProfile.mutation !== 'none';
  const requirements = resolveAgentOperationalRequirements(task.goal.originalRequest);
  const exactEffectfulRequirement = mutating && requirements.some((requirement) => (
    requirement.effectful
    && operationalRequirementInputMatches(
      requirement,
      decision.capabilityId,
      decision.input,
      task.executionProfile?.projectRoot,
    )
  ));
  if (mutating && !taskRequiresVerifiedMutation(task) && !exactEffectfulRequirement) {
    throw new AgentDecisionValidationError(
      'unrequested-mutation',
      'The trusted goal contract does not request a state change. Select a read-only or response capability.',
    );
  }
  const knownFolderTarget = resolveKnownFolderRequestTarget(task.goal.originalRequest);
  if (knownFolderTarget && mutating) {
    if (
      decision.capabilityId !== 'workspace.known-folder.write'
      || !knownFolderWriteInputMatchesRequest(task.goal.originalRequest, decision.input)
    ) {
      throw new AgentDecisionValidationError(
        'operational-target-mismatch',
        'The proposed mutation does not match the exact runtime-owned known-folder target, filename, or content.',
      );
    }
    return;
  }
  if (requirements.length === 0) return;
  const effectfulRequirements = requirements.filter((requirement) => requirement.effectful);
  const relevant = mutating
    ? effectfulRequirements
    : effectfulRequirements.length === 0
      ? requirements
      : [];
  if (relevant.length === 0) return;
  if (!relevant.some((requirement) => (
    operationalRequirementInputMatches(
      requirement,
      decision.capabilityId,
      decision.input,
      task.executionProfile?.projectRoot,
    )
  ))) {
    throw new AgentDecisionValidationError(
      'operational-target-mismatch',
      'The proposed capability or arguments do not match any exact runtime-owned requirement in the original request.',
    );
  }
}

function requestRequiresKernelObservation(request: string): boolean {
  const disposition = classifyOscarRequestDisposition(request);
  // An explicit negative constraint on a second action ("read X; do not
  // write") must not erase the affirmative local observation. The request
  // classifier already distinguishes an actual operational read from a chat
  // question such as "explain how to create a file".
  if (disposition.mode === 'agent') return true;
  if (isNonExecutingMutationDiscussion(request)) return false;
  return disposition.hasLocalEffectTarget
    || disposition.kind === 'file_operation'
    || disposition.kind === 'system_action'
    || disposition.kind === 'tool_use';
}

function mixedTaskMayUsePlainResponse(checkpoint: AgentTaskCheckpoint): boolean {
  const requiredOutputs = checkpoint.task.goal.expectedOutputs.filter((entry) => entry.required !== false);
  const effectOutputs = requiredOutputs.filter((entry) => requiresVerifiedMutation(entry.kind));
  if (effectOutputs.length === 0) return false;
  const effectsSatisfied = effectOutputs.every((output) => checkpoint.observations.some((observation) => (
    observation.status === 'success'
    && observationProvesVerifiedGoalMutation(checkpoint, observation)
    && observationMatchesGoalTarget(checkpoint, 'expected-output', output.description, observation)
  )));
  if (!effectsSatisfied || !agentOperationalRequirementsSatisfied(checkpoint)) return false;
  return requiredOutputs.some((output) => (
    output.kind === 'answer'
    && !targetDescriptionMatchesAnyOperationalRequirement(checkpoint, output.description)
  ));
}

function bindRuntimeOwnedOperationalInput(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentDecision,
  capabilities: readonly MonarchCapability[],
): AgentDecision {
  if (decision.kind !== 'act' && decision.kind !== 'inspect') return decision;
  const task = checkpoint.task;
  decision = bindCoderExecutionProfileInput(task, decision, capabilities);
  if (decision.capabilityId === 'models.agent.synthesize') {
    const ids = Array.isArray(decision.input.observationIds)
      ? [...new Set(decision.input.observationIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
      : [];
    if (ids.length === 0 || ids.length > 128) {
      throw new AgentDecisionValidationError(
        'invalid-synthesis-binding',
        'Grounded synthesis requires 1-128 current-task observation ids.',
      );
    }
    const selected = ids.map((id) => checkpoint.observations.find((entry) => entry.id === id));
    const invalid = selected.find((observation) => !observation
      || (observation.status !== 'success' && observation.status !== 'partial')
      || observation.capabilityId === 'models.agent.respond'
      || observation.capabilityId === 'models.agent.synthesize'
      || !observation.evidence.some((entry) => (
        entry.evidenceClass === 'kernel-observation' || entry.evidenceClass === 'kernel-verification'
      )));
    if (invalid || selected.some((entry) => !entry)) {
      throw new AgentDecisionValidationError(
        'invalid-synthesis-binding',
        'Every synthesis id must reference a successful current-task Kernel observation.',
      );
    }
    const observations: unknown[] = [];
    let remainingChars = 128_000;
    for (const observation of selected as AgentObservation[]) {
      const full = redactAgentContextValue({
        id: observation.id,
        capabilityId: observation.capabilityId,
        status: observation.status,
        summary: observation.summary,
        structuredData: observation.structuredData,
        evidence: observation.evidence,
        occurredAt: observation.occurredAt,
      }, {
        maxStringChars: 16_000,
        maxArrayItems: 256,
        maxObjectKeys: 128,
        maxDepth: 9,
      }).value;
      const encoded = JSON.stringify(full);
      if (encoded.length <= remainingChars) {
        observations.push(full);
        remainingChars -= encoded.length;
      } else {
        observations.push({
          id: observation.id,
          capabilityId: observation.capabilityId,
          status: observation.status,
          summary: observation.summary,
          occurredAt: observation.occurredAt,
          bindingTruncated: true,
        });
      }
    }
    return {
      ...decision,
      input: {
        observationIds: ids,
        request: task.goal.originalRequest,
        observations,
      },
    };
  }
  const capability = capabilities.find((entry) => entry.id === decision.capabilityId);
  if (!capability || resolveAgentCapabilityMetadata(capability).effectProfile.mutation === 'none') return decision;
  if (decision.capabilityId === 'workspace.files.write') {
    const requirements = resolveAgentOperationalRequirements(task.goal.originalRequest)
      .filter((entry) => entry.capabilityId === decision.capabilityId);
    const suppliedPath = typeof decision.input.path === 'string' ? decision.input.path : '';
    const selected = requirements.find((entry) => (
      typeof entry.input.path === 'string'
      && sameTaskFilesystemPath(task, suppliedPath, entry.input.path)
    )) || (requirements.length === 1 ? requirements[0] : undefined);
    if (selected) {
      return rebindAgentExecutableDecisionInput(decision, capability, { ...selected.input });
    }
    return decision;
  }
  if (decision.capabilityId !== 'workspace.known-folder.write') return decision;
  const expected = parseKnownFolderFileRequest(task.goal.originalRequest);
  if (!expected) return decision;
  // Capability selection remains model-authored; the effect target, bytes and
  // Kernel verification are compiled only from the trusted original request.
  return rebindAgentExecutableDecisionInput(decision, capability, { ...expected });
}

function sameTaskFilesystemPath(task: AgentTask, left: string, right: string): boolean {
  if (!left || !right) return false;
  const root = task.executionProfile?.projectRoot || process.cwd();
  const canonical = (value: string): string => {
    const resolved = path.resolve(root, value).replace(/[\\/]+$/u, '');
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  return canonical(left) === canonical(right);
}

function effectiveTaskPermissionProfile(
  task: AgentTask,
  ambient: MonarchPermissionProfile,
): MonarchPermissionProfile {
  return task.executionProfile
    ? { ...task.executionProfile.permissionProfile }
    : ambient;
}

const CODER_PROJECT_PATH_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'coder.files.list': ['path'],
  'coder.files.read': ['path'],
  'coder.files.write': ['path'],
  'coder.files.patch': ['path'],
  'coder.files.delete': ['path'],
  'coder.command.run': ['cwd'],
  'coder.git.diff': ['path'],
  'coder.huggingface.download': ['destination'],
  'coder.huggingface.upload': ['localPath'],
});

function bindCoderExecutionProfileInput(
  task: AgentTask,
  decision: AgentExecutableDecision,
  capabilities: readonly MonarchCapability[],
): AgentExecutableDecision {
  if (task.source.surface !== 'coder') return decision;
  const profile = task.executionProfile;
  if (!profile) {
    throw new AgentDecisionValidationError(
      'coder-execution-profile-missing',
      'Coder actions require a trusted project execution profile.',
    );
  }
  if (/^coder\.projects\./u.test(decision.capabilityId)) {
    throw new AgentDecisionValidationError(
      'coder-project-control-forbidden',
      'The model cannot create, import, activate, or switch the Coder project bound to this task.',
    );
  }
  const input = { ...decision.input };
  if (decision.capabilityId.startsWith('coder.')) {
    const capability = capabilities.find((entry) => entry.id === decision.capabilityId);
    const properties = capability?.inputSchema?.properties || {};
    if (Object.hasOwn(properties, 'projectId')) input.projectId = profile.projectId;
    const boundPaths = new Map<string, string>();
    for (const field of CODER_PROJECT_PATH_FIELDS[decision.capabilityId] || []) {
      const value = input[field];
      if (typeof value === 'string' && value.trim()) {
        const resolved = assertCoderProjectPath(profile.projectRoot, value, `${decision.capabilityId}.${field}`);
        if (shouldCanonicalizeCoderPath(decision.capabilityId, field)) {
          input[field] = resolved;
          boundPaths.set(value, resolved);
        }
      }
    }
    if (decision.capabilityId === 'coder.git.stage' && Array.isArray(input.paths)) {
      for (const value of input.paths) {
        if (typeof value !== 'string') continue;
        assertCoderProjectPath(profile.projectRoot, value, 'coder.git.stage.paths');
      }
    }
    return {
      ...decision,
      input,
      ...(decision.preconditions ? { preconditions: bindCoderPathPredicates(decision.preconditions, boundPaths) } : {}),
      ...(decision.verification ? { verification: bindCoderPathPredicates(decision.verification, boundPaths) } : {}),
    };
  }
  if (decision.capabilityId === 'system.shell.run') {
    const cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
    if (!cwd || !path.isAbsolute(cwd)) {
      throw new AgentDecisionValidationError(
        'coder-shell-cwd-required',
        'Coder shell fallback requires one exact absolute cwd inside the bound project.',
      );
    }
    assertCoderProjectPath(profile.projectRoot, cwd, 'system.shell.run.cwd');
  }
  return { ...decision, input };
}

function assertCoderProjectPath(projectRoot: string, value: string, field: string): string {
  const resolved = path.resolve(projectRoot, value);
  const relative = path.relative(path.resolve(projectRoot), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AgentDecisionValidationError(
      'coder-project-scope-mismatch',
      `${field} must stay inside the runtime-bound Coder project.`,
    );
  }
  return resolved;
}

function shouldCanonicalizeCoderPath(capabilityId: string, field: string): boolean {
  return field !== 'path' || !capabilityId.startsWith('coder.git.');
}

function bindCoderPathPredicates(
  predicates: MonarchActionPredicate[],
  bindings: ReadonlyMap<string, string>,
): MonarchActionPredicate[] {
  if (bindings.size === 0) return predicates;
  return predicates.map((predicate) => {
    const target = [...bindings.entries()].find(([candidate]) => (
      candidate.replace(/\\/gu, '/').replace(/^\.\//u, '').toLocaleLowerCase('en-US')
      === predicate.target.replace(/\\/gu, '/').replace(/^\.\//u, '').toLocaleLowerCase('en-US')
    ))?.[1];
    return target ? { ...predicate, target } : predicate;
  });
}

function isRuntimeOwnedKnownFolderDecision(task: AgentTask, decision: AgentExecutableDecision): boolean {
  return decision.capabilityId === 'workspace.known-folder.write'
    && parseKnownFolderFileRequest(task.goal.originalRequest) !== null;
}

function isRuntimeOwnedWorkspaceBatchContinuationDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  if (decision.capabilityId !== 'workspace.files.inspect-batch') return false;
  const latest = [...checkpoint.observations].reverse().find((observation) => (
    observation.capabilityId === decision.capabilityId
    && (observation.status === 'success' || observation.status === 'partial')
  ));
  const binding = objectRecord(objectRecord(latest?.structuredData)?.runtimeBinding);
  const continuationInput = objectRecord(binding?.continuationInput);
  return binding?.kind === 'workspace-files-inspect-batch'
    && binding.exactReceipt === true
    && binding.complete === false
    && continuationInput !== null
    && JSON.stringify(continuationInput) === JSON.stringify(decision.input);
}

function isRuntimeOwnedWorkspaceKnownFolderPreludeDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  const knownFolder = requestedBatchKnownFolder(checkpoint.task.goal.originalRequest);
  return Boolean(
    knownFolder
    && requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
    && decision.capabilityId === 'workspace.known-folder.resolve'
    && decision.input.knownFolder === knownFolder
    && decision.reason === 'runtime-owned-known-folder-prelude'
    && !checkpoint.observations.some((entry) => entry.capabilityId === decision.capabilityId)
  );
}

function isRuntimeOwnedApplicationDiscoveryDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  const requirement = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest)
    .find((entry) => entry.capabilityId === 'device.app.open');
  const requestedApp = typeof requirement?.input.app === 'string'
    ? requirement.input.app.trim()
    : '';
  return Boolean(
    applicationDiscoveryRecoveryTriggered(checkpoint)
    && requestedApp
    && decision.capabilityId === 'device.apps.search'
    && decision.reason === 'runtime-owned-application-discovery'
    && decision.input.query === requestedApp
    && decision.input.limit === 5
    && Object.keys(decision.input).length === 2
    && !checkpoint.observations.some((entry) => entry.capabilityId === decision.capabilityId)
  );
}

function isRuntimeOwnedMutationReconciliationDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  if (decision.kind !== 'inspect' || decision.reason !== 'runtime-owned-mutation-reconciliation') return false;
  const sourceObservation = [...checkpoint.observations].reverse().find((observation) => {
    const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeReconciliationBinding);
    return binding?.schemaVersion === 1
      && binding.kind === 'mutation-postcondition-reconciliation'
      && binding.capabilityId === decision.capabilityId;
  });
  if (!sourceObservation) return false;
  const binding = objectRecord(objectRecord(sourceObservation.structuredData)?.runtimeReconciliationBinding);
  const input = objectRecord(binding?.input);
  return Boolean(
    input
    && binding?.sourceObservationId === sourceObservation.id
    && binding.inputCanonicalHash === canonicalProposalHash(canonicalizeActionIdentityArgs(
      input,
      agentActionIdentityRoot(checkpoint),
    ))
    && binding.inputCanonicalHash === canonicalProposalHash(canonicalizeActionIdentityArgs(
      decision.input,
      agentActionIdentityRoot(checkpoint),
    ))
  );
}

function isRuntimeOwnedWorkspaceBatchStartDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  const knownFolder = requestedBatchKnownFolder(checkpoint.task.goal.originalRequest);
  if (
    !knownFolder
    || !requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
    || decision.capabilityId !== 'workspace.files.inspect-batch'
    || decision.reason !== 'runtime-owned-pagination-start'
    || decision.input.knownFolder !== knownFolder
    || Object.keys(decision.input).length !== 1
    || checkpoint.observations.some((entry) => entry.capabilityId === decision.capabilityId)
  ) return false;
  return checkpoint.observations.some((observation) => {
    if (observation.capabilityId !== 'workspace.known-folder.resolve' || observation.status !== 'success') return false;
    const output = objectRecord(objectRecord(observation.structuredData)?.output);
    return output?.knownFolder === knownFolder
      && output.exists === true
      && output.directory === true;
  });
}

function isRuntimeOwnedBoundedRetryDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  if (decision.reason !== 'runtime-owned-bounded-retry' || decision.kind !== 'inspect') return false;
  const observation = checkpoint.observations.at(-1);
  const binding = objectRecord(objectRecord(observation?.structuredData)?.runtimeRetryBinding);
  const input = objectRecord(binding?.input);
  return Boolean(
    observation
    && observation.status !== 'success'
    && observation.retryable
    && binding?.schemaVersion === 1
    && binding.kind === 'bounded-idempotent-observation-retry'
    && binding.sourceObservationId === observation.id
    && binding.capabilityId === decision.capabilityId
    && binding.remainingAttempts === 1
    && input
    && binding.inputCanonicalHash === canonicalProposalHash(canonicalizeActionIdentityArgs(
      input,
      agentActionIdentityRoot(checkpoint),
    ))
    && JSON.stringify(input) === JSON.stringify(decision.input)
  );
}

function isRuntimeOwnedExactWorkspaceWriteDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  if (decision.capabilityId !== 'workspace.files.write') return false;
  return resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest).some((requirement) => (
    requirement.capabilityId === decision.capabilityId
    && operationalRequirementInputMatches(
      requirement,
      decision.capabilityId,
      decision.input,
      checkpoint.task.executionProfile?.projectRoot,
    )
  ));
}

function isRuntimeOwnedWorkspaceBatchSynthesisDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  if (
    !requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
    || decision.capabilityId !== 'models.agent.synthesize'
    || decision.reason !== 'runtime-owned-grounded-batch-synthesis'
    || Object.keys(decision.input).length !== 3
  ) return false;
  const ids = Array.isArray(decision.input.observationIds)
    ? decision.input.observationIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const pages = checkpoint.observations.filter((entry) => (
    entry.capabilityId === 'workspace.files.inspect-batch'
    && (entry.status === 'success' || entry.status === 'partial')
  ));
  return ids.length === pages.length
    && ids.every((id, index) => id === pages[index]?.id)
    && decision.input.request === checkpoint.task.goal.originalRequest
    && Array.isArray(decision.input.observations)
    && decision.input.observations.length === ids.length;
}

function isRuntimeOwnedGroundedSynthesisDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  if (
    decision.capabilityId !== 'models.agent.synthesize'
    || decision.reason !== 'runtime-owned-grounded-synthesis'
    || Object.keys(decision.input).length !== 3
  ) return false;
  const expectedIds = groundedSynthesisObservationIds(checkpoint);
  const actualIds = Array.isArray(decision.input.observationIds)
    ? decision.input.observationIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return expectedIds.length > 0
    && actualIds.length === expectedIds.length
    && actualIds.every((id, index) => id === expectedIds[index])
    && decision.input.request === checkpoint.task.goal.originalRequest
    && Array.isArray(decision.input.observations)
    && decision.input.observations.length === expectedIds.length;
}

function isRuntimeOwnedDirectOperationalDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  const plan = checkpoint.task.plan;
  if (!plan || !isTrustedDirectOperationalRuntimePlan(plan)) return false;
  const requirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  return requirements.length === 1
    && operationalRequirementInputMatches(
      requirements[0]!,
      decision.capabilityId,
      decision.input,
      checkpoint.task.executionProfile?.projectRoot,
    );
}

function isRuntimeOwnedComputerUseDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  const plan = checkpoint.task.plan;
  const goal = parseTrustedComputerUseWindowGoal(checkpoint.task.goal.originalRequest);
  if (!plan || !goal || !isTrustedComputerUseRuntimePlan(plan)) return false;
  const step = currentAgentPlanStep(plan, checkpoint.task.currentStepId);
  if (step?.title === TRUSTED_COMPUTER_USE_RESOLVE_STEP) {
    const targetMatches = goal.targetKind === 'exact-title'
      ? decision.input.exactTitle === goal.target && decision.input.titleQuery === undefined
      : decision.input.titleQuery === goal.target && decision.input.exactTitle === undefined;
    return decision.kind === 'inspect'
      && decision.capabilityId === 'computer.windows.list'
      && targetMatches
      && decision.input.limit === 2
      && Object.keys(decision.input).length === 2;
  }
  if (step?.title === TRUSTED_COMPUTER_USE_EFFECT_STEP && goal.effectKind === 'close') {
    const resolution = trustedComputerUseWindowResolution(checkpoint, goal);
    const observationId = resolution.status === 'unique'
      ? trustedComputerUseObservationId(checkpoint, resolution.windowRef)
      : '';
    return decision.kind === 'act'
      && decision.capabilityId === 'computer.window.close'
      && resolution.status === 'unique'
      && decision.input.windowRef === resolution.windowRef
      && decision.input.observationId === observationId
      && Object.keys(decision.input).length === 2;
  }
  if (step?.title !== TRUSTED_COMPUTER_USE_OBSERVE_STEP || decision.capabilityId !== 'computer.window.observe') {
    return false;
  }
  const resolution = trustedComputerUseWindowResolution(checkpoint, goal);
  return decision.kind === 'inspect'
    && resolution.status === 'unique'
    && decision.input.windowRef === resolution.windowRef
    && decision.input.captureNonce === step.id
    && Object.keys(decision.input).length === 2;
}

function isRuntimeOwnedComputerUseWorkflowDecision(
  checkpoint: AgentTaskCheckpoint,
  decision: AgentExecutableDecision,
): boolean {
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  const plan = checkpoint.task.plan;
  if (!workflow || !plan || !isTrustedComputerUseWorkflowPlan(plan, workflow)) return false;
  const step = currentAgentPlanStep(plan, checkpoint.task.currentStepId);
  const applicationQuery = trustedComputerUseWorkflowApplicationQuery(checkpoint, workflow);
  if (step?.title === TRUSTED_COMPUTER_USE_WORKFLOW_LAUNCH_STEP) {
    return decision.kind === 'act'
      && decision.capabilityId === 'device.app.open'
      && decision.input.app === workflow.application
      && Object.keys(decision.input).length === 1;
  }
  if (step?.title === TRUSTED_COMPUTER_USE_WORKFLOW_RESOLVE_STEP) {
    return decision.kind === 'inspect'
      && decision.capabilityId === 'computer.windows.list'
      && decision.input.titleQuery === applicationQuery
      && decision.input.limit === 1
      && Object.keys(decision.input).length === 2;
  }
  const resolution = trustedComputerUseWorkflowWindowResolution(checkpoint, workflow);
  if (resolution.status !== 'unique') return false;
  const latest = trustedComputerUseWorkflowLatestObservation(checkpoint, resolution.windowRef);
  if (step?.title === TRUSTED_COMPUTER_USE_WORKFLOW_OBSERVE_STEP) {
    return decision.kind === 'inspect'
      && decision.capabilityId === 'computer.window.observe'
      && decision.input.windowRef === resolution.windowRef
      && decision.input.captureNonce === step.id
      && Object.keys(decision.input).length === 2;
  }
  if (!latest) return false;
  if (trustedComputerUseWorkflowCalculatorKeyIndex(step?.title || '') >= 0) {
    const keyIndex = trustedComputerUseWorkflowCalculatorKeyIndex(step?.title || '');
    return decision.kind === 'act'
      && decision.capabilityId === 'computer.window.key'
      && decision.input.windowRef === resolution.windowRef
      && decision.input.observationId === latest.observationId
      && decision.input.key === workflow.calculation?.keySequence[keyIndex]
      && Array.isArray(decision.input.modifiers)
      && decision.input.modifiers.length === 0
      && Object.keys(decision.input).length === 4;
  }
  if (step?.title === TRUSTED_COMPUTER_USE_WORKFLOW_VERIFY_STEP) {
    return decision.kind === 'inspect'
      && decision.capabilityId === 'computer.window.verify-text'
      && decision.input.windowRef === resolution.windowRef
      && decision.input.observationId === latest.observationId
      && decision.input.expectedText === workflow.expectedText
      && Object.keys(decision.input).length === 3;
  }
  return false;
}

function blocksTrustedComputerUseWorkflowAutoCompletion(
  checkpoint: AgentTaskCheckpoint,
  observation: AgentObservation,
): boolean {
  // A batch page is evidence, never the user-facing result. Even the terminal
  // page must return to the model so it can synthesize across every current-task
  // observation and explicitly disclose skipped/unsupported files.
  if (observation.capabilityId === 'workspace.files.inspect-batch') return true;
  if (
    observation.capabilityId === 'workspace.known-folder.resolve'
    && requestRequiresWorkspaceBatchSynthesis(checkpoint.task.goal.originalRequest)
  ) return true;
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  return Boolean(
    workflow
    && checkpoint.task.plan
    && isTrustedComputerUseWorkflowPlan(checkpoint.task.plan, workflow)
    && !(
      observation.capabilityId === 'computer.window.verify-text'
      && objectRecord(objectRecord(observation.structuredData)?.runtimeBinding)?.safeAutoCompletion === true
    )
  );
}

function observationProvesVerifiedMutation(observation: AgentObservation): boolean {
  const receipt = objectRecord(objectRecord(observation.structuredData)?.verificationReceipt);
  return observation.status === 'success'
    && observationMutationTruth(observation) === 'occurred'
    && observationSideEffects(observation).length > 0
    && receipt?.schemaVersion === 1
    && receipt.exact === true
    && typeof receipt.proposalCanonicalHash === 'string'
    && observation.evidence.some((entry) => (
      entry.evidenceClass === 'kernel-verification'
      && /:verification:/iu.test(entry.reference)
      && !/^Verification failed:/iu.test(String(entry.summary || ''))
    ));
}

function observationProvesVerifiedGoalMutation(
  checkpoint: AgentTaskCheckpoint,
  observation: AgentObservation,
): boolean {
  if (observationProvesVerifiedMutation(observation)) return true;
  const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeBinding);
  if (
    binding?.kind === 'mutation-postcondition-reconciliation'
    && binding.exactTarget === true
    && binding.stateSatisfied === true
    && typeof binding.sourceObservationId === 'string'
  ) {
    const source = checkpoint.observations.find((entry) => entry.id === binding.sourceObservationId);
    const sourceBinding = objectRecord(objectRecord(source?.structuredData)?.runtimeReconciliationBinding);
    return Boolean(
      source
      && sourceBinding?.schemaVersion === 1
      && sourceBinding.kind === 'mutation-postcondition-reconciliation'
      && sourceBinding.sourceObservationId === source.id
      && sourceBinding.sourceCapabilityId === binding.sourceCapabilityId
      && sourceBinding.sourceProposalCanonicalHash === binding.sourceProposalCanonicalHash
      && observation.status === 'success'
      && hasKernelEvidence(observation)
    );
  }
  const workflow = parseTrustedComputerUseWorkflow(checkpoint.task.goal.originalRequest);
  if (
    !workflow
    || binding?.kind !== 'computer-window-text-verification'
    || binding.exactReceipt !== true
    || binding.safeAutoCompletion !== true
  ) return false;
  return checkpoint.observations.some((entry) => {
    const actionBinding = objectRecord(objectRecord(entry.structuredData)?.runtimeBinding);
    return actionBinding?.kind === 'computer-window-workflow-action'
      && actionBinding.exactReceipt === true
      && observationProvesVerifiedMutation(entry);
  });
}

function buildVerifiedActionCompletionDecision(
  checkpoint: AgentTaskCheckpoint,
  observation: AgentObservation,
  _artifacts: AgentArtifactReference[],
  groundedSynthesisAvailable: boolean,
): Extract<AgentDecision, { kind: 'complete' }> | null {
  const plainResponse = plainAgentResponseReceipt(checkpoint, observation);
  const requiredOutputs = checkpoint.task.goal.expectedOutputs.filter((entry) => entry.required !== false);
  if (plainResponse && requiredOutputs.every((entry) => entry.kind === 'answer')) {
    const evidenceBindings = [
      ...requiredOutputs.map((output) => ({
        targetType: 'expected-output' as const,
        targetId: output.id,
        observationIds: [observation.id],
        artifactIds: [],
      })),
      ...checkpoint.task.goal.successCriteria.map((criterion) => ({
        targetType: 'success-criterion' as const,
        targetId: criterion.id,
        observationIds: [observation.id],
        artifactIds: [],
      })),
    ];
    return {
      kind: 'complete',
      summary: plainResponse.rawText,
      evidenceObservationIds: [observation.id],
      artifactIds: [],
      evidenceBindings,
    };
  }
  const synthesized = groundedSynthesisReceipt(checkpoint, observation);
  if (synthesized) {
    const requiredOutputs = checkpoint.task.goal.expectedOutputs.filter((entry) => entry.required !== false);
    if (requiredOutputs.length === 0 || requiredOutputs.some((entry) => entry.kind !== 'answer')) return null;
    const sourceObservations = synthesized.sourceObservationIds
      .map((id) => checkpoint.observations.find((entry) => entry.id === id))
      .filter((entry): entry is AgentObservation => Boolean(entry));
    const outputBindings = requiredOutputs.map((output) => {
      const matching = sourceObservations.filter((entry) => (
        observationMatchesGoalTarget(checkpoint, 'expected-output', output.description, entry)
      ));
      return matching.length > 0
        && observationsCoverEveryResourceAnchor(checkpoint, output.description, matching) ? {
        targetType: 'expected-output' as const,
        targetId: output.id,
        observationIds: matching.map((entry) => entry.id),
        artifactIds: [],
      } : null;
    });
    const criterionBindings = checkpoint.task.goal.successCriteria.map((criterion) => {
      const matching = sourceObservations.filter((entry) => (
        observationMatchesVerificationTarget(checkpoint, 'success-criterion', criterion.description, entry)
      ));
      return matching.length > 0
        && observationsCoverEveryResourceAnchor(checkpoint, criterion.description, matching) ? {
        targetType: 'success-criterion' as const,
        targetId: criterion.id,
        observationIds: matching.map((entry) => entry.id),
        artifactIds: [],
      } : null;
    });
    if ([...outputBindings, ...criterionBindings].some((entry) => entry === null)) return null;
    const evidenceBindings = [...outputBindings, ...criterionBindings]
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    return {
      kind: 'complete',
      summary: synthesized.rawText,
      evidenceObservationIds: [...new Set([...synthesized.sourceObservationIds, observation.id])],
      artifactIds: [],
      evidenceBindings,
    };
  }
  const requiredAnswers = checkpoint.task.goal.expectedOutputs.filter((entry) => (
    entry.required !== false && entry.kind === 'answer'
  ));
  if (
    requiredAnswers.length > 0
    && groundedSynthesisAvailable
    && requestRequiresKernelObservation(checkpoint.task.goal.originalRequest)
    && !plainResponse
  ) {
    // A Kernel observation proves the local fact, but it is not itself a
    // user-facing answer. Keep the task running until models.agent.synthesize
    // returns text bound to the exact current-task observation ids. This also
    // keeps instructions embedded in files/tool output as inert evidence.
    return null;
  }
  if (!agentOperationalRequirementsSatisfied(checkpoint)) return null;
  if (observation.status !== 'success' || (!hasKernelEvidence(observation) && !plainResponse)) return null;
  const legacyEffectKind = inferredLegacyEffectKind(checkpoint.task);
  const criteria = checkpoint.task.goal.successCriteria;
  if (requiredOutputs.length === 0 && criteria.length === 0) return null;
  const candidates = checkpoint.observations.filter((entry) => (
    entry.status === 'success'
    && (
      (hasKernelEvidence(entry) && observationMatchesTypedOperationalTarget(checkpoint, entry))
      || plainAgentResponseReceipt(checkpoint, entry) !== null
    )
  ));
  const outputBindings = requiredOutputs.map((output) => {
    const effectRequired = requiresVerifiedMutation(output.kind) || legacyEffectKind !== null;
    const observations = candidates.filter((entry) => (
      observationMatchesGoalTarget(checkpoint, 'expected-output', output.description, entry)
      && (!effectRequired || observationProvesVerifiedGoalMutation(checkpoint, entry))
    ));
    const artifactRequired = output.kind === 'artifact' || legacyEffectKind === 'artifact';
    const matchingArtifacts = artifactRequired
      ? checkpoint.task.artifacts.filter((artifact) => (
        artifactMatchesBoundGoalArtifact(checkpoint, artifact, output.description)
      ))
      : [];
    if (
      observations.length === 0
      || !observationsCoverEveryResourceAnchor(checkpoint, output.description, observations)
      || (artifactRequired && matchingArtifacts.length === 0)
    ) return null;
    return {
      targetType: 'expected-output' as const,
      targetId: output.id,
      observationIds: observations.map((entry) => entry.id),
      artifactIds: matchingArtifacts.map((entry) => entry.id),
    };
  });
  if (outputBindings.some((entry) => entry === null)) return null;
  const criterionBindings = criteria.map((criterion) => {
    const criterionRequiresEffect = targetDescriptionMatchesAnyEffectfulOperationalRequirement(
      checkpoint,
      criterion.description,
    );
    const observations = candidates.filter((entry) => (
      observationMatchesVerificationTarget(checkpoint, 'success-criterion', criterion.description, entry)
      && (!criterionRequiresEffect || observationProvesVerifiedGoalMutation(checkpoint, entry))
    ));
    if (
      observations.length === 0
      || !observationsCoverEveryResourceAnchor(checkpoint, criterion.description, observations)
    ) return null;
    return {
      targetType: 'success-criterion' as const,
      targetId: criterion.id,
      observationIds: observations.map((entry) => entry.id),
      artifactIds: [],
    };
  });
  if (criterionBindings.some((entry) => entry === null)) return null;

  const evidenceBindings = [...outputBindings, ...criterionBindings].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const evidenceObservationIds = [...new Set(evidenceBindings.flatMap((entry) => entry.observationIds))];
  const artifactIds = [...new Set(evidenceBindings.flatMap((entry) => entry.artifactIds))];
  const decision: Extract<AgentDecision, { kind: 'complete' }> = {
    kind: 'complete',
    summary: artifactIds.length > 0
      ? `Созданы и проверены: ${checkpoint.task.artifacts
        .filter((entry) => artifactIds.includes(entry.id))
        .map((entry) => entry.reference)
        .join(', ')}.`
      : observation.summary,
    evidenceObservationIds,
    artifactIds,
    evidenceBindings,
  };
  const groundedSummary = groundedAnswerCompletionSummary(checkpoint, decision);
  const answerOutputs = requiredOutputs.filter((entry) => entry.kind === 'answer');
  if (answerOutputs.length > 0 && !groundedSummary) return null;
  return groundedSummary ? { ...decision, summary: groundedSummary } : decision;
}

function pendingApproval(checkpoint: AgentTaskCheckpoint): AgentApproval | null {
  return checkpoint.approvals.find((entry) => entry.id === checkpoint.task.activeApprovalId && entry.status === 'pending') || null;
}

function requiresTaskBoundApproval(
  task: AgentTask,
  decision: AgentExecutableDecision,
  capability: MonarchCapability,
): boolean {
  if (task.actionApprovalPolicy !== 'all-effects') return false;
  if (decision.kind === 'act') return true;
  return capability.risk !== 'none' && capability.risk !== 'read';
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
  return {
    task: withCurrentStep(task, undefined),
    changed: task.currentStepId !== undefined,
  };
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
    ...(approval.purpose ? { purpose: approval.purpose } : {}),
    ...(approval.policyDecisionHash ? { policyDecisionHash: approval.policyDecisionHash } : {}),
    ...(approval.authorityTierAtRequest ? { authorityTierAtRequest: approval.authorityTierAtRequest } : {}),
  };
}

function approvalPolicyMetadata(result: AgentActionGatewayResult): {
  purpose: 'policy' | 'owner-security-override';
  policyDecisionHash?: string;
  authorityTierAtRequest?: 'public' | 'owner';
} {
  const metadata = result.result.metadata && typeof result.result.metadata === 'object'
    ? result.result.metadata as Record<string, unknown>
    : {};
  const policy = metadata.policy && typeof metadata.policy === 'object'
    ? metadata.policy as Record<string, unknown>
    : {};
  const policyDecisionHash = typeof policy.policyDecisionHash === 'string' && /^[a-f0-9]{64}$/u.test(policy.policyDecisionHash)
    ? policy.policyDecisionHash
    : undefined;
  const authorityTierAtRequest = policy.authorityTier === 'owner' || policy.authorityTier === 'public'
    ? policy.authorityTier
    : undefined;
  const purpose = metadata.securityOverride === true && authorityTierAtRequest === 'owner'
    ? 'owner-security-override'
    : 'policy';
  return {
    purpose,
    ...(policyDecisionHash ? { policyDecisionHash } : {}),
    ...(authorityTierAtRequest ? { authorityTierAtRequest } : {}),
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
  let reference = '';
  let kind: AgentArtifactReference['kind'] = 'report';
  if ((capability.id === 'workspace.files.write'
      || capability.id === 'coder.files.write'
      || capability.id === 'coder.files.patch')
    && typeof decision.input.path === 'string') {
    reference = decision.input.path;
    kind = 'file';
  } else if (capability.id === 'workspace.known-folder.write') {
    const structured = observation.structuredData;
    const output = structured && typeof structured === 'object' && !Array.isArray(structured)
      ? structured.output
      : undefined;
    if (output && typeof output === 'object' && !Array.isArray(output) && typeof output.path === 'string') {
      reference = output.path;
      kind = 'file';
    }
  }
  if (!reference) return [];
  return [{
    id: createMonarchId('agent_artifact'),
    kind,
    label: reference.split(/[\\/]/).at(-1) || 'verified file',
    reference,
    createdAt: observation.occurredAt,
  }];
}

function mergeArtifacts(current: AgentArtifactReference[], additions: AgentArtifactReference[]): AgentArtifactReference[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of additions) merged.set(entry.id, entry);
  return [...merged.values()];
}

interface AgentKernelVerificationReceiptV1 {
  schemaVersion: 1;
  proposalCanonicalHash: string;
  exact: boolean;
  expectedPredicateHashes: string[];
  successfulPredicateHashes: string[];
  missingPredicateHashes: string[];
}

function buildKernelVerificationReceipt(
  metadata: Record<string, unknown> | undefined,
  requiredPredicates: readonly MonarchActionPredicate[],
  proposalCanonicalHash: string,
): AgentKernelVerificationReceiptV1 {
  const expectedPredicateHashes = [...new Set(requiredPredicates.map((predicate) => (
    canonicalProposalHash(predicate)
  )))];
  const observations = metadata?.observations;
  const successful = new Set<string>();
  if (Array.isArray(observations)) {
    for (const entry of observations) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (
        record.phase !== 'verification'
        || record.ok !== true
        || !record.predicate
        || typeof record.predicate !== 'object'
        || Array.isArray(record.predicate)
      ) continue;
      successful.add(canonicalProposalHash(record.predicate));
    }
  }
  const successfulPredicateHashes = expectedPredicateHashes.filter((hash) => successful.has(hash));
  const missingPredicateHashes = expectedPredicateHashes.filter((hash) => !successful.has(hash));
  return {
    schemaVersion: 1,
    proposalCanonicalHash,
    exact: missingPredicateHashes.length === 0,
    expectedPredicateHashes,
    successfulPredicateHashes,
    missingPredicateHashes,
  };
}

function bindCapabilityOwnedVerification(
  decision: AgentExecutableDecision,
  descriptors: ReturnType<typeof resolveAgentCapabilityMetadata>['verification'],
): AgentExecutableDecision {
  const required = descriptors.flatMap((descriptor) => (
    descriptor.required !== false && descriptor.predicate ? [{ ...descriptor.predicate }] : []
  ));
  if (required.length === 0) return decision;
  const merged: MonarchActionPredicate[] = [];
  const seen = new Set<string>();
  for (const predicate of [...required, ...(decision.verification || [])]) {
    const key = canonicalProposalHash(predicate);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(predicate);
  }
  return { ...decision, verification: merged };
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
  outputKind: AgentTask['goal']['expectedOutputs'][number]['kind'] | undefined,
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
    && observations.every((entry) => entry?.status === 'success' && (
      hasKernelEvidence(entry) || plainAgentResponseReceipt(checkpoint, entry) !== null
    ));
  const artifactsValid = artifacts.every(Boolean)
    && binding.artifactIds.every((id) => observations.some((entry) => entry?.artifacts.some((artifact) => artifact.id === id)));
  const legacyEffectKind = inferredLegacyEffectKind(checkpoint.task);
  const artifactRequired = outputKind === 'artifact'
    || (targetType === 'expected-output' && legacyEffectKind === 'artifact');
  const answerRequired = outputKind === 'answer';
  const effectRequired = requiresVerifiedMutation(outputKind)
    || (targetType === 'expected-output' && legacyEffectKind !== null)
    || (targetType === 'success-criterion' && targetDescriptionMatchesAnyEffectfulOperationalRequirement(
      checkpoint,
      targetDescription,
    ));
  const artifactTargetValid = !artifactRequired || (
    artifacts.length > 0
    && artifacts.every((artifact) => artifactMatchesBoundGoalArtifact(checkpoint, artifact!, targetDescription))
  );
  const targetObservations = observations.filter((observation): observation is AgentObservation => Boolean(
    observation
    && observationMatchesVerificationTarget(checkpoint, targetType, targetDescription, observation)
    && (
      plainAgentResponseReceipt(checkpoint, observation) !== null
      || observationMatchesTypedOperationalTarget(checkpoint, observation)
    )
    && (!effectRequired || observationProvesVerifiedGoalMutation(checkpoint, observation)),
  ));
  const evidenceTargetValid = targetObservations.length > 0;
  const synthesizedAnswer = groundedSynthesisCompletionSummary(
    checkpoint,
    decision,
    new Set(targetObservations.map((entry) => entry.id)),
  );
  const answerGrounded = !answerRequired
    || Boolean(synthesizedAnswer)
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

function plainAgentResponseCompletionSummary(
  checkpoint: AgentTaskCheckpoint,
  decision: Extract<AgentDecision, { kind: 'complete' }>,
): string | undefined {
  const declaredIds = new Set([
    ...decision.evidenceObservationIds,
    ...decision.evidenceBindings.flatMap((entry) => entry.observationIds),
  ]);
  for (const observation of [...checkpoint.observations].reverse()) {
    if (!declaredIds.has(observation.id)) continue;
    const receipt = plainAgentResponseReceipt(checkpoint, observation);
    if (receipt) return receipt.rawText;
  }
  return undefined;
}

function groundedSynthesisReceipt(
  checkpoint: AgentTaskCheckpoint,
  observation: AgentObservation,
): { rawText: string; sourceObservationIds: string[] } | null {
  if (observation.capabilityId !== 'models.agent.synthesize' || observation.status !== 'success') return null;
  const structured = objectRecord(observation.structuredData);
  const output = objectRecord(structured?.output);
  const binding = objectRecord(structured?.runtimeBinding);
  const rawText = typeof output?.rawText === 'string' ? output.rawText.trim() : '';
  const sourceObservationIds = Array.isArray(output?.sourceObservationIds)
    ? [...new Set(output.sourceObservationIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
    : [];
  const boundIds = Array.isArray(binding?.sourceObservationIds)
    ? binding.sourceObservationIds.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (
    binding?.kind !== 'grounded-synthesis'
    || binding.exactSourceBinding !== true
    || binding.batchCoverageComplete !== true
    || !rawText
    || binding.rawTextSha256 !== sha256Text(rawText)
    || sourceObservationIds.length === 0
    || sourceObservationIds.length !== boundIds.length
    || !sourceObservationIds.every((id) => boundIds.includes(id))
  ) return null;
  const sources = sourceObservationIds.map((id) => checkpoint.observations.find((entry) => entry.id === id));
  if (sources.some((entry) => !entry
    || (entry.status !== 'success' && entry.status !== 'partial')
    || !hasKernelEvidence(entry))) return null;
  return { rawText, sourceObservationIds };
}

function plainAgentResponseReceipt(
  checkpoint: AgentTaskCheckpoint,
  observation: AgentObservation | undefined,
): { rawText: string } | null {
  if (
    !observation
    || observation.capabilityId !== 'models.agent.respond'
    || observation.status !== 'success'
    || (
      requestRequiresKernelObservation(checkpoint.task.goal.originalRequest)
      && !mixedTaskMayUsePlainResponse(checkpoint)
    )
  ) return null;
  const requiredOutputs = checkpoint.task.goal.expectedOutputs.filter((entry) => entry.required !== false);
  if (requiredOutputs.length === 0 || !requiredOutputs.some((entry) => entry.kind === 'answer')) return null;
  const output = objectRecord(objectRecord(observation.structuredData)?.output);
  const rawText = typeof output?.rawText === 'string' ? output.rawText.trim() : '';
  if (
    output?.ok !== true
    || !rawText
    || !observation.evidence.some((entry) => entry.evidenceClass === 'model-generated')
  ) return null;
  return { rawText };
}

function groundedSynthesisCompletionSummary(
  checkpoint: AgentTaskCheckpoint,
  decision: Extract<AgentDecision, { kind: 'complete' }>,
  allowedObservationIds?: ReadonlySet<string>,
): string | undefined {
  const declaredIds = new Set([
    ...decision.evidenceObservationIds,
    ...decision.evidenceBindings.flatMap((entry) => entry.observationIds),
  ]);
  for (const observation of [...checkpoint.observations].reverse()) {
    const receipt = groundedSynthesisReceipt(checkpoint, observation);
    if (!receipt) continue;
    if (!receipt.sourceObservationIds.every((id) => declaredIds.has(id))) continue;
    if (allowedObservationIds && !receipt.sourceObservationIds.every((id) => allowedObservationIds.has(id))) continue;
    return receipt.rawText;
  }
  return undefined;
}

function requestRequiresWorkspaceBatchSynthesis(request: string): boolean {
  const normalized = request.normalize('NFKC').toLocaleLowerCase();
  const requestsFiles = /\b(?:files?|documents?)\b|файл|документ/iu.test(normalized);
  const requestsCompleteSet = /\b(?:all|every)\b|все[а-яё]*/iu.test(normalized);
  const requestsCollection = /\b(?:desktop|folder|directory)\b|рабоч[а-яё]*\s+стол|папк|директор/iu.test(normalized);
  return requestsFiles && requestsCompleteSet && requestsCollection;
}

function requestedBatchKnownFolder(request: string): 'desktop' | 'downloads' | null {
  const normalized = request.normalize('NFKC').toLocaleLowerCase();
  if (/\bdesktop\b|рабоч[а-яё]*\s+стол/iu.test(normalized)) return 'desktop';
  if (/\bdownloads?\b|загрузк/iu.test(normalized)) return 'downloads';
  return null;
}

function observationMatchesGoalTarget(
  checkpoint: AgentTaskCheckpoint,
  _targetType: AgentVerificationRecord['targetType'],
  targetDescription: string,
  observation: AgentObservation,
): boolean {
  if (plainAgentResponseReceipt(checkpoint, observation)) {
    return !targetDescriptionMatchesAnyOperationalRequirement(checkpoint, targetDescription);
  }
  if (!observationMatchesTypedOperationalTarget(checkpoint, observation)) return false;
  if (computerUseRuntimeBindingProvesTarget(observation, targetDescription)) return true;
  const operationalRequirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  if (operationalRequirements.length > 0) {
    return operationalRequirements.some((requirement) => (
      (
        operationalRequirementMatches(requirement, observation.capabilityId, observationOutput(observation))
        || reconciliationObservationMatchesOperationalRequirement(checkpoint, observation, requirement)
      )
      && targetDescriptionMatchesOperationalInput(
        targetDescription,
        requirement.input,
        requirement.capabilityId,
        objectRecord(observationOutput(observation)) || undefined,
      )
    ));
  }
  const knownFolderTarget = resolveKnownFolderRequestTarget(checkpoint.task.goal.originalRequest);
  if (knownFolderTarget) {
    return targetDescriptionMatchesOperationalInput(
      targetDescription,
      { ...knownFolderTarget },
      'workspace.known-folder.write',
    );
  }
  const evidenceDescription = targetDescription;
  const capabilityId = normalizeEvidenceText(observation.capabilityId);
  const resourceAnchors = extractEvidenceResourceAnchors(evidenceDescription)
    .filter((entry) => entry !== capabilityId);
  const primaryActionTarget = readObservationActionTarget(observation);
  const observedTargets = primaryActionTarget ? [primaryActionTarget] : observationResourceTargets(observation);
  if (resourceAnchors.length > 0) {
    return resourceAnchors.some((anchor) => observedTargets.some((target) => evidenceTargetMatches(
      anchor,
      target,
      checkpoint.task.executionProfile?.projectRoot,
    )));
  }

  const normalizedDescription = normalizeEvidenceText(evidenceDescription);
  if (primaryActionTarget && containsEvidenceToken(normalizedDescription, primaryActionTarget)) return true;
  if (capabilityId.length >= 3 && containsEvidenceToken(normalizedDescription, capabilityId)) return true;
  if (observation.artifacts.some((artifact) => artifactMatchesGoalDescription(artifact, evidenceDescription))) return true;
  // An effectful goal without a runtime-owned target contract must remain
  // incomplete. Model-selected semantics and an unrelated Kernel receipt are
  // never enough to prove the user's requested effect.
  return !taskRequiresVerifiedMutation(checkpoint.task)
    && observation.status === 'success'
    && hasKernelEvidence(observation);
}

function targetDescriptionMatchesAnyOperationalRequirement(
  checkpoint: AgentTaskCheckpoint,
  targetDescription: string,
): boolean {
  const requirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  if (requirements.some((requirement) => targetDescriptionMatchesOperationalInput(
    targetDescription,
    requirement.input,
    requirement.capabilityId,
  ))) return true;
  const knownFolderTarget = resolveKnownFolderRequestTarget(checkpoint.task.goal.originalRequest);
  return Boolean(knownFolderTarget && targetDescriptionMatchesOperationalInput(
    targetDescription,
    { ...knownFolderTarget },
    'workspace.known-folder.write',
  ));
}

function targetDescriptionMatchesAnyEffectfulOperationalRequirement(
  checkpoint: AgentTaskCheckpoint,
  targetDescription: string,
): boolean {
  const requirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  if (requirements.some((requirement) => requirement.effectful && targetDescriptionMatchesOperationalInput(
    targetDescription,
    requirement.input,
    requirement.capabilityId,
  ))) return true;
  const knownFolderTarget = resolveKnownFolderRequestTarget(checkpoint.task.goal.originalRequest);
  return Boolean(knownFolderTarget && targetDescriptionMatchesOperationalInput(
    targetDescription,
    { ...knownFolderTarget },
    'workspace.known-folder.write',
  ));
}

function targetDescriptionMatchesOperationalInput(
  targetDescription: string,
  input: Record<string, unknown>,
  capabilityId: string,
  observedOutput?: Record<string, unknown>,
): boolean {
  const normalizedDescription = normalizeEvidenceText(targetDescription);
  const compactDescription = normalizedDescription.replace(/\s+/gu, '');
  const inputValues = Object.entries(input)
    .filter(([key]) => !(
      capabilityId === 'workspace.storage.audit'
      && ['topN', 'maxDepth', 'maxEntries', 'maxWallTimeMs'].includes(key)
    ))
    .map(([, value]) => value);
  const meaningfulValues = [...inputValues, ...Object.values(observedOutput || {})].flatMap((value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
    if (typeof value !== 'string') return [];
    const normalized = normalizeEvidenceText(value);
    if (normalized.length < 2) return [];
    const leaf = path.win32.basename(value);
    const stem = normalizeEvidenceText(leaf.replace(/\.[^.]+$/u, ''));
    return stem.length >= 2 && stem !== normalized ? [normalized, stem] : [normalized];
  });
  if (meaningfulValues.some((value) => (
    containsEvidenceToken(normalizedDescription, value)
    || compactDescription.includes(value.replace(/\s+/gu, ''))
  ))) return true;
  const semanticCapabilityTokens = capabilityId
    .split('.')
    .map((entry) => normalizeEvidenceText(entry))
    .filter((entry) => entry.length >= 3 && ![
      'device', 'workspace', 'files', 'file', 'known', 'folder', 'set', 'get', 'read', 'write',
    ].includes(entry));
  return meaningfulValues.length === 0
    && semanticCapabilityTokens.length > 0
    && semanticCapabilityTokens.every((token) => containsEvidenceToken(normalizedDescription, token));
}

function observationsCoverEveryResourceAnchor(
  checkpoint: AgentTaskCheckpoint,
  targetDescription: string,
  observations: readonly AgentObservation[],
): boolean {
  const anchors = extractEvidenceResourceAnchors(targetDescription);
  if (anchors.length <= 1) return true;
  const targets = observations.flatMap((observation) => {
    const primary = readObservationActionTarget(observation);
    return primary ? [primary] : observationResourceTargets(observation);
  });
  return anchors.every((anchor) => targets.some((target) => evidenceTargetMatches(
    anchor,
    target,
    checkpoint.task.executionProfile?.projectRoot,
  )));
}

function observationMatchesVerificationTarget(
  checkpoint: AgentTaskCheckpoint,
  targetType: AgentVerificationRecord['targetType'],
  targetDescription: string,
  observation: AgentObservation,
): boolean {
  if (observationMatchesGoalTarget(checkpoint, targetType, targetDescription, observation)) return true;
  if (targetType !== 'success-criterion') return false;
  // A criterion that names its own file/URL/resource is an independent target;
  // it must never inherit evidence from a different required output.
  if (extractEvidenceResourceAnchors(targetDescription).length > 0) return false;
  const requiredOutputs = checkpoint.task.goal.expectedOutputs.filter((output) => output.required !== false);
  return requiredOutputs.length > 0 && requiredOutputs.some((output) => (
    observationMatchesGoalTarget(checkpoint, 'expected-output', output.description, observation)
  ));
}

function hasKernelEvidence(observation: AgentObservation | undefined): boolean {
  return Boolean(observation?.evidence.some((entry) => (
    entry.evidenceClass === 'kernel-observation' || entry.evidenceClass === 'kernel-verification'
  )));
}

function extractEvidenceResourceAnchors(value: string): string[] {
  const description = String(value || '');
  const exactWindowsPaths = [...description.matchAll(
    /[A-Za-z]:[\\/][^<>:"|?*\r\n]*?\.[A-Za-z0-9]{1,12}(?=$|[\s,;.!?)])/gu,
  )];
  const masked = [...description];
  for (const match of exactWindowsPaths) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    for (let index = start; index < start + match[0].length; index += 1) masked[index] = ' ';
  }
  const matches = [
    ...exactWindowsPaths.map((entry) => entry[0]),
    ...(masked.join('').match(
    /https?:\/\/[^\s"'<>]+|(?:[A-Za-z]:)?(?:[\\/][\p{L}\p{N}._~:@%+,=-]+)+|[\p{L}\p{N}_-]+(?:[\\/][\p{L}\p{N}._~:@%+,=-]+)+|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+/gu,
    ) || []),
  ];
  const pathLanguage = /\b(path|file|folder|directory|target|resource)\b|(?:путь|файл|папк|каталог|директор)/iu.test(description);
  return [...new Set(matches
    .map((entry) => normalizeEvidenceText(entry).replace(/^[.,;:!?]+|[.,;:!?]+$/g, ''))
    .filter((entry) => entry.length >= 3 && isLikelyResourceAnchor(entry, pathLanguage)))];
}

function isLikelyResourceAnchor(value: string, pathLanguage: boolean): boolean {
  if (/^https?:\/\//iu.test(value)) return true;
  if (/^[a-z]:[\\/]/iu.test(value) || /^[\\/]/u.test(value) || value.includes('\\')) return true;
  if (/[\p{L}\p{N}_-]+\.[\p{L}\p{N}_-]+$/u.test(value)) return true;
  return pathLanguage && value.includes('/');
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

function evidenceTargetMatches(expected: string, actual: string, projectRoot?: string): boolean {
  const expectedPath = expected.replace(/^\.\//, '').replace(/^\//, '');
  const actualPath = actual.replace(/^\.\//, '').replace(/^\//, '');
  if (expectedPath === actualPath) return true;
  if (!projectRoot || /^https?:\/\//iu.test(expected) || /^https?:\/\//iu.test(actual)) return false;
  const requestedTarget = path.resolve(projectRoot, expected.replace(/\//gu, path.sep));
  const relative = path.relative(path.resolve(projectRoot), requestedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return normalizeEvidenceText(requestedTarget) === actualPath;
}

function containsEvidenceToken(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, 'u').test(haystack);
}

function artifactMatchesGoalDescription(artifact: AgentArtifactReference, description: string): boolean {
  const normalizedDescription = normalizeEvidenceText(description);
  const reference = normalizeEvidenceText(artifact.reference);
  const label = normalizeEvidenceText(artifact.label.replace(/\.[^.]+$/u, ''));
  return (reference.length >= 3 && normalizedDescription.includes(reference))
    || (label.length >= 3 && normalizedDescription.includes(label));
}

function artifactMatchesBoundGoalArtifact(
  checkpoint: AgentTaskCheckpoint,
  artifact: AgentArtifactReference,
  description: string,
): boolean {
  const knownFolderTarget = resolveKnownFolderRequestTarget(checkpoint.task.goal.originalRequest);
  if (!knownFolderTarget) return artifactMatchesGoalDescription(artifact, description);
  return sameCanonicalFilesystemPath(artifact.reference, knownFolderTarget.path);
}

function observationMatchesTypedOperationalTarget(
  checkpoint: AgentTaskCheckpoint,
  observation: AgentObservation,
): boolean {
  const knownFolderTarget = resolveKnownFolderRequestTarget(checkpoint.task.goal.originalRequest);
  const output = observationOutput(observation);
  if (knownFolderTarget) {
    return observation.capabilityId === 'workspace.known-folder.write'
      && knownFolderWriteOutputMatchesRequest(checkpoint.task.goal.originalRequest, output);
  }
  const requirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  if (requirements.length === 0) return true;
  return requirements.some((requirement) => (
    operationalRequirementMatches(requirement, observation.capabilityId, output)
    || reconciliationObservationMatchesOperationalRequirement(checkpoint, observation, requirement)
  ));
}

function agentOperationalRequirementsSatisfied(checkpoint: AgentTaskCheckpoint): boolean {
  const requirements = resolveAgentOperationalRequirements(checkpoint.task.goal.originalRequest);
  if (requirements.length === 0) return true;
  return requirements.every((requirement) => operationalRequirementIsSatisfied(checkpoint, requirement));
}

function operationalRequirementIsSatisfied(
  checkpoint: AgentTaskCheckpoint,
  requirement: ReturnType<typeof resolveAgentOperationalRequirements>[number],
): boolean {
  return checkpoint.observations.some((observation) => (
    observation.status === 'success'
    && hasKernelEvidence(observation)
    && (
      operationalRequirementMatches(requirement, observation.capabilityId, observationOutput(observation))
      || reconciliationObservationMatchesOperationalRequirement(checkpoint, observation, requirement)
    )
    && (!requirement.effectful || observationProvesVerifiedGoalMutation(checkpoint, observation))
  ));
}

function reconciliationObservationMatchesOperationalRequirement(
  checkpoint: AgentTaskCheckpoint,
  observation: AgentObservation,
  requirement: ReturnType<typeof resolveAgentOperationalRequirements>[number],
): boolean {
  const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeBinding);
  if (
    observation.status !== 'success'
    || binding?.kind !== 'mutation-postcondition-reconciliation'
    || binding.exactTarget !== true
    || binding.stateSatisfied !== true
    || typeof binding.sourceObservationId !== 'string'
    || binding.sourceCapabilityId !== requirement.capabilityId
  ) return false;
  const source = checkpoint.observations.find((entry) => entry.id === binding.sourceObservationId);
  const sourceBinding = objectRecord(objectRecord(source?.structuredData)?.runtimeReconciliationBinding);
  const sourceInput = objectRecord(sourceBinding?.sourceInput);
  return Boolean(
    source
    && sourceInput
    && sourceBinding?.sourceCapabilityId === requirement.capabilityId
    && sourceBinding.sourceProposalCanonicalHash === binding.sourceProposalCanonicalHash
    && operationalRequirementInputMatches(
      requirement,
      requirement.capabilityId,
      sourceInput,
      checkpoint.task.executionProfile?.projectRoot,
    )
  );
}

function observationOutput(observation: AgentObservation): unknown {
  const structured = observation.structuredData;
  return structured && typeof structured === 'object' && !Array.isArray(structured)
    ? structured.output
    : undefined;
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
  const reconciledSourceIds = new Set(observations.flatMap((observation) => {
    const binding = objectRecord(objectRecord(observation.structuredData)?.runtimeBinding);
    return observation.status === 'success'
      && binding?.kind === 'mutation-postcondition-reconciliation'
      && binding.exactTarget === true
      && binding.stateSatisfied === true
      && typeof binding.sourceObservationId === 'string'
      ? [binding.sourceObservationId]
      : [];
  }));
  const latest = new Map<string, AgentObservation>();
  for (const observation of observations) {
    if (reconciledSourceIds.has(observation.id)) continue;
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
  for (const key of ['path', 'targetPath', 'url', 'resourceId', 'id', 'app']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function agentToolActivity(capabilityId: string, inputValue: unknown): AgentJsonObject {
  const input = inputValue && typeof inputValue === 'object' && !Array.isArray(inputValue)
    ? inputValue as Record<string, unknown>
    : {};
  const lower = capabilityId.toLowerCase();
  const computerActivity = computerUseActivity(lower);
  if (computerActivity) return jsonObject(computerActivity);
  const operation = lower.includes('search') || lower.includes('.network.fetch') || lower.includes('.chat.web')
    ? 'search'
    : lower.includes('.files.list') ? 'inspect'
      : lower.includes('.read') || lower.includes('.get') || lower.includes('.status') ? 'read'
        : lower.includes('.move') ? 'move'
          : lower.includes('.copy') ? 'copy'
            : lower.includes('.trash') ? 'trash'
              : lower.includes('.delete') ? 'delete'
                : lower.includes('.mkdir') || lower.includes('.create') ? 'create'
                  : lower.includes('.write') || lower.includes('.append') || lower.includes('.replace') ? 'write'
                    : lower.includes('.open') ? 'open' : 'execute';
  const domain = lower.includes('.network.') || lower.includes('.chat.web') || lower.includes('browser')
    ? 'internet'
    : lower.startsWith('workspace.files.') ? 'files'
      : lower.startsWith('memory.') || lower.includes('.memory.') ? 'memory'
        : lower.startsWith('astra.agent-skills.') ? 'skills'
          : lower.startsWith('device.apps.') ? 'apps' : 'system';
  const query = safeActivityText(input.query);
  const pathValue = safeActivityText(input.path || input.sourcePath);
  const targetPath = safeActivityText(input.targetPath || input.destinationPath);
  const url = safeActivityUrl(input.url);
  const app = safeActivityText(input.app || input.name);
  const webPrompt = domain === 'internet' ? lastUserMessage(input.messages) : '';
  const subject = query || url || app || pathValue || webPrompt;
  const target = targetPath || (query && pathValue ? pathValue : '');
  return jsonObject({
    operation,
    domain,
    ...(subject ? { subject } : {}),
    ...(target ? { target } : {}),
    motion: ['move', 'copy', 'trash', 'delete', 'create', 'write', 'open'].includes(operation)
      ? 'heartbeat'
      : 'breathing',
  });
}

function computerUseActivity(capabilityId: string): AgentJsonObject | null {
  const activities: Record<string, AgentJsonObject> = {
    'computer.control.status': { operation: 'inspect', domain: 'computer-use', label: 'Проверяю Computer Use', motion: 'breathing' },
    'computer.control.stop': { operation: 'control', domain: 'computer-use', label: 'Останавливаю Computer Use', motion: 'heartbeat' },
    'computer.windows.list': { operation: 'inspect', domain: 'computer-use', label: 'Смотрю открытые окна', motion: 'breathing' },
    'computer.window.observe': { operation: 'inspect', domain: 'computer-use', label: 'Смотрю на окно', motion: 'breathing' },
    'computer.window.analyze': { operation: 'inspect', domain: 'computer-use', label: 'Анализирую экран', motion: 'breathing' },
    'computer.window.click': { operation: 'click', domain: 'computer-use', label: 'Перемещаю курсор', motion: 'heartbeat' },
    'computer.window.close': { operation: 'close', domain: 'computer-use', label: 'Закрываю окно', motion: 'heartbeat' },
    'computer.window.type': { operation: 'type', domain: 'computer-use', label: 'Ввожу текст', motion: 'heartbeat' },
    'computer.window.key': { operation: 'key', domain: 'computer-use', label: 'Нажимаю клавишу', motion: 'heartbeat' },
    'computer.window.scroll': { operation: 'scroll', domain: 'computer-use', label: 'Прокручиваю окно', motion: 'heartbeat' },
  };
  return activities[capabilityId] || null;
}

function lastUserMessage(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const entry = value[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.role === 'user') return safeActivityText(record.content);
  }
  return '';
}

function safeActivityUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return safeActivityText(`${parsed.origin}${parsed.pathname}`);
  } catch {
    return safeActivityText(value);
  }
}

function safeActivityText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return String(redactAgentContextValue(value, { maxStringChars: 160 }).value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
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

function decisionTelemetry(response: AgentModelDecisionResponse): AgentJsonObject {
  return jsonObject({
    ...(response.decisionProfile ? { decisionProfile: response.decisionProfile } : {}),
    ...(response.initialTier ? { initialTier: response.initialTier } : {}),
    ...(response.finalTier ? { finalTier: response.finalTier } : {}),
    ...(response.escalationReason ? { escalationReason: response.escalationReason } : {}),
    ...(response.attemptedTiers ? { attemptedTiers: response.attemptedTiers.slice(0, 4) } : {}),
    ...(Number.isFinite(response.inputChars) ? { inputChars: response.inputChars } : {}),
    ...(Number.isFinite(response.modelCalls) ? { modelCalls: response.modelCalls } : {}),
    ...(Number.isFinite(response.queueLatencyMs) ? { queueLatencyMs: response.queueLatencyMs } : {}),
    ...(Number.isFinite(response.loadLatencyMs) ? { loadLatencyMs: response.loadLatencyMs } : {}),
    ...(Number.isFinite(response.generationLatencyMs) ? { generationLatencyMs: response.generationLatencyMs } : {}),
  });
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

function normalizeDecisionCycleBudget(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_AGENT_DECISION_CYCLE_BUDGET_MS;
  return Math.max(10, Math.min(Math.floor(value as number), 10 * 60_000));
}

async function decideAgentModelWithinBudget(
  provider: AgentDecisionProvider,
  request: Omit<AgentModelDecisionRequest, 'signal' | 'timeoutMs'>,
  parentSignal: AbortSignal,
  timeoutMsInput: number,
): Promise<AgentModelDecisionResponse> {
  const timeoutMs = Math.max(1, Math.floor(timeoutMsInput));
  const startedAt = Date.now();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) forwardAbort();
  else parentSignal.addEventListener('abort', forwardAbort, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exhausted = new Promise<AgentModelDecisionResponse>((resolve) => {
      const timer = setTimeout(() => {
        controller.abort('agent-decision-time-budget');
        resolve({
          ok: false,
          error: 'agent-decision-time-budget-exhausted',
          degraded: true,
          latencyMs: Date.now() - startedAt,
        });
      }, timeoutMs);
      timeout = timer;
      timer.unref?.();
    });
    return await Promise.race([
      provider.decide({ ...request, signal: controller.signal, timeoutMs }),
      exhausted,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    parentSignal.removeEventListener('abort', forwardAbort);
  }
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

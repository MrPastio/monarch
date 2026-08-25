import { createHash } from 'node:crypto';
import path from 'node:path';
import { createMonarchId, nowIso } from '../core/utils';
import type { MonarchCapability, MonarchPermissionProfile } from '../core/contracts';
import { supportsWorkspaceTaskLease } from '../core/capability-leases';
import { AgentLoop } from './agent-loop';
import type { AgentDecisionProvider } from './model-decision-provider';
import type { AgentKernelExecutionAdapter } from './kernel-execution-adapter';
import { createAgentBudgetUsage, normalizeAgentBudget } from './budget-manager';
import { normalizeAgentGoal, type NormalizeAgentGoalInput } from './goal-normalizer';
import { createInitialAgentPlan } from './plan-manager';
import { createAgentCognitiveProfile } from './cognitive-profile';
import { createAgentWorkingState } from './working-state';
import type { AgentRuntimeAvailabilitySnapshot } from './runtime-availability';
import {
  AGENT_OBSERVATION_SCHEMA_VERSION,
  AGENT_EXECUTION_PROFILE_SCHEMA_VERSION,
  AGENT_TASK_SCHEMA_VERSION,
  type AgentApproval,
  type AgentBudgetLimits,
  type AgentDecisionModelPolicy,
  type AgentEvidenceReference,
  type AgentJsonValue,
  type AgentObservation,
  type AgentTask,
  type AgentTaskCheckpoint,
  type AgentTaskEvent,
  type AgentTaskExecutionProfile,
  type AgentTaskSource,
  type AgentTaskSurface,
  type AgentTaskStore,
  type AgentTaskStoreCommit,
  type AgentTaskStoreListener,
} from './types';
import {
  AgentTaskStoreConflictError,
  AgentTaskStoreIdempotencyConflictError,
} from './agent-task-store';

const RESTART_RUNNABLE_STATUSES = new Set<AgentTask['status']>([
  'preparing',
  'running',
  'cancelling',
  'interrupted',
]);
const EXACT_ONCE_APPROVAL_CAPABILITIES = new Set([
  'workspace.files.move',
  'workspace.files.trash',
  'workspace.files.delete',
  'device.recycle-bin.empty',
  'device.browser.close-active',
]);

export interface CreateAgentTaskInput extends NormalizeAgentGoalInput {
  source: AgentTaskSource;
  conversationId?: string;
  parentTaskId?: string;
  clientRequestId?: string;
  budgets?: Partial<AgentBudgetLimits>;
  autoStart?: boolean;
  actionApprovalPolicy?: 'kernel' | 'all-effects';
  planningMode?: 'adaptive' | 'model-first';
  decisionModelPolicy?: AgentDecisionModelPolicy;
  /** Internal-only trusted execution profile supplied by a local surface. */
  executionProfile?: AgentTaskExecutionProfile;
  /** Bounded, explicitly untrusted observations available before the first model turn. */
  initialObservations?: AgentTaskInitialObservationInput[];
}

export interface AgentTaskInitialObservationInput {
  capabilityId: string;
  summary: string;
  structuredData?: AgentJsonValue;
  evidence: AgentEvidenceReference[];
  warnings?: string[];
}

export interface AgentTaskMessageInput {
  content: string;
  messageId?: string;
}

export interface RepeatAgentTaskInput {
  clientRequestId?: string;
  autoStart?: boolean;
  source?: AgentTaskSource;
}

export interface AgentApprovalResolutionInput {
  decision: 'approve' | 'deny';
  grantScope?: 'once' | 'task';
  requestId?: string;
  reason?: string;
  actorSurface: AgentTaskSurface;
  requireArm?: boolean;
}

export interface AgentApprovalArmInput {
  canonicalProposalHash: string;
  capabilityId: string;
  actorSurface: AgentTaskSurface;
  requestId?: string;
}

export interface MonarchAgentRuntimeOptions {
  store: AgentTaskStore;
  decisionProvider: AgentDecisionProvider;
  executionAdapter: AgentKernelExecutionAdapter;
  listCapabilities: () => readonly MonarchCapability[];
  getPermissionProfile: () => MonarchPermissionProfile;
  getModuleStates?: () => Readonly<Record<string, 'active' | 'degraded' | 'inactive' | 'failed' | 'unavailable'>>;
  getRuntimeAvailability?: () => Promise<readonly AgentRuntimeAvailabilitySnapshot[]> | readonly AgentRuntimeAvailabilitySnapshot[];
  availableCredentialRefs?: () => ReadonlySet<string>;
  runnerId?: string;
  runnerClaimTtlMs?: number;
  decisionCycleBudgetMs?: number;
  autoRun?: boolean;
}

export class MonarchAgentRuntime {
  readonly store: AgentTaskStore;
  private readonly loop: AgentLoop;
  private readonly autoRun: boolean;
  private readonly runnerClaimTtlMs: number;
  private readonly running = new Map<string, Promise<AgentTask | null>>();
  private readonly controllers = new Map<string, AbortController>();
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoverySweep: Promise<void> | null = null;
  private started = false;

  constructor(options: MonarchAgentRuntimeOptions) {
    this.store = options.store;
    this.autoRun = options.autoRun !== false;
    this.runnerClaimTtlMs = Math.max(300, Math.min(options.runnerClaimTtlMs || 5 * 60_000, 30 * 60_000));
    this.loop = new AgentLoop({
      store: options.store,
      decisionProvider: options.decisionProvider,
      executionAdapter: options.executionAdapter,
      listCapabilities: options.listCapabilities,
      getPermissionProfile: options.getPermissionProfile,
      ...(options.getModuleStates ? { getModuleStates: options.getModuleStates } : {}),
      ...(options.getRuntimeAvailability ? { getRuntimeAvailability: options.getRuntimeAvailability } : {}),
      ...(options.availableCredentialRefs ? { availableCredentialRefs: options.availableCredentialRefs } : {}),
      runnerId: options.runnerId || `agent_runner_${process.pid}`,
      runnerClaimTtlMs: this.runnerClaimTtlMs,
      ...(options.decisionCycleBudgetMs !== undefined
        ? { decisionCycleBudgetMs: options.decisionCycleBudgetMs }
        : {}),
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.recoverAndSchedule();
    } catch (error) {
      this.started = false;
      this.clearRecoveryTimer();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.clearRecoveryTimer();
    for (const controller of this.controllers.values()) controller.abort('shutdown');
    await Promise.allSettled([...this.running.values()]);
    await this.recoverySweep?.catch(() => undefined);
  }

  async createTask(input: CreateAgentTaskInput): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const goal = normalizeAgentGoal(input);
    const taskId = input.clientRequestId
      ? deterministicTaskId(input.source.surface, input.clientRequestId)
      : createMonarchId('agent_task');
    const normalizedSource = normalizeSource(input.source);
    const budgets = normalizeAgentBudget(input.budgets);
    const shouldAutoStart = this.autoRun && input.autoStart !== false;
    if (input.clientRequestId) {
      const existing = await this.store.getTask(taskId);
      if (existing) {
        if (!sameAgentTaskRequest(existing, goal, normalizedSource, budgets, input, shouldAutoStart)) {
          throw new AgentRuntimeError(409, 'client-request-reused', 'clientRequestId is already bound to a different Agent Task request.');
        }
        return existing;
      }
    }
    const createdAt = nowIso();
    const initialObservations = normalizeInitialObservations(input.initialObservations, taskId, createdAt);
    const plan = createInitialAgentPlan(goal.normalizedObjective, createdAt);
    const decisionModelPolicy = input.decisionModelPolicy
      ? normalizeDecisionModelPolicy(input.decisionModelPolicy)
      : undefined;
    const task: AgentTask = {
      schemaVersion: AGENT_TASK_SCHEMA_VERSION,
      id: taskId,
      traceId: input.clientRequestId
        ? deterministicTraceId(input.source.surface, input.clientRequestId)
        : createMonarchId('agent_trace'),
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      source: normalizedSource,
      ...(input.conversationId ? { conversationId: boundedId(input.conversationId, 'conversation') } : {}),
      ...(input.parentTaskId ? { parentTaskId: boundedId(input.parentTaskId, 'parent task') } : {}),
      ...(input.actionApprovalPolicy ? { actionApprovalPolicy: normalizeActionApprovalPolicy(input.actionApprovalPolicy) } : {}),
      ...(input.planningMode && input.planningMode !== 'adaptive'
        ? { planningMode: normalizePlanningMode(input.planningMode) }
        : {}),
      ...(decisionModelPolicy
        ? { decisionModelPolicy }
        : {}),
      ...(input.executionProfile
        ? { executionProfile: normalizeExecutionProfile(input.executionProfile, normalizedSource.surface) }
        : {}),
      goal,
      status: shouldAutoStart ? 'preparing' : 'created',
      plan,
      currentStepId: plan.steps[0]!.id,
      cognitiveProfile: createAgentCognitiveProfile(decisionModelPolicy, createdAt),
      workingState: createAgentWorkingState(
        goal,
        plan,
        initialObservations.map((observation) => observation.id),
        createdAt,
      ),
      messages: [{
        id: createMonarchId('agent_message'), role: 'user', kind: 'request', createdAt,
        content: goal.originalRequest,
      }],
      observations: initialObservations.map((observation) => ({
        id: observation.id,
        taskId,
        status: observation.status,
        summary: observation.summary,
        occurredAt: observation.occurredAt,
      })),
      artifacts: [],
      approvals: [],
      budgets,
      usage: createAgentBudgetUsage(createdAt),
      checkpointVersion: 0,
      eventSequence: 0,
      createdAt,
      updatedAt: createdAt,
    };
    let commit: AgentTaskStoreCommit;
    try {
      commit = await this.store.createTask(task, {
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        events: [
          { type: 'task.created', payload: jsonObject({ source: task.source.surface }) },
          { type: 'plan.created', payload: jsonObject({ planId: plan.id, revision: plan.revision }) },
          ...initialObservations.map((observation) => ({
            type: 'observation.created' as const,
            payload: jsonObject({
              observationId: observation.id,
              capabilityId: observation.capabilityId,
              status: observation.status,
              evidenceClass: 'model-generated',
              inputObservation: true,
            }),
          })),
          ...(shouldAutoStart ? [{
            type: 'task.status.changed' as const,
            payload: jsonObject({ from: 'created', to: 'preparing', reason: 'auto-start' }),
          }] : []),
        ],
        observations: initialObservations,
      });
    } catch (error) {
      if (input.clientRequestId && error instanceof AgentTaskStoreIdempotencyConflictError) {
        const existing = await this.store.getTask(taskId);
        if (existing && sameAgentTaskRequest(existing, goal, normalizedSource, budgets, input, shouldAutoStart)) {
          return existing;
        }
        throw new AgentRuntimeError(
          409,
          'client-request-reused',
          'clientRequestId is already bound to a different Agent Task request.',
        );
      }
      throw error;
    }
    if (shouldAutoStart && !commit.replayed) this.schedule(taskId);
    return commit.checkpoint;
  }

  getTask(taskId: string): Promise<AgentTaskCheckpoint | null> {
    return this.store.getTask(taskId);
  }

  listTasks(): Promise<AgentTask[]> {
    return this.store.listTasks();
  }

  async repeatTask(
    taskId: string,
    input: RepeatAgentTaskInput = {},
  ): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const original = await this.store.getTask(boundedId(taskId, 'task'));
    if (!original) {
      throw new AgentRuntimeError(404, 'task-not-found', 'Agent task was not found.');
    }
    if (!isTerminal(original.task)) {
      throw new AgentRuntimeError(409, 'task-not-terminal', 'Only a terminal Agent Task can be repeated.');
    }
    const goal = original.task.goal;
    return this.createTask({
      request: goal.originalRequest,
      normalizedObjective: goal.normalizedObjective,
      expectedOutputs: goal.expectedOutputs.map((entry) => ({ ...entry })),
      constraints: goal.constraints.map((entry) => ({ ...entry })),
      successCriteria: goal.successCriteria.map((entry) => ({ ...entry })),
      ...(goal.userPreferences ? { userPreferences: [...goal.userPreferences] } : {}),
      budgets: { ...original.task.budgets },
      source: input.source || {
        surface: original.task.source.surface,
        ...(original.task.source.remote !== undefined
          ? { remote: original.task.source.remote }
          : {}),
      },
      parentTaskId: original.task.id,
      ...(original.task.decisionModelPolicy
        ? { decisionModelPolicy: { ...original.task.decisionModelPolicy } }
        : {}),
      ...(original.task.executionProfile
        ? { executionProfile: structuredClone(original.task.executionProfile) }
        : {}),
      ...(input.clientRequestId
        ? { clientRequestId: boundedId(input.clientRequestId, 'client request') }
        : {}),
      ...(input.autoStart !== undefined ? { autoStart: input.autoStart } : {}),
    });
  }

  async sendMessage(taskId: string, input: AgentTaskMessageInput): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const content = String(input.content || '').replace(/\s+/g, ' ').trim().slice(0, 16_000);
    if (!content) throw new AgentRuntimeError(400, 'empty-message', 'Agent task message is required.');
    const messageId = input.messageId ? boundedId(input.messageId, 'message') : createMonarchId('agent_message');
    let commit: AgentTaskStoreCommit;
    try {
      commit = await this.mutate(taskId, (checkpoint) => {
        const existing = checkpoint.task.messages.find((message) => message.id === messageId);
        if (existing) {
          if (existing.role !== 'user' || existing.content !== content) {
            throw new AgentRuntimeError(409, 'message-id-reused', 'messageId is already bound to different message content.');
          }
          return {
            task: checkpoint.task,
            events: [],
            clientRequestId: messageId,
            idempotencyPayload: { operation: 'send-message', messageId, content },
          };
        }
        if (isTerminal(checkpoint.task)) throw new AgentRuntimeError(409, 'task-terminal', 'Terminal task cannot accept messages.');
        const task = { ...checkpoint.task };
        task.messages = [...task.messages, {
          id: messageId,
          role: 'user' as const,
          kind: 'clarification' as const,
          createdAt: nowIso(),
          content,
        }].slice(-200);
        if (task.status === 'waiting-for-user') task.status = 'running';
        return {
          task,
          events: task.status === checkpoint.task.status ? [] : [{
            type: 'task.status.changed' as const,
            payload: jsonObject({ from: checkpoint.task.status, to: task.status, reason: 'user-message' }),
          }],
          clientRequestId: messageId,
          idempotencyPayload: { operation: 'send-message', messageId, content },
        };
      });
    } catch (error) {
      if (error instanceof AgentTaskStoreIdempotencyConflictError) {
        throw new AgentRuntimeError(409, 'message-id-reused', 'messageId is already bound to different message content.');
      }
      throw error;
    }
    if (commit.task.status === 'running' || this.running.has(taskId)) this.wake(taskId);
    return commit.checkpoint;
  }

  async pause(taskId: string): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const locallyActive = this.running.has(taskId);
    const commit = await this.mutate(taskId, (checkpoint) => {
      if (isTerminal(checkpoint.task)) return { task: checkpoint.task, events: [] };
      if (checkpoint.task.status === 'cancelling' || checkpoint.task.cancellationRequested) {
        throw new AgentRuntimeError(409, 'cancellation-in-progress', 'A cancelling task cannot be paused.');
      }
      if (hasPendingActiveApproval(checkpoint)) {
        return { task: checkpoint.task, events: [] };
      }
      if (checkpoint.task.status === 'paused') return { task: checkpoint.task, events: [] };
      const active = locallyActive || Boolean(checkpoint.task.runnerClaim);
      const task: AgentTask = active
        ? { ...checkpoint.task, pauseRequested: true }
        : { ...checkpoint.task, status: 'paused', pauseRequested: false };
      return {
        task,
        events: active ? [] : [{
          type: 'task.status.changed' as const,
          payload: jsonObject({ from: checkpoint.task.status, to: 'paused' }),
        }],
      };
    });
    if (locallyActive && commit.task.pauseRequested) this.controllers.get(taskId)?.abort('pause');
    return commit.checkpoint;
  }

  async resume(taskId: string): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const commit = await this.mutate(taskId, (checkpoint) => {
      if (isTerminal(checkpoint.task)) throw new AgentRuntimeError(409, 'task-terminal', 'Terminal task cannot be resumed.');
      if (checkpoint.task.status === 'cancelling' || checkpoint.task.cancellationRequested) {
        throw new AgentRuntimeError(409, 'cancellation-in-progress', 'Cancellation is monotonic and cannot be resumed.');
      }
      if (checkpoint.task.status === 'waiting-for-approval') {
        throw new AgentRuntimeError(409, 'approval-required', 'Resolve the durable approval before resuming.');
      }
      if (hasPendingActiveApproval(checkpoint)) {
        const task = { ...checkpoint.task, status: 'waiting-for-approval' as const, pauseRequested: false };
        return {
          task,
          events: [{
            type: 'task.status.changed' as const,
            payload: jsonObject({ from: checkpoint.task.status, to: 'waiting-for-approval', reason: 'approval-wait-restored' }),
          }],
        };
      }
      if (checkpoint.task.status === 'waiting-for-user') {
        throw new AgentRuntimeError(409, 'message-required', 'A waiting task needs a user message, not a blind resume.');
      }
      const task = { ...checkpoint.task, status: 'running' as const, pauseRequested: false };
      return {
        task,
        events: checkpoint.task.status === 'running' ? [] : [{
          type: 'task.status.changed' as const,
          payload: jsonObject({ from: checkpoint.task.status, to: 'running', reason: 'explicit-resume' }),
        }],
      };
    });
    if (commit.task.status === 'running') this.wake(taskId);
    return commit.checkpoint;
  }

  async cancel(taskId: string): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const commit = await this.mutate(taskId, (checkpoint) => {
      if (isTerminal(checkpoint.task)) return { task: checkpoint.task, events: [] };
      const completedAt = nowIso();
      const active = this.running.has(taskId) || Boolean(checkpoint.task.runnerClaim);
      const revoked = revokePendingApprovals(checkpoint, completedAt);
      const baseTask: AgentTask = {
        ...checkpoint.task,
        approvals: revoked.references,
      };
      if (revoked.revokedActive) {
        delete baseTask.activeApprovalId;
        delete baseTask.pendingAction;
      }
      if (active) {
        return {
          task: { ...baseTask, status: 'cancelling', cancellationRequested: true },
          events: [
            ...revoked.events,
            ...(checkpoint.task.status === 'cancelling' ? [] : [{
              type: 'task.status.changed' as const,
              payload: jsonObject({ from: checkpoint.task.status, to: 'cancelling' }),
            }]),
          ],
          ...(revoked.changed ? { approvals: revoked.approvals } : {}),
        };
      }
      delete baseTask.activeApprovalId;
      delete baseTask.pendingAction;
      return {
        task: {
          ...baseTask,
          status: 'cancelled',
          cancellationRequested: true,
          completedAt,
          terminalReason: { code: 'cancelled-by-user', summary: 'Задача остановлена до начала активного шага.' },
        },
        events: [
          ...revoked.events,
          { type: 'task.status.changed' as const, payload: jsonObject({ from: checkpoint.task.status, to: 'cancelled' }) },
          { type: 'task.cancelled' as const, payload: jsonObject({ summary: 'Задача остановлена до начала активного шага.' }) },
        ],
        ...(revoked.changed ? { approvals: revoked.approvals } : {}),
      };
    });
    this.controllers.get(taskId)?.abort('cancel');
    if (commit.task.status === 'cancelling') {
      const activeRun = this.running.get(taskId);
      if (activeRun) {
        void activeRun.then(
          () => this.finalizeCancellationIfIdle(taskId),
          () => this.finalizeCancellationIfIdle(taskId),
        ).catch(() => undefined);
      } else {
        void this.finalizeCancellationIfIdle(taskId).catch(() => undefined);
      }
    }
    return commit.checkpoint;
  }

  async armApproval(
    taskId: string,
    approvalId: string,
    input: AgentApprovalArmInput,
  ): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const normalizedApprovalId = boundedId(approvalId, 'approval');
    const requestId = input.requestId ? boundedId(input.requestId, 'approval arm request') : undefined;
    const canonicalProposalHash = String(input.canonicalProposalHash || '').trim();
    const capabilityId = String(input.capabilityId || '').trim();
    const idempotencyPayload = jsonObject({
      operation: 'arm-approval',
      approvalId: normalizedApprovalId,
      canonicalProposalHash,
      capabilityId,
      actorSurface: input.actorSurface,
    });
    try {
      const commit = await this.mutate(taskId, (checkpoint) => {
        const expectedSurface = approvalDecisionSurface(checkpoint.task.source.surface);
        if (input.actorSurface !== expectedSurface) {
          throw new AgentRuntimeError(
            403,
            'approval-surface-mismatch',
            `Approval for ${checkpoint.task.source.surface} must be armed from ${expectedSurface}.`,
          );
        }
        const index = checkpoint.approvals.findIndex((entry) => entry.id === normalizedApprovalId);
        if (index < 0) throw new AgentRuntimeError(404, 'approval-not-found', 'Agent approval was not found.');
        const current = checkpoint.approvals[index]!;
        if (
          current.status !== 'pending'
          || checkpoint.task.status !== 'waiting-for-approval'
          || checkpoint.task.activeApprovalId !== normalizedApprovalId
          || current.canonicalProposalHash !== canonicalProposalHash
          || current.capabilityId !== capabilityId
          || checkpoint.task.pendingAction?.canonicalProposalHash !== canonicalProposalHash
        ) {
          throw new AgentRuntimeError(409, 'approval-binding-mismatch', 'Approval arm no longer matches the active proposal.');
        }
        const armedAt = nowIso();
        const expiresAt = new Date(Math.min(
          Date.parse(current.expiresAt || new Date(Date.now() + 8_000).toISOString()),
          Date.now() + 8_000,
        )).toISOString();
        const armed: AgentApproval = {
          ...current,
          arm: {
            canonicalProposalHash,
            capabilityId,
            armedAt,
            expiresAt,
            armedBySurface: input.actorSurface,
          },
        };
        const approvals = [...checkpoint.approvals];
        approvals[index] = armed;
        return {
          task: checkpoint.task,
          approvals,
          events: [{
            type: 'approval.armed',
            payload: jsonObject({ approvalId: normalizedApprovalId, canonicalProposalHash, capabilityId, expiresAt }),
          }],
          ...(requestId ? { clientRequestId: requestId, idempotencyPayload } : {}),
        };
      });
      return commit.checkpoint;
    } catch (error) {
      if (error instanceof AgentTaskStoreIdempotencyConflictError) {
        throw new AgentRuntimeError(409, 'approval-arm-request-reused', 'Approval arm requestId is already bound to another action.');
      }
      throw error;
    }
  }

  async resolveApproval(
    taskId: string,
    approvalId: string,
    input: AgentApprovalResolutionInput,
  ): Promise<AgentTaskCheckpoint> {
    await this.ensureStarted();
    const normalizedApprovalId = boundedId(approvalId, 'approval');
    const requestId = input.requestId ? boundedId(input.requestId, 'approval request') : undefined;
    const grantScope = input.grantScope || 'once';
    const reason = input.reason ? String(input.reason).slice(0, 1_000) : undefined;
    const idempotencyPayload = jsonObject({
      operation: 'resolve-approval',
      approvalId: normalizedApprovalId,
      decision: input.decision,
      grantScope,
      reason: reason || null,
      actorSurface: input.actorSurface || null,
      requireArm: input.requireArm === true,
    });
    let commit: AgentTaskStoreCommit;
    try {
      commit = await this.mutate(taskId, (checkpoint) => {
      const expectedSurface = approvalDecisionSurface(checkpoint.task.source.surface);
      if (input.actorSurface !== expectedSurface) {
        throw new AgentRuntimeError(
          403,
          'approval-surface-mismatch',
          `Approval for ${checkpoint.task.source.surface} must be decided from ${expectedSurface}.`,
        );
      }
      const index = checkpoint.approvals.findIndex((entry) => entry.id === normalizedApprovalId);
      if (index < 0) throw new AgentRuntimeError(404, 'approval-not-found', 'Agent approval was not found.');
      const current = checkpoint.approvals[index]!;
      const requiresArm = input.requireArm === true || current.purpose === 'owner-security-override';
      if (input.decision === 'approve' && requiresArm) {
        const arm = current.arm;
        if (
          !arm
          || !input.actorSurface
          || arm.armedBySurface !== input.actorSurface
          || arm.canonicalProposalHash !== current.canonicalProposalHash
          || arm.capabilityId !== current.capabilityId
          || Date.parse(arm.expiresAt) <= Date.now()
        ) {
          throw new AgentRuntimeError(409, 'approval-arm-required', 'Sensitive approval must be armed again from the same surface.');
        }
      }
      if (
        input.decision === 'approve'
        && grantScope === 'task'
        && (!supportsWorkspaceTaskLease(current.capabilityId)
          || EXACT_ONCE_APPROVAL_CAPABILITIES.has(current.capabilityId)
          || current.purpose === 'owner-security-override')
      ) {
        throw new AgentRuntimeError(
          409,
          'approval-scope-must-be-once',
          'This capability does not support task-wide approval. Approve its exact action once.',
        );
      }
      if (current.status !== 'pending') {
        const same = (input.decision === 'approve' && current.status === 'approved')
          || (input.decision === 'deny' && current.status === 'denied');
        if (same) return {
          task: checkpoint.task,
          events: [],
          approvals: checkpoint.approvals,
          ...(requestId ? { clientRequestId: requestId, idempotencyPayload } : {}),
        };
        throw new AgentRuntimeError(409, 'approval-already-resolved', 'Agent approval is already resolved.');
      }
      if (isTerminal(checkpoint.task)) {
        throw new AgentRuntimeError(409, 'task-terminal', 'Terminal task cannot resolve approvals.');
      }
      if (
        checkpoint.task.status !== 'waiting-for-approval'
        || checkpoint.task.cancellationRequested
        || checkpoint.task.activeApprovalId !== normalizedApprovalId
      ) {
        throw new AgentRuntimeError(409, 'approval-not-active', 'Approval is not the active task approval.');
      }
      const pending = checkpoint.task.pendingAction;
      const reference = checkpoint.task.approvals.find((entry) => entry.id === normalizedApprovalId);
      if (
        !pending
        || pending.status !== 'waiting-approval'
        || pending.canonicalProposalHash !== current.canonicalProposalHash
        || stableJson(pending.proposal) !== stableJson(current.proposal)
        || !reference
        || reference.status !== 'pending'
        || reference.capabilityId !== current.capabilityId
        || reference.canonicalProposalHash !== current.canonicalProposalHash
        || reference.purpose !== current.purpose
        || reference.policyDecisionHash !== current.policyDecisionHash
        || reference.authorityTierAtRequest !== current.authorityTierAtRequest
      ) {
        throw new AgentRuntimeError(409, 'approval-binding-mismatch', 'Approval no longer matches the checkpointed action proposal.');
      }
      const resolvedAt = nowIso();
      const expired = current.expiresAt ? Date.parse(current.expiresAt) <= Date.now() : false;
      const status: AgentApproval['status'] = expired ? 'expired' : input.decision === 'approve' ? 'approved' : 'denied';
      const resolved: AgentApproval = {
        ...current,
        status,
        resolvedAt,
        ...(status === 'approved' ? { grantScope } : {}),
        decision: {
          outcome: status,
          decidedAt: resolvedAt,
          decidedBy: 'user',
          ...(reason ? { reason } : {}),
        },
      };
      const approvals = [...checkpoint.approvals];
      approvals[index] = resolved;
      const refs = checkpoint.task.approvals.map((entry) => entry.id === resolved.id ? { ...entry, status } : entry);
      const task: AgentTask = { ...checkpoint.task, status: 'running', approvals: refs };
      return {
        task,
        approvals,
        events: [
          { type: 'approval.resolved', payload: jsonObject({ approvalId: resolved.id, decision: status, grantScope: resolved.grantScope || null }) },
          { type: 'task.status.changed', payload: jsonObject({ from: checkpoint.task.status, to: 'running', reason: 'approval-resolved' }) },
        ],
        ...(requestId ? { clientRequestId: requestId, idempotencyPayload } : {}),
      };
      });
    } catch (error) {
      if (error instanceof AgentTaskStoreIdempotencyConflictError) {
        throw new AgentRuntimeError(
          409,
          'approval-request-reused',
          'Approval requestId is already bound to a different resolution payload.',
        );
      }
      throw error;
    }
    this.wake(taskId);
    return commit.checkpoint;
  }

  getEvents(taskId: string, afterSequence = 0): Promise<AgentTaskEvent[]> {
    return this.store.getTask(taskId).then((checkpoint) => (
      checkpoint ? checkpoint.events.filter((event) => event.sequence > afterSequence) : []
    ));
  }

  subscribe(taskId: string | '*', listener: AgentTaskStoreListener): () => void {
    return this.store.subscribe(taskId, listener);
  }

  async waitForIdle(taskId: string): Promise<AgentTask | null> {
    await this.running.get(taskId);
    return this.store.getTaskState(taskId);
  }

  async discardTask(taskIdInput: string): Promise<boolean> {
    await this.ensureStarted();
    const taskId = boundedId(taskIdInput, 'task');
    const checkpoint = await this.store.getTask(taskId);
    if (!checkpoint) return false;
    if (!isTerminal(checkpoint.task)) {
      await this.cancel(taskId);
      await this.waitForIdle(taskId);
    }
    const discard = this.store.discardTask;
    if (!discard) {
      throw new AgentRuntimeError(409, 'task-store-not-volatile', 'Only a volatile Agent task store can discard task history.');
    }
    this.controllers.delete(taskId);
    this.running.delete(taskId);
    return discard.call(this.store, taskId);
  }

  async discardAllTasks(): Promise<number> {
    await this.ensureStarted();
    if (!this.store.discardTask) {
      throw new AgentRuntimeError(409, 'task-store-not-volatile', 'Only a volatile Agent task store can discard task history.');
    }
    let discarded = 0;
    for (const task of await this.store.listTasks()) {
      if (await this.discardTask(task.id)) discarded += 1;
    }
    return discarded;
  }

  private schedule(taskId: string): Promise<AgentTask | null> {
    const existing = this.running.get(taskId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    const running = this.loop.run(taskId, controller.signal)
      .finally(() => {
        this.controllers.delete(taskId);
        this.running.delete(taskId);
      });
    this.running.set(taskId, running);
    return running;
  }

  private wake(taskId: string): void {
    const existing = this.running.get(taskId);
    if (!existing) {
      this.schedule(taskId);
      return;
    }
    void existing.then(
      () => { if (this.started) this.schedule(taskId); },
      () => { if (this.started) this.schedule(taskId); },
    );
  }

  private async recoverAndSchedule(): Promise<void> {
    await this.store.reconcileLegacyCompletedPlans();
    await this.store.recoverExpiredClaims();
    const tasks = await this.store.listTasks();
    if (this.autoRun && this.started) {
      for (const task of tasks) {
        if (RESTART_RUNNABLE_STATUSES.has(task.status) && !task.runnerClaim) this.schedule(task.id);
      }
    }
    if (this.started) this.armRecoveryTimer(tasks);
  }

  private armRecoveryTimer(tasks: AgentTask[]): void {
    this.clearRecoveryTimer();
    if (!this.started) return;
    const expiries = tasks
      .map((task) => task.runnerClaim ? Date.parse(task.runnerClaim.expiresAt) : Number.NaN)
      .filter(Number.isFinite);
    const earliest = expiries.length > 0 ? Math.min(...expiries) : Number.POSITIVE_INFINITY;
    const untilExpiry = Number.isFinite(earliest) ? earliest - Date.now() + 10 : 5_000;
    const delayMs = Math.max(25, Math.min(5_000, untilExpiry));
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      const sweep = this.recoverAndSchedule().catch(() => {
        if (this.started) this.armRecoveryTimer([]);
      });
      const tracked = sweep.finally(() => {
        if (this.recoverySweep === tracked) this.recoverySweep = null;
      });
      this.recoverySweep = tracked;
    }, delayMs);
    this.recoveryTimer.unref?.();
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private async finalizeCancellationIfIdle(taskId: string): Promise<void> {
    const checkpoint = await this.store.getTask(taskId);
    if (
      !checkpoint
      || isTerminal(checkpoint.task)
      || !checkpoint.task.cancellationRequested
      || this.running.has(taskId)
      || checkpoint.task.runnerClaim
    ) return;
    await this.mutate(taskId, (latest) => {
      if (
        isTerminal(latest.task)
        || !latest.task.cancellationRequested
        || this.running.has(taskId)
        || latest.task.runnerClaim
      ) return { task: latest.task, events: [] };
      const completedAt = nowIso();
      const revoked = revokePendingApprovals(latest, completedAt);
      const task: AgentTask = {
        ...latest.task,
        status: 'cancelled',
        cancellationRequested: true,
        approvals: revoked.references,
        completedAt,
        terminalReason: { code: 'cancelled-by-user', summary: 'Задача остановлена после завершения активного шага.' },
      };
      delete task.activeApprovalId;
      delete task.pendingAction;
      return {
        task,
        events: [
          ...revoked.events,
          { type: 'task.status.changed', payload: jsonObject({ from: latest.task.status, to: 'cancelled' }) },
          { type: 'task.cancelled', payload: jsonObject({ summary: 'Задача остановлена после завершения активного шага.' }) },
        ],
        ...(revoked.changed ? { approvals: revoked.approvals } : {}),
      };
    });
  }

  private async mutate(
    taskId: string,
    mutation: (checkpoint: AgentTaskCheckpoint) => {
      task: AgentTask;
      events: Parameters<AgentTaskStore['saveTask']>[1]['events'];
      observations?: AgentTaskCheckpoint['observations'];
      approvals?: AgentTaskCheckpoint['approvals'];
      clientRequestId?: string;
      idempotencyPayload?: Parameters<AgentTaskStore['saveTask']>[1]['idempotencyPayload'];
    },
  ) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const checkpoint = await this.store.getTask(taskId);
      if (!checkpoint) throw new AgentRuntimeError(404, 'task-not-found', 'Agent task was not found.');
      const next = mutation(checkpoint);
      try {
        return await this.store.saveTask(next.task, {
          expectedCheckpointVersion: checkpoint.task.checkpointVersion,
          events: next.events || [],
          ...(next.observations ? { observations: next.observations } : {}),
          ...(next.approvals ? { approvals: next.approvals } : {}),
          ...(next.clientRequestId ? { clientRequestId: next.clientRequestId } : {}),
          ...(next.idempotencyPayload !== undefined ? { idempotencyPayload: next.idempotencyPayload } : {}),
        });
      } catch (error) {
        if (!(error instanceof AgentTaskStoreConflictError) || attempt === 3) throw error;
      }
    }
    throw new AgentRuntimeError(409, 'task-conflict', 'Agent task changed concurrently.');
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.start();
  }
}

export class AgentRuntimeError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

function deterministicTaskId(surface: string, clientRequestId: string): string {
  return `agent_task_${digest(`${surface}:${clientRequestId}`).slice(0, 32)}`;
}

function deterministicTraceId(surface: string, clientRequestId: string): string {
  return `agent_trace_${digest(`trace:${surface}:${clientRequestId}`).slice(0, 32)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sameAgentTaskRequest(
  checkpoint: AgentTaskCheckpoint,
  goal: AgentTask['goal'],
  source: AgentTaskSource,
  budgets: AgentBudgetLimits,
  input: Pick<CreateAgentTaskInput, 'conversationId' | 'parentTaskId' | 'actionApprovalPolicy' | 'planningMode' | 'decisionModelPolicy' | 'executionProfile' | 'initialObservations'>,
  shouldAutoStart: boolean,
): boolean {
  const task = checkpoint.task;
  const originallyAutoStarted = checkpoint.events.some((event) => (
    event.type === 'task.status.changed' && event.payload?.reason === 'auto-start'
  ));
  const expectedInitialObservations = normalizeInitialObservations(
    input.initialObservations,
    task.id,
    checkpoint.task.createdAt,
  );
  return stableJson(task.goal) === stableJson(goal)
    && stableJson(task.source) === stableJson(source)
    && stableJson(task.budgets) === stableJson(budgets)
    && (task.conversationId || '') === (input.conversationId || '')
    && (task.parentTaskId || '') === (input.parentTaskId || '')
    && (task.actionApprovalPolicy || 'kernel') === (input.actionApprovalPolicy || 'kernel')
    && (task.planningMode || 'adaptive') === (input.planningMode || 'adaptive')
    && stableJson(task.decisionModelPolicy || null) === stableJson(
      input.decisionModelPolicy ? normalizeDecisionModelPolicy(input.decisionModelPolicy) : null,
    )
    && stableJson(task.executionProfile || null) === stableJson(
      input.executionProfile ? normalizeExecutionProfile(input.executionProfile, source.surface) : null,
    )
    && expectedInitialObservations.every((expected) => checkpoint.observations.some((actual) => (
      actual.id === expected.id && stableJson(actual) === stableJson(expected)
    )))
    && originallyAutoStarted === shouldAutoStart;
}

function normalizeActionApprovalPolicy(value: string): 'kernel' | 'all-effects' {
  if (value !== 'kernel' && value !== 'all-effects') {
    throw new AgentRuntimeError(400, 'invalid-action-approval-policy', 'Agent action approval policy is unsupported.');
  }
  return value;
}

function normalizePlanningMode(value: string): 'adaptive' | 'model-first' {
  if (value !== 'adaptive' && value !== 'model-first') {
    throw new AgentRuntimeError(400, 'invalid-planning-mode', 'Agent planning mode is unsupported.');
  }
  return value;
}

function normalizeDecisionModelPolicy(value: AgentDecisionModelPolicy): AgentDecisionModelPolicy {
  const requestedRoleInput = String(value?.requestedRole || '');
  const requestedRole = requestedRoleInput === 'gemma4-deepthinking' || requestedRoleInput === 'gemma4-31b'
    ? 'qwen3.8-27b-pro'
    : requestedRoleInput;
  if (![
    'gemma4-fast',
    'gemma4-balanced',
    'gemma4-deepthinking',
    'gemma4-31b',
    'qwen3.8-27b-pro',
    'qwen3-coder-30b-a3b-instruct',
    'deepseek-coder-v2-lite-instruct',
  ].includes(requestedRole)) {
    throw new AgentRuntimeError(400, 'invalid-decision-model-role', 'Agent decision model role is unsupported.');
  }
  if (value.selectionSource !== 'user-explicit' || value.fallback !== 'exact') {
    throw new AgentRuntimeError(400, 'invalid-decision-model-policy', 'Agent decision model policy is unsupported.');
  }
  return {
    requestedRole: requestedRole as AgentDecisionModelPolicy['requestedRole'],
    selectionSource: 'user-explicit',
    fallback: 'exact',
  };
}

function normalizeExecutionProfile(
  value: AgentTaskExecutionProfile,
  surface: AgentTaskSurface,
): AgentTaskExecutionProfile {
  if (surface !== 'coder' || value?.schemaVersion !== AGENT_EXECUTION_PROFILE_SCHEMA_VERSION || value.kind !== 'coder-project') {
    throw new AgentRuntimeError(400, 'invalid-execution-profile', 'Coder execution profiles are only valid for the trusted Coder surface.');
  }
  const projectId = boundedId(value.projectId, 'Coder project');
  const projectRootInput = String(value.projectRoot || '').trim();
  if (!/^[A-Za-z]:[\\/]/u.test(projectRootInput) || projectRootInput.length > 2_048) {
    throw new AgentRuntimeError(400, 'invalid-execution-profile-root', 'Coder execution profile requires one exact absolute Windows project root.');
  }
  const profile = value.permissionProfile;
  if (!profile || !['read-only', 'workspace-write', 'danger-full-access'].includes(profile.sandboxMode)
    || !['on-request', 'never'].includes(profile.approvalPolicy)
    || (profile.autonomyMode !== undefined
      && !['guided', 'workspace-autonomous', 'full-local'].includes(profile.autonomyMode))) {
    throw new AgentRuntimeError(400, 'invalid-execution-permission-profile', 'Coder execution permission profile is unsupported.');
  }
  return {
    schemaVersion: AGENT_EXECUTION_PROFILE_SCHEMA_VERSION,
    kind: 'coder-project',
    projectId,
    projectRoot: path.resolve(projectRootInput),
    permissionProfile: {
      sandboxMode: profile.sandboxMode,
      approvalPolicy: profile.approvalPolicy,
      ...(profile.autonomyMode ? { autonomyMode: profile.autonomyMode } : {}),
    },
  };
}

function normalizeInitialObservations(
  input: AgentTaskInitialObservationInput[] | undefined,
  taskId: string,
  occurredAt: string,
): AgentObservation[] {
  if (!input?.length) return [];
  if (input.length > 4) {
    throw new AgentRuntimeError(400, 'too-many-initial-observations', 'At most four initial observations are allowed.');
  }
  return input.map((candidate, index) => {
    const capabilityId = String(candidate.capabilityId || '').trim().slice(0, 200);
    const summary = String(candidate.summary || '').trim().slice(0, 8_000);
    if (!capabilityId || !summary) {
      throw new AgentRuntimeError(400, 'invalid-initial-observation', 'Initial observations require capabilityId and summary.');
    }
    const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
    if (evidence.length === 0 || evidence.length > 8 || evidence.some((entry) => entry.evidenceClass !== 'model-generated')) {
      throw new AgentRuntimeError(
        400,
        'invalid-initial-observation-evidence',
        'Initial observations require one to eight model-generated evidence references.',
      );
    }
    const normalized = {
      capabilityId,
      summary,
      ...(candidate.structuredData === undefined ? {} : { structuredData: candidate.structuredData }),
      evidence,
      warnings: (candidate.warnings || []).map((warning) => String(warning).trim().slice(0, 500)).filter(Boolean).slice(0, 8),
    };
    return {
      schemaVersion: AGENT_OBSERVATION_SCHEMA_VERSION,
      id: `agent_observation_${digest(`initial:${taskId}:${index}:${stableJson(normalized)}`).slice(0, 32)}`,
      taskId,
      capabilityId,
      status: 'success',
      summary,
      ...(candidate.structuredData === undefined ? {} : { structuredData: candidate.structuredData }),
      evidence: evidence.map((entry) => ({ ...entry })),
      artifacts: [],
      warnings: normalized.warnings,
      retryable: false,
      occurredAt,
    };
  });
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}

function normalizeSource(input: AgentTaskSource): AgentTaskSource {
  const surfaces = new Set(['desktop', 'telegram', 'voice', 'api', 'coder', 'system', 'smoke']);
  if (!surfaces.has(input.surface)) throw new AgentRuntimeError(400, 'invalid-source', 'Agent task source is unsupported.');
  return {
    surface: input.surface,
    ...(input.requestId ? { requestId: boundedId(input.requestId, 'source request') } : {}),
    ...(input.conversationId ? { conversationId: boundedId(input.conversationId, 'source conversation') } : {}),
    ...(input.remote !== undefined ? { remote: input.remote } : {}),
  };
}

function approvalDecisionSurface(source: AgentTaskSurface): AgentTaskSurface {
  if (source === 'voice' || source === 'coder') return 'desktop';
  return source;
}

function boundedId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized)) {
    throw new AgentRuntimeError(400, `invalid-${label.replace(/\s+/g, '-')}-id`, `Invalid ${label} id.`);
  }
  return normalized;
}

function isTerminal(task: AgentTask): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

function hasPendingActiveApproval(checkpoint: AgentTaskCheckpoint): boolean {
  const approvalId = checkpoint.task.activeApprovalId;
  return Boolean(
    approvalId
    && checkpoint.task.pendingAction?.status === 'waiting-approval'
    && checkpoint.approvals.some((approval) => approval.id === approvalId && approval.status === 'pending'),
  );
}

function revokePendingApprovals(
  checkpoint: AgentTaskCheckpoint,
  resolvedAt: string,
): {
  changed: boolean;
  revokedActive: boolean;
  approvals: AgentApproval[];
  references: AgentTask['approvals'];
  events: Array<{ type: 'approval.resolved'; payload: { [key: string]: import('./types').AgentJsonValue } }>;
} {
  const revokedIds = new Set<string>();
  const approvals = checkpoint.approvals.map((approval): AgentApproval => {
    if (approval.status !== 'pending') return approval;
    revokedIds.add(approval.id);
    return {
      ...approval,
      status: 'revoked',
      resolvedAt,
      decision: {
        outcome: 'revoked',
        decidedAt: resolvedAt,
        decidedBy: 'system',
        reason: 'Task cancellation revoked the pending approval.',
      },
    };
  });
  return {
    changed: revokedIds.size > 0,
    revokedActive: checkpoint.task.activeApprovalId !== undefined
      && revokedIds.has(checkpoint.task.activeApprovalId),
    approvals,
    references: checkpoint.task.approvals.map((reference) => (
      revokedIds.has(reference.id) ? { ...reference, status: 'revoked' as const } : reference
    )),
    events: approvals
      .filter((approval) => revokedIds.has(approval.id))
      .map((approval) => ({
        type: 'approval.resolved' as const,
        payload: jsonObject({ approvalId: approval.id, decision: 'revoked', reason: 'task-cancelled' }),
      })),
  };
}

function jsonObject(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as { [key: string]: import('./types').AgentJsonValue };
}

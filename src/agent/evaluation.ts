import type { AgentApproval, AgentTaskCheckpoint, AgentTaskEvent } from './types';

export interface AgentEvaluationExpectation {
  clarificationExpected?: boolean;
}

export interface AgentEvaluationCase {
  id: string;
  checkpoint: AgentTaskCheckpoint;
  expectation?: AgentEvaluationExpectation;
}

export interface AgentEvaluationCaseResult {
  id: string;
  completed: boolean;
  unnecessaryClarifications: number;
  invalidDecisionRecovered: boolean | null;
  toolCalls: number;
  repeatedNoProgress: boolean;
  falseSuccess: boolean;
  permissionCorrect: boolean | null;
  cancellationCorrect: boolean | null;
  recoveredAfterToolFailure: boolean | null;
}

export interface AgentEvaluationReport {
  totalTasks: number;
  taskCompletionRate: number;
  unnecessaryClarificationCount: number;
  invalidToolCallRecoveryRate: number;
  averageToolCalls: number;
  repeatedNoProgressLoops: number;
  falseSuccessCount: number;
  permissionCorrectnessRate: number;
  cancellationCorrectnessRate: number;
  recoveryAfterFailureRate: number;
  cases: AgentEvaluationCaseResult[];
}

/**
 * Deterministic replay evaluator. It consumes only durable task records and
 * redacted events; model text and hidden reasoning are neither needed nor read.
 */
export function evaluateAgentRuns(inputs: readonly AgentEvaluationCase[]): AgentEvaluationReport {
  const cases = inputs.map(evaluateCase);
  return {
    totalTasks: cases.length,
    taskCompletionRate: ratio(cases.filter((entry) => entry.completed).length, cases.length),
    unnecessaryClarificationCount: sum(cases.map((entry) => entry.unnecessaryClarifications)),
    invalidToolCallRecoveryRate: nullableRate(cases.map((entry) => entry.invalidDecisionRecovered)),
    averageToolCalls: cases.length === 0 ? 0 : sum(cases.map((entry) => entry.toolCalls)) / cases.length,
    repeatedNoProgressLoops: cases.filter((entry) => entry.repeatedNoProgress).length,
    falseSuccessCount: cases.filter((entry) => entry.falseSuccess).length,
    permissionCorrectnessRate: nullableRate(cases.map((entry) => entry.permissionCorrect)),
    cancellationCorrectnessRate: nullableRate(cases.map((entry) => entry.cancellationCorrect)),
    recoveryAfterFailureRate: nullableRate(cases.map((entry) => entry.recoveredAfterToolFailure)),
    cases,
  };
}

function evaluateCase(input: AgentEvaluationCase): AgentEvaluationCaseResult {
  const { checkpoint } = input;
  const completed = checkpoint.task.status === 'completed';
  const invalidModelEvents = checkpoint.events.filter((event) => (
    event.type === 'model.completed' && event.payload?.valid === false && event.payload?.ok === true
  ));
  const recoveredInvalid = invalidModelEvents.length === 0
    ? null
    : invalidModelEvents.every((invalid) => checkpoint.events.some((candidate) => (
        candidate.sequence > invalid.sequence
        && candidate.type === 'model.completed'
        && candidate.payload?.valid === true
      )));
  const failedObservations = checkpoint.observations.filter((entry) => entry.status === 'failed' || entry.status === 'partial');
  const recoveredAfterFailure = failedObservations.length === 0
    ? null
    : completed && failedObservations.every((failed) => checkpoint.observations.some((candidate) => (
        candidate.occurredAt >= failed.occurredAt && candidate.status === 'success'
      )));
  const cancellation = checkpoint.task.status === 'cancelled'
    ? cancellationIsConsistent(checkpoint.events)
    : null;
  const approvals = checkpoint.approvals;
  const permission = approvals.length === 0 ? null : approvals.every((approval) => approvalIsConsistent(approval, checkpoint));
  const assistantClarifications = checkpoint.task.messages.filter((entry) => (
    entry.role === 'assistant' && entry.kind === 'clarification'
  )).length;
  const hasVerifiedCompletion = checkpoint.events.some((event) => (
    event.type === 'verification.completed' && event.payload?.status === 'verified'
  ));
  const requiredArtifacts = checkpoint.task.goal.expectedOutputs.some((output) => output.required !== false && output.kind === 'artifact');
  const mutationEvidenceMissing = checkpoint.observations.some((observation) => (
    observation.status === 'success'
    && observation.artifacts.length > 0
    && !observation.evidence.some((evidence) => /verification|side-effect/i.test(evidence.reference))
  ));

  return {
    id: input.id,
    completed,
    unnecessaryClarifications: input.expectation?.clarificationExpected === true ? 0 : assistantClarifications,
    invalidDecisionRecovered: recoveredInvalid,
    toolCalls: checkpoint.task.usage.toolCalls,
    repeatedNoProgress: checkpoint.task.usage.consecutiveNoProgress >= checkpoint.task.budgets.maxConsecutiveNoProgress,
    falseSuccess: completed && (!hasVerifiedCompletion || (requiredArtifacts && checkpoint.task.artifacts.length === 0) || mutationEvidenceMissing),
    permissionCorrect: permission,
    cancellationCorrect: cancellation,
    recoveredAfterToolFailure: recoveredAfterFailure,
  };
}

function cancellationIsConsistent(events: readonly AgentTaskEvent[]): boolean {
  const terminal = events.find((event) => event.type === 'task.cancelled');
  if (!terminal) return false;
  return !events.some((event) => event.sequence > terminal.sequence && event.type === 'tool.started');
}

function approvalIsConsistent(approval: AgentApproval, checkpoint: AgentTaskCheckpoint): boolean {
  if (approval.status === 'pending') return false;
  const resolved = checkpoint.events.find((event) => (
    event.type === 'approval.resolved' && event.payload?.approvalId === approval.id
  ));
  if (!resolved) return approval.status === 'revoked' && checkpoint.task.status === 'cancelled';
  if (approval.status !== 'approved') {
    return !checkpoint.events.some((event) => (
      event.sequence > resolved.sequence
      && event.type === 'tool.started'
      && event.payload?.capabilityId === approval.capabilityId
    ));
  }
  return checkpoint.observations.some((observation) => (
    observation.capabilityId === approval.capabilityId
    && observation.status === 'success'
    && (!approval.resolvedAt || observation.occurredAt >= approval.resolvedAt)
  ));
}

function nullableRate(values: Array<boolean | null>): number {
  const applicable = values.filter((value): value is boolean => value !== null);
  return applicable.length === 0 ? 1 : ratio(applicable.filter(Boolean).length, applicable.length);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

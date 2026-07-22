import { createHash } from 'node:crypto';
import {
  AGENT_CHECKPOINT_SCHEMA_VERSION,
  type AgentApproval,
  type AgentObservation,
  type AgentTask,
  type AgentTaskCheckpoint,
  type AgentTaskEvent,
  type AgentTaskStatus,
} from './types';

export type AgentCheckpointReason =
  | 'task-created'
  | 'goal-normalized'
  | 'plan-revised'
  | 'before-sensitive-action'
  | 'observation-recorded'
  | 'approval-resolved'
  | 'status-changed'
  | 'cancellation-requested'
  | 'terminal-state';

export interface AgentCheckpointSignal {
  taskCreated?: boolean;
  goalNormalized?: boolean;
  planRevised?: boolean;
  beforeSensitiveAction?: boolean;
  observationRecorded?: boolean;
  approvalResolved?: boolean;
  statusChanged?: boolean;
  cancellationRequested?: boolean;
  terminalState?: boolean;
}

export interface AgentCheckpointVerification {
  ok: boolean;
  errors: string[];
  digest: string;
}

export interface CreateAgentTaskCheckpointOptions {
  observations?: AgentObservation[];
  approvals?: AgentApproval[];
  savedAt?: Date | string | number;
}

const TERMINAL_STATUSES = new Set<AgentTaskStatus>(['completed', 'failed', 'cancelled']);

export function checkpointReasonFor(signal: AgentCheckpointSignal): AgentCheckpointReason | null {
  if (signal.terminalState) return 'terminal-state';
  if (signal.cancellationRequested) return 'cancellation-requested';
  if (signal.beforeSensitiveAction) return 'before-sensitive-action';
  if (signal.approvalResolved) return 'approval-resolved';
  if (signal.observationRecorded) return 'observation-recorded';
  if (signal.planRevised) return 'plan-revised';
  if (signal.goalNormalized) return 'goal-normalized';
  if (signal.taskCreated) return 'task-created';
  if (signal.statusChanged) return 'status-changed';
  return null;
}

export function createAgentTaskCheckpoint(
  task: AgentTask,
  events: AgentTaskEvent[],
  options: CreateAgentTaskCheckpointOptions = {},
): AgentTaskCheckpoint {
  if (!String(task.id || '').trim()) throw new Error('Agent checkpoint requires a task id.');
  if (!Number.isInteger(task.checkpointVersion) || task.checkpointVersion < 1) {
    throw new Error('Agent checkpoint version must be a positive integer.');
  }
  const checkpoint: AgentTaskCheckpoint = {
    schemaVersion: AGENT_CHECKPOINT_SCHEMA_VERSION,
    task: cloneJson(task, 'task'),
    events: cloneJson(events, 'events'),
    observations: cloneJson(options.observations || [], 'observations'),
    approvals: cloneJson(options.approvals || [], 'approvals'),
    savedAt: normalizeIso(options.savedAt ?? Date.now()),
  };
  const verification = verifyAgentTaskCheckpoint(checkpoint);
  if (!verification.ok) {
    throw new Error('Invalid agent checkpoint: ' + verification.errors.join(' '));
  }
  return checkpoint;
}

export function verifyAgentTaskCheckpoint(
  checkpoint: AgentTaskCheckpoint,
  previous?: AgentTaskCheckpoint,
): AgentCheckpointVerification {
  const errors: string[] = [];
  if (checkpoint.schemaVersion !== AGENT_CHECKPOINT_SCHEMA_VERSION) {
    errors.push('Unsupported checkpoint schema version.');
  }
  if (!String(checkpoint.task.id || '').trim()) errors.push('Checkpoint task id is missing.');
  if (!Number.isInteger(checkpoint.task.checkpointVersion) || checkpoint.task.checkpointVersion < 1) {
    errors.push('Checkpoint version must be a positive integer.');
  }
  if (!Number.isFinite(Date.parse(checkpoint.savedAt))) errors.push('Checkpoint savedAt is invalid.');

  let previousSequence = 0;
  const eventIds = new Set<string>();
  for (const event of checkpoint.events) {
    if (event.taskId !== checkpoint.task.id) errors.push('Checkpoint contains an event for another task.');
    if (!Number.isInteger(event.sequence) || event.sequence <= previousSequence) {
      errors.push('Checkpoint event sequence is not strictly increasing.');
    }
    if (eventIds.has(event.id)) errors.push('Checkpoint contains a duplicate event id.');
    eventIds.add(event.id);
    previousSequence = Math.max(previousSequence, event.sequence);
  }
  if (checkpoint.events.length > 0 && previousSequence !== checkpoint.task.eventSequence) {
    errors.push('Checkpoint event sequence does not match task eventSequence.');
  }
  if (checkpoint.observations.some((entry) => entry.taskId !== checkpoint.task.id)) {
    errors.push('Checkpoint contains an observation for another task.');
  }
  if (checkpoint.approvals.some((entry) => entry.taskId !== checkpoint.task.id)) {
    errors.push('Checkpoint contains an approval for another task.');
  }

  if (previous) {
    if (previous.task.id !== checkpoint.task.id) errors.push('Checkpoint task id changed.');
    if (checkpoint.task.checkpointVersion !== previous.task.checkpointVersion + 1) {
      errors.push('Checkpoint version is not contiguous.');
    }
    if (checkpoint.task.eventSequence < previous.task.eventSequence) {
      errors.push('Checkpoint event sequence moved backwards.');
    }
    if (TERMINAL_STATUSES.has(previous.task.status) && checkpoint.task.status !== previous.task.status) {
      errors.push('Terminal task status is immutable.');
    }
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    digest: agentCheckpointDigest(checkpoint),
  };
}

export function recoveryStatusFor(status: AgentTaskStatus): AgentTaskStatus {
  if (TERMINAL_STATUSES.has(status)) return status;
  if (
    status === 'waiting-for-user'
    || status === 'waiting-for-approval'
    || status === 'waiting-for-runtime'
    || status === 'paused'
    || status === 'interrupted'
  ) {
    return status;
  }
  return 'interrupted';
}

export function isTerminalAgentStatus(status: AgentTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function agentCheckpointDigest(checkpoint: AgentTaskCheckpoint): string {
  return createHash('sha256').update(stableJson(checkpoint), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) throw new Error('Agent checkpoint is not JSON serializable.');
  return serialized;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = sortJsonValue(source[key]);
  return sorted;
}

function cloneJson<T>(value: T, label: string): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not JSON serializable');
    return JSON.parse(serialized) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error('Agent checkpoint ' + label + ' must be JSON serializable: ' + detail);
  }
}

function normalizeIso(value: Date | string | number): string {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Agent checkpoint timestamp is invalid.');
  return new Date(timestamp).toISOString();
}

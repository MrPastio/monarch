import { describe, expect, it } from 'vitest';
import {
  agentCheckpointDigest,
  checkpointReasonFor,
  createAgentTaskCheckpoint,
  recoveryStatusFor,
  verifyAgentTaskCheckpoint,
} from '../../src/agent/checkpoint-manager';
import {
  AGENT_TASK_EVENT_SCHEMA_VERSION,
  AGENT_TASK_SCHEMA_VERSION,
  type AgentTask,
  type AgentTaskEvent,
} from '../../src/agent/types';

describe('agent checkpoint helpers', () => {
  it('creates a versioned checkpoint and verifies event/task consistency', () => {
    const event = taskEvent(1);
    const checkpoint = createAgentTaskCheckpoint(task(1, 1), [event], {
      savedAt: '2026-07-22T10:00:00Z',
    });
    expect(checkpoint.savedAt).toBe('2026-07-22T10:00:00.000Z');
    expect(verifyAgentTaskCheckpoint(checkpoint)).toMatchObject({ ok: true });
    expect(agentCheckpointDigest(checkpoint)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects non-contiguous checkpoints and keeps terminal states immutable', () => {
    const previous = createAgentTaskCheckpoint(task(1, 1, 'completed'), [taskEvent(1)]);
    const next = createAgentTaskCheckpoint(task(3, 1, 'running'), [taskEvent(1)]);
    expect(verifyAgentTaskCheckpoint(next, previous)).toMatchObject({ ok: false });
    expect(verifyAgentTaskCheckpoint(next, previous).errors).toContain('Terminal task status is immutable.');
  });

  it('prioritizes mandatory checkpoint triggers and marks active work interrupted', () => {
    expect(checkpointReasonFor({ planRevised: true, beforeSensitiveAction: true }))
      .toBe('before-sensitive-action');
    expect(recoveryStatusFor('running')).toBe('interrupted');
    expect(recoveryStatusFor('waiting-for-approval')).toBe('waiting-for-approval');
    expect(recoveryStatusFor('completed')).toBe('completed');
  });
});

function task(
  checkpointVersion: number,
  eventSequence: number,
  status: AgentTask['status'] = 'running',
): AgentTask {
  return {
    schemaVersion: AGENT_TASK_SCHEMA_VERSION,
    id: 'task-1',
    traceId: 'trace-1',
    source: { surface: 'api' },
    goal: {
      originalRequest: 'Create a report.',
      normalizedObjective: 'Create a verified report.',
      expectedOutputs: [{ id: 'report', description: 'Report file' }],
      constraints: [],
      successCriteria: [{ id: 'exists', description: 'File exists' }],
    },
    status,
    messages: [],
    observations: [],
    artifacts: [],
    approvals: [],
    budgets: {
      maxSteps: 10,
      maxModelTurns: 5,
      maxToolCalls: 10,
      maxWallTimeMs: 60_000,
      maxFailures: 2,
      maxConsecutiveNoProgress: 2,
    },
    usage: {
      steps: 0,
      modelTurns: 0,
      toolCalls: 0,
      failures: 0,
      consecutiveNoProgress: 0,
      startedAt: '2026-07-22T10:00:00.000Z',
      updatedAt: '2026-07-22T10:00:00.000Z',
    },
    checkpointVersion,
    eventSequence,
    createdAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:00.000Z',
  };
}

function taskEvent(sequence: number): AgentTaskEvent {
  return {
    schemaVersion: AGENT_TASK_EVENT_SCHEMA_VERSION,
    id: 'event-' + String(sequence),
    taskId: 'task-1',
    traceId: 'trace-1',
    sequence,
    type: 'task.status.changed',
    createdAt: '2026-07-22T10:00:00.000Z',
  };
}

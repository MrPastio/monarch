import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MonarchApplication } from '../../src/app/application';
import {
  InMemoryAgentTaskStore,
  type AgentDecisionProvider,
  type AgentModelDecisionResponse,
  type AgentTaskCheckpoint,
} from '../../src/agent';

describe('Oscar Agent Task scheduling stress', () => {
  it('settles 50 sequential and 8 concurrent tasks without orphaned runners or duplicate terminals', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'monarch-agent-task-stress-'));
    const store = new InMemoryAgentTaskStore();
    const app = new MonarchApplication({
      workspaceRoot: root,
      enabledModules: ['workspace'],
      enableLocalSystemRouter: false,
      enableAgentRuntimeV2: true,
      agentTaskStore: store,
      agentDecisionProvider: new DeterministicTerminalProvider(),
    });
    await app.start();
    try {
      const completed: AgentTaskCheckpoint[] = [];
      for (let index = 0; index < 50; index += 1) {
        const created = await app.createAgentTask({
          request: `Synthetic sequential lifecycle ${index}`,
          source: { surface: 'smoke' },
          clientRequestId: `stress-sequential-${index}`,
        });
        completed.push(await waitForTerminal(app, created.task.id));
      }
      const concurrent = await Promise.all(Array.from({ length: 8 }, async (_entry, index) => {
        const created = await app.createAgentTask({
          request: `Synthetic concurrent lifecycle ${index}`,
          source: { surface: 'smoke' },
          clientRequestId: `stress-concurrent-${index}`,
        });
        return waitForTerminal(app, created.task.id);
      }));
      completed.push(...concurrent);

      expect(completed).toHaveLength(58);
      expect(completed.every((checkpoint) => checkpoint.task.status === 'failed')).toBe(true);
      expect(completed.every((checkpoint) => checkpoint.task.runnerClaim === undefined)).toBe(true);
      expect(completed.every((checkpoint) => (
        checkpoint.events.filter((event) => event.type === 'task.failed').length === 1
      ))).toBe(true);
      expect(new Set(completed.map((checkpoint) => checkpoint.task.id)).size).toBe(58);
      expect(await store.listTasks()).toHaveLength(58);
    } finally {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

class DeterministicTerminalProvider implements AgentDecisionProvider {
  decide(): Promise<AgentModelDecisionResponse> {
    return Promise.resolve({
      ok: true,
      role: 'stress-fixture',
      adapter: 'stress-fixture',
      rawText: JSON.stringify({
        kind: 'fail',
        code: 'synthetic-terminal',
        reason: 'Synthetic terminal used only to stress durable Agent Task scheduling.',
      }),
    });
  }
}

async function waitForTerminal(app: MonarchApplication, taskId: string): Promise<AgentTaskCheckpoint> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const checkpoint = await app.agentRuntime!.getTask(taskId);
    if (checkpoint && ['completed', 'failed', 'cancelled'].includes(checkpoint.task.status)) return checkpoint;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Agent Task ${taskId} did not settle before the stress deadline.`);
}

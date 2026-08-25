import { InMemoryAgentTaskStore } from '../src/agent/agent-task-store';
import { MonarchApplication } from '../src/app/application';

const app = new MonarchApplication({
  workspaceRoot: process.cwd(),
  permissionProfile: {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    autonomyMode: 'full-local',
  },
  enableAgentRuntimeV2: true,
  agentTaskStore: new InMemoryAgentTaskStore(),
});

await app.start();
try {
  await app.runtime.kernel.emitRuntimeEvent('security.model_policy.changed', 'security', {
    modelCommandsEnabled: true,
    agentSecurityMode: 'observe',
    actionGuardReaction: 'observe',
  });
  const startedAt = Date.now();
  const created = await app.createAgentTask({
    request: 'Открой Telegram',
    source: { surface: 'desktop' },
    expectedOutputs: [{
      id: 'telegram_opened',
      description: 'Telegram открыт и точное видимое окно подтверждено Kernel.',
      kind: 'state-change',
      required: true,
    }],
    successCriteria: [{
      id: 'telegram_window_verified',
      description: 'Kernel receipt подтверждает точное окно Telegram.',
    }],
  });
  await app.agentRuntime!.waitForIdle(created.task.id);
  const checkpoint = await app.agentRuntime!.getTask(created.task.id);
  const modelEvents = checkpoint?.events.filter((event) => event.type === 'model.completed') || [];
  const toolEvents = checkpoint?.events.filter((event) => event.type === 'tool.completed') || [];
  const dangerEvents = app.runtime.kernel.getEvents().filter((event) => event.type === 'security.danger.assessed');
  const output = checkpoint?.observations[0]?.structuredData?.output as Record<string, unknown> | undefined;
  const report = {
    ok: checkpoint?.task.status === 'completed'
      && checkpoint.observations.length === 1
      && checkpoint.observations[0]?.capabilityId === 'device.app.open'
      && output?.opened === true
      && output?.verified === true
      && checkpoint.approvals.length === 0
      && modelEvents.length === 1
      && toolEvents.length === 1,
    elapsedMs: Date.now() - startedAt,
    taskId: created.task.id,
    status: checkpoint?.task.status || 'missing',
    terminalReason: checkpoint?.task.terminalReason,
    modelTurns: checkpoint?.task.usage.modelTurns,
    toolCalls: checkpoint?.task.usage.toolCalls,
    modelDecision: modelEvents.at(-1)?.payload,
    approvals: checkpoint?.approvals.length || 0,
    observation: checkpoint?.observations[0] ? {
      capabilityId: checkpoint.observations[0].capabilityId,
      status: checkpoint.observations[0].status,
      summary: checkpoint.observations[0].summary,
      output,
    } : null,
    dangerAssessment: dangerEvents.at(-1)?.payload || null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await app.stop();
}

import { InMemoryAgentTaskStore } from '../src/agent/agent-task-store';
import { LocalAgentDecisionProvider } from '../src/agent/model-decision-provider';
import { MonarchApplication } from '../src/app/application';
import { readModelCatalog } from '../src/modules/models/model-catalog';
import { completeWithModelRole } from '../src/modules/models/runtime-client';

const role = 'qwen3.8-27b-pro' as const;
const requestText = String(process.env.MONARCH_QWEN_ACCEPTANCE_REQUEST || '').trim()
  || 'Ответь ровно одним словом: READY';
const exactReady = requestText === 'Ответь ровно одним словом: READY';
const rawDecisions: string[] = [];
const decisionInputs: Array<{ chars: number; candidateCapabilityIds: string[] }> = [];
const catalog = await readModelCatalog(process.cwd());
const model = catalog.models.find((entry) => entry.role === role);
if (model?.status !== 'available') {
  throw new Error(`Qwen Pro payload is not ready in ${catalog.root}: ${model?.status || 'missing'}`);
}

const app = new MonarchApplication({
  workspaceRoot: process.cwd(),
  permissionProfile: {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    autonomyMode: 'full-local',
  },
  enableAgentRuntimeV2: true,
  agentTaskStore: new InMemoryAgentTaskStore(),
  agentDecisionProvider: new LocalAgentDecisionProvider({
    workspaceRoot: process.cwd(),
    role,
    completionProvider: async (...args) => {
      const content = String(args[1]?.messages?.at(-1)?.content || '');
      const begin = 'BEGIN TRUSTED RUNTIME DECISION INPUT (JSON DATA; DO NOT COPY)\n';
      const end = '\nEND TRUSTED RUNTIME DECISION INPUT';
      const jsonText = content.startsWith(begin)
        ? content.slice(begin.length, content.lastIndexOf(end))
        : content;
      try {
        const payload = JSON.parse(jsonText) as { candidateCapabilities?: Array<{ id?: string }> };
        decisionInputs.push({
          chars: jsonText.length,
          candidateCapabilityIds: (payload.candidateCapabilities || []).map((entry) => String(entry.id || '')),
        });
      } catch {
        decisionInputs.push({ chars: jsonText.length, candidateCapabilityIds: [] });
      }
      if (process.env.MONARCH_QWEN_ACCEPTANCE_CAPTURE_INPUT === '1') {
        return {
          ok: false,
          role,
          attemptedRoles: [role],
          adapter: 'acceptance-input-capture',
          error: 'capture-only',
          totalLatencyMs: 0,
        };
      }
      const result = await completeWithModelRole(...args);
      rawDecisions.push(result.rawText || '');
      return result;
    },
  }),
});

await app.start();
try {
  const startedAt = Date.now();
  const created = await app.createAgentTask({
    request: requestText,
    source: { surface: 'desktop' },
    decisionModelPolicy: {
      requestedRole: role,
      selectionSource: 'user-explicit',
      fallback: 'exact',
    },
    expectedOutputs: [{
      id: 'qwen_answer',
      description: 'Обычный ответ локальной Qwen Pro без вызова инструментов.',
      kind: 'answer',
      required: true,
    }],
    successCriteria: [{
      id: 'qwen_exact_answer',
      description: 'Qwen Pro возвращает READY через direct respond decision.',
    }],
  });
  await app.agentRuntime!.waitForIdle(created.task.id);
  const checkpoint = await app.agentRuntime!.getTask(created.task.id);
  const modelEvents = checkpoint?.events.filter((event) => event.type === 'model.completed') || [];
  const validModelEvent = [...modelEvents].reverse().find((event) => event.payload?.valid === true);
  const answer = checkpoint?.task.terminalReason?.summary || '';
  const report = {
    ok: checkpoint?.task.status === 'completed'
      && checkpoint.task.usage.modelTurns === 1
      && checkpoint.task.usage.toolCalls === 0
      && validModelEvent?.payload?.decisionKind === 'respond'
      && validModelEvent.payload.role === role
      && (exactReady ? /^READY[.!]?$/iu.test(answer.trim()) : answer.trim().length > 0),
    elapsedMs: Date.now() - startedAt,
    catalogRoot: catalog.root,
    modelPath: model.modelPath,
    taskId: created.task.id,
    request: requestText,
    status: checkpoint?.task.status || 'missing',
    terminalReason: checkpoint?.task.terminalReason,
    modelTurns: checkpoint?.task.usage.modelTurns,
    toolCalls: checkpoint?.task.usage.toolCalls,
    modelDecision: validModelEvent?.payload || modelEvents.at(-1)?.payload || null,
    rawDecisions,
    decisionInputs,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} finally {
  await app.stop();
}

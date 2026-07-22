import { describe, expect, it } from 'vitest';
import { ReplayAgentDecisionProvider } from '../../src/agent/model-decision-provider';

describe('agent model decision provider', () => {
  it('provides deterministic replay decisions without executing model text', async () => {
    const provider = new ReplayAgentDecisionProvider(['{"kind":"fail","code":"done","reason":"fixture"}']);
    const result = await provider.decide({
      taskId: 'task_1', traceId: 'trace_1', compiledContext: {}, capabilities: [],
    });
    expect(result).toMatchObject({ ok: true, adapter: 'replay' });
    expect(provider.requests).toHaveLength(1);
  });

  it('honors cancellation before consuming a replay turn', async () => {
    const provider = new ReplayAgentDecisionProvider(['{}']);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.decide({
      taskId: 'task_1', traceId: 'trace_1', compiledContext: {}, capabilities: [], signal: controller.signal,
    })).resolves.toMatchObject({ ok: false, error: 'model-call-aborted' });
    expect(provider.requests).toHaveLength(1);
  });
});

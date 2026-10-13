import { describe, expect, it, vi } from 'vitest';
import { maxCloudEffortFields, maxCloudEffortTunable } from '../../src/agent-v3/max-cloud-catalog';
import { MaxCloudProvider } from '../../src/agent-v3/max-cloud-provider';

const key = 'synthetic-key-never-a-real-secret-123';
const schema = { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] };

describe('MAX cloud reasoning depth', () => {
  it('maps depth into each service API form and skips models without it', () => {
    expect(maxCloudEffortFields('deepseek', 'deepseek-chat', 'high')).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'max' });
    expect(maxCloudEffortFields('deepseek', 'deepseek-chat', 'medium').reasoning_effort).toBe('high');
    expect(maxCloudEffortFields('openai', 'o4-mini', 'low')).toEqual({ reasoning_effort: 'low' });
    expect(maxCloudEffortFields('openai', 'gpt-4.1', 'high')).toEqual({});
    expect(maxCloudEffortFields('anthropic', 'claude-sonnet-4-6', 'medium')).toEqual({ thinking: { type: 'enabled', budget_tokens: 4096 } });
    expect(maxCloudEffortFields('openrouter', 'openai/gpt-5', 'high')).toEqual({ reasoning: { effort: 'high' } });
    expect(maxCloudEffortFields('xai', 'grok-3-mini', 'medium')).toEqual({ reasoning_effort: 'low' });
    expect(maxCloudEffortFields('cerebras', 'gpt-oss-120b', 'high')).toEqual({ reasoning_effort: 'high' });
    expect(maxCloudEffortFields('deepseek', 'deepseek-chat', undefined)).toEqual({});
    expect(maxCloudEffortTunable('mistral', 'mistral-large-latest')).toBe(false);
    expect(maxCloudEffortTunable('gemini', 'gemini-3.8-flash')).toBe(true);
  });
  it('applies depth to the answer only, never to the safety screens', async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body);
      const safety = JSON.stringify(body).includes('safety classification stage');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(safety ? { decision: 'allow' } : { text: 'ок' }) } }] }));
    });
    await new MaxCloudProvider({ providerId: 'cerebras', model: 'gpt-oss-120b', apiKey: key, reasoningEffort: 'low', fetch: fetchFn })
      .propose([{ role: 'user', content: 'привет' }], schema, 2048);
    expect(bodies[0].reasoning_effort).toBeUndefined(); expect(bodies[2].reasoning_effort).toBeUndefined();
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'low', max_tokens: 2048 });
  });
  it('runs a DeepSeek agent step without its unbounded thinking', async () => {
    // Live: a step writing a game file spent 20,192, then 40,960 tokens thinking and returned nothing.
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body);
      const safety = JSON.stringify(body).includes('safety classification stage');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(safety ? { decision: 'allow' } : { text: 'ок' }) } }] }));
    });
    await new MaxCloudProvider({ providerId: 'deepseek', model: 'deepseek-chat', apiKey: key, reasoningEffort: 'high', fetch: fetchFn })
      .propose([{ role: 'user', content: 'привет' }], schema, 8192);
    expect(bodies[1].thinking).toBeUndefined(); expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(bodies[1].max_tokens).toBe(8192);
  });
  it('gives Claude room for thinking and drops thinking blocks from the proposal', async () => {
    const bodies: any[] = [];
    const fetchFn = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body);
      const safety = JSON.stringify(body).includes('safety classification stage');
      const text = JSON.stringify(safety ? { decision: 'allow' } : { text: 'ок' });
      return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [
        ...(safety ? [] : [{ type: 'thinking', thinking: 'notes', signature: 'x' }]), { type: 'text', text }] }));
    });
    const value = await new MaxCloudProvider({ providerId: 'anthropic', model: 'claude-sonnet-4-6', apiKey: key, reasoningEffort: 'high', fetch: fetchFn })
      .propose([{ role: 'user', content: 'привет' }], schema, 2048);
    expect(value).toEqual({ text: 'ок' });
    expect(bodies[1].thinking).toEqual({ type: 'enabled', budget_tokens: 12_000 });
    expect(bodies[1].max_tokens).toBe(2048 + 12_000);
    expect(bodies[0].thinking).toBeUndefined();
  });
});

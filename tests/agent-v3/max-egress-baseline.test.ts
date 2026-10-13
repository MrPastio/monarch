import { describe, expect, it, vi } from 'vitest';
import { MAX_CLOUD_PROVIDERS } from '../../src/agent-v3/max-cloud-catalog';
import { MaxCloudProvider } from '../../src/agent-v3/max-cloud-provider';

/** Baseline for the Monarch Security program (stage 1, finding F-08): what one
 * MAX chat answer sends today. These numbers are a measurement, not a target —
 * the egress gateway (stage 2) is expected to change them, and this test must
 * then be updated together with that change, never loosened silently. */

const key = 'synthetic-key-never-a-real-secret-123';
const CONTEXT_CANARY = 'CANARY-CONTEXT-7f3a91';
const ANSWER = 'Синтетический ответ без личных данных.';

function sse(events: unknown[]) {
  const text = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}

function capture() {
  const requests: Array<{ url: string; body: string; headers: string }> = [];
  const fetchFn = vi.fn(async (url: any, init: any) => {
    const body = String(init.body ?? '');
    requests.push({ url: String(url), body, headers: JSON.stringify(init.headers ?? {}) });
    const parsed = JSON.parse(body);
    if (body.includes('safety classification stage for Monarch MAX')) {
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ decision: 'allow' }) } }] }));
    }
    expect(parsed.stream).toBe(true);
    return sse([{ choices: [{ delta: { content: ANSWER }, finish_reason: 'stop' }] }]);
  });
  return { requests, fetchFn };
}

describe('MAX egress baseline: one chat answer', () => {
  it('sends the full context twice and the answer once more, to the same provider only', async () => {
    const provider = MAX_CLOUD_PROVIDERS.find(item => item.id === 'deepseek')!;
    const { requests, fetchFn } = capture();
    const stream = new MaxCloudProvider({ providerId: provider.id, model: provider.model, apiKey: key, fetch: fetchFn })
      .streamText([
        { role: 'system', content: 'Синтетическая история.' },
        { role: 'user', content: `Вопрос с меткой ${CONTEXT_CANARY}.` },
      ], 2048);
    const shown: string[] = [];
    for await (const piece of stream) shown.push(piece);
    expect(shown.join('')).toBe(ANSWER);

    // Input screen, the answer itself, output screen.
    expect(requests).toHaveLength(3);
    expect(requests.filter(item => item.body.includes(CONTEXT_CANARY))).toHaveLength(2);
    expect(requests.filter(item => item.body.includes(ANSWER))).toHaveLength(1);
    for (const request of requests) {
      expect(request.url.startsWith(provider.base + '/')).toBe(true);
      // The connection key is authentication only: never in a URL or a body.
      expect(request.url).not.toContain(key);
      expect(request.body).not.toContain(key);
      expect(request.headers).toContain(key);
    }
  });
});

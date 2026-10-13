import { expect, it, vi } from 'vitest';
import { listMaxCloudModels } from '../../src/agent-v3/max-cloud-models';
import { MAX_CLOUD_PROVIDERS } from '../../src/agent-v3/max-cloud-catalog';
const key = 'synthetic-provider-key-123456789';
it.each(MAX_CLOUD_PROVIDERS.filter(p => p.id !== 'groq'))('reads $id catalog with bounded authenticated GET and no prompts', async p => {
  const row = p.id === 'gemini' ? { name: 'models/gemini-example', supportedGenerationMethods: ['generateContent'] }
    : p.id === 'fireworks' ? { name: 'accounts/fireworks/models/example', supportsServerless: true, conversationConfig: {} }
    : { id: p.id === 'openai' ? 'gpt-example' : 'Example/Chat', type: 'chat', display_name: 'Example Chat' };
  const fetcher = vi.fn(async (url: any, init: any) => {
    expect(new URL(url).protocol).toBe('https:'); expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal); expect(JSON.stringify(init.headers)).toContain(key);
    return Response.json(p.id === 'together' ? [row] : p.id === 'gemini' || p.id === 'fireworks' ? { models: [row] } : { data: [row] });
  });
  const result = await listMaxCloudModels(p.id, key, fetcher);
  expect(result).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(key); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects unknown providers and invalid credentials before network', async () => {
  const fetcher = vi.fn(); await expect(listMaxCloudModels('evil' as any, key, fetcher)).rejects.toThrow();
  await expect(listMaxCloudModels('openai', 'bad', fetcher)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
});
it('preserves Groq admission without querying or listing retired models', async () => {
  const fetcher = vi.fn(); expect(await listMaxCloudModels('groq', key, fetcher)).toEqual([{ id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B' }]); expect(fetcher).not.toHaveBeenCalled();
});
it('follows only bounded host-owned pagination and drops non-chat models', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-a', display_name: 'Claude A' }], has_more: true, last_id: 'claude-a' }))
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'claude-b' }, { id: 'embedding-example' }], has_more: false }));
  expect(await listMaxCloudModels('anthropic', key, fetcher)).toHaveLength(2);
  expect(fetcher.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models?limit=100&after_id=claude-a');
});
it('never exposes rejected response bodies or saves the key', async () => {
  await expect(listMaxCloudModels('openai', key, vi.fn(async () => new Response(key, { status: 401 })))).rejects.toThrow('credential-rejected');
});
it('rejects oversized catalogs', async () => {
  await expect(listMaxCloudModels('openai', key, vi.fn(async () => new Response('x'.repeat(4*1024*1024+1))))).rejects.toThrow('catalog-budget');
});

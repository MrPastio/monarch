import { describe, expect, it, vi } from 'vitest';
import { AiHordeProvider, AiHordeProviderError } from '../../src/image-generation';

const WEBP_1X1 = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==', 'base64');

describe('AiHordeProvider', () => {
  it('submits an anonymous bounded job with privacy and safety controls', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => jsonResponse({
      id: '12345678-1234-1234-1234-123456789abc',
      kudos: 0,
      warnings: [],
    }, 202));
    const provider = new AiHordeProvider({ fetchFn: fetchFn as typeof fetch, apiBaseUrl: 'https://example.test/api/v2' });
    await expect(provider.submit({
      prompt: 'orange butterfly',
      negativePrompt: 'text',
      aspectRatio: '16:9',
      count: 2,
      seed: '42',
    }, 'safe')).resolves.toMatchObject({ requestId: '12345678-1234-1234-1234-123456789abc' });

    const [, init] = fetchFn.mock.calls[0] || [];
    expect(new Headers(init?.headers).get('apikey')).toBe('0000000000');
    expect(new Headers(init?.headers).get('Client-Agent')).toContain('Monarch:');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: 'orange butterfly ### text',
      params: { width: 896, height: 512, n: 2, seed: '42' },
      nsfw: false,
      trusted_workers: true,
      censor_nsfw: true,
      r2: false,
      shared: true,
      allow_downgrade: true,
    });
  });

  it('passes an enabled NSFW policy to the provider without the SFW censor flag', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: '12345678-1234-1234-1234-123456789abc', kudos: 0 }, 202));
    const provider = new AiHordeProvider({ fetchFn: fetchFn as typeof fetch });
    await provider.submit({ prompt: 'adult figure study' }, 'nsfw');
    const [, init] = fetchFn.mock.calls[0] || [];
    expect(JSON.parse(String(init?.body))).toMatchObject({ nsfw: true, censor_nsfw: false });
  });

  it('decodes an inline image and refuses arbitrary result URLs', async () => {
    const payloads = [
      { done: true, finished: 1, generations: [{ img: WEBP_1X1.toString('base64'), state: 'ok', model: 'test', seed: '7' }] },
      { done: true, finished: 1, generations: [{ img: 'https://attacker.example/image.webp', state: 'ok' }] },
    ];
    const fetchFn = vi.fn(async () => jsonResponse(payloads.shift() || {}));
    const provider = new AiHordeProvider({ fetchFn: fetchFn as typeof fetch });
    await expect(provider.status('12345678-1234-1234-1234-123456789abc')).resolves.toMatchObject({
      generations: [{ mimeType: 'image/webp', state: 'ok', model: 'test' }],
    });
    await expect(provider.status('12345678-1234-1234-1234-123456789abc'))
      .rejects.toMatchObject({ code: 'provider-remote-result-rejected' });
  });

  it('turns timeout and provider HTTP failures into typed errors', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ message: 'busy' }, 503));
    const provider = new AiHordeProvider({ fetchFn: fetchFn as typeof fetch });
    await expect(provider.check('12345678-1234-1234-1234-123456789abc'))
      .rejects.toEqual(expect.objectContaining<Partial<AiHordeProviderError>>({ code: 'provider-busy', statusCode: 503 }));
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

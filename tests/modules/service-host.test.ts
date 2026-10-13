import { describe, expect, it, vi } from 'vitest';
import { LoopbackServiceHostTransport } from '../../src/modules/service-host';

const token = 'a'.repeat(64);

describe('shared service host transport', () => {
  it('accepts only an exact token-bound IPv4 loopback service endpoint', () => {
    expect(new LoopbackServiceHostTransport({ serviceId: 'calendar' }).available).toBe(false);
    expect(() => new LoopbackServiceHostTransport({ serviceId: 'calendar', token })).toThrow('calendar:host-binding');
    expect(() => new LoopbackServiceHostTransport({ serviceId: 'calendar', endpoint: 'http://localhost:4317/calendar', token }))
      .toThrow('calendar:host-binding');
    expect(() => new LoopbackServiceHostTransport({ serviceId: 'calendar', endpoint: 'http://127.0.0.1:4317/calendar?x=1', token }))
      .toThrow('calendar:host-binding');
    expect(new LoopbackServiceHostTransport({ serviceId: 'calendar', endpoint: 'http://127.0.0.1:4317/calendar', token }).available)
      .toBe(true);
  });

  it('sends a typed operation envelope and preserves the caller cancellation signal', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(
      JSON.stringify({ result: { calendars: 2 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const controller = new AbortController();
      const transport = new LoopbackServiceHostTransport({
        serviceId: 'calendar', endpoint: 'http://127.0.0.1:4317/calendar', token,
      });
      await expect(transport.request('calendars.list', { maxResults: 10 }, controller.signal))
        .resolves.toEqual({ calendars: 2 });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('http://127.0.0.1:4317/calendar');
      expect(JSON.parse(String(init.body))).toEqual({ operation: 'calendars.list', input: { maxResults: 10 } });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects oversized and untrusted broker responses without exposing their text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'token=secret' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const transport = new LoopbackServiceHostTransport({
        serviceId: 'calendar', endpoint: 'http://127.0.0.1:4317/calendar', token,
      });
      await expect(transport.request('calendars.list', {})).rejects.toThrow('calendar:host-response');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

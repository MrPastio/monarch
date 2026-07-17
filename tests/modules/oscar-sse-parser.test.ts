import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendHttpError, cancelGeneration, drainSseBuffer, formatBackendStatusMessage, previewChatRoute, streamChat } from '../../oscar/frontend/src/lib/api';
import type { ChatRequest } from '../../oscar/frontend/src/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Oscar frontend SSE parser', () => {
  it('keeps incomplete SSE blocks until stream flush', () => {
    const pending = drainSseBuffer('event: done\ndata: {"ok":true}');

    expect(pending.events).toEqual([]);
    expect(pending.buffer).toBe('event: done\ndata: {"ok":true}');

    const flushed = drainSseBuffer(pending.buffer, true);

    expect(flushed.events).toEqual([{ event: 'done', data: { ok: true } }]);
    expect(flushed.buffer).toBe('');
  });

  it('parses CRLF-delimited events and preserves a trailing partial event', () => {
    const drained = drainSseBuffer(
      'event: token\r\ndata: {"token":"ok"}\r\n\r\nevent: done\r\ndata: {"ok":true}',
    );

    expect(drained.events).toEqual([{ event: 'token', data: { token: 'ok' } }]);
    expect(drained.buffer).toBe('event: done\ndata: {"ok":true}');
  });

  it('emits the final streamChat event when the response ends without a blank line', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: token\ndata: {"token":"ok"}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: done\ndata: {"ok":true}'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const events: Array<{ event: string; data: unknown }> = [];
    await streamChat(createChatRequest(), (event, data) => {
      events.push({ event, data });
    });

    expect(events).toEqual([
      { event: 'token', data: { token: 'ok' } },
      { event: 'done', data: { ok: true } },
    ]);
  });

  it('rejects a clean EOF without done while preserving emitted tokens', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: token\ndata: {"token":"partial"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const events: Array<{ event: string; data: unknown }> = [];
    await expect(streamChat(createChatRequest(), (event, data) => {
      events.push({ event, data });
    })).rejects.toThrow('Поток ответа завершился до подтверждения результата');

    expect(events).toEqual([{ event: 'token', data: { token: 'partial' } }]);
  });

  it('hides backend detail from user-facing HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ detail: 'secret stack trace / token / path' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )));

    await expect(streamChat(createChatRequest(), () => {})).rejects.toMatchObject({
      name: 'BackendHttpError',
      status: 500,
      detail: 'secret stack trace / token / path',
      message: 'Oscar backend не смог обработать запрос. Детали остались в backend-логах.',
    });

    await expect(streamChat(createChatRequest(), () => {})).rejects.not.toThrow('secret stack trace');
  });

  it('uses actionable safe messages for auth failures', () => {
    const error = new BackendHttpError(401, 'Unauthorized: invalid or missing token');

    expect(error.message).toBe('Нет доступа к Oscar backend. Проверь локальный токен и перезапусти UI.');
    expect(error.message).not.toContain('Unauthorized');
    expect(formatBackendStatusMessage(404)).toContain('frontend и backend разных версий');
  });

  it('forwards the request abort signal to route preview', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      selected_model: 'gemma4-balanced',
      auto_selected: true,
      deep_thinking: false,
      requires_confirmation: false,
      web_search: false,
      search_reason: 'explicit-off',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await previewChatRoute(createChatRequest(), controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7861/api/chat/route',
      expect.objectContaining({ method: 'POST', signal: controller.signal }),
    );
  });

  it('uses the backend cancellation endpoint for active generation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      cancelled: true,
      queue_busy: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelGeneration()).resolves.toMatchObject({ ok: true, cancelled: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7861/api/generation/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

function createChatRequest(): ChatRequest {
  return {
    messages: [{ role: 'user', content: 'ping' }],
    web_search: false,
    use_memory: false,
    reasoning_effort: 'low',
    max_new_tokens: 32,
    temperature: 0.2,
    top_p: 0.9,
  };
}

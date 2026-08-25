import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeConfirmedCapabilityStream,
  executeCapabilityStream,
  executeVoiceAgentTask,
  executeVoiceModeAction,
  executeVoiceModeDeviceAction,
  cancelOscarTurn,
  cancelOscarTurnSubmission,
  createOscarTurn,
  createAgentTask,
  fetchOscarAttachment,
  fetchOscarRequestDisposition,
  fetchOscarTurnByClientRequestId,
  fetchCoderRuns,
  formatMonarchHttpError,
  installModels,
  skipModelOnboarding,
  acknowledgeModelOnboardingWelcome,
  prepareVoiceTranscription,
  resolveAgentTaskApproval,
  submitAgentActionJob,
  streamOscarTurn,
  streamAgentTask,
  transcribeVoiceAudio,
  writeLocalSettings,
} from '../../src/ui/public/modules/api.js';

function stubVoiceAgentCompletion(summary: string) {
  return stubVoiceAgentTerminal('task.completed', { summary });
}

function stubVoiceAgentTerminal(type: string, payload: Record<string, unknown>) {
  vi.stubGlobal('window', {
    monarchDesktop: { getMutationAttestation: vi.fn(async () => 'desktop-attestation-fixture') },
  });
  const outcome = type === 'task.completed' ? 'verified' : type === 'task.cancelled' ? 'cancelled' : 'failed';
  const status = outcome === 'verified' ? 'succeeded' : outcome;
  const summary = String(payload.summary || 'Проверенный результат не получен.');
  const turn = {
    id: 'voice-turn-1',
    taskId: 'voice-task-1',
    status,
    outcome: { kind: outcome, summary },
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/oscar/turns') {
      return {
        ok: true,
        status: 202,
        json: async () => ({ version: 1, ok: true, turn: { id: 'voice-turn-1', status: 'running' } }),
      };
    }
    if (url.includes('/api/oscar/turns/voice-turn-1/events')) {
      return new Response(`event: turn.outcome\ndata: ${JSON.stringify({ event: { sequence: 1, type: 'turn.outcome', payload: { outcome, summary } } })}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (url === '/api/oscar/turns/voice-turn-1') {
      return { ok: true, status: 200, json: async () => ({ version: 1, ok: true, turn }) };
    }
    throw new Error(`Unexpected voice Turn request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubVoiceAgentOutcome(outcome: 'answered' | 'answered:source-grounded', summary: string) {
  vi.stubGlobal('window', {
    monarchDesktop: { getMutationAttestation: vi.fn(async () => 'desktop-attestation-fixture') },
  });
  const turn = {
    id: 'voice-turn-answer',
    taskId: 'voice-task-answer',
    status: 'succeeded',
    outcome: { kind: outcome, summary },
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/oscar/turns') {
      return {
        ok: true,
        status: 202,
        json: async () => ({ version: 1, ok: true, turn: { id: turn.id, status: 'running' } }),
      };
    }
    if (url.includes(`/api/oscar/turns/${turn.id}/events`)) {
      return new Response(`event: turn.outcome\ndata: ${JSON.stringify({
        event: { sequence: 1, type: 'turn.outcome', payload: { outcome, summary } },
      })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url === `/api/oscar/turns/${turn.id}`) {
      return { ok: true, status: 200, json: async () => ({ version: 1, ok: true, turn }) };
    }
    throw new Error(`Unexpected voice Turn request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('static UI API errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits any selected model set through the one-click installer endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 2 }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(installModels(['gemma4-fast', 'qwen3.8-27b-pro'], 'onboarding'))
      .resolves.toMatchObject({ schemaVersion: 2 });
    expect(fetchMock).toHaveBeenCalledWith('/api/models/install', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      roles: ['gemma4-fast', 'qwen3.8-27b-pro'],
      source: 'onboarding',
    });
  });

  it('uses dedicated mutation endpoints for skip and the one-time welcome receipt', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 2 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await skipModelOnboarding();
    await acknowledgeModelOnboardingWelcome();

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/models/onboarding/skip', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/models/onboarding/welcome', expect.objectContaining({ method: 'POST' }));
  });

  it('hides server-side details for 500 errors', () => {
    const message = formatMonarchHttpError(500, {
      message: 'stack trace C:\\Monarch\\secret-token.txt',
    });

    expect(message).toBe('Monarch столкнулся с внутренней ошибкой. Детали остались в локальных логах.');
    expect(message).not.toContain('secret-token');
  });

  it('keeps actionable client-side validation messages', () => {
    expect(formatMonarchHttpError(400, { message: 'Intent text is required.' })).toBe('Intent text is required.');
    expect(formatMonarchHttpError(401)).toContain('Нет доступа');
    expect(formatMonarchHttpError(403, {
      error: 'turn-source-mismatch',
      message: 'Oscar Turn belongs to another surface.',
    })).toBe('Oscar Turn belongs to another surface.');
    expect(formatMonarchHttpError(403)).not.toContain('Security');
  });

  it('refreshes Desktop attestation once and recovers a terminal Turn checkpoint without creating a duplicate', async () => {
    const getMutationAttestation = vi.fn(async () => 'desktop-attestation-refreshed');
    vi.stubGlobal('window', { monarchDesktop: { getMutationAttestation }, setTimeout });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/events?after=0')) {
        return new Response(JSON.stringify({
          version: 1,
          ok: false,
          error: 'turn-source-mismatch',
          message: 'Oscar Turn belongs to another surface.',
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/oscar/turns/turn-recover-1') {
        expect(init?.headers).toMatchObject({
          'X-Monarch-Desktop-Attestation': 'desktop-attestation-refreshed',
        });
        return new Response(JSON.stringify({
          version: 1,
          ok: true,
          turn: {
            id: 'turn-recover-1',
            status: 'succeeded',
            outcome: { kind: 'answered', summary: 'Настоящий durable ответ.' },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected recovery request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of await streamOscarTurn('turn-recover-1')) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'turn.outcome',
        data: expect.objectContaining({
          event: expect.objectContaining({
            payload: expect.objectContaining({ summary: 'Настоящий durable ответ.', replayedFromCheckpoint: true }),
          }),
        }),
      }),
    ]);
    expect(getMutationAttestation).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/oscar/turns' && init?.method === 'POST')).toBe(false);
  });

  it('resumes a torn Oscar SSE stream from the last sequence without duplicating replayed deltas', async () => {
    vi.stubGlobal('window', { setTimeout });
    let firstPull = true;
    const firstBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstPull) {
          firstPull = false;
          controller.enqueue(new TextEncoder().encode(
            'event: answer.delta\ndata: {"event":{"sequence":1,"type":"answer.delta","payload":{"content":"A"}}}\n\n',
          ));
          return;
        }
        controller.error(new TypeError('synthetic socket reset'));
      },
    });
    const replay = [
      'event: answer.delta\ndata: {"event":{"sequence":1,"type":"answer.delta","payload":{"content":"DUPLICATE"}}}',
      'event: answer.delta\ndata: {"event":{"sequence":2,"type":"answer.delta","payload":{"content":"B"}}}',
      'event: turn.outcome\ndata: {"event":{"sequence":3,"type":"turn.outcome","payload":{"outcome":"answered","summary":"AB"}}}',
      '',
    ].join('\n\n');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(firstBody, { status: 200 }))
      .mockResolvedValueOnce(new Response(replay, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of await streamOscarTurn('turn-network-replay')) events.push(event);

    expect(events.map((event) => [event.type, event.data.event.payload.content || event.data.event.payload.summary]))
      .toEqual([
        ['answer.delta', 'A'],
        ['answer.delta', 'B'],
        ['turn.outcome', 'AB'],
      ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/oscar/turns/turn-network-replay/events?after=0',
      '/api/oscar/turns/turn-network-replay/events?after=1',
    ]);
  });

  it('uses the durable terminal checkpoint after every Oscar SSE reconnect is torn down', async () => {
    vi.stubGlobal('window', { setTimeout });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/oscar/turns/turn-network-terminal') {
        return new Response(JSON.stringify({
          version: 1,
          ok: true,
          turn: {
            id: 'turn-network-terminal',
            status: 'failed',
            outcome: { kind: 'failed', summary: 'Durable failure survived every reconnect.' },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new TypeError('synthetic connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of await streamOscarTurn('turn-network-terminal')) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'turn.failed',
        data: expect.objectContaining({
          event: expect.objectContaining({
            payload: expect.objectContaining({
              summary: 'Durable failure survived every reconnect.',
              replayedFromCheckpoint: true,
            }),
          }),
        }),
      }),
    ]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/events?after=0'))).toHaveLength(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/oscar/turns/turn-network-terminal',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('never reconnects an Oscar SSE stream after the caller explicitly aborts it', async () => {
    vi.stubGlobal('window', { setTimeout });
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const consuming = (async () => {
      for await (const _event of await streamOscarTurn('turn-explicit-abort', 0, { signal: controller.signal })) {
        // The request is aborted before any event can be accepted.
      }
    })();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(consuming).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('loads durable Coder history across every registered project', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, runs: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchCoderRuns()).resolves.toMatchObject({ ok: true, runs: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/coder/runs', expect.objectContaining({ method: 'GET' }));
  });

  it('reads a persisted image through its exact conversation binding', async () => {
    vi.stubGlobal('window', {
      monarchDesktop: { getMutationAttestation: vi.fn(async () => 'desktop-attestation-attachment') },
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/oscar/attachments/attachment_1?conversationId=conversation_1&privacyMode=persistent');
      expect(init?.method).toBe('GET');
      return new Response(JSON.stringify({
        version: 1,
        ok: true,
        attachment: {
          id: 'attachment_1',
          mimeType: 'image/png',
          digest: `sha256:${'a'.repeat(64)}`,
          dataBase64: 'iVBORw0KGgo=',
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOscarAttachment('attachment_1', {
      conversationId: 'conversation_1',
      privacyMode: 'persistent',
    })).resolves.toMatchObject({ attachment: { id: 'attachment_1' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the exact client request identity and AbortSignal across Turn create and cancellation recovery', async () => {
    vi.stubGlobal('window', {
      monarchDesktop: { getMutationAttestation: vi.fn(async () => 'desktop-attestation-turn-recovery') },
    });
    const controller = new AbortController();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/oscar/turns') {
        expect(init?.signal).toBe(controller.signal);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          clientRequestId: 'client_ui_recovery_1',
          inputMessageId: 'message_ui_recovery_1',
          conversationId: 'conversation_ui_recovery_1',
          text: 'Проверь',
        });
        return new Response(JSON.stringify({
          version: 1,
          ok: true,
          turn: { id: 'turn_ui_recovery_1', status: 'routing' },
        }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/oscar/turn-cancellations') {
        expect(JSON.parse(String(init?.body))).toEqual({
          version: 1,
          clientRequestId: 'client_ui_recovery_1',
          privacyMode: 'persistent',
        });
        return new Response(JSON.stringify({
          version: 1,
          ok: true,
          cancellation: { clientRequestId: 'client_ui_recovery_1', reserved: false },
          turn: { id: 'turn_ui_recovery_1', status: 'cancelled' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/oscar/turns?clientRequestId=client_ui_recovery_1&privacyMode=persistent') {
        return new Response(JSON.stringify({
          version: 1,
          ok: true,
          turn: { id: 'turn_ui_recovery_1', status: 'cancelled' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected Turn recovery request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createOscarTurn({
      conversationId: 'conversation_ui_recovery_1',
      text: 'Проверь',
      privacyMode: 'persistent',
    }, {
      clientRequestId: 'client_ui_recovery_1',
      inputMessageId: 'message_ui_recovery_1',
      signal: controller.signal,
    })).resolves.toMatchObject({ turn: { id: 'turn_ui_recovery_1' } });
    await expect(cancelOscarTurnSubmission('client_ui_recovery_1', {
      privacyMode: 'persistent',
    })).resolves.toMatchObject({ turn: { status: 'cancelled' } });
    await expect(fetchOscarTurnByClientRequestId('client_ui_recovery_1', {
      privacyMode: 'persistent',
    })).resolves.toMatchObject({ turn: { id: 'turn_ui_recovery_1' } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('accepts the direct durable settings receipt returned by the backend contract', async () => {
    vi.stubGlobal('window', {
      monarchDesktop: { getMutationAttestation: vi.fn(async () => 'desktop-attestation-settings') },
    });
    const contentHash = 'a'.repeat(64);
    const receipt = {
      schemaVersion: 1,
      receiptId: 'settings_receipt_direct',
      clientRequestId: 'settings_request_direct',
      command: 'voice.update',
      scope: { type: 'chat' },
      revision: 3,
      contentHash,
      readBackHash: contentHash,
      policyDecisionHash: 'b'.repeat(64),
      committedAt: '2026-08-03T00:00:00.000Z',
      replayed: false,
      result: {},
    };
    const context = {
      schemaVersion: 1,
      kind: 'voice',
      scope: { type: 'chat' },
      revision: 3,
      contentHash,
      value: {},
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/settings/commands') {
        return new Response(JSON.stringify(receipt), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/settings/read') {
        return new Response(JSON.stringify(context), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected settings request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(writeLocalSettings('voice.update', { patch: {} }, {
      clientRequestId: 'settings_request_direct',
      expectedRevision: 2,
    })).resolves.toEqual({ receipt, context });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('routes recorded audio to the local voice transcription capability', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        output: {
          transcript: ' локальный текст ',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    await expect(transcribeVoiceAudio({
      audioBase64: 'dm9pY2U=',
      mimeType: 'audio/webm',
      language: 'ru-RU',
      signal: controller.signal,
    })).resolves.toBe('локальный текст');

    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const request = call?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith('/api/execute', expect.objectContaining({
      method: 'POST',
      signal: controller.signal,
    }));
    expect(JSON.parse(String(request.body))).toMatchObject({
      moduleId: 'voice',
      capabilityId: 'voice.transcribe.audio',
      requestedBy: 'ui:voice',
      includeState: false,
      input: {
        audioBase64: 'dm9pY2U=',
        mimeType: 'audio/webm',
        language: 'ru-RU',
      },
    });
  });

  it('prepares streaming STT without exposing a separate Voice model runtime', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          ok: true,
          summary: 'Voice STT ready.',
          output: { stt: { status: 'ready', engine: 'sherpa-onnx-t-one' } },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(prepareVoiceTranscription(controller.signal)).resolves.toMatchObject({
      ok: true,
      text: '',
      output: { stt: { status: 'ready', engine: 'sherpa-onnx-t-one' } },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith('/api/execute', expect.objectContaining({
      method: 'POST',
      signal: controller.signal,
    }));
    expect(JSON.parse(String(request.body))).toEqual({
      moduleId: 'voice',
      capabilityId: 'voice.transcribe.prepare',
      input: {},
      requestedBy: 'ui:voice-mode',
      includeState: false,
    });
  });

  it('confirms only the exact scripted volume command and keeps state payloads disabled', async () => {
    const fetchMock = stubVoiceAgentCompletion('Громкость установлена на 100%.');

    await expect(executeVoiceModeDeviceAction('поставь громкость на максимум'))
      .resolves.toMatchObject({ ok: true, text: 'Громкость установлена на 100%.' });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      text: 'поставь громкость на максимум',
      surface: 'voice',
      privacyMode: 'persistent',
    });
    expect(body).not.toHaveProperty('capabilityId');
  });

  it('rejects a volume success payload unless Windows verification is explicit', async () => {
    stubVoiceAgentTerminal('task.failed', {
      summary: 'Windows не подтвердил новый уровень громкости.',
      code: 'verification-failed',
    });

    await expect(executeVoiceModeDeviceAction('поставь громкость на максимум'))
      .resolves.toMatchObject({
        ok: false,
        text: '',
        error: 'voice-turn-failed',
      });
  });

  it('delegates a spoken app launch to the Device module with an exact one-time confirmation', async () => {
    const fetchMock = stubVoiceAgentCompletion('Открыл Калькулятор.');

    await expect(executeVoiceModeAction({
      actionId: 'device.app.open',
      slots: { app: 'calculator' },
    }, 'открой калькулятор')).resolves.toMatchObject({
      ok: true,
      text: 'Открыл Калькулятор.',
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ text: 'открой калькулятор', surface: 'voice' });
    expect(body).not.toHaveProperty('capabilityId');
  });

  it.each([
    ['answered' as const, { boundedAnswer: true, verified: false, performed: false }],
    ['answered:source-grounded' as const, { grounded: true, verified: false, performed: false }],
  ])('speaks a terminal common-Agent %s answer without presenting it as an executed action', async (outcome, marker) => {
    const fetchMock = stubVoiceAgentOutcome(outcome, 'Короткий ответ общего Agent Runtime.');

    await expect(executeVoiceAgentTask('объясни простыми словами')).resolves.toMatchObject({
      ok: true,
      text: 'Короткий ответ общего Agent Runtime.',
      output: {
        taskId: 'voice-task-answer',
        outcome,
        ...marker,
      },
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      text: 'объясни простыми словами',
      surface: 'voice',
      privacyMode: 'persistent',
    });
  });

  it('reports a pending Voice action-card without resolving approval from voice', async () => {
    vi.stubGlobal('window', {
      monarchDesktop: { getMutationAttestation: vi.fn(async () => 'desktop-attestation-fixture') },
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/oscar/turns') {
        return { ok: true, status: 202, json: async () => ({ turn: { id: 'voice-turn-approval', status: 'running' } }) };
      }
      if (url.includes('/api/oscar/turns/voice-turn-approval/events')) {
        return new Response(`event: approval.required\ndata: ${JSON.stringify({
          event: {
            sequence: 1,
            type: 'approval.required',
            payload: { taskId: 'voice-task-approval', approvalId: 'approval-exact' },
          },
        })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error(`Unexpected Voice approval request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeVoiceModeAction({}, 'удали файл D:\\Temp\\candidate.txt')).resolves.toMatchObject({
      ok: false,
      error: 'voice-approval-required',
      output: {
        turnId: 'voice-turn-approval',
        taskId: 'voice-task-approval',
        approvalId: 'approval-exact',
        performed: false,
      },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/approvals/'))).toBe(false);
  });

  it('keeps Oscar disposition text out of the request URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, disposition: { mode: 'chat' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOscarRequestDisposition('секретный текст')).resolves.toMatchObject({ mode: 'chat' });
    expect(fetchMock).toHaveBeenCalledWith('/api/oscar/request-disposition', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: 'секретный текст' }),
    }));

    const history = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index}:${'я'.repeat(5_000)}`,
    }));
    history.splice(4, 0, { role: 'system', content: 'internal prompt must not become user history' });
    const controller = new AbortController();
    await fetchOscarRequestDisposition('новый текст', history, { signal: controller.signal });
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, { body: string; signal: AbortSignal }];
    const body = JSON.parse(String(init.body));
    expect(url).toBe('/api/oscar/request-disposition');
    expect(init.signal).toBe(controller.signal);
    expect(body.history).toHaveLength(4);
    expect(body.history.every((message) => message.content.length <= 4_000)).toBe(true);
    expect(body.history.some((message) => message.content.includes('internal prompt'))).toBe(false);
  });

  it('passes cancellation to the Agent Task event stream request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const opening = streamAgentTask('task-1', 4, { signal: controller.signal });
    controller.abort();

    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/tasks/task-1/events?after=4',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('attests Electron desktop mutations without putting the secret in request bodies', async () => {
    vi.stubGlobal('window', {
      monarchDesktop: {
        getMutationAttestation: vi.fn(async () => 'desktop-attestation-fixture'),
      },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: 1, ok: true, task: { id: 'task-attested' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createAgentTask('Открой калькулятор', {
      source: 'desktop',
      autoStart: false,
    })).resolves.toMatchObject({ task: { id: 'task-attested' } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Monarch-Desktop-Attestation': 'desktop-attestation-fixture',
    });
    expect(String(init.body)).not.toContain('desktop-attestation-fixture');
  });

  it('refreshes an expired Desktop attestation once before retrying the exact Turn cancellation', async () => {
    const getMutationAttestation = vi.fn()
      .mockResolvedValueOnce('desktop-attestation-stale')
      .mockResolvedValueOnce('desktop-attestation-fresh');
    vi.stubGlobal('window', { monarchDesktop: { getMutationAttestation } });
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        ok: false,
        error: 'turn-source-mismatch',
        message: 'Oscar Turn belongs to another Desktop session.',
      }), { status: 403, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version: 1,
        ok: true,
        turn: { id: 'turn-cancel-refresh', status: 'cancelled' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelOscarTurn('turn-cancel-refresh', { signal: controller.signal }))
      .resolves.toMatchObject({ turn: { status: 'cancelled' } });

    expect(getMutationAttestation).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => ({
      attestation: (init as RequestInit).headers?.['X-Monarch-Desktop-Attestation'],
      body: (init as RequestInit).body,
      signal: (init as RequestInit).signal,
    }))).toEqual([
      { attestation: 'desktop-attestation-stale', body: '{"version":1}', signal: controller.signal },
      { attestation: 'desktop-attestation-fresh', body: '{"version":1}', signal: controller.signal },
    ]);
  });

  it('does not retry a Turn cancellation rejected by ordinary policy', async () => {
    const getMutationAttestation = vi.fn(async () => 'desktop-attestation-current');
    vi.stubGlobal('window', { monarchDesktop: { getMutationAttestation } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      version: 1,
      ok: false,
      error: 'policy-denied',
      message: 'Cancellation is not permitted for this source.',
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(cancelOscarTurn('turn-policy-denied')).rejects.toMatchObject({
      name: 'MonarchHttpError',
      code: 'policy-denied',
    });
    expect(getMutationAttestation).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forwards an explicit cancellation deadline abort without retrying the Turn mutation', async () => {
    vi.stubGlobal('window', {});
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const cancellation = cancelOscarTurn('turn-cancel-deadline', { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('Synthetic cancellation deadline.', 'TimeoutError'));

    await expect(cancellation).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation through an exact Agent approval decision request', async () => {
    vi.stubGlobal('window', {});
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const settlement = resolveAgentTaskApproval(
      'task-approval-stop',
      'approval-stop',
      'approve',
      'once',
      { canonicalProposalHash: 'hash-stop', capabilityId: 'workspace.file.read' },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort(new DOMException('Synthetic approval stop.', 'AbortError'));

    await expect(settlement).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/tasks/task-approval-stop/approvals/approval-stop',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('uses the same Device clock and verified volume capabilities as ordinary chat', async () => {
    stubVoiceAgentCompletion('Сейчас 23:34.');

    await expect(executeVoiceModeAction({
      actionId: 'time.query',
      slots: { query: 'local-clock' },
    }, 'сколько времени')).resolves.toMatchObject({ ok: true, text: 'Сейчас 23:34.' });
    stubVoiceAgentCompletion('Громкость установлена на 45%.');
    await expect(executeVoiceModeAction({
      actionId: 'device.volume',
      slots: { operation: 'set', value: '45' },
    }, 'поставь громкость на 45 процентов')).resolves.toMatchObject({
      ok: true,
      text: 'Громкость установлена на 45%.',
    });

  });

  it('reads brightness directly and confirms only the exact mutating brightness request', async () => {
    stubVoiceAgentCompletion('Сейчас яркость экрана 72%.');

    await expect(executeVoiceModeAction({
      actionId: 'device.brightness.status',
      slots: { operation: 'get' },
    }, 'какая сейчас яркость')).resolves.toMatchObject({
      ok: true,
      text: 'Сейчас яркость экрана 72%.',
    });
    stubVoiceAgentCompletion('Яркость установлена на 55%.');
    await expect(executeVoiceModeAction({
      actionId: 'device.brightness',
      slots: { operation: 'set', value: '55' },
    }, 'поставь яркость на 55 процентов')).resolves.toMatchObject({
      ok: true,
      text: 'Яркость установлена на 55%.',
    });

  });

  it('delegates voice workspace creation to the existing Workspace capability', async () => {
    const fetchMock = stubVoiceAgentCompletion('Создал файл note.txt.');

    await expect(executeVoiceModeAction({
      actionId: 'workspace.create',
      slots: { path: 'note.txt', kind: 'file', content: 'готово' },
    }, 'создай файл note.txt')).resolves.toMatchObject({
      ok: true,
      text: 'Создал файл note.txt.',
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ text: 'создай файл note.txt', surface: 'voice' });
    expect(body).not.toHaveProperty('capabilityId');
  });

  it('queues an Oscar agent action through the streamed job endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, job: { id: 'job_security' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitAgentActionJob('проверь опасные процессы', false, '', 180000, {
      modelProposed: true,
      originatingUserText: 'проверь безопасность процессов',
    })).resolves.toMatchObject({
      job: { id: 'job_security' },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/jobs', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      text: 'проверь опасные процессы',
      timeoutMs: 180000,
      context: { modelProposed: true, originatingUserText: 'проверь безопасность процессов' },
    });
    expect(body).not.toHaveProperty('confirmed');
  });

  it('flushes the final capability SSE event without a trailing blank line', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: token\r\ndata: {"token":"ok"}\r\n\r\n'));
        controller.enqueue(new TextEncoder().encode('event: done\r\ndata: {"ok":true}'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const stream = await executeCapabilityStream('oscar', 'oscar.chat.stream', {}, 'ui:oscar', false);
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([
      { type: 'token', data: { token: 'ok' } },
      { type: 'done', data: { ok: true } },
    ]);
  });

  it('refuses to replay a stream with a legacy confirmation token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        result: {
          ok: false,
          error: 'confirmation-required',
          metadata: { confirmation: { token: 'research-token' } },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeConfirmedCapabilityStream(
      'oscar',
      'oscar.chat.stream',
      { web_search: true },
      'ui:oscar',
    )).rejects.toThrow(/action-card|confirmation token/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(requestBody).not.toHaveProperty('confirmed');
    expect(requestBody).not.toHaveProperty('confirmationToken');
  });

  it('rejects capability EOF without a terminal event and keeps emitted tokens observable', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: token\ndata: {"token":"partial"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const stream = await executeCapabilityStream('oscar', 'oscar.chat.stream', {}, 'ui:oscar', false);
    const events = [];
    await expect((async () => {
      for await (const event of stream) events.push(event);
    })()).rejects.toMatchObject({ code: 'runtime-disconnected' });

    expect(events).toEqual([{ type: 'token', data: { token: 'partial' } }]);
  });
});

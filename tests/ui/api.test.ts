import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeConfirmedCapabilityStream,
  executeCapabilityStream,
  executeVoiceModeAction,
  executeVoiceModeDeviceAction,
  executeVoiceModeScripted,
  createAgentTask,
  fetchOscarRequestDisposition,
  fetchCoderRuns,
  formatMonarchHttpError,
  prepareVoiceModeModels,
  releaseVoiceModeModels,
  respondVoiceMode,
  respondVoiceModeFast,
  respondVoiceModeRealtime,
  submitAgentActionJob,
  streamAgentTask,
  transcribeVoiceAudio,
} from '../../src/ui/public/modules/api.js';

function stubVoiceAgentCompletion(summary: string) {
  return stubVoiceAgentTerminal('task.completed', { summary });
}

function stubVoiceAgentTerminal(type: string, payload: Record<string, unknown>) {
  vi.stubGlobal('window', {
    monarchDesktop: { getMutationAttestation: vi.fn(async () => 'desktop-attestation-fixture') },
  });
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/agent/tasks') {
      return {
        ok: true,
        status: 202,
        json: async () => ({ version: 1, ok: true, task: { id: 'voice-task-1' } }),
      };
    }
    if (url.includes('/api/agent/tasks/voice-task-1/events')) {
      return new Response(`event: ${type}\ndata: ${JSON.stringify({ payload })}\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    throw new Error(`Unexpected voice Agent request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('static UI API errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
      confirmed: false,
      includeState: false,
      input: {
        audioBase64: 'dm9pY2U=',
        mimeType: 'audio/webm',
        language: 'ru-RU',
      },
    });
  });

  it('prepares streaming STT without preloading an LLM and releases lazy Lite explicitly', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          ok: true,
          summary: 'Voice STT ready.',
          output: { profiles: [], stt: { status: 'ready', engine: 'sherpa-onnx-t-one' } },
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(prepareVoiceModeModels(controller.signal)).resolves.toMatchObject({
      ok: true,
      text: '',
      output: { profiles: [], stt: { status: 'ready', engine: 'sherpa-onnx-t-one' } },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith('/api/execute', expect.objectContaining({
      method: 'POST',
      signal: controller.signal,
    }));
    expect(JSON.parse(String(request.body))).toEqual({
      moduleId: 'voice',
      capabilityId: 'voice.mode.prepare',
      input: {},
      requestedBy: 'ui:voice-mode',
      confirmed: false,
      includeState: false,
    });

    await expect(releaseVoiceModeModels(controller.signal)).resolves.toMatchObject({ ok: true });
    const releaseRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(releaseRequest.body))).toEqual({
      moduleId: 'voice',
      capabilityId: 'voice.mode.release',
      input: { profiles: ['lite'] },
      requestedBy: 'ui:voice-mode',
      confirmed: false,
      includeState: false,
    });
  });

  it('isolates scripted, Micro, Lite, and Fast voice requests by capability', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const output = body.capabilityId === 'oscar.voice.fast' || body.capabilityId === 'oscar.voice.realtime'
        ? { response: { answer: 'fast answer' } }
        : body.capabilityId === 'voice.mode.execute-scripted'
          ? { answer: 'scripted answer' }
          : { text: `${body.input.profile} answer` };
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: { ok: true, summary: 'done', output },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(executeVoiceModeScripted('который час', controller.signal))
      .resolves.toMatchObject({ ok: true, text: 'scripted answer' });
    await expect(respondVoiceMode('привет', 'micro', controller.signal))
      .resolves.toMatchObject({ ok: true, text: 'micro answer' });
    await expect(respondVoiceMode('объясни коротко', 'lite', controller.signal))
      .resolves.toMatchObject({ ok: true, text: 'lite answer' });
    await expect(respondVoiceModeFast('проанализируй', 'ru', controller.signal))
      .resolves.toMatchObject({ ok: true, text: 'fast answer' });
    await expect(respondVoiceModeRealtime('погода в Киеве', 'weather', 'ru', controller.signal, 'Киев'))
      .resolves.toMatchObject({ ok: true, text: 'fast answer' });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies).toEqual([
      {
        moduleId: 'voice',
        capabilityId: 'voice.mode.execute-scripted',
        input: { text: 'который час' },
        requestedBy: 'ui:voice-mode',
        confirmed: false,
        includeState: false,
      },
      {
        moduleId: 'voice',
        capabilityId: 'voice.mode.respond',
        input: { text: 'привет', profile: 'micro' },
        requestedBy: 'ui:voice-mode',
        confirmed: false,
        includeState: false,
      },
      {
        moduleId: 'voice',
        capabilityId: 'voice.mode.respond',
        input: { text: 'объясни коротко', profile: 'lite' },
        requestedBy: 'ui:voice-mode',
        confirmed: false,
        includeState: false,
      },
      {
        moduleId: 'oscar',
        capabilityId: 'oscar.voice.fast',
        input: { text: 'проанализируй', language: 'ru' },
        requestedBy: 'ui:voice-mode',
        confirmed: false,
        includeState: false,
      },
      {
        moduleId: 'oscar',
        capabilityId: 'oscar.voice.realtime',
        input: { text: 'погода в Киеве', kind: 'weather', language: 'ru', location: 'Киев' },
        requestedBy: 'ui:voice-mode',
        confirmed: false,
        includeState: false,
      },
    ]);
    expect(bodies.some((body) => String(body.capabilityId).startsWith('oscar.chat.'))).toBe(false);
    expect(fetchMock.mock.calls.every((call) => (call[1] as RequestInit).signal === controller.signal)).toBe(true);
  });

  it('normalizes voice capability failures without exposing a fake answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: false,
        result: {
          ok: false,
          error: 'voice-profile-unavailable',
          summary: 'internal runtime detail',
          userFacing: { message: 'Быстрый голосовой профиль пока недоступен.' },
        },
      }),
    })));

    await expect(respondVoiceMode('привет', 'micro')).resolves.toMatchObject({
      ok: false,
      text: '',
      error: 'voice-profile-unavailable',
      message: 'Быстрый голосовой профиль пока недоступен.',
    });
  });

  it('confirms only the token-bound realtime voice lookup from the explicit utterance', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return {
        ok: true,
        json: async () => body.confirmed
          ? { ok: true, result: { ok: true, summary: 'done', output: { text: 'Сейчас тепло.' } } }
          : {
              ok: false,
              result: {
                ok: false,
                error: 'confirmation-required',
                metadata: { confirmation: { token: 'voice-network-token' } },
              },
            },
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(respondVoiceModeRealtime('погода в Киеве', 'weather', 'ru', undefined, 'Киев'))
      .resolves.toMatchObject({ ok: true, text: 'Сейчас тепло.' });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies).toEqual([
      expect.objectContaining({
        moduleId: 'oscar',
        capabilityId: 'oscar.voice.realtime',
        requestedBy: 'ui:voice-mode',
        confirmed: false,
      }),
      expect.objectContaining({
        moduleId: 'oscar',
        capabilityId: 'oscar.voice.realtime',
        requestedBy: 'ui:voice-mode',
        confirmed: true,
        confirmationToken: 'voice-network-token',
      }),
    ]);
  });

  it('confirms only the exact scripted volume command and keeps state payloads disabled', async () => {
    const fetchMock = stubVoiceAgentCompletion('Громкость установлена на 100%.');

    await expect(executeVoiceModeDeviceAction('поставь громкость на максимум'))
      .resolves.toMatchObject({ ok: true, text: 'Громкость установлена на 100%.' });

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      request: 'поставь громкость на максимум',
      source: 'voice',
      autoStart: true,
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
        error: 'verification-failed',
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
    expect(body).toMatchObject({ request: 'открой калькулятор', source: 'voice' });
    expect(body).not.toHaveProperty('capabilityId');
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
    expect(body).toMatchObject({ request: 'создай файл note.txt', source: 'voice' });
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
      confirmed: false,
      timeoutMs: 180000,
      context: { modelProposed: true, originatingUserText: 'проверь безопасность процессов' },
    });
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

  it('binds an explicit UI approval to the one-time stream confirmation token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        result: {
          ok: false,
          error: 'confirmation-required',
          metadata: { confirmation: { token: 'research-token' } },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('event: done\ndata: {"ok":true}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const stream = await executeConfirmedCapabilityStream(
      'oscar',
      'oscar.chat.stream',
      { web_search: true },
      'ui:oscar',
    );
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events).toEqual([{ type: 'done', data: { ok: true } }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      confirmed: true,
      confirmationToken: 'research-token',
      input: { web_search: true },
    });
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

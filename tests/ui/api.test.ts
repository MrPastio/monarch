import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeConfirmedCapabilityStream,
  executeCapabilityStream,
  executeVoiceModeAction,
  executeVoiceModeDeviceAction,
  executeVoiceModeScripted,
  fetchCoderRuns,
  formatMonarchHttpError,
  prepareVoiceModeModels,
  releaseVoiceModeModels,
  respondVoiceMode,
  respondVoiceModeFast,
  respondVoiceModeRealtime,
  submitAgentActionJob,
  transcribeVoiceAudio,
} from '../../src/ui/public/modules/api.js';

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
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return {
        ok: true,
        json: async () => body.confirmed
          ? {
              ok: true,
              result: {
                ok: true,
                summary: 'verified',
                output: { text: 'Громкость установлена на 100%.', verified: true, level: 100 },
              },
            }
          : {
              ok: false,
              result: {
                ok: false,
                error: 'confirmation-required',
                metadata: { confirmation: { token: 'voice-volume-token' } },
              },
            },
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeVoiceModeDeviceAction('поставь громкость на максимум'))
      .resolves.toMatchObject({ ok: true, text: 'Громкость установлена на 100%.' });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      moduleId: 'voice',
      capabilityId: 'voice.mode.execute-scripted',
      input: { text: 'поставь громкость на максимум' },
      confirmed: false,
      includeState: false,
    });
    expect(bodies[1]).toEqual({
      ...bodies[0],
      confirmed: true,
      confirmationToken: 'voice-volume-token',
    });
  });

  it('rejects a volume success payload unless Windows verification is explicit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          ok: true,
          summary: 'claimed success',
          output: {
            text: 'Громкость установлена на 100%.',
            actionId: 'device.volume',
            verified: false,
          },
        },
      }),
    })));

    await expect(executeVoiceModeDeviceAction('поставь громкость на максимум'))
      .resolves.toMatchObject({
        ok: false,
        text: '',
        error: 'voice-volume-unverified',
      });
  });

  it('delegates a spoken app launch to the Device module with an exact one-time confirmation', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      return {
        ok: true,
        json: async () => body.confirmed
          ? {
              result: {
                ok: true,
                summary: 'Открыл Калькулятор.',
                output: { opened: true, text: 'Открыл Калькулятор.' },
              },
            }
          : {
              result: {
                ok: false,
                error: 'confirmation-required',
                metadata: { confirmation: { token: 'voice-app-token' } },
              },
            },
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeVoiceModeAction({
      actionId: 'device.app.open',
      slots: { app: 'calculator' },
    }, 'открой калькулятор')).resolves.toMatchObject({
      ok: true,
      text: 'Открыл Калькулятор.',
    });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'calculator' },
      requestedBy: 'ui:voice-mode',
      confirmed: false,
      includeState: false,
    });
    expect(bodies[1]).toMatchObject({ confirmed: true, confirmationToken: 'voice-app-token' });
  });

  it('reads brightness directly and confirms only the exact mutating brightness request', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.capabilityId === 'device.brightness.get') {
        return {
          ok: true,
          json: async () => ({ result: { ok: true, output: { level: 72, verified: true, text: 'Сейчас яркость экрана 72%.' } } }),
        };
      }
      return {
        ok: true,
        json: async () => body.confirmed
          ? { result: { ok: true, output: { level: 55, verified: true, text: 'Яркость установлена на 55%.' } } }
          : { result: { ok: false, error: 'confirmation-required', metadata: { confirmation: { token: 'brightness-token' } } } },
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(executeVoiceModeAction({
      actionId: 'device.brightness.status',
      slots: { operation: 'get' },
    }, 'какая сейчас яркость')).resolves.toMatchObject({
      ok: true,
      text: 'Сейчас яркость экрана 72%.',
    });
    await expect(executeVoiceModeAction({
      actionId: 'device.brightness',
      slots: { operation: 'set', value: '55' },
    }, 'поставь яркость на 55 процентов')).resolves.toMatchObject({
      ok: true,
      text: 'Яркость установлена на 55%.',
    });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({
      moduleId: 'device',
      capabilityId: 'device.brightness.get',
      input: {},
      confirmed: false,
    });
    expect(bodies[1]).toMatchObject({
      moduleId: 'device',
      capabilityId: 'device.brightness.set',
      input: { operation: 'set', value: 55 },
      confirmed: false,
    });
    expect(bodies[2]).toMatchObject({
      capabilityId: 'device.brightness.set',
      input: { operation: 'set', value: 55 },
      confirmed: true,
      confirmationToken: 'brightness-token',
    });
  });

  it('delegates voice workspace creation to the existing Workspace capability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        result: { ok: true, summary: 'File written.', output: { path: 'note.txt' } },
      }),
    })));

    await expect(executeVoiceModeAction({
      actionId: 'workspace.create',
      slots: { path: 'note.txt', kind: 'file', content: 'готово' },
    }, 'создай файл note.txt')).resolves.toMatchObject({
      ok: true,
      text: 'Создал файл note.txt.',
    });

    const body = JSON.parse(String(((fetch as any).mock.calls[0][1] as RequestInit).body));
    expect(body).toMatchObject({
      moduleId: 'workspace',
      capabilityId: 'workspace.files.write',
      input: { path: 'note.txt', content: 'готово', overwrite: false },
    });
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

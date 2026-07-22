import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { dispatchVoiceModeTurn } from '../../src/ui/public/modules/voice-mode-dispatch.js';

function handlers() {
  return {
    executeAction: vi.fn(async () => ({ ok: true, text: 'device' })),
    executeScripted: vi.fn(async () => ({ ok: true, text: 'scripted' })),
    release: vi.fn(async () => ({ ok: true, output: { status: 'released', profiles: ['lite'] } })),
    respond: vi.fn(async () => ({ ok: true, text: 'model' })),
    respondFast: vi.fn(async () => ({ ok: true, text: 'fast' })),
    respondRealtime: vi.fn(async () => ({ ok: true, text: 'current' })),
  };
}

describe('voice mode lane dispatcher', () => {
  it('routes the clock through the authoritative Device capability, never a model', async () => {
    const laneHandlers = handlers();
    const controller = new AbortController();

    await expect(dispatchVoiceModeTurn({
      text: '  который час  ',
      candidate: {
        lane: 'scripted',
        actionId: 'time.query',
        slots: { query: 'local-clock', timeZone: 'system' },
      },
      signal: controller.signal,
    }, laneHandlers)).resolves.toEqual({ ok: true, text: 'device' });

    expect(laneHandlers.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ lane: 'scripted', actionId: 'time.query' }),
      'который час',
      controller.signal,
    );
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.respond).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
    expect(laneHandlers.release).not.toHaveBeenCalled();
  });

  it('routes volume status through the read-only Device capability', async () => {
    const laneHandlers = handlers();

    await dispatchVoiceModeTurn({
      text: 'какая сейчас громкость',
      candidate: { lane: 'scripted', actionId: 'device.volume.status' },
    }, laneHandlers);

    expect(laneHandlers.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'device.volume.status' }),
      'какая сейчас громкость',
      undefined,
    );
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
  });

  it('routes volume through the token-confirmed device executor, never a model', async () => {
    const laneHandlers = handlers();
    const controller = new AbortController();

    await expect(dispatchVoiceModeTurn({
      text: 'поставь громкость на максимум',
      candidate: { lane: 'scripted', actionId: 'device.volume' },
      signal: controller.signal,
    }, laneHandlers)).resolves.toEqual({ ok: true, text: 'device' });

    expect(laneHandlers.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ lane: 'scripted', actionId: 'device.volume' }),
      'поставь громкость на максимум',
      controller.signal,
    );
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.respond).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
    expect(laneHandlers.release).not.toHaveBeenCalled();
  });

  it('routes ambiguous volume to scripted clarification without device execution or a model', async () => {
    const laneHandlers = handlers();

    await dispatchVoiceModeTurn({
      text: 'установи громкость обратно',
      candidate: { lane: 'scripted', actionId: 'device.volume.clarification' },
    }, laneHandlers);

    expect(laneHandlers.executeScripted).toHaveBeenCalledWith('установи громкость обратно', undefined);
    expect(laneHandlers.executeAction).not.toHaveBeenCalled();
    expect(laneHandlers.respond).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
    expect(laneHandlers.release).not.toHaveBeenCalled();
  });

  it('dispatches a resolved volume follow-up through its canonical server-reclassified command', async () => {
    const laneHandlers = handlers();

    await dispatchVoiceModeTurn({
      text: 'пятьдесят',
      candidate: {
        lane: 'scripted',
        actionId: 'device.volume',
        slots: {
          clarificationResolved: 'true',
          canonicalCommand: 'установи громкость на 50 процентов',
        },
      },
    }, laneHandlers);

    expect(laneHandlers.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ lane: 'scripted', actionId: 'device.volume' }),
      'установи громкость на 50 процентов',
      undefined,
    );
    expect(laneHandlers.respond).not.toHaveBeenCalled();
  });

  it('keeps an invalid volume clarification retry out of every model lane', async () => {
    const laneHandlers = handlers();

    await dispatchVoiceModeTurn({
      text: 'сто пятьдесят',
      candidate: {
        lane: 'scripted',
        actionId: 'device.volume.clarification',
        slots: {
          clarificationRetry: 'true',
          canonicalCommand: 'установи громкость',
        },
      },
    }, laneHandlers);

    expect(laneHandlers.executeScripted).toHaveBeenCalledWith('установи громкость', undefined);
    expect(laneHandlers.executeAction).not.toHaveBeenCalled();
    expect(laneHandlers.respond).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
  });

  it.each([
    ['voice-micro', 'micro'],
    ['voice-lite', 'lite'],
  ] as const)('maps %s to its isolated voice profile', async (lane, profile) => {
    const laneHandlers = handlers();
    const controller = new AbortController();

    await dispatchVoiceModeTurn({
      text: 'ответь коротко',
      candidate: { lane, actionId: 'assistant.fallback' },
      signal: controller.signal,
    }, laneHandlers);

    expect(laneHandlers.respond).toHaveBeenCalledWith('ответь коротко', profile, controller.signal);
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
  });

  it('sends Fast only to the dedicated Oscar voice capability', async () => {
    const laneHandlers = handlers();
    const controller = new AbortController();

    await dispatchVoiceModeTurn({
      text: 'проанализируй причину',
      candidate: { lane: 'fast-llm', actionId: 'assistant.fallback' },
      signal: controller.signal,
    }, laneHandlers);

    expect(laneHandlers.respondFast).toHaveBeenCalledWith('проанализируй причину', 'ru', controller.signal, []);
    expect(laneHandlers.release).toHaveBeenCalledWith(controller.signal);
    expect(laneHandlers.release.mock.invocationCallOrder[0])
      .toBeLessThan(laneHandlers.respondFast.mock.invocationCallOrder[0]);
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.respond).not.toHaveBeenCalled();
  });

  it('sends weather and web lookups only to the dedicated realtime voice capability', async () => {
    const laneHandlers = handlers();
    const controller = new AbortController();

    await dispatchVoiceModeTurn({
      text: 'погода в Киеве',
      candidate: { lane: 'voice-realtime', actionId: 'weather.query', slots: { location: 'киеве' } },
      signal: controller.signal,
    }, laneHandlers);
    await dispatchVoiceModeTurn({
      text: 'Слушай, Оскар, премьер России',
      candidate: {
        lane: 'voice-realtime',
        actionId: 'web.search',
        slots: { query: 'премьер россии' },
      },
      signal: controller.signal,
    }, laneHandlers);

    expect(laneHandlers.respondRealtime).toHaveBeenNthCalledWith(
      1,
      'погода в Киеве',
      'weather',
      'ru',
      controller.signal,
      'киеве',
      [],
    );
    expect(laneHandlers.respondRealtime).toHaveBeenNthCalledWith(
      2,
      'премьер россии',
      'web-search',
      'ru',
      controller.signal,
      undefined,
      [],
    );
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.release).toHaveBeenCalledTimes(2);
    expect(laneHandlers.release.mock.invocationCallOrder[0])
      .toBeLessThan(laneHandlers.respondRealtime.mock.invocationCallOrder[0]);
    expect(laneHandlers.release.mock.invocationCallOrder[1])
      .toBeLessThan(laneHandlers.respondRealtime.mock.invocationCallOrder[1]);
    expect(laneHandlers.respond).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
  });

  it.each([
    ['device.brightness', { operation: 'set', value: '55' }],
    ['device.brightness.status', { operation: 'get' }],
    ['device.app.open', { app: 'calculator' }],
    ['device.browser.open', { url: 'example.com', browser: 'default' }],
    ['device.media.open', { provider: 'youtube', query: 'Monarch demo' }],
    ['workspace.create', { path: 'note.txt', kind: 'file' }],
    ['workspace.delete', { path: 'note.txt', kind: 'file' }],
  ])('delegates %s to the permission-aware action executor', async (actionId, slots) => {
    const laneHandlers = handlers();
    const candidate = { lane: 'scripted', actionId, slots };

    await dispatchVoiceModeTurn({ text: 'команда', candidate }, laneHandlers);

    expect(laneHandlers.executeAction).toHaveBeenCalledWith(candidate, 'команда', undefined);
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
  });

  it('handles wake-only and blocked turns locally without an API call', async () => {
    const laneHandlers = handlers();

    const wakeOnly = await dispatchVoiceModeTurn({
      text: 'Оскар',
      candidate: {
        lane: 'scripted',
        actionId: 'listen.continue',
        slots: { acknowledgement: 'Слушаю.' },
      },
    }, laneHandlers);
    const blocked = await dispatchVoiceModeTurn({
      text: 'очень длинный запрос',
      candidate: { lane: 'blocked', actionId: 'assistant.fallback' },
    }, laneHandlers);

    expect(wakeOnly).toMatchObject({
      ok: true,
      local: true,
      action: 'listen.continue',
      text: 'Слушаю.',
    });
    expect(blocked).toMatchObject({ ok: false, local: true, blocked: true, error: 'voice-mode-blocked' });
    expect(laneHandlers.executeScripted).not.toHaveBeenCalled();
    expect(laneHandlers.respond).not.toHaveBeenCalled();
    expect(laneHandlers.respondFast).not.toHaveBeenCalled();
  });

  it('keeps the fullscreen voice source detached from Oscar composer submission', () => {
    const source = readFileSync(
      new URL('../../src/ui/public/modules/oscar-voice-mode.js', import.meta.url),
      'utf8',
    );

    expect(source).toContain('dispatchVoiceModeTurn');
    expect(source).toContain('prepareVoiceModeModels');
    expect(source).not.toContain("from './oscar-pane.js'");
    expect(source).not.toContain('submitOscarVoiceTurn');
  });
});

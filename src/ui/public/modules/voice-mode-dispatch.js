import {
  executeVoiceModeAction,
  executeVoiceModeScripted,
  releaseVoiceModeModels,
  respondVoiceMode,
  respondVoiceModeFast,
  respondVoiceModeRealtime,
} from './api.js';

const DEFAULT_HANDLERS = Object.freeze({
  executeAction: executeVoiceModeAction,
  executeScripted: executeVoiceModeScripted,
  release: releaseVoiceModeModels,
  respond: respondVoiceMode,
  respondFast: respondVoiceModeFast,
  respondRealtime: respondVoiceModeRealtime,
});

export async function dispatchVoiceModeTurn(
  { text, candidate, signal } = {},
  handlers = DEFAULT_HANDLERS,
) {
  const lane = String(candidate?.lane || '').trim();
  const actionId = String(candidate?.actionId || '').trim();

  if (actionId === 'listen.continue') {
    return {
      ok: true,
      local: true,
      action: 'listen.continue',
      text: String(candidate?.slots?.acknowledgement || '').trim(),
    };
  }

  if (lane === 'blocked') {
    return {
      ok: false,
      local: true,
      blocked: true,
      error: 'voice-mode-blocked',
      message: 'Этот запрос слишком большой для быстрого голосового ответа.',
      text: '',
    };
  }

  const cleanText = String(text || '').trim();
  if (!cleanText) {
    return {
      ok: false,
      error: 'voice-text-empty',
      message: 'Голосовой запрос пуст.',
      text: '',
    };
  }

  switch (lane) {
  case 'scripted':
    if ([
      'time.query',
      'device.volume',
      'device.volume.status',
      'device.brightness',
      'device.brightness.status',
      'device.app.open',
      'device.browser.open',
      'device.media.open',
      'workspace.create',
      'workspace.delete',
    ].includes(actionId)) {
      const canonicalCommand = candidate?.slots?.clarificationResolved === 'true'
        ? String(candidate?.slots?.canonicalCommand || '').trim()
        : '';
      return handlers.executeAction(candidate, canonicalCommand || cleanText, signal);
    }
    return handlers.executeScripted(
      actionId === 'device.volume.clarification' && candidate?.slots?.clarificationRetry === 'true'
        ? String(candidate?.slots?.canonicalCommand || 'установи громкость')
        : cleanText,
      signal,
    );
  case 'voice-micro':
    return handlers.respond(cleanText, 'micro', signal);
  case 'voice-lite':
    return handlers.respond(cleanText, 'lite', signal);
  case 'voice-realtime':
    {
      const released = await handlers.release(signal);
      if (released?.ok === false) return released;
      const realtimeText = actionId === 'web.search'
        ? String(candidate?.slots?.query || cleanText).trim()
        : cleanText;
      return handlers.respondRealtime(
        realtimeText,
        actionId === 'weather.query' ? 'weather' : 'web-search',
        'ru',
        signal,
        actionId === 'weather.query' ? candidate?.slots?.location : undefined,
        candidate?.context?.history || [],
      );
    }
  case 'fast-llm':
    {
      const released = await handlers.release(signal);
      if (released?.ok === false) return released;
      return handlers.respondFast(cleanText, 'ru', signal, candidate?.context?.history || []);
    }
  default:
    return {
      ok: false,
      error: 'voice-mode-lane-unsupported',
      message: `Неизвестный голосовой маршрут: ${lane || 'empty'}.`,
      text: '',
    };
  }
}

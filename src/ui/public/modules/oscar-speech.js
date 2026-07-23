import { readOscarVoicePreferences } from './oscar-voice-settings.js';

const DEFAULT_CHUNK_LENGTH = 240;

export function normalizeTextForSpeech(value) {
  let text = String(value || '').replace(/\r\n?/g, '\n');
  text = text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, body) => `\n${body}\n`)
    .replace(/!\[([^\]]*)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\|/g, ', ')
    .replace(/\bhttps?:\/\/[^\s<>)]+/gi, spokenUrl);

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    if (/[.!?…:;]$/.test(line)) return line;
    return `${line}.`;
  }).join(' ').replace(/\s+/g, ' ').trim();
}

export function detectSpeechLanguage(value) {
  const text = String(value || '').toLowerCase();
  if (/[іїєґ]/u.test(text)) return 'uk-UA';
  if (/(?:^|[\s,.!?;:])(?:аз|съм|няма|какво|защо|това|благодаря|може ли)(?=$|[\s,.!?;:])/u.test(text)) return 'bg-BG';
  const cyrillic = (text.match(/[а-яё]/giu) || []).length;
  const latin = (text.match(/[a-z]/giu) || []).length;
  return cyrillic > 0 && cyrillic >= latin * 0.35 ? 'ru-RU' : 'en-US';
}

export function chunkSpeechText(value, maxLength = DEFAULT_CHUNK_LENGTH) {
  const text = String(value || '').trim();
  if (!text) return [];
  const safeMax = Math.max(80, Math.min(500, Math.trunc(Number(maxLength) || DEFAULT_CHUNK_LENGTH)));
  const sentences = text.match(/[^.!?…;:]+(?:[.!?…;:]+|$)/gu) || [text];
  const chunks = [];
  let current = '';

  const pushPart = (part) => {
    const clean = part.trim();
    if (!clean) return;
    const next = current ? `${current} ${clean}` : clean;
    if (next.length <= safeMax) {
      current = next;
      return;
    }
    if (current) chunks.push(current);
    current = '';
    if (clean.length <= safeMax) {
      current = clean;
      return;
    }
    const pieces = splitLongSpeechPart(clean, safeMax);
    chunks.push(...pieces.slice(0, -1));
    current = pieces.at(-1) || '';
  };

  sentences.forEach(pushPart);
  if (current) chunks.push(current);
  return chunks;
}

export function selectBestSpeechVoice(voices, language) {
  const list = Array.isArray(voices) ? voices.filter(Boolean) : [];
  if (!list.length) return null;
  return [...list].sort((left, right) => scoreVoice(right, language) - scoreVoice(left, language))[0] || null;
}

export function createOscarSpeechController({
  desktop = globalThis.window?.monarchDesktop,
  speechSynthesis = globalThis.window?.speechSynthesis,
  Utterance = globalThis.window?.SpeechSynthesisUtterance,
  getPreferences = readOscarVoicePreferences,
  onStateChange = () => {},
  onAudioFrame = () => {},
} = {}) {
  let state = {
    status: 'idle',
    messageId: '',
    error: '',
    engine: '',
    warmup: normalizeSpeechWarmupResult({ status: 'idle' }),
    playback: normalizeSpeechPlaybackResult({ status: 'idle' }),
  };
  let runId = 0;
  let removeTelemetryListener = () => {};
  let warmupPromise = null;

  const cloneState = () => ({
    ...state,
    warmup: { ...state.warmup },
    playback: { ...state.playback },
  });

  const publish = (next) => {
    const previousStatus = state.status;
    state = {
      ...state,
      ...next,
      ...(next.warmup ? { warmup: { ...next.warmup } } : {}),
      ...(next.playback ? { playback: { ...next.playback } } : {}),
    };
    onStateChange(cloneState());
    if (previousStatus === 'speaking' && state.status !== 'speaking') {
      onAudioFrame({ level: 0, peak: 0, brightness: 0, rms: 0, sequence: 0, source: 'tts' });
    }
  };

  if (typeof desktop?.onSpeechTelemetry === 'function') {
    try {
      const cleanup = desktop.onSpeechTelemetry((value) => {
        if (state.status !== 'speaking' || state.engine !== 'neural') return;
        const frame = normalizeSpeechAudioFrame(value);
        if (frame) onAudioFrame(frame);
      });
      if (typeof cleanup === 'function') removeTelemetryListener = cleanup;
    } catch {
      // Playback remains available when telemetry subscription is unavailable.
    }
  }

  const stop = () => {
    const stopped = state.status === 'speaking';
    runId += 1;
    if (stopped) {
      try { speechSynthesis?.cancel?.(); } catch { /* best effort */ }
      try { void desktop?.stopSpeaking?.(); } catch { /* best effort */ }
    }
    publish({
      status: 'idle',
      messageId: '',
      error: '',
      engine: '',
      ...(stopped ? { playback: { ...state.playback, status: 'stopped' } } : {}),
    });
    return stopped;
  };

  const toggle = ({ messageId, text }) => {
    const id = String(messageId || '');
    if (state.status === 'speaking' && state.messageId === id) {
      stop();
      return { ok: true, stopped: true };
    }

    stop();
    const normalized = normalizeTextForSpeech(text);
    if (!id || !normalized) {
      publish({ status: 'error', messageId: id, error: 'Нет текста для озвучки.', engine: '' });
      return { ok: false, error: 'speech-text-empty' };
    }

    const language = detectSpeechLanguage(normalized);
    const preferences = getPreferences();
    const currentRun = ++runId;
    if (typeof desktop?.speakText === 'function') {
      publish({
        status: 'speaking',
        messageId: id,
        error: '',
        engine: 'neural',
        playback: normalizeSpeechPlaybackResult({ status: 'speaking', engine: 'qwen3-tts-pending' }),
      });
      Promise.resolve(desktop.speakText({ text: normalized, language, ...preferences }))
        .then((result) => {
          if (currentRun !== runId) return;
          const playback = normalizeSpeechPlaybackResult(result);
          if (result?.ok === false) {
            publish({
              status: 'error',
              messageId: id,
              error: readSpeechFailure(result),
              engine: playback.engine || 'neural',
              playback,
            });
            return;
          }
          publish({ status: 'idle', messageId: '', error: '', engine: '', playback });
        })
        .catch((error) => {
          if (currentRun !== runId) return;
          const playback = normalizeSpeechPlaybackResult({
            status: 'failed',
            ok: false,
            engine: 'neural',
            error: 'speech-ipc-failed',
            summary: readSpeechFailure(error),
          });
          publish({ status: 'error', messageId: id, error: playback.summary, engine: 'neural', playback });
        });
      return { ok: true, engine: 'neural', language, voice: preferences.voice };
    }

    if (speechSynthesis && typeof Utterance === 'function' && typeof speechSynthesis.speak === 'function') {
      const chunks = chunkSpeechText(normalized);
      const voices = typeof speechSynthesis.getVoices === 'function' ? speechSynthesis.getVoices() : [];
      const voice = selectBestSpeechVoice(voices, language);
      publish({
        status: 'speaking',
        messageId: id,
        error: '',
        engine: 'browser',
        playback: normalizeSpeechPlaybackResult({ status: 'speaking', engine: 'browser' }),
      });
      speakBrowserChunk({ chunks, index: 0, language, voice, currentRun, id });
      return { ok: true, engine: 'browser', language, chunks: chunks.length };
    }

    publish({
      status: 'error',
      messageId: id,
      error: 'Озвучка доступна в Monarch Desktop или браузере с системным TTS.',
      engine: '',
    });
    return { ok: false, error: 'speech-unavailable' };
  };

  const speakBrowserChunk = ({ chunks, index, language, voice, currentRun, id }) => {
    if (currentRun !== runId) return;
    if (index >= chunks.length) {
      publish({
        status: 'idle',
        messageId: '',
        error: '',
        engine: '',
        playback: normalizeSpeechPlaybackResult({ status: 'done', ok: true, engine: 'browser' }),
      });
      return;
    }
    try {
      const utterance = new Utterance(chunks[index]);
      utterance.lang = language;
      const speed = Number(getPreferences().speed) || 100;
      utterance.rate = Math.max(0.8, Math.min(1.2, speed / 100));
      utterance.pitch = 0.98;
      if (voice) utterance.voice = voice;
      utterance.onend = () => speakBrowserChunk({ chunks, index: index + 1, language, voice, currentRun, id });
      utterance.onerror = (event) => {
        if (currentRun !== runId || event?.error === 'canceled' || event?.error === 'interrupted') return;
        const playback = normalizeSpeechPlaybackResult({
          status: 'failed',
          ok: false,
          engine: 'browser',
          error: 'browser-speech-failed',
          summary: 'Системный голос не смог озвучить ответ.',
        });
        publish({ status: 'error', messageId: id, error: playback.summary, engine: 'browser', playback });
      };
      speechSynthesis.speak(utterance);
    } catch (error) {
      if (currentRun !== runId) return;
      const playback = normalizeSpeechPlaybackResult({
        status: 'failed',
        ok: false,
        engine: 'browser',
        error: 'browser-speech-failed',
        summary: readSpeechFailure(error),
      });
      publish({ status: 'error', messageId: id, error: playback.summary, engine: 'browser', playback });
    }
  };

  const requestWarmup = (retry = false) => {
    try { speechSynthesis?.getVoices?.(); } catch { /* browser may not expose voices yet */ }
    if (warmupPromise && !retry) return warmupPromise;
    if (retry && state.warmup.status !== 'failed') return warmupPromise || requestWarmup(false);
    if (retry) warmupPromise = null;

    if (typeof desktop?.warmSpeechOutput !== 'function') {
      const result = normalizeSpeechWarmupResult({
        status: 'unavailable',
        ok: false,
        error: 'speech-warmup-unavailable',
        summary: 'Desktop-мост прогрева TTS недоступен.',
      });
      publish({ warmup: result });
      warmupPromise = Promise.resolve(result);
      return warmupPromise;
    }

    publish({ warmup: normalizeSpeechWarmupResult({ status: 'loading' }) });
    let pending;
    try {
      pending = desktop.warmSpeechOutput({ retry });
    } catch (error) {
      pending = Promise.reject(error);
    }
    warmupPromise = Promise.resolve(pending).then(
      (value) => {
        const result = normalizeSpeechWarmupResult(value);
        publish({ warmup: result });
        return result;
      },
      (error) => {
        const result = normalizeSpeechWarmupResult({
          status: 'failed',
          ok: false,
          error: 'speech-warmup-ipc-failed',
          summary: readSpeechFailure(error),
        });
        publish({ warmup: result });
        return result;
      },
    );
    return warmupPromise;
  };
  const prewarm = () => requestWarmup(false);
  const retryWarmup = () => requestWarmup(true);
  const markNeuralReleased = () => {
    warmupPromise = null;
    publish({ warmup: normalizeSpeechWarmupResult({ status: 'idle' }) });
  };
  const releaseForInference = async () => {
    if (typeof desktop?.releaseSpeechOutput !== 'function') {
      return { ok: true, released: false };
    }
    const result = await desktop.releaseSpeechOutput();
    if (result?.ok !== false) markNeuralReleased();
    return result;
  };
  const restoreAfterInference = () => {
    markNeuralReleased();
    return prewarm();
  };

  return {
    toggle,
    stop,
    prewarm,
    awaitWarmup: prewarm,
    retryWarmup,
    releaseForInference,
    restoreAfterInference,
    dispose: () => {
      removeTelemetryListener();
      removeTelemetryListener = () => {};
    },
    isSupported: () => typeof desktop?.speakText === 'function'
      || Boolean(speechSynthesis && typeof Utterance === 'function' && typeof speechSynthesis.speak === 'function'),
    getState: cloneState,
  };
}

export function normalizeSpeechWarmupResult(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const requestedStatus = String(value.status || '').trim().toLowerCase();
  const ok = value.ok === true;
  const status = ok
    ? 'ready'
    : (['idle', 'loading', 'unavailable'].includes(requestedStatus) ? requestedStatus : 'failed');
  return {
    status,
    ok,
    engine: boundedSpeechDiagnostic(value.engine, 80),
    error: ['idle', 'loading'].includes(status)
      ? ''
      : boundedSpeechDiagnostic(value.error || 'neural-tts-warmup-failed', 120),
    summary: ['idle', 'loading'].includes(status)
      ? ''
      : boundedSpeechDiagnostic(value.summary || 'Нейросетевой TTS не прогрелся.', 800),
    elapsedMs: Math.max(0, Math.round(Number(value.elapsedMs) || 0)),
    ...(Number.isFinite(Number(value.attempt)) ? { attempt: Math.max(0, Math.round(Number(value.attempt))) } : {}),
    ...(value.model ? { model: boundedSpeechDiagnostic(value.model, 160) } : {}),
    ...(value.device ? { device: boundedSpeechDiagnostic(value.device, 160) } : {}),
    ...(Number.isFinite(Number(value.loadSeconds)) ? { loadSeconds: Number(value.loadSeconds) } : {}),
    ...(Number.isFinite(Number(value.warmupSeconds)) ? { warmupSeconds: Number(value.warmupSeconds) } : {}),
  };
}

function normalizeSpeechPlaybackResult(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const requestedStatus = String(value.status || '').trim().toLowerCase();
  const ok = value.ok === true;
  const status = ['idle', 'speaking', 'stopped', 'done', 'failed'].includes(requestedStatus)
    ? requestedStatus
    : (ok ? 'done' : 'failed');
  return {
    status,
    ok,
    engine: boundedSpeechDiagnostic(value.engine, 80),
    fallback: value.fallback === true,
    fallbackFrom: boundedSpeechDiagnostic(value.fallbackFrom, 120),
    neuralError: boundedSpeechDiagnostic(value.neuralError, 120),
    error: boundedSpeechDiagnostic(value.error, 120),
    summary: boundedSpeechDiagnostic(value.summary, 800),
    playbackStarted: value.playbackStarted === true,
    partial: value.partial === true,
    ...(Number.isFinite(Number(value.ttfaSeconds)) ? { ttfaSeconds: Number(value.ttfaSeconds) } : {}),
    ...(Number.isFinite(Number(value.generationSeconds)) ? { generationSeconds: Number(value.generationSeconds) } : {}),
    ...(Number.isFinite(Number(value.audioSeconds)) ? { audioSeconds: Number(value.audioSeconds) } : {}),
  };
}

function boundedSpeechDiagnostic(value, limit) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function normalizeSpeechAudioFrame(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rms = boundedAudioNumber(value.rms);
  const peak = boundedAudioNumber(value.peak);
  const brightness = boundedAudioNumber(value.brightness);
  const sequence = Math.max(0, Math.round(Number(value.sequence) || 0));
  if (!String(value.id || '').trim()) return null;
  return {
    level: Math.min(1, Math.sqrt(rms) * 3.2),
    peak,
    brightness,
    rms,
    sequence,
    source: 'tts',
  };
}

function boundedAudioNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function spokenUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^www\./i, '').replace(/\./g, ' точка ');
    return ` ссылка ${host} `;
  } catch {
    return ' ссылка ';
  }
}

function splitLongSpeechPart(value, maxLength) {
  const words = value.split(/\s+/).filter(Boolean);
  const parts = [];
  let current = '';
  for (const word of words) {
    if (word.length > maxLength) {
      if (current) parts.push(current);
      current = '';
      for (let offset = 0; offset < word.length; offset += maxLength) {
        parts.push(word.slice(offset, offset + maxLength));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLength) current = next;
    else {
      if (current) parts.push(current);
      current = word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function scoreVoice(voice, language) {
  const voiceLanguage = String(voice?.lang || '').toLowerCase();
  const wanted = String(language || '').toLowerCase();
  const name = String(voice?.name || '').toLowerCase();
  let score = 0;
  if (voiceLanguage === wanted) score += 120;
  else if (voiceLanguage.split('-')[0] === wanted.split('-')[0]) score += 90;
  if (/natural|neural|online|premium|enhanced/.test(name)) score += 45;
  if (/desktop/.test(name)) score -= 8;
  if (voice?.localService) score += 6;
  if (voice?.default) score += 3;
  const preferred = preferredVoiceNames(language);
  const preferredIndex = preferred.findIndex((candidate) => name.includes(candidate));
  if (preferredIndex >= 0) score += 70 - preferredIndex * 6;
  return score;
}

function preferredVoiceNames(language) {
  if (/^ru/i.test(language)) return ['pavel', 'irina', 'dmitry'];
  if (/^uk/i.test(language)) return ['ostap', 'polina'];
  if (/^bg/i.test(language)) return ['ivan', 'kalina'];
  return ['guy', 'mark', 'aria', 'zira', 'david'];
}

function readSpeechFailure(value) {
  if (typeof value === 'string') return value.slice(0, 240);
  const message = value?.summary || value?.message || value?.error;
  return String(message || 'Не удалось запустить локальную озвучку.').replace(/\s+/g, ' ').slice(0, 240);
}

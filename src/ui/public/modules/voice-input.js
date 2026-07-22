import { transcribeVoiceAudio } from './api.js';
import { setMascotState } from './mascot-controller.js';
import { canUseDirectVoicePcm, createVoicePcmStream } from './voice-pcm-stream.js';

const VOICE_DONE_HIDE_DELAY_MS = 1800;
const VOICE_ERROR_HIDE_DELAY_MS = 8000;
const MIN_RECORDING_MS = 500;
const MAX_RECORDING_MS = 10 * 60_000;
const RECORDING_CHUNK_MS = 500;
const MAX_RECORDING_BYTES = 32 * 1024 * 1024;
const FALLBACK_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

export const VOICE_RECORDING_LIMITS = Object.freeze({
  minMs: MIN_RECORDING_MS,
  maxMs: MAX_RECORDING_MS,
  maxBytes: MAX_RECORDING_BYTES,
});

const SPEECH_LANGUAGE_BY_PRIMARY = Object.freeze({
  ru: 'ru-RU',
  uk: 'uk-UA',
  ua: 'uk-UA',
  bg: 'bg-BG',
  en: 'en-US',
});

const SPOKEN_PUNCTUATION = Object.freeze({
  ru: [
    ['точка с запятой', ';'],
    ['вопросительный знак', '?'],
    ['знак вопроса', '?'],
    ['восклицательный знак', '!'],
    ['знак восклицания', '!'],
    ['двоеточие', ':'],
    ['запятая', ','],
    ['точка', '.'],
  ],
  uk: [
    ['крапка з комою', ';'],
    ['питальний знак', '?'],
    ['знак питання', '?'],
    ['окличний знак', '!'],
    ['знак оклику', '!'],
    ['двокрапка', ':'],
    ['кома', ','],
    ['крапка', '.'],
  ],
  bg: [
    ['точка и запетая', ';'],
    ['въпросителен знак', '?'],
    ['удивителен знак', '!'],
    ['възклицателен знак', '!'],
    ['двоеточие', ':'],
    ['запетая', ','],
    ['точка', '.'],
  ],
  en: [
    ['question mark', '?'],
    ['exclamation mark', '!'],
    ['exclamation point', '!'],
    ['full stop', '.'],
    ['semicolon', ';'],
    ['colon', ':'],
    ['comma', ','],
    ['period', '.'],
  ],
});

const QUESTION_STARTS = Object.freeze({
  ru: /^(?:монарх[\s,]+)?(?:кто|что|где|куда|откуда|когда|почему|зачем|как|какой|какая|какое|какие|сколько|чей|чья|чье|чьи|можно ли|нужно ли|есть ли|будет ли|умеешь ли|можешь ли)(?=\s|$)/iu,
  uk: /^(?:монарх[\s,]+)?(?:хто|що|де|куди|звідки|коли|чому|навіщо|як|який|яка|яке|які|скільки|чий|чия|чи|можна|потрібно)(?=\s|$)/iu,
  bg: /^(?:монарх[\s,]+)?(?:кой|коя|кое|кои|какво|къде|накъде|откъде|кога|защо|как|колко|дали|може ли|има ли)(?=\s|$)/iu,
  en: /^(?:monarch[\s,]+)?(?:who|what|where|when|why|how|which|whose|can|could|would|will|should|is|are|am|do|does|did|has|have|was|were)(?=\s|$)/iu,
});

export function initVoiceInput(root = null) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope) return [];

  return [
    attachVoiceInput({
      form: scope.querySelector('#composer'),
      input: scope.querySelector('#intent-input'),
      button: scope.querySelector('#intent-voice-input'),
      status: scope.querySelector('#intent-voice-status'),
      statusTitle: scope.querySelector('#intent-voice-status [data-voice-title]'),
      statusPreview: scope.querySelector('#intent-voice-status [data-voice-preview]'),
      cancelButton: scope.querySelector('#intent-voice-cancel'),
    }),
    attachVoiceInput({
      form: scope.querySelector('#oscar-composer'),
      input: scope.querySelector('#oscar-input'),
      button: scope.querySelector('#oscar-voice-input'),
      status: scope.querySelector('#oscar-voice-status'),
      statusTitle: scope.querySelector('#oscar-voice-status [data-voice-title]'),
      statusPreview: scope.querySelector('#oscar-voice-status [data-voice-preview]'),
      cancelButton: scope.querySelector('#oscar-voice-cancel'),
      canStart: () => !scope.body?.classList?.contains('voice-mode-open'),
    }),
  ].filter(Boolean);
}

export function attachVoiceInput(options) {
  const win = options.windowObject || (typeof window !== 'undefined' ? window : null);
  const form = options.form;
  const input = options.input;
  const button = options.button;
  if (!form || !input || !button) return null;

  const mode = selectVoiceInputMode(win);
  const supportsRecorder = mode === 'local-recorder';
  const transcribeAudio = options.transcribeAudio || transcribeVoiceAudio;
  const createPcmStream = options.createPcmStream || createVoicePcmStream;
  const encodeAudio = options.encodeAudio || blobToBase64;
  let activeSession = null;
  let sessionCounter = 0;
  let destroyed = false;
  let finalTranscript = '';
  let hideTimer = null;

  const controller = {
    start,
    stop: () => stop(true),
    cancel,
    cancelSilently: () => cancelActiveSession({ showFeedback: false }),
    isListening: () => Boolean(activeSession),
    isSupported: () => Boolean(mode),
    refreshAvailability: syncAvailability,
    destroy,
  };

  button.addEventListener('click', () => {
    if (activeSession?.state === 'recording') {
      stop(true);
      return;
    }
    if (activeSession) {
      return;
    }
    if (isComposerBusy(form, input) && canActivateWhileBusy()) {
      options.onBusyActivate?.();
      return;
    }
    if (!canStartNow()) return;
    start();
  });
  options.cancelButton?.addEventListener('click', cancel);
  form.addEventListener('submit', () => {
    if (activeSession) {
      cancelActiveSession({ showFeedback: false });
    }
  }, { capture: true });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeSession) {
      event.preventDefault();
      cancel();
    }
  });

  const observer = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(syncAvailability)
    : null;
  observer?.observe(form, { attributes: true, attributeFilter: ['aria-busy'] });
  observer?.observe(input, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });

  if (!mode) {
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-label', 'Голосовой ввод недоступен');
    button.title = 'Голосовой ввод недоступен: нет локальной записи MediaRecorder';
    showStatus({ hidden: true });
    return controller;
  }

  syncAvailability();
  showStatus({ hidden: true });
  return controller;

  function start() {
    if (destroyed || activeSession || !canStartNow() || isComposerBusy(form, input)) {
      return;
    }
    if (mode === 'local-recorder') {
      const session = {
        token: ++sessionCounter,
        state: 'starting',
        recorder: null,
        stream: null,
        chunks: [],
        mimeType: preferredRecordingMimeType(win),
        startedAt: 0,
        durationMs: 0,
        commit: false,
        maxTimer: null,
        abortController: null,
        pcmStream: null,
        pcmStartPromise: null,
        pcmFinalPromise: null,
      };
      activeSession = session;
      clearStatusTimer();
      finalTranscript = '';
      button.setAttribute('aria-label', 'Подключаю микрофон');
      button.title = 'Подключаю микрофон';
      showStatus({
        title: 'Подключаю микрофон',
        preview: 'Разреши локальную запись',
        state: 'starting',
        cancelVisible: true,
      });
      syncAvailability();
      void startAudioRecording(session);
    }
  }

  async function startAudioRecording(session) {
    try {
      const stream = await win.navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isActiveSession(session)) {
        stopMediaStream(stream);
        return;
      }
      session.stream = stream;
      options.onStream?.(stream);
      const recorder = new win.MediaRecorder(
        stream,
        session.mimeType ? { mimeType: session.mimeType } : undefined,
      );
      session.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (!isActiveSession(session)) return;
        if (event.data && event.data.size > 0) {
          session.chunks.push(event.data);
        }
      };
      recorder.onerror = (event) => {
        void cancelPcmSession(session);
        finishSession(session, false, readVoiceError(event), 'error');
      };
      recorder.onstop = () => {
        releaseSessionStream(session);
        void finishRecordedBlob(session);
      };
      session.state = 'recording';
      session.startedAt = Date.now();
      form.classList.add('voice-listening');
      button.classList.add('is-listening');
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-label', 'Остановить локальную запись');
      button.title = 'Остановить локальную запись';
      showStatus({
        title: 'Записываю локально',
        preview: 'Говори свободно · нажми микрофон, когда закончишь',
        state: 'listening',
        cancelVisible: true,
      });
      setVoiceMascot('listening', 'Слушаю голосовой ввод');
      if (options.createPcmStream || canUseDirectVoicePcm(win)) {
        session.pcmStartPromise = Promise.resolve(createPcmStream({
          windowObject: win,
          mediaStream: stream,
          language: readSpeechLanguage(win),
          onTelemetry: options.onPcmTelemetry,
        })).then((pcmStream) => {
          if (!isActiveSession(session)) {
            void pcmStream?.cancel?.();
            return null;
          }
          session.pcmStream = pcmStream;
          return pcmStream;
        }).catch(() => null);
      }
      recorder.start(RECORDING_CHUNK_MS);
      session.maxTimer = setTimeout(() => {
        if (isActiveSession(session) && session.state === 'recording') {
          stop(true);
        }
      }, MAX_RECORDING_MS);
      syncAvailability();
    } catch (error) {
      if (isActiveSession(session)) {
        finishSession(session, false, readVoiceError(error), 'error');
      }
    }
  }

  function stop(commit) {
    const session = activeSession;
    if (!session) return;
    if (session.state === 'recording') {
      stopRecording(session, commit);
      return;
    }
    if (!commit || session.state === 'starting') {
      cancelActiveSession({ showFeedback: !commit });
    }
  }

  function cancel() {
    cancelActiveSession({ showFeedback: true });
  }

  function destroy() {
    destroyed = true;
    clearStatusTimer();
    observer?.disconnect();
    cancelActiveSession({ showFeedback: false });
  }

  function syncAvailability() {
    const busy = isComposerBusy(form, input);
    // Voice Mode marks its own capture form busy as soon as recognition starts.
    // That state must disable the trigger without cancelling the clip before
    // MediaRecorder.onstop has handed it to local STT.
    if (busy && activeSession && activeSession.state !== 'recognizing') {
      cancelActiveSession({ showFeedback: false });
      return;
    }
    const state = activeSession?.state || 'idle';
    const busyActivation = !activeSession && busy && canActivateWhileBusy();
    button.disabled = busyActivation ? false : !supportsRecorder
      || state === 'starting'
      || state === 'recognizing'
      || !canStartNow()
      || (busy && state !== 'recording');
    button.setAttribute('aria-disabled', String(button.disabled));
  }

  function canStartNow() {
    try {
      return typeof options.canStart !== 'function' || options.canStart() !== false;
    } catch {
      return false;
    }
  }

  function canActivateWhileBusy() {
    try {
      return typeof options.canActivateWhileBusy === 'function'
        && options.canActivateWhileBusy() === true;
    } catch {
      return false;
    }
  }

  function clearStatusTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function clearRecordingTimer(session) {
    if (session?.maxTimer) {
      clearTimeout(session.maxTimer);
      session.maxTimer = null;
    }
  }

  function showStatus(status) {
    renderVoiceStatus(options, status);
    options.onStateChange?.({ ...status });
    if (status.hideAfter) {
      const delay = typeof status.hideAfter === 'number'
        ? status.hideAfter
        : status.state === 'error'
          ? VOICE_ERROR_HIDE_DELAY_MS
          : VOICE_DONE_HIDE_DELAY_MS;
      hideTimer = setTimeout(() => {
        renderVoiceStatus(options, { hidden: true });
        options.onStateChange?.({ hidden: true, state: 'idle' });
      }, delay);
    }
  }

  function stopRecording(session, commit) {
    if (!isActiveSession(session) || session.state !== 'recording') return;
    const activeRecorder = session.recorder;
    const durationMs = readRecordingDurationMs(session);
    clearRecordingTimer(session);
    if (!activeRecorder) {
      finishSession(session, false, 'Голосовой ввод остановлен', 'error');
      return;
    }
    if (commit && durationMs < MIN_RECORDING_MS) {
      session.commit = false;
      try {
        if (activeRecorder.state !== 'inactive') {
          activeRecorder.stop();
        }
      } catch {}
      finishSession(session, false, 'Слишком короткая запись', 'error');
      return;
    }
    session.commit = commit;
    session.durationMs = durationMs;
    const captureStoppedAtEpochMs = Date.now();
    if (commit) {
      session.state = 'recognizing';
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('aria-label', 'Распознаю локальную запись');
      button.title = 'Распознаю локальную запись';
      showStatus({
        title: 'Подготавливаю запись',
        preview: 'Распознавание можно отменить',
        state: 'recognizing',
        cancelVisible: true,
      });
    }
    if (!commit) {
      cancelActiveSession({ showFeedback: true });
      return;
    }
    session.pcmFinalPromise = session.pcmStartPromise
      ? Promise.resolve(session.pcmStartPromise)
        .then((pcmStream) => pcmStream?.stop?.(captureStoppedAtEpochMs) || null)
        .then((result) => ({ result, error: null }))
        .catch((error) => ({ result: null, error }))
      : null;
    try {
      if (activeRecorder.state !== 'inactive') {
        activeRecorder.stop();
      }
    } catch {
      finishSession(session, false, 'Голосовой ввод остановлен', 'error');
    }
  }

  async function finishRecordedBlob(session) {
    if (!isActiveSession(session) || !session.commit) return;
    const language = readSpeechLanguage(win);
    const direct = session.pcmFinalPromise
      ? await session.pcmFinalPromise.catch(() => null)
      : null;
    if (!isActiveSession(session) || !session.commit) return;
    const directTranscript = typeof direct?.result?.transcript === 'string'
      ? direct.result.transcript.trim()
      : '';
    if (directTranscript) {
      commitRecognizedTranscript(session, directTranscript, language);
      return;
    }
    const chunks = [...session.chunks];
    const mimeType = session.mimeType || chunks[0]?.type || 'audio/webm';
    if (!chunks.length) {
      finishSession(session, false, 'Речь не распознана', 'error');
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size > MAX_RECORDING_BYTES) {
      finishSession(session, false, 'Запись слишком длинная', 'error');
      return;
    }
    showStatus({
      title: 'Распознаю локально',
      preview: 'секунду...',
      state: 'recognizing',
      cancelVisible: true,
    });
    setVoiceMascot('listening', 'Распознаю запись локально');
    try {
      const audioBase64 = await encodeAudio(blob);
      if (!isActiveSession(session)) return;
      session.abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const transcript = await transcribeAudio({
        audioBase64,
        mimeType,
        language,
        durationMs: session.durationMs,
        ...(session.abortController ? { signal: session.abortController.signal } : {}),
      });
      if (!isActiveSession(session)) return;
      commitRecognizedTranscript(session, transcript, language);
    } catch (error) {
      if (isActiveSession(session)) {
        finishSession(session, false, formatVoiceInputError(error), 'error');
      }
    }
  }

  function commitRecognizedTranscript(session, transcript, language) {
    if (!isActiveSession(session)) return;
    const currentValue = input.value || '';
    finalTranscript = formatVoiceTranscript(transcript, language, {
      capitalizeFirst: startsNewSentence(currentValue),
    });
    if (!finalTranscript) {
      finishSession(session, false, 'Речь не распознана', 'error');
      return;
    }
    if (options.insertTranscript !== false) {
      const nextValue = composeVoiceDraft(currentValue, finalTranscript, '');
      input.value = nextValue;
      dispatchInput(input);
    }
    finishSession(session, true, 'Готово', 'done');
    options.onTranscript?.({ transcript: finalTranscript, language });
  }

  function finishSession(session, commit, message, state) {
    if (!isActiveSession(session)) return;
    clearStatusTimer();
    clearRecordingTimer(session);
    releaseSessionStream(session);
    activeSession = null;
    form.classList.remove('voice-listening');
    button.classList.remove('is-listening');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Голосовой ввод');
    button.title = 'Голосовой ввод';
    showStatus({
      title: message,
      preview: commit && finalTranscript ? finalTranscript : '',
      state,
      hideAfter: true,
      cancelVisible: false,
    });
    if (state === 'done') {
      setVoiceMascot('success', 'Голос распознан локально');
    } else if (state === 'error') {
      setVoiceMascot('error', message || 'Голос не распознан');
    } else {
      setVoiceMascot('idle', 'Готов к локальной работе');
    }
    syncAvailability();
  }

  function cancelActiveSession({ showFeedback }) {
    const session = activeSession;
    if (!session) return;
    activeSession = null;
    clearRecordingTimer(session);
    session.abortController?.abort?.();
    void cancelPcmSession(session);
    try {
      if (session.recorder && session.recorder.state !== 'inactive') {
        session.recorder.stop();
      }
    } catch {}
    releaseSessionStream(session);
    form.classList.remove('voice-listening');
    button.classList.remove('is-listening');
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', 'Голосовой ввод');
    button.title = 'Голосовой ввод';
    if (showFeedback) {
      showStatus({
        title: 'Отменено',
        preview: '',
        state: 'idle',
        hideAfter: true,
        cancelVisible: false,
      });
      setVoiceMascot('idle', 'Готов к локальной работе');
    } else {
      showStatus({ hidden: true, cancelVisible: false });
    }
    syncAvailability();
  }

  function isActiveSession(session) {
    return Boolean(session && activeSession?.token === session.token);
  }

  async function cancelPcmSession(session) {
    const pcmStream = session?.pcmStream || await Promise.resolve(session?.pcmStartPromise).catch(() => null);
    session.pcmStream = null;
    await Promise.resolve(pcmStream?.cancel?.()).catch(() => undefined);
  }

  function releaseSessionStream(session) {
    if (!session?.stream) return;
    stopMediaStream(session.stream);
    session.stream = null;
    options.onStream?.(null);
  }

  function readRecordingDurationMs(session) {
    return session.startedAt ? Math.max(0, Date.now() - session.startedAt) : 0;
  }
}

function stopMediaStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

function setVoiceMascot(stateName, detail) {
  try {
    setMascotState(stateName, {
      title: stateName === 'listening' ? 'Oscar слушает' : undefined,
      detail,
      meta: stateName === 'listening' ? 'Голос' : undefined,
    });
  } catch {
    // Voice input stays usable even if the companion surface is not mounted.
  }
}

export function composeVoiceDraft(baseValue, finalTranscript = '', interimTranscript = '') {
  const spoken = normalizeTranscript(`${finalTranscript} ${interimTranscript}`);
  return appendVoiceText(baseValue, spoken);
}

export function appendVoiceText(baseValue, addition) {
  const base = String(baseValue || '');
  const text = normalizeTranscript(addition);
  if (!text) return base;
  if (!base.trim()) return text;
  const trimmed = base.replace(/\s+$/, '');
  const needsSpace = !/[(\[{"'«]$/.test(trimmed) && !/^[,.;:!?)]/.test(text);
  return `${trimmed}${needsSpace ? ' ' : ''}${text}`;
}

export function normalizeTranscript(value) {
  return String(value || '')
    .replace(/\uFFFD/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSpeechLanguage(value) {
  const primary = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .split('-', 1)[0];
  return SPEECH_LANGUAGE_BY_PRIMARY[primary] || 'ru-RU';
}

export function readSpeechLanguage(win) {
  const browserLanguages = Array.from(win?.navigator?.languages || []).filter(Boolean);
  const preferred = browserLanguages[0] || win?.navigator?.language || 'ru-RU';
  return normalizeSpeechLanguage(preferred);
}

export function formatVoiceTranscript(value, language = 'ru-RU', options = {}) {
  const locale = normalizeSpeechLanguage(language);
  const primary = locale.slice(0, 2).toLowerCase();
  let text = normalizeTranscript(value);
  if (!text) return '';

  text = replaceSpokenPunctuation(text, SPOKEN_PUNCTUATION[primary] || []);
  text = text
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  text = capitalizeVoiceSentences(text, locale, options.capitalizeFirst !== false);

  if (!hasTerminalPunctuation(text)) {
    if (QUESTION_STARTS[primary]?.test(stripLeadingVoiceQuote(text))) {
      text += '?';
    } else if (shouldAppendSentencePeriod(text)) {
      text += '.';
    }
  }
  return text;
}

function shouldAppendSentencePeriod(value) {
  const text = value.trim();
  if (!text || /[,;:]$/u.test(text)) return false;
  return !/(?:https?:\/\/|www\.|\b\d+\.\d+\b|\b[\p{L}\p{N}_-]+\.(?:css|docx?|exe|html?|ini|jsx?|json|md|mjs|pdf|ps1|py|sh|toml|tsx?|txt|xlsx?|ya?ml)\b|^(?:cmd|curl|docker|git|node|npm|pip|pnpm|powershell|python|yarn)\b)/iu.test(text);
}

function replaceSpokenPunctuation(value, entries) {
  let result = ` ${value} `;
  for (const [phrase, symbol] of [...entries].sort((left, right) => right[0].length - left[0].length)) {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(phrase)}(?=\\s|$)`, 'giu');
    result = result.replace(pattern, (_match, leadingSpace) => `${leadingSpace}${symbol}`);
  }
  return result.trim();
}

function capitalizeVoiceSentences(value, locale, capitalizeFirst) {
  return value.replace(
    /(^|[.!?…]\s+)([«“"'(\[]*)(\p{L})/gu,
    (match, boundary, opening, letter, offset) => {
      if (offset === 0 && !capitalizeFirst) return match;
      return `${boundary}${opening}${letter.toLocaleUpperCase(locale)}`;
    },
  );
}

function hasTerminalPunctuation(value) {
  return /[.!?…](?:[»”"')\]]*)$/u.test(value.trim());
}

function stripLeadingVoiceQuote(value) {
  return value.replace(/^[«“"'(\[]+\s*/u, '');
}

function startsNewSentence(value) {
  const text = String(value || '').trim();
  return !text || hasTerminalPunctuation(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function canUseAudioRecorder(win) {
  return Boolean(win?.MediaRecorder && win?.navigator?.mediaDevices?.getUserMedia);
}

export function selectVoiceInputMode(win) {
  return canUseAudioRecorder(win) ? 'local-recorder' : null;
}

export function preferredRecordingMimeType(win) {
  const recorder = win?.MediaRecorder;
  if (!recorder?.isTypeSupported) return '';
  return FALLBACK_RECORDING_MIME_TYPES.find((type) => recorder.isTypeSupported(type)) || '';
}

function renderVoiceStatus(targets, status) {
  const container = targets.status;
  if (!container) return;
  const cancelVisible = !status.hidden && status.cancelVisible === true;
  if (targets.cancelButton) {
    targets.cancelButton.hidden = !cancelVisible;
    targets.cancelButton.disabled = !cancelVisible;
    targets.cancelButton.tabIndex = cancelVisible ? 0 : -1;
    targets.cancelButton.setAttribute('aria-hidden', String(!cancelVisible));
  }
  if (status.hidden) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.dataset.state = status.state || 'idle';
  if (targets.statusTitle) {
    targets.statusTitle.textContent = status.title || 'Голос';
  }
  if (targets.statusPreview) {
    targets.statusPreview.textContent = status.preview || '';
  }
}

function dispatchInput(input) {
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function isComposerBusy(form, input) {
  return input.disabled || input.getAttribute('aria-disabled') === 'true' || form.getAttribute('aria-busy') === 'true';
}

function readVoiceError(error) {
  const code = String(error?.error || error?.message || error || '').toLowerCase();
  if (/not-allowed|permission|denied/.test(code)) return 'Микрофон запрещён';
  if (/audio-capture|no-microphone|not-found/.test(code)) return 'Микрофон не найден';
  if (/no-speech/.test(code)) return 'Речь не распознана';
  if (/network/.test(code)) return 'Локальный голосовой ввод недоступен';
  return 'Голосовой ввод остановлен';
}

export function formatVoiceInputError(error) {
  const code = String(error?.code || error?.result?.error || '').toLowerCase();
  const message = String(error?.message || error || '');
  const value = `${code} ${message}`.toLowerCase();
  if (/voice-audio-too-long|voice-stt-stream-too-long/.test(code)) {
    return 'Запись превысила 10 минут. Заверши диктовку раньше.';
  }
  if (/voice-stt-timeout|timeout|timed out|превысила лимит|не успел/.test(value)) {
    return 'Распознавание заняло слишком долго. Скажи короче.';
  }
  if (/voice-audio-too-large|voice-audio-too-long|request-too-large|too large|слишком больш|слишком длин/.test(value)) {
    return 'Запись слишком длинная. Скажи короче.';
  }
  if (/voice-stt-empty-transcript|empty|без текста|не вернул текст|no speech|no-speech/.test(value)) {
    return 'Речь не распознана';
  }
  if (/voice-stt-command-missing|не настроен/.test(value)) {
    return 'Локальный STT не настроен';
  }
  return message || 'Голосовой ввод остановлен';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.split(',', 2)[1] || '');
    };
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать аудио.'));
    reader.readAsDataURL(blob);
  });
}

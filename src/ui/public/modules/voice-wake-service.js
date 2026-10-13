import { attachVoiceInput } from './voice-input.js';
import { createAdaptiveVoiceActivityDetector, measureVoicePcmFrame } from './voice-activity-detector.js';
import { readVoiceInputPreferences, readVoiceSettingsSnapshot } from './oscar-voice-settings.js';

const RESTART_DELAY_MS = 220;
const ERROR_RESTART_DELAY_MS = 8_000;
const WAKE_SEGMENT_ROTATION_MS = 4 * 60_000;
const WAKE_PREFIX = /^(?:(?:эй|hey)[\s,.:;!?-]+)?(?:(?:[вb]\s*)?о+с+к+[аa]+р+|vos+c*[aа]+r+|os+c*[aа]+r+)(?=$|[\s,.:;!?-])[\s,.:;!?-]*/iu;
const WAKE_ONLY = /^(?:(?:эй|hey)[\s,.:;!?-]+)?(?:(?:[вb]\s*)?о+с+к+[аa]+р+|vos+c*[aа]+r+|os+c*[aа]+r+)[\s,.:;!?-]*$/iu;
const WAKE_INCOMPLETE_PARTIAL_ONLY = /^(?:(?:эй|hey)[\s,.:;!?-]+)?(?:(?:[вb]\s*)?о+с+к+[аa]+|vos+c*[aа]+|os+c*[aа]+)[\s,.:;!?-]*$/iu;

export function initVoiceWakeService({ root = document, voiceMode } = {}) {
  const desktop = globalThis.window?.monarchDesktop;
  if (!root?.body || !voiceMode || typeof desktop?.updateVoiceWakeState !== 'function') {
    publishState('unavailable');
    return null;
  }

  const host = root.createElement('div');
  host.hidden = true;
  host.setAttribute('aria-hidden', 'true');
  const form = root.createElement('form');
  const input = root.createElement('textarea');
  const button = root.createElement('button');
  button.type = 'button';
  form.append(input, button);
  host.append(form);
  root.body.append(host);

  let destroyed = false;
  let pausedByVoice = false;
  let pausedByExternalCapture = false;
  let restartTimer = 0;
  let analyserCleanup = () => {};
  let state = 'idle';
  let settingsReady = readVoiceSettingsSnapshot().ready === true;
  let acknowledgedInvocation = null;
  let lastDiagnostic = null;
  let lastSegmentResetAt = 0;

  const capture = attachVoiceInput({
    form,
    input,
    button,
    windowObject: window,
    insertTranscript: false,
    silentUi: true,
    maxRecordingMs: 0,
    retainFallbackAudio: false,
    canStart: shouldListen,
    onStream: bindActivityDetector,
    onPartialTranscript: ({ transcript }) => handlePartialTranscript(transcript),
    onTranscript: ({ transcript }) => handleTranscript(transcript),
    onError: (diagnostic) => {
      lastDiagnostic = diagnostic;
    },
    onStateChange: (next) => {
      if (next?.state === 'starting') {
        lastDiagnostic = null;
        setState('starting');
      } else if (next?.state === 'listening') setState('listening');
      else if (next?.state === 'recognizing') setState('recognizing');
      else if (next?.state === 'error') {
        acknowledgedInvocation = null;
        if (!lastDiagnostic) {
          setState('listening');
          scheduleRestart();
          return;
        }
        const diagnosticText = `${lastDiagnostic.code || ''} ${lastDiagnostic.message || ''} ${next.title || ''}`;
        setState(/доступ|permission|notallowed/iu.test(diagnosticText) ? 'permission-denied' : 'error');
        scheduleRestart(ERROR_RESTART_DELAY_MS);
      }
    },
  });

  const onSettings = () => {
    settingsReady = true;
    reconcile();
  };
  const onVoiceOpen = () => {
    pausedByVoice = true;
    stopListening();
    setState('voice-active');
  };
  const onVoiceClosed = () => {
    pausedByVoice = false;
    scheduleRestart(260);
  };
  const onCaptureClick = (event) => {
    if (!event.target?.closest?.('#intent-voice-input, #oscar-voice-input')) return;
    pausedByExternalCapture = true;
    stopListening();
    setState('dictation-active');
    waitForExternalCaptureEnd();
  };
  window.addEventListener('monarch:voice-settings-changed', onSettings);
  window.addEventListener('monarch:voice-mode-open', onVoiceOpen);
  window.addEventListener('monarch:voice-mode-closed', onVoiceClosed);
  root.addEventListener('click', onCaptureClick, true);
  reconcile();

  return {
    reconcile,
    destroy() {
      destroyed = true;
      clearRestart();
      analyserCleanup();
      capture?.destroy?.();
      window.removeEventListener('monarch:voice-settings-changed', onSettings);
      window.removeEventListener('monarch:voice-mode-open', onVoiceOpen);
      window.removeEventListener('monarch:voice-mode-closed', onVoiceClosed);
      root.removeEventListener('click', onCaptureClick, true);
      host.remove();
      setState('disabled');
    },
    snapshot: () => ({ state, enabled: isEnabled(), listening: capture?.isListening?.() === true }),
  };

  function isEnabled() {
    const preferences = readVoiceInputPreferences();
    return preferences.simplifiedModeEnabled !== false && preferences.backgroundWakeEnabled !== false;
  }

  function shouldListen() {
    return !destroyed
      && settingsReady
      && isEnabled()
      && !pausedByVoice
      && !pausedByExternalCapture;
  }

  function reconcile() {
    clearRestart();
    if (!settingsReady) {
      stopListening();
      setState('settings-loading');
      return;
    }
    if (!shouldListen()) {
      stopListening();
      setState(isEnabled() ? pausedByVoice ? 'voice-active' : 'dictation-active' : 'disabled');
      return;
    }
    startListening();
  }

  function startListening() {
    if (!shouldListen() || capture?.isListening?.()) return;
    capture?.start?.();
  }

  function stopListening() {
    clearRestart();
    analyserCleanup();
    capture?.cancelSilently?.();
  }

  function scheduleRestart(delay = RESTART_DELAY_MS) {
    clearRestart();
    if (!shouldListen()) return;
    restartTimer = window.setTimeout(() => {
      restartTimer = 0;
      startListening();
    }, delay);
  }

  function clearRestart() {
    if (restartTimer) window.clearTimeout(restartTimer);
    restartTimer = 0;
  }

  function bindActivityDetector(stream) {
    analyserCleanup();
    if (!stream || !shouldListen()) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContext !== 'function') {
      setState('manual-only');
      return;
    }
    let context;
    let source;
    let analyser;
    let interval = 0;
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
    } catch (error) {
      try { source?.disconnect?.(); } catch {}
      void context?.close?.();
      lastDiagnostic = {
        stage: 'wake-analyser',
        code: String(error?.name || error?.code || '').slice(0, 80),
        message: String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 240),
      };
      setState('error');
      return;
    }
    const timeData = new Uint8Array(analyser.fftSize);
    const clock = () => Number(window.performance?.now?.()) || Date.now();
    lastSegmentResetAt = clock();
    const detector = createAdaptiveVoiceActivityDetector({
      startedAtMs: lastSegmentResetAt,
      maxSpeechMs: 9_000,
      noSpeechMs: 60_000,
    });
    interval = window.setInterval(() => {
      if (!shouldListen() || !capture?.isListening?.()) return;
      analyser.getByteTimeDomainData(timeData);
      const activity = detector.push({ ...measureVoicePcmFrame(timeData), atMs: clock() });
      if (activity.type === 'speech-start') setState('hearing');
      if (activity.type === 'speech-end' || activity.type === 'max-duration') {
        analyserCleanup();
        capture.stop();
      } else if (activity.type === 'no-speech') {
        acknowledgedInvocation = null;
        const now = clock();
        detector.reset(now);
        setState('listening');
        if (now - lastSegmentResetAt >= WAKE_SEGMENT_ROTATION_MS) {
          lastSegmentResetAt = now;
          void capture.resetSegment?.().catch((error) => {
            lastDiagnostic = {
              stage: 'wake-segment-reset',
              code: String(error?.name || error?.code || '').slice(0, 80),
              message: String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 240),
            };
            setState('error');
            stopListening();
            scheduleRestart(ERROR_RESTART_DELAY_MS);
          });
        }
      }
    }, 48);
    analyserCleanup = () => {
      if (interval) window.clearInterval(interval);
      interval = 0;
      try { source?.disconnect?.(); } catch {}
      void context?.close?.();
      analyserCleanup = () => {};
    };
  }

  function handleTranscript(value) {
    const text = String(value || '').trim();
    if (!shouldListen()) return;
    const invocation = parseWakeInvocation(text);
    const wasAcknowledged = Boolean(acknowledgedInvocation);
    const accepted = invocation.matched ? invocation : acknowledgedInvocation;
    acknowledgedInvocation = null;
    if (!accepted?.matched) {
      setState('listening');
      scheduleRestart();
      return;
    }
    pausedByVoice = true;
    stopListening();
    setState('activated');
    voiceMode.open({
      source: 'background-wake',
      acknowledged: wasAcknowledged,
      ...(accepted.wakeOnly ? {} : { transcript: accepted.command }),
    });
  }

  function handlePartialTranscript(value) {
    if (!shouldListen() || acknowledgedInvocation) return;
    const invocation = parseWakePartialInvocation(value);
    if (!invocation.matched) return;
    acknowledgedInvocation = invocation;
    setState('activated');
    voiceMode.acknowledgeWake?.();
  }

  function waitForExternalCaptureEnd() {
    const poll = () => {
      if (destroyed) return;
      const busy = [...root.querySelectorAll('#intent-voice-input, #oscar-voice-input')]
        .some((element) => element.classList.contains('is-listening') || element.disabled);
      if (busy) {
        window.setTimeout(poll, 320);
        return;
      }
      pausedByExternalCapture = false;
      scheduleRestart(260);
    };
    window.setTimeout(poll, 500);
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    publishState(next, lastDiagnostic);
    void desktop.updateVoiceWakeState({
      state: next,
      enabled: isEnabled(),
      ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}),
    }).catch(() => undefined);
  }
}

export function parseWakeInvocation(value) {
  const text = String(value || '').trim();
  if (!WAKE_PREFIX.test(text)) return { matched: false, wakeOnly: false, command: '' };
  return {
    matched: true,
    wakeOnly: WAKE_ONLY.test(text),
    command: text.replace(WAKE_PREFIX, '').trim(),
  };
}

export function parseWakePartialInvocation(value) {
  const exact = parseWakeInvocation(value);
  if (exact.matched) return exact;
  const text = String(value || '').trim();
  if (!WAKE_INCOMPLETE_PARTIAL_ONLY.test(text)) {
    return { matched: false, wakeOnly: false, command: '' };
  }
  return { matched: true, wakeOnly: true, command: '' };
}

function publishState(state, diagnostic = null) {
  const labels = {
    unavailable: 'Только в Desktop',
    'settings-loading': 'Жду загрузку настроек',
    disabled: 'Выключено',
    starting: 'Запрашиваю микрофон',
    listening: 'Жду обращения «Оскар»',
    hearing: 'Слышу речь',
    recognizing: 'Распознаю обращение',
    activated: 'Оскар активирован',
    'voice-active': 'Активный голосовой сеанс',
    'dictation-active': 'Микрофон передан диктовке',
    'permission-denied': 'Нет разрешения на микрофон',
    'manual-only': 'Автопауза недоступна',
    error: 'Не удалось услышать обращение. Проверь микрофон и попробуй включить снова.',
  };
  window.dispatchEvent(new CustomEvent('monarch:voice-wake-state', {
    detail: { state, label: labels[state] || 'Отклик на обращение', diagnostic },
  }));
}

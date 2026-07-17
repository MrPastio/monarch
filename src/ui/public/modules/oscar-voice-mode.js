import {
  classifyVoiceModeText,
  closeVoiceModeSession,
  completeVoiceModeTurn,
  prepareVoiceModeModels,
  releaseVoiceModeModels,
  startVoiceModeSession,
} from './api.js';
import { createOscarSpeechController } from './oscar-speech.js';
import { attachVoiceInput } from './voice-input.js';
import {
  createAdaptiveVoiceActivityDetector,
  measureVoicePcmFrame,
} from './voice-activity-detector.js';
import { dispatchVoiceModeTurn } from './voice-mode-dispatch.js';
import { createVoiceThinkingPhrasePicker } from './voice-mode-phrases.js';
import {
  createVoiceModeClarification,
  resolveVoiceModeClarification,
} from './voice-mode-clarification.js';
import {
  advanceVoiceOrbMotion,
  blendVoiceOrbFrames,
  createVoiceOrbFrame,
  createVoiceSpeechEnvelope,
  normalizeVoiceAmplitude,
  normalizeVoiceOrbFrameDelta,
  normalizeVoiceModePhase,
  resolveVoiceModeVisualState,
  sampleVoiceSpeechEnvelope,
  smoothVoiceOrbSignal,
  VOICE_MODE_VISUAL_STATES,
  VOICE_ORB_STATE_TRANSITION_MS,
} from './voice-mode-state.js';

const PHASE_COPY = Object.freeze({
  idle: ['Готов', 'Oscar рядом', 'Возвращаю микрофон'],
  entering: ['Пробуждаюсь', 'Oscar рядом', 'Подключаю локальный микрофон'],
  listening: ['Слушаю', 'Говори', 'Закончу запись автоматически после короткой паузы'],
  recognizing: ['Распознаю локально', 'Слышу тебя', 'Перевожу звук в текст'],
  routing: ['Выбираю маршрут', 'Понял запрос', 'Проверяю, хватит ли быстрого пути'],
  thinking: ['Готовлю ответ', 'Сейчас отвечу', 'Работает локальный Fast ceiling'],
  speaking: ['Отвечаю', 'Оскар говорит', 'Нажми круг, чтобы прервать ответ'],
  error: ['Не получилось', 'Нужна ещё попытка', 'Проверь микрофон и повтори'],
});
const VISUAL_STATE_ACCESSIBLE_LABELS = Object.freeze({
  idle: 'Голосовой индикатор Оскар: ожидание',
  listening: 'Оскар слушает. Нажми, чтобы закончить реплику вручную',
  thinking: 'Оскар обрабатывает запрос',
  speaking: 'Оскар отвечает. Нажми, чтобы остановить ответ и говорить дальше',
  paused: 'Голосовой индикатор Оскар: пауза',
});

const VOICE_SPEECH_FALLBACK_COPY = Object.freeze({
  'neural-tts-runtime-missing': 'Qwen TTS не установлен',
  'neural-tts-ready-timeout': 'Qwen TTS не успел прогреться',
  'neural-tts-start-timeout': 'Qwen TTS не начал воспроизведение вовремя',
  'neural-tts-completion-timeout': 'Qwen TTS не завершил озвучку вовремя',
  'neural-tts-playback-frame-missing': 'Qwen TTS не подтвердил воспроизведение',
  'neural-tts-startup-failed': 'Qwen TTS не запустился',
  'neural-tts-worker-exit': 'Qwen TTS-worker завершился',
  'neural-tts-retirement-timeout': 'Предыдущий Qwen TTS-worker не завершился',
  'neural-tts-disabled': 'Qwen TTS отключён',
});

export function describeVoiceSpeechFallback(playback = {}) {
  if (!playback || playback.fallback !== true) return null;
  const lastError = String(
    playback.fallbackFrom || playback.neuralError || playback.error || 'neural-tts-unavailable',
  ).trim().replace(/\s+/g, ' ').slice(0, 120);
  const reason = VOICE_SPEECH_FALLBACK_COPY[lastError] || 'Qwen TTS недоступен';
  return {
    lastError,
    kicker: 'Аварийная озвучка',
    title: 'Ответ озвучен через Windows',
    detail: `${reason} · использован локальный SAPI (${lastError})`,
  };
}

export async function warmVoiceModeSpeech(speech) {
  const first = await speech.awaitWarmup();
  if (first?.status !== 'failed') return { warmup: first, retried: false };
  const retry = await speech.retryWarmup();
  return { warmup: retry, retried: true };
}

export function initOscarVoiceMode(root = document) {
  const surface = root.querySelector('#oscar-voice-mode-surface');
  const openButton = root.querySelector('#oscar-voice-mode');
  const closeButton = root.querySelector('#oscar-voice-mode-close');
  const endButton = root.querySelector('#oscar-voice-mode-end');
  const muteButton = root.querySelector('#oscar-voice-mode-mute');
  const captureForm = root.querySelector('#oscar-voice-mode-capture');
  const captureInput = root.querySelector('#oscar-voice-mode-input');
  const orb = root.querySelector('#oscar-voice-mode-orb');
  const orbCanvas = root.querySelector('#oscar-voice-mode-canvas');
  if (!surface || !openButton || !captureForm || !captureInput || !orb) return null;

  const kicker = root.querySelector('#oscar-voice-mode-kicker');
  const title = root.querySelector('#oscar-voice-mode-title');
  const detail = root.querySelector('#oscar-voice-mode-detail');
  const transcript = root.querySelector('#oscar-voice-mode-transcript');
  const thinking = root.querySelector('#oscar-voice-mode-thinking');
  const live = root.querySelector('#oscar-voice-mode-live');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const pickThinkingPhrase = createVoiceThinkingPhrasePicker();
  let isOpen = false;
  let micMuted = false;
  let turnId = 0;
  let openTimer = 0;
  let restartTimer = 0;
  let thinkingTimer = 0;
  let lastFocus = null;
  let analyserCleanup = () => {};
  let speechLevelCleanup = () => {};
  let speechEnvelope = createVoiceSpeechEnvelope('Oscar');
  let lastSpeechStatus = 'idle';
  let lastSpeechTelemetryAt = 0;
  let expectingSpeech = false;
  let activeTurnController = null;
  let pendingClarification = null;
  let speechWarmupFailure = null;
  let voiceSessionId = '';
  let voiceSessionPromise = null;
  let voiceSessionEpoch = 0;

  const orbRenderer = createOrganicVoiceOrbRenderer({
    canvas: orbCanvas,
    orb,
    reducedMotion,
    windowObject: window,
  });
  orb.addEventListener('click', guardMutedCapture, { capture: true });

  const speech = createOscarSpeechController({
    desktop: window.monarchDesktop,
    speechSynthesis: window.speechSynthesis,
    Utterance: window.SpeechSynthesisUtterance,
    onAudioFrame: (frame) => {
      if (!isOpen || lastSpeechStatus !== 'speaking' || reducedMotion?.matches) return;
      const level = normalizeVoiceAmplitude(frame?.level);
      if (level <= 0) return;
      lastSpeechTelemetryAt = window.performance?.now?.() || Date.now();
      surface.dataset.outputTelemetry = 'live';
      const brightness = normalizeVoiceAmplitude(frame?.brightness);
      const peak = normalizeVoiceAmplitude(frame?.peak);
      const balance = Math.max(-1, Math.min(1, (brightness - 0.42) * 1.65 + (peak - level) * 0.18));
      writeVoiceLevel(level, 'tts', balance);
    },
    onStateChange: (speechState) => {
      const previous = lastSpeechStatus;
      lastSpeechStatus = speechState.status;
      if (!isOpen) return;
      if (speechState.status === 'speaking') {
        expectingSpeech = false;
        analyserCleanup();
        setPhase('speaking');
        bindSpeechLevel();
        return;
      }
      if (speechState.status === 'error') {
        expectingSpeech = false;
        speechLevelCleanup();
        const lastError = String(
          speechState.playback?.neuralError || speechState.playback?.error || '',
        ).trim().slice(0, 120);
        surface.dataset.speechFallback = 'false';
        if (lastError) surface.dataset.speechLastError = lastError;
        else delete surface.dataset.speechLastError;
        setPhase('error', {
          detail: speechState.error || 'Не удалось озвучить ответ',
        });
        scheduleListening(2200);
        return;
      }
      if (speechState.status === 'idle' && previous === 'speaking' && !expectingSpeech) {
        speechLevelCleanup();
        const fallbackNotice = describeVoiceSpeechFallback(speechState.playback);
        surface.dataset.speechFallback = String(Boolean(fallbackNotice));
        if (fallbackNotice?.lastError) surface.dataset.speechLastError = fallbackNotice.lastError;
        else delete surface.dataset.speechLastError;
        if (micMuted) {
          setPhase('listening', {
            kicker: 'Микрофон выключен',
            title: 'Я не слушаю',
            detail: fallbackNotice?.detail || 'Включи микрофон, чтобы продолжить',
          });
          return;
        }
        setPhase('idle', fallbackNotice || {});
        scheduleListening(fallbackNotice ? 900 : 420);
      }
    },
  });
  speech.prewarm();

  const capture = attachVoiceInput({
    form: captureForm,
    input: captureInput,
    button: orb,
    windowObject: window,
    insertTranscript: false,
    onStream: (stream) => bindMicrophoneLevel(stream),
    canStart: () => isOpen && !micMuted,
    canActivateWhileBusy: () => isOpen && surface.dataset.phase === 'speaking',
    onBusyActivate: interruptSpeech,
    onTranscript: ({ transcript: spokenText }) => void handleTranscript(spokenText),
    onStateChange: (captureState) => {
      if (!isOpen || micMuted || captureState.hidden) return;
      if (captureState.state === 'starting') {
        setPhase('entering', { kicker: 'Микрофон', detail: 'Запрашиваю локальный аудиопоток' });
      } else if (captureState.state === 'listening') {
        setPhase('listening', speechWarmupFailureCopy());
      } else if (captureState.state === 'recognizing') {
        setPhase('recognizing');
      } else if (captureState.state === 'error') {
        setPhase('error', { detail: captureState.title || 'Голос не распознан' });
        scheduleListening(2200);
      }
    },
  });

  openButton.addEventListener('click', open);
  closeButton?.addEventListener('click', close);
  endButton?.addEventListener('click', close);
  muteButton?.addEventListener('click', toggleMute);
  surface.addEventListener('keydown', trapDialogKeydown);

  function open() {
    if (isOpen) return;
    abortActiveTurn();
    isOpen = true;
    micMuted = false;
    pendingClarification = null;
    speechWarmupFailure = null;
    turnId += 1;
    const openingTurn = turnId;
    const sessionEpoch = ++voiceSessionEpoch;
    voiceSessionId = '';
    voiceSessionPromise = startVoiceModeSession().then((sessionId) => {
      if (!isOpen || sessionEpoch !== voiceSessionEpoch) {
        void closeVoiceModeSession(sessionId).catch(() => undefined);
        return '';
      }
      voiceSessionId = sessionId;
      return sessionId;
    }).catch(() => '');
    lastFocus = document.activeElement;
    clearTimers();
    surface.hidden = false;
    keepSurfaceAtOrigin();
    surface.dataset.mic = 'live';
    surface.dataset.voiceActivity = 'waiting';
    orbRenderer?.start();
    resetVoiceLevel();
    document.body.classList.add('voice-mode-open');
    syncMuteControl();
    setPhase('entering', { detail: 'Подготавливаю локальный Qwen-голос' });
    live.textContent = 'Голосовой режим открыт. Проверяю готовность локального голоса.';
    closeButton?.focus({ preventScroll: true });
    // Qwen TTS owns startup priority: loading Micro/Lite in parallel can push
    // Windows over its commit limit and silently force every turn onto SAPI.
    // The overlay stays responsive, while listening and CPU model preparation
    // begin only after the bounded shared neural warmup has settled.
    const continueAfterSpeechWarmup = ({ warmup } = {}) => {
      if (!isOpen || openingTurn !== turnId) return;
      const ready = warmup?.ok === true && warmup?.status === 'ready';
      surface.dataset.speechWarmup = ready ? 'ready' : 'failed';
      if (ready) {
        speechWarmupFailure = null;
        delete surface.dataset.speechLastError;
      } else {
        const lastError = String(warmup?.error || 'neural-tts-warmup-failed').slice(0, 120);
        speechWarmupFailure = {
          lastError,
          summary: String(warmup?.summary || 'Qwen TTS не прогрелся.').slice(0, 300),
        };
        surface.dataset.speechLastError = lastError;
        setPhase('error', {
          kicker: 'Qwen TTS недоступен',
          title: 'Голос не прогрелся',
          detail: `${speechWarmupFailure.summary} · микрофон останется доступен`,
        });
        live.textContent = `Qwen TTS не готов: ${lastError}. Продолжаю слушать, но аварийная Windows-озвучка явно отмечена.`;
      }
      // This capability now prepares streaming STT only. Lite stays lazy and
      // cannot race Qwen's allocation; a failed Qwen warmup never preloads it.
      void prepareVoiceModeModels().catch(() => {
        // Direct MediaRecorder transcription remains the truthful fallback.
      });
      openTimer = window.setTimeout(
        startListening,
        ready ? (reducedMotion?.matches ? 40 : 180) : 1_100,
      );
    };
    void warmVoiceModeSpeech(speech).then(continueAfterSpeechWarmup, (error) => {
      continueAfterSpeechWarmup({
        warmup: {
          status: 'failed',
          ok: false,
          error: 'speech-warmup-ipc-failed',
          summary: error instanceof Error ? error.message : String(error || 'Qwen TTS warmup failed.'),
        },
      });
    });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    voiceSessionEpoch += 1;
    const closingSessionId = voiceSessionId;
    const closingSessionPromise = voiceSessionPromise;
    voiceSessionId = '';
    voiceSessionPromise = null;
    pendingClarification = null;
    turnId += 1;
    abortActiveTurn();
    clearTimers();
    capture?.cancel();
    speech.stop();
    void releaseVoiceModeModels().catch(() => {
      // Closing must stay instant; the backend still owns exact-worker safety.
    });
    if (closingSessionId) {
      void closeVoiceModeSession(closingSessionId).catch(() => undefined);
    } else {
      void closingSessionPromise?.then((sessionId) => (
        sessionId ? closeVoiceModeSession(sessionId) : null
      )).catch(() => undefined);
    }
    analyserCleanup();
    speechLevelCleanup();
    resetVoiceLevel();
    surface.dataset.phase = 'closed';
    surface.dataset.voiceActivity = 'idle';
    surface.dataset.visualState = 'paused';
    orbRenderer?.setVisualState('paused');
    orbRenderer?.stop();
    surface.classList.add('is-closing');
    document.body.classList.remove('voice-mode-open');
    window.setTimeout(() => {
      surface.hidden = true;
      surface.classList.remove('is-closing');
      lastFocus?.focus?.({ preventScroll: true });
    }, reducedMotion?.matches ? 1 : 260);
  }

  function toggleMute() {
    const currentPhase = surface.dataset.phase;
    micMuted = !micMuted;
    surface.dataset.mic = micMuted ? 'muted' : 'live';
    syncVisualState();
    syncMuteControl();
    keepSurfaceAtOrigin();
    if (micMuted) {
      pendingClarification = null;
      capture?.cancel();
      analyserCleanup();
      surface.dataset.voiceActivity = 'idle';
      if (lastSpeechStatus === 'speaking' || ['recognizing', 'routing', 'thinking'].includes(currentPhase)) {
        syncVisualState();
        if (live) live.textContent = 'Микрофон выключен. Текущая задача продолжает выполняться.';
        return;
      }
      setPhase('listening', {
        kicker: 'Микрофон выключен',
        title: 'Я не слушаю',
        detail: 'Озвучивание ответа останется активным',
      });
      return;
    }
    if (!['speaking', 'recognizing', 'routing', 'thinking'].includes(surface.dataset.phase)) {
      if (live) live.textContent = 'Микрофон включен. Возвращаюсь к прослушиванию.';
      scheduleListening(180);
      return;
    }
    if (live) live.textContent = 'Микрофон включен. Текущая задача продолжает выполняться.';
  }

  function interruptSpeech() {
    if (!isOpen || surface.dataset.phase !== 'speaking') return false;
    expectingSpeech = false;
    const stopped = speech.stop();
    if (!stopped) return false;
    speechLevelCleanup();
    setPhase('idle', {
      kicker: 'Ответ остановлен',
      title: 'Слушаю тебя',
      detail: micMuted ? 'Включи микрофон, чтобы продолжить' : 'Говори новую команду',
    });
    if (!micMuted) scheduleListening(80);
    return true;
  }

  function guardMutedCapture(event) {
    if (!micMuted || surface.dataset.phase === 'speaking') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (live) live.textContent = 'Микрофон выключен. Включи его кнопкой внизу.';
  }

  function startListening() {
    if (!isOpen || micMuted || capture?.isListening()) return;
    speechLevelCleanup();
    resetVoiceLevel();
    captureInput.value = '';
    if (!capture?.isSupported()) {
      setPhase('error', { detail: 'MediaRecorder или доступ к микрофону недоступен' });
      return;
    }
    setPhase('listening', speechWarmupFailureCopy());
    surface.dataset.voiceActivity = 'waiting';
    capture.start();
  }

  function speechWarmupFailureCopy() {
    if (!speechWarmupFailure) return {};
    return {
      kicker: 'Qwen TTS недоступен',
      title: 'Говори',
      detail: `${speechWarmupFailure.summary} · ответ может прозвучать через Windows`,
    };
  }

  async function handleTranscript(spokenText) {
    const text = String(spokenText || '').trim();
    if (!isOpen || !text) return;
    analyserCleanup();
    resetVoiceLevel();
    abortActiveTurn();
    const controller = new AbortController();
    activeTurnController = controller;
    const currentTurn = ++turnId;
    clearRestartTimer();
    transcript.textContent = text;
    setPhase('routing');
    try {
      const sessionId = voiceSessionId || await voiceSessionPromise || '';
      const classifiedCandidate = await classifyVoiceModeText(text, controller.signal, sessionId);
      if (!isOpen || currentTurn !== turnId) return;
      const clarification = resolveVoiceModeClarification(
        pendingClarification,
        classifiedCandidate,
        text,
      );
      const candidate = clarification.candidate;
      pendingClarification = clarification.pending;
      surface.dataset.lane = candidate.lane || 'scripted';

      const isLocalResult = candidate.actionId === 'listen.continue' || candidate.lane === 'blocked';
      if (!isLocalResult) {
        setPhase('thinking', {
          detail: candidate.lane === 'fast-llm'
            ? 'Сложный запрос · Fast с жёстким потолком'
            : candidate.lane === 'voice-realtime'
              ? candidate.actionId === 'weather.query'
                ? 'Получаю погоду напрямую · без модели'
                : 'Ищу источники · короткий Fast-ответ'
            : candidate.lane === 'voice-micro'
              ? 'Мгновенный Micro-путь'
              : candidate.lane === 'voice-lite'
                ? 'Короткий Lite-путь'
                : 'Выполняю без модели',
        });
        showThinkingPhrase();
      }
      const result = await dispatchVoiceModeTurn({
        text,
        candidate,
        signal: controller.signal,
      });
      clearThinkingTimer();
      if (!isOpen || currentTurn !== turnId) return;
      if (result.action === 'listen.continue' && !result.text) {
        transcript.textContent = 'Слушаю команду после «Оскар»';
        if (micMuted) {
          setPhase('listening', {
            kicker: 'Микрофон выключен',
            title: 'Я не слушаю',
            detail: 'Включи микрофон, чтобы продолжить',
          });
          return;
        }
        scheduleListening(300);
        return;
      }
      if (result.blocked) {
        setPhase('error', {
          title: 'Лучше продолжить текстом',
          detail: result.message || 'Этот запрос слишком большой для быстрого голосового ответа',
        });
        scheduleListening(3200);
        return;
      }
      if (!result.ok || !result.text) {
        if (candidate.actionId !== 'listen.continue') pendingClarification = null;
        setPhase('error', { detail: readableVoiceError(result.message || result.error) });
        scheduleListening(2600);
        return;
      }

      const contextTurnId = String(candidate?.context?.turnId || '').trim();
      if (sessionId && contextTurnId) {
        const committed = await completeVoiceModeTurn({
          sessionId,
          turnId: contextTurnId,
          response: result.text,
          actionId: candidate.actionId,
          signal: controller.signal,
        }).catch(() => null);
        if (committed?.ok === false) {
          const recoveryEpoch = voiceSessionEpoch;
          voiceSessionId = '';
          voiceSessionPromise = startVoiceModeSession().then((nextId) => {
            if (!isOpen || recoveryEpoch !== voiceSessionEpoch) {
              void closeVoiceModeSession(nextId).catch(() => undefined);
              return '';
            }
            voiceSessionId = nextId;
            return nextId;
          }).catch(() => '');
        }
      }

      const nextClarification = createVoiceModeClarification(candidate);
      if (nextClarification) pendingClarification = nextClarification;
      else if (candidate.actionId !== 'listen.continue') pendingClarification = null;

      transcript.textContent = compactVisibleAnswer(result.text);
      thinking.hidden = true;
      expectingSpeech = true;
      speechEnvelope = createVoiceSpeechEnvelope(result.text);
      const speechResult = speech.toggle({
        messageId: `voice-turn-${currentTurn}`,
        text: result.text,
      });
      if (!speechResult?.ok) {
        expectingSpeech = false;
        setPhase('error', { detail: 'Ответ готов, но локальная озвучка недоступна' });
        scheduleListening(2400);
      }
    } catch (error) {
      clearThinkingTimer();
      if (controller.signal.aborted || isAbortError(error)) return;
      if (!isOpen || currentTurn !== turnId) return;
      setPhase('error', { detail: readableVoiceError(error) });
      scheduleListening(2600);
    } finally {
      if (activeTurnController === controller) {
        activeTurnController = null;
      }
    }
  }

  function abortActiveTurn() {
    const controller = activeTurnController;
    activeTurnController = null;
    controller?.abort();
  }

  function setPhase(phase, overrides = {}) {
    const safePhase = normalizeVoiceModePhase(phase);
    const copy = PHASE_COPY[safePhase] || PHASE_COPY.error;
    surface.dataset.phase = safePhase;
    if (safePhase !== 'listening') surface.dataset.voiceActivity = 'idle';
    syncVisualState();
    if (kicker) kicker.textContent = overrides.kicker || copy[0];
    if (title) title.textContent = overrides.title || copy[1];
    if (detail) detail.textContent = overrides.detail || copy[2];
    if (live) live.textContent = `${overrides.title || copy[1]}. ${overrides.detail || copy[2]}`;
    captureForm.setAttribute('aria-busy', String(['recognizing', 'routing', 'thinking', 'speaking'].includes(safePhase)));
    if (safePhase !== 'thinking') thinking.hidden = true;
    keepSurfaceAtOrigin();
  }

  function keepSurfaceAtOrigin() {
    surface.scrollTop = 0;
    surface.scrollLeft = 0;
    window.requestAnimationFrame?.(() => {
      if (!isOpen) return;
      surface.scrollTop = 0;
      surface.scrollLeft = 0;
    });
  }

  function syncVisualState() {
    const visualState = resolveVoiceModeVisualState(surface.dataset.phase, { micMuted });
    surface.dataset.visualState = visualState;
    orb.dataset.visualState = visualState;
    orb.setAttribute('aria-label', micMuted
      ? 'Голосовой индикатор Оскар: пауза, микрофон выключен'
      : VISUAL_STATE_ACCESSIBLE_LABELS[visualState]);
    orbRenderer?.setVisualState(visualState);
  }

  function showThinkingPhrase() {
    clearThinkingTimer();
    const phrase = pickThinkingPhrase();
    thinking.textContent = phrase;
    thinking.hidden = false;
    thinkingTimer = window.setTimeout(() => {
      if (!isOpen || surface.dataset.phase !== 'thinking') return;
      thinking.textContent = pickThinkingPhrase();
    }, 5200);
  }

  function scheduleListening(delay = 400) {
    clearRestartTimer();
    if (!isOpen || micMuted) return;
    restartTimer = window.setTimeout(startListening, delay);
  }

  function clearRestartTimer() {
    if (restartTimer) window.clearTimeout(restartTimer);
    restartTimer = 0;
  }

  function clearThinkingTimer() {
    if (thinkingTimer) window.clearTimeout(thinkingTimer);
    thinkingTimer = 0;
  }

  function clearTimers() {
    if (openTimer) window.clearTimeout(openTimer);
    openTimer = 0;
    clearRestartTimer();
    clearThinkingTimer();
  }

  function syncMuteControl() {
    orb.setAttribute('aria-disabled', String(micMuted));
    orb.title = micMuted ? 'Микрофон выключен' : '';
    capture?.refreshAvailability?.();
    if (!muteButton) return;
    muteButton.setAttribute('aria-pressed', String(micMuted));
    muteButton.classList.toggle('is-muted', micMuted);
    const label = muteButton.querySelector('span');
    if (label) label.textContent = micMuted ? 'Включить микрофон' : 'Микрофон';
  }

  function bindMicrophoneLevel(stream) {
    analyserCleanup();
    speechLevelCleanup();
    resetVoiceLevel();
    if (!stream || !isOpen) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContext !== 'function') {
      surface.dataset.voiceActivity = 'manual';
      setPhase('listening', { detail: 'Автопауза недоступна · нажми круг, когда закончишь' });
      return;
    }
    let frame = 0;
    let smoothedLevel = 0;
    let context = null;
    let source = null;
    let analyser = null;
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
    } catch {
      try { source?.disconnect?.(); } catch { /* visualizer is best effort */ }
      void context?.close?.();
      resetVoiceLevel();
      return;
    }
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.76;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Uint8Array(analyser.fftSize);
    const readClockMs = () => {
      const value = window.performance?.now?.();
      return Number.isFinite(value) ? value : Date.now();
    };
    const detector = createAdaptiveVoiceActivityDetector({
      startedAtMs: readClockMs(),
      maxSpeechMs: 10_800,
    });
    surface.dataset.voiceActivity = 'waiting';
    const sample = () => {
      if (!isOpen || micMuted || surface.dataset.phase !== 'listening') return;
      analyser.getByteFrequencyData(data);
      analyser.getByteTimeDomainData(timeData);
      const midpoint = Math.max(1, Math.floor(data.length * 0.38));
      const highLength = Math.max(1, data.length - midpoint);
      let peakValue = 0;
      let total = 0;
      let lowTotal = 0;
      let highTotal = 0;
      for (let index = 0; index < data.length; index += 1) {
        const value = data[index];
        if (value > peakValue) peakValue = value;
        total += value;
        if (index < midpoint) lowTotal += value;
        else highTotal += value;
      }
      const peak = peakValue / 255;
      const average = total / Math.max(1, data.length) / 255;
      const low = lowTotal / midpoint / 255;
      const high = highTotal / highLength / 255;
      const rawLevel = normalizeVoiceAmplitude(peak * 0.72 + average * 1.4);
      smoothedLevel = smoothedLevel * 0.68 + rawLevel * 0.32;
      if (reducedMotion?.matches) {
        writeVoiceLevel(0.18, 'mic', 0);
      } else {
        writeVoiceLevel(smoothedLevel, 'mic', Math.max(-1, Math.min(1, (high - low) * 3.2)));
      }
      const activity = detector.push({
        ...measureVoicePcmFrame(timeData),
        atMs: readClockMs(),
      });
      if (activity.type === 'speech-start') {
        surface.dataset.voiceActivity = 'speech';
        setPhase('listening', {
          kicker: 'Слышу речь',
          detail: 'Продолжай · закончу после короткой паузы',
        });
        if (transcript) transcript.textContent = 'Слышу тебя — говори свободно';
      } else if (activity.type === 'speech-end' || activity.type === 'max-duration') {
        surface.dataset.voiceActivity = 'ending';
        if (live) live.textContent = activity.type === 'max-duration'
          ? 'Достигнут предел голосовой реплики. Отправляю на распознавание.'
          : 'Пауза распознана. Отправляю голос на распознавание.';
        capture?.stop();
        return;
      } else if (activity.type === 'no-speech') {
        surface.dataset.voiceActivity = 'waiting';
        capture?.cancelSilently();
        setPhase('listening', { detail: 'Жду голос · запись начнётся автоматически' });
        if (transcript) transcript.textContent = 'Начинай говорить — нажимать ничего не нужно';
        scheduleListening(140);
        return;
      }
      frame = window.requestAnimationFrame(sample);
    };
    frame = window.requestAnimationFrame(sample);
    analyserCleanup = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      try { source?.disconnect?.(); } catch { /* best effort */ }
      void context?.close?.();
      if (surface.dataset.voiceActivity !== 'idle') surface.dataset.voiceActivity = 'waiting';
      resetVoiceLevel();
      analyserCleanup = () => {};
    };
  }

  function bindSpeechLevel() {
    speechLevelCleanup();
    analyserCleanup();
    if (reducedMotion?.matches) {
      surface.dataset.outputTelemetry = 'reduced-motion';
      writeVoiceLevel(0.24, 'tts', 0);
      speechLevelCleanup = () => {
        resetVoiceLevel();
        speechLevelCleanup = () => {};
      };
      return;
    }

    let frame = 0;
    lastSpeechTelemetryAt = 0;
    surface.dataset.outputTelemetry = 'synthetic-fallback';
    const startedAt = window.performance?.now?.() || Date.now();
    const sample = (now) => {
      if (!isOpen || lastSpeechStatus !== 'speaking') return;
      const elapsed = Math.max(0, (Number(now) || Date.now()) - startedAt);
      if (lastSpeechTelemetryAt > 0 && (Number(now) || Date.now()) - lastSpeechTelemetryAt < 180) {
        frame = window.requestAnimationFrame(sample);
        return;
      }
      surface.dataset.outputTelemetry = 'synthetic-fallback';
      const level = sampleVoiceSpeechEnvelope(speechEnvelope, elapsed);
      const balance = Math.sin(elapsed / 248) * 0.72;
      writeVoiceLevel(level, 'tts', balance);
      frame = window.requestAnimationFrame(sample);
    };
    frame = window.requestAnimationFrame(sample);
    speechLevelCleanup = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      lastSpeechTelemetryAt = 0;
      resetVoiceLevel();
      speechLevelCleanup = () => {};
    };
  }

  function writeVoiceLevel(value, source, balance = 0) {
    const level = normalizeVoiceAmplitude(value);
    const safeBalance = Math.max(-1, Math.min(1, Number(balance) || 0));
    surface.style.setProperty('--voice-level', level.toFixed(3));
    surface.style.setProperty('--voice-energy', (level * level).toFixed(3));
    surface.style.setProperty('--voice-input-level', source === 'mic' ? level.toFixed(3) : '0');
    surface.style.setProperty('--voice-output-level', source === 'tts' ? level.toFixed(3) : '0');
    surface.style.setProperty('--voice-balance', safeBalance.toFixed(3));
    surface.dataset.levelSource = level > 0.015 ? source : 'ambient';
    orbRenderer?.setLevels({
      level,
      inputLevel: source === 'mic' ? level : 0,
      outputLevel: source === 'tts' ? level : 0,
      balance: safeBalance,
    });
  }

  function resetVoiceLevel() {
    if (surface.dataset.phase !== 'speaking') surface.dataset.outputTelemetry = 'idle';
    writeVoiceLevel(0, 'ambient', 0);
  }

  function trapDialogKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...surface.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return {
    open,
    close,
    toggleMute,
    isOpen: () => isOpen,
    isMuted: () => micMuted,
    getPhase: () => surface.dataset.phase,
    destroy: () => {
      close();
      orbRenderer?.destroy();
    },
  };
}

const VOICE_ORB_CANVAS_PALETTES = Object.freeze({
  idle: Object.freeze({
    highlight: '#fff2bd',
    inner: '#ffc552',
    middle: '#d86608',
    edge: '#2b0d02',
    glow: '255, 157, 24',
  }),
  listening: Object.freeze({
    highlight: '#ffd77a',
    inner: '#bd5c0b',
    middle: '#652304',
    edge: '#100703',
    glow: '228, 112, 12',
  }),
  thinking: Object.freeze({
    highlight: '#fff8dc',
    inner: '#ffd45c',
    middle: '#ee8610',
    edge: '#461403',
    glow: '255, 172, 32',
  }),
  speaking: Object.freeze({
    highlight: '#fffef4',
    inner: '#ffe79a',
    middle: '#ffac23',
    edge: '#742405',
    glow: '255, 190, 56',
  }),
  paused: Object.freeze({
    highlight: '#dca252',
    inner: '#8c430d',
    middle: '#3a1605',
    edge: '#0b0603',
    glow: '198, 103, 18',
  }),
});

export function createOrganicVoiceOrbRenderer({ canvas, orb, reducedMotion, windowObject }) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  let context = null;
  try {
    // Keep compositor synchronization enabled. Desynchronized 2D canvases can
    // visibly tear on the Electron/Windows GPU path during rapid state changes.
    context = canvas.getContext('2d', { alpha: true });
  } catch {
    return null;
  }
  if (!context) return null;

  const targetSignal = {
    level: 0,
    inputLevel: 0,
    outputLevel: 0,
    balance: 0,
  };
  let renderedSignal = { ...targetSignal };
  let visualState = 'paused';
  let stateTransition = null;
  let active = false;
  let destroyed = false;
  let frameRequest = 0;
  let cssWidth = 1;
  let cssHeight = 1;
  let dpr = 1;
  let sizeDirty = true;
  let lastFrameAt = null;
  let motionPhase = 0;
  let lastRenderedFrame = null;

  const requestFrame = typeof windowObject.requestAnimationFrame === 'function'
    ? (callback) => windowObject.requestAnimationFrame(callback)
    : (callback) => windowObject.setTimeout(() => callback(now()), 16);
  const cancelFrame = typeof windowObject.cancelAnimationFrame === 'function'
    ? (id) => windowObject.cancelAnimationFrame(id)
    : (id) => windowObject.clearTimeout(id);

  orb?.classList?.add('has-organic-canvas');

  function now() {
    return windowObject.performance?.now?.() ?? Date.now();
  }

  function syncCanvasSize() {
    const rect = canvas.getBoundingClientRect?.();
    const nextWidth = Math.max(1, Math.round(rect?.width || orb?.clientWidth || 280));
    const nextHeight = Math.max(1, Math.round(rect?.height || orb?.clientHeight || nextWidth));
    const nextDpr = Math.max(1, Math.min(2, Number(windowObject.devicePixelRatio) || 1));
    const pixelWidth = Math.round(nextWidth * nextDpr);
    const pixelHeight = Math.round(nextHeight * nextDpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    cssWidth = nextWidth;
    cssHeight = nextHeight;
    dpr = nextDpr;
  }

  function createFrame(state) {
    return createVoiceOrbFrame({
      visualState: state,
      motionPhase,
      level: renderedSignal.level,
      inputLevel: renderedSignal.inputLevel,
      outputLevel: renderedSignal.outputLevel,
      balance: renderedSignal.balance,
      reducedMotion: Boolean(reducedMotion?.matches),
    });
  }

  function draw() {
    if (destroyed) return;
    if (sizeDirty) {
      syncCanvasSize();
      sizeDirty = false;
    }
    const targetFrame = createFrame(visualState);
    const frame = stateTransition
      ? blendVoiceOrbFrames(
        stateTransition.fromFrame,
        targetFrame,
        stateTransition.elapsedMs / VOICE_ORB_STATE_TRANSITION_MS,
      )
      : targetFrame;
    if (stateTransition && frame !== stateTransition.fromFrame && frame.paletteMix) {
      frame.paletteMix = {
        ...frame.paletteMix,
        fromPalette: stateTransition.fromPalette,
      };
    }
    lastRenderedFrame = frame;
    drawOrganicVoiceOrb(context, frame, cssWidth, cssHeight, dpr);
  }

  function advanceFrame(timestamp) {
    const safeTimestamp = Number.isFinite(timestamp) ? timestamp : now();
    const deltaMs = lastFrameAt === null
      ? 0
      : normalizeVoiceOrbFrameDelta(safeTimestamp - lastFrameAt);
    lastFrameAt = safeTimestamp;
    renderedSignal = smoothVoiceOrbSignal(renderedSignal, targetSignal, deltaMs);
    motionPhase = advanceVoiceOrbMotion({
      phase: motionPhase,
      deltaMs,
      visualState,
      level: renderedSignal.level,
      reducedMotion: Boolean(reducedMotion?.matches),
    });
    if (stateTransition && deltaMs > 0) {
      stateTransition.elapsedMs += deltaMs;
      if (stateTransition.elapsedMs >= VOICE_ORB_STATE_TRANSITION_MS) stateTransition = null;
    }
  }

  function tick(timestamp) {
    frameRequest = 0;
    if (!active || destroyed) return;
    advanceFrame(timestamp);
    draw();
    schedule();
  }

  function schedule() {
    if (!active || destroyed || windowObject.document?.hidden) return;
    if (reducedMotion?.matches) return;
    if (!frameRequest) frameRequest = requestFrame(tick);
  }

  function cancelScheduledFrame() {
    if (frameRequest) cancelFrame(frameRequest);
    frameRequest = 0;
  }

  function handleResize() {
    sizeDirty = true;
    draw();
    schedule();
  }

  function handleMotionPreference() {
    cancelScheduledFrame();
    lastFrameAt = null;
    stateTransition = null;
    if (reducedMotion?.matches) renderedSignal = { ...targetSignal };
    draw();
    if (!reducedMotion?.matches) {
      lastFrameAt = now();
      schedule();
    }
  }

  function handleVisibility() {
    cancelScheduledFrame();
    lastFrameAt = null;
    if (!windowObject.document?.hidden) {
      sizeDirty = true;
      draw();
      lastFrameAt = now();
      schedule();
    }
  }

  const resizeObserver = typeof windowObject.ResizeObserver === 'function'
    ? new windowObject.ResizeObserver(handleResize)
    : null;
  resizeObserver?.observe(orb || canvas);
  if (!resizeObserver) windowObject.addEventListener?.('resize', handleResize);
  windowObject.document?.addEventListener?.('visibilitychange', handleVisibility);
  reducedMotion?.addEventListener?.('change', handleMotionPreference);
  if (!reducedMotion?.addEventListener) reducedMotion?.addListener?.(handleMotionPreference);
  draw();

  return {
    start() {
      if (destroyed) return;
      if (active) {
        schedule();
        return;
      }
      active = true;
      sizeDirty = true;
      lastFrameAt = now();
      draw();
      schedule();
    },
    stop() {
      active = false;
      cancelScheduledFrame();
      lastFrameAt = null;
      stateTransition = null;
      renderedSignal = { ...targetSignal };
      draw();
    },
    setVisualState(value) {
      const nextState = VOICE_MODE_VISUAL_STATES.includes(value) ? value : 'paused';
      if (nextState === visualState) {
        schedule();
        return;
      }
      const previousFrame = lastRenderedFrame || createFrame(visualState);
      const previousPalette = resolveVoiceOrbCanvasPalette(previousFrame);
      visualState = nextState;
      stateTransition = active && !reducedMotion?.matches
        ? { fromFrame: previousFrame, fromPalette: previousPalette, elapsedMs: 0 }
        : null;
      if (reducedMotion?.matches || !active) draw();
      schedule();
    },
    setLevels(nextSignal = {}) {
      targetSignal.level = normalizeVoiceAmplitude(nextSignal.level);
      targetSignal.inputLevel = normalizeVoiceAmplitude(nextSignal.inputLevel);
      targetSignal.outputLevel = normalizeVoiceAmplitude(nextSignal.outputLevel);
      targetSignal.balance = Math.max(-1, Math.min(1, Number(nextSignal.balance) || 0));
      if (reducedMotion?.matches || !active) {
        renderedSignal = { ...targetSignal };
        draw();
      }
      schedule();
    },
    snapshot() {
      return {
        active,
        destroyed,
        visualState,
        motionPhase,
        frameScheduled: Boolean(frameRequest),
        transitionProgress: stateTransition
          ? Math.min(1, stateTransition.elapsedMs / VOICE_ORB_STATE_TRANSITION_MS)
          : 1,
        signal: { ...renderedSignal },
        targetSignal: { ...targetSignal },
        renderedFrame: lastRenderedFrame ? {
          state: lastRenderedFrame.state,
          radius: lastRenderedFrame.radius,
          luminance: lastRenderedFrame.luminance,
          point0: lastRenderedFrame.points?.[0] ? { ...lastRenderedFrame.points[0] } : null,
          palette: { ...resolveVoiceOrbCanvasPalette(lastRenderedFrame) },
        } : null,
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      lastFrameAt = null;
      stateTransition = null;
      cancelScheduledFrame();
      resizeObserver?.disconnect();
      if (!resizeObserver) windowObject.removeEventListener?.('resize', handleResize);
      windowObject.document?.removeEventListener?.('visibilitychange', handleVisibility);
      reducedMotion?.removeEventListener?.('change', handleMotionPreference);
      if (!reducedMotion?.removeEventListener) reducedMotion?.removeListener?.(handleMotionPreference);
      orb?.classList?.remove('has-organic-canvas');
    },
  };
}

function drawOrganicVoiceOrb(context, frame, width, height, dpr) {
  const side = Math.min(width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  const palette = resolveVoiceOrbCanvasPalette(frame);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  drawVoiceOrbRings(context, frame, centerX, centerY, side, palette);
  drawVoiceOrbBands(context, frame, centerX, centerY, side, palette);

  const aura = context.createRadialGradient(centerX, centerY, side * 0.04, centerX, centerY, side * 0.43);
  aura.addColorStop(0, `rgba(${palette.glow}, ${0.11 + frame.glow * 0.08})`);
  aura.addColorStop(0.42, `rgba(${palette.glow}, ${0.04 + frame.glow * 0.04})`);
  aura.addColorStop(1, `rgba(${palette.glow}, 0)`);
  context.fillStyle = aura;
  context.fillRect(0, 0, width, height);

  context.save();
  traceSmoothVoiceOrbPath(context, frame.points, centerX, centerY, side * 1.08);
  context.globalCompositeOperation = 'lighter';
  context.shadowColor = `rgba(${palette.glow}, ${0.3 + frame.glow * 0.25})`;
  context.shadowBlur = side * (0.075 + frame.glow * 0.065);
  context.fillStyle = `rgba(${palette.glow}, ${0.055 + frame.glow * 0.055})`;
  context.fill();
  context.restore();

  const highlightX = centerX - side * 0.07 + frame.balance * side * 0.018;
  const highlightY = centerY - side * 0.085;
  const fill = context.createRadialGradient(
    highlightX,
    highlightY,
    side * 0.006,
    centerX,
    centerY,
    side * (frame.radius * 1.23),
  );
  fill.addColorStop(0, palette.highlight);
  fill.addColorStop(0.18, palette.inner);
  fill.addColorStop(0.58, palette.middle);
  fill.addColorStop(1, palette.edge);

  context.save();
  traceSmoothVoiceOrbPath(context, frame.points, centerX, centerY, side);
  context.shadowColor = `rgba(${palette.glow}, ${0.34 + frame.glow * 0.28})`;
  context.shadowBlur = side * (0.045 + frame.glow * 0.045);
  context.fillStyle = fill;
  context.fill();
  context.clip();

  const sheen = context.createRadialGradient(
    centerX - side * 0.105,
    centerY - side * 0.12,
    0,
    centerX - side * 0.04,
    centerY - side * 0.05,
    side * 0.26,
  );
  sheen.addColorStop(0, `rgba(255, 255, 244, ${0.22 + frame.luminance * 0.25})`);
  sheen.addColorStop(0.26, `rgba(255, 239, 191, ${0.07 + frame.luminance * 0.08})`);
  sheen.addColorStop(1, 'rgba(255, 170, 35, 0)');
  context.globalCompositeOperation = 'screen';
  context.fillStyle = sheen;
  context.fillRect(0, 0, width, height);

  if (frame.state === 'thinking' || frame.state === 'speaking') {
    drawVoiceOrbInteriorLight(context, frame, centerX, centerY, side);
  }
  context.restore();

  context.save();
  traceSmoothVoiceOrbPath(context, frame.points, centerX, centerY, side);
  context.strokeStyle = `rgba(255, 242, 204, ${0.12 + frame.luminance * 0.16})`;
  context.lineWidth = Math.max(0.7, side * 0.0034);
  context.stroke();
  context.restore();

  drawVoiceOrbParticles(context, frame, centerX, centerY, side, palette);
}

function resolveVoiceOrbCanvasPalette(frame) {
  const target = VOICE_ORB_CANVAS_PALETTES[frame.state] || VOICE_ORB_CANVAS_PALETTES.paused;
  const mix = frame.paletteMix;
  if (!mix || mix.progress >= 1) return target;
  const source = mix.fromPalette || VOICE_ORB_CANVAS_PALETTES[mix.from] || target;
  return {
    highlight: blendHexColor(source.highlight, target.highlight, mix.progress),
    inner: blendHexColor(source.inner, target.inner, mix.progress),
    middle: blendHexColor(source.middle, target.middle, mix.progress),
    edge: blendHexColor(source.edge, target.edge, mix.progress),
    glow: blendRgbTriplet(source.glow, target.glow, mix.progress),
  };
}

function blendHexColor(from, to, progress) {
  const parse = (value) => {
    const source = String(value || '#000000').trim();
    const channels = /^rgba?\(/i.test(source) ? source.match(/[\d.]+/g) : null;
    if (channels?.length >= 3) {
      return channels.slice(0, 3).map((part) => Math.max(0, Math.min(255, Number(part) || 0)));
    }
    const clean = source.replace('#', '');
    const expanded = clean.length === 3
      ? clean.split('').map((part) => `${part}${part}`).join('')
      : clean.padEnd(6, '0').slice(0, 6);
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) || 0);
  };
  const source = parse(from);
  const target = parse(to);
  return `rgb(${source.map((value, index) => Math.round(value + (target[index] - value) * progress)).join(', ')})`;
}

function blendRgbTriplet(from, to, progress) {
  const parse = (value) => String(value || '0, 0, 0')
    .split(',')
    .map((part) => Math.max(0, Math.min(255, Number(part.trim()) || 0)));
  const source = parse(from);
  const target = parse(to);
  return source.map((value, index) => Math.round(value + (target[index] - value) * progress)).join(', ');
}

function drawVoiceOrbRings(context, frame, centerX, centerY, side, palette) {
  if (!frame.rings.length) return;
  context.save();
  context.lineWidth = Math.max(0.8, side * (0.0027 + frame.level * 0.0018));
  for (const ring of frame.rings) {
    context.globalAlpha = ring.alpha;
    context.strokeStyle = ring.accent ? 'rgba(255, 239, 191, .9)' : `rgb(${palette.glow})`;
    context.beginPath();
    context.ellipse(
      centerX,
      centerY,
      ring.radiusX * side,
      ring.radiusY * side,
      ring.rotation,
      0,
      Math.PI * 2,
    );
    context.stroke();
  }
  context.restore();
}

function drawVoiceOrbBands(context, frame, centerX, centerY, side, palette) {
  if (!frame.bands.length) return;
  context.save();
  context.strokeStyle = `rgb(${palette.glow})`;
  context.lineWidth = Math.max(0.8, side * (0.0028 + frame.level * 0.0024));
  for (const band of frame.bands) {
    const reach = band.reach * side;
    const lift = band.lift * side;
    const coreReach = frame.radius * side * 1.18;
    context.globalAlpha = band.alpha;
    context.beginPath();
    context.moveTo(centerX - reach, centerY);
    context.bezierCurveTo(
      centerX - reach * 0.78,
      centerY - lift,
      centerX - reach * 0.68,
      centerY + lift,
      centerX - coreReach,
      centerY,
    );
    context.moveTo(centerX + reach, centerY);
    context.bezierCurveTo(
      centerX + reach * 0.78,
      centerY - lift,
      centerX + reach * 0.68,
      centerY + lift,
      centerX + coreReach,
      centerY,
    );
    context.stroke();
  }
  context.restore();
}

function drawVoiceOrbInteriorLight(context, frame, centerX, centerY, side) {
  const lobes = frame.state === 'thinking' ? 3 : 2;
  for (let index = 0; index < lobes; index += 1) {
    const angle = index * 2.25 + frame.balance * 0.35;
    const x = centerX + Math.cos(angle) * side * (0.055 + index * 0.017);
    const y = centerY + Math.sin(angle) * side * (0.045 + index * 0.012);
    const radius = side * (0.1 + frame.level * 0.025 - index * 0.009);
    const light = context.createRadialGradient(x, y, 0, x, y, radius);
    light.addColorStop(0, `rgba(255, 255, 235, ${0.12 + frame.level * 0.1})`);
    light.addColorStop(1, 'rgba(255, 185, 55, 0)');
    context.fillStyle = light;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

function drawVoiceOrbParticles(context, frame, centerX, centerY, side, palette) {
  if (!frame.particles.length) return;
  context.save();
  context.globalCompositeOperation = 'lighter';
  for (const particle of frame.particles) {
    const x = centerX + particle.x * side;
    const y = centerY + particle.y * side;
    const radius = Math.max(1.25, particle.radius * side);
    const particleFill = context.createRadialGradient(x, y, 0, x, y, radius * 2.8);
    particleFill.addColorStop(0, `rgba(255, 255, 238, ${Math.min(1, particle.alpha + 0.28)})`);
    particleFill.addColorStop(0.3, `rgba(${palette.glow}, ${particle.alpha})`);
    particleFill.addColorStop(1, `rgba(${palette.glow}, 0)`);
    context.fillStyle = particleFill;
    context.beginPath();
    context.arc(x, y, radius * 2.8, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function traceSmoothVoiceOrbPath(context, points, centerX, centerY, scale) {
  if (!points.length) return;
  const first = points[0];
  const last = points.at(-1);
  context.beginPath();
  context.moveTo(
    centerX + ((last.x + first.x) / 2) * scale,
    centerY + ((last.y + first.y) / 2) * scale,
  );
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    context.quadraticCurveTo(
      centerX + current.x * scale,
      centerY + current.y * scale,
      centerX + ((current.x + next.x) / 2) * scale,
      centerY + ((current.y + next.y) / 2) * scale,
    );
  }
  context.closePath();
}

function compactVisibleAnswer(value) {
  const clean = String(value || '')
    .replace(/```[\s\S]*?```/g, ' фрагмент кода ')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/[*_#>`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 260 ? `${clean.slice(0, 257).trimEnd()}…` : clean;
}

export function readableVoiceError(value) {
  const original = String(value?.message || value || 'Голосовой режим временно недоступен')
    .replace(/\s+/g, ' ')
    .trim();
  const text = String(value?.message || value || '').toLowerCase();
  if (text.includes('busy')) return 'Oscar уже занят другим ответом';
  if (text.includes('attachment')) return 'Сначала убери вложение из текстового чата';
  if (/(?:microphone|микрофон|getusermedia|mediarecorder|notallowederror)/u.test(text)) return 'Нет доступа к микрофону';
  if (/(?:permission|denied|approval|confirmation-required|blocked by policy)/u.test(text)) {
    return 'Действие заблокировано текущим профилем доступа';
  }
  if (/(?:weather provider|voice weather|open-meteo|network|сеть|погод)/u.test(text)) {
    return 'Не удалось получить актуальные данные. Попробуй ещё раз чуть позже';
  }
  if (text.includes('route')) return 'Voice router временно недоступен';
  return original.slice(0, 180);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

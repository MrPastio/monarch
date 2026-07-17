import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { normalizeRussianSpeechText } from './russian-speech-normalizer.mjs';

export const MAX_SPEECH_TEXT_CHARS = 64_000;
const DEFAULT_NEURAL_READY_TIMEOUT_MS = 45_000;
const DEFAULT_NEURAL_START_TIMEOUT_MS = 6_000;
const DEFAULT_NEURAL_COMPLETION_TIMEOUT_MS = 120_000;
const DEFAULT_NEURAL_QUARANTINE_TIMEOUT_MS = 1_500;
const DEFAULT_FALLBACK_TIMEOUT_MS = 120_000;
const SPEECH_VOICES = new Set(['oscar', 'oscar-clear', 'aurora']);
const SPEECH_STYLES = new Set(['natural', 'calm', 'warm', 'focused', 'energetic']);

export function resolveNeuralCompletionTimeoutMs(textLength, configuredTimeoutMs = DEFAULT_NEURAL_COMPLETION_TIMEOUT_MS) {
  const configured = Math.max(
    20_000,
    Number(configuredTimeoutMs) || DEFAULT_NEURAL_COMPLETION_TIMEOUT_MS,
  );
  const adaptive = Math.max(20_000, Math.max(1, Number(textLength) || 0) * 400);
  return Math.max(configured, adaptive);
}

export function createWindowsSpeechOutput({
  workspaceRoot,
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  programFiles = process.env.ProgramFiles,
  pathValue = process.env.Path,
  spawnProcess = spawn,
  fileExists = existsSync,
  enableNeural = true,
  neuralReadyTimeoutMs = DEFAULT_NEURAL_READY_TIMEOUT_MS,
  neuralStartTimeoutMs = DEFAULT_NEURAL_START_TIMEOUT_MS,
  neuralCompletionTimeoutMs = DEFAULT_NEURAL_COMPLETION_TIMEOUT_MS,
  neuralQuarantineTimeoutMs = DEFAULT_NEURAL_QUARANTINE_TIMEOUT_MS,
  fallbackTimeoutMs = DEFAULT_FALLBACK_TIMEOUT_MS,
  onTelemetry = () => {},
} = {}) {
  const root = String(workspaceRoot || '');
  const neuralPythonPath = path.join(root, 'runtime', 'voice', '.venv', 'Scripts', 'python.exe');
  const neuralWorkerPath = path.join(root, 'tools', 'local-neural-tts.py');
  const neuralModelPath = path.join(root, 'runtime', 'voice', 'models', 'qwen3-tts-0.6b-base');
  const neuralReferencePath = path.join(root, 'assets', 'voice', 'oscar-reference.wav');
  const neuralCachePath = path.join(root, 'runtime', 'voice', 'hf-cache');
  const fallbackWorkerPath = path.join(root, 'tools', 'local-windows-tts.ps1');

  let neural = null;
  let active = null;
  let generation = 0;
  let requestSequence = 0;
  let disposed = false;

  const settleActive = (record, result) => {
    if (!record || record.settled) return;
    record.settled = true;
    if (record.startTimer) clearTimeout(record.startTimer);
    if (record.completionTimer) clearTimeout(record.completionTimer);
    if (record.fallbackTimer) clearTimeout(record.fallbackTimer);
    if (active === record) active = null;
    record.resolve(result);
  };

  const stop = () => {
    generation += 1;
    const current = active;
    active = null;
    if (!current) return false;
    if (current.kind === 'neural') {
      sendWorkerMessage(current.worker, { type: 'stop', id: current.id });
    } else if (current.child && !current.child.killed) {
      try { current.child.kill(); } catch { /* process already stopped */ }
    }
    settleActive(current, {
      ok: true,
      cancelled: true,
      engine: current.kind === 'neural' ? 'qwen3-tts-cuda-graph' : 'windows-sapi',
    });
    return true;
  };

  const speak = async (input) => {
    let request;
    try {
      request = normalizeSpeechRequest(input);
    } catch (error) {
      return {
        ok: false,
        error: 'speech-input-invalid',
        summary: error instanceof Error ? error.message : String(error),
      };
    }
    if (platform !== 'win32') {
      return { ok: false, error: 'speech-platform-unsupported', summary: 'Локальный desktop TTS недоступен на этой платформе.' };
    }
    if (disposed) {
      return { ok: false, error: 'speech-output-disposed', summary: 'Локальный TTS уже остановлен.' };
    }

    stop();
    const runId = ++generation;

    // A loading neural worker is not a failure. Await the single shared
    // readiness promise so Qwen remains the primary voice even for the first
    // turn; SAPI is reserved for an actual startup/playback failure or timeout.
    const neuralResult = await speakNeural(request, runId);
    if (neuralResult.ok || neuralResult.cancelled || neuralResult.playbackStarted || runId !== generation) {
      return runId !== generation ? { ok: true, cancelled: true, engine: 'qwen3-tts-cuda-graph' } : neuralResult;
    }

    const fallbackResult = await speakFallback(request, runId);
    if (fallbackResult.ok || fallbackResult.cancelled) {
      return {
        ...fallbackResult,
        fallback: true,
        fallbackFrom: neuralResult.error || 'neural-tts-unavailable',
      };
    }
    return {
      ...fallbackResult,
      summary: [neuralResult.summary, fallbackResult.summary].filter(Boolean).join(' ').slice(0, 800),
      neuralError: neuralResult.error,
    };
  };

  const speakNeural = async (request, runId) => {
    const readiness = await ensureNeuralWorker();
    if (runId !== generation) return { ok: true, cancelled: true, engine: 'qwen3-tts-cuda-graph' };
    if (!readiness.ok) return readiness;
    const worker = neural;
    if (!worker || worker.status !== 'ready') {
      return { ok: false, error: 'neural-tts-not-ready', summary: 'Нейросетевой TTS не перешёл в ready-состояние.' };
    }

    return new Promise((resolve) => {
      const id = `speech-${Date.now()}-${++requestSequence}`;
      const record = {
        kind: 'neural',
        id,
        runId,
        worker,
        resolve,
        settled: false,
        textLength: request.text.length,
        playbackStarted: false,
        startTimer: null,
        completionTimer: null,
      };
      active = record;
      if (!sendWorkerMessage(worker, { type: 'speak', id, ...request })) {
        quarantineNeuralWorker(worker, id);
        settleActive(record, {
          ok: false,
          error: 'neural-tts-write-failed',
          summary: 'Не удалось передать ответ прогретому TTS-worker.',
        });
        return;
      }
      record.startTimer = setTimeout(() => {
        quarantineNeuralWorker(worker, id);
        settleActive(record, {
          ok: false,
          error: 'neural-tts-start-timeout',
          summary: 'Нейросетевой голос не начал воспроизведение вовремя.',
        });
      }, Math.max(500, Number(neuralStartTimeoutMs) || DEFAULT_NEURAL_START_TIMEOUT_MS));
      record.startTimer.unref?.();
    });
  };

  const ensureNeuralWorker = () => {
    if (!enableNeural) {
      return Promise.resolve({ ok: false, error: 'neural-tts-disabled', summary: 'Нейросетевой TTS отключён для этого запуска.' });
    }
    if (neural?.status === 'ready') return Promise.resolve({ ok: true, ...neural.details });
    if (neural?.status === 'loading') return neural.readyPromise;
    if (neural?.status === 'retirement-failed') {
      return Promise.resolve({
        ok: false,
        error: 'neural-tts-retirement-timeout',
        summary: 'Предыдущий Qwen TTS-worker не завершился; новый запуск заблокирован, чтобы не держать две CUDA-модели одновременно.',
      });
    }
    if (neural?.status === 'quarantined' || neural?.status === 'failed') {
      const retirement = neural.retirementPromise || quarantineNeuralWorker(neural);
      return retirement.then((safeToRestart) => safeToRestart
        ? ensureNeuralWorker()
        : ({
            ok: false,
            error: 'neural-tts-retirement-timeout',
            summary: 'Предыдущий Qwen TTS-worker не подтвердил завершение; повторный запуск отменён без перекрытия моделей.',
          }));
    }
    if (!fileExists(neuralPythonPath) || !fileExists(neuralWorkerPath) || !fileExists(neuralModelPath) || !fileExists(neuralReferencePath)) {
      return Promise.resolve({
        ok: false,
        error: 'neural-tts-runtime-missing',
        summary: 'Нейросетевой TTS не установлен. Запусти npm run voice:setup.',
      });
    }

    let child;
    try {
      child = spawnProcess(neuralPythonPath, ['-u', neuralWorkerPath], {
        cwd: root,
        env: {
          ...process.env,
          HF_HOME: neuralCachePath,
          HF_HUB_CACHE: path.join(neuralCachePath, 'hub'),
          HUGGINGFACE_HUB_CACHE: path.join(neuralCachePath, 'hub'),
          HF_HUB_OFFLINE: '1',
          MONARCH_TTS_MODEL_PATH: neuralModelPath,
          MONARCH_TTS_REFERENCE_AUDIO: neuralReferencePath,
          PYTHONUTF8: '1',
        },
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return Promise.resolve({
        ok: false,
        error: 'neural-tts-spawn-failed',
        summary: error instanceof Error ? error.message : String(error),
      });
    }

    let resolveReady;
    const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
    const state = {
      child,
      status: 'loading',
      details: {},
      stderr: '',
      readyPromise,
      resolveReady,
      readySettled: false,
      closed: false,
      lines: null,
      timer: null,
      quarantineTimer: null,
      forceRetirementTimer: null,
      retirementPromise: null,
      resolveRetirement: null,
      retirementSettled: false,
    };
    neural = state;
    state.lines = readline.createInterface({ input: child.stdout });
    state.lines.on('line', (line) => handleWorkerLine(state, line));
    child.stderr?.on('data', (chunk) => {
      state.stderr = appendBounded(state.stderr, chunk, 8_000);
    });
    child.once('error', (error) => {
      if (state.status !== 'quarantined') {
        failNeuralWorker(state, 'neural-tts-spawn-failed', error.message);
      }
    });
    child.once('close', (code, signal) => {
      state.closed = true;
      if (state.status === 'quarantined') {
        finishNeuralRetirement(state);
      } else if (state.status === 'retirement-failed') {
        if (state.quarantineTimer) clearTimeout(state.quarantineTimer);
        if (state.forceRetirementTimer) clearTimeout(state.forceRetirementTimer);
      } else {
        const summary = boundedWorkerError(state.stderr, code, signal);
        failNeuralWorker(state, 'neural-tts-worker-exit', summary);
      }
      state.lines?.close();
      if (neural === state) neural = null;
    });
    state.timer = setTimeout(() => {
      failNeuralWorker(state, 'neural-tts-ready-timeout', 'Нейросетевой TTS не успел прогреться за 45 секунд.');
    }, Math.max(1_000, Number(neuralReadyTimeoutMs) || DEFAULT_NEURAL_READY_TIMEOUT_MS));
    state.timer.unref?.();
    return readyPromise;
  };

  const handleWorkerLine = (state, line) => {
    let event;
    try {
      event = JSON.parse(String(line || '').trim());
    } catch {
      state.stderr = appendBounded(state.stderr, line, 8_000);
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (state.status === 'quarantined') return;
    if (event.type === 'ready') {
      if (state.status !== 'loading' || state.readySettled || state.closed) return;
      state.status = 'ready';
      state.details = event;
      finishNeuralReady(state, { ok: true, ...event });
      return;
    }
    if (event.type === 'fatal') {
      failNeuralWorker(state, event.error || 'neural-tts-startup-failed', event.summary || 'Нейросетевой TTS не запустился.');
      return;
    }
    const current = active;
    if (!current || current.kind !== 'neural' || current.worker !== state || current.id !== event.id) return;
    if (event.type === 'frame') {
      const telemetry = normalizeSpeechTelemetry(event);
      if (telemetry) {
        markNeuralPlaybackStarted(current);
        try { onTelemetry(telemetry); } catch { /* UI telemetry must never interrupt playback */ }
      }
    } else if (event.type === 'done') {
      if (!current.playbackStarted) {
        quarantineNeuralWorker(current.worker, current.id);
        settleActive(current, {
          ok: false,
          error: 'neural-tts-playback-frame-missing',
          summary: 'Нейросетевой worker завершил запрос без подтверждённого воспроизведения.',
        });
      } else {
        settleActive(current, { ok: true, ...event });
      }
    } else if (event.type === 'stopped') {
      settleActive(current, { ok: true, cancelled: true, engine: 'qwen3-tts-cuda-graph' });
    } else if (event.type === 'error') {
      quarantineNeuralWorker(current.worker, current.id);
      settleActive(current, {
        ok: false,
        engine: 'qwen3-tts-cuda-graph',
        error: event.error || 'neural-tts-failed',
        summary: event.summary || 'Нейросетевой TTS не смог озвучить ответ.',
        playbackStarted: current.playbackStarted,
        partial: current.playbackStarted,
      });
    }
  };

  const markNeuralPlaybackStarted = (record) => {
    record.playbackStarted = true;
    if (record.startTimer) {
      clearTimeout(record.startTimer);
      record.startTimer = null;
    }
    if (record.completionTimer || record.settled) return;
    const configuredLimit = Math.max(
      20_000,
      Number(neuralCompletionTimeoutMs) || DEFAULT_NEURAL_COMPLETION_TIMEOUT_MS,
    );
    const timeoutMs = resolveNeuralCompletionTimeoutMs(record.textLength, configuredLimit);
    record.completionTimer = setTimeout(() => {
      quarantineNeuralWorker(record.worker, record.id);
      settleActive(record, {
        ok: false,
        engine: 'qwen3-tts-cuda-graph',
        error: 'neural-tts-completion-timeout',
        summary: 'Нейросетевой голос начал ответ, но не завершил воспроизведение.',
        playbackStarted: true,
        partial: true,
      });
    }, timeoutMs);
    record.completionTimer.unref?.();
  };

  const finishNeuralReady = (state, result) => {
    if (state.readySettled) return;
    state.readySettled = true;
    if (state.timer) clearTimeout(state.timer);
    state.resolveReady(result);
  };

  const failNeuralWorker = (state, error, summary) => {
    if (state.status === 'quarantined') return;
    if (state.status !== 'ready') state.status = 'failed';
    finishNeuralReady(state, { ok: false, error, summary: String(summary || '').slice(0, 800) });
    const current = active;
    if (current?.kind === 'neural' && current.worker === state) {
      settleActive(current, {
        ok: false,
        engine: 'qwen3-tts-cuda-graph',
        error,
        summary: String(summary || '').slice(0, 800),
        playbackStarted: current.playbackStarted,
        partial: current.playbackStarted,
      });
    }
    quarantineNeuralWorker(state, current?.id);
  };

  const finishNeuralRetirement = (state, safeToRestart = true) => {
    if (!state || state.retirementSettled) return;
    state.retirementSettled = true;
    if (state.quarantineTimer) {
      clearTimeout(state.quarantineTimer);
      state.quarantineTimer = null;
    }
    if (state.forceRetirementTimer) {
      clearTimeout(state.forceRetirementTimer);
      state.forceRetirementTimer = null;
    }
    if (safeToRestart) {
      if (neural === state) neural = null;
    } else {
      state.status = 'retirement-failed';
    }
    state.resolveRetirement?.(safeToRestart);
  };

  const quarantineNeuralWorker = (state, requestId) => {
    if (!state) return Promise.resolve();
    if (state.status === 'quarantined' && state.retirementPromise) return state.retirementPromise;

    let resolveRetirement;
    state.retirementPromise = new Promise((resolve) => { resolveRetirement = resolve; });
    state.resolveRetirement = resolveRetirement;
    state.retirementSettled = false;
    state.status = 'quarantined';

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    sendWorkerMessage(state, { type: 'stop', id: requestId });
    sendWorkerMessage(state, { type: 'shutdown' });

    if (state.closed) {
      finishNeuralRetirement(state);
      return state.retirementPromise;
    }

    const retirementTimeoutMs = Math.max(
      50,
      Number(neuralQuarantineTimeoutMs) || DEFAULT_NEURAL_QUARANTINE_TIMEOUT_MS,
    );
    state.quarantineTimer = setTimeout(() => {
      state.quarantineTimer = null;
      if (state.closed) {
        finishNeuralRetirement(state);
        return;
      }
      if (!state.child?.killed) {
        try { state.child?.kill(); } catch { /* worker is already unavailable */ }
      }
      // `child.killed` only confirms signal delivery. Keep the retirement gate
      // closed for one more bounded interval. If `close` still never arrives,
      // fail closed: callers may use SAPI, but no second CUDA worker is spawned.
      state.forceRetirementTimer = setTimeout(() => {
        state.forceRetirementTimer = null;
        finishNeuralRetirement(state, false);
      }, retirementTimeoutMs);
      state.forceRetirementTimer.unref?.();
    }, retirementTimeoutMs);
    state.quarantineTimer.unref?.();

    return state.retirementPromise;
  };

  const speakFallback = (request, runId) => {
    if (runId !== generation) return Promise.resolve({ ok: true, cancelled: true, engine: 'windows-sapi' });
    if (!fileExists(fallbackWorkerPath)) {
      return Promise.resolve({ ok: false, error: 'speech-worker-missing', summary: 'Аварийный Windows TTS-worker не найден.' });
    }
    const executable = resolveWindowsPowerShell(systemRoot, programFiles, pathValue, fileExists);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawnProcess(executable, [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          fallbackWorkerPath,
        ], {
          cwd: root,
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ ok: false, error: 'speech-worker-spawn-failed', summary: error instanceof Error ? error.message : String(error) });
        return;
      }

      const record = { kind: 'fallback', child, runId, resolve, settled: false, fallbackTimer: null };
      active = record;
      child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, 4_000); });
      child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, 4_000); });
      child.once('error', (error) => {
        settleActive(record, { ok: false, error: 'speech-worker-spawn-failed', summary: error.message });
      });
      child.once('close', (code, signal) => {
        if (record.settled) return;
        if (runId !== generation) {
          settleActive(record, { ok: true, cancelled: true, engine: 'windows-sapi' });
        } else if (code === 0) {
          settleActive(record, { ok: true, engine: 'windows-sapi', ...readWorkerSummary(stdout) });
        } else {
          settleActive(record, { ok: false, error: 'speech-worker-exit', summary: boundedWorkerError(stderr, code, signal) });
        }
      });
      record.fallbackTimer = setTimeout(() => {
        settleActive(record, {
          ok: false,
          error: 'speech-fallback-timeout',
          summary: 'Аварийная Windows озвучка не завершилась вовремя.',
        });
        try { child.kill(); } catch { /* process already stopped */ }
      }, Math.max(50, Number(fallbackTimeoutMs) || DEFAULT_FALLBACK_TIMEOUT_MS));
      record.fallbackTimer.unref?.();
      child.stdin?.end(JSON.stringify(request), 'utf8');
    });
  };

  const warmup = () => {
    if (platform !== 'win32' || disposed) return Promise.resolve({ ok: false, error: 'speech-platform-unsupported' });
    return ensureNeuralWorker();
  };

  const releaseNeural = async () => {
    if (disposed) return { ok: false, released: false, error: 'speech-output-disposed', summary: 'Локальный TTS уже остановлен.' };
    const worker = neural;
    stop();
    if (!worker) return { ok: true, released: false };
    const retired = await quarantineNeuralWorker(worker);
    return retired
      ? { ok: true, released: true }
      : {
          ok: false,
          released: false,
          error: 'neural-tts-retirement-timeout',
          summary: 'TTS-worker не подтвердил освобождение памяти; запуск другой локальной модели остановлен.',
        };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    const worker = neural;
    neural = null;
    if (!worker?.child || worker.child.killed) return;
    sendWorkerMessage(worker, { type: 'shutdown' });
    const killTimer = setTimeout(() => {
      try { worker.child.kill(); } catch { /* process already stopped */ }
    }, 1_500);
    killTimer.unref?.();
  };

  return {
    speak,
    stop,
    warmup,
    releaseNeural,
    dispose,
    isSpeaking: () => Boolean(active && !active.settled),
    isNeuralReady: () => neural?.status === 'ready',
  };
}

export function createSpeechWarmupCoordinator({
  warmup,
  now = () => Date.now(),
  onDiagnostics = () => {},
} = {}) {
  if (typeof warmup !== 'function') throw new TypeError('Speech warmup coordinator requires a warmup function.');

  let sharedPromise = null;
  let attempts = 0;
  let snapshot = {
    status: 'idle',
    ok: false,
    engine: '',
    error: '',
    summary: '',
    elapsedMs: 0,
    attempt: 0,
  };

  const readNow = () => {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  };

  const publish = (next) => {
    snapshot = { ...next };
    try { onDiagnostics({ ...snapshot }); } catch { /* diagnostics must never break TTS startup */ }
    return { ...snapshot };
  };

  const start = ({ retry = false } = {}) => {
    if (sharedPromise) {
      const canRetry = retry === true && snapshot.status === 'failed' && attempts < 2;
      if (!canRetry) return sharedPromise;
      sharedPromise = null;
    }
    attempts += 1;
    const attempt = attempts;
    const startedAt = readNow();
    publish({
      status: 'loading',
      ok: false,
      engine: '',
      error: '',
      summary: '',
      elapsedMs: 0,
      attempt,
    });

    let warmupResult;
    try {
      // Invoke synchronously so the Qwen child is spawned before callers start
      // other local model runtimes. Resolution remains asynchronous and shared.
      warmupResult = warmup();
    } catch (error) {
      warmupResult = Promise.reject(error);
    }
    sharedPromise = Promise.resolve(warmupResult).then(
      (result) => publish({
        ...normalizeWarmupDiagnostics(result, Math.max(0, readNow() - startedAt)),
        attempt,
      }),
      (error) => publish({
        ...normalizeWarmupDiagnostics({
          ok: false,
          error: 'neural-tts-warmup-failed',
          summary: error instanceof Error ? error.message : String(error),
        }, Math.max(0, readNow() - startedAt)),
        attempt,
      }),
    );
    return sharedPromise;
  };

  return {
    start,
    retry: () => start({ retry: true }),
    reset: () => {
      sharedPromise = null;
      snapshot = {
        status: 'idle',
        ok: false,
        engine: '',
        error: '',
        summary: '',
        elapsedMs: 0,
        attempt: attempts,
      };
      return { ...snapshot };
    },
    snapshot: () => ({ ...snapshot }),
  };
}

function normalizeWarmupDiagnostics(input, elapsedMs) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const ok = value.ok === true;
  const bounded = (item, limit) => String(item || '').trim().replace(/\s+/g, ' ').slice(0, limit);
  return {
    status: ok ? 'ready' : 'failed',
    ok,
    engine: bounded(value.engine, 80),
    error: ok ? '' : bounded(value.error || 'neural-tts-warmup-failed', 120),
    summary: ok ? '' : bounded(value.summary || 'Нейросетевой TTS не прогрелся.', 800),
    elapsedMs: Math.max(0, Math.round(Number(elapsedMs) || 0)),
    ...(value.model ? { model: bounded(value.model, 160) } : {}),
    ...(value.device ? { device: bounded(value.device, 160) } : {}),
    ...(value.speaker ? { speaker: bounded(value.speaker, 120) } : {}),
    ...(Number.isFinite(Number(value.loadSeconds)) ? { loadSeconds: Number(value.loadSeconds) } : {}),
    ...(Number.isFinite(Number(value.warmupSeconds)) ? { warmupSeconds: Number(value.warmupSeconds) } : {}),
  };
}

export function normalizeSpeechTelemetry(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const id = String(value.id || '').trim().slice(0, 120);
  if (!id) return null;
  const requiredValues = [value.sequence, value.rms, value.peak, value.brightness, value.sampleRate];
  if (requiredValues.some((item) => item === '' || item === null || item === undefined || !Number.isFinite(Number(item)))) {
    return null;
  }
  const sequence = boundedSpeechInteger(value.sequence, 0, Number.MAX_SAFE_INTEGER, 0);
  const rms = boundedSpeechNumber(value.rms, 0, 1, 0);
  const peak = boundedSpeechNumber(value.peak, 0, 1, 0);
  const brightness = boundedSpeechNumber(value.brightness, 0, 1, 0);
  const sampleRate = boundedSpeechInteger(value.sampleRate, 8_000, 192_000, 24_000);
  return { id, sequence, rms, peak, brightness, sampleRate };
}

export function createSpeechDiagnosticRecord(kind, input, { now = () => new Date() } = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const bounded = (item, limit) => String(item || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const failureText = `${value.error || ''} ${value.summary || ''}`.toLowerCase();
  const failureSignal = /(?:os error 1455|error 1455|файл подкачки слишком мал)/u.test(failureText)
    ? 'windows-os-1455-pagefile-too-small'
    : '';
  let at;
  try {
    const valueNow = now();
    at = (valueNow instanceof Date ? valueNow : new Date(valueNow)).toISOString();
  } catch {
    at = new Date().toISOString();
  }
  return {
    at,
    event: `desktop.speech.${bounded(kind, 40)}`,
    ok: value.ok === true,
    status: bounded(value.status || (value.cancelled ? 'cancelled' : (value.ok === true ? 'done' : 'failed')), 40),
    engine: bounded(value.engine, 80),
    error: bounded(value.error, 120),
    failureSignal,
    fallback: value.fallback === true,
    fallbackFrom: bounded(value.fallbackFrom, 120),
    neuralError: bounded(value.neuralError, 120),
    playbackStarted: value.playbackStarted === true,
    partial: value.partial === true,
    ...(Number.isFinite(Number(value.attempt)) ? { attempt: Number(value.attempt) } : {}),
    ...(Number.isFinite(Number(value.elapsedMs)) ? { elapsedMs: Number(value.elapsedMs) } : {}),
    ...(Number.isFinite(Number(value.loadSeconds)) ? { loadSeconds: Number(value.loadSeconds) } : {}),
    ...(Number.isFinite(Number(value.warmupSeconds)) ? { warmupSeconds: Number(value.warmupSeconds) } : {}),
    ...(Number.isFinite(Number(value.ttfaSeconds)) ? { ttfaSeconds: Number(value.ttfaSeconds) } : {}),
    ...(Number.isFinite(Number(value.generationSeconds)) ? { generationSeconds: Number(value.generationSeconds) } : {}),
    ...(Number.isFinite(Number(value.audioSeconds)) ? { audioSeconds: Number(value.audioSeconds) } : {}),
    ...(Number.isFinite(Number(value.speedX)) ? { speedX: Number(value.speedX) } : {}),
  };
}

export function normalizeSpeechRequest(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sourceText = String(value.text || '').trim();
  if (!sourceText) throw new Error('Нет текста для озвучки.');
  if (sourceText.length > MAX_SPEECH_TEXT_CHARS) throw new Error('Ответ слишком длинный для одного локального сеанса озвучки.');
  const language = normalizeSpeechLanguage(value.language);
  const text = language === 'ru-RU' ? normalizeRussianSpeechText(sourceText) : sourceText;
  if (text.length > MAX_SPEECH_TEXT_CHARS) throw new Error('Нормализованный ответ слишком длинный для одного локального сеанса озвучки.');
  const voice = normalizeSpeechOption(value.voice, SPEECH_VOICES, 'oscar');
  const style = normalizeSpeechOption(value.style, SPEECH_STYLES, 'natural');
  const legacySpeed = value.pace === 'slow' ? 90 : value.pace === 'fast' ? 112 : 100;
  const speed = boundedSpeechInteger(value.speed, 80, 120, legacySpeed);
  const pitch = boundedSpeechInteger(value.pitch, -2, 2, 0);
  const expressiveness = boundedSpeechInteger(value.expressiveness, 0, 100, 55);
  const pauseMs = boundedSpeechInteger(value.pauseMs, 40, 400, 80);
  const volume = boundedSpeechInteger(value.volume, 20, 100, 100);
  const pace = speed < 96 ? 'slow' : speed > 104 ? 'fast' : 'normal';
  const fallbackRate = speed <= 88 ? -2 : speed < 98 ? -1 : speed >= 114 ? 2 : speed > 102 ? 1 : 0;
  const rate = Math.max(-2, Math.min(2, Math.round(Number(value.rate) || fallbackRate)));
  const instruction = String(value.instruction || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, 300);
  return { text, language, rate, voice, style, pace, speed, pitch, expressiveness, pauseMs, volume, instruction };
}

function normalizeSpeechOption(value, allowed, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function boundedSpeechInteger(value, minimum, maximum, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function boundedSpeechNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, numeric));
}

export function normalizeSpeechLanguage(value) {
  const prefix = String(value || 'ru-RU').trim().toLowerCase().split(/[-_]/, 1)[0];
  switch (prefix) {
  case 'uk': return 'uk-UA';
  case 'bg': return 'bg-BG';
  case 'en': return 'en-US';
  case 'ru':
  default:
    return 'ru-RU';
  }
}

export function resolveWindowsPowerShell(systemRoot = '', programFiles = '', pathValue = '', fileExists = existsSync) {
  const modern = path.join(String(programFiles || 'C:\\Program Files'), 'PowerShell', '7', 'pwsh.exe');
  if (fileExists(modern)) return modern;
  for (const directory of String(pathValue || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, 'pwsh.exe');
    if (fileExists(candidate)) return candidate;
  }
  const candidate = path.join(String(systemRoot || 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fileExists(candidate) ? candidate : 'powershell.exe';
}

function sendWorkerMessage(worker, payload) {
  if (!worker?.child?.stdin || worker.child.killed || worker.closed) return false;
  try {
    worker.child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function appendBounded(current, chunk, limit) {
  return `${current}${String(chunk ?? '')}`.slice(-limit);
}

function readWorkerSummary(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Ignore bounded worker diagnostics that are not JSON.
    }
  }
  return {};
}

function boundedWorkerError(stderr, code, signal) {
  const detail = String(stderr || '').trim().replace(/\s+/g, ' ').slice(0, 600);
  return detail || `Локальный TTS завершился с кодом ${code ?? signal ?? 'unknown'}.`;
}

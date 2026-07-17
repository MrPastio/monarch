import {
  cancelVoicePcmTranscription,
  finishVoicePcmTranscription,
  pushVoicePcmTranscription,
  startVoicePcmTranscription,
} from './api.js';

const PCM_BATCH_MS = 120;
const MAX_QUEUED_PCM_BYTES = 512 * 1024;
const MAX_TOTAL_PCM_BYTES = 3 * 1024 * 1024;
const FLUSH_TIMEOUT_MS = 80;

export function canUseDirectVoicePcm(win = typeof window !== 'undefined' ? window : null) {
  const AudioContextCtor = win?.AudioContext || win?.webkitAudioContext;
  return Boolean(
    AudioContextCtor
      && win?.AudioWorkletNode
      && win?.navigator?.mediaDevices?.getUserMedia,
  );
}

export async function createVoicePcmStream(options = {}) {
  const win = options.windowObject || (typeof window !== 'undefined' ? window : null);
  if (!canUseDirectVoicePcm(win) || !options.mediaStream) return null;

  const AudioContextCtor = win.AudioContext || win.webkitAudioContext;
  const context = new AudioContextCtor({ latencyHint: 'interactive' });
  let source = null;
  let node = null;
  let gain = null;
  try {
    await context.audioWorklet.addModule(
      options.processorUrl || new URL('./voice-pcm-processor.js', import.meta.url).toString(),
    );
    source = context.createMediaStreamSource(options.mediaStream);
    node = new win.AudioWorkletNode(context, 'monarch-voice-pcm', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: { batchMs: PCM_BATCH_MS },
    });
    gain = context.createGain();
    gain.gain.value = 0;
    source.connect(node);
    node.connect(gain);
    gain.connect(context.destination);
    await context.resume?.();
  } catch (error) {
    disconnect(source);
    disconnect(node);
    disconnect(gain);
    await context.close?.().catch?.(() => undefined);
    throw error;
  }

  const api = {
    start: options.startSession || startVoicePcmTranscription,
    push: options.pushSession || pushVoicePcmTranscription,
    finish: options.finishSession || finishVoicePcmTranscription,
    cancel: options.cancelSession || cancelVoicePcmTranscription,
  };
  const sampleRate = Math.round(Number(context.sampleRate) || 0);
  let sequence = 0;
  let queuedBytes = 0;
  let totalBytes = 0;
  let stopped = false;
  let finalizing = false;
  let failure = null;
  let remoteSessionId = '';
  let lastPartial = '';
  let lastPartialAt = 0;
  let pushTail = Promise.resolve();

  const startPromise = Promise.resolve(api.start({
    language: options.language || 'ru-RU',
    sampleRate,
  })).then((result) => {
    remoteSessionId = typeof result?.sessionId === 'string' ? result.sessionId : '';
    if (!remoteSessionId) throw new Error('Streaming STT не вернул session id.');
    emitTelemetry('started', result);
    return result;
  }).catch((error) => {
    markFailure(error);
    throw error;
  });
  void startPromise.catch(() => undefined);

  node.port.onmessage = (event) => {
    if (event.data?.type !== 'pcm' || stopped) return;
    const pcm = event.data.pcm;
    if (!(pcm instanceof ArrayBuffer) || !pcm.byteLength) return;
    enqueuePcm(pcm);
  };

  return Object.freeze({
    sampleRate,
    stop,
    cancel,
    snapshot,
  });

  function enqueuePcm(pcm) {
    if (failure || stopped) return;
    const bytes = pcm.byteLength;
    if (bytes > 64 * 1024
      || queuedBytes + bytes > MAX_QUEUED_PCM_BYTES
      || totalBytes + bytes > MAX_TOTAL_PCM_BYTES) {
      markFailure(Object.assign(new Error('Очередь streaming PCM переполнена.'), {
        code: 'voice-stt-queue-overflow',
      }));
      void cancelRemote();
      return;
    }
    const batchSequence = sequence;
    sequence += 1;
    queuedBytes += bytes;
    totalBytes += bytes;
    const pcmBase64 = arrayBufferToBase64(pcm);
    pushTail = pushTail.then(async () => {
      if (failure) return;
      const started = await startPromise;
      const result = await api.push({
        sessionId: started.sessionId,
        sequence: batchSequence,
        pcmBase64,
      });
      const partial = typeof result?.partial === 'string' ? result.partial.trim() : '';
      if (partial) {
        lastPartial = partial;
        lastPartialAt = Date.now();
      }
      emitTelemetry('partial', {
        sequence: batchSequence,
        processingMs: result?.processingMs,
        audioMs: result?.audioMs,
        partialLength: partial.length,
        partialAgeMs: lastPartialAt ? Date.now() - lastPartialAt : null,
        enginePath: result?.enginePath,
      });
    }).catch((error) => {
      markFailure(error);
      void cancelRemote();
    }).finally(() => {
      queuedBytes = Math.max(0, queuedBytes - bytes);
    });
  }

  async function stop(captureStoppedAtEpochMs = Date.now()) {
    if (finalizing) throw new Error('Streaming STT уже завершается.');
    finalizing = true;
    await flushNode(node, FLUSH_TIMEOUT_MS);
    stopped = true;
    disposeGraph();
    await pushTail;
    if (failure) throw failure;
    const started = await startPromise;
    const result = await api.finish({
      sessionId: started.sessionId,
      captureStoppedAtEpochMs,
    });
    const transcript = typeof result?.transcript === 'string' ? result.transcript.trim() : '';
    emitTelemetry('final', {
      enginePath: result?.enginePath,
      captureStopToFinalMs: result?.captureStopToFinalMs,
      finalizeMs: result?.finalizeMs,
      partialAgeMs: result?.partialAgeMs,
      transcriptLength: transcript.length,
    });
    return { ...result, transcript };
  }

  function cancel() {
    if (stopped && !finalizing) return Promise.resolve();
    stopped = true;
    finalizing = false;
    disposeGraph();
    return cancelRemote();
  }

  async function cancelRemote() {
    const sessionId = remoteSessionId || await startPromise.then((value) => value.sessionId).catch(() => '');
    if (!sessionId) return;
    await api.cancel({ sessionId }).catch(() => undefined);
  }

  function disposeGraph() {
    try { node?.port?.postMessage?.({ type: 'close' }); } catch {}
    disconnect(source);
    disconnect(node);
    disconnect(gain);
    void context.close?.().catch?.(() => undefined);
    source = null;
    node = null;
    gain = null;
  }

  function markFailure(error) {
    if (!failure) failure = error instanceof Error ? error : new Error(String(error));
  }

  function emitTelemetry(type, values = {}) {
    options.onTelemetry?.({ type, ...values });
  }

  function snapshot() {
    return Object.freeze({
      sampleRate,
      sequence,
      queuedBytes,
      totalBytes,
      stopped,
      failed: Boolean(failure),
      lastPartialLength: lastPartial.length,
      partialAgeMs: lastPartialAt ? Date.now() - lastPartialAt : null,
    });
  }
}

function flushNode(node, timeoutMs) {
  if (!node?.port) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      node.port.removeEventListener?.('message', onMessage);
      resolve();
    };
    const onMessage = (event) => {
      if (event.data?.type === 'flushed') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    node.port.addEventListener?.('message', onMessage);
    node.port.start?.();
    try { node.port.postMessage({ type: 'flush' }); } catch { finish(); }
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const block = 0x8000;
  for (let index = 0; index < bytes.length; index += block) {
    binary += String.fromCharCode(...bytes.subarray(index, index + block));
  }
  return btoa(binary);
}

function disconnect(node) {
  try { node?.disconnect?.(); } catch {}
}

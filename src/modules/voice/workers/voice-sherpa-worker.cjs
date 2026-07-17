'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const MAX_STREAMS = 4;
const MAX_PCM_BYTES = 3 * 1024 * 1024;
const MAX_DURATION_SECONDS = 30;
const MAX_BATCH_BYTES = 64 * 1024;
const FINAL_SILENCE_MS = 320;
const STREAM_TTL_MS = readBoundedInteger(process.env.MONARCH_STT_STREAM_TTL_MS, 45_000, 100, 120_000);

let recognizer = null;
let modelDir = '';
let modelLoadMs = 0;
const streams = new Map();

class WorkerFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function findModelDir() {
  const configured = String(process.env.MONARCH_SHERPA_MODEL_DIR || '').trim();
  const candidates = configured
    ? [path.resolve(configured)]
    : [
        path.resolve(process.cwd(), 'runtime', 'voice', 'models', 'sherpa-onnx-streaming-t-one-russian-2025-09-08'),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'model.onnx'))
      && fs.existsSync(path.join(candidate, 'tokens.txt'))) {
      return candidate;
    }
  }
  throw new WorkerFailure(
    'voice-stt-language-unavailable',
    'Локальная streaming T-one модель не найдена. Запусти npm run voice:stt:setup.',
  );
}

function ensureRecognizer(language) {
  if (!/^ru(?:-|$)/i.test(String(language || ''))) {
    throw new WorkerFailure(
      'voice-stt-language-unsupported',
      'Streaming T-one поддерживает только русский язык.',
    );
  }
  const candidate = findModelDir();
  if (recognizer && candidate === modelDir) return 0;
  if (streams.size > 0) {
    throw new WorkerFailure('voice-stt-stream-busy', 'Нельзя менять T-one модель при активной записи.');
  }
  let sherpa;
  try {
    sherpa = require('sherpa-onnx-node');
  } catch (error) {
    throw new WorkerFailure(
      'voice-stt-runtime-missing',
      `Optional sherpa-onnx-node runtime недоступен: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const startedAt = performance.now();
  try {
    recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 8000, featureDim: 80 },
      modelConfig: {
        toneCtc: { model: path.join(candidate, 'model.onnx') },
        tokens: path.join(candidate, 'tokens.txt'),
        numThreads: readThreadCount(),
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: 0,
    });
  } catch (error) {
    recognizer = null;
    throw new WorkerFailure(
      'voice-stt-model-load-failed',
      `T-one не смог загрузить модель: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  modelDir = candidate;
  modelLoadMs = elapsedMs(startedAt);
  return modelLoadMs;
}

function startStream(request) {
  const streamId = readStreamId(request.streamId);
  if (streams.has(streamId)) throw new WorkerFailure('voice-stt-stream-conflict', 'STT stream уже существует.');
  if (streams.size >= MAX_STREAMS) throw new WorkerFailure('voice-stt-stream-limit', 'Слишком много STT streams.');
  const sampleRate = readSampleRate(request.sampleRate);
  const loadMs = ensureRecognizer(request.language);
  const stream = recognizer.createStream();
  const timer = setTimeout(() => {
    streams.delete(streamId);
  }, STREAM_TTL_MS);
  timer.unref();
  streams.set(streamId, {
    stream,
    timer,
    sampleRate,
    sequence: 0,
    bytes: 0,
    frames: 0,
    decodeMs: 0,
    startedAt: performance.now(),
    lastPartialAt: null,
    partial: '',
  });
  return {
    engine: 'sherpa-onnx-t-one',
    model: path.basename(modelDir),
    sampleRate,
    loadMs,
    warm: loadMs === 0,
    pid: process.pid,
  };
}

function pushStream(request) {
  const streamId = readStreamId(request.streamId);
  const state = streams.get(streamId);
  if (!state) throw new WorkerFailure('voice-stt-stream-not-found', 'STT stream не найден.');
  const sequence = readSequence(request.sequence);
  if (sequence !== state.sequence) {
    throw new WorkerFailure('voice-stt-stream-sequence', 'Нарушена последовательность PCM batches.');
  }
  const pcm = readPcm(request.pcmBase64);
  const nextBytes = state.bytes + pcm.byteLength;
  const nextFrames = state.frames + pcm.byteLength / 2;
  if (nextBytes > MAX_PCM_BYTES) throw new WorkerFailure('voice-stt-stream-too-large', 'PCM stream превысил лимит.');
  if (nextFrames > state.sampleRate * MAX_DURATION_SECONDS) {
    throw new WorkerFailure('voice-stt-stream-too-long', 'PCM stream превысил лимит длительности.');
  }

  const startedAt = performance.now();
  state.stream.acceptWaveform({ samples: pcm16ToFloat32(pcm), sampleRate: state.sampleRate });
  decodeReady(state.stream);
  const processingMs = elapsedMs(startedAt);
  const partial = sanitizeText(recognizer.getResult(state.stream)?.text);
  state.sequence += 1;
  state.bytes = nextBytes;
  state.frames = nextFrames;
  state.decodeMs += processingMs;
  state.partial = partial;
  if (partial) state.lastPartialAt = performance.now();
  return {
    engine: 'sherpa-onnx-t-one',
    sequence,
    partial,
    processingMs,
    audioMs: Math.round(nextFrames * 1000 / state.sampleRate),
    pid: process.pid,
  };
}

function finishStream(request) {
  const streamId = readStreamId(request.streamId);
  const state = streams.get(streamId);
  if (!state) throw new WorkerFailure('voice-stt-stream-not-found', 'STT stream не найден.');
  streams.delete(streamId);
  clearTimeout(state.timer);
  const startedAt = performance.now();
  const silenceFrames = Math.round(state.sampleRate * FINAL_SILENCE_MS / 1000);
  state.stream.acceptWaveform({ samples: new Float32Array(silenceFrames), sampleRate: state.sampleRate });
  decodeReady(state.stream);
  state.stream.inputFinished();
  decodeReady(state.stream);
  const text = sanitizeText(recognizer.getResult(state.stream)?.text);
  const finalizeMs = elapsedMs(startedAt);
  return {
    text,
    engine: 'sherpa-onnx-t-one',
    model: path.basename(modelDir),
    recognitionMs: state.decodeMs,
    finalizeMs,
    audioMs: Math.round(state.frames * 1000 / state.sampleRate),
    bytes: state.bytes,
    partialAgeMs: state.lastPartialAt === null ? null : elapsedMs(state.lastPartialAt),
    pid: process.pid,
  };
}

function decodeReady(stream) {
  let iterations = 0;
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
    iterations += 1;
    if (iterations > 512) {
      throw new WorkerFailure('voice-stt-decode-limit', 'T-one decode loop превысил безопасный предел.');
    }
  }
}

function parseRequest(line) {
  let value;
  try { value = JSON.parse(line); } catch {
    throw new WorkerFailure('voice-stt-protocol-error', 'Worker получил повреждённый JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerFailure('voice-stt-protocol-error', 'Worker request должен быть object.');
  }
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 160) {
    throw new WorkerFailure('voice-stt-protocol-error', 'Worker request id некорректен.');
  }
  const allowed = new Set(['prepare', 'stream-start', 'stream-push', 'stream-finish', 'stream-cancel', 'shutdown']);
  if (!allowed.has(value.type)) throw new WorkerFailure('voice-stt-protocol-error', 'Worker request type некорректен.');
  return value;
}

function readStreamId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(value)) {
    throw new WorkerFailure('voice-stt-protocol-error', 'STT stream id некорректен.');
  }
  return value;
}

function readSampleRate(value) {
  if (!Number.isInteger(value) || value < 8000 || value > 48000) {
    throw new WorkerFailure('voice-stt-stream-rate-invalid', 'PCM sample rate некорректен.');
  }
  return value;
}

function readSequence(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new WorkerFailure('voice-stt-stream-sequence', 'PCM sequence некорректен.');
  }
  return value;
}

function readPcm(value) {
  if (typeof value !== 'string' || !value || value.length > 96 * 1024) {
    throw new WorkerFailure('voice-stt-stream-pcm-invalid', 'PCM batch некорректен.');
  }
  const pcm = Buffer.from(value, 'base64');
  if (!pcm.byteLength || pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_BATCH_BYTES
    || pcm.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new WorkerFailure('voice-stt-stream-pcm-invalid', 'PCM batch некорректен.');
  }
  return pcm;
}

function pcm16ToFloat32(buffer) {
  const samples = new Float32Array(buffer.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = buffer.readInt16LE(index * 2);
    samples[index] = value < 0 ? value / 32768 : value / 32767;
  }
  return samples;
}

function sanitizeText(value) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function readThreadCount() {
  const value = Number.parseInt(process.env.MONARCH_SHERPA_THREADS || '4', 10);
  return Number.isFinite(value) ? Math.min(8, Math.max(1, value)) : 4;
}

function readBoundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let id = '';
  try {
    const request = parseRequest(line);
    id = request.id.trim();
    if (request.type === 'shutdown') {
      for (const state of streams.values()) clearTimeout(state.timer);
      streams.clear();
      emit({ id, type: 'stopped', pid: process.pid });
      input.close();
      return;
    }
    if (request.type === 'prepare') {
      const loadMs = ensureRecognizer(request.language);
      emit({
        id,
        type: 'ready',
        engine: 'sherpa-onnx-t-one',
        model: path.basename(modelDir),
        loadMs,
        warm: loadMs === 0,
        pid: process.pid,
      });
      return;
    }
    if (request.type === 'stream-start') {
      emit({ id, type: 'stream-started', ...startStream(request) });
      return;
    }
    if (request.type === 'stream-push') {
      emit({ id, type: 'stream-partial', ...pushStream(request) });
      return;
    }
    if (request.type === 'stream-finish') {
      emit({ id, type: 'stream-final', ...finishStream(request) });
      return;
    }
    const streamId = readStreamId(request.streamId);
    const state = streams.get(streamId);
    if (state) clearTimeout(state.timer);
    const cancelled = streams.delete(streamId);
    emit({ id, type: 'stream-cancelled', cancelled, pid: process.pid });
  } catch (error) {
    emit({
      id,
      type: 'error',
      code: error instanceof WorkerFailure ? error.code : 'voice-stt-worker-error',
      message: String(error instanceof Error ? error.message : error).slice(0, 500),
    });
  }
});

input.on('close', () => {
  for (const state of streams.values()) clearTimeout(state.timer);
  streams.clear();
  process.exitCode = 0;
});

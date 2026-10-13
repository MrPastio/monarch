import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  VoiceSttRuntime,
  VoiceSttRuntimeError,
} from '../../src/modules/voice/voice-stt-runtime';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => (
    rm(target, { recursive: true, force: true }).catch(() => undefined)
  )));
});

describe('VoiceSttRuntime', () => {
  it('keeps one worker alive and reuses its warm model across utterances', async () => {
    const worker = await writeFakeWorker();
    const audioRoot = await mkdtemp(path.join(os.tmpdir(), 'monarch-voice-stt-test-'));
    cleanupPaths.push(audioRoot);
    const audioPath = path.join(audioRoot, 'voice.webm');
    await writeFile(audioPath, 'voice-data', 'utf8');

    const runtime = new VoiceSttRuntime({
      workspaceRoot: process.cwd(),
      executable: process.execPath,
      workerScriptPath: worker.scriptPath,
      audioRoot,
      requestTimeoutMs: 2_000,
    });
    try {
      const prepared = await runtime.prepare('ru-RU');
      const first = await runtime.transcribe({ audioPath, language: 'ru-RU' });
      const second = await runtime.transcribe({ audioPath, language: 'ru-RU' });

      expect(prepared).toMatchObject({
        status: 'ready',
        engine: 'vosk',
        model: 'fake-vosk-ru',
        loadMs: 120,
        warm: false,
      });
      expect(first).toMatchObject({
        text: 'локальный текст 1',
        pid: prepared.pid,
        loadMs: 0,
        warm: true,
        conversionMs: 12,
        recognitionMs: 34,
        totalMs: 46,
      });
      expect(second).toMatchObject({
        text: 'локальный текст 2',
        pid: prepared.pid,
        warm: true,
      });
      expect(runtime.snapshot()).toMatchObject({
        state: 'ready',
        engine: 'vosk',
        model: 'fake-vosk-ru',
        pid: prepared.pid,
        loadMs: 120,
      });
    } finally {
      await runtime.shutdown();
    }
    expect(runtime.snapshot()).toMatchObject({ state: 'idle' });
  });

  it('preserves stable worker errors and blocks audio outside its temporary root', async () => {
    const worker = await writeFakeWorker();
    const audioRoot = await mkdtemp(path.join(os.tmpdir(), 'monarch-voice-stt-test-'));
    cleanupPaths.push(audioRoot);
    const audioPath = path.join(audioRoot, 'voice.webm');
    await writeFile(audioPath, 'voice-data', 'utf8');
    const runtime = new VoiceSttRuntime({
      workspaceRoot: process.cwd(),
      executable: process.execPath,
      workerScriptPath: worker.scriptPath,
      audioRoot,
      requestTimeoutMs: 2_000,
    });
    try {
      await expect(runtime.transcribe({ audioPath, language: 'uk-UA' })).rejects.toMatchObject({
        code: 'voice-stt-language-unavailable',
      });
      expect(() => runtime.transcribe({
        audioPath: path.join(process.cwd(), 'package.json'),
        language: 'ru-RU',
      })).toThrowError(VoiceSttRuntimeError);
    } finally {
      await runtime.shutdown();
    }
  });

  it('cancels an active one-shot transcription and restarts the worker cleanly', async () => {
    const worker = await writeFakeWorker();
    const audioRoot = await mkdtemp(path.join(os.tmpdir(), 'monarch-voice-stt-cancel-'));
    cleanupPaths.push(audioRoot);
    const audioPath = path.join(audioRoot, 'voice.ogg');
    await writeFile(audioPath, 'voice-data', 'utf8');
    const runtime = new VoiceSttRuntime({
      workspaceRoot: process.cwd(), executable: process.execPath,
      workerScriptPath: worker.scriptPath, audioRoot, requestTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    try {
      const pending = runtime.transcribe({ audioPath, language: 'bg-BG' }, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const started = Date.now();
      controller.abort(new Error('owner stopped'));
      await expect(pending).rejects.toMatchObject({ code: 'voice-stt-cancelled' });
      expect(Date.now() - started).toBeLessThan(1_000);

      await expect(runtime.transcribe({ audioPath, language: 'ru-RU' })).resolves.toMatchObject({
        text: 'локальный текст 1', engine: 'vosk',
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it('drains an in-flight warmup before shutting the worker down', async () => {
    const worker = await writeFakeWorker();
    const runtime = new VoiceSttRuntime({
      workspaceRoot: process.cwd(),
      executable: process.execPath,
      workerScriptPath: worker.scriptPath,
      requestTimeoutMs: 2_000,
    });

    const preparing = runtime.prepare('ru-RU');
    const shuttingDown = runtime.shutdown();

    await expect(preparing).resolves.toMatchObject({ status: 'ready' });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(runtime.snapshot()).toMatchObject({ state: 'idle' });
  });

  it('streams ordered PCM through the resident Vosk fallback without ffmpeg', async () => {
    const worker = await writeFakeWorker();
    const runtime = new VoiceSttRuntime({
      workspaceRoot: process.cwd(),
      executable: process.execPath,
      workerScriptPath: worker.scriptPath,
      requestTimeoutMs: 2_000,
    });
    try {
      const started = await runtime.startStream({
        streamId: 'stream_vosk_123',
        language: 'ru-RU',
        sampleRate: 16_000,
      });
      const partial = await runtime.pushStream({
        streamId: 'stream_vosk_123',
        sequence: 0,
        pcmBase64: Buffer.alloc(320).toString('base64'),
      });
      const final = await runtime.finishStream('stream_vosk_123');

      expect(started).toMatchObject({ engine: 'vosk', sampleRate: 16_000 });
      expect(partial).toMatchObject({ partial: 'частичный', sequence: 0 });
      expect(final).toMatchObject({ text: 'готовый поток', engine: 'vosk', bytes: 320 });
    } finally {
      await runtime.shutdown();
    }
  });

  it('binds only an existing absolute isolated Python package root into the worker', async () => {
    const worker = await writeFakeWorker();
    const pythonPath = await mkdtemp(path.join(os.tmpdir(), 'monarch-voice-python-path-'));
    cleanupPaths.push(pythonPath);
    const previous = process.env.MONARCH_STT_PYTHONPATH;
    process.env.MONARCH_STT_PYTHONPATH = pythonPath;
    try {
      const runtime = new VoiceSttRuntime({
        workspaceRoot: process.cwd(), executable: process.execPath,
        workerScriptPath: worker.scriptPath, requestTimeoutMs: 2_000,
      });
      try {
        await expect(runtime.prepare('ru-RU')).resolves.toMatchObject({ status: 'ready' });
      } finally {
        await runtime.shutdown();
      }
    } finally {
      if (previous === undefined) delete process.env.MONARCH_STT_PYTHONPATH;
      else process.env.MONARCH_STT_PYTHONPATH = previous;
    }
  });
});

async function writeFakeWorker(): Promise<{ scriptPath: string }> {
  const runtimeRoot = path.join(process.cwd(), 'runtime');
  const tempDir = await mkdtemp(path.join(runtimeRoot, 'voice-stt-runtime-test-'));
  cleanupPaths.push(tempDir);
  const scriptPath = path.join(tempDir, 'fake-worker.cjs');
  await writeFile(scriptPath, `
const readline = require('node:readline');
const path = require('node:path');
const lines = readline.createInterface({ input: process.stdin });
let warm = false;
let turns = 0;
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'shutdown') process.exit(0);
  const isolatedPythonPath = String(process.env.MONARCH_STT_PYTHONPATH || '');
  if (isolatedPythonPath && process.env.PYTHONPATH !== isolatedPythonPath) {
    console.log(JSON.stringify({ id: request.id, type: 'error',
      code: 'voice-stt-runtime-path-denied', message: 'python path was not isolated' }));
    return;
  }
  if (request.type === 'transcribe') {
    const audioRoot = String(process.env.MONARCH_VOICE_AUDIO_ROOT || '');
    const relative = path.relative(path.resolve(audioRoot), path.resolve(request.audioPath || ''));
    if (!path.isAbsolute(audioRoot) || relative === '..' || relative.startsWith('..' + path.sep)) {
      console.log(JSON.stringify({ id: request.id, type: 'error',
        code: 'voice-stt-audio-path-denied', message: 'audio root was not bound' }));
      return;
    }
  }
  if (request.type === 'prepare') {
    const loadMs = warm ? 0 : 120;
    const wasWarm = warm;
    warm = true;
    console.log(JSON.stringify({
      id: request.id,
      type: 'ready',
      engine: 'vosk',
      model: 'fake-vosk-ru',
      loadMs,
      warm: wasWarm,
      pid: process.pid,
    }));
    return;
  }
  if (request.type === 'stream-start') {
    warm = true;
    console.log(JSON.stringify({
      id: request.id, type: 'stream-started', engine: 'vosk', model: 'fake-vosk-ru',
      loadMs: 0, warm: true, sampleRate: request.sampleRate, pid: process.pid,
    }));
    return;
  }
  if (request.type === 'stream-push') {
    console.log(JSON.stringify({
      id: request.id, type: 'stream-partial', engine: 'vosk', partial: 'частичный',
      sequence: request.sequence, processingMs: 5, audioMs: 10, pid: process.pid,
    }));
    return;
  }
  if (request.type === 'stream-finish') {
    console.log(JSON.stringify({
      id: request.id, type: 'stream-final', text: 'готовый поток', engine: 'vosk',
      model: 'fake-vosk-ru', recognitionMs: 5, finalizeMs: 1, audioMs: 10,
      bytes: 320, partialAgeMs: 1, pid: process.pid,
    }));
    return;
  }
  if (request.type === 'stream-cancel') {
    console.log(JSON.stringify({ id: request.id, type: 'stream-cancelled', cancelled: true, pid: process.pid }));
    return;
  }
  if (request.language === 'uk-UA') {
    console.log(JSON.stringify({
      id: request.id,
      type: 'error',
      code: 'voice-stt-language-unavailable',
      message: 'No local UK model.',
    }));
    return;
  }
  if (request.language === 'bg-BG') return;
  warm = true;
  turns += 1;
  console.log(JSON.stringify({
    id: request.id,
    type: 'transcript',
    text: 'локальный текст ' + turns,
    engine: 'vosk',
    model: 'fake-vosk-ru',
    loadMs: 0,
    warm: true,
    conversionMs: 12,
    recognitionMs: 34,
    totalMs: 46,
    pid: process.pid,
  }));
});
`, 'utf8');
  return { scriptPath };
}

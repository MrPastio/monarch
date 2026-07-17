import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SPEECH_TEXT_CHARS,
  createSpeechDiagnosticRecord,
  createSpeechWarmupCoordinator,
  createWindowsSpeechOutput,
  normalizeSpeechRequest,
  normalizeSpeechTelemetry,
  resolveNeuralCompletionTimeoutMs,
  resolveWindowsPowerShell,
} from '../../desktop/electron/speech-output.mjs';
import { normalizeRussianSpeechText } from '../../desktop/electron/russian-speech-normalizer.mjs';

describe('Electron Windows speech output', () => {
  it('scales the neural completion budget with long answers instead of capping it at two minutes', () => {
    expect(resolveNeuralCompletionTimeoutMs(100, 120_000)).toBe(120_000);
    expect(resolveNeuralCompletionTimeoutMs(1_000, 120_000)).toBe(400_000);
    expect(resolveNeuralCompletionTimeoutMs(64_000, 120_000)).toBe(25_600_000);
  });

  it('shares one synchronously-started Qwen warmup promise and publishes bounded diagnostics', async () => {
    let finishWarmup: (value: unknown) => void = () => undefined;
    let nowMs = 0;
    const warmup = vi.fn(() => new Promise((resolve) => { finishWarmup = resolve; }));
    const onDiagnostics = vi.fn();
    const coordinator = createSpeechWarmupCoordinator({
      warmup,
      now: () => nowMs,
      onDiagnostics,
    });

    const first = coordinator.start();
    const second = coordinator.start();

    expect(first).toBe(second);
    expect(warmup).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toMatchObject({ status: 'loading', attempt: 1 });

    nowMs = 125;
    finishWarmup({
      ok: true,
      engine: 'qwen3-tts-cuda-graph',
      model: 'qwen3-tts-0.6b-base',
      loadSeconds: 12.1,
    });

    await expect(first).resolves.toMatchObject({
      status: 'ready',
      ok: true,
      engine: 'qwen3-tts-cuda-graph',
      elapsedMs: 125,
      attempt: 1,
    });
    expect(onDiagnostics).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'ready', attempt: 1 }));
  });

  it('resolves a failed warmup and permits only one explicit retry', async () => {
    const warmup = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'neural-tts-startup-failed',
        summary: 'Файл подкачки слишком мал для завершения операции. (os error 1455)',
      })
      .mockResolvedValueOnce({ ok: true, engine: 'qwen3-tts-cuda-graph' });
    const coordinator = createSpeechWarmupCoordinator({ warmup });

    const first = coordinator.start();
    await expect(first).resolves.toMatchObject({
      status: 'failed',
      ok: false,
      error: 'neural-tts-startup-failed',
      summary: expect.stringContaining('1455'),
      attempt: 1,
    });

    const retry = coordinator.retry();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toMatchObject({ status: 'ready', ok: true, attempt: 2 });
    expect(coordinator.retry()).toBe(retry);
    expect(warmup).toHaveBeenCalledTimes(2);
  });

  it('resets warmup ownership after another local model requests GPU memory', async () => {
    const warmup = vi.fn().mockResolvedValue({ ok: true, engine: 'qwen3-tts-cuda-graph' });
    const coordinator = createSpeechWarmupCoordinator({ warmup });

    await expect(coordinator.start()).resolves.toMatchObject({ status: 'ready', attempt: 1 });
    expect(coordinator.reset()).toMatchObject({ status: 'idle', attempt: 1 });
    await expect(coordinator.start()).resolves.toMatchObject({ status: 'ready', attempt: 2 });
    expect(warmup).toHaveBeenCalledTimes(2);
  });

  it('writes bounded PII-safe diagnostic records and classifies Windows os1455', () => {
    const record = createSpeechDiagnosticRecord('warmup', {
      ok: false,
      status: 'failed',
      error: 'neural-tts-startup-failed',
      summary: 'Файл подкачки слишком мал для завершения операции. (os error 1455)',
      text: 'секретный текст ответа',
      speaker: 'private-speaker',
      elapsedMs: 20_052,
    }, { now: () => new Date('2026-07-14T00:00:00.000Z') });

    expect(record).toMatchObject({
      at: '2026-07-14T00:00:00.000Z',
      event: 'desktop.speech.warmup',
      status: 'failed',
      error: 'neural-tts-startup-failed',
      failureSignal: 'windows-os-1455-pagefile-too-small',
      elapsedMs: 20_052,
    });
    expect(record).not.toHaveProperty('summary');
    expect(record).not.toHaveProperty('text');
    expect(record).not.toHaveProperty('speaker');
    expect(JSON.stringify(record)).not.toContain('секретный текст ответа');
  });

  it('normalizes bounded local speech requests', () => {
    expect(normalizeSpeechRequest({ text: '  Привет  ', language: 'uk', rate: 9 })).toEqual({
      text: 'Привет',
      language: 'uk-UA',
      rate: 2,
      voice: 'oscar',
      style: 'natural',
      pace: 'normal',
      speed: 100,
      pitch: 0,
      expressiveness: 55,
      pauseMs: 80,
      volume: 100,
      instruction: '',
    });
    expect(normalizeSpeechRequest({
      text: 'Тест',
      voice: 'aurora',
      style: 'warm',
      speed: 116,
      pitch: -1,
      expressiveness: 82,
      pauseMs: 160,
      volume: 74,
      instruction: '  Мягко и уверенно.  ',
    })).toMatchObject({
      voice: 'aurora',
      style: 'warm',
      pace: 'fast',
      speed: 116,
      pitch: -1,
      expressiveness: 82,
      pauseMs: 160,
      volume: 74,
      rate: 2,
      instruction: 'Мягко и уверенно.',
    });
    expect(() => normalizeSpeechRequest({ text: 'x'.repeat(MAX_SPEECH_TEXT_CHARS + 1) })).toThrow(/слишком длинный/i);
  });

  it('expands Russian time, dates, numbers, percentages, and units only for TTS', () => {
    const visibleText = 'Сейчас 01:06. Сегодня 14.07.2026. Температура 23 °C, влажность 65%, ветер 5 м/с, память 1,5 ГБ. Ответ 42.';
    const input = { text: visibleText, language: 'ru-RU' };

    expect(normalizeRussianSpeechText(visibleText)).toBe(
      'Сейчас один час шесть минут. Сегодня четырнадцатое июля две тысячи двадцать шестого года. '
      + 'Температура двадцать три градуса Цельсия, влажность шестьдесят пять процентов, '
      + 'ветер пять метров в секунду, память одна целая пять десятых гигабайта. Ответ сорок два.',
    );
    expect(normalizeSpeechRequest(input).text).toBe(normalizeRussianSpeechText(visibleText));
    expect(input.text).toBe(visibleText);
    expect(normalizeSpeechRequest({ text: 'At 01:06, load is 65%.', language: 'en-US' }).text)
      .toBe('At 01:06, load is 65%.');
  });

  it('does not partially expand versions or IP addresses', () => {
    expect(normalizeRussianSpeechText('Версия v2.5, IP 127.0.0.1, порт 4317.')).toBe(
      'Версия v2.5, IP 127.0.0.1, порт четыре тысячи триста семнадцать.',
    );
  });

  it('normalizes bounded speech telemetry without exposing worker payload fields', () => {
    expect(normalizeSpeechTelemetry({
      id: 'speech-1',
      sequence: 4,
      rms: 0.08,
      peak: 2,
      brightness: -1,
      sampleRate: 24_000,
      text: 'must-not-leak',
    })).toEqual({
      id: 'speech-1',
      sequence: 4,
      rms: 0.08,
      peak: 1,
      brightness: 0,
      sampleRate: 24_000,
    });
    expect(normalizeSpeechTelemetry({ rms: 0.2 })).toBeNull();
    expect(normalizeSpeechTelemetry({
      id: 'speech-incomplete',
      sequence: 1,
      rms: 0.2,
      peak: 0.4,
      brightness: 0.3,
    })).toBeNull();
  });

  it('uses a direct PowerShell file process and pipes text through stdin', async () => {
    let written = '';
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      child.stdin.on('data', (chunk) => { written += String(chunk); });
      child.stdin.on('finish', () => {
        child.stdout.write('{"voice":"Microsoft Pavel","language":"ru-RU"}\n');
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0, null));
      });
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      systemRoot: 'Z:\\missing-windows',
      programFiles: 'Z:\\missing-program-files',
      pathValue: '',
      spawnProcess,
      enableNeural: false,
    });

    const result = await output.speak({ text: 'Ответ из stdin', language: 'ru-RU', volume: 37 });

    expect(result).toMatchObject({ ok: true, voice: 'Microsoft Pavel', language: 'ru-RU' });
    expect(JSON.parse(written)).toMatchObject({ text: 'Ответ из stdin', language: 'ru-RU', volume: 37 });
    expect(spawnProcess).toHaveBeenCalledWith(
      resolveWindowsPowerShell('Z:\\missing-windows', 'Z:\\missing-program-files', ''),
      expect.arrayContaining(['-File', path.resolve('tools/local-windows-tts.ps1')]),
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it('applies the normalized output volume inside the Windows SAPI worker', () => {
    const worker = readFileSync(path.resolve('tools/local-windows-tts.ps1'), 'utf8');
    expect(worker).toContain('$synthesizer.Volume = $volume');
    expect(worker).toContain('[Math]::Max(0, [Math]::Min(100, [int]$request.volume))');
    expect(worker).not.toContain('$synthesizer.Volume = 100');
  });

  it('keeps the neural worker alive and resolves streamed completion events', async () => {
    let buffered = '';
    let receivedRequest: Record<string, unknown> | undefined;
    const onTelemetry = vi.fn();
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      child.stdin.on('data', (chunk) => {
        buffered += String(chunk);
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const line of lines.filter(Boolean)) {
          const request = JSON.parse(line);
          if (request.type === 'speak') {
            receivedRequest = request;
            queueMicrotask(() => {
              child.stdout.write(`${JSON.stringify({ type: 'speaking', id: request.id })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'frame',
                id: request.id,
                sequence: 1,
                rms: 0.0625,
                peak: 0.7,
                brightness: 0.4,
                sampleRate: 24_000,
              })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'done',
                id: request.id,
                engine: 'qwen3-tts-cuda-graph',
                speaker: 'ryan',
                ttfaSeconds: 0.48,
              })}\n`);
            });
          }
        }
      });
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({
          type: 'ready',
          engine: 'qwen3-tts-cuda-graph',
          speaker: 'ryan',
        })}\n`);
      });
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      spawnProcess,
      fileExists: () => true,
      neuralReadyTimeoutMs: 2_000,
      onTelemetry,
    });

    await output.warmup();

    const result = await output.speak({
      text: 'Нейросетевой ответ',
      language: 'ru-RU',
      voice: 'oscar-clear',
      style: 'focused',
      speed: 108,
      pitch: 1,
      expressiveness: 66,
      pauseMs: 120,
      volume: 88,
    });

    expect(result).toMatchObject({
      ok: true,
      engine: 'qwen3-tts-cuda-graph',
      speaker: 'ryan',
      ttfaSeconds: 0.48,
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(onTelemetry).toHaveBeenCalledWith({
      id: expect.stringMatching(/^speech-/),
      sequence: 1,
      rms: 0.0625,
      peak: 0.7,
      brightness: 0.4,
      sampleRate: 24_000,
    });
    expect(receivedRequest).toMatchObject({
      voice: 'oscar-clear',
      style: 'focused',
      pace: 'fast',
      speed: 108,
      pitch: 1,
      expressiveness: 66,
      pauseMs: 120,
      volume: 88,
      rate: 1,
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      path.resolve('runtime/voice/.venv/Scripts/python.exe'),
      ['-u', path.resolve('tools/local-neural-tts.py')],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    output.dispose();
  });

  it('never restarts the full answer through Windows after Qwen playback already began', async () => {
    const spawnProcess = vi.fn((executable: string) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      if (/python\.exe$/i.test(executable)) {
        let buffered = '';
        child.stdin.on('data', (chunk) => {
          buffered += String(chunk);
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines.filter(Boolean)) {
            const request = JSON.parse(line);
            if (request.type !== 'speak') continue;
            queueMicrotask(() => {
              child.stdout.write(`${JSON.stringify({
                type: 'frame',
                id: request.id,
                sequence: 1,
                rms: 0.05,
                peak: 0.4,
                brightness: 0.3,
                sampleRate: 24_000,
              })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'error',
                id: request.id,
                error: 'neural-tts-failed',
                summary: 'Поздний сбой после начала воспроизведения.',
              })}\n`);
            });
          }
        });
        queueMicrotask(() => child.stdout.write('{"type":"ready","engine":"qwen3-tts-cuda-graph"}\n'));
      } else {
        child.stdin.on('finish', () => {
          child.stdout.write('{"voice":"Microsoft Pavel","language":"ru-RU"}\n');
          child.stdout.end();
          queueMicrotask(() => child.emit('close', 0, null));
        });
      }
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      spawnProcess,
      fileExists: () => true,
      neuralReadyTimeoutMs: 2_000,
      neuralQuarantineTimeoutMs: 50,
    });
    await output.warmup();

    const result = await output.speak({ text: 'Длинный нейросетевой ответ', language: 'ru-RU' });

    expect(result).toMatchObject({
      ok: false,
      engine: 'qwen3-tts-cuda-graph',
      error: 'neural-tts-failed',
      playbackStarted: true,
      partial: true,
    });
    expect(result).not.toHaveProperty('fallback');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    output.dispose();
  });

  it('awaits an in-progress neural warmup instead of downgrading the first turn to SAPI', async () => {
    let neuralChild: (EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      kill: () => boolean;
    }) | null = null;
    const createChild = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      return child;
    };
    const spawnProcess = vi.fn((executable: string) => {
      const child = createChild();
      if (/python\.exe$/i.test(executable)) {
        neuralChild = child;
        let buffered = '';
        child.stdin.on('data', (chunk) => {
          buffered += String(chunk);
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines.filter(Boolean)) {
            const request = JSON.parse(line);
            if (request.type !== 'speak') continue;
            queueMicrotask(() => {
              child.stdout.write(`${JSON.stringify({ type: 'speaking', id: request.id })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'frame',
                id: request.id,
                sequence: 1,
                rms: 0.05,
                peak: 0.4,
                brightness: 0.3,
                sampleRate: 24_000,
              })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'done',
                id: request.id,
                engine: 'qwen3-tts-cuda-graph',
                speaker: 'oscar',
              })}\n`);
            });
          }
        });
        return child;
      }
      child.stdin.on('finish', () => {
        child.stdout.write('{"voice":"Microsoft Pavel","language":"ru-RU"}\n');
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0, null));
      });
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      spawnProcess,
      fileExists: () => true,
      neuralReadyTimeoutMs: 2_000,
    });

    const warmup = output.warmup();
    const speech = output.speak({ text: 'Первый нейросетевой ответ', language: 'ru-RU' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    neuralChild?.stdout.write('{"type":"ready","engine":"qwen3-tts-cuda-graph"}\n');
    const [result] = await Promise.all([speech, warmup]);

    expect(result).toMatchObject({
      ok: true,
      engine: 'qwen3-tts-cuda-graph',
      speaker: 'oscar',
    });
    expect(result).not.toHaveProperty('fallback');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(output.isNeuralReady()).toBe(true);
    output.dispose();
  });

  it('holds retry and speak behind retirement until a timed-out Qwen worker really closes', async () => {
    vi.useFakeTimers();
    try {
      const neuralChildren: Array<EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      }> = [];
      const createChild = () => {
        const child = new EventEmitter() as EventEmitter & {
          stdin: PassThrough;
          stdout: PassThrough;
          stderr: PassThrough;
          killed: boolean;
          kill: () => boolean;
        };
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        // Signal delivery is deliberately not the process `close` event.
        child.kill = () => {
          child.killed = true;
          return true;
        };
        return child;
      };
      const spawnProcess = vi.fn(() => {
        const child = createChild();
        const workerIndex = neuralChildren.length;
        neuralChildren.push(child);
        let buffered = '';
        child.stdin.on('data', (chunk) => {
          buffered += String(chunk);
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines.filter(Boolean)) {
            const request = JSON.parse(line);
            if (request.type !== 'speak' || workerIndex === 0) continue;
            queueMicrotask(() => {
              child.stdout.write(`${JSON.stringify({
                type: 'frame',
                id: request.id,
                sequence: 1,
                rms: 0.05,
                peak: 0.4,
                brightness: 0.3,
                sampleRate: 24_000,
              })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'done',
                id: request.id,
                engine: 'qwen3-tts-cuda-graph',
                speaker: 'oscar',
              })}\n`);
            });
          }
        });
        if (workerIndex > 0) {
          queueMicrotask(() => {
            child.stdout.write('{"type":"ready","engine":"qwen3-tts-cuda-graph"}\n');
          });
        }
        return child;
      });
      const output = createWindowsSpeechOutput({
        workspaceRoot: path.resolve('.'),
        platform: 'win32',
        spawnProcess,
        fileExists: () => true,
        neuralReadyTimeoutMs: 1_000,
        neuralQuarantineTimeoutMs: 50,
      });

      const failedWarmup = output.warmup();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(failedWarmup).resolves.toMatchObject({
        ok: false,
        error: 'neural-tts-ready-timeout',
      });

      const retry = output.warmup();
      const speech = output.speak({ text: 'Свежий worker после retirement', language: 'ru-RU' });
      await Promise.resolve();
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(neuralChildren[0].killed).toBe(true);
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      neuralChildren[0].emit('close', null, 'SIGTERM');
      await expect(retry).resolves.toMatchObject({ ok: true, engine: 'qwen3-tts-cuda-graph' });
      await expect(speech).resolves.toMatchObject({ ok: true, engine: 'qwen3-tts-cuda-graph', speaker: 'oscar' });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(neuralChildren).toHaveLength(2);
      output.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an idle neural worker and permits a later cold warmup', async () => {
    const children: Array<EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      kill: () => boolean;
    }> = [];
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      let buffered = '';
      child.stdin.on('data', (chunk) => {
        buffered += String(chunk);
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const line of lines.filter(Boolean)) {
          if (JSON.parse(line).type === 'shutdown') queueMicrotask(() => child.emit('close', 0, null));
        }
      });
      queueMicrotask(() => child.stdout.write('{"type":"ready","engine":"qwen3-tts-cuda-graph"}\n'));
      children.push(child);
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      spawnProcess,
      fileExists: () => true,
      neuralReadyTimeoutMs: 2_000,
    });

    await expect(output.warmup()).resolves.toMatchObject({ ok: true });
    await expect(output.releaseNeural()).resolves.toEqual({ ok: true, released: true });
    expect(output.isNeuralReady()).toBe(false);
    await expect(output.warmup()).resolves.toMatchObject({ ok: true });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
    output.dispose();
  });

  it('fails closed instead of spawning a second Qwen worker when retirement never closes', async () => {
    vi.useFakeTimers();
    try {
      const neuralChildren: Array<EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      }> = [];
      const spawnProcess = vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & {
          stdin: PassThrough;
          stdout: PassThrough;
          stderr: PassThrough;
          killed: boolean;
          kill: () => boolean;
        };
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.kill = () => {
          child.killed = true;
          return true;
        };
        const workerIndex = neuralChildren.length;
        neuralChildren.push(child);
        if (workerIndex > 0) {
          queueMicrotask(() => {
            child.stdout.write('{"type":"ready","engine":"qwen3-tts-cuda-graph"}\n');
          });
        }
        return child;
      });
      const output = createWindowsSpeechOutput({
        workspaceRoot: path.resolve('.'),
        platform: 'win32',
        spawnProcess,
        fileExists: () => true,
        neuralReadyTimeoutMs: 1_000,
        neuralQuarantineTimeoutMs: 50,
      });

      const failedWarmup = output.warmup();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(failedWarmup).resolves.toMatchObject({ error: 'neural-tts-ready-timeout' });

      const blockedRetry = output.warmup();
      await vi.advanceTimersByTimeAsync(100);
      await expect(blockedRetry).resolves.toMatchObject({
        ok: false,
        error: 'neural-tts-retirement-timeout',
      });
      await expect(output.warmup()).resolves.toMatchObject({ error: 'neural-tts-retirement-timeout' });
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(neuralChildren).toHaveLength(1);

      neuralChildren[0].emit('close', null, 'SIGTERM');
      await Promise.resolve();
      await expect(output.warmup()).resolves.toMatchObject({
        ok: true,
        engine: 'qwen3-tts-cuda-graph',
      });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(neuralChildren).toHaveLength(2);
      neuralChildren[1].emit('close', 0, null);
      output.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to SAPI when a ready neural worker announces speaking but never emits a playback frame', async () => {
    const createChild = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      return child;
    };
    const spawnProcess = vi.fn((executable: string) => {
      const child = createChild();
      if (/python\.exe$/i.test(executable)) {
        let buffered = '';
        child.stdin.on('data', (chunk) => {
          buffered += String(chunk);
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines.filter(Boolean)) {
            const request = JSON.parse(line);
            if (request.type !== 'speak') continue;
            queueMicrotask(() => {
              child.stdout.write(`${JSON.stringify({ type: 'speaking', id: request.id })}\n`);
            });
          }
        });
        queueMicrotask(() => {
          child.stdout.write('{"type":"ready","engine":"qwen3-tts-cuda-graph"}\n');
        });
        return child;
      }
      child.stdin.on('finish', () => {
        child.stdout.write('{"voice":"Microsoft Pavel","language":"ru-RU"}\n');
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0, null));
      });
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      spawnProcess,
      fileExists: () => true,
      neuralReadyTimeoutMs: 2_000,
      neuralStartTimeoutMs: 500,
      neuralQuarantineTimeoutMs: 50,
    });
    await output.warmup();

    const result = await output.speak({ text: 'Ответ не должен зависнуть', language: 'ru-RU' });

    expect(result).toMatchObject({
      ok: true,
      engine: 'windows-sapi',
      fallback: true,
      fallbackFrom: 'neural-tts-start-timeout',
    });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    output.dispose();
  });

  it('quarantines a timed-out neural worker and starts a fresh Qwen worker on the next turn', async () => {
    const neuralChildren: Array<EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      kill: () => boolean;
    }> = [];
    const createChild = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      return child;
    };
    const spawnProcess = vi.fn((executable: string) => {
      const child = createChild();
      if (/python\.exe$/i.test(executable)) {
        const workerIndex = neuralChildren.length;
        neuralChildren.push(child);
        let buffered = '';
        child.stdin.on('data', (chunk) => {
          buffered += String(chunk);
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines.filter(Boolean)) {
            const request = JSON.parse(line);
            if (request.type === 'shutdown' && workerIndex > 0) {
              queueMicrotask(() => child.emit('close', 0, null));
              continue;
            }
            if (request.type !== 'speak') continue;
            queueMicrotask(() => {
              child.stdout.write(`${JSON.stringify({ type: 'speaking', id: request.id })}\n`);
              if (workerIndex === 0) return;
              child.stdout.write(`${JSON.stringify({
                type: 'frame',
                id: request.id,
                sequence: 1,
                rms: 0.05,
                peak: 0.4,
                brightness: 0.3,
                sampleRate: 24_000,
              })}\n`);
              child.stdout.write(`${JSON.stringify({
                type: 'done',
                id: request.id,
                engine: 'qwen3-tts-cuda-graph',
                speaker: 'oscar',
              })}\n`);
            });
          }
        });
        queueMicrotask(() => {
          child.stdout.write('{"type":"ready","engine":"qwen3-tts-cuda-graph"}\n');
        });
        return child;
      }
      child.stdin.on('finish', () => {
        child.stdout.write('{"voice":"Microsoft Pavel","language":"ru-RU"}\n');
        child.stdout.end();
        queueMicrotask(() => child.emit('close', 0, null));
      });
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      spawnProcess,
      fileExists: () => true,
      neuralReadyTimeoutMs: 2_000,
      neuralStartTimeoutMs: 500,
      neuralQuarantineTimeoutMs: 50,
    });
    await output.warmup();

    const first = await output.speak({ text: 'Первый worker завис', language: 'ru-RU' });
    const second = await output.speak({ text: 'Новый worker отвечает', language: 'ru-RU' });

    expect(first).toMatchObject({
      ok: true,
      engine: 'windows-sapi',
      fallback: true,
      fallbackFrom: 'neural-tts-start-timeout',
    });
    expect(second).toMatchObject({
      ok: true,
      engine: 'qwen3-tts-cuda-graph',
      speaker: 'oscar',
    });
    expect(second).not.toHaveProperty('fallback');
    expect(neuralChildren).toHaveLength(2);
    expect(neuralChildren[0].killed).toBe(true);
    expect(neuralChildren[1].killed).toBe(false);
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    output.dispose();
  });

  it('bounds a hung Windows SAPI fallback with a stable timeout error', async () => {
    let fallbackChild: (EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      kill: () => boolean;
    }) | null = null;
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill: () => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      fallbackChild = child;
      return child;
    });
    const output = createWindowsSpeechOutput({
      workspaceRoot: path.resolve('.'),
      platform: 'win32',
      spawnProcess,
      fileExists: () => true,
      enableNeural: false,
      fallbackTimeoutMs: 50,
    });

    const result = await output.speak({ text: 'Зависший аварийный голос', language: 'ru-RU' });

    expect(result).toMatchObject({
      ok: false,
      error: 'speech-fallback-timeout',
      neuralError: 'neural-tts-disabled',
    });
    expect(fallbackChild?.killed).toBe(true);
    expect(output.isSpeaking()).toBe(false);
    output.dispose();
  });
});

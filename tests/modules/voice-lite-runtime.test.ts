import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VoiceModule } from '../../src/modules/voice';
import {
  VoiceModeModelManager,
  type VoiceModeModelManagerPort,
} from '../../src/modules/voice/voice-mode-model-manager';
import {
  VOICE_MODE_PROFILE_METADATA,
  VoiceProfileRuntime,
  type VoiceModeProfile,
  type VoiceProfileRuntimePort,
} from '../../src/modules/voice/voice-lite-runtime';
import { executeVoiceModeScripted, formatLocalTime } from '../../src/modules/voice/voice-scripted';
import type { VoiceSttRuntimePort } from '../../src/modules/voice/voice-stt-runtime';

const cleanupTasks: Array<() => Promise<void>> = [];
const FAULT_WORKER_TIMEOUT_MS = 2_000;

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

describe('VoiceProfileRuntime', () => {
  it('keeps one profile JSONL worker alive and serializes turns', async () => {
    const fixture = await createWorkerFixture(['micro']);
    const runtime = fixture.runtime('micro');
    const prepared = await runtime.prepare();
    const [first, second] = await Promise.all([
      runtime.respond({ text: 'Первый запрос' }),
      runtime.respond({ text: 'Второй запрос' }),
    ]);

    expect(prepared).toMatchObject({
      status: 'ready',
      profile: 'micro',
      backend: 'llama-cpp-cpu',
      model: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    });
    expect(first).toMatchObject({
      text: 'micro: Первый запрос',
      profile: 'micro',
      pid: prepared.pid,
      ttftMs: 2,
    });
    expect(second.pid).toBe(prepared.pid);
    expect(runtime.snapshot()).toMatchObject({
      state: 'ready',
      profile: 'micro',
      pid: prepared.pid,
    });
  });

  it('rejects oversized input before spawning a worker', async () => {
    const fixture = await createWorkerFixture(['micro']);
    const runtime = fixture.runtime('micro');

    await expect(runtime.respond({ text: 'я'.repeat(1_201) })).rejects.toMatchObject({
      code: 'voice-lite-text-too-long',
    });
    expect(runtime.snapshot()).toMatchObject({ state: 'idle' });
  });

  it('fails with a stable code when the fixed profile GGUF is absent', async () => {
    const fixture = await createWorkerFixture([]);

    await expect(fixture.runtime('micro').prepare()).rejects.toMatchObject({
      code: 'voice-lite-model-missing',
    });
  });

  it.each([
    ['timeout', 'voice-lite-timeout'],
    ['protocol', 'voice-lite-protocol-error'],
    ['fatal', 'voice-lite-model-load-failed'],
  ] as const)('quarantines a %s worker before starting exactly one replacement', async (mode, code) => {
    const fixture = await createFaultWorkerFixture(mode);
    const runtime = fixture.runtime;

    await expect(runtime.prepare()).rejects.toMatchObject({ code });
    await expect(runtime.prepare()).resolves.toMatchObject({
      status: 'ready',
      profile: 'lite',
    });
    expect(await readFile(fixture.spawnCountPath, 'utf8')).toBe('2');
  });
});

describe('VoiceModeModelManager', () => {
  it('keeps every LLM lazy, never spawns Micro, and releases the exact Lite worker', async () => {
    const fixture = await createWorkerFixture(['micro', 'lite']);
    const manager = fixture.manager();
    const prepared = await manager.prepare();
    const lite = await manager.respond({ profile: 'lite', text: 'сократи длинную фразу' });

    expect(prepared).toMatchObject({ status: 'ready', backend: 'llama-cpp-cpu', profiles: [] });
    expect(lite).toMatchObject({ profile: 'lite', text: 'lite: сократи длинную фразу' });
    expect(manager.snapshot()).toMatchObject({
      profiles: {
        micro: { state: 'idle', profile: 'micro' },
        lite: {
          state: 'ready',
          profile: 'lite',
          repository: 'unsloth/Qwen3-1.7B-GGUF',
          license: 'Apache-2.0',
          sha256: 'B139949C5BD74937AD8ED8C8CF3D9FFB1E99C866C823204DC42C0D91FA181897',
        },
      },
    });

    await expect(manager.prepare({ profiles: ['micro'] })).rejects.toMatchObject({
      code: 'voice-mode-profile-invalid',
    });
    await expect(manager.respond({ profile: 'micro', text: 'привет' })).rejects.toMatchObject({
      code: 'voice-mode-profile-route-mismatch',
    });

    await expect(manager.release()).resolves.toEqual({ status: 'released', profiles: ['lite'] });
    expect(manager.snapshot().profiles).toMatchObject({
      micro: { state: 'idle' },
      lite: { state: 'idle' },
    });
  });

  it('rejects profile and sampling overrides outside the server-owned contract', async () => {
    const fixture = await createWorkerFixture(['micro']);
    const manager = fixture.manager();

    await expect(manager.respond({ profile: 'unknown', text: 'привет' })).rejects.toMatchObject({
      code: 'voice-mode-profile-invalid',
    });
    await expect(manager.respond({
      profile: 'micro',
      text: 'привет',
      temperature: 0.8,
    })).rejects.toMatchObject({ code: 'voice-mode-input-invalid' });
    await expect(manager.respond({ profile: 'lite', text: 'привет' })).rejects.toMatchObject({
      code: 'voice-mode-profile-route-mismatch',
    });
    await expect(manager.respond({ profile: 'micro', text: 'открой браузер' })).rejects.toMatchObject({
      code: 'voice-mode-profile-route-mismatch',
    });
  });
});

describe('scripted voice execution', () => {
  it('answers wake-only, local time, and arithmetic without a model', () => {
    const now = new Date(2026, 0, 2, 9, 5);
    const expectedTime = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    expect(executeVoiceModeScripted('Оскар')).toEqual({
      text: 'Слушаю.',
      actionId: 'listen.continue',
      lane: 'scripted',
      model: 'none',
      performed: true,
      status: 'completed',
    });
    expect(executeVoiceModeScripted('Оскар, ты тут?')).toEqual({
      text: 'Я тут.',
      actionId: 'listen.continue',
      lane: 'scripted',
      model: 'none',
      performed: true,
      status: 'completed',
    });
    expect(executeVoiceModeScripted('Оскар, который час?', now)).toEqual({
      text: `Сейчас ${expectedTime}.`,
      actionId: 'time.query',
      lane: 'scripted',
      model: 'none',
      performed: true,
      status: 'completed',
    });
    expect(executeVoiceModeScripted('Оскар, 7 умножить на 6')).toEqual({
      text: 'Получается 42.',
      actionId: 'math.calculate',
      lane: 'scripted',
      model: 'none',
      performed: true,
      status: 'completed',
    });
  });

  it('formats the current instant in the explicit Windows-mapped Kyiv timezone', () => {
    const instant = new Date('2026-07-13T22:06:00.000Z');

    expect(formatLocalTime(instant, 'Europe/Kyiv')).toBe('01:06');
    expect(executeVoiceModeScripted('Оскар, который час?', instant, 'Europe/Kyiv')).toMatchObject({
      text: 'Сейчас 01:06.',
      actionId: 'time.query',
    });
  });

  it('clarifies incomplete or unavailable actions without pretending to execute them', () => {
    expect(executeVoiceModeScripted('Подскажи погоду прямо сейчас')).toMatchObject({
      text: 'Для какого города показать погоду?',
      actionId: 'weather.query',
      performed: false,
      status: 'clarification',
    });
    expect(executeVoiceModeScripted('Установи громкость обратно')).toMatchObject({
      text: 'Не понял точный уровень громкости. Скажи полностью, например: «установи громкость на 50 процентов».',
      actionId: 'device.volume.clarification',
      performed: false,
      status: 'clarification',
    });
    expect(executeVoiceModeScripted('Оскар, открой браузер')).toMatchObject({
      text: 'Открытие браузера требует системный Device-исполнитель. Я ничего не открывал.',
      actionId: 'device.browser.open',
      performed: false,
      status: 'unsupported',
    });
    expect(() => executeVoiceModeScripted('Оскар, какая погода в Киеве')).toThrowError(
      expect.objectContaining({ code: 'voice-scripted-route-rejected', actionId: 'weather.query' }),
    );
    expect(() => executeVoiceModeScripted('Проанализируй архитектуру проекта')).toThrowError(
      expect.objectContaining({ code: 'voice-scripted-route-rejected' }),
    );
  });
});

describe('VoiceModule voice mode capabilities', () => {
  it('wires profile prepare/respond, scripted execution, events, and shutdown', async () => {
    const calls: string[] = [];
    const manager = fakeManager(calls);
    const sttCalls: string[] = [];
    const sttRuntime = fakeSttRuntime(sttCalls);
    const events: string[] = [];
    const context = {
      emit: async (event: string) => {
        events.push(event);
      },
    } as any;
    const voice = new VoiceModule(manager, sttRuntime);

    const prepare = await voice.executeCapability(
      request('voice.mode.prepare', {}),
      context,
    );
    const respond = await voice.executeCapability(
      request('voice.mode.respond', { profile: 'micro', text: 'быстро' }),
      context,
    );
    const scripted = await voice.executeCapability(
      request('voice.mode.execute-scripted', { text: 'Оскар, 10 плюс 5' }),
      context,
    );
    const unavailable = await voice.executeCapability(
      request('voice.mode.execute-scripted', { text: 'Оскар, открой браузер' }),
      context,
    );
    const release = await voice.executeCapability(
      request('voice.mode.release', { profiles: ['lite'] }),
      context,
    );
    await voice.deactivate(context);

    expect(prepare).toMatchObject({
      ok: true,
      output: {
        profiles: [],
        stt: { status: 'ready', engine: 'vosk', pid: 778 },
      },
    });
    expect(respond).toMatchObject({
      ok: true,
      output: { profile: 'micro', text: 'Ответ: быстро', generationMs: 25, ttftMs: 4 },
    });
    expect(scripted).toMatchObject({
      ok: true,
      output: { text: 'Получается 15.', actionId: 'math.calculate', model: 'none' },
    });
    expect(unavailable).toMatchObject({
      ok: true,
      output: {
        text: 'Открытие браузера требует системный Device-исполнитель. Я ничего не открывал.',
        actionId: 'device.browser.open',
        model: 'none',
        performed: false,
        status: 'unsupported',
      },
    });
    expect(release).toMatchObject({
      ok: true,
      output: { status: 'released', profiles: ['lite'] },
    });
    expect(events).toEqual(expect.arrayContaining([
      'voice.mode.ready',
      'voice.mode.released',
      'voice.mode.responded',
      'voice.mode.scripted.executed',
      'voice.mode.scripted.unsupported',
    ]));
    expect(calls).toEqual(['prepare:{}', 'release:lite', 'shutdown']);
    expect(sttCalls).toEqual(['prepare:ru-RU', 'shutdown']);
  });
});

async function createWorkerFixture(installedProfiles: VoiceModeProfile[]): Promise<{
  runtime: (profile: VoiceModeProfile) => VoiceProfileRuntime;
  manager: () => VoiceModeModelManager;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-voice-profile-'));
  const workerPath = path.join(root, 'src', 'modules', 'voice', 'workers', 'fake-worker.mjs');
  const modelRoot = path.join(root, 'runtime', 'voice', 'models', 'voice-lite');
  await mkdir(path.dirname(workerPath), { recursive: true });
  await mkdir(modelRoot, { recursive: true });
  await writeFile(workerPath, FAKE_WORKER, 'utf8');
  for (const profile of installedProfiles) {
    await writeFile(path.join(modelRoot, modelName(profile)), 'GGUF', 'utf8');
  }

  const owned: Array<{ shutdown(): Promise<void> }> = [];
  const common = {
    workspaceRoot: root,
    executable: process.execPath,
    workerScriptPath: workerPath,
    requestTimeoutMs: 5_000,
  };
  cleanupTasks.push(async () => {
    await Promise.all(owned.map((value) => value.shutdown().catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
  });
  return {
    runtime: (profile) => {
      const runtime = new VoiceProfileRuntime({ profile, ...common });
      owned.push(runtime);
      return runtime;
    },
    manager: () => {
      const manager = new VoiceModeModelManager(common);
      owned.push(manager);
      return manager;
    },
  };
}

async function createFaultWorkerFixture(mode: 'timeout' | 'protocol' | 'fatal'): Promise<{
  runtime: VoiceProfileRuntime;
  spawnCountPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-voice-profile-fault-'));
  const workerPath = path.join(root, 'src', 'modules', 'voice', 'workers', 'fault-worker.mjs');
  const modelRoot = path.join(root, 'runtime', 'voice', 'models', 'voice-lite');
  const spawnCountPath = path.join(root, 'spawn-count.txt');
  await mkdir(path.dirname(workerPath), { recursive: true });
  await mkdir(modelRoot, { recursive: true });
  await writeFile(path.join(modelRoot, modelName('lite')), 'GGUF', 'utf8');
  await writeFile(workerPath, faultWorkerSource(mode, spawnCountPath), 'utf8');
  const runtime = new VoiceProfileRuntime({
    profile: 'lite',
    workspaceRoot: root,
    executable: process.execPath,
    workerScriptPath: workerPath,
    requestTimeoutMs: FAULT_WORKER_TIMEOUT_MS,
  });
  cleanupTasks.push(async () => {
    await runtime.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, spawnCountPath };
}

function faultWorkerSource(mode: 'timeout' | 'protocol' | 'fatal', spawnCountPath: string): string {
  return `
import fs from 'node:fs';
import readline from 'node:readline';
const marker = ${JSON.stringify(spawnCountPath)};
const count = (fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0) + 1;
fs.writeFileSync(marker, String(count));
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'shutdown') process.exit(0);
  if (count === 1) {
    if (${JSON.stringify(mode)} === 'timeout') return;
    if (${JSON.stringify(mode)} === 'protocol') {
      process.stdout.write('{broken-json\\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      id: request.id,
      type: 'error',
      code: 'voice-lite-model-load-failed',
      message: 'synthetic fatal load failure',
    }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    id: request.id,
    type: 'ready',
    profile: 'lite',
    backend: 'llama-cpp-cpu',
    model: ${JSON.stringify(modelName('lite'))},
    loadMs: 1,
    pid: process.pid,
  }) + '\\n');
});
`;
}

function fakeManager(calls: string[]): VoiceModeModelManagerPort {
  return {
    prepare: async (input = {}) => {
      calls.push(`prepare:${JSON.stringify(input)}`);
      return {
        status: 'ready',
        backend: 'llama-cpp-cpu',
        profiles: [],
      };
    },
    respond: async (input) => {
      const request = input as { profile: VoiceModeProfile; text: string };
      return {
        text: `Ответ: ${request.text}`,
        profile: request.profile,
        backend: 'llama-cpp-cpu',
        model: modelName(request.profile),
        loadMs: 12,
        generationMs: 25,
        ttftMs: 4,
        pid: 777,
      };
    },
    shutdown: async () => {
      calls.push('shutdown');
    },
    release: async (input = {}) => {
      const profiles = (input as { profiles?: VoiceModeProfile[] }).profiles || ['lite'];
      calls.push(`release:${profiles.join(',')}`);
      return { status: 'released', profiles };
    },
    snapshot: () => ({
      backend: 'llama-cpp-cpu',
      profiles: {
        micro: profileSnapshot('micro', 777),
        lite: profileSnapshot('lite'),
      },
    }),
  };
}

function fakeSttRuntime(calls: string[]): VoiceSttRuntimePort {
  return {
    prepare: async (language = 'ru-RU') => {
      calls.push(`prepare:${language}`);
      return {
        status: 'ready',
        engine: 'vosk',
        model: 'fake-vosk-ru',
        loadMs: 9,
        warm: false,
        pid: 778,
      };
    },
    transcribe: async () => ({
      text: 'unused',
      engine: 'vosk',
      model: 'fake-vosk-ru',
      loadMs: 0,
      warm: true,
      conversionMs: 1,
      recognitionMs: 1,
      totalMs: 2,
      pid: 778,
    }),
    shutdown: async () => {
      calls.push('shutdown');
    },
    snapshot: () => ({
      state: 'idle',
      engine: 'vosk',
    }),
  };
}

function profileSnapshot(profile: VoiceModeProfile, pid?: number) {
  return {
    state: pid ? 'ready' as const : 'idle' as const,
    profile,
    backend: 'llama-cpp-cpu' as const,
    model: modelName(profile),
    repository: VOICE_MODE_PROFILE_METADATA[profile].repository,
    license: VOICE_MODE_PROFILE_METADATA[profile].license,
    sha256: VOICE_MODE_PROFILE_METADATA[profile].sha256,
    ...(pid ? { pid } : {}),
  };
}

function request(capabilityId: string, input: unknown) {
  return {
    id: `exec_${capabilityId}`,
    intentId: `intent_${capabilityId}`,
    moduleId: 'voice',
    capabilityId,
    input,
    createdAt: new Date(0).toISOString(),
    requestedBy: 'test',
  };
}

function modelName(profile: VoiceModeProfile): string {
  return profile === 'micro'
    ? 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
    : 'qwen3-1.7b-q4_k_m.gguf';
}

const FAKE_WORKER = String.raw`
import readline from 'node:readline';

const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'missing';
const model = profile === 'micro'
  ? 'qwen2.5-0.5b-instruct-q4_k_m.gguf'
  : 'qwen3-1.7b-q4_k_m.gguf';
const workerPid = process.pid + 1000;
const input = readline.createInterface({ input: process.stdin });
let active = 0;

input.on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.type === 'shutdown') {
    process.stdout.write(JSON.stringify({ id: request.id, type: 'shutdown', ok: true }) + '\n');
    process.exit(0);
  }
  if (request.type === 'prepare') {
    process.stdout.write(JSON.stringify({
      id: request.id,
      type: 'ready',
      status: 'ready',
      profile,
      backend: 'llama-cpp-cpu',
      model,
      loadMs: 8,
      pid: workerPid,
    }) + '\n');
    return;
  }
  if (request.type === 'respond') {
    active += 1;
    if (active > 1) {
      process.stdout.write(JSON.stringify({
        id: request.id,
        type: 'error',
        code: 'voice-lite-concurrent-request',
        message: 'requests overlapped',
      }) + '\n');
      active -= 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
    process.stdout.write(JSON.stringify({
      id: request.id,
      type: 'response',
      text: profile + ': ' + request.text,
      profile,
      backend: 'llama-cpp-cpu',
      model,
      loadMs: 8,
      generationMs: 11,
      ttftMs: 2,
      pid: workerPid,
    }) + '\n');
    active -= 1;
  }
});
`;

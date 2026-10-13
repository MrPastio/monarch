import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMonarchRuntime } from '../../src/bootstrap';
import { resolveMonarchRuntimePaths } from '../../src/core';
import { normalizeSpeechLanguage, parseAndValidateCommand, VoiceModule } from '../../src/modules/voice';

const previousTranscribeCommand = process.env.MONARCH_STT_TRANSCRIBE_COMMAND;
const previousBridgeCommand = process.env.MONARCH_STT_COMMAND;
const previousDisableDefaultStt = process.env.MONARCH_DISABLE_DEFAULT_STT;
const previousPrewarmOnActivate = process.env.MONARCH_STT_PREWARM_ON_ACTIVATE;

describe('Voice Module', () => {
  afterEach(() => {
    restoreEnv('MONARCH_STT_TRANSCRIBE_COMMAND', previousTranscribeCommand);
    restoreEnv('MONARCH_STT_COMMAND', previousBridgeCommand);
    restoreEnv('MONARCH_DISABLE_DEFAULT_STT', previousDisableDefaultStt);
    restoreEnv('MONARCH_STT_PREWARM_ON_ACTIVATE', previousPrewarmOnActivate);
  });

  it('can fail closed when the default local STT adapter is explicitly disabled', async () => {
    delete process.env.MONARCH_STT_TRANSCRIBE_COMMAND;
    process.env.MONARCH_STT_COMMAND = 'node runtime/fake-long-running-bridge.js';
    process.env.MONARCH_DISABLE_DEFAULT_STT = '1';

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await executeVoiceTranscribe(runtime.kernel, Buffer.from('voice-data').toString('base64'));

      expect(result.ok).toBe(false);
      expect(result.error).toBe('voice-stt-command-missing');
      expect(result.output).toMatchObject({
        configured: {
          stt: true,
          transcribe: false,
        },
      });
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
    }
  });

  it('advertises the built-in local Vosk adapter when no custom command is set', async () => {
    delete process.env.MONARCH_STT_TRANSCRIBE_COMMAND;
    delete process.env.MONARCH_DISABLE_DEFAULT_STT;

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await runtime.kernel.execute({
        id: 'exec_voice_status',
        intentId: 'intent_voice_status',
        moduleId: 'voice',
        capabilityId: 'voice.status',
        input: {},
        createdAt: new Date(0).toISOString(),
        requestedBy: 'test',
      });

      expect(result.ok).toBe(true);
      expect(result.output).toMatchObject({
        configured: {
          transcribe: true,
        },
      });
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
    }
  });

  it.each([
    ['generic kernel', undefined, 0],
    ['explicit desktop policy', '1', 1],
  ])('applies activation STT prewarm only for %s', async (_label, policy, expectedCalls) => {
    delete process.env.MONARCH_STT_TRANSCRIBE_COMMAND;
    delete process.env.MONARCH_DISABLE_DEFAULT_STT;
    if (policy === undefined) delete process.env.MONARCH_STT_PREWARM_ON_ACTIVATE;
    else process.env.MONARCH_STT_PREWARM_ON_ACTIVATE = policy;
    const prepare = vi.fn(async () => ({
      status: 'ready' as const,
      engine: 'vosk' as const,
      model: 'fake-vosk-ru',
      loadMs: 12,
      warm: false,
      pid: 777,
    }));
    const shutdown = vi.fn(async () => undefined);
    const sttRuntime = {
      prepare,
      transcribe: vi.fn(),
      shutdown,
      snapshot: () => ({ state: 'idle' as const, engine: 'vosk' as const }),
    };
    const voice = new VoiceModule(sttRuntime);
    const context = { emit: vi.fn(async () => undefined) } as any;

    await voice.activate(context);
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledTimes(expectedCalls);
    if (expectedCalls) expect(prepare).toHaveBeenCalledWith('ru-RU');
    await voice.deactivate(context);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('transcribes recorded audio through the configured local command', async () => {
    const script = await writeTranscriberScript(`
import { readFileSync } from 'node:fs';

const audioPath = process.argv[2] || '';
const language = process.argv[3] || 'unknown';
const audio = readFileSync(audioPath, 'utf8');
if (!audio.includes('voice-data')) {
  console.error('missing test audio');
  process.exit(2);
}
console.log(JSON.stringify({ text: \`локальный текст \${language}\` }));
`);
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = script.command;

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await executeVoiceTranscribe(
        runtime.kernel,
        Buffer.from('voice-data').toString('base64'),
        { durationMs: 31_000 },
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('Voice input transcribed locally.');
      expect(result.output).toMatchObject({
        transcript: 'локальный текст ru-RU',
        mimeType: 'audio/webm',
        bytes: 'voice-data'.length,
        durationMs: 31_000,
      });
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(script.tempDir, { recursive: true, force: true });
    }
  });

  it('extracts only JSON transcript text when STT stdout contains service logs', async () => {
    const script = await writeTranscriberScript(`
if (process.env.PYTHONIOENCODING !== 'utf-8' || process.env.PYTHONUTF8 !== '1') {
  console.error('utf8 env missing');
  process.exit(2);
}
console.log('LOG (VoskAPI:model.cc:213) beam=10 max-active=3000');
console.log(JSON.stringify({ text: 'чистый текст', engine: 'test' }));
`);
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = script.command;

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await executeVoiceTranscribe(runtime.kernel, Buffer.from('voice-data').toString('base64'));

      expect(result.ok).toBe(true);
      expect(result.output).toMatchObject({
        transcript: 'чистый текст',
      });
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(script.tempDir, { recursive: true, force: true });
    }
  });

  it('does not treat service-only STT stdout as a user transcript', async () => {
    const script = await writeTranscriberScript(`
console.log('LOG (VoskAPI:model.cc:213) beam=10 max-active=3000');
console.log('stderr: local decoder reached a limit');
`);
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = script.command;

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await executeVoiceTranscribe(runtime.kernel, Buffer.from('voice-data').toString('base64'));

      expect(result.ok).toBe(false);
      expect(result.error).toBe('voice-stt-empty-transcript');
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(script.tempDir, { recursive: true, force: true });
    }
  });

  it('rejects voice input only after the long-form 10-minute safety envelope', async () => {
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = 'node runtime/should-not-run.js {audio} {language}';

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await executeVoiceTranscribe(
        runtime.kernel,
        Buffer.from('voice-data').toString('base64'),
        { durationMs: 10 * 60_000 + 1 }
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBe('voice-audio-too-long');
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
    }
  });

  it('returns a stable local STT exit-code error with bounded diagnostics', async () => {
    const script = await writeTranscriberScript(`
console.error('decoder failed because audio could not be read');
process.exit(2);
`);
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = script.command;

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await executeVoiceTranscribe(runtime.kernel, Buffer.from('voice-data').toString('base64'));

      expect(result.ok).toBe(false);
      expect(result.error).toBe('voice-stt-command-exit');
      expect(result.summary).toContain('кодом 2');
      expect(result.output).toMatchObject({
        stderr: expect.stringContaining('decoder failed'),
        exitCode: 2,
      });
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(script.tempDir, { recursive: true, force: true });
    }
  });

  it('preserves a stable error when the selected local language model is unavailable', async () => {
    const script = await writeTranscriberScript(`
console.error('MONARCH_VOICE_ERROR=voice-stt-language-unavailable');
console.error('No matching local model.');
process.exit(2);
`);
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = script.command;

    const runtime = createMonarchRuntime({
      enabledModules: ['voice'],
      enableLocalSystemRouter: false,
    });
    await runtime.kernel.start();
    try {
      const result = await executeVoiceTranscribe(
        runtime.kernel,
        Buffer.from('voice-data').toString('base64'),
        { language: 'uk-UA' },
      );

      expect(result.ok).toBe(false);
      expect(result.error).toBe('voice-stt-language-unavailable');
      expect(result.summary).toContain('нет локальной Vosk-модели');
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(script.tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a configured bridge executable cannot spawn', async () => {
    process.env.MONARCH_STT_COMMAND = path.join(process.cwd(), 'runtime', 'missing-voice-bridge.exe');
    const voice = new VoiceModule();
    const context = { emit: async () => undefined } as any;
    const start = await voice.executeCapability({
      id: 'exec_voice_missing_bridge',
      intentId: 'intent_voice_missing_bridge',
      moduleId: 'voice',
      capabilityId: 'voice.bridge.start',
      input: { bridge: 'stt' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'test',
      confirmed: true,
    }, context);

    expect(start.ok).toBe(false);
    expect(start.error).toBe('voice-bridge-command-invalid');

    const status = await voice.executeCapability({
      id: 'exec_voice_status_after_failed_bridge',
      intentId: 'intent_voice_status_after_failed_bridge',
      moduleId: 'voice',
      capabilityId: 'voice.status',
      input: {},
      createdAt: new Date(0).toISOString(),
      requestedBy: 'test',
    }, context);
    expect(status.output).toMatchObject({ running: { stt: false } });
  });

  it('exposes only transport capabilities; reasoning belongs to the common Agent Runtime', () => {
    const capabilityIds = new VoiceModule().manifest.capabilities.map((capability) => capability.id);

    expect(capabilityIds).toContain('voice.transcribe.prepare');
    expect(capabilityIds.some((id) => id.startsWith('voice.mode.'))).toBe(false);
  });

  it('reaps only exact dead-process transcription temp directories on activation', async () => {
    process.env.MONARCH_DISABLE_DEFAULT_STT = '1';
    const root = await mkdtemp(path.join(process.cwd(), 'runtime', 'voice-temp-reaper-'));
    const runtimePaths = resolveMonarchRuntimePaths(root);
    const tempRoot = path.join(runtimePaths.dataRoot, 'temporary', 'voice');
    const dead = path.join(tempRoot, 'transcribe-999999-deadfixture');
    const active = path.join(tempRoot, `transcribe-${process.pid}-activefixture`);
    const unmarked = path.join(tempRoot, 'keep-user-directory');
    await Promise.all([dead, active, unmarked].map(async (directory) => {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'audio.ogg'), 'fixture', 'utf8');
    }));
    const emit = vi.fn(async () => undefined);
    const voice = new VoiceModule({
      prepare: vi.fn(), transcribe: vi.fn(), shutdown: vi.fn(async () => undefined),
      snapshot: () => ({ state: 'idle' as const, engine: 'vosk' as const }),
    } as any, { workspaceRoot: root, runtimePaths });
    try {
      await voice.activate({ emit } as any);
      expect(await readdir(tempRoot)).toEqual(expect.arrayContaining([
        `transcribe-${process.pid}-activefixture`, 'keep-user-directory',
      ]));
      expect(await readdir(tempRoot)).not.toContain('transcribe-999999-deadfixture');
      expect(emit).toHaveBeenCalledWith('voice.activated', 'voice', expect.objectContaining({
        reapedTemporaryDirectories: 1,
      }));
    } finally {
      await voice.deactivate({ emit } as any);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds worker and temporary paths to the ModuleLoader runtime context', async () => {
    const runtimeFixtures = path.join(process.cwd(), 'runtime');
    await mkdir(runtimeFixtures, { recursive: true });
    const workspaceRoot = await mkdtemp(path.join(runtimeFixtures, 'voice-factory-context-'));
    try {
      const runtime = createMonarchRuntime({
        workspaceRoot, enabledModules: ['voice'], enableLocalSystemRouter: false,
      });
      const voice = runtime.modules.find((module) => module.manifest.id === 'voice') as VoiceModule;
      const paths = voice as unknown as { workspaceRoot: string; audioTempRoot: string };
      expect(paths.workspaceRoot).toBe(path.resolve(workspaceRoot));
      expect(paths.audioTempRoot).toBe(path.join(workspaceRoot, 'data', 'local', 'temporary', 'voice'));
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('cancels the configured transcriber and keeps temporary audio under the runtime data root', async () => {
    const markerId = Math.random().toString(36).slice(2);
    const enteredPath = path.join(process.cwd(), 'runtime', `voice-entered-${markerId}.txt`);
    const latePath = path.join(process.cwd(), 'runtime', `voice-late-${markerId}.txt`);
    const script = await writeTranscriberScript(`
import { writeFileSync } from 'node:fs';
const audioPath = process.argv[2] || '';
writeFileSync(${JSON.stringify(enteredPath)}, audioPath, 'utf8');
setTimeout(() => writeFileSync(${JSON.stringify(latePath)}, 'should-not-survive', 'utf8'), 1000);
setInterval(() => {}, 1000);
`);
    process.env.MONARCH_STT_TRANSCRIBE_COMMAND = script.command;
    const runtime = createMonarchRuntime({ enabledModules: ['voice'], enableLocalSystemRouter: false });
    const controller = new AbortController();
    await runtime.kernel.start();
    try {
      const pending = runtime.kernel.execute({
        id: 'exec_voice_cancelled', intentId: 'intent_voice_cancelled', moduleId: 'voice',
        capabilityId: 'voice.transcribe.audio',
        input: { audioBase64: Buffer.from('voice-data').toString('base64'), mimeType: 'audio/ogg', language: 'ru-RU' },
        createdAt: new Date(0).toISOString(), requestedBy: 'test',
      }, { signal: controller.signal });
      const audioPath = await waitForFile(enteredPath);
      const expectedRoot = path.join(resolveMonarchRuntimePaths(process.cwd()).dataRoot, 'temporary', 'voice');
      expect(path.relative(expectedRoot, audioPath).startsWith('..')).toBe(false);

      const started = Date.now();
      controller.abort(new Error('owner stopped'));
      await expect(pending).resolves.toMatchObject({ ok: false, error: 'voice-stt-cancelled' });
      expect(Date.now() - started).toBeLessThan(1_000);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await expect(readFile(latePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runtime.kernel.stop().catch(() => undefined);
      await rm(script.tempDir, { recursive: true, force: true });
      await rm(enteredPath, { force: true });
      await rm(latePath, { force: true });
    }
  });
});

describe('Voice command policy', () => {
  const workspaceRoot = process.cwd();

  it('allows project-owned Node scripts without a shell', () => {
    expect(parseAndValidateCommand('node runtime/voice-worker.js', workspaceRoot)).toEqual({
      executable: 'node',
      args: ['runtime/voice-worker.js'],
    });
  });

  it('normalizes only supported speech languages before command substitution', () => {
    expect(normalizeSpeechLanguage('ru')).toBe('ru-RU');
    expect(normalizeSpeechLanguage('uk_UA')).toBe('uk-UA');
    expect(normalizeSpeechLanguage('bg-BG')).toBe('bg-BG');
    expect(normalizeSpeechLanguage('en-GB')).toBe('en-US');
    expect(normalizeSpeechLanguage('ru-RU; Write-Output hacked')).toBe('ru-RU');
    expect(normalizeSpeechLanguage('de-DE')).toBeNull();
  });

  it('rejects sibling-prefix paths that are outside the workspace', () => {
    const sibling = path.join(path.dirname(workspaceRoot), `${path.basename(workspaceRoot)}-evil`, 'worker.exe');
    expect(() => parseAndValidateCommand(`"${sibling}"`, workspaceRoot)).toThrow(/outside|authorized workspace|allowed catalog/i);
  });

  it('rejects shell hosts and inline interpreter code for voice commands', () => {
    expect(() => parseAndValidateCommand('cmd.exe /c whoami', workspaceRoot)).toThrow(/not allowed|allowed catalog/i);
    expect(() => parseAndValidateCommand('powershell.exe -EncodedCommand ZQBjAGgAbwA=', workspaceRoot)).toThrow(/not allowed|allowed catalog/i);
    expect(() => parseAndValidateCommand('python -c "print(1)"', workspaceRoot)).toThrow();
    expect(() => parseAndValidateCommand('node -e "console.log(1)"', workspaceRoot)).toThrow();
  });

  it('allows only a project PowerShell file for the explicit model-runner policy', () => {
    expect(parseAndValidateCommand(
      'powershell.exe -ExecutionPolicy Bypass -File scripts/start-model.ps1',
      workspaceRoot,
      { allowShellFile: true },
    )).toEqual({
      executable: 'powershell.exe',
      args: ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/start-model.ps1'],
    });
    expect(() => parseAndValidateCommand(
      'powershell.exe -Command "Get-Process"',
      workspaceRoot,
      { allowShellFile: true },
    )).toThrow(/-File|inline|shell/i);
  });
});

async function writeTranscriberScript(source: string): Promise<{ tempDir: string; command: string }> {
  const runtimeDir = path.join(process.cwd(), 'runtime');
  await mkdir(runtimeDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(runtimeDir, 'voice-test-'));
  const scriptPath = path.join(tempDir, 'transcribe.js');
  const relativeScriptPath = path.relative(process.cwd(), scriptPath).replace(/\\/g, '/');
  await writeFile(scriptPath, source, 'utf8');
  return {
    tempDir,
    command: `node ${relativeScriptPath} {audio} {language}`,
  };
}

function executeVoiceTranscribe(
  kernel: ReturnType<typeof createMonarchRuntime>['kernel'],
  audioBase64: string,
  input: Record<string, unknown> = {}
) {
  return kernel.execute({
    id: `exec_voice_${Math.random().toString(36).slice(2)}`,
    intentId: 'intent_voice_test',
    moduleId: 'voice',
    capabilityId: 'voice.transcribe.audio',
    input: {
      audioBase64,
      mimeType: 'audio/webm;codecs=opus',
      language: 'ru-RU',
      ...input,
    },
    createdAt: new Date(0).toISOString(),
    requestedBy: 'test',
  });
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

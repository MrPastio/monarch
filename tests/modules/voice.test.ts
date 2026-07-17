import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createMonarchRuntime } from '../../src/bootstrap';
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
    const voice = new VoiceModule(undefined, sttRuntime);
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
      const result = await executeVoiceTranscribe(runtime.kernel, Buffer.from('voice-data').toString('base64'));

      expect(result.ok).toBe(true);
      expect(result.summary).toBe('Voice input transcribed locally.');
      expect(result.output).toMatchObject({
        transcript: 'локальный текст ru-RU',
        mimeType: 'audio/webm',
        bytes: 'voice-data'.length,
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

  it('rejects voice input that is too long for quick local recognition before spawning STT', async () => {
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
        { durationMs: 31_000 }
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

  it('classifies a voice turn without loading a model', async () => {
    const voice = new VoiceModule();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = {
      emit: async (event: string, _moduleId: string, payload: unknown) => {
        emitted.push({ event, payload });
      },
    } as any;

    const result = await voice.executeCapability({
      id: 'exec_voice_classify',
      intentId: 'intent_voice_classify',
      moduleId: 'voice',
      capabilityId: 'voice.mode.classify',
      input: { text: 'Оскар, проанализируй архитектуру и сравни варианты' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'ui:voice-mode',
    }, context);

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      lane: 'fast-llm',
      modelRoute: 'gemma4-fast',
    });
    expect(emitted).toContainEqual(expect.objectContaining({ event: 'voice.mode.classified' }));
  });

  it('owns a session-scoped multi-turn context without using standard Oscar history', async () => {
    const voice = new VoiceModule();
    const context = { emit: vi.fn(async () => undefined) } as any;
    const request = (capabilityId: string, input: Record<string, unknown>) => ({
      id: `exec_${capabilityId}`,
      intentId: 'intent_voice_session',
      moduleId: 'voice',
      capabilityId,
      input,
      createdAt: new Date(0).toISOString(),
      requestedBy: 'ui:voice-mode',
    });

    const started = await voice.executeCapability(request('voice.mode.session.start', {}), context);
    const sessionId = String((started.output as any).sessionId);
    const first = await voice.executeCapability(request('voice.mode.classify', {
      sessionId,
      text: 'Кто сейчас премьер России?',
    }), context);
    const firstCandidate = first.output as any;
    await voice.executeCapability(request('voice.mode.session.complete', {
      sessionId,
      turnId: firstCandidate.context.turnId,
      response: 'Премьер-министр России — Михаил Мишустин.',
      actionId: firstCandidate.actionId,
    }), context);

    const followUp = await voice.executeCapability(request('voice.mode.classify', {
      sessionId,
      text: 'А сколько ему лет?',
    }), context);

    expect(followUp.output).toMatchObject({
      lane: 'fast-llm',
      context: {
        contextDependent: true,
        history: [
          { role: 'user', content: 'Кто сейчас премьер России?' },
          { role: 'assistant', content: 'Премьер-министр России — Михаил Мишустин.' },
        ],
      },
    });
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

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

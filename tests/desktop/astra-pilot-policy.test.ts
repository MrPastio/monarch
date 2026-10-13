import { describe, expect, it } from 'vitest';
import { ASTRA_RUNTIME_PILOT_MODE, ASTRA_RUNTIME_PILOT_SWITCH, ASTRA_TELEGRAM_PILOT_MODE,
  ASTRA_TELEGRAM_PILOT_SWITCH, prepareAstraRuntimePilotEnvironment, resolveAstraRuntimePilotMode,
  resolveAstraTelegramPilotMode } from '../../desktop/electron/astra-pilot-policy.mjs';

const journalKey = Buffer.alloc(32, 0x41).toString('base64');

describe('Astra runtime pilot desktop admission', () => {
  it('integrates local tasks into both desktop builds and permits an explicit diagnostic disable', () => {
    expect(resolveAstraRuntimePilotMode({ argv: ['electron'], isPackaged: false })).toBe(ASTRA_RUNTIME_PILOT_MODE);
    expect(resolveAstraRuntimePilotMode({ argv: ['Monarch'], isPackaged: true })).toBe(ASTRA_RUNTIME_PILOT_MODE);
    expect(resolveAstraRuntimePilotMode({ argv: ['Monarch', '--disable-astra-v3'], isPackaged: true })).toBeNull();
  });

  it('admits only the exact source CLI switch outside isolated desktop modes', () => {
    expect(resolveAstraRuntimePilotMode({ argv: ['electron', ASTRA_RUNTIME_PILOT_SWITCH], isPackaged: false })).toBe(ASTRA_RUNTIME_PILOT_MODE);
    expect(resolveAstraRuntimePilotMode({ argv: ['electron', ASTRA_RUNTIME_PILOT_SWITCH], isPackaged: true })).toBe(ASTRA_RUNTIME_PILOT_MODE);
    expect(resolveAstraRuntimePilotMode({ argv: ['electron', ASTRA_RUNTIME_PILOT_SWITCH], isPackaged: false, isolatedMode: true })).toBeNull();
    expect(resolveAstraRuntimePilotMode({ argv: ['electron', '--astra-v3-same-owner-pilot=true'], isPackaged: false })).toBe(ASTRA_RUNTIME_PILOT_MODE);
  });

  it('requires a separate exact switch for Telegram remote reads', () => {
    const base = { argv: ['electron', ASTRA_RUNTIME_PILOT_SWITCH], isPackaged: false,
      runtimeMode: ASTRA_RUNTIME_PILOT_MODE };
    expect(resolveAstraTelegramPilotMode(base)).toBeNull();
    expect(resolveAstraTelegramPilotMode({ ...base, argv: [...base.argv, ASTRA_TELEGRAM_PILOT_SWITCH] }))
      .toBe(ASTRA_TELEGRAM_PILOT_MODE);
    expect(resolveAstraTelegramPilotMode({ ...base, runtimeMode: null,
      argv: [...base.argv, ASTRA_TELEGRAM_PILOT_SWITCH] })).toBeNull();
    expect(resolveAstraTelegramPilotMode({ ...base, isolatedMode: true,
      argv: [...base.argv, ASTRA_TELEGRAM_PILOT_SWITCH] })).toBeNull();
  });

  it('scrubs inherited pilot credentials and authors a fresh exact pair only when admitted', () => {
    const inherited = { KEEP: 'yes', MONARCH_ASTRA_V3_PILOT: ASTRA_RUNTIME_PILOT_MODE,
      MONARCH_ASTRA_V3_HOST_TOKEN: 'attacker', MONARCH_ASTRA_TELEGRAM_MODE: ASTRA_TELEGRAM_PILOT_MODE,
      MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT: 'http://127.0.0.1:9999',
      MONARCH_ASTRA_V3_MODEL_HOST_TOKEN: 'attacker-model-token',
      MONARCH_ASTRA_V3_MODEL_HOST_GENERATION: 'attacker_generation',
      MONARCH_ASTRA_V3_MODEL_DIGEST: 'sha256:' + '0'.repeat(64),
      MONARCH_ASTRA_V3_MODEL_DIGESTS: '{"attacker":"catalog"}', MONARCH_ASTRA_V3_MODEL_MODE: 'local',
      MONARCH_ASTRA_V3_LOCAL_MEMORY: 'owner-settings-v1', MONARCH_ASTRA_V3_JOURNAL_KEY: 'attacker',
      OSCAR_ASTRA_LOCAL_COMPONENT: 'attacker' };
    expect(prepareAstraRuntimePilotEnvironment({ environment: inherited, mode: null, hostToken: 'x'.repeat(64) }))
      .toEqual({ KEEP: 'yes' });
    expect(inherited.MONARCH_ASTRA_V3_HOST_TOKEN).toBe('attacker');
    expect(prepareAstraRuntimePilotEnvironment({ environment: inherited, mode: ASTRA_RUNTIME_PILOT_MODE,
      hostToken: 'x'.repeat(64), journalKey }))
      .toEqual({ KEEP: 'yes', MONARCH_ASTRA_V3_PILOT: ASTRA_RUNTIME_PILOT_MODE,
        MONARCH_ASTRA_V3_HOST_TOKEN: 'x'.repeat(64), MONARCH_ASTRA_V3_JOURNAL_KEY: journalKey });
    expect(prepareAstraRuntimePilotEnvironment({ environment: inherited, mode: ASTRA_RUNTIME_PILOT_MODE,
      telegramMode: ASTRA_TELEGRAM_PILOT_MODE, hostToken: 'x'.repeat(64), journalKey }))
      .toEqual({ KEEP: 'yes', MONARCH_ASTRA_V3_PILOT: ASTRA_RUNTIME_PILOT_MODE,
        MONARCH_ASTRA_V3_HOST_TOKEN: 'x'.repeat(64), MONARCH_ASTRA_V3_JOURNAL_KEY: journalKey,
        MONARCH_ASTRA_TELEGRAM_MODE: ASTRA_TELEGRAM_PILOT_MODE });
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: inherited, mode: null,
      telegramMode: ASTRA_TELEGRAM_PILOT_MODE, hostToken: 'x'.repeat(64) })).toThrow('telegram-authority');
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: inherited, mode: ASTRA_RUNTIME_PILOT_MODE,
      hostToken: 'short', journalKey }))
      .toThrow('astra-pilot-policy:authority');
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: inherited, mode: ASTRA_RUNTIME_PILOT_MODE,
      hostToken: 'x'.repeat(64), journalKey: 'not-a-key' })).toThrow('astra-pilot-policy:authority');
  });

  it('authors managed local discovery without inheriting model identity or granting remote memory export', () => {
    const env = prepareAstraRuntimePilotEnvironment({ environment: { MONARCH_ASTRA_V3_MODEL_MODE: 'max',
      MONARCH_ASTRA_V3_LOCAL_MEMORY: 'owner-settings-v1', OSCAR_ASTRA_LOCAL_COMPONENT: 'attacker' },
      mode: ASTRA_RUNTIME_PILOT_MODE, managedLocal: true, hostToken: 'h'.repeat(43), journalKey });
    expect(env).toEqual({ MONARCH_ASTRA_V3_PILOT: ASTRA_RUNTIME_PILOT_MODE,
      MONARCH_ASTRA_V3_HOST_TOKEN: 'h'.repeat(43), MONARCH_ASTRA_V3_JOURNAL_KEY: journalKey,
      MONARCH_ASTRA_V3_MODEL_MODE: 'managed-local' });
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: {}, mode: null,
      managedLocal: true, hostToken: 'h'.repeat(43) })).toThrow('model-authority');
  });

  it('authors the MAX model endpoint only as a complete child capability under the runtime pilot', () => {
    const modelHost = { endpoint: 'http://127.0.0.1:4319', bearerToken: 'm'.repeat(43),
      hostGeneration: 'max_host_generation', modelDigest: 'sha256:' + 'a'.repeat(64), modelDigests: {
        'openai/gpt-oss-120b': 'sha256:' + 'a'.repeat(64),
        'qwen/qwen3.8-27b': 'sha256:' + 'b'.repeat(64),
      } };
    expect(prepareAstraRuntimePilotEnvironment({ environment: { KEEP: 'yes' }, mode: ASTRA_RUNTIME_PILOT_MODE,
      hostToken: 'h'.repeat(43), journalKey, modelHost })).toEqual({ KEEP: 'yes', MONARCH_ASTRA_V3_PILOT: ASTRA_RUNTIME_PILOT_MODE,
      MONARCH_ASTRA_V3_HOST_TOKEN: 'h'.repeat(43), MONARCH_ASTRA_V3_MODEL_HOST_ENDPOINT: modelHost.endpoint,
      MONARCH_ASTRA_V3_JOURNAL_KEY: journalKey,
      MONARCH_ASTRA_V3_MODEL_HOST_TOKEN: modelHost.bearerToken,
      MONARCH_ASTRA_V3_MODEL_HOST_GENERATION: modelHost.hostGeneration,
      MONARCH_ASTRA_V3_MODEL_DIGEST: modelHost.modelDigest,
      MONARCH_ASTRA_V3_MODEL_DIGESTS: JSON.stringify(modelHost.modelDigests) });
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: {}, mode: null,
      hostToken: 'h'.repeat(43), modelHost })).toThrow('model-authority');
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: {}, mode: ASTRA_RUNTIME_PILOT_MODE,
      hostToken: 'h'.repeat(43), journalKey, modelHost: { ...modelHost, endpoint: 'https://api.groq.com' } }))
      .toThrow('model-authority');
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: {}, mode: ASTRA_RUNTIME_PILOT_MODE,
      hostToken: 'h'.repeat(43), journalKey, modelHost: { ...modelHost,
        modelDigests: { ...modelHost.modelDigests, 'qwen/qwen3.8-27b': modelHost.modelDigests['openai/gpt-oss-120b'] } } }))
      .toThrow('model-authority');
    expect(() => prepareAstraRuntimePilotEnvironment({ environment: {}, mode: ASTRA_RUNTIME_PILOT_MODE,
      hostToken: 'h'.repeat(43), journalKey, modelHost: { ...modelHost, modelDigest: 'sha256:' + 'c'.repeat(64) } }))
      .toThrow('model-authority');
  });
});

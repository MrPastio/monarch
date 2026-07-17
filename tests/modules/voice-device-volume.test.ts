import { describe, expect, it, vi } from 'vitest';
import {
  classifyVoiceVolumeIntent,
  executeVoiceVolumeAction,
  executeVoiceVolumeStatus,
  isVoiceVolumeStatusQuery,
  parseVoiceVolumeAction,
} from '../../src/modules/voice/voice-device-volume';
import { VoiceModule } from '../../src/modules/voice';

describe('voice device volume', () => {
  it('parses absolute, relative, mute, and spoken-number commands deterministically', () => {
    expect(parseVoiceVolumeAction('Поставь громкость на максимум')).toEqual({ action: 'set', value: 100 });
    expect(parseVoiceVolumeAction('Сделай громкость пятьдесят пять процентов')).toEqual({ action: 'set', value: 55 });
    expect(parseVoiceVolumeAction('Сделай на двадцать процентов громче')).toEqual({ action: 'change', delta: 20 });
    expect(parseVoiceVolumeAction('Убавь громкость')).toEqual({ action: 'change', delta: -10 });
    expect(parseVoiceVolumeAction('Выключи звук')).toEqual({ action: 'mute' });
    expect(parseVoiceVolumeAction('Включи звук')).toEqual({ action: 'unmute' });
    expect(parseVoiceVolumeAction('Громкость установи обратно на стол')).toEqual({ action: 'set', value: 100 });
    expect(parseVoiceVolumeAction('На 35 процентов громкость установи')).toEqual({ action: 'set', value: 35 });
    expect(parseVoiceVolumeAction('Звук выключи')).toEqual({ action: 'mute' });
  });

  it('normalizes numeric STT homophones only inside an unambiguous volume set command', () => {
    expect(classifyVoiceVolumeIntent('Громкость установи обратно на стол')).toMatchObject({
      kind: 'action',
      normalizedText: 'громкость установи обратно на сто процентов',
      action: { action: 'set', value: 100 },
      slots: { sttNormalization: 'numeric-homophone' },
    });
    expect(classifyVoiceVolumeIntent('Поставь коробку обратно на стол')).toMatchObject({
      kind: 'none',
      normalizedText: 'поставь коробку обратно на стол',
    });
    expect(parseVoiceVolumeAction('Громкость на стол')).toBeNull();
    expect(parseVoiceVolumeAction('Установи громкость на стол в комнате')).toBeNull();
  });

  it.each([
    'Установи громкость обратно',
    'Громкость 50 процентов',
    'Включи и выключи звук',
    'Не поставь громкость на 50 процентов',
  ])('fails closed for the ambiguous volume command %s', (text) => {
    expect(classifyVoiceVolumeIntent(text)).toMatchObject({
      kind: 'clarification',
      slots: { domain: 'volume', intent: 'clarification' },
    });
    expect(parseVoiceVolumeAction(text)).toBeNull();
  });

  it.each([
    'Сколько времени займет установить громкость на 50 процентов?',
    'Что будет если поставить громкость на максимум?',
    'Как установить громкость на 50 процентов?',
  ])('never mutates for the informational volume context %s', (text) => {
    expect(classifyVoiceVolumeIntent(text).kind).toBe('none');
    expect(parseVoiceVolumeAction(text)).toBeNull();
  });

  it('fails closed for questions and observations instead of mutating the device', () => {
    expect(parseVoiceVolumeAction('У меня громкость на максимум?')).toBeNull();
    expect(parseVoiceVolumeAction('Громкость сейчас 50 процентов?')).toBeNull();
    expect(parseVoiceVolumeAction('Сколько сейчас громкость?')).toBeNull();
    expect(parseVoiceVolumeAction('Можешь поставить громкость на максимум?')).toEqual({ action: 'set', value: 100 });
    expect(isVoiceVolumeStatusQuery('У меня громкость на максимум?')).toBe(true);
    expect(isVoiceVolumeStatusQuery('Поставь громкость на максимум')).toBe(false);
  });

  it('reports the verified current volume without a mutating action or model', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      action: 'get',
      before: 90,
      beforeMuted: false,
      level: 90,
      muted: false,
    });

    await expect(executeVoiceVolumeStatus(run)).resolves.toMatchObject({
      text: 'Сейчас громкость 90%.',
      actionId: 'device.volume.status',
      model: 'none',
      verified: true,
      level: 90,
    });
    expect(run).toHaveBeenCalledWith({ action: 'get' });
  });

  it('reports success only from the reread Windows state', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      action: 'set',
      before: 90,
      beforeMuted: false,
      level: 100,
      muted: false,
    });

    await expect(executeVoiceVolumeAction('Громкость на максимум', run)).resolves.toEqual({
      text: 'Громкость установлена на 100%.',
      actionId: 'device.volume',
      lane: 'scripted',
      model: 'none',
      performed: true,
      status: 'completed',
      verified: true,
      level: 100,
      muted: false,
    });
    expect(run).toHaveBeenCalledWith({ action: 'set', value: 100 });
  });

  it('executes the safely normalized live STT transcript only after normal verification', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      action: 'set',
      before: 30,
      beforeMuted: false,
      level: 100,
      muted: false,
    });

    await expect(executeVoiceVolumeAction('Громкость установи обратно на стол', run))
      .resolves.toMatchObject({ actionId: 'device.volume', level: 100, verified: true });
    expect(run).toHaveBeenCalledWith({ action: 'set', value: 100 });
  });

  it('never claims completion when Windows reports a different level', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true,
      action: 'set',
      before: 90,
      beforeMuted: false,
      level: 90,
      muted: false,
    });

    await expect(executeVoiceVolumeAction('Громкость на максимум', run)).rejects.toMatchObject({
      code: 'voice-volume-unverified',
    });
  });

  it('elevates only the executable volume branch above read risk', () => {
    const voice = new VoiceModule();
    const base = {
      id: 'exec_voice_volume',
      intentId: 'intent_voice_volume',
      moduleId: 'voice',
      capabilityId: 'voice.mode.execute-scripted',
      createdAt: new Date(0).toISOString(),
      requestedBy: 'ui:voice-mode',
    };

    expect(voice.resolveCapabilityRisk({
      ...base,
      input: { text: 'Поставь громкость на максимум' },
    })).toBe('execute');
    expect(voice.resolveCapabilityRisk({
      ...base,
      input: { text: 'Громкость установи обратно на стол' },
    })).toBe('execute');
    expect(voice.resolveCapabilityRisk({
      ...base,
      input: { text: 'Установи громкость обратно' },
    })).toBeUndefined();
    expect(voice.resolveCapabilityRisk({
      ...base,
      input: { text: 'Который час' },
    })).toBeUndefined();
  });
});

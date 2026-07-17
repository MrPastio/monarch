import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readableVoiceError } from '../../src/ui/public/modules/oscar-voice-mode.js';

describe('voice mode truthful runtime copy', () => {
  it('does not misreport every permission or network error as microphone denial', () => {
    expect(readableVoiceError('microphone permission denied')).toBe('Нет доступа к микрофону');
    expect(readableVoiceError('network permission denied')).toBe(
      'Действие заблокировано текущим профилем доступа',
    );
    expect(readableVoiceError('Voice weather provider is temporarily unavailable.')).toBe(
      'Не удалось получить актуальные данные. Попробуй ещё раз чуть позже',
    );
  });

  it('owns a dedicated Voice session lifecycle without submitting to standard chat', () => {
    const source = readFileSync(
      new URL('../../src/ui/public/modules/oscar-voice-mode.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain('startVoiceModeSession');
    expect(source).toContain('completeVoiceModeTurn');
    expect(source).toContain('closeVoiceModeSession');
    expect(source).not.toContain('submitOscarVoiceTurn');
  });

  it('lets the orb interrupt active speech without treating it as a microphone start', () => {
    const voiceMode = readFileSync(
      new URL('../../src/ui/public/modules/oscar-voice-mode.js', import.meta.url),
      'utf8',
    );
    const voiceInput = readFileSync(
      new URL('../../src/ui/public/modules/voice-input.js', import.meta.url),
      'utf8',
    );

    expect(voiceMode).toContain('canActivateWhileBusy');
    expect(voiceMode).toContain('onBusyActivate: interruptSpeech');
    expect(voiceMode).toContain('Нажми круг, чтобы прервать ответ');
    expect(voiceInput).toContain('options.onBusyActivate?.()');
  });
});

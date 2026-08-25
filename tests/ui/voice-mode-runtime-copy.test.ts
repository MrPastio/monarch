import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isWakeOnlyVoiceText,
  readableVoiceError,
} from '../../src/ui/public/modules/oscar-voice-mode.js';

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

  it('submits every ordinary transcript to the common Agent Turn without a private routing loop', () => {
    const source = readFileSync(
      new URL('../../src/ui/public/modules/oscar-voice-mode.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain('executeVoiceAgentTask(text, controller.signal)');
    expect(source).not.toContain('classifyVoiceModeText');
    expect(source).not.toContain('dispatchVoiceModeTurn');
    expect(source).not.toContain('respondVoiceMode');
    expect(source).not.toContain('completeVoiceModeTurn');
  });

  it('keeps only an exact wake word outside Agent Runtime', () => {
    expect(isWakeOnlyVoiceText('Оскар')).toBe(true);
    expect(isWakeOnlyVoiceText(' Oscar! ')).toBe(true);
    expect(isWakeOnlyVoiceText('Оскар, открой Telegram')).toBe(false);
    expect(isWakeOnlyVoiceText('расскажи про Оскара')).toBe(false);
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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  describeSimplifiedVoiceStart,
  isWakeOnlyVoiceText,
  readableVoiceError,
} from '../../src/ui/public/modules/oscar-voice-mode.js';
import {
  parseWakeInvocation,
  parseWakePartialInvocation,
} from '../../src/ui/public/modules/voice-wake-service.js';

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

  it('keeps unknown simplified commands out of Full Voice until the user explicitly disables the default mode', () => {
    const source = readFileSync(
      new URL('../../src/ui/public/modules/oscar-voice-mode.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain('executeVoiceAgentTask(text, controller.signal)');
    expect(source).toContain('executeSimplifiedVoiceCommand(text, controller.signal, {');
    expect(source).toContain("result.status === 'unsupported'");
    // A phrase outside the quick set is asked in the chat instead of a dead end.
    expect(source).toContain('sendTranscriptToChat(text)');
    expect(source).toContain("surface.dataset.speechWarmup = 'system'");
    expect(source).toContain("latencyMode: simplifiedMode ? 'instant' : 'natural'");
    expect(source).toContain('if (!simplifiedMode) {');
    expect(source).not.toContain('classifyVoiceModeText');
    expect(source).not.toContain('dispatchVoiceModeTurn');
    expect(source).not.toContain('respondVoiceMode');
    expect(source).not.toContain('completeVoiceModeTurn');
  });

  it('reacts to a scripted app launch before the backend receipt without model thinking', () => {
    expect(describeSimplifiedVoiceStart('открой Telegram')).toMatchObject({
      title: 'Открываю',
      spokenText: 'Открываю.',
    });
    expect(describeSimplifiedVoiceStart('расскажи про Telegram')).toBeNull();
  });

  it('keeps provider egress explicit, versioned, and revocable in Voice settings', () => {
    const html = readFileSync(new URL('../../src/ui/public/index.html', import.meta.url), 'utf8');
    const settings = readFileSync(new URL('../../src/ui/public/modules/settings-pane.js', import.meta.url), 'utf8');
    expect(html).toContain('id="voice-information-providers"');
    expect(html).toContain('IP и технические сетевые данные');
    expect(html).toContain('История чата, память, файлы и Safe не передаются');
    expect(settings).toContain("VOICE_INFORMATION_PROVIDER_AGREEMENT_VERSION = '2026-08-29.1'");
    expect(settings).toContain('informationProviderConsentedAt');
  });

  it('keeps only an exact wake word outside Agent Runtime', () => {
    expect(isWakeOnlyVoiceText('Оскар')).toBe(true);
    expect(isWakeOnlyVoiceText(' Oscar! ')).toBe(true);
    expect(isWakeOnlyVoiceText('Оскар, открой Telegram')).toBe(false);
    expect(isWakeOnlyVoiceText('расскажи про Оскара')).toBe(false);
  });

  it('accepts bounded T-one phonetic wake variants without fuzzy matching arbitrary text', () => {
    expect(parseWakeInvocation('воскар')).toMatchObject({ matched: true, wakeOnly: true });
    expect(parseWakeInvocation('voscar открой музыку')).toMatchObject({
      matched: true,
      wakeOnly: false,
      command: 'открой музыку',
    });
    expect(parseWakePartialInvocation('воска')).toMatchObject({ matched: true, wakeOnly: true });
    expect(parseWakePartialInvocation('osca')).toMatchObject({ matched: true, wakeOnly: true });
    expect(parseWakePartialInvocation('воска на столе')).toMatchObject({ matched: false });
    expect(parseWakePartialInvocation('расскажи про оскара')).toMatchObject({ matched: false });
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

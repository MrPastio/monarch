import { describe, expect, it } from 'vitest';
import {
  createVoiceModeClarification,
  resolveVoiceModeClarification,
} from '../../src/ui/public/modules/voice-mode-clarification.js';

const fallback = (text: string) => ({
  actionId: 'assistant.fallback',
  normalizedText: text,
  lane: 'voice-lite',
  modelRoute: 'qwen3-1.7b',
  maxNewTokens: 96,
  requiresConfirmation: false,
  usesLlm: true,
  requiresRealtime: false,
  slots: {},
});

describe('voice mode clarification continuity', () => {
  it('turns the next bare city into deterministic realtime weather without an LLM', () => {
    const pending = createVoiceModeClarification({
      actionId: 'weather.query',
      lane: 'scripted',
      slots: {},
    }, 1_000);
    const resolved = resolveVoiceModeClarification(pending, fallback('киев'), 'Киев', 2_000);

    expect(resolved).toMatchObject({
      consumed: true,
      pending: null,
      candidate: {
        actionId: 'weather.query',
        lane: 'voice-realtime',
        modelRoute: 'none',
        usesLlm: false,
        requiresRealtime: true,
        slots: { location: 'киев' },
      },
    });
  });

  it('keeps a pending clarification across a bare wake acknowledgement', () => {
    const pending = { kind: 'weather-location', expiresAt: 31_000 };
    const wake = { ...fallback(''), actionId: 'listen.continue', lane: 'scripted' };
    expect(resolveVoiceModeClarification(pending, wake, 'Оскар', 2_000)).toMatchObject({
      consumed: false,
      pending,
      candidate: { actionId: 'listen.continue' },
    });
  });

  it.each([
    ['50', 50],
    ['на 50 процентов', 50],
    ['пятьдесят', 50],
    ['семьдесят пять процентов', 75],
  ])('turns the bounded volume follow-up %s into a canonical confirmed command', (text, level) => {
    const pending = createVoiceModeClarification({
      actionId: 'device.volume.clarification',
      lane: 'scripted',
      slots: { domain: 'volume', intent: 'clarification' },
    }, 1_000);
    const resolved = resolveVoiceModeClarification(pending, fallback(text), text, 2_000);

    expect(resolved).toMatchObject({
      consumed: true,
      pending: null,
      candidate: {
        actionId: 'device.volume',
        lane: 'scripted',
        risk: 'write',
        requiresConfirmation: true,
        usesLlm: false,
        slots: {
          operation: 'set',
          value: String(level),
          canonicalCommand: `установи громкость на ${level} процентов`,
          clarificationResolved: 'true',
        },
      },
    });
  });

  it.each(['150', 'пятьдесят или шестьдесят', 'на стол', 'сделай погромче'])
    ('keeps unsafe or unrelated volume follow-up %s inside clarification', (text) => {
      const pending = { kind: 'volume-level', expiresAt: 31_000 };
      expect(resolveVoiceModeClarification(pending, fallback(text), text, 2_000)).toMatchObject({
        consumed: true,
        pending,
        candidate: {
          actionId: 'device.volume.clarification',
          lane: 'scripted',
          usesLlm: false,
          slots: {
            canonicalCommand: 'установи громкость',
            clarificationRetry: 'true',
          },
        },
      });
    });

  it('expires and cancels clarification state without routing text to a model', () => {
    const expired = { kind: 'weather-location', expiresAt: 1_500 };
    expect(resolveVoiceModeClarification(expired, fallback('киев'), 'Киев', 2_000)).toMatchObject({
      consumed: false,
      pending: null,
      candidate: { actionId: 'assistant.fallback' },
    });

    const active = { kind: 'weather-location', expiresAt: 31_000 };
    expect(resolveVoiceModeClarification(active, fallback('отмена'), 'Отмена', 2_000)).toMatchObject({
      consumed: true,
      pending: null,
      candidate: {
        actionId: 'listen.continue',
        usesLlm: false,
        slots: { acknowledgement: 'Хорошо.' },
      },
    });
  });
});

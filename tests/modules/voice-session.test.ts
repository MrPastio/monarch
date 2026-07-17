import { describe, expect, it } from 'vitest';
import { VoiceSessionStore } from '../../src/modules/voice/voice-session';

describe('VoiceSessionStore', () => {
  it('keeps bounded multi-turn context inside one ephemeral voice session', () => {
    const store = new VoiceSessionStore();
    const session = store.start();
    const first = store.beginTurn(session.sessionId, 'Кто сейчас премьер России?');

    expect(first.history).toEqual([]);
    store.completeTurn(
      session.sessionId,
      first.turnId,
      'Премьер-министр России — Михаил Мишустин.',
      'web.search',
    );

    const followUp = store.beginTurn(session.sessionId, 'А сколько ему лет?');
    expect(followUp.contextDependent).toBe(true);
    expect(followUp.history).toEqual([
      { role: 'user', content: 'Кто сейчас премьер России?' },
      { role: 'assistant', content: 'Премьер-министр России — Михаил Мишустин.' },
    ]);
    expect(followUp.contextualText).toContain('Текущий запрос: А сколько ему лет?');
  });

  it('expires and forgets the whole context without persisting it', () => {
    let now = 10_000;
    const store = new VoiceSessionStore(1_000, () => now);
    const session = store.start();
    now += 1_001;

    expect(() => store.beginTurn(session.sessionId, 'Продолжай')).toThrowError(/expired/i);
    expect(store.snapshot().activeSessions).toBe(0);
  });
});

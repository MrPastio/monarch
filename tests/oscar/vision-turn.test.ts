import { describe, expect, it, vi } from 'vitest';
import { InMemoryOscarTurnStore, OscarTurnCoordinator, type OscarPersistedMessage } from '../../src/oscar-turn';
import { mapOscarAnswerStream } from '../../src/app/oscar-turn-runtime';

describe('native image failure delivery', () => {
  it('fails visibly once and persists the same explanation without a text-only recovery call', async () => {
    const persisted: OscarPersistedMessage[] = [];
    const fallback = vi.fn(async () => ({ answer: 'Я не вижу прикрепленного изображения.' }));
    async function* backend() {
      yield { type: 'token', data: { token: 'Изображение прикреплено, но Vision недоступен.' } };
      yield { type: 'done', data: { ok: false, usage: { failure_code: 'vision-unavailable', generation_stop_reason: 'error' } } };
    }
    const coordinator = new OscarTurnCoordinator({
      persistentStore: new InMemoryOscarTurnStore(), volatileStore: new InMemoryOscarTurnStore(),
      answerExecutor: async () => mapOscarAnswerStream(backend()),
      answerFallback: fallback, persistMessage: async message => { persisted.push(message); },
      resolveAttachments: async () => [{ id: 'image-1', name: 'picture.png', mimeType: 'image/png',
        sizeBytes: 4, digest: `sha256:${'a'.repeat(64)}`, dataBase64: 'aW1nCg==' }],
    });
    await coordinator.start();
    try {
      const accepted = await coordinator.submit({ text: 'Опиши прикреплённое изображение.',
        clientRequestId: 'vision-request', conversationId: 'vision-chat', source: 'desktop',
        privacyMode: 'persistent', attachmentIds: ['image-1'], modifiers: {} });
      await vi.waitFor(async () => {
        const done = await coordinator.getTurn(accepted.turn.id);
        expect(done?.turn.status).toBe('failed');
        expect(done?.turn.outcome?.summary).toContain('Изображение прикреплено');
        expect(done?.turn.outcome?.diagnostic?.code).toBe('vision-unavailable');
      });
      expect(fallback).not.toHaveBeenCalled();
      expect(persisted.find(message => message.role === 'assistant')?.content).toContain('адаптера Vision');
    } finally { await coordinator.stop(); }
  });
});

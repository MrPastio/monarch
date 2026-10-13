import type { OscarClient } from '../oscar/client';
import type { OscarTurnCoordinator } from '../../oscar-turn';
import type { TelegramConversationBridge, TelegramConversationSummary } from './v2-interface';
import type { TelegramV2Store, TelegramEnvelopeV2 } from './v2-store';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const summary = (value: unknown): TelegramConversationSummary => {
  const v = record(value);
  if (typeof v.id !== 'string' || typeof v.title !== 'string') throw Error('telegram-v2:invalid-history-response');
  return { id: v.id, title: v.title, archived: v.archived === true, localOnly: v.local_only === true || v.privacy_mode === 'incognito' };
};
export function createTelegramOscarBridge(client: OscarClient, coordinator: OscarTurnCoordinator, store: TelegramV2Store): TelegramConversationBridge {
  const allowed = (id: string, epoch?: string) => {
    const s = store.settings();
    if (!s.enabled || s.paused || !s.historyEnabled || epoch !== undefined && epoch !== s.pairingEpoch
      || store.bindings().some(b => b.conversationId === id && b.localOnly)) throw Error('telegram-v2:history-denied');
    return s.pairingEpoch;
  };
  return {
    async list() {
      const epoch = allowed('');
      const items = record(await client.listConversations()).conversations;
      allowed('', epoch);
      if (!Array.isArray(items)) throw Error('telegram-v2:invalid-history-response');
      return items.map(summary).filter(c => !c.localOnly && !store.bindings().some(b => b.conversationId === c.id && b.localOnly));
    },
    async create(title) {
      const epoch = allowed(''); const created = await client.createConversation(title); allowed('', epoch); return summary(created);
    },
    async update(id, patch) {
      const epoch = allowed(id);
      const data = record(await client.getConversation(id, { messageLimit: 1 }));
      if (data.local_only === true || data.privacy_mode === 'incognito') throw Error('telegram-v2:history-denied');
      allowed(id, epoch); await client.updateConversation(id, patch); allowed(id, epoch);
    },
    async messages(id, before) {
      const epoch = allowed(id);
      const data = record(await client.getConversation(id, { messageLimit: 2, ...(before ? { before } : {}) }));
      allowed(id, epoch);
      if (data.local_only === true || data.privacy_mode === 'incognito') throw Error('telegram-v2:history-denied');
      const cursor = record(data.message_page).next_before;
      const messages = Array.isArray(data.messages) ? data.messages.map(record)
        .filter(m => ['user', 'assistant'].includes(String(m.role)) && typeof m.content === 'string')
        .map(m => ({ role: String(m.role), content: String(m.content) })) : [];
      return { messages, ...(typeof cursor === 'number' ? { before: cursor } : {}) };
    },
    async tasks(conversationId) {
      const s = store.settings();
      if (!s.enabled) throw Error('telegram-v2:task-unavailable');
      const tasks = [];
      for (const { actor } of store.list<{ actor: TelegramEnvelopeV2 }>('request').slice(0, 100)) {
        if (actor.pairingEpoch !== s.pairingEpoch || conversationId && actor.conversationId !== conversationId) continue;
        const turn = await coordinator.findTurnByClientRequestId({ clientRequestId: actor.requestId, source: 'telegram', privacyMode: 'persistent' });
        if (turn && !['succeeded', 'failed', 'cancelled', 'blocked'].includes(turn.turn.status)) tasks.push({ id: turn.turn.id, conversationId: actor.conversationId, status: turn.turn.status,
          ...(!store.settings().paused && store.settings().historyEnabled && !store.bindings().some(b => b.conversationId === actor.conversationId && (b.localOnly || b.archived))
            ? { title: turn.turn.request.text.slice(0, 160) } : {}) });
      }
      if (!store.settings().enabled || store.settings().pairingEpoch !== s.pairingEpoch) throw Error('telegram-v2:task-unavailable');
      return tasks;
    },
    async cancel(turnId, conversationId) {
      const turn = await coordinator.getTurn(turnId); const s = store.settings();
      const binding = turn && store.request(turn.turn.clientRequestId);
      if (!s.enabled || !turn || turn.turn.source !== 'telegram' || turn.turn.conversationId !== conversationId || !binding || binding.actor.pairingEpoch !== s.pairingEpoch) throw Error('telegram-v2:task-unavailable');
      await coordinator.cancel(turnId, 'telegram');
    },
  };
}

import { describe, expect, it } from 'vitest';
import {
  OSCAR_AGENT_ACTION_NOTE_MARKER,
  readOscarDurableHistory,
  withoutOscarAgentActionNote,
  type OscarDurableHistoryPorts,
} from '../../src/app/oscar-durable-history';
import type { OscarTurnV1 } from '../../src/oscar-turn';

function ports(overrides: Partial<OscarDurableHistoryPorts> & { messages?: unknown[] } = {}): OscarDurableHistoryPorts {
  return {
    flushOutbox: async () => undefined,
    readConversation: async () => ({ messages: overrides.messages ?? [] }),
    readTurn: async () => null,
    agentActions: () => [],
    ...overrides,
  };
}

describe('readOscarDurableHistory', () => {
  it('gives the model the saved reply of an agent turn together with what it really did', async () => {
    const agentTurn = { id: 'turn_agent', mode: 'agent' } as OscarTurnV1;
    const history = await readOscarDurableHistory('conversation', ports({
      messages: [
        { role: 'user', content: 'Посмотри свою память', turn_id: 'turn_agent' },
        { role: 'assistant', content: 'Да, я сам смотрел свои файлы памяти.', turn_id: 'turn_agent', outcome: 'verified' },
      ],
      readTurn: async (id) => id === 'turn_agent' ? agentTurn : null,
      agentActions: () => [
        { capabilityId: 'memory.list', state: 'observed', ok: true },
        { capabilityId: 'memory.list', state: 'observed', ok: true },
        { capabilityId: 'workspace.files.read', state: 'proposed' },
      ],
    }));
    expect(history).toHaveLength(2);
    expect(history![1]!.content).toContain('Да, я сам смотрел свои файлы памяти.');
    expect(history![1]!.content).toContain('memory.list — успешно ×2');
    expect(history![1]!.content).not.toContain('workspace.files.read');
  });

  it('delivers the just-finished answer before reading, so it is never missing', async () => {
    const saved: unknown[] = [{ role: 'user', content: 'Привет' }];
    const history = await readOscarDurableHistory('conversation', ports({
      flushOutbox: async () => { saved.push({ role: 'assistant', content: 'Привет! Чем помочь?', outcome: 'answered' }); },
      readConversation: async () => ({ messages: saved }),
    }));
    expect(history).toEqual([
      { role: 'user', content: 'Привет' },
      { role: 'assistant', content: 'Привет! Чем помочь?' },
    ]);
  });

  it('leaves error notices and superseded turns out of the model context', async () => {
    const history = await readOscarDurableHistory('conversation', ports({
      messages: [
        { role: 'user', content: 'Новости SpaceX', turn_id: 'turn_failed' },
        { role: 'assistant', content: 'Astra V3 Agent Runtime недоступен.', turn_id: 'turn_failed', outcome: 'blocked' },
        { role: 'user', content: 'Старая формулировка', turn_id: 'turn_old' },
        { role: 'assistant', content: 'Старый ответ', turn_id: 'turn_old', outcome: 'answered' },
        { role: 'system', content: 'служебное' },
      ],
    }), { excludeTurnIds: ['turn_old'] });
    expect(history).toEqual([{ role: 'user', content: 'Новости SpaceX' }]);
  });

  it('keeps an annotated reply within the Turn limit and gives the local store its saved wording back', async () => {
    const saved = 'а'.repeat(20_000);
    const history = await readOscarDurableHistory('conversation', ports({
      messages: [{ role: 'assistant', content: saved, turn_id: 'turn_agent', outcome: 'verified' }],
      readTurn: async () => ({ id: 'turn_agent', mode: 'agent' }) as OscarTurnV1,
      agentActions: () => [{ capabilityId: 'memory.list', state: 'observed', ok: true }],
    }));
    const content = history![0]!.content;
    expect(content.length).toBeLessThanOrEqual(20_000);
    expect(content).toContain(OSCAR_AGENT_ACTION_NOTE_MARKER);
    expect(withoutOscarAgentActionNote(content)).toBe(saved.slice(0, withoutOscarAgentActionNote(content).length));
    expect(withoutOscarAgentActionNote('Обычный ответ')).toBe('Обычный ответ');
  });

  it('treats an unknown conversation as new and an unreadable store as unavailable', async () => {
    await expect(readOscarDurableHistory('new', ports({
      readConversation: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); },
    }))).resolves.toEqual([]);
    await expect(readOscarDurableHistory('down', ports({
      readConversation: async () => { throw new Error('connection refused'); },
    }))).resolves.toBeNull();
    await expect(readOscarDurableHistory('slow', ports({
      readConversation: () => new Promise(() => undefined),
    }), { timeoutMs: 20 })).resolves.toBeNull();
  });
});

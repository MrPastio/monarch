import { describe, expect, it } from 'vitest';
import { maxMemorySources, renderMaxMemoryContext } from '../../src/app/oscar-turn-runtime';
import { OSCAR_MAX_PROMPT } from '../../src/app/oscar-max-prompt';

const recall = {
  explicitMemories: [
    { kind: 'explicit', id: 'rule1', text: 'Отвечай кратко', createdAt: '2026-01-01', reason: 'profile:rule', origin: {} },
    { kind: 'explicit', id: 'about1', text: 'Я живу в Варне', createdAt: '2026-01-01', reason: 'profile:about', origin: {} },
    { kind: 'explicit', id: 'note1', text: 'Ключ у соседа', createdAt: '2026-01-02', reason: 'semantic', origin: {} },
  ],
  episodes: [
    { kind: 'episode', id: 'ep1', text: 'Пользователь: борщ', createdAt: '2026-02-03T10:00:00Z', reason: 'semantic', origin: { conversationId: 'c1' } },
  ],
};

describe('MAX memory context', () => {
  it('labels profile rules, facts and past chats for the cloud model', () => {
    const rendered = renderMaxMemoryContext(recall)!;
    const json = JSON.parse(rendered.slice(rendered.indexOf('{')));
    expect(json.items.map((item: { kind: string }) => item.kind)).toEqual(['rule', 'about', 'owner-saved', 'past-chat']);
    expect(json.items[3]).toMatchObject({ date: '2026-02-03' });
    expect(rendered).toContain('rule — как он просил отвечать');
    expect(renderMaxMemoryContext({ explicitMemories: [], episodes: [] })).toBeNull();
  });

  it('returns the same records as «Из памяти» source cards', () => {
    expect(maxMemorySources(recall).map((source) => source.url)).toEqual([
      'memory://profile/rule1?rule', 'memory://profile/about1', 'memory://explicit/note1', 'memory://chat/c1?item=ep1',
    ]);
    expect(maxMemorySources(recall)[0]!.title).toBe('Из памяти · о тебе');
  });

  it('no longer tells the model that memory was not passed', () => {
    expect(OSCAR_MAX_PROMPT).not.toContain('Сохранённая память Monarch не передана');
    expect(OSCAR_MAX_PROMPT).toContain('нет такого блока — памяти в этом вызове нет');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { buildAssistantModelMessages } from '../../src/modules/assistant';
import type { MonarchKernelContext } from '../../src/core';

describe('assistant local profile context', () => {
  it('injects saved style and only permanent memory into the system prompt', async () => {
    const context = {
      execute: vi.fn(async (request) => request.moduleId === 'profile'
        ? { ok: true, summary: 'ok', output: { profile: {
          adaptiveSummary: 'Работает над Monarch один',
          traits: ['тёплый'],
          styleRules: ['Сначала результат'],
          boundaries: [],
          preferences: { communicationPreset: 'warm' },
        } } }
        : { ok: true, summary: 'ok', output: { records: [
          { text: 'Не удалять чужие изменения', category: 'project', tier: 'permanent', pinned: true },
          { text: 'Временная заметка', category: 'note', tier: 'working', pinned: false },
        ] } }),
      listModules: vi.fn(() => []),
      listCapabilities: vi.fn(() => []),
      getPermissionProfile: vi.fn(() => ({ sandboxMode: 'workspace-write', approvalPolicy: 'on-request' })),
      listRecentIntentJobs: vi.fn(() => []),
    } as unknown as MonarchKernelContext;

    const messages = await buildAssistantModelMessages({ text: 'Привет', context });
    expect(messages[0]?.content).toContain('<monarch_direct_model_policy');
    const localContext = messages.find((message) => message.content.includes('<local_user_context>'))?.content || '';
    expect(localContext).toContain('Сначала результат');
    expect(localContext).toContain('Не удалять чужие изменения');
    expect(localContext).not.toContain('Временная заметка');
    expect(messages[0]?.content.length).toBeLessThan(1800);
  });
});

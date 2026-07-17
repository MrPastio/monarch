import { describe, expect, it } from 'vitest';
import { AssistantModule } from '../../src/modules/assistant';

describe('assistant model override routing', () => {
  it('passes explicit Deep Thinking Extended override from intent context', async () => {
    const module = new AssistantModule();

    const decision = await module.handleIntent({
      id: 'intent_model_override',
      source: 'desktop',
      text: 'Объясни коротко, почему роутер выбрал эту модель?',
      createdAt: new Date(0).toISOString(),
      context: { model_override: 'gemma4-31b' },
    });

    expect(decision?.capabilityId).toBe('assistant.reply');
    expect((decision?.input as any)?.model_override).toBe('gemma4-31b');
  });

  it('drops invalid model overrides before assistant execution', async () => {
    const module = new AssistantModule();

    const decision = await module.handleIntent({
      id: 'intent_invalid_model_override',
      source: 'desktop',
      text: 'Объясни коротко, что такое Monarch?',
      createdAt: new Date(0).toISOString(),
      context: { model_override: 'not-a-model' },
    });

    expect(decision?.capabilityId).toBe('assistant.reply');
    expect((decision?.input as any)?.model_override).toBeUndefined();
  });
});

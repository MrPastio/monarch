import { describe, expect, it } from 'vitest';
import { AssistantModule } from '../../src/modules/assistant';

describe('assistant model override routing', () => {
  it('migrates an explicit retired Extra override to Qwen Pro', async () => {
    const module = new AssistantModule();

    const decision = await module.handleIntent({
      id: 'intent_model_override',
      source: 'desktop',
      text: 'Объясни коротко, почему роутер выбрал эту модель?',
      createdAt: new Date(0).toISOString(),
      context: { model_override: 'gemma4-31b' },
    });

    expect(decision?.capabilityId).toBe('assistant.reply');
    expect((decision?.input as any)?.model_override).toBe('qwen3.8-27b-pro');
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

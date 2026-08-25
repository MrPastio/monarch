import { describe, expect, it, vi } from 'vitest';
import { ImagePromptTranslationError, ImagePromptTranslator } from '../../src/image-generation';

describe('ImagePromptTranslator', () => {
  it('uses one exact Fast request without conversation, memory, or web state', async () => {
    const complete = vi.fn(async () => ({
      choices: [{ message: { content: 'an orange cat in a black car' } }],
    }));
    const translator = new ImagePromptTranslator(complete);

    await expect(translator.translate('рыжий кот в чёрной машине')).resolves.toEqual({
      schemaVersion: 1,
      sourceText: 'рыжий кот в чёрной машине',
      translatedText: 'an orange cat in a black car',
      targetLanguage: 'en',
      model: 'gemma4-fast',
      stateless: true,
      memoryUsed: false,
      webUsed: false,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      model: 'gemma4-fast',
      temperature: 0.1,
      reasoning_effort: 'low',
      inference_lane: 'interactive',
    });
    expect(request?.messages).toHaveLength(2);
    expect(request).not.toHaveProperty('conversationId');
    expect(request).not.toHaveProperty('memory');
    expect(request).not.toHaveProperty('tools');
  });

  it('normalizes fenced model output and rejects empty input', async () => {
    const translator = new ImagePromptTranslator(async () => ({ choices: [{ text: '```english\ncinematic lake\n```' }] }));
    await expect(translator.translate('озеро')).resolves.toMatchObject({ translatedText: 'cinematic lake' });
    await expect(translator.translate('   ')).rejects.toBeInstanceOf(ImagePromptTranslationError);
  });
});

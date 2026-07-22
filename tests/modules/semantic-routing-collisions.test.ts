import { describe, expect, it } from 'vitest';
import { KnowledgeModule, evaluateKnowledgePolicy } from '../../src/modules/knowledge';
import { PluginsModule } from '../../src/modules/plugins';
import { ProfileModule } from '../../src/modules/profile';
import { SharingModule } from '../../src/modules/sharing';
import { VoiceModule } from '../../src/modules/voice';

function intent(text: string): any {
  return { id: 'semantic-route', source: 'desktop', text, createdAt: new Date(0).toISOString() };
}

function voiceModule(): VoiceModule {
  return new VoiceModule({} as any, {} as any);
}

describe('semantic vocabulary does not steal ordinary chat', () => {
  it.each([
    [() => voiceModule(), 'What is the voice of reason?'],
    [() => new SharingModule(), 'Explain the sharing economy'],
    [() => new ProfileModule(), 'What is personal identity?'],
    [() => new PluginsModule(), 'Объясни расширение Вселенной'],
    [() => new KnowledgeModule(), 'Explain current in electricity'],
    [() => new KnowledgeModule(), 'What is today in grammar?'],
  ])('keeps %s local to ordinary assistant reasoning', async (createModule, text) => {
    expect(await createModule().handleIntent(intent(text))).toBeNull();
  });

  it('keeps real module requests routable', async () => {
    expect((await voiceModule().handleIntent(intent('show voice status')))?.capabilityId).toBe('voice.status');
    expect((await new SharingModule().handleIntent(intent('Monarch Sharing status')))?.capabilityId).toBe('sharing.status');
    expect((await new ProfileModule().handleIntent(intent('show profile')))?.capabilityId).toBe('profile.read');
    expect((await new PluginsModule().handleIntent(intent('show plugins')))?.capabilityId).toBe('plugins.catalog.list');
    expect((await new KnowledgeModule().handleIntent(intent('latest OpenAI news')))?.capabilityId).toBe('knowledge.policy.evaluate');
  });

  it.each([
    'Explain current in electricity',
    'What is today in grammar?',
    'Create a daily schedule',
  ])('keeps ambiguous freshness vocabulary out of web policy: %s', (text) => {
    expect(evaluateKnowledgePolicy(text).policy).toBe('local_only');
  });
});

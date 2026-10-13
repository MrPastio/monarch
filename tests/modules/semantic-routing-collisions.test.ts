import { describe, expect, it } from 'vitest';
import { KnowledgeModule, evaluateKnowledgePolicy } from '../../src/modules/knowledge';
import { PluginsModule } from '../../src/modules/plugins';
import { pluginsManifest } from '../../src/modules/plugins/manifest';
import { ProfileModule } from '../../src/modules/profile';
import { SharingModule } from '../../src/modules/sharing';
import { VoiceModule } from '../../src/modules/voice';

function voiceModule(): VoiceModule {
  return new VoiceModule({} as any);
}

describe('typed capability catalogs do not expose phrase routers', () => {
  it('keeps module authority exact and removes handleIntent from every representative module', () => {
    const modules = [voiceModule(), new SharingModule(), new ProfileModule(), new KnowledgeModule()];
    expect(modules.every((module) => !('handleIntent' in module))).toBe(true);
    expect(modules.flatMap((module) => module.manifest.capabilities).map((capability) => capability.id)).toEqual(
      expect.arrayContaining(['voice.status', 'sharing.status', 'profile.read', 'knowledge.policy.evaluate']),
    );
  });

  it('keeps plugin discovery in the typed catalog without phrase activators', () => {
    expect('handleIntent' in new PluginsModule()).toBe(false);
    expect(pluginsManifest.capabilities.every(capability => capability.routing === undefined)).toBe(true);
  });

  it.each([
    'Explain current in electricity',
    'What is today in grammar?',
    'Create a daily schedule',
  ])('keeps ambiguous freshness vocabulary out of web policy: %s', (text) => {
    expect(evaluateKnowledgePolicy(text).policy).toBe('local_only');
  });
});

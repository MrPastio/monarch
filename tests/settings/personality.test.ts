import { describe, expect, it } from 'vitest';
import {
  personalityProfileHash,
  renderPersonalitySystemContext,
  resolvePersonalityContext,
  type PersonalityProfileV2,
} from '../../src/settings';

const PROFILE: PersonalityProfileV2 = {
  schemaVersion: 2,
  id: 'personality-direct',
  variant: 'direct',
  name: 'Прямой',
  revision: 3,
  contentHash: '5acebf090455d12cab06a7c7d8abcd583c774b34cc947c465421976ee672c06d',
  dimensions: {
    brevity: 78,
    warmth: 42,
    directness: 92,
    initiative: 56,
    humor: 18,
    skepticism: 74,
    technicalDepth: 88,
    structure: 76,
  },
  addressForm: 'ты',
  language: 'ru',
  customRules: ['Сначала результат.'],
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:01:00.000Z',
};

describe('Personality V2 contract', () => {
  it('matches the canonical Python SHA-256 profile hash', () => {
    expect(personalityProfileHash(PROFILE)).toBe(PROFILE.contentHash);
  });

  it('resolves only an enabled selected profile with an intact hash', () => {
    const document = {
      schemaVersion: 2,
      enabled: true,
      selectedProfileId: PROFILE.id,
      profiles: [PROFILE],
    };
    expect(resolvePersonalityContext(document)).toMatchObject({
      profileId: PROFILE.id,
      profileRevision: 3,
      profileHash: PROFILE.contentHash,
      variant: 'direct',
    });
    expect(resolvePersonalityContext({ ...document, enabled: false })).toBeNull();
    expect(resolvePersonalityContext({
      ...document,
      profiles: [{ ...PROFILE, dimensions: { ...PROFILE.dimensions, directness: 12 } }],
    })).toBeNull();
  });

  it('renders a style-only context with the immutable binding', () => {
    const context = resolvePersonalityContext({
      schemaVersion: 2,
      enabled: true,
      selectedProfileId: PROFILE.id,
      profiles: [PROFILE],
    })!;
    const rendered = renderPersonalitySystemContext(context);
    expect(rendered).toContain('<monarch_personality_context_v2>');
    expect(rendered).toContain(PROFILE.contentHash);
    expect(rendered).toContain('Style preference only');
    expect(rendered).toContain('Сначала результат.');
  });
});

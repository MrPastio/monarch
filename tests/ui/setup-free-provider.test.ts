import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('first setup: Groq as the free way in', () => {
  it('badges Groq with its model only before anything is picked or connected', () => {
    const source = readFileSync('src/ui/public/modules/model-onboarding.js', 'utf8');
    expect(source).toContain("const freeOffer = !flow.chosenProvider && !flow.providers.some((item) => item.state === 'ready');");
    expect(source).toContain("const freeStart = freeOffer && provider.id === 'groq';");
    expect(source).toContain("freeStart ? 'GPT OSS 120B'");
    expect(source).toContain('<span class="setup-free-badge">Бесплатно</span>');
    expect(readFileSync('src/ui/public/setup-flow.css', 'utf8')).toContain('.setup-free-badge');
  });
});

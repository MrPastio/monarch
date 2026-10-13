import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EARLY_ACCESS_SURFACES } from '../../src/ui/public/modules/early-access-notice.js';

describe('early-alpha notices', () => {
  it('covers voice mode, Coder and Sharing once each, on real surfaces', () => {
    const index = readFileSync('src/ui/public/index.html', 'utf8');
    expect(EARLY_ACCESS_SURFACES.map(item => item.id)).toEqual(['voice', 'coder', 'sharing']);
    for (const surface of EARLY_ACCESS_SURFACES) {
      for (const selector of [surface.host, surface.watch].filter(Boolean)) expect(index).toContain(`id="${selector!.slice(1)}"`);
      expect(surface.text).toMatch(/крайне нестабильно/u);
    }
    const source = readFileSync('src/ui/public/modules/early-access-notice.js', 'utf8');
    expect(source).toContain("remember(surface.id);");
    expect(readFileSync('src/ui/public/app.js', 'utf8')).toContain('initEarlyAccessNotices();');
  });
});

describe('Monarch Security development banner', () => {
  it('sits under the Security tabs until acknowledged once, naming a second line of defence', () => {
    const source = readFileSync('src/ui/public/modules/early-access-notice.js', 'utf8');
    expect(source).toContain("'#security-section .security-chrome'");
    expect(source).toContain('Monarch Security ещё в разработке');
    expect(source).toContain('Microsoft Defender');
    expect(source).toContain("'Я осознаю'");
    expect(source).toContain("remember('security')");
    expect(readFileSync('src/ui/public/app.js', 'utf8')).toContain('mountSecurityDevelopmentBanner();');
  });
});

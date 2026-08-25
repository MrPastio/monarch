import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync('src/ui/public/index.html', 'utf8');
const appSource = readFileSync('src/ui/public/app.js', 'utf8');

describe('removed Projects view', () => {
  it('keeps Projects out of top-level navigation and routing', () => {
    expect(indexSource).not.toContain('id="workspace-section"');
    expect(indexSource).not.toContain('data-scroll-target="workspace-section"');
    expect(appSource).not.toContain("case 'workspace-section'");
    expect(indexSource).toContain('data-scroll-target="images-section"');
  });
});

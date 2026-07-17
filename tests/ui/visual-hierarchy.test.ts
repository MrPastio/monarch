import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellStyles = readFileSync('src/ui/public/styles-v2.css', 'utf8');
const sharingStyles = readFileSync('src/ui/public/sharing.css', 'utf8');

describe('Monarch visual hierarchy', () => {
  it('reserves the warm accent for intent instead of ordinary selection', () => {
    expect(shellStyles).toMatch(/\.nav-item\.active\s*\{[^}]*color:\s*var\(--text\)[^}]*background:\s*var\(--selection-soft\)/s);
    expect(shellStyles).toMatch(/\.settings-tabs button\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--selection-soft\)/s);
    expect(shellStyles).toMatch(/\.claude-primary-btn,\s*\.primary-button\s*\{[^}]*#ffc52c[^}]*#ff971c/s);
    expect(sharingStyles).toMatch(/\.sharing-preset-tabs button\[aria-selected="true"\]\s*\{[^}]*rgba\(255, 255, 255, 0\.085\)/s);
  });

  it('uses neutral glass depth and a consistent card gap', () => {
    expect(shellStyles).toContain('--card-gap: 14px;');
    expect(shellStyles).toContain('--shadow-card:');
    expect(shellStyles).toMatch(/\.models-card-grid\s*\{\s*gap:\s*var\(--card-gap\)/s);
    expect(shellStyles).toMatch(/\.model-record-card\s*\{[^}]*min-height:\s*126px[^}]*padding:\s*16px/s);
    expect(sharingStyles).toMatch(/\.sharing-connect-panel,[\s\S]*?border:\s*1px solid transparent;[\s\S]*?box-shadow:\s*var\(--shadow-card/s);
  });

  it('keeps semantic security states distinct without using accent for structure', () => {
    expect(shellStyles).toMatch(/\.security-title-block \.section-kicker\s*\{\s*color:\s*var\(--muted\)/s);
    expect(shellStyles).toMatch(/\.security-tabs button\[aria-selected="true"\]::after\s*\{\s*background:\s*rgba\(255, 255, 255, 0\.78\)/s);
    expect(shellStyles).toMatch(/\.security-switch input:checked \+ span\s*\{\s*background:\s*rgba\(105, 211, 152, 0\.76\)/s);
  });
});

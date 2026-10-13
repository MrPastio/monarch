import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellStyles = readFileSync('src/ui/public/styles-v2.css', 'utf8');
const sharingStyles = readFileSync('src/ui/public/sharing.css', 'utf8');
const securityStyles = readFileSync('src/ui/public/security-center.css', 'utf8');

describe('Monarch visual hierarchy', () => {
  it('reserves the warm accent for intent instead of ordinary selection', () => {
    expect(shellStyles).toMatch(/\.nav-item\.active\s*\{[^}]*color:\s*var\(--text\)[^}]*background:\s*var\(--selection-soft\)/s);
    expect(shellStyles).toMatch(/\.settings-tabs button\[aria-selected="true"\]\s*\{[^}]*background:\s*var\(--selection-soft\)/s);
    expect(shellStyles).toMatch(/\.claude-primary-btn,\s*\.primary-button\s*\{[^}]*#ffc52c[^}]*#ff971c/s);
    expect(sharingStyles).toMatch(/\.sharing-preset-tabs button\[aria-selected="true"\]\s*\{[^}]*rgba\(var\(--theme-wash-rgb, 255, 255, 255\), 0\.085\)/s);
  });

  it('uses neutral glass depth and a consistent card gap', () => {
    expect(shellStyles).toContain('--card-gap: 14px;');
    expect(shellStyles).toContain('--shadow-card:');
    expect(shellStyles).toMatch(/\.models-card-grid\s*\{\s*gap:\s*var\(--card-gap\)/s);
    expect(shellStyles).toMatch(/\.model-record-card\s*\{[^}]*min-height:\s*126px[^}]*padding:\s*16px/s);
    expect(sharingStyles).toMatch(/\.sharing-connect-panel,[\s\S]*?border:\s*1px solid transparent;[\s\S]*?box-shadow:\s*var\(--shadow-card/s);
  });

  it('keeps semantic security states distinct without using accent for structure', () => {
    // Structure (eyebrow, selected tab text) stays neutral; the accent marks one moving indicator.
    expect(securityStyles).toMatch(/\.security-eyebrow\s*\{\s*color:\s*var\(--sec-muted\)/s);
    expect(securityStyles).toMatch(/\.security-tabs button\[aria-selected="true"\]\s*\{\s*color:\s*var\(--sec-ink\)/s);
    expect(securityStyles).toMatch(/\.security-tab-indicator\s*\{[^}]*background:\s*var\(--sec-accent\)/s);
    // Health is told by its own role, never by the accent.
    expect(securityStyles).toMatch(/\.security-switch input:checked \+ span\s*\{\s*background:\s*var\(--success/s);
    expect(securityStyles).toMatch(/\.security-ring-seg\[data-state="healthy"\]\s*\{\s*stroke:\s*var\(--sec-ok\)/s);
  });

  it('gives the Security center one stylesheet owner', () => {
    for (const file of ['styles-v2.css', 'ui-refresh.css', 'paper-pixel.css', 'white-theme.css', 'compact-layout.css', 'settings-simple.css', 'monarch-design.css']) {
      // `:not(...)` exclusions that keep other layers off Security controls are allowed.
      const source = readFileSync(`src/ui/public/${file}`, 'utf8').replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '');
      expect(source, file).not.toMatch(/\.security-|\.danger-(?:scale|band|mark)/);
    }
  });
});

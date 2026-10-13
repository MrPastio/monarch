import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync('src/ui/public/index.html', 'utf8');
const appSource = readFileSync('src/ui/public/app.js', 'utf8');
const activeStyles = readFileSync('src/ui/public/themes.css', 'utf8');
import { msUntilThemeBoundary, normalizeUiPreferences, resolveTheme, serializeUiPreferences } from '../../src/ui/public/modules/ui-preferences.js';

describe('Monarch theme preference', () => {
  it('defaults to the white theme and rejects arbitrary theme strings', () => {
    for (const theme of [undefined, null, 'system', 'arbitrary']) {
      expect(normalizeUiPreferences({ theme }).theme).toBe('light');
    }
    expect(normalizeUiPreferences({ theme: 'dark' }).theme).toBe('dark');
  });
  it('moves profiles to the white redesign once and keeps a later dark choice', () => {
    expect(indexHtml).toContain("localStorage.getItem('monarch.ui.theme.default') !== 'white-v1'");
    expect(indexHtml).toContain("stored.theme === 'dark' ? 'dark' : 'light'");
    expect(indexHtml).toContain('<body data-theme="light">');
  });
  it('keeps white-theme text readable on pure white', () => {
    const white = readFileSync('src/ui/public/white-theme.css', 'utf8');
    const luminance = (hex: string) => {
      const channels = hex.match(/[a-f\d]{2}/gi)!.map(channel => parseInt(channel, 16) / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    for (const name of ['text', 'text-soft', 'muted', 'theme-amber-ink', 'theme-danger-ink', 'theme-success-ink', 'theme-info-ink', 'ds-accent-ink']) {
      const color = white.match(new RegExp('--' + name + ': (#[a-f0-9]{6})'))![1];
      expect((1 + .05) / (luminance(color) + .05), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('preserves an explicit theme alongside unrelated preferences across reload', () => {
    for (const theme of ['light', 'dark', 'auto']) {
      const original = normalizeUiPreferences({ theme, density: 'compact', contextMeterVisible: false });
      expect(normalizeUiPreferences(JSON.parse(JSON.stringify(serializeUiPreferences(original))))).toEqual(original);
    }
  });
  it('resolves the auto theme from Windows or the clock', () => {
    expect(normalizeUiPreferences({ theme: 'auto' })).toMatchObject({ theme: 'auto', autoTheme: 'system' });
    expect(normalizeUiPreferences({ theme: 'auto', autoTheme: 'time' }).autoTheme).toBe('time');
    expect(normalizeUiPreferences({ autoTheme: 'moon' }).autoTheme).toBe('system');
    const at = (hour: number) => new Date(2026, 8, 26, hour, 30);
    expect(resolveTheme({ theme: 'auto', autoTheme: 'system' }, { systemDark: true })).toBe('dark');
    expect(resolveTheme({ theme: 'auto', autoTheme: 'system' }, { systemDark: false })).toBe('light');
    expect(resolveTheme({ theme: 'auto', autoTheme: 'time' }, { now: at(6) })).toBe('dark');
    expect(resolveTheme({ theme: 'auto', autoTheme: 'time' }, { now: at(12) })).toBe('light');
    expect(resolveTheme({ theme: 'auto', autoTheme: 'time' }, { now: at(21) })).toBe('dark');
    expect(resolveTheme({ theme: 'dark', autoTheme: 'time' }, { now: at(12) })).toBe('dark');
    expect(msUntilThemeBoundary(at(19))).toBe(30 * 60_000);
    expect(msUntilThemeBoundary(at(23))).toBe(7.5 * 3_600_000);
  });
  it('loads the theme before application initialization and synchronizes native chrome', () => {
    expect(indexHtml.indexOf('dataset.theme')).toBeLessThan(indexHtml.indexOf('<body'));
    expect(indexHtml).toContain('<option value="light">');
    expect(appSource).toContain("setTheme?.(followsSystem ? 'system' : theme)");
    expect(activeStyles).toContain('color-scheme: light;');
  });
  it('provides readable light semantic text on the darkest base surface', () => {
    const luminance = (hex: string) => {
      const channels = hex.match(/[a-f\d]{2}/gi)!.map(channel => parseInt(channel, 16) / 255)
        .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    for (const name of ['text', 'text-soft', 'muted', 'theme-amber-ink', 'theme-danger-ink', 'theme-success-ink', 'theme-info-ink']) {
      const color = activeStyles.match(new RegExp('--' + name + ': (#[a-f0-9]{6})'))![1];
      expect((luminance('#f4f0e9') + .05) / (luminance(color) + .05), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});

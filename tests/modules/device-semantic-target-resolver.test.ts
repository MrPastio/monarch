import { describe, expect, it } from 'vitest';
import { resolveSemanticApplicationTarget } from '../../src/modules/device/semantic-target-resolver';
import type { InstalledApplicationCatalogEntry } from '../../src/modules/device/application-resolver';

const catalog: InstalledApplicationCatalogEntry[] = [
  { name: 'YouTube Music', launchId: 'Chrome._crx_music', source: 'start-apps', executableName: 'chrome.exe' },
  { name: 'Telegram Desktop', launchId: 'Telegram.App', source: 'start-apps', executableName: 'Telegram.exe' },
  { name: 'Obsidian', launchId: 'C:/Users/demo/Desktop/Obsidian.lnk', source: 'shortcut', executableName: 'Obsidian.exe' },
];

describe('semantic Windows target resolver', () => {
  it('maps a role request to the only matching installed target', () => {
    const result = resolveSemanticApplicationTarget('музыку', catalog);
    expect(result.status).toBe('unique');
    if (result.status === 'unique') {
      expect(result.role).toBe('media.music');
      expect(result.selected.name).toBe('YouTube Music');
    }
  });

  it('keeps the same mechanism for non-music roles', () => {
    const messaging = resolveSemanticApplicationTarget('мессенджер', catalog);
    const notes = resolveSemanticApplicationTarget('заметки', catalog);
    expect(messaging.status === 'unique' ? messaging.selected.name : '').toBe('Telegram Desktop');
    expect(notes.status === 'unique' ? notes.selected.name : '').toBe('Obsidian');
  });

  it('fails closed on multiple role candidates unless a preference resolves them', () => {
    const candidates = [
      ...catalog,
      { name: 'Spotify', launchId: 'Spotify.App', source: 'start-apps' as const, executableName: 'Spotify.exe' },
    ];
    expect(resolveSemanticApplicationTarget('музыку', candidates).status).toBe('ambiguous');
    const preferred = resolveSemanticApplicationTarget('музыку', candidates, {
      preferredTargetByRole: { 'media.music': 'spotify' },
    });
    expect(preferred.status === 'unique' ? preferred.selected.name : '').toBe('Spotify');
  });
});

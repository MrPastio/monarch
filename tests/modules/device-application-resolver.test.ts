import { describe, expect, it } from 'vitest';
import {
  rankInstalledApplications,
  resolveInstalledApplication,
  sanitizeInstalledApplicationCatalog,
  type InstalledApplicationCatalogEntry,
} from '../../src/modules/device/application-resolver';

const CATALOG: InstalledApplicationCatalogEntry[] = [
  { name: 'Paint', launchId: 'Microsoft.Paint_8wekyb3d8bbwe!App', source: 'start-apps', executableName: 'mspaint.exe' },
  { name: 'Figma', launchId: 'com.squirrel.Figma.Figma', source: 'start-apps', executableName: 'Figma.exe' },
  { name: 'Logitech G HUB', launchId: 'LGHUB/system_tray/lghub_system_tray.exe', source: 'start-apps', executableName: 'lghub_system_tray.exe' },
  { name: 'Microsoft Word', launchId: 'Word.Application', source: 'start-apps', executableName: 'WINWORD.EXE' },
  { name: 'Adobe Photoshop 2026', launchId: 'Adobe.Photoshop', source: 'start-apps', executableName: 'Photoshop.exe' },
  { name: 'Steam', launchId: 'Steam/steam.exe', source: 'start-apps', executableName: 'steam.exe' },
  { name: 'SteamVR', launchId: 'steam://rungameid/250820', source: 'start-apps' },
  { name: 'Telegram Desktop', launchId: 'TelegramMessenger.TelegramDesktop!App', source: 'start-apps' },
  { name: 'Google Chrome', launchId: 'Chrome', source: 'start-apps' },
  { name: 'Discord', launchId: 'com.squirrel.Discord.Discord', source: 'start-apps' },
  { name: 'Visual Studio Code', launchId: 'Microsoft.VisualStudioCode', source: 'start-apps' },
  { name: 'Калькулятор', launchId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', source: 'start-apps', executableName: 'CalculatorApp.exe' },
];

describe('generic Windows application resolver', () => {
  it.each([
    ['пеинт', 'Paint'],
    ['фигму', 'Figma'],
    ['логитеч хаб', 'Logitech G HUB'],
    ['ворд', 'Microsoft Word'],
    ['фотошоп', 'Adobe Photoshop 2026'],
    ['калькулятор', 'Калькулятор'],
    ['ыеуфь', 'Steam'],
    ['rfkmrekznjh', 'Калькулятор'],
    ['ntktuhfv', 'Telegram Desktop'],
    ['стим', 'Steam'],
    ['телеграм', 'Telegram Desktop'],
    ['хром', 'Google Chrome'],
    ['дискорд', 'Discord'],
    ['вижуал студио код', 'Visual Studio Code'],
  ])('resolves %s without an application-specific alias', (query, expected) => {
    const resolution = resolveInstalledApplication(query, CATALOG);
    expect(resolution.status, JSON.stringify(resolution)).toBe('unique');
    if (resolution.status === 'unique') expect(resolution.selected.name).toBe(expected);
  });

  it('fails closed when two applications are equally plausible', () => {
    const result = resolveInstalledApplication('steam', CATALOG);
    expect(result.status).toBe('unique');
    const ambiguous = resolveInstalledApplication('steam v', [
      { name: 'Steam Video', launchId: 'one', source: 'start-apps' },
      { name: 'Steam Voice', launchId: 'two', source: 'start-apps' },
    ]);
    expect(ambiguous.status).toBe('ambiguous');
  });

  it('does not let prefix matches tie with an exact keyboard-layout match', () => {
    const result = resolveInstalledApplication('ыеуфь', [
      { name: 'Steam', launchId: 'one', source: 'start-apps' },
      { name: 'SteamVR', launchId: 'two', source: 'start-apps' },
      { name: 'Steam Support Center', launchId: 'three', source: 'start-apps' },
      { name: 'Age of History II Definitive Edition', launchId: 'steam://rungameid/3381680', source: 'start-apps' },
    ]);
    expect(result.status).toBe('unique');
    if (result.status === 'unique') expect(result.selected.name).toBe('Steam');
    expect(result.candidates.find((entry) => entry.name.startsWith('Age of History'))?.score || 0).toBeLessThan(0.8);
  });

  it('prefers a user-facing Start application over an App Paths helper executable match', () => {
    const result = resolveInstalledApplication('хром', [
      { name: 'Google Chrome', launchId: 'Chrome', source: 'start-apps' },
      {
        name: 'iCloud for Windows',
        launchId: 'C:/Program Files/WindowsApps/Apple/iCloudChrome.exe',
        executableName: 'iCloudChrome.exe',
        source: 'app-path',
      },
    ]);
    expect(result.status).toBe('unique');
    if (result.status === 'unique') expect(result.selected.name).toBe('Google Chrome');
  });

  it('penalizes a short same-script prefix when a full transliterated product name matches', () => {
    const result = resolveInstalledApplication('дискорд', [
      { name: 'Discord', launchId: 'discord', source: 'start-apps' },
      { name: 'Диск восстановления', launchId: 'recovery-drive', source: 'start-apps' },
    ]);
    expect(result.status).toBe('unique');
    if (result.status === 'unique') expect(result.selected.name).toBe('Discord');
  });

  it('does not auto-select a weak semantic guess', () => {
    const result = resolveInstalledApplication('рисовалка', CATALOG);
    expect(result.status).toBe('missing');
  });

  it('uses the invariant AUMID product identity when the visible Windows name is localized', () => {
    const result = resolveInstalledApplication('Photos', [
      {
        name: 'Фотографии',
        launchId: 'Microsoft.Windows.Photos_8wekyb3d8bbwe!App',
        source: 'start-apps',
      },
    ]);

    expect(result.status, JSON.stringify(result)).toBe('unique');
    if (result.status === 'unique') {
      expect(result.selected).toMatchObject({
        name: 'Фотографии',
        launchId: 'Microsoft.Windows.Photos_8wekyb3d8bbwe!App',
      });
      expect(result.selected.score).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('prefers a Start application over a duplicate App Paths entry', () => {
    const ranked = rankInstalledApplications('Paint', [
      ...CATALOG,
      { name: 'Paint', launchId: 'C:/Windows/System32/mspaint.exe', source: 'app-path', executableName: 'mspaint.exe' },
    ]);
    expect(ranked.filter((entry) => entry.name === 'Paint')).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ name: 'Paint', source: 'start-apps', score: 1 });
  });

  it('sanitizes and bounds OS catalog data before scoring it', () => {
    expect(sanitizeInstalledApplicationCatalog([
      { name: ' Paint\u0000 ', appId: 'Microsoft.Paint', source: 'start-apps' },
      { name: 'Documentation', appId: 'https://example.com/docs', source: 'start-apps' },
      { name: 'Manual', appId: 'C:/Product/manual.pdf', source: 'start-apps' },
      { name: '', appId: 'missing-name', source: 'start-apps' },
      { name: 'Unknown source', appId: 'fixture', source: 'untrusted' },
      'not-an-entry',
    ])).toEqual([{ name: 'Paint', launchId: 'Microsoft.Paint', source: 'start-apps' }]);
  });
});

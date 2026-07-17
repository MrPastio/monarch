import { describe, expect, it } from 'vitest';
import {
  SAFE_FILE_FORMAT_GROUPS,
  SAFE_FILE_FORMATS,
  getSafeFileFormat,
  isSafeEditableTextMime,
  seedSafeFileContent,
  withSafeFileExtension,
} from '../../desktop/safe/file-formats.mjs';

describe('Monarch Safe file creation formats', () => {
  it('offers a broad grouped catalog without duplicate identifiers', () => {
    expect(SAFE_FILE_FORMAT_GROUPS.map((group) => group.label)).toEqual(expect.arrayContaining([
      'PowerShell',
      'Shell и автоматизация',
      'Web',
      'Языки программирования',
      'Данные и конфигурация',
    ]));
    expect(SAFE_FILE_FORMATS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(SAFE_FILE_FORMATS.map((format) => format.id)).size).toBe(SAFE_FILE_FORMATS.length);
  });

  it('covers the PowerShell-specific file family', () => {
    const powershell = SAFE_FILE_FORMAT_GROUPS.find((group) => group.label === 'PowerShell');
    expect(powershell?.formats.map((format) => format.extension)).toEqual(expect.arrayContaining([
      '.ps1',
      '.psm1',
      '.psd1',
      '.ps1xml',
      '.types.ps1xml',
      '.format.ps1xml',
      '.pssc',
      '.psrc',
      '.cdxml',
      '.clixml',
      '.psc1',
      '.xaml',
    ]));
  });

  it('adds the selected extension once and keeps compatible aliases', () => {
    expect(withSafeFileExtension('deploy', 'powershell-script')).toBe('deploy.ps1');
    expect(withSafeFileExtension('module.PSM1', 'powershell-module')).toBe('module.PSM1');
    expect(withSafeFileExtension('compose.yml', 'data-yaml')).toBe('compose.yml');
    expect(withSafeFileExtension('notes', 'text/markdown')).toBe('notes.md');
  });

  it('preserves existing MIME-backed choices and provides useful local seeds', () => {
    expect(getSafeFileFormat('text/markdown').mime).toBe('text/markdown');
    expect(getSafeFileFormat('application/json').extension).toBe('.json');
    expect(seedSafeFileContent('powershell-script')).toContain('[CmdletBinding()]');
    expect(seedSafeFileContent('powershell-clixml')).toContain('#< CLIXML');
  });

  it('keeps every creatable source format in the bounded text editor', () => {
    const sourceFormats = SAFE_FILE_FORMATS.filter((format) => format.mime !== 'application/octet-stream');
    expect(sourceFormats.every((format) => isSafeEditableTextMime(format.mime))).toBe(true);
  });
});

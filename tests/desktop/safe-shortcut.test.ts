import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSafeShortcutDetails, safeShortcutPath } from '../../desktop/electron/safe-shortcut.mjs';

describe('Monarch Safe shortcut', () => {
  it('creates a packaged launcher that opens only the Safe entry', () => {
    const details = buildSafeShortcutDetails({
      executablePath: 'E:\\Monarch\\Monarch.exe',
      appEntryPath: 'E:\\Monarch\\desktop\\electron\\main.mjs',
      iconPath: 'E:\\Monarch\\assets\\safe\\monarch-safe.ico',
      packaged: true,
    });
    expect(details).toMatchObject({
      target: 'E:\\Monarch\\Monarch.exe',
      cwd: 'E:\\Monarch',
      args: '--safe',
      appUserModelId: 'Monarch.Safe',
    });
  });

  it('uses a dedicated desktop filename and quotes the development entrypoint', () => {
    expect(safeShortcutPath('C:\\Users\\Anton\\Desktop')).toBe(path.join('C:\\Users\\Anton\\Desktop', 'Monarch Safe.lnk'));
    expect(buildSafeShortcutDetails({
      executablePath: 'C:\\Program Files\\node.exe',
      appEntryPath: 'E:\\Monarch Work\\desktop\\electron\\main.mjs',
      iconPath: 'E:\\Monarch Work\\assets\\safe\\monarch-safe.ico',
    }).args).toBe('"E:\\Monarch Work\\desktop\\electron\\main.mjs" --safe');
  });
});

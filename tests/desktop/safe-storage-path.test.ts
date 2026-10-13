import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSafeMainStorageRoot, resolveSafeStorageRoot } from '../../desktop/electron/safe-storage-path.mjs';

describe('Monarch Safe storage location', () => {
  it('stores the real vault in MonarchData on the Monarch drive', () => {
    expect(resolveSafeStorageRoot({ workspaceRoot: 'E:\\Monarch' })).toBe(
      path.win32.normalize('E:\\MonarchData\\Safe\\safe-v1'),
    );
  });

  it('keeps entry QA isolated in its temporary Electron profile', () => {
    expect(resolveSafeStorageRoot({
      workspaceRoot: 'E:\\Monarch',
      qaUserDataRoot: 'C:\\Temp\\monarch-safe-entry-qa',
    })).toBe(path.win32.normalize('C:\\Temp\\monarch-safe-entry-qa\\safe-v1'));
  });

  it('prioritizes the isolated QA profile over an installed configuration root', () => {
    expect(resolveSafeMainStorageRoot({
      workspaceRoot: 'E:\\Monarch',
      qaUserDataRoot: 'E:\\MonarchArtifacts\\safe-qa-profile',
      installedConfigRoot: 'E:\\MonarchData',
    })).toBe(path.win32.normalize('E:\\MonarchArtifacts\\safe-qa-profile\\safe-v1'));
  });
});

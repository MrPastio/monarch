import { describe, expect, it } from 'vitest';
import { resolveDesktopUpdatePolicy } from '../../desktop/electron/update-policy.mjs';

describe('desktop update policy', () => {
  it('never offers release installation from a development workspace', () => {
    expect(resolveDesktopUpdatePolicy({
      isPackaged: false,
      fallbackVersion: '0.2.3.2',
    })).toEqual({
      mode: 'development',
      canInstall: false,
      currentVersion: '0.2.3.2',
      reason: 'development-workspace',
    });
  });

  it('enables updates only for a consistent installed launcher layout', () => {
    expect(resolveDesktopUpdatePolicy({
      isPackaged: true,
      fallbackVersion: '0.2.3.2',
      installRoot: 'E:\\Monarch App',
      payloadRoot: 'E:\\MonarchData',
      installedDescriptor: { appVersion: '0.2.3.4' },
      installedPointer: { currentVersion: '0.2.3.4' },
      installedLayout: { schemaVersion: 1, payloadRoot: 'E:\\MonarchData' },
    })).toEqual({
      mode: 'installed',
      canInstall: true,
      currentVersion: '0.2.3.4',
      reason: null,
    });
  });

  it('fails closed when launcher pointer and running binaries disagree', () => {
    expect(resolveDesktopUpdatePolicy({
      isPackaged: true,
      fallbackVersion: '0.2.3.2',
      installRoot: 'E:\\Monarch App',
      payloadRoot: 'E:\\MonarchData',
      installedDescriptor: { appVersion: '0.2.3.3' },
      installedPointer: { currentVersion: '0.2.3.4' },
      installedLayout: { schemaVersion: 1, payloadRoot: 'E:\\MonarchData' },
    })).toMatchObject({
      mode: 'unsupported',
      canInstall: false,
      currentVersion: '0.2.3.3',
      reason: 'installed-version-mismatch',
    });
  });

  it('fails closed when the launcher layout points at another payload root', () => {
    expect(resolveDesktopUpdatePolicy({
      isPackaged: true,
      fallbackVersion: '0.2.3.2',
      installRoot: 'E:\\Monarch App',
      payloadRoot: 'E:\\MonarchData',
      installedDescriptor: { appVersion: '0.2.3.4' },
      installedPointer: { currentVersion: '0.2.3.4' },
      installedLayout: { schemaVersion: 1, payloadRoot: 'E:\\OtherMonarchData' },
    })).toMatchObject({
      mode: 'unsupported',
      canInstall: false,
      reason: 'installed-layout-missing',
    });
  });
});

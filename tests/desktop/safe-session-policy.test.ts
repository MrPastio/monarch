import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ownsSafeSessionResource } from '../../desktop/electron/safe-session-policy.mjs';

describe('Monarch Safe session identity policy', () => {
  it('accepts cleanup only for the currently active runtime resource', () => {
    const oldRuntime = {};
    const reopenedRuntime = {};

    expect(ownsSafeSessionResource(oldRuntime, oldRuntime)).toBe(true);
    expect(ownsSafeSessionResource(reopenedRuntime, oldRuntime)).toBe(false);
    expect(ownsSafeSessionResource(null, oldRuntime)).toBe(false);
    expect(ownsSafeSessionResource(reopenedRuntime, null)).toBe(false);
  });

  it('keeps an old exit/close callback from owning a reopened window or capability key', () => {
    const oldWindow = {};
    const reopenedWindow = {};
    const oldCapabilityKey = Buffer.alloc(32, 1);
    const reopenedCapabilityKey = Buffer.alloc(32, 2);

    expect(ownsSafeSessionResource(reopenedWindow, oldWindow)).toBe(false);
    expect(ownsSafeSessionResource(reopenedCapabilityKey, oldCapabilityKey)).toBe(false);
    expect(ownsSafeSessionResource(reopenedWindow, reopenedWindow)).toBe(true);
    expect(ownsSafeSessionResource(reopenedCapabilityKey, reopenedCapabilityKey)).toBe(true);
  });

  it('binds Electron exit and close cleanup to captured session resources', async () => {
    const source = await readFile('desktop/electron/main.mjs', 'utf8');

    expect(source).toContain("launchedSafeProcess.once('exit'");
    expect(source).toContain('ownsSafeSessionResource(safeProcess, launchedSafeProcess)');
    expect(source).toContain('stopSafeRuntime(launchedSafeProcess, launchedCapabilityKey)');
    expect(source).toContain('closeSafeForSystemBoundary(launchedSafeWindow, launchedSafeProcess, launchedCapabilityKey)');
  });

  it('does not pass Electron powerMonitor event objects as Safe windows', async () => {
    const source = await readFile('desktop/electron/main.mjs', 'utf8');

    expect(source).toContain("powerMonitor.on('lock-screen', () => closeSafeForSystemBoundary())");
    expect(source).toContain("powerMonitor.on('suspend', () => closeSafeForSystemBoundary())");
    expect(source).not.toContain("powerMonitor.on('lock-screen', closeSafeForSystemBoundary)");
    expect(source).not.toContain("powerMonitor.on('suspend', closeSafeForSystemBoundary)");
    expect(source).toContain("typeof targetWindow.isDestroyed === 'function'");
    expect(source).toContain("typeof targetWindow.destroy === 'function'");
  });
});

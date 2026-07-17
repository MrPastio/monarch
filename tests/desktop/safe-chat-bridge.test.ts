import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtime = readFileSync('desktop/safe/runtime.mjs', 'utf8');
const main = readFileSync('desktop/electron/main.mjs', 'utf8');
const preload = readFileSync('desktop/electron/preload.mjs', 'utf8');

describe('Monarch Safe chat bridge boundary', () => {
  it('exposes only chat-scoped Safe service actions to the main renderer', () => {
    expect(runtime).toContain("case 'chatStatus'");
    expect(runtime).toContain("case 'chatList'");
    expect(runtime).toContain("case 'chatRead'");
    expect(runtime).toContain("case 'chatUpsert'");
    expect(runtime).toContain("case 'chatDelete'");
    expect(runtime).toContain("case 'chatLock'");
    expect(runtime).toContain('unsupported-service-action');
    expect(preload).toContain("ipcRenderer.invoke('monarch:safe-chat-upsert'");
    expect(preload).not.toContain('unlockSafe');
    expect(preload).not.toContain('readSafeFile');
  });

  it('binds every mutating chat IPC operation to the trusted main renderer', () => {
    expect(main).toContain("ipcMain.handle('monarch:safe-chat-upsert'");
    expect(main).toContain("ipcMain.handle('monarch:safe-chat-delete'");
    expect(main).toContain("ipcMain.handle('monarch:safe-chat-lock'");
    expect(main.match(/assertTrustedMainRenderer\(event\);/g)?.length).toBeGreaterThanOrEqual(5);
    expect(main).toContain("error.code = 'untrusted-renderer'");
  });

  it('clears outstanding requests and reports a sealed state when Safe closes', () => {
    expect(main).toContain('rejectSafeServiceRequests(processToStop');
    expect(main).toContain("emitSafeChatStatus({ runtime: false, unlocked: false })");
    expect(runtime).toContain("emitParentStatus('auto-lock', status)");
  });
});

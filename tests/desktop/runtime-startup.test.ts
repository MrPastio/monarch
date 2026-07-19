import { describe, expect, it } from 'vitest';
import { waitForRuntimeReady } from '../../desktop/electron/runtime-startup.mjs';

describe('Electron runtime startup', () => {
  it('allows a cold Windows startup to exceed the former 15 second deadline', async () => {
    let clock = 0;
    let attempts = 0;

    const health = await waitForRuntimeReady({
      fetchHealth: async () => {
        attempts += 1;
        if (attempts < 5) throw new Error('connect ECONNREFUSED 127.0.0.1:4317');
        return { ok: true };
      },
      timeoutMs: 60_000,
      now: () => clock,
      delay: async () => {
        clock += 5_000;
      },
    });

    expect(clock).toBe(20_000);
    expect(health).toEqual({ ok: true });
  });

  it('fails immediately with both runtime logs when the child exits', async () => {
    let exited = false;

    await expect(waitForRuntimeReady({
      fetchHealth: async () => {
        exited = true;
        throw new Error('connect ECONNREFUSED 127.0.0.1:4317');
      },
      getProcessExit: () => exited ? { code: 1, signal: null } : null,
      readErrorLog: async () => 'Error: Cannot find package runtime-dependency',
      errorLogPath: 'E:\\Programs\\Monarch\\runtime\\electron-server-4317.err.log',
      readOutputLog: async () => '[startup] Activating module security...',
      outputLogPath: 'E:\\Programs\\Monarch\\runtime\\electron-server-4317.out.log',
      delay: async () => undefined,
    })).rejects.toThrow(
      /runtime exited before startup \(1\)[\s\S]*err\.log[\s\S]*out\.log[\s\S]*Cannot find package[\s\S]*Activating module security/,
    );
  });

  it('reports a bounded timeout and the last connection error', async () => {
    let clock = 0;

    await expect(waitForRuntimeReady({
      fetchHealth: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:4317');
      },
      timeoutMs: 3_000,
      now: () => clock,
      delay: async () => {
        clock += 1_000;
      },
    })).rejects.toThrow(
      /did not become ready within 3 seconds[\s\S]*ECONNREFUSED/,
    );
  });
});

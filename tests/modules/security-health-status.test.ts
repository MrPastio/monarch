import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core';
import { SecurityModule } from '../../src/modules/security';
import { boundStateHistory } from '../../src/app/http-server';

const statusResult = (running: boolean) => ({
  ok: true, exitCode: 0, args: ['status'], stdout: '', stderr: '', jsonLines: [{ ok: true, running }],
});

class FakeStatusClient {
  readonly config = { projectRoot: 'E:\\Monarch\\security', configPath: 'config.toml', pythonPath: 'python', timeoutMs: 30_000 };
  readonly available = true;
  status = vi.fn(async () => statusResult(true));
  backgroundBenchmarkStatus() { return null; }
  dispose() {}
}

function securityHealth(health: Awaited<ReturnType<MonarchKernel['checkHealth']>>) {
  return health.modules.find((entry) => entry.moduleId === 'security')!.health!;
}

describe('Security health without a helper start on every state read', () => {
  let kernel: MonarchKernel | null = null;
  afterEach(async () => { vi.useRealTimers(); await kernel?.stop(); kernel = null; });

  it('reuses the last protector status, refreshes it in the background when stale, and never pins a failure as ok', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const client = new FakeStatusClient();
    kernel = new MonarchKernel({ permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new SecurityModule(client as never));
    await kernel.start();

    // The first read waits for a status; the next ones reuse it.
    expect(securityHealth(await kernel.checkHealth()).ok).toBe(true);
    await kernel.checkHealth(); await kernel.checkHealth();
    expect(client.status).toHaveBeenCalledTimes(1);

    // Stale: the old status is shown while one fresh read runs.
    vi.setSystemTime(Date.now() + 16_000);
    client.status.mockRejectedValueOnce(new Error('helper-down'));
    expect(securityHealth(await kernel.checkHealth()).ok).toBe(true);
    await vi.waitFor(() => expect(client.status).toHaveBeenCalledTimes(2));
    // The failed read is reported, not hidden behind the earlier success.
    await vi.waitFor(async () => expect(securityHealth(await kernel!.checkHealth()).ok).toBe(false));
  });

  it('the Security pane status is always a fresh read', async () => {
    const client = new FakeStatusClient();
    kernel = new MonarchKernel({ permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    kernel.registerModule(new SecurityModule(client as never));
    await kernel.start();
    await kernel.checkHealth();
    const request = { id: 'status', intentId: 'status-intent', moduleId: 'security', capabilityId: 'security.status',
      input: {}, createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: false };
    await kernel.execute(request); await kernel.execute({ ...request, id: 'status-2' });
    expect(client.status).toHaveBeenCalledTimes(3);
  });
});

describe('UI state reply', () => {
  it('carries the newest kernel history, not all of it', () => {
    const events = Array.from({ length: 120 }, (_, index) => ({ id: `e${index}` }));
    const audit = Array.from({ length: 80 }, (_, index) => ({ id: `a${index}` }));
    const state = { runtime: { snapshot: { modules: [], capabilities: [], events, audit } } } as never;
    const bounded = boundStateHistory(state) as unknown as { runtime: { snapshot: { events: Array<{ id: string }>; audit: Array<{ id: string }> } } };
    expect(bounded.runtime.snapshot.events).toHaveLength(50);
    expect(bounded.runtime.snapshot.events.at(-1)!.id).toBe('e119');
    expect(bounded.runtime.snapshot.audit).toHaveLength(50);
    expect(bounded.runtime.snapshot.audit[0]!.id).toBe('a30');
  });
});

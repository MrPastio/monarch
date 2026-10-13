import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core';
import { SecurityModule } from '../../src/modules/security';

class Client {
  readonly config = { projectRoot: 'E:\\Monarch\\security', configPath: 'fixture.toml', pythonPath: 'python', timeoutMs: 8000 };
  readonly available = false;
  retryInspection = vi.fn(async () => ({ ok: true, exitCode: 0, args: ['inspection-retry'], stdout: '', stderr: '',
    jsonLines: [{ ok: true, accepted: true, status: 'queued', id: '1'.repeat(32) }] }));
  dispose() {}
}

describe('Security inspection recovery capability', () => {
  let kernel: MonarchKernel | null = null;
  afterEach(async () => { await kernel?.stop(); kernel = null; });
  it('uses the exact read capability without accepting caller paths or changing protection', async () => {
    const client = new Client();
    kernel = new MonarchKernel({ permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' } });
    kernel.registerModule(new SecurityModule(client as any));
    await kernel.start();
    const request = { id: 'recovery', intentId: 'owner-retry', moduleId: 'security', capabilityId: 'security.inspection.retry',
      input: {}, createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: false };
    const accepted = await kernel.execute(request);
    expect(accepted).toMatchObject({ ok: true, output: { payload: { status: 'queued', accepted: true } } });
    expect(client.retryInspection).toHaveBeenCalledTimes(1);
    const invalid = await kernel.execute({ ...request, id: 'bad-recovery', input: { path: 'E:\\other-folder' } });
    expect(invalid.ok).toBe(false);
    expect(client.retryInspection).toHaveBeenCalledTimes(1);
  });
});

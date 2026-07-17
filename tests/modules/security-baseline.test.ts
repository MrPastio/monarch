import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core';
import { SecurityModule } from '../../src/modules/security';

class FakeBaselineClient {
  readonly config = { projectRoot: 'E:\\Monarch\\security', configPath: 'config.toml', pythonPath: 'python', timeoutMs: 30_000 };
  readonly available = true;
  baseline = vi.fn(async (_scope: string, digest?: string) => ({
    ok: true, exitCode: 0, args: ['baseline'], stdout: '', stderr: '',
    jsonLines: [{ ok: true, digest }],
  }));
  baselinePreview = vi.fn(async () => ({
    ok: true, exitCode: 0, args: ['baseline-preview'], stdout: '', stderr: '',
    jsonLines: [{ ok: true, digest: 'a'.repeat(64), counts: { added: 1, changed: 0, removed: 0 } }],
  }));
  backgroundBenchmarkStatus() { return null; }
  dispose() {}
}

describe('Security persistence baseline approval', () => {
  let kernel: MonarchKernel | null = null;
  afterEach(async () => { await kernel?.stop(); kernel = null; });

  it('routes Oscar Security reads to native Security capabilities and baseline requests to preview', async () => {
    const security = new SecurityModule(new FakeBaselineClient() as any);
    const incidents = await security.handleIntent({ id: 'incidents', text: 'Oscar, покажи угрозы и инциденты Security' } as any);
    const quarantine = await security.handleIntent({ id: 'quarantine', text: 'Oscar, покажи что находится в карантине' } as any);
    const baseline = await security.handleIntent({ id: 'baseline', text: 'Oscar, проверь baseline автозапуска' } as any);

    expect(incidents?.capabilityId).toBe('security.incidents.list');
    expect(quarantine?.capabilityId).toBe('security.quarantine.list');
    expect(baseline).toMatchObject({ capabilityId: 'security.baseline.preview', permissionMode: 'allow' });
  });

  it('routes a natural current-process safety audit to a real system scan', async () => {
    const security = new SecurityModule(new FakeBaselineClient() as any);
    const route = await security.handleIntent({
      id: 'process-audit',
      text: 'Можешь выдать мне аудит по всем текущим процессам на их безопасность',
    } as any);

    expect(route).toMatchObject({
      capabilityId: 'security.scan.system',
      permissionMode: 'allow',
      input: { includeFiles: false, includeInstalls: false, noLlm: true },
    });
  });

  it('routes Security strictness changes to the confirmed native profile capability', async () => {
    const security = new SecurityModule(new FakeBaselineClient() as any);
    const route = await security.handleIntent({
      id: 'security-level',
      text: 'Установи максимальный уровень строгости Security',
    } as any);

    expect(route).toMatchObject({
      capabilityId: 'security.profile.set',
      permissionMode: 'confirm',
      input: { level: 'maximum' },
    });
  });

  it('routes model command safety settings to the native Security policy', async () => {
    const security = new SecurityModule(new FakeBaselineClient() as any);
    const route = await security.handleIntent({
      id: 'model-policy',
      text: 'Security, всегда спрашивай подтверждение перед командами Oscar модели',
    } as any);

    expect(route).toMatchObject({
      capabilityId: 'security.model_policy.set',
      permissionMode: 'confirm',
      input: { enabled: true, confirmationMode: 'always' },
    });
  });

  it('keeps preview read-only and requires its exact digest for persistence approval', async () => {
    const client = new FakeBaselineClient();
    kernel = new MonarchKernel({ permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' } });
    kernel.registerModule(new SecurityModule(client as any));
    await kernel.start();

    const preview = await kernel.execute({
      id: 'preview', intentId: 'preview-intent', moduleId: 'security', capabilityId: 'security.baseline.preview',
      input: {}, createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: false,
    });
    expect(preview).toMatchObject({ ok: true, output: { payload: { counts: { added: 1 } } } });
    expect(client.baseline).not.toHaveBeenCalled();

    const missing = await kernel.execute({
      id: 'missing', intentId: 'missing-intent', moduleId: 'security', capabilityId: 'security.baseline.write',
      input: { scope: 'persistence' }, createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: true,
    });
    expect(missing).toMatchObject({ ok: false, error: 'baseline-preview-required' });
    expect(client.baseline).not.toHaveBeenCalled();

    const digest = 'a'.repeat(64);
    const approved = await kernel.execute({
      id: 'approve', intentId: 'approve-intent', moduleId: 'security', capabilityId: 'security.baseline.write',
      input: { scope: 'persistence', expectedDigest: digest }, createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: true,
    });
    expect(approved.ok).toBe(true);
    expect(client.baseline).toHaveBeenCalledWith('persistence', digest);
  });
});

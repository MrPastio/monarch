import { afterEach, describe, expect, it } from 'vitest';
import { MonarchKernel } from '../../src/core';
import { SecurityModule } from '../../src/modules/security';
import type { SecurityBenchmarkJobSnapshot } from '../../src/modules/security/client';

class FakeBenchmarkSecurityClient {
  readonly config = {
    projectRoot: 'E:\\Monarch\\security',
    configPath: 'E:\\Monarch\\security\\config\\monarch_security.toml',
    pythonPath: 'python',
    timeoutMs: 30_000,
  };
  readonly available = true;
  current: SecurityBenchmarkJobSnapshot | null = null;
  disposed = false;

  startBackgroundBenchmark(durationSeconds: number, intervalSeconds: number): SecurityBenchmarkJobSnapshot {
    if (this.current?.status === 'running') return this.current;
    this.current = {
      jobId: '12345678-1234-1234-1234-123456789abc',
      status: 'running',
      durationSeconds,
      intervalSeconds,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      elapsedSeconds: 0,
      progressPercent: 0,
      result: null,
      error: null,
    };
    return this.current;
  }

  backgroundBenchmarkStatus(): SecurityBenchmarkJobSnapshot | null {
    return this.current;
  }

  cancelBackgroundBenchmark(jobId: string): SecurityBenchmarkJobSnapshot | null {
    if (!this.current || this.current.jobId !== jobId) return null;
    this.current = { ...this.current, status: 'cancelled', error: 'Cancelled by user.' };
    return this.current;
  }

  dispose(): void {
    this.disposed = true;
    if (this.current?.status === 'running') this.current = { ...this.current, status: 'cancelled' };
  }
}

describe('Security background benchmark capabilities', () => {
  let kernel: MonarchKernel | null = null;

  afterEach(async () => {
    await kernel?.stop();
    kernel = null;
  });

  it('starts once, exposes progress, rejects stale cancel ids, and cancels the owned job', async () => {
    const client = new FakeBenchmarkSecurityClient();
    kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(new SecurityModule(client as any));
    await kernel.start();

    const start = await kernel.execute({
      id: 'benchmark-start', intentId: 'benchmark-intent', moduleId: 'security',
      capabilityId: 'security.benchmark.start', input: { durationSeconds: 300, intervalSeconds: 0.5 },
      createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: true,
    });
    expect(start).toMatchObject({ ok: true, output: { status: 'running', durationSeconds: 300 } });

    const duplicate = await kernel.execute({
      id: 'benchmark-start-2', intentId: 'benchmark-intent-2', moduleId: 'security',
      capabilityId: 'security.benchmark.start', input: { durationSeconds: 600, intervalSeconds: 1 },
      createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: true,
    });
    expect(duplicate).toMatchObject({ ok: true, output: { reused: true, durationSeconds: 300 } });

    const status = await kernel.execute({
      id: 'benchmark-status', intentId: 'benchmark-intent-3', moduleId: 'security',
      capabilityId: 'security.benchmark.status', input: {},
      createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: false,
    });
    expect(status).toMatchObject({ ok: true, output: { status: 'running', progressPercent: 0 } });

    const staleCancel = await kernel.execute({
      id: 'benchmark-cancel-stale', intentId: 'benchmark-intent-4', moduleId: 'security',
      capabilityId: 'security.benchmark.cancel', input: { jobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: true,
    });
    expect(staleCancel).toMatchObject({ ok: false, error: 'benchmark-job-not-found' });

    const cancel = await kernel.execute({
      id: 'benchmark-cancel', intentId: 'benchmark-intent-5', moduleId: 'security',
      capabilityId: 'security.benchmark.cancel', input: { jobId: client.current?.jobId },
      createdAt: new Date().toISOString(), requestedBy: 'test', confirmed: true,
    });
    expect(cancel).toMatchObject({ ok: true, output: { status: 'cancelled' } });
  });
});

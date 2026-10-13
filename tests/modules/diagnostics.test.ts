import { describe, expect, it } from 'vitest';
import { MonarchKernel, type MonarchExecutionResult, type MonarchModule } from '../../src/core';
import { DiagnosticsModule } from '../../src/modules/diagnostics';
import { executeTypedCapability } from '../helpers/typed-capability';

describe('Diagnostics Module', () => {
  it('executes an exact project diagnostics capability as a structured read-only report', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DiagnosticsModule());
    await kernel.start();
    try {
      const result = await executeTypedCapability(kernel, 'diagnostics.project.report', { limit: 50 });
      const output = result.output as { status?: string; checked_sources?: string[] } | undefined;

      expect(result.ok).toBe(true);
      expect(output?.status).toMatch(/ok|warning|critical/);
      expect(output?.checked_sources).toContain('kernel.modules');
    } finally {
      await kernel.stop();
    }
  });

  it('detects failures in supplied source summaries and suggests memory notes', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DiagnosticsModule());
    await kernel.start();
    try {
      const result = await kernel.execute({
        id: 'exec_diagnostics_project_report',
        intentId: 'intent_diagnostics_project_report',
        moduleId: 'diagnostics',
        capabilityId: 'diagnostics.project.report',
        input: {
          sources: {
            'npm test': 'FAILED tests/modules/memory.test.ts\nTraceback: assertion error',
            'git diff': 'TODO remove debug console.log before release',
          },
        },
        createdAt: new Date(0).toISOString(),
        requestedBy: 'smoke',
      });
      const output = result.output as {
        status?: string;
        detected_anomalies?: Array<{ source?: string; status?: string }>;
        memory_entry_suggestions?: Array<{ type?: string }>;
      };

      expect(result.ok).toBe(true);
      expect(output.status).toBe('critical');
      expect(output.detected_anomalies?.some((item) => item.source === 'npm test')).toBe(true);
      expect(output.memory_entry_suggestions?.some((item) => item.type === 'active_bug')).toBe(true);
    } finally {
      await kernel.stop();
    }
  });

  it('adaptively probes safe read-only status capabilities through an exact typed call', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DiagnosticsModule());
    kernel.registerModule(createStatusModule());
    await kernel.start();
    try {
      const result = await executeTypedCapability(kernel, 'diagnostics.system.inspect', {
        query: 'проверь всю систему Monarch',
      });
      const output = result.output as {
        scope?: string;
        modules?: Array<{ id?: string; probe?: string; probeOk?: boolean }>;
        totals?: { probed?: number; failed?: number };
      } | undefined;

      expect(result.ok).toBe(true);
      expect(output?.scope).toBe('all');
      expect(output?.modules).toContainEqual(expect.objectContaining({
        id: 'status-fixture',
        probe: 'status-fixture.status',
        probeOk: true,
      }));
      expect(output?.totals).toMatchObject({ probed: 1, failed: 0 });
    } finally {
      await kernel.stop();
    }
  });
});

function createStatusModule(): MonarchModule {
  return {
    manifest: {
      id: 'status-fixture',
      name: 'Status Fixture',
      version: '0.1.0',
      kind: 'system',
      description: 'Read-only status fixture.',
      owns: ['status fixture'],
      permissions: ['read'],
      capabilities: [{
        id: 'status-fixture.status',
        moduleId: 'status-fixture',
        title: 'Status',
        risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(): Promise<MonarchExecutionResult> {
      return { ok: true, summary: 'Fixture is healthy.', output: { healthy: true } };
    },
  };
}

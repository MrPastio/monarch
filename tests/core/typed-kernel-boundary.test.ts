import { describe, expect, it, vi } from 'vitest';
import {
  MonarchKernel,
  type MonarchExecutionRequest,
  type MonarchKernelContext,
  type MonarchModule,
} from '../../src/core';

describe('typed Kernel execution boundary', () => {
  it('never turns user text into a capability while exact typed execution remains available', async () => {
    const handleIntent = vi.fn(async () => ({
      intentId: 'legacy',
      targetModuleId: 'typed-boundary',
      capabilityId: 'typed-boundary.echo',
      confidence: 1,
      reason: 'This legacy hook must never run.',
      permissionMode: 'allow' as const,
      input: { value: 'wrong' },
    }));
    const executeCapability = vi.fn(async (request: MonarchExecutionRequest) => ({
      ok: true,
      summary: 'Exact typed execution completed.',
      output: request.input,
    }));
    const module: MonarchModule = {
      manifest: {
        id: 'typed-boundary',
        name: 'Typed boundary fixture',
        version: '1.0.0',
        kind: 'tooling',
        description: 'Proves that text is not capability authority.',
        owns: ['tests.typed-boundary'],
        permissions: ['none'],
        capabilities: [{
          id: 'typed-boundary.echo',
          moduleId: 'typed-boundary',
          title: 'Echo exact input',
          risk: 'none',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        }],
      },
      activate: async (_context: MonarchKernelContext) => undefined,
      handleIntent,
      executeCapability,
    };
    const kernel = new MonarchKernel({ agencyStateDirectory: false });
    kernel.registerModule(module);
    await kernel.start();
    try {
      const legacy = await kernel.submitIntent('typed-boundary.echo {"value":"activated by text"}', 'api');
      expect(legacy).toMatchObject({
        route: null,
        plan: null,
        execution: { ok: false, error: 'legacy-text-router-retired' },
      });
      expect(handleIntent).not.toHaveBeenCalled();
      expect(executeCapability).not.toHaveBeenCalled();

      const exact = await kernel.execute({
        id: 'exec_exact_typed_boundary',
        intentId: 'intent_exact_typed_boundary',
        moduleId: 'typed-boundary',
        capabilityId: 'typed-boundary.echo',
        input: { value: 'trusted typed input' },
        createdAt: new Date().toISOString(),
        requestedBy: 'typed-boundary-test',
        source: 'api',
        confirmed: false,
      });
      expect(exact).toMatchObject({
        ok: true,
        output: { value: 'trusted typed input' },
      });
      expect(handleIntent).not.toHaveBeenCalled();
      expect(executeCapability).toHaveBeenCalledTimes(1);
    } finally {
      await kernel.stop();
    }
  });
});

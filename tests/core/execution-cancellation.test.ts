import { describe, expect, it } from 'vitest';
import {
  MonarchKernel,
  type MonarchExecutionControl,
  type MonarchExecutionResult,
  type MonarchModule,
} from '../../src/core';

describe('Execution Engine cancellation control', () => {
  it('propagates AbortSignal to an active capability worker through the action gateway', async () => {
    let receivedSignal: AbortSignal | undefined;
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(createCancellableModule((control) => {
      receivedSignal = control?.signal;
    }));
    await kernel.start();

    try {
      const controller = new AbortController();
      const execution = kernel.executeActionProposal({
        capabilityId: 'test.cancel.wait',
        args: {},
        reason: 'Exercise cancellation propagation.',
      }, {
        requestedBy: 'agent:test',
        signal: controller.signal,
      });
      await waitFor(() => receivedSignal === controller.signal);
      controller.abort('cancel');

      await expect(execution).resolves.toMatchObject({
        result: {
          ok: false,
          error: 'cancelled',
          metadata: { cancellation: { requested: true } },
        },
      });
      expect(receivedSignal).toBe(controller.signal);
    } finally {
      await kernel.stop();
    }
  });

  it('does not dispatch a capability when its signal is already aborted', async () => {
    let calls = 0;
    const kernel = new MonarchKernel({
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
    });
    kernel.registerModule(createCancellableModule(() => {
      calls += 1;
    }));
    await kernel.start();

    try {
      const controller = new AbortController();
      controller.abort('cancel');
      const result = await kernel.executeActionProposal({
        capabilityId: 'test.cancel.wait',
        args: {},
      }, { requestedBy: 'agent:test', signal: controller.signal });

      expect(result.result).toMatchObject({ ok: false, error: 'cancelled' });
      expect(calls).toBe(0);
    } finally {
      await kernel.stop();
    }
  });
});

function createCancellableModule(onStart: (control?: MonarchExecutionControl) => void): MonarchModule {
  return {
    manifest: {
      id: 'test-cancel',
      name: 'Test cancellation',
      version: '1.0.0',
      kind: 'tooling',
      description: 'Test-only cancellable capability.',
      owns: ['test cancellation'],
      permissions: ['read'],
      capabilities: [{
        id: 'test.cancel.wait',
        moduleId: 'test-cancel',
        title: 'Wait for cancellation',
        risk: 'read',
      }],
    },
    async activate(): Promise<void> {},
    async executeCapability(_request, _context, control): Promise<MonarchExecutionResult> {
      onStart(control);
      const signal = control?.signal;
      if (signal?.aborted) return cancelledResult(signal);
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve(cancelledResult(signal)), { once: true });
      });
    },
  };
}

function cancelledResult(signal: AbortSignal): MonarchExecutionResult {
  return {
    ok: false,
    summary: 'Capability observed cancellation.',
    error: 'cancelled',
    metadata: { cancellation: { requested: true, reason: String(signal.reason || 'aborted') } },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Capability did not start before timeout.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

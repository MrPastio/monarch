import { describe, expect, it } from 'vitest';
import {
  MonarchKernel,
  type MonarchExecutionControl,
  type MonarchExecutionResult,
  type MonarchModule,
} from '../../src/core';

describe('Execution Engine cancellation control', () => {
  it('does not let an approving dispatch guard bypass the Kernel read-only policy', async () => {
    let calls = 0;
    const kernel = new MonarchKernel({ agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' } });
    const module = createCancellableModule(() => {});
    module.manifest = { ...module.manifest, permissions: ['write'], capabilities: module.manifest.capabilities.map(capability => ({ ...capability, risk: 'write' })) };
    module.executeCapability = async () => { calls++; return { ok: true, summary: 'Unexpected dispatch.' }; };
    kernel.registerModule(module); await kernel.start();
    try {
      const result = await kernel.executeActionProposal({ capabilityId: 'test.cancel.wait', args: {} }, { dispatchGuard: () => true });
      expect(result.result.ok).toBe(false); expect(calls).toBe(0);
    } finally { await kernel.stop(); }
  });
  it.each(['cancel', 'fence'])('rechecks %s after asynchronous start observers and before module dispatch', async mode => {
    let calls = 0, current = true;
    const controller = new AbortController();
    const kernel = new MonarchKernel({ agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    const module = createCancellableModule(() => { calls++; });
    // If dispatched incorrectly, return promptly so this regression cannot hang.
    module.executeCapability = async () => { calls++; return { ok: true, summary: 'Unexpected dispatch.' }; };
    kernel.registerModule(module); await kernel.start();
    const unsubscribe = kernel.subscribeEvent('capability.execution.started', async () => {
      await Promise.resolve();
      if (mode === 'cancel') controller.abort('cancel-at-last-boundary'); else current = false;
    });
    try {
      const result = await kernel.executeActionProposal({ capabilityId: 'test.cancel.wait', args: {} },
        { requestedBy: 'agent:test', signal: controller.signal, dispatchGuard: () => current });
      expect(result.result).toMatchObject({ ok: false, error: mode === 'cancel' ? 'cancelled' : 'execution-dispatch-fenced' });
      expect(result.result.metadata?.dispatchControl).toEqual({ dispatched: false, reason: mode === 'cancel' ? 'cancelled' : 'runtime-fence' });
      expect(calls).toBe(0);
      const receipt = kernel.getActionLedgerRecord(result.proposal.idempotencyKey);
      expect(receipt?.result?.ok).toBe(false);
      expect(receipt?.result?.metadata?.dispatchControl).toEqual(result.result.metadata?.dispatchControl);
    } finally { unsubscribe(); await kernel.stop(); }
  });

  it('does not pass an internal dispatch fence to capability code or durable data', async () => {
    let received: MonarchExecutionControl | undefined;
    const kernel = new MonarchKernel({ agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'on-request' } });
    const module = createCancellableModule(() => {});
    module.executeCapability = async (_request, _context, control) => { received = control; return { ok: true, summary: 'Synthetic observation.' }; };
    kernel.registerModule(module); await kernel.start();
    try {
      const controller = new AbortController();
      const result = await kernel.executeActionProposal({ capabilityId: 'test.cancel.wait', args: {} },
        { requestedBy: 'agent:test', signal: controller.signal, dispatchGuard: () => true });
      expect(result.result.ok).toBe(true); expect(received?.signal).toBe(controller.signal);
      expect(received?.dispatchGuard).toBeUndefined();
      expect(JSON.stringify(kernel.listActionLedger())).not.toContain('dispatchGuard');
      expect(JSON.stringify(kernel.getEvents())).not.toContain('dispatchGuard');
    } finally { await kernel.stop(); }
  });

  it.each(['return', 'throw'])('does not let a %s after dispatch claim that cancellation prevented the action', async mode => {
    const kernel = new MonarchKernel({ agencyStateDirectory: false }), controller = new AbortController();
    let actualCalls = 0;
    const module = createCancellableModule(() => {});
    module.executeCapability = async () => {
      actualCalls++; controller.abort('after-module-start');
      if (mode === 'throw') throw new Error('owned-synthetic-module-fault');
      return { ok: false, summary: 'Already entered module.', error: 'cancelled',
        metadata: { dispatchControl: { dispatched: false, reason: 'runtime-fence' } } };
    };
    kernel.registerModule(module); await kernel.start();
    try {
      const returned = await kernel.executeActionProposal({ capabilityId: 'test.cancel.wait', args: {} }, { signal: controller.signal });
      expect(actualCalls).toBe(1);
      expect(returned.result).toMatchObject({ ok: false, error: 'cancelled', metadata: { dispatchControl: { dispatched: true } } });
      expect(kernel.getActionLedgerRecord(returned.proposal.idempotencyKey)?.result?.metadata?.dispatchControl)
        .toMatchObject({ dispatched: true });
    } finally { await kernel.stop(); }
  });

  it('fails closed on a throwing guard without exposing its exception or dispatching', async () => {
    let calls = 0;
    const kernel = new MonarchKernel({ agencyStateDirectory: false });
    kernel.registerModule(createCancellableModule(() => { calls++; })); await kernel.start();
    try {
      const result = await kernel.executeActionProposal({ capabilityId: 'test.cancel.wait', args: {} },
        { dispatchGuard: () => { throw new Error('synthetic-private-guard-detail'); } });
      expect(result.result).toMatchObject({ ok: false, error: 'execution-dispatch-fenced' });
      expect(JSON.stringify(result)).not.toContain('synthetic-private-guard-detail'); expect(calls).toBe(0);
    } finally { await kernel.stop(); }
  });
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

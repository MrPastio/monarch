import { describe, expect, it, vi } from 'vitest';
import { GmailModule } from '../../src/modules/gmail';
import { gmailManifest } from '../../src/modules/gmail/manifest';
import { resolveAgentCapabilityMetadata } from '../../src/core';

describe('Gmail service module', () => {
  it('exposes typed capabilities without keyword activation metadata', () => {
    expect(gmailManifest.capabilities.map(item => item.id)).toEqual([
      'gmail.connection.status', 'gmail.messages.search', 'gmail.message.read', 'gmail.draft.create', 'gmail.draft.send',
    ]);
    expect(gmailManifest.capabilities.every(item => item.routing === undefined)).toBe(true);
    expect(gmailManifest.capabilities.filter(item => item.agent?.effectProfile?.mutation === 'none')
      .every(item => item.agent?.idempotency === 'idempotent')).toBe(true);
    expect(() => gmailManifest.capabilities.forEach(resolveAgentCapabilityMetadata)).not.toThrow();
    expect(gmailManifest.capabilities.find(item => item.id === 'gmail.draft.send')?.agent?.effectProfile)
      .toMatchObject({ targetScope: 'external-service', reversibility: 'irreversible', identityImpact: true });
  });

  it('uses only the private operation broker and returns bounded product output', async () => {
    const request = vi.fn(async () => ({ messages: [{ id: 'message_1', subject: 'Status' }] }));
    const module = new GmailModule({ available: true, request } as never);
    const result = await module.executeCapability({ capabilityId: 'gmail.messages.search',
      input: { query: 'from:owner@example.com', maxResults: 5 } } as never);
    expect(request).toHaveBeenCalledWith('messages.search', { query: 'from:owner@example.com', maxResults: 5 }, undefined);
    expect(result).toMatchObject({ ok: true, output: { messages: [{ id: 'message_1' }] } });
  });

  it('does not expose broker errors or credentials', async () => {
    const module = new GmailModule({ available: true,
      request: async () => { throw Error('refresh_token=secret-owner-token'); } } as never);
    const result = await module.executeCapability({ capabilityId: 'gmail.connection.status', input: {} } as never);
    expect(result).toMatchObject({ ok: false, error: 'gmail:request-failed' });
    expect(JSON.stringify(result)).not.toContain('secret-owner-token');
  });

  it('forwards cancellation to the broker and lets the Kernel classify the abort', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_operation, _input, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort',
        () => reject(Error('broker-aborted')), { once: true }));
      return {};
    });
    const module = new GmailModule({ available: true, request } as never);
    const pending = module.executeCapability({ capabilityId: 'gmail.messages.search', input: { query: 'agent' } } as never,
      {} as never, { signal: controller.signal });
    controller.abort('stop');
    await expect(pending).rejects.toThrow('broker-aborted');
    expect(request).toHaveBeenCalledWith('messages.search', { query: 'agent' }, controller.signal);
  });
});

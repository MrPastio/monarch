import { describe, expect, it, vi } from 'vitest';
import { GitHubModule } from '../../src/modules/github';
import { githubManifest } from '../../src/modules/github/manifest';
import { MonarchKernel } from '../../src/core/kernel';
import { resolveAgentCapabilityMetadata } from '../../src/core';

describe('GitHub service module', () => {
  it('exposes typed capabilities without phrase or keyword routing metadata', () => {
    expect(githubManifest.capabilities.map(item => item.id)).toEqual([
      'github.connection.status', 'github.repositories.list', 'github.repository.file.read',
      'github.issues.list', 'github.issue.create', 'github.pull-requests.list', 'github.pull-request.comment',
    ]);
    expect(githubManifest.capabilities.every(item => item.routing === undefined)).toBe(true);
    expect(githubManifest.capabilities.filter(item => item.agent?.effectProfile?.mutation === 'none')
      .every(item => item.agent?.idempotency === 'idempotent')).toBe(true);
    expect(() => githubManifest.capabilities.forEach(resolveAgentCapabilityMetadata)).not.toThrow();
    expect(githubManifest.capabilities.find(item => item.id === 'github.issue.create')?.agent?.effectProfile)
      .toMatchObject({ targetScope: 'external-service', mutation: 'persistent', identityImpact: true });
    expect(githubManifest.capabilities.find(item => item.id === 'github.pull-request.comment')?.agent?.supportedSources)
      .toContain('coder');
    expect(githubManifest.capabilities.some(item => /merge|delete|release/iu.test(item.id))).toBe(false);
  });

  it('dispatches only typed private-broker operations', async () => {
    const request = vi.fn(async () => ({ issues: [{ number: 4, title: 'Agent runtime' }] }));
    const module = new GitHubModule({ available: true, request } as never);
    const result = await module.executeCapability({ capabilityId: 'github.issues.list',
      input: { repository: 'owner/project', state: 'open', maxResults: 10 } } as never);
    expect(request).toHaveBeenCalledWith('issues.list', { repository: 'owner/project', state: 'open', maxResults: 10 }, undefined);
    expect(result).toMatchObject({ ok: true, output: { issues: [{ number: 4 }] } });
  });

  it('does not echo provider errors or credentials', async () => {
    const module = new GitHubModule({ available: true,
      request: async () => { throw Error('token=github_pat_owner_secret'); } } as never);
    const result = await module.executeCapability({ capabilityId: 'github.connection.status', input: {} } as never);
    expect(result).toMatchObject({ ok: false, error: 'github:request-failed' });
    expect(JSON.stringify(result)).not.toContain('github_pat_owner_secret');
  });

  it('forwards cancellation to the broker and lets the Kernel classify the abort', async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_operation, _input, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort',
        () => reject(Error('broker-aborted')), { once: true }));
      return {};
    });
    const module = new GitHubModule({ available: true, request } as never);
    const pending = module.executeCapability({ capabilityId: 'github.issues.list',
      input: { repository: 'owner/project' } } as never, {} as never, { signal: controller.signal });
    controller.abort('stop');
    await expect(pending).rejects.toThrow('broker-aborted');
    expect(request).toHaveBeenCalledWith('issues.list', { repository: 'owner/project' }, controller.signal);
  });

  it('does not add an artificial second confirmation to an allowlisted Direct Access post', async () => {
    const request = vi.fn(async () => ({ number: 1 }));
    const kernel = new MonarchKernel({ agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request', autonomyMode: 'full-local' } });
    kernel.registerModule(new GitHubModule({ available: true, request } as never));
    await kernel.start();
    try {
      const result = await kernel.execute({
        id: 'exec_github_issue_create', intentId: 'intent_github_issue_create', moduleId: 'github',
        capabilityId: 'github.issue.create', input: { repository: 'owner/project', title: 'Agent task' },
        createdAt: new Date(0).toISOString(), requestedBy: 'agent:github-fixture', source: 'desktop',
        executionMode: 'agent-runtime', confirmed: false,
      });
      expect(result).toMatchObject({ ok: true, output: { number: 1 } });
      expect(request).toHaveBeenCalledOnce();
    } finally { await kernel.stop(); }
  });
});

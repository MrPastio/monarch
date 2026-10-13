import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { MonarchKernel } from '../../src/core';
import { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { SecurityModule } from '../../src/modules/security';

describe('Security Desktop control transport', () => {
  it('executes the real UI helper through HTTP and Kernel without an agent turn', async () => {
    const enableBackground = vi.fn(async () => ({ ok: true, exitCode: 0, args: [], stdout: '', stderr: '', jsonLines: [{ ok: true, enabled: true }] }));
    const client = { available: false, config: { projectRoot: path.resolve('security') }, enableBackground, dispose() {} };
    const kernel = new MonarchKernel({ agencyStateDirectory: false, permissionProfile: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' } });
    kernel.registerModule(new SecurityModule(client as any));
    await kernel.start();
    const app = { runtime: { kernel }, ensureStarted: async () => {}, executeSecurityDesktopControl: MonarchApplication.prototype.executeSecurityDesktopControl } as unknown as MonarchApplication;
    const server = createMonarchHttpServer({ app, publicDirectory: path.resolve('src/ui/public'), port: 4439, apiToken: 'isolated-api', desktopAttestationToken: 'isolated-desktop' });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const fetchOriginal = globalThis.fetch;
    const routes: string[] = [];
    try {
      vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => 'isolated-api' }) });
      vi.stubGlobal('window', { monarchDesktop: { getMutationAttestation: async () => 'isolated-desktop' } });
      vi.stubGlobal('fetch', (input: string, init: RequestInit) => { routes.push(input); return fetchOriginal(url + input, init); });
      const { executeConfirmedCapability } = await import('../../src/ui/public/modules/api.js');
      expect(await executeConfirmedCapability('security', 'security.background.enable', {}, 'ui:security')).toMatchObject({ ok: true });
      expect(routes).toEqual(['/api/security/control']);
      expect(enableBackground).toHaveBeenCalledOnce();
      const request = (body: unknown, extra = {}) => fetchOriginal(url + '/api/security/control', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Monarch-Session': 'isolated-api', ...extra }, body: JSON.stringify(body) });
      expect((await request({ schemaVersion: 1, capabilityId: 'security.background.enable', input: {}, source: 'desktop' })).status).toBe(403);
      expect((await request({ schemaVersion: 1, capabilityId: 'security.background.enable', input: {} }, { 'X-Monarch-Desktop-Attestation': 'isolated-desktop', Origin: 'https://untrusted.example' })).status).toBe(403);
      expect((await request({ schemaVersion: 1, capabilityId: 'security.controller.check', input: {} }, { 'X-Monarch-Desktop-Attestation': 'isolated-desktop' })).status).toBe(400);
      expect((await request({ schemaVersion: 1, capabilityId: 'security.screen_lock.test', input: {} }, { 'X-Monarch-Desktop-Attestation': 'isolated-desktop' })).status).toBe(400);
      for (const body of [null, [], { schemaVersion: 1, capabilityId: 'security.background.enable', input: {}, confirmed: true }]) {
        expect((await request(body, { 'X-Monarch-Desktop-Attestation': 'isolated-desktop' })).status).toBe(400);
      }
      const invalid = await request({ schemaVersion: 1, capabilityId: 'security.background.enable', input: { pin: 'not-accepted' } }, { 'X-Monarch-Desktop-Attestation': 'isolated-desktop' });
      expect(await invalid.json()).toMatchObject({ ok: false, result: { ok: false } });
      expect(enableBackground).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await kernel.stop();
    }
  });
});

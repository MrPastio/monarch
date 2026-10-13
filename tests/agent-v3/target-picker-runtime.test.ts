import path from 'node:path';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonarchApplication } from '../../src/app/application';
import { createMonarchHttpServer } from '../../src/app/http-server';
import { AstraTargetPicker } from '../../src/app/astra-target-picker';
import type { OscarTurnCheckpoint } from '../../src/oscar-turn/types';
import { oscarBridgeHost, oscarBridgeMarker } from '../fixtures/agent-v3/oscar-bridge-host';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(await realpath('.test-tmp'));
    expect(path.basename(root).startsWith('astra-v3-oscar-picker-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(oscarBridgeMarker);
    await rm(root, { recursive: true, force: false });
  }
});
describe('trusted picked targets -> actual ordinary HTTP/coordinator/Kernel', () => {
  it('reads a non-catalog file and creates an explicitly approved new leaf; picking alone does no dispatch', async () => {
    const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-picker-'))); roots.push(root);
    await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
    await writeFile(path.join(root, 'selected.txt'), 'original catalog fixture', { flag: 'wx' });
    await writeFile(path.join(root, 'Другой вход.txt'), 'new synthetic choice 🟠', { flag: 'wx' });
    const token = 'owned-picked-desktop-attestation', actor = { source: 'desktop' as const,
      id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') };
    const s = await oscarBridgeHost(root, { actor, durableSelections: true });
    const app = new Proxy<MonarchApplication>({} as MonarchApplication, { get: (_target, key) => {
      if (key === 'oscarTurnCoordinator') return s.coordinator;
      if (key === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: false, internetEnabled: false, historyContextEnabled: false });
      throw Error('ordinary-product-access-forbidden:' + String(key));
    } });
    const server = createMonarchHttpServer({ app, publicDirectory: root, desktopAttestationToken: token,
      apiToken: 'unused-picked-api', requireApiToken: true, astraOscarTurns: true, astraSelections: s.selections! });
    const dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      await s.start(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
      const headers = { 'Content-Type': 'application/json', 'X-Monarch-Desktop-Attestation': token };
      const post = async (route: string, body: unknown): Promise<OscarTurnCheckpoint> => {
        const response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
        const json = await response.json(); expect(response.status, JSON.stringify(json)).toBeLessThan(300); return json;
      };
      const picker = new AstraTargetPicker({ deployment: 'isolated-validation', canonicalRoot: root, store: s.selections!,
        currentSource: () => ({ actor, conversationId: 'conversation', epoch: 'isolated_page' }),
        choose: async access => path.join(root, access === 'observe' ? 'Другой вход.txt' : 'Другой итог.txt'),
        ttlMs: 60000, maxReadBytes: 4096, maxCreateBytes: 4096, timeoutMs: 1000 });
      const read = await picker.pick({ version: 1, requestId: 'pick_read', access: 'observe' }, () => {});
      const create = await picker.pick({ version: 1, requestId: 'pick_create', access: 'exclusive-create' }, () => {});
      if (read.status !== 'selected' || create.status !== 'selected') throw Error('expected-targets');
      expect(dispatch).not.toHaveBeenCalled(); await expect(readFile(path.join(root, 'Другой итог.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const source = { version: 1, conversationId: 'conversation', privacyMode: 'persistent', text: 'Обработай выбранную цель согласно явно заданному действию.' };
      const observed = await post('/api/oscar/turns', { ...source, clientRequestId: 'picked_read', inputMessageId: 'picked_read_message',
        astra: { selectionId: read.selection.selectionId, goal: { kind: 'observe', targets: ['picked'] } } });
      await s.flush(); expect((await s.coordinator.getTurn(observed.turn.id))!.turn.status).toBe('succeeded'); expect(dispatch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(dispatch.mock.calls[0])).toContain('Другой вход.txt');
      const content = '  Другие точные байты 🟠\n';
      const created = await post('/api/oscar/turns', { ...source, clientRequestId: 'picked_create', inputMessageId: 'picked_create_message',
        astra: { selectionId: create.selection.selectionId, goal: { kind: 'create', target: 'picked', content: { kind: 'literal', text: content } } } });
      await s.flush(); const waiting = (await s.coordinator.getTurn(created.turn.id))!.turn;
      expect(waiting.status).toBe('waiting-for-approval'); expect(dispatch).toHaveBeenCalledTimes(2);
      await expect(readFile(path.join(root, 'Другой итог.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const approval = s.bridge.find(waiting)!.approval!;
      await post('/api/oscar/turns/' + waiting.id + '/astra-input', { version: 1, conversationId: waiting.conversationId, inputMessageId: waiting.inputMessageId,
        input: { kind: 'decide', decision: { approvalId: approval.id, approvalDigest: approval.digest, messageId: 'picked_approval', decision: 'approve' } } });
      await s.flush(); expect(await readFile(path.join(root, 'Другой итог.txt'), 'utf8')).toBe(content);
      expect((await s.coordinator.getTurn(waiting.id))!.turn.outcome?.kind).toBe('partial'); expect(dispatch).toHaveBeenCalledTimes(3);
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
      console.log('picked-route-proof', { kernelCalls: 3, bytes: Buffer.byteLength(content), nativeDialog: 'controlled-port-not-native-window' });
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await s.close(); }
  }, 15000);
});

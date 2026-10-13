import path from 'node:path';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { oscarBridgeHost, oscarBridgeMarker } from '../fixtures/agent-v3/oscar-bridge-host';
import { createMonarchHttpServer } from '../../src/app/http-server';
import type { MonarchApplication } from '../../src/app/application';
import { validateOscarAstraGoal } from '../../src/oscar-turn/astra-contract';

describe('Computer observation through actual Oscar HTTP/coordinator/Turn store', () => {
  it('closes the computer Goal shape without widening file or input authority', () => {
    expect(() => validateOscarAstraGoal({ kind: 'computer-observe' })).not.toThrow();
    expect(() => validateOscarAstraGoal({ kind: 'computer-action' })).not.toThrow();
    for (const extra of [{ windowRef: 'hwnd:42' }, { target: 'raw' }, { click: true }, { targets: ['file'] }])
      for (const kind of ['computer-observe', 'computer-action'] as const)
        expect(() => validateOscarAstraGoal({ kind, ...extra })).toThrow();
  });
  it('delivers once with the exact predecessor, serves detail read-only and restores without recapture', async () => {
    const parent = await realpath('.test-tmp'); expect(parent).toBe('D:\\Monarch-test-tmp-astra-v3');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-computer-')));
    await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
    const token = 'owned-computer-oscar', actor = { source: 'desktop' as const,
      id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') };
    let s = await oscarBridgeHost(root, { actor, computer: true });
    const app = new Proxy({} as MonarchApplication, { get: (_, key) => {
      if (key === 'oscarTurnCoordinator') return s.coordinator;
      if (key === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: false, internetEnabled: false, historyContextEnabled: false });
      throw Error('product-access-forbidden:' + String(key));
    } });
    const server = createMonarchHttpServer({ app, publicDirectory: root, requireApiToken: true, apiToken: token,
      desktopAttestationToken: token, astraOscarTurns: true, astraTasks: s.facade });
    try {
      await s.start(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
      const headers = { Authorization: 'Bearer ' + token, 'x-monarch-desktop-attestation': token, 'Content-Type': 'application/json' };
      const post = (url: string, body: unknown, auth = headers) => fetch(base + url, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const window = s.computer!.window;
      const selected = s.windowSelections!.issue({ actor, conversationId: 'conversation', requestId: 'pick', ttlMs: 60000, timeoutMs: 1000,
        window: { windowRef: window.windowRef, processId: window.processId, processInstanceId: window.processInstanceId,
          processName: window.processName, title: window.title } }, () => true);
      const request = { version: 1, clientRequestId: 'window_request', conversationId: 'conversation', inputMessageId: 'window_message',
        text: '  Наблюдай выбранное окно 🟠\n', privacyMode: 'persistent', astra: { selectionId: selected.selectionId, goal: { kind: 'computer-observe' } } };
      expect((await post('/api/oscar/turns', { ...request, astra: { ...request.astra, goal: { kind: 'computer-observe', click: true } } })).status).toBe(400);
      expect((await post('/api/oscar/turns', request, { ...headers, 'x-monarch-desktop-attestation': '' })).status).toBe(403);
      const admitted = await post('/api/oscar/turns', request), first = await admitted.json(); expect(admitted.status, JSON.stringify(first)).toBeLessThan(300);
      let cp = first; const deadline = Date.now() + 5000;
      while (cp.turn.status !== 'succeeded' && Date.now() < deadline) { await delay(20); cp = await (await fetch(base + '/api/oscar/turns/' + first.turn.id, { headers })).json(); }
      expect(cp.turn).toMatchObject({ status: 'succeeded', outcome: { kind: 'partial' }, request: { text: request.text, astra: request.astra } });
      const task = s.bridge.find(cp.turn)!; expect(task.status).toBe('observed');
      for (let i = 0; i < 100 && s.bridge.find(cp.turn)!.message!.delivery !== 'acknowledged'; i++) await delay(10);
      expect(s.bridge.find(cp.turn)!.message!.delivery).toBe('acknowledged');
      const delivered = await s.delivered(); expect(delivered).toHaveLength(2);
      expect(delivered[1]).toMatchObject({ requiredPreviousMessageId: request.inputMessageId, content: task.message!.content, contentMode: 'exact' });
      const detailUrl = '/api/astra/v3/computer-observe-tasks/' + task.id + '?conversationId=conversation&inputMessageId=window_message';
      const detail = await (await fetch(base + detailUrl, { headers })).json(); expect(JSON.stringify(detail.task.observation)).toContain('ASTRA_OSCAR_WINDOW_42');
      expect((await fetch(base + detailUrl.replace('conversationId=conversation', 'conversationId=other'), { headers })).status).toBe(404);
      expect((await post('/api/oscar/turns/' + cp.turn.id + '/astra-input', { version: 1 })).status).toBe(409);
      expect((await (await post('/api/oscar/turns', request)).json()).turn.id).toBe(cp.turn.id);
      expect(s.computer!.counts()).toEqual({ captures: 1, listings: 0, inputs: 0 });
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
      await s.close(); s = await oscarBridgeHost(root, { actor, computer: true }); await s.start();
      const restored = await s.coordinator.getTurn(cp.turn.id); expect(restored!.turn.status).toBe('succeeded');
      expect(s.bridge.find(restored!.turn)!.message!.delivery).toBe('acknowledged'); expect(await s.delivered()).toHaveLength(2);
      expect(s.computer!.counts().captures).toBe(0);
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await s.close();
      expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
      expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(oscarBridgeMarker); await rm(root, { recursive: true });
    }
  });
  it('requires an exact Oscar approval and dispatches one pre-issued action without exposing a native handle', async () => {
    const parent = await realpath('.test-tmp'); expect(parent).toBe('D:\\Monarch-test-tmp-astra-v3');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-action-')));
    await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
    const token = 'owned-computer-action-oscar', actor = { source: 'desktop' as const,
      id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/desktop').digest('hex') };
    const s = await oscarBridgeHost(root, { actor, computerAction: true });
    const app = new Proxy({} as MonarchApplication, { get: (_, key) => {
      if (key === 'oscarTurnCoordinator') return s.coordinator;
      if (key === 'getOwnerDevSettings') return () => ({ zeroRetentionEnabled: false, internetEnabled: false, historyContextEnabled: false });
      throw Error('product-access-forbidden:' + String(key));
    } });
    const server = createMonarchHttpServer({ app, publicDirectory: root, requireApiToken: true, apiToken: token,
      desktopAttestationToken: token, astraOscarTurns: true, astraTasks: s.facade });
    try {
      await s.start(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
      const headers = { Authorization: 'Bearer ' + token, 'x-monarch-desktop-attestation': token, 'Content-Type': 'application/json' };
      const post = (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
      const request = { version: 1, clientRequestId: 'action_request', conversationId: 'conversation', inputMessageId: 'action_message',
        text: 'Выполни ровно выбранное действие после подтверждения.', privacyMode: 'persistent',
        astra: { selectionId: s.actionPlan!.selectionId, goal: { kind: 'computer-action' } } };
      expect((await post('/api/oscar/turns', { ...request, astra: { ...request.astra,
        goal: { kind: 'computer-action', windowRef: s.actionPlan!.windowRef } } })).status).toBe(400);
      const admitted = await post('/api/oscar/turns', request); let cp: any = await admitted.json();
      expect(admitted.status, JSON.stringify(cp)).toBeLessThan(300);
      let deadline = Date.now() + 5000;
      while (cp.turn.status !== 'waiting-for-approval' && Date.now() < deadline) {
        await delay(20); cp = await (await fetch(base + '/api/oscar/turns/' + cp.turn.id, { headers })).json();
      }
      expect(cp.turn.status).toBe('waiting-for-approval'); expect(s.computerActionCalls()).toBe(0);
      const card = cp.events.filter((event: any) => event.type === 'approval.required').at(-1)?.payload;
      expect(card).toMatchObject({ approvalKind: 'computer-action', action: s.computerAction,
        windowTitle: s.actionPlan!.title, grantScope: 'once', businessCompletionCertified: false });
      expect(card).not.toHaveProperty('source'); expect(card).not.toHaveProperty('window');
      expect(JSON.stringify(card)).not.toContain('hwnd:'); expect(JSON.stringify(card)).not.toContain('processId');
      expect((await post('/api/oscar/turns/' + cp.turn.id + '/astra-input', { version: 1,
        conversationId: request.conversationId, inputMessageId: request.inputMessageId,
        input: { kind: 'reply', reply: {} } })).status).toBe(409);
      const decision = { kind: 'decide', decision: { approvalId: card.id, approvalDigest: card.digest,
        messageId: 'action_approval_message', decision: 'approve' } };
      const approved = await post('/api/oscar/turns/' + cp.turn.id + '/astra-input', { version: 1,
        conversationId: request.conversationId, inputMessageId: request.inputMessageId, input: decision });
      expect(approved.status, await approved.text()).toBeLessThan(300);
      deadline = Date.now() + 5000;
      while (cp.turn.status !== 'succeeded' && Date.now() < deadline) {
        await delay(20); cp = await (await fetch(base + '/api/oscar/turns/' + cp.turn.id, { headers })).json();
      }
      expect(cp.turn, JSON.stringify({ turn: cp.turn, task: s.bridge.find(cp.turn), jobs: s.scheduler.list(),
        audit: s.kernel.getSnapshot().audit.slice(-8) })).toMatchObject({ status: 'succeeded', outcome: { kind: 'partial' } });
      expect(s.bridge.find(cp.turn)).toMatchObject({ status: 'observed', message: {
        verification: 'internal-computer-action-proof', predecessorMessageId: request.inputMessageId } });
      expect(s.computerActionCalls()).toBe(1);
      expect((await post('/api/oscar/turns/' + cp.turn.id + '/astra-input', { version: 1,
        conversationId: request.conversationId, inputMessageId: request.inputMessageId, input: decision })).status).toBeLessThan(300);
      expect(s.computerActionCalls()).toBe(1);
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await s.close();
      expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
      expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(oscarBridgeMarker); await rm(root, { recursive: true });
    }
  }, 15_000);
});

import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AstraJournal } from '../../src/agent-v3/journal';
import { oscarBridgeHost, oscarBridgeMarker } from '../fixtures/agent-v3/oscar-bridge-host';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(await realpath('.test-tmp'));
    expect(path.basename(root).startsWith('astra-v3-oscar-selection-')).toBe(true);
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(oscarBridgeMarker); await rm(root, { recursive: true, force: false });
  }
});
describe('selected target lifecycle on actual restart/Kernel route', () => {
  it.each(['pending', 'revoked'] as const)('restores exact %s selection after actual exit68 without a replacement grant', async stage => {
    const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
    const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-oscar-selection-'))); roots.push(root);
    await writeFile(path.join(root, '.fixture-marker'), oscarBridgeMarker, { flag: 'wx' });
    await writeFile(path.join(root, 'selected.txt'), 'synthetic selection input', { flag: 'wx' });
    const cut = await new Promise<{ turnId: string; selectionId: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/fixtures/agent-v3/target-selection-worker.ts'), root, stage],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
      let stdout = '', stderr = '', timeout = false;
      const timer = setTimeout(() => { timeout = true; child.kill(); }, 15000);
      child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 16384) child.kill(); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer); if (timeout || code !== 68) return reject(Error('selection-crash:' + code + ':' + stderr));
        try { const proof = JSON.parse(stdout.trim()); expect(proof).toMatchObject({ marker: 'owned-astra-selection-exit', stage,
          dispatches: 1, modelCalls: 0, legacyCalls: 0, answerCalls: 0 }); resolve(proof); } catch (error) { reject(error); }
      });
    });
    const probe = new AstraJournal(path.join(root, 'astra.sqlite'));
    const expiry = (probe.read('scheduler_oscar_bridge')!.checkpoint as { expiresAt: number }).expiresAt;
    expect(probe.read(cut.selectionId)!.checkpoint).toHaveProperty('state', stage === 'pending' ? 'active' : 'revoked'); probe.close();
    expect(expiry - Date.now()).toBeLessThanOrEqual(1100);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry - Date.now() + 20)));
    const s = await oscarBridgeHost(root, { durableSelections: true }), dispatch = vi.spyOn(s.kernel, 'executeActionProposal');
    try {
      expect(s.selectionId).toBe(cut.selectionId); await s.start(); await s.flush();
      let turn = (await s.coordinator.getTurn(cut.turnId))!.turn;
      if (stage === 'revoked') {
        expect(['cancelled', 'blocked']).toContain(turn.status); expect(dispatch).not.toHaveBeenCalled();
        await expect(readFile(path.join(root, 'Новый отчёт.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(s.selections!.list({ actor: turn.request.astra!.actor, conversationId: turn.conversationId })).toEqual([]);
      } else {
        expect(turn.status).toBe('waiting-for-approval'); expect(dispatch).not.toHaveBeenCalled();
        const approval = s.bridge.find(turn)!.approval!;
        await s.coordinator.submitAstraInput(turn.id, turn.source, { kind: 'decide', decision: {
          approvalId: approval.id, approvalDigest: approval.digest, messageId: 'after_restart_approval', decision: 'approve' } });
        await s.flush(); turn = (await s.coordinator.getTurn(turn.id))!.turn;
        expect(turn.status).toBe('succeeded'); expect(turn.outcome?.kind).toBe('partial'); expect(dispatch).toHaveBeenCalledTimes(1);
        expect(await readFile(path.join(root, 'Новый отчёт.txt'), 'utf8')).toBe('Точные байты 🟠');
        s.selections!.revoke(s.selectionId, { actor: turn.request.astra!.actor, conversationId: turn.conversationId }); await s.flush();
        expect((await s.coordinator.getTurn(turn.id))!.turn.outcome).toEqual(turn.outcome);
        expect(dispatch).toHaveBeenCalledTimes(1); // Denial cannot erase a known prior receipt.
      }
      expect(s.counts()).toEqual({ modelCalls: 0, legacyCalls: 0, answerCalls: 0 });
    } finally { await s.close(); }
  }, 20000);
});

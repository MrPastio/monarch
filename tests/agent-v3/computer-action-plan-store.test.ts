import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraComputerActionPlanStore } from '../../src/app/astra-computer-action-plan-store';
import type { AstraComputerSelectionSnapshot } from '../../src/app/astra-task-facade';
import type { AstraComputerObservation } from '../../src/agent-v3/computer-observe-work-adapter';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('Astra host-issued Computer action plans', () => {
  it('persists one compact approval-required proposal and resolves it only for its source', async () => {
    const parent = await realpath('.test-tmp'), root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-action-plans-'))); roots.push(root);
    await writeFile(path.join(root, '.fixture-marker'), 'astra-action-plan-owned-only', { flag: 'wx' });
    const file = path.join(root, 'journal.sqlite'); let clock = Date.now();
    const actor = { source: 'desktop' as const, id: 'sha256:' + '1'.repeat(64) };
    const source: AstraComputerSelectionSnapshot = { selectionId: 'window_choice', actor, conversationId: 'conversation', revision: 1,
      windowRef: 'hwnd:0000000000000042', processId: 42, processInstanceId: 'process:' + '2'.repeat(64), title: 'Owned editor',
      expiresAt: clock + 60_000, timeoutMs: 3000 };
    const observation: AstraComputerObservation = { authority: 'none', authorizesInput: false, temporalSemantics: 'snapshot-at-capture',
      observationId: 'computer-observation-11111111-1111-4111-8111-111111111111', observedAt: new Date(clock).toISOString(),
      windowRef: source.windowRef, processId: source.processId, processInstanceId: source.processInstanceId, title: source.title,
      screenshotDigest: 'sha256:' + '3'.repeat(64), truncated: false, omittedPasswordElements: 1,
      elements: [{ elementId: 'owned_editor', name: 'Private field label', value: 'Private current value', enabled: true, offscreen: false,
        password: false, controlType: 'Edit' }, { elementId: 'other_element', name: 'Must not duplicate', enabled: true, offscreen: false }] };
    const action = { kind: 'type' as const, elementId: 'owned_editor', text: 'Exact replacement 🟠', textMode: 'replace' as const };
    let journal = new AstraJournal(file), store = new AstraComputerActionPlanStore({ deployment: 'isolated-validation', journal,
      scopeId: 'action_plans', now: () => clock });
    const request = { actor, conversationId: source.conversationId, requestId: 'prepare_once', source, observation, action, ttlMs: 30_000, timeoutMs: 4000 };
    const descriptor = store.issue(request, () => true);
    expect(descriptor).toMatchObject({ title: source.title, authority: 'approval-required', grantScope: 'none' });
    expect(descriptor).not.toHaveProperty('windowRef'); expect(descriptor).not.toHaveProperty('action');
    expect(store.issue(request, () => true)).toEqual(descriptor);
    const context = { actor, conversationId: source.conversationId, inputMessageId: 'action_message', text: 'Run reviewed action.' };
    const resolved = store.resolve(descriptor.selectionId, context);
    expect(resolved).toMatchObject({ actor, conversationId: source.conversationId, windowRef: source.windowRef, action,
      observation: { observationId: observation.observationId,
        elements: [{ elementId: action.elementId, enabled: true, offscreen: false, password: false, controlType: 'Edit' }] } });
    const retained = JSON.stringify(journal.read(descriptor.selectionId)?.checkpoint);
    expect(Buffer.byteLength(retained)).toBeLessThan(16_384); expect(retained).not.toContain('Private field label');
    expect(retained).not.toContain('Private current value'); expect(retained).not.toContain('Must not duplicate');
    expect(() => store.resolve(descriptor.selectionId, { ...context, actor: { ...actor, id: 'sha256:' + '9'.repeat(64) } })).toThrow('not-found');
    expect(() => store.issue({ ...request, action: { ...action, text: 'changed' } }, () => true)).toThrow('request-conflict');
    journal.close(); journal = new AstraJournal(file); store = new AstraComputerActionPlanStore({ deployment: 'isolated-validation', journal,
      scopeId: 'action_plans', now: () => clock });
    expect(store.resolve(descriptor.selectionId, context).action).toEqual(action);
    store.revoke(descriptor.selectionId, { actor, conversationId: source.conversationId });
    expect(store.list({ actor, conversationId: source.conversationId })).toEqual([]);
    expect(() => store.resolve(descriptor.selectionId, context)).toThrow('unavailable'); journal.close();
    expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe('astra-action-plan-owned-only');
  });

  it('rejects stale sources, password targets and post-issue expiry', async () => {
    const parent = await realpath('.test-tmp'), root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-action-plans-'))); roots.push(root);
    await writeFile(path.join(root, '.fixture-marker'), 'astra-action-plan-owned-only', { flag: 'wx' });
    const journal = new AstraJournal(path.join(root, 'journal.sqlite')); let clock = Date.now();
    const store = new AstraComputerActionPlanStore({ deployment: 'isolated-validation', journal, scopeId: 'expiry', now: () => clock });
    const actor = { source: 'desktop' as const, id: 'sha256:' + '4'.repeat(64) };
    const source: AstraComputerSelectionSnapshot = { selectionId: 'window_choice', actor, conversationId: 'conversation', revision: 1,
      windowRef: 'hwnd:42', processId: 42, processInstanceId: 'process:' + '5'.repeat(64), title: 'Owned editor', expiresAt: clock + 10_000, timeoutMs: 3000 };
    const observation: AstraComputerObservation = { authority: 'none', authorizesInput: false, temporalSemantics: 'snapshot-at-capture',
      observationId: 'computer-observation-22222222-2222-4222-8222-222222222222', observedAt: new Date(clock).toISOString(), windowRef: source.windowRef,
      processId: source.processId, processInstanceId: source.processInstanceId, title: source.title, screenshotDigest: 'sha256:' + '6'.repeat(64),
      truncated: false, omittedPasswordElements: 0, elements: [{ elementId: 'secret', enabled: true, offscreen: false, password: true }] };
    const base = { actor, conversationId: source.conversationId, requestId: 'plan', source, observation, ttlMs: 5000, timeoutMs: 1000 };
    expect(() => store.issue({ ...base, action: { kind: 'click', elementId: 'secret', button: 'left', clicks: 1 } }, () => true)).toThrow('element');
    const descriptor = store.issue({ ...base, requestId: 'close', action: { kind: 'close' } }, () => true);
    clock += 5001; expect(() => store.resolve(descriptor.selectionId,
      { actor, conversationId: source.conversationId, inputMessageId: 'message', text: 'Close.' })).toThrow('unavailable');
    expect(store.list({ actor, conversationId: source.conversationId })).toEqual([]); journal.close();
  });
});

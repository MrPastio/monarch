import path from 'node:path';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { setImmediate as immediate } from 'node:timers/promises';
import { MonarchKernel } from '../../src/core/kernel';
import { ComputerModule, type ComputerNativeActionReceipt, type ComputerNativeObservation, type ComputerNativeProvider } from '../../src/modules/computer';
import { AstraJournal } from '../../src/agent-v3/journal';
import { AstraWorkScheduler } from '../../src/agent-v3/work-scheduler';
import { AstraComputerObserveWorkAdapter } from '../../src/agent-v3/computer-observe-work-adapter';
import { isolatedLocalSecurity } from '../fixtures/agent-v3/local-security';
import { MonarchAstraTaskFacade, type AstraComputerSelectionSnapshot, type AstraTaskHttpRequest } from '../../src/app/astra-task-facade';
import { AstraPreparedModelClient } from '../../src/agent-v3/prepared-model-client';
import { createHash, createHmac } from 'node:crypto';
import { createMonarchHttpServer } from '../../src/app/http-server';
import type { MonarchApplication } from '../../src/app/application';
import { AstraComputerSelectionStore } from '../../src/app/astra-computer-selection-store';
import { AstraComputerActionPlanStore } from '../../src/app/astra-computer-action-plan-store';
import { AstraComputerPicker } from '../../src/app/astra-computer-picker';
import { EventEmitter } from 'node:events';
import { attachAstraDesktopHost } from '../../src/app/astra-desktop-host';
import { AstraTargetSelectionStore } from '../../src/app/astra-target-selection-store';

const marker = 'astra-computer-observe-synthetic-only';
const windowRef = 'hwnd:0000000000000042', title = 'Astra synthetic selected window';
const processInstanceId = 'process:' + '4'.repeat(64);
async function setup(enabled = true, acquire = true) {
  const parent = await realpath('.test-tmp'); expect(path.parse(parent).root.toUpperCase()).toBe('D:\\');
  const root = await realpath(await mkdtemp(path.join(parent, 'astra-v3-computer-observe-')));
  await writeFile(path.join(root, '.fixture-marker'), marker, { flag: 'wx' });
  let revoked = false;
  const provider: ComputerNativeProvider = {
    status: async () => ({ available: true, provider: 'synthetic-no-desktop' }),
    listWindows: vi.fn(async () => { throw Error('window-enumeration-forbidden'); }),
    act: vi.fn(async () => { throw Error('native-input-forbidden'); }),
    observe: vi.fn(async (ref, screenshotPath, _signal, selection): Promise<ComputerNativeObservation> => ({
      observedAt: new Date().toISOString(), selectionBinding: selection,
      window: { windowRef: ref, processId: 42, processInstanceId, processName: 'AstraFixture', title, minimized: false, foreground: false,
        bounds: { x: 0, y: 0, width: 400, height: 300 } },
      screenshot: { path: screenshotPath, sha256: 'a'.repeat(64), perceptualHash: 'a'.repeat(16),
        width: 400, height: 300, captureMethod: 'synthetic', occlusionSafe: true },
      stateFingerprint: 'synthetic', focusedElementId: null, truncated: false,
      elements: [{ elementId: 'selected_editor', automationId: 'qaEditor', className: 'Edit', controlType: 'Edit',
        name: 'Editor', value: 'Untrusted window text', password: false, enabled: true, offscreen: false, focused: false,
        focusable: true, patterns: ['value'], bounds: { x: 1, y: 1, width: 200, height: 100 } }],
    })),
  };
  const computer = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'runtime'), observationRoot: path.join(root, 'observations'),
    controlStatePath: path.join(root, 'control.json'), nativeProvider: provider,
    visionAnalyzer: { analyze: async () => { throw Error('vision-forbidden'); } } });
  const kernel = new MonarchKernel({ workspaceRoot: root, agencyStateDirectory: false,
    permissionProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' } });
  kernel.registerModule(computer); kernel.registerModule(isolatedLocalSecurity(root)); await kernel.start();
  // Explicit fixture-owned local user control, not an action available to Astra.
  if (enabled) computer.control.start('owned-synthetic-user');
  const journal = new AstraJournal(path.join(root, 'astra.sqlite'));
  const options = { deployment: 'isolated-validation' as const, kernel, journal,
    selection: { id: 'owned_window', windowRef, processId: 42, processInstanceId, title, expiresAt: Date.now() + 60000,
      source: { conversationId: 'synthetic_chat', inputMessageId: 'synthetic_message', userText: 'Read only the selected QA window.' } },
    isSourceCurrent: () => !revoked };
  const adapter = new AstraComputerObserveWorkAdapter(options);
  const schedulerOptions = { deployment: 'isolated-validation' as const, scopeId: 'computer_fixture', journal, adapters: [adapter] };
  const scheduler = new AstraWorkScheduler(schedulerOptions); if (acquire) scheduler.acquire();
  const dispatch = vi.spyOn(kernel, 'executeActionProposal');
  return { root, kernel, computer, provider, journal, adapter, options, scheduler, schedulerOptions, dispatch,
    revoke: () => { revoked = true; }, submit: (timeoutMs = 1000) => scheduler.submit({ requestId: 'request', adapterId: adapter.id,
      input: { selectionId: 'owned_window', timeoutMs } }),
    close: async () => { await scheduler.close(); await kernel.stop(); journal.close();
      expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent);
      expect(await readFile(path.join(root, '.fixture-marker'), 'utf8')).toBe(marker); await rm(root, { recursive: true }); } };
}

describe('Astra Computer observation pack -> real Kernel/Computer module, synthetic native provider', () => {
  it('captures only the selected window and retains bounded untrusted evidence without another capture on replay', async () => {
    const s = await setup();
    try {
      const job = s.submit(); await s.scheduler.drain();
      expect(s.scheduler.job(job.id), JSON.stringify(s.scheduler.job(job.id))).toMatchObject({ state: 'observed' });
      const view = s.adapter.inspect(job.input);
      expect(view.nativeCompletionCertified).toBe(false);
      expect(view.checkpoint.observation).toMatchObject({ authority: 'none', authorizesInput: false, processId: 42, windowRef,
        elements: [expect.objectContaining({ value: 'Untrusted window text' })] });
      expect(JSON.stringify(view)).not.toContain(s.root); expect(s.dispatch).toHaveBeenCalledTimes(1);
      expect(s.provider.observe).toHaveBeenCalledWith(windowRef, expect.any(String), expect.any(AbortSignal), { processId: 42, processInstanceId, title });
      await s.scheduler.drain(); s.adapter.reconcile(job.input, () => s.scheduler.ownerIsCurrent());
      expect(s.provider.observe).toHaveBeenCalledTimes(1); expect(s.provider.act).not.toHaveBeenCalled(); expect(s.provider.listWindows).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it.each(['missing-binding', 'wrong-process', 'wrong-instance', 'wrong-title'] as const)('rejects a native observation with %s', async mode => {
    const s = await setup(), original = s.provider.observe;
    s.provider.observe = vi.fn(async (...args: Parameters<ComputerNativeProvider['observe']>) => { const output = await original(...args);
      if (mode === 'missing-binding') delete output.selectionBinding;
      if (mode === 'wrong-process') output.window.processId++;
      if (mode === 'wrong-instance') output.window.processInstanceId = `process:${'5'.repeat(64)}`;
      if (mode === 'wrong-title') output.window.title += ' other';
      return output; });
    try {
      const job = s.submit(); await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect(s.adapter.inspect(job.input).checkpoint.observation).toBeUndefined();
      expect(s.provider.observe).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('does not enable Computer Use and cannot capture when local user control is off', async () => {
    const s = await setup(false);
    try { const job = s.submit(); await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect(s.provider.observe).not.toHaveBeenCalled(); expect(s.computer.control.snapshot().enabled).toBe(false);
    } finally { await s.close(); }
  });
  it('rechecks source revocation after asynchronous Kernel observers before native capture', async () => {
    const s = await setup(); const off = s.kernel.subscribeEvent('capability.execution.started', async () => { await Promise.resolve(); s.revoke(); });
    try { const job = s.submit(); await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).not.toBe('observed');
      expect(s.provider.observe).not.toHaveBeenCalled();
    } finally { off(); await s.close(); }
  });
  it('never persists password element text or silently drops the truncation marker', async () => {
    const s = await setup(), original = s.provider.observe;
    s.provider.observe = vi.fn(async (...args: Parameters<ComputerNativeProvider['observe']>) => { const value = await original(...args); value.truncated = true;
      value.elements.push({ ...value.elements[0]!, elementId: 'password', password: true, name: 'Synthetic private marker', value: 'do-not-retain' }); return value; });
    try { const job = s.submit(); await s.scheduler.drain(); const view = s.adapter.inspect(job.input);
      expect(view.checkpoint.observation).toMatchObject({ truncated: true, omittedPasswordElements: 1 });
      expect(JSON.stringify(view)).not.toContain('do-not-retain'); expect(JSON.stringify(view)).not.toContain('Synthetic private marker');
    } finally { await s.close(); }
  });
  it.each(['oversized', 'old-receipt'] as const)('rejects %s evidence without a second capture', async mode => {
    const s = await setup(), original = s.provider.observe;
    s.provider.observe = vi.fn(async (...args: Parameters<ComputerNativeProvider['observe']>) => { const value = await original(...args);
      if (mode === 'oversized') value.elements = Array.from({ length: 129 }, (_, index) => ({ ...value.elements[0]!, elementId: 'element_' + index }));
      else value.observedAt = new Date(0).toISOString();
      return value; });
    try { const job = s.submit(); await s.scheduler.drain(); expect(s.scheduler.job(job.id).state).toBe('blocked');
      expect(s.adapter.inspect(job.input).checkpoint.observation).toBeUndefined(); expect(s.provider.observe).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('preserves unknown native occupancy until a late return, then cancels without another capture', async () => {
    const s = await setup(), original = s.provider.observe;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    s.provider.observe = vi.fn(async (...args: Parameters<ComputerNativeProvider['observe']>) => { entered(); await gate; return original(...args); });
    try {
      const job = s.submit(50), flight = s.scheduler.drain(); await started;
      s.scheduler.command(job.id, 'cancel'); await flight;
      expect(s.scheduler.job(job.id).state).toBe('cancelling'); expect(s.journal.reservation(job.reservationId)).not.toBeNull();
      expect(s.adapter.inspect(job.input).checkpoint.quiescent).toBe(false);
      release();
      for (let i = 0; i < 100 && !s.adapter.inspect(job.input).checkpoint.quiescent; i++) await immediate();
      expect(s.adapter.inspect(job.input).checkpoint.quiescent).toBe(true);
      s.scheduler.reconcile(job.id); expect(s.scheduler.job(job.id).state).toBe('cancelled');
      expect(s.provider.observe).toHaveBeenCalledTimes(1); expect(s.dispatch).toHaveBeenCalledTimes(1);
    } finally { release(); await s.close(); }
  });
  it('restores retained evidence under a fresh scheduler without using its old observation as input authority', async () => {
    const s = await setup();
    try {
      const job = s.submit(); await s.scheduler.drain(); await s.scheduler.close();
      const adapter = new AstraComputerObserveWorkAdapter(s.options), next = new AstraWorkScheduler({ ...s.schedulerOptions, adapters: [adapter] });
      try { next.acquire(); await next.drain(); expect(next.job(job.id).state).toBe('observed');
        expect(adapter.inspect(job.input).checkpoint.observation?.authorizesInput).toBe(false);
        expect(s.provider.observe).toHaveBeenCalledTimes(1);
      } finally { await next.close(); }
    } finally { await s.close(); }
  });
  it('rejects arbitrary window fields and stale selection before admission', async () => {
    const s = await setup();
    try {
      expect(() => s.scheduler.submit({ requestId: 'bad', adapterId: s.adapter.id, input: { selectionId: 'owned_window', windowRef: 'hwnd:1234' } })).toThrow('input');
      s.revoke(); expect(() => s.submit()).toThrow('source-stale'); expect(s.dispatch).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it.each(['before-kernel', 'after-receipt'] as const)('recovers the %s persistence boundary without re-observing', async boundary => {
    const s = await setup(), append = s.journal.appendAtomic.bind(s.journal); let fault = true;
    const spy = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
      const cp = input.primary.checkpoint as { schemaVersion?: string; phase?: string };
      if (fault && cp.schemaVersion === 'monarch.astra-v3-computer-observe.internal.v1'
        && cp.phase === (boundary === 'before-kernel' ? 'dispatching' : 'settled')) {
        fault = false;
        if (boundary === 'before-kernel') append(input, guard); // Durable intent; no dispatch receipt.
        throw Error('owned-persistence-cut');
      }
      return append(input, guard);
    });
    try {
      const job = s.submit(); await s.scheduler.drain(); spy.mockRestore();
      expect(fault).toBe(false); expect(s.scheduler.job(job.id).state).toBe('indeterminate');
      const calls = boundary === 'before-kernel' ? 0 : 1;
      expect(s.provider.observe).toHaveBeenCalledTimes(calls); await s.scheduler.close();
      const adapter = new AstraComputerObserveWorkAdapter(s.options), next = new AstraWorkScheduler({ ...s.schedulerOptions, adapters: [adapter] });
      try { next.acquire(); next.reconcile(job.id); await next.drain();
        expect(next.job(job.id).state).toBe(boundary === 'before-kernel' ? 'indeterminate' : 'observed');
        expect(s.provider.observe).toHaveBeenCalledTimes(calls); expect(s.dispatch).toHaveBeenCalledTimes(calls);
        if (boundary === 'before-kernel') expect(s.journal.reservation(job.reservationId)).not.toBeNull();
      } finally { await next.close(); }
    } finally { spy.mockRestore(); await s.close(); }
  });
});

const actor = { id: 'sha256:' + 'b'.repeat(64), source: 'desktop' as const };
const request: AstraTaskHttpRequest = { version: 1, clientRequestId: 'window_request', conversationId: 'synthetic_chat',
  inputMessageId: 'synthetic_message', text: 'Read only the selected QA window.', selectionId: 'owned_window', privacyMode: 'persistent' };
async function applicationSetup(enabled = true, durableWindowSelection = false, durableActionPlans = false) {
  const s = await setup(enabled, false);
  const fetchModel = vi.fn<typeof fetch>(async () => { throw Error('model-network-forbidden'); });
  let selected: AstraComputerSelectionSnapshot | undefined = { selectionId: request.selectionId, actor, conversationId: request.conversationId,
    revision: 1, windowRef, processId: 42, processInstanceId, title, expiresAt: Date.now() + 60000, timeoutMs: 1000 };
  let changed = () => {};
  const windowStore = durableWindowSelection ? new AstraComputerSelectionStore({ deployment: 'isolated-validation', journal: s.journal,
    scopeId: 'computer_application', onRevoked: () => changed() }) : undefined;
  const actionPlans = durableActionPlans ? new AstraComputerActionPlanStore({ deployment: 'isolated-validation', journal: s.journal,
    scopeId: 'computer_action_plans', onRevoked: () => changed() }) : undefined;
  const options = { deployment: 'isolated-validation' as const, scopeId: 'computer_application', journal: s.journal, kernel: s.kernel, canonicalRoot: s.root,
    client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: 'http://127.0.0.1:1', bearerToken: 'synthetic-not-used',
      hostGeneration: 'synthetic_no_model', fetch: fetchModel }), policy: { expectedModelDigest: 'sha256:' + 'c'.repeat(64) },
    catalog: { resolve: () => { throw Error('file-selection-forbidden'); } },
    computerCatalog: windowStore ?? { resolve: () => { if (!selected) throw Error('window-selection-revoked'); return selected; } },
    ...(actionPlans ? { computerActionCatalog: actionPlans } : {}) };
  const facade = new MonarchAstraTaskFacade(options);
  changed = () => facade.notifySourceChange();
  const schedulerOptions = { deployment: 'isolated-validation' as const, scopeId: options.scopeId, journal: s.journal, adapters: facade.adapters };
  const scheduler = new AstraWorkScheduler(schedulerOptions); facade.attach(scheduler); facade.start();
  return { ...s, facade, scheduler, schedulerOptions, options, fetchModel, windowStore, actionPlans, revokeWindow: () => { selected = undefined; },
    mutateSelection: (change: Partial<AstraComputerSelectionSnapshot>) => { selected = { ...selected!, ...change }; },
    close: async () => { await facade.stop(); expect(fetchModel).not.toHaveBeenCalled(); await s.close(); } };
}
async function applicationActionSetup(token: string) {
  const s = await setup(true, false);
  s.kernel.setPermissionProfile({ sandboxMode: 'read-only', approvalPolicy: 'on-request' });
  const httpActor = { id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/api').digest('hex'), source: 'api' as const };
  const actionRequest: AstraTaskHttpRequest = { ...request, clientRequestId: 'action_http_request', inputMessageId: 'action_http_message',
    text: 'Replace the exact selected synthetic editor value once.', selectionId: 'owned_action_plan' };
  const sourceSelection = { processId: 42, processInstanceId, title };
  const proposal = s.kernel.prepareActionProposal({ capabilityId: 'computer.window.observe', proposalId: 'owned_action_observe',
    args: { windowRef, captureNonce: 'owned_action_http_seed', selectionBinding: sourceSelection }, reason: 'Owned action HTTP seed.' },
  { requestedBy: 'user:owned-test', intentId: 'owned_action_observe', originatingUserText: actionRequest.text });
  const captured = await s.kernel.executeActionProposal(proposal, { requestedBy: 'user:owned-test', intentId: 'owned_action_observe',
    source: 'desktop', originatingUserText: actionRequest.text });
  expect(captured.result.ok).toBe(true); const output = captured.result.output as any;
  const observation = { authority: 'none' as const, authorizesInput: false as const, temporalSemantics: 'snapshot-at-capture' as const,
    observationId: output.observationId, observedAt: output.observedAt, windowRef, processId: 42, processInstanceId, title,
    screenshotDigest: 'sha256:' + output.screenshot.sha256, truncated: false, omittedPasswordElements: 0,
    elements: output.elements.map((e: any) => ({ elementId: e.elementId, name: e.name, value: e.value, automationId: e.automationId,
      className: e.className, controlType: e.controlType, enabled: e.enabled, offscreen: e.offscreen, focused: e.focused })) };
  const action = { kind: 'type' as const, elementId: 'selected_editor', text: '  HTTP Astra 🟠  ', textMode: 'replace' as const };
  const expiresAt = Date.now() + 60000;
  s.provider.act = vi.fn(async nativeRequest => {
    const after = await s.provider.observe(nativeRequest.windowRef, nativeRequest.afterScreenshotPath, undefined, sourceSelection);
    const receipt: ComputerNativeActionReceipt = { dispatchedAt: new Date().toISOString(), actionKind: 'type', foregroundVerified: false,
      exactTargetVerified: true, dispatchMode: 'uia-semantic', inputLeaseId: nativeRequest.inputLeaseId, controlEpoch: nativeRequest.controlEpoch,
      cursor: { x: 1, y: 1, style: 'oscar-orange', nativeOverlay: true, systemCursorRestored: true, userTakeoverDetected: false,
        dispatchMode: 'uia-semantic', exactTargetVerifiedAtDispatch: true }, after,
      textVerification: { textMode: 'replace', textSha256: createHash('sha256').update(action.text).digest('hex'), valueVerifiedAfterDispatch: true } };
    return receipt;
  });
  const fetchModel = vi.fn<typeof fetch>(async () => { throw Error('model-network-forbidden'); });
  const options = { deployment: 'isolated-validation' as const, scopeId: 'computer_action_application', journal: s.journal, kernel: s.kernel,
    canonicalRoot: s.root, client: new AstraPreparedModelClient({ deployment: 'isolated-validation', endpoint: 'http://127.0.0.1:1',
      bearerToken: 'synthetic-not-used', hostGeneration: 'synthetic_no_model', fetch: fetchModel }),
    policy: { expectedModelDigest: 'sha256:' + 'c'.repeat(64) }, catalog: { resolve: () => { throw Error('file-selection-forbidden'); } },
    computerActionCatalog: { resolve: () => ({ selectionId: actionRequest.selectionId, actor: httpActor,
      conversationId: actionRequest.conversationId, revision: 1, windowRef, processId: 42, processInstanceId, title, expiresAt,
      timeoutMs: 3000, observation, action }) } };
  const facade = new MonarchAstraTaskFacade(options), scheduler = new AstraWorkScheduler({ deployment: 'isolated-validation',
    scopeId: options.scopeId, journal: s.journal, adapters: facade.adapters }); facade.attach(scheduler); facade.start();
  return { ...s, facade, scheduler, httpActor, actionRequest, action, fetchModel,
    close: async () => { await facade.stop(); expect(fetchModel).not.toHaveBeenCalled(); await s.close(); } };
}
describe('Computer observation task through the common Application facade and host', () => {
  it('runs authenticated HTTP approval -> Astra task -> scheduler -> Kernel -> one Computer action', async () => {
    const token = 'synthetic-computer-action-http-test', s = await applicationActionSetup(token);
    const server = createMonarchHttpServer({ app: {} as MonarchApplication, publicDirectory: s.root, apiToken: token,
      requireApiToken: true, astraTasks: s.facade });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const route = '/api/astra/v3/computer-action-tasks', headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    try {
      const admitted = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(s.actionRequest) });
      const created = await admitted.json(); expect(admitted.status, JSON.stringify(created)).toBe(202);
      const url = base + route + '/' + created.task.id, context = { conversationId: s.actionRequest.conversationId,
        inputMessageId: s.actionRequest.inputMessageId }, query = '?' + new URLSearchParams(context);
      let task: any;
      for (let i = 0; i < 100; i++) { task = (await (await fetch(url + query, { headers })).json()).task;
        if (task?.approval) break; await immediate(); }
      expect(task).toMatchObject({ status: 'awaiting-approval', approval: { action: s.action, source: {
        conversationId: s.actionRequest.conversationId, inputMessageId: s.actionRequest.inputMessageId },
      grantScope: 'once', businessCompletionCertified: false } });
      const approval = task.approval;
      expect(s.provider.act).not.toHaveBeenCalled();
      const decision = await fetch(url + '/decide', { method: 'POST', headers, body: JSON.stringify({ version: 1, ...context,
        approvalId: task.approval.id, approvalDigest: task.approval.digest, replyMessageId: 'http_action_approval', decision: 'approve' }) });
      expect(decision.status, await decision.text()).toBe(200);
      for (let i = 0; i < 100; i++) { task = (await (await fetch(url + query, { headers })).json()).task;
        if (task?.message) break; await immediate(); }
      expect(task, JSON.stringify({ jobs: s.scheduler.list(), audit: s.kernel.getSnapshot().audit.slice(-6) })).toMatchObject({ status: 'observed', message: { predecessorMessageId: context.inputMessageId,
        verification: 'internal-computer-action-proof', delivery: 'pending' } });
      expect(s.provider.act).toHaveBeenCalledTimes(1);
      const replay = await fetch(url + '/decide', { method: 'POST', headers, body: JSON.stringify({ version: 1, ...context,
        approvalId: approval.id, approvalDigest: approval.digest,
        replyMessageId: 'http_action_approval', decision: 'approve' }) });
      expect(replay.status).toBe(200); expect(s.provider.act).toHaveBeenCalledTimes(1);
      expect((await fetch(url + '/decide', { method: 'POST', headers, body: JSON.stringify({ version: 1, ...context,
        approvalId: 'wrong', approvalDigest: 'sha256:' + '0'.repeat(64), replyMessageId: 'forged_answer', decision: 'approve' }) })).status).toBe(409);
      expect(s.provider.act).toHaveBeenCalledTimes(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await s.close(); }
  });
  it('joins trusted Electron IPC, native dialog choice, durable selection and task without accepting renderer HWND', async () => {
    const s = await applicationSetup(true, true, true), token = 'owned-desktop-computer-test';
    const desktopActor = { id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/desktop').digest('hex'), source: 'desktop' as const };
    s.provider.listWindows = vi.fn(async () => [{ windowRef, processId: 42, processInstanceId, processName: 'SyntheticWindow', title, minimized: false, foreground: false,
      bounds: { x: 0, y: 0, width: 400, height: 300 } }]);
    const origin = 'http://127.0.0.1:32772', frame = { url: origin + '/' };
    const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
    const hostWindow = { webContents: contents, isDestroyed: () => false };
    const handlers = new Map<string, (event: unknown, value?: unknown) => Promise<any>>();
    const ipcMain = { handle: (key: string, handler: any) => { if (handlers.has(key)) throw Error('duplicate-ipc'); handlers.set(key, handler); },
      removeHandler: (key: string) => handlers.delete(key) };
    const showMessageBox = vi.fn(async (_parent: unknown, _options: { signal: AbortSignal }) => ({ response: 0 }));
    const selections = new AstraTargetSelectionStore({ deployment: 'isolated-validation', scopeId: 'desktop_files', canonicalRoot: s.root, journal: s.journal });
    const host = attachAstraDesktopHost({ deployment: 'isolated-validation', scopeId: 'desktop_windows', canonicalRoot: s.root, journal: s.journal,
      selections, coordinator: { getTurn: async () => null, flushOutbox: vi.fn(async () => {}) }, actor: desktopActor,
      conversationId: request.conversationId, desktopAttestationToken: token,
      ipcMain, window: hostWindow, origin, dialog: {},
      computer: { selections: s.windowStore!, actionPlans: s.actionPlans!, facade: s.facade, kernel: s.kernel, module: s.computer, dialog: { showMessageBox } },
    } as unknown as Parameters<typeof attachAstraDesktopHost>[0]);
    const invoke = (name: string, value?: unknown, event = { sender: contents, senderFrame: frame }) => handlers.get('monarch:astra-' + name)!(event, value);
    try {
      const boot = await invoke('desktop-bootstrap'); expect(boot.computerObservation).toBe(true); expect(boot.computerActions).toBe(true);
      const pick = { version: 1, requestId: 'desktop_pick', source: boot.computerSource };
      await expect(invoke('pick-window', { ...pick, windowRef })).rejects.toThrow('source-request');
      await expect(invoke('pick-window', pick, { sender: {} as any, senderFrame: frame })).rejects.toThrow('untrusted-frame');
      expect(s.provider.listWindows).not.toHaveBeenCalled();
      const chosen = await invoke('pick-window', pick); expect(chosen.status).toBe('selected'); expect(chosen.selection.windowRef).toBeUndefined();
      const input = { ...request, selectionId: chosen.selection.selectionId }, task = s.facade.computerTasks!.submit(desktopActor, input);
      await s.facade.drain(); const observed = s.facade.computerTasks!.read(desktopActor, task.id, input); expect(observed.status).toBe('observed');
      s.facade.computerTasks!.acknowledge(desktopActor, task.id, input, observed.message!.certificateDigest);
      const proposedAction = { kind: 'type', elementId: 'selected_editor', text: 'Exact host plan 🟠', textMode: 'replace' };
      await expect(invoke('issue-computer-action', { version: 1, requestId: 'desktop_action', taskId: task.id,
        action: proposedAction, source: boot.computerSource, windowRef })).rejects.toThrow('source-request');
      const plan = await invoke('issue-computer-action', { version: 1, requestId: 'desktop_action', taskId: task.id,
        action: proposedAction, source: boot.computerSource });
      expect(plan).toMatchObject({ authority: 'approval-required', grantScope: 'none', title });
      expect(plan).not.toHaveProperty('windowRef'); expect(plan).not.toHaveProperty('action');
      expect(await invoke('computer-action-plans', { version: 1, kind: 'list', source: boot.computerSource })).toEqual([plan]);
      expect(s.actionPlans!.resolve(plan.selectionId, { actor: desktopActor, conversationId: request.conversationId,
        inputMessageId: 'action_message', text: 'Run exact reviewed action.' })).toMatchObject({ action: proposedAction,
        windowRef, observation: { elements: [{ elementId: 'selected_editor', enabled: true, offscreen: false, password: false, controlType: 'Edit' }] } });
      await invoke('computer-action-plans', { version: 1, kind: 'revoke', selectionId: plan.selectionId, source: boot.computerSource });
      expect(await invoke('computer-action-plans', { version: 1, kind: 'list', source: boot.computerSource })).toEqual([]);
      expect((await invoke('window-selections', { version: 1, kind: 'list', source: boot.computerSource }))).toEqual([chosen.selection]);
      await invoke('window-selections', { version: 1, kind: 'revoke', selectionId: chosen.selection.selectionId, source: boot.computerSource });
      expect(await invoke('window-selections', { version: 1, kind: 'list', source: boot.computerSource })).toEqual([]);
      let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
      showMessageBox.mockImplementationOnce((_parent, options) => new Promise(resolve => { entered(); options.signal.addEventListener('abort', () => resolve({ response: 0 }), { once: true }); }));
      const pending = invoke('pick-window', { ...pick, requestId: 'during_navigation' });
      const denied = expect(pending).rejects.toThrow(/source-changed|untrusted-frame/u);
      await started; contents.emit('did-start-navigation', { isMainFrame: true }); await denied;
      expect(s.windowStore!.list({ actor: desktopActor, conversationId: request.conversationId })).toEqual([]);
      expect(s.provider.observe).toHaveBeenCalledTimes(1); expect(s.provider.act).not.toHaveBeenCalled();
      host.dispose(); expect(handlers.size).toBe(0);
    } finally { host.dispose(); await s.close(); }
  });
  it('issues a durable choice from Kernel metadata, then observes through the same host and honors persisted revocation', async () => {
    const s = await applicationSetup(true, true), source = { actor, conversationId: request.conversationId, epoch: 'page_1' };
    s.provider.listWindows = vi.fn(async () => [{ windowRef, processId: 42, processInstanceId, processName: 'SyntheticWindow', title, minimized: false, foreground: false,
      bounds: { x: 0, y: 0, width: 400, height: 300 } }]);
    const choose = vi.fn(async () => 0);
    const picker = new AstraComputerPicker({ deployment: 'isolated-validation', store: s.windowStore!, kernel: s.kernel, currentSource: () => source, choose });
    try {
      const picked = await picker.pick({ version: 1, requestId: 'trusted_pick' }, () => {}); expect(picked.status).toBe('selected');
      if (picked.status !== 'selected') throw Error('expected-selection');
      expect(picked.selection).not.toHaveProperty('windowRef'); expect(picked.selection).not.toHaveProperty('processId');
      expect(s.provider.observe).not.toHaveBeenCalled();
      expect(await picker.pick({ version: 1, requestId: 'trusted_pick' }, () => {})).toEqual(picked);
      expect(s.provider.listWindows).toHaveBeenCalledTimes(1); expect(choose).toHaveBeenCalledTimes(1);
      const input = { ...request, selectionId: picked.selection.selectionId }, task = s.facade.computerTasks!.submit(actor, input);
      await s.facade.drain(); expect(s.facade.computerTasks!.read(actor, task.id, input).status).toBe('observed');
      expect(s.dispatch.mock.calls.map(call => call[0].capabilityId)).toEqual(['computer.windows.list', 'computer.window.observe']);
      const pending = s.facade.computerTasks!.submit(actor, { ...input, clientRequestId: 'second', inputMessageId: 'second_message' });
      s.windowStore!.revoke(picked.selection.selectionId, source); await s.facade.drain();
      expect(s.facade.computerTasks!.read(actor, pending.id, { ...input, inputMessageId: 'second_message' }).status).toBe('blocked');
      expect(s.provider.observe).toHaveBeenCalledTimes(1);
      const restored = new AstraComputerSelectionStore({ deployment: 'isolated-validation', journal: s.journal, scopeId: 'computer_application' });
      expect(() => restored.resolve(picked.selection.selectionId, { ...source, inputMessageId: request.inputMessageId, text: request.text })).toThrow('unavailable');
      await expect(picker.pick({ version: 1, requestId: 'trusted_pick' }, () => {})).rejects.toThrow('unavailable');
      expect(s.provider.listWindows).toHaveBeenCalledTimes(1); expect(s.provider.act).not.toHaveBeenCalled();
    } finally { picker.dispose(); await s.close(); }
  });
  it('rolls source, task, queue and capacity back together before SQLite commit, then admits the same request', async () => {
    const s = await applicationSetup();
    try {
      await s.facade.drain(); const capacity = s.journal.capacity(), append = s.journal.appendAtomic.bind(s.journal); let checks = 0;
      const spy = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
        if (input.additional?.some(item => item.events.some(event => (event as { type?: string }).type === 'application.source-admitted')))
          return append(input, () => ++checks === 1 && (!guard || guard()));
        return append(input, guard);
      });
      try { expect(() => s.facade.computerTasks!.submit(actor, request)).toThrow(); } finally { spy.mockRestore(); }
      expect(checks).toBe(2); expect(s.journal.capacity()).toEqual(capacity); expect(s.scheduler.list()).toEqual([]);
      const task = s.facade.computerTasks!.submit(actor, request); await s.facade.drain();
      expect(s.facade.computerTasks!.read(actor, task.id, request).status).toBe('observed'); expect(s.provider.observe).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('retains a completed capture across proof/outbox failure and explicitly recovers without recapturing', async () => {
    const s = await applicationSetup(), append = s.journal.appendAtomic.bind(s.journal);
    const spy = vi.spyOn(s.journal, 'appendAtomic').mockImplementation((input, guard) => {
      if (input.primary.events.some(event => (event as { type?: string }).type === 'computer-task.proof-retained')) throw Error('owned-proof-outbox-failure');
      return append(input, guard);
    });
    try {
      const task = s.facade.computerTasks!.submit(actor, request); await s.facade.drain();
      expect(s.facade.computerTasks!.read(actor, task.id, request)).toMatchObject({ status: 'awaiting-certification', runtimeIssue: 'progression-failed' });
      expect(s.facade.computerTasks!.read(actor, task.id, request).message).toBeUndefined(); expect(s.provider.observe).toHaveBeenCalledTimes(1);
      spy.mockRestore(); await s.facade.computerTasks!.reconcile(actor, task.id, request); await s.facade.drain();
      expect(s.facade.computerTasks!.read(actor, task.id, request).status).toBe('observed'); expect(s.provider.observe).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); await s.close(); }
  });
  it('pauses before capture and resumes the same task without a replacement job', async () => {
    const s = await applicationSetup();
    try {
      const task = s.facade.computerTasks!.submit(actor, request);
      expect(s.facade.computerTasks!.command(actor, task.id, request, 'pause').status).toBe('paused');
      await s.facade.drain(); expect(s.provider.observe).not.toHaveBeenCalled();
      s.facade.computerTasks!.command(actor, task.id, request, 'resume'); await s.facade.drain();
      expect(s.facade.computerTasks!.read(actor, task.id, request).status).toBe('observed');
      expect(s.scheduler.list()).toHaveLength(1); expect(s.provider.observe).toHaveBeenCalledTimes(1);
    } finally { await s.close(); }
  });
  it('runs authenticated HTTP -> common host -> Kernel -> Computer with read-only polling, no model or desktop', async () => {
    const s = await applicationSetup(), token = 'synthetic-computer-http-test';
    const httpActor = { id: 'sha256:' + createHmac('sha256', token).update('monarch.astra-v3.http-actor.v1/api').digest('hex'), source: 'api' as const };
    s.mutateSelection({ actor: httpActor });
    const server = createMonarchHttpServer({ app: {} as MonarchApplication, publicDirectory: s.root, apiToken: token, requireApiToken: true, astraTasks: s.facade });
    const off = createMonarchHttpServer({ app: {} as MonarchApplication, publicDirectory: s.root, apiToken: token, requireApiToken: true });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => off.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port, route = '/api/astra/v3/computer-observe-tasks';
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    try {
      expect((await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status).toBe(401);
      expect((await fetch('http://127.0.0.1:' + (off.address() as { port: number }).port + route, { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(404);
      const admitted = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(request) });
      const response = await admitted.json(); expect(admitted.status, JSON.stringify(response)).toBe(202);
      const url = base + route + '/' + response.task.id;
      const query = '?conversationId=' + request.conversationId + '&inputMessageId=' + request.inputMessageId;
      let view = (await (await fetch(url + query, { headers })).json()).task;
      for (let i = 0; i < 50 && !view.message; i++) view = (await (await fetch(url + query, { headers })).json()).task;
      expect(view).toMatchObject({ status: 'observed', observation: { authorizesInput: false }, modelJobs: 0, computerJobs: 1 });
      expect((await fetch(url + '?conversationId=other&inputMessageId=' + request.inputMessageId, { headers })).status).toBe(404);
      expect((await fetch(url + '/decide', { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(405);
      expect((await fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ ...request, windowRef: 'hwnd:99' }) })).status).toBe(400);
      expect((await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(request) })).status).toBe(202);
      expect(s.provider.observe).toHaveBeenCalledTimes(1); expect(s.provider.act).not.toHaveBeenCalled(); expect(s.provider.listWindows).not.toHaveBeenCalled();
      const acknowledgment = await fetch(url + '/ack', { method: 'POST', headers, body: JSON.stringify({ version: 1,
        conversationId: request.conversationId, inputMessageId: request.inputMessageId, certificateDigest: view.message.certificateDigest }) });
      expect(acknowledgment.status).toBe(200); expect((await acknowledgment.json()).task.message.delivery).toBe('acknowledged');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => off.close(error => error ? reject(error) : resolve())); await s.close();
    }
  });
  it('progresses from one source to one observation and replays the same source without a second capture', async () => {
    const s = await applicationSetup();
    try {
      const task = s.facade.computerTasks!.submit(actor, request);
      // Read-only polling: no test-side drain, scheduler wake or reconcile.
      let view = s.facade.computerTasks!.read(actor, task.id, request);
      for (let i = 0; i < 100 && !view.message; i++) { await immediate(); view = s.facade.computerTasks!.read(actor, task.id, request); }
      expect(view).toMatchObject({ status: 'observed', computerJobs: 1, modelJobs: 0, readJobs: 0,
        observation: { authorizesInput: false }, message: { predecessorMessageId: request.inputMessageId, verification: 'internal-computer-observation-proof' } });
      expect(s.facade.computerTasks!.submit(actor, request).id).toBe(task.id);
      expect(s.facade.computerTasks!.list(actor, request.conversationId)).toHaveLength(1);
      expect(s.provider.observe).toHaveBeenCalledTimes(1); expect(s.scheduler.list()).toHaveLength(1);
      expect(s.facade.computerTasks!.acknowledge(actor, task.id, request, view.message!.certificateDigest).message?.delivery).toBe('acknowledged');
      await s.facade.stop();
      const next = new MonarchAstraTaskFacade(s.options), scheduler = new AstraWorkScheduler({ ...s.schedulerOptions, adapters: next.adapters }); next.attach(scheduler); next.start();
      try { const restored = next.computerTasks!.read(actor, task.id, request);
        expect(restored).toEqual({ ...view, message: { ...view.message!, delivery: 'acknowledged' } });
        expect(s.provider.observe).toHaveBeenCalledTimes(1);
      } finally { await next.stop(); }
    } finally { await s.close(); }
  });
  it('keeps exact actor/chat/message/family boundaries and rejects caller window handles or goal substitution', async () => {
    const s = await applicationSetup();
    try {
      const task = s.facade.computerTasks!.submit(actor, request);
      expect(() => s.facade.computerTasks!.read({ ...actor, id: 'sha256:' + 'd'.repeat(64) }, task.id, request)).toThrow('not-found');
      expect(() => s.facade.computerTasks!.read(actor, task.id, { ...request, conversationId: 'other' })).toThrow('not-found');
      expect(() => s.facade.computerTasks!.read(actor, task.id, { ...request, inputMessageId: 'other' })).toThrow('not-found');
      expect(() => s.facade.read(actor, task.id, request)).toThrow('not-found');
      expect(() => s.facade.computerTasks!.submit(actor, { ...request, windowRef: 'hwnd:99' } as AstraTaskHttpRequest)).toThrow('invalid-request');
      expect(() => s.facade.computerTasks!.submit(actor, { ...request, goal: { kind: 'observe', targets: ['other'] } })).toThrow('invalid-request');
      expect(() => s.facade.computerTasks!.submit(actor, { ...request, text: 'different' })).toThrow('request-conflict');
    } finally { await s.close(); }
  });
  it.each(['revoked', 'reselected', 'cancelled', 'disabled'] as const)('does not capture when %s before dispatch', async mode => {
    const s = await applicationSetup(mode !== 'disabled');
    try {
      const task = s.facade.computerTasks!.submit(actor, request);
      if (mode === 'revoked') s.revokeWindow();
      if (mode === 'reselected') s.mutateSelection({ revision: 2, title: 'Different selected window' });
      if (mode === 'cancelled') s.facade.computerTasks!.command(actor, task.id, request, 'cancel');
      await s.facade.drain(); const view = s.facade.computerTasks!.read(actor, task.id, request);
      expect(view.status).toBe(mode === 'cancelled' ? 'cancelled' : 'blocked');
      expect(view.observation).toBeUndefined(); expect(view.message).toBeDefined(); expect(s.provider.observe).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it.each(['actor', 'conversation', 'expiry'] as const)('rejects a host selection with invalid %s before queue admission', async mismatch => {
    const s = await applicationSetup();
    try {
      s.mutateSelection(mismatch === 'actor' ? { actor: { ...actor, id: 'sha256:' + 'd'.repeat(64) } }
        : mismatch === 'conversation' ? { conversationId: 'other' } : { expiresAt: 1 });
      expect(() => s.facade.computerTasks!.submit(actor, request)).toThrow();
      expect(s.scheduler.list()).toEqual([]); expect(s.provider.observe).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });
  it('does not expose the computer family without explicit host registration', async () => {
    const s = await applicationSetup();
    try { const { computerCatalog: _unused, ...options } = s.options; const disabled = new MonarchAstraTaskFacade(options);
      expect(disabled.computerTasks).toBeUndefined(); expect(disabled.adapters.some(item => item.id === 'admitted-computer-observe')).toBe(false);
    } finally { await s.close(); }
  });
});

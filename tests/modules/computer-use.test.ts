import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateComputerTextInput } from '../../src/modules/computer/native-bridge';
import { describe, expect, it, vi } from 'vitest';
import {
  ComputerModule,
  ComputerUseNativeError,
  immutableComputerSafeBoundary,
  type ComputerNativeActionReceipt,
  type ComputerNativeObservation,
  type ComputerNativeProvider,
} from '../../src/modules/computer';

const TEST_ROOT = path.join(tmpdir(), 'monarch-computer-use-unit');
const WINDOW_REF = 'hwnd:0000000000000042';
const PROCESS_INSTANCE_ID = `process:${'4'.repeat(64)}`;
const ELEMENT_ID = 'el-editor-0';

describe('Computer Use module', () => {
  it.each(['stop-during-probe', 'deactivate-during-probe', 'provider-unavailable', 'cursor-failed', 'stop-during-audit'])('never leaves authority enabled after %s', async failure => {
    const root = path.join(TEST_ROOT, `start-fence-${failure}-${Date.now()}`);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = fakeProvider({ status: vi.fn(async () => {
      if (['stop-during-probe', 'deactivate-during-probe'].includes(failure)) await gate;
      return { available: failure !== 'provider-unavailable' };
    }), startCursorSession: vi.fn(async () => {
      if (failure === 'cursor-failed') throw Error('owned cursor failure');
      return { started: true };
    }) });
    const context = { emit: vi.fn(async () => undefined), audit: vi.fn(async (_kind, message) => {
      if (failure === 'stop-during-audit' && message === 'User enabled Computer Use.')
        await module.executeCapability(request('computer.control.stop', {}), context);
    }) } as any;
    const module = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'runtime'),
      observationRoot: path.join(root, 'observations'), nativeProvider: provider });
    try {
      await module.activate(context);
      const started = module.executeCapability(request('computer.control.start', {}), context);
      if (failure === 'stop-during-probe') {
        expect(await module.executeCapability(request('computer.control.start', {}), context)).toMatchObject({ ok: false });
        await module.executeCapability(request('computer.control.stop', {}), context);
        release();
      }
      if (failure === 'deactivate-during-probe') { await module.deactivate(); release(); }
      expect(await started).toMatchObject({ ok: false });
      expect(await module.executeCapability(request('computer.control.status', {}), context)).toMatchObject({
        output: { control: { enabled: false } },
      });
      if (['stop-during-probe', 'deactivate-during-probe', 'provider-unavailable'].includes(failure)) expect(provider.startCursorSession).not.toHaveBeenCalled();
    } finally { release(); await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });
  it('defers native preparation while disabled, then probes it before enabling CU', async () => {
    const root = path.join(TEST_ROOT, `lazy-start-${Date.now()}`);
    const provider = fakeProvider();
    const context = { emit: vi.fn(async () => undefined), audit: vi.fn(async () => undefined) } as any;
    const module = new ComputerModule({ monarchRoot: root, runtimeRoot: path.join(root, 'runtime'),
      observationRoot: path.join(root, 'observations'), nativeProvider: provider });
    try {
      await module.activate(context);
      expect(provider.status).not.toHaveBeenCalled();
      expect(context.emit).toHaveBeenCalledWith('computer.activated', 'computer', expect.objectContaining({
        provider: { available: null, deferred: true, reason: 'not-checked-until-needed' }, cursorSession: null,
      }));
      expect(await module.executeCapability(request('computer.control.start', {}), context)).toMatchObject({ ok: true });
      expect(provider.status).toHaveBeenCalled();
    } finally { await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });
  it('validates exact text modes before native work without coercion or Unicode repair', () => {
    expect(validateComputerTextInput('', 'replace')).toEqual({ text: '', textMode: 'replace' });
    expect(validateComputerTextInput('  \n', undefined)).toEqual({ text: '  \n', textMode: 'insert' });
    for (const [text, mode] of [['', 'insert'], ['x', 'auto'], ['x', null], [23, 'replace'], ['\uD800', 'insert'], ['\0', 'replace'], ['x'.repeat(4001), 'replace']])
      expect(() => validateComputerTextInput(text, mode)).toThrow(expect.objectContaining({ code: 'computer-text-input-invalid' }));
  });
  it.each(['', '  Exact replacement 🟠\n'])('replaces only with an exact semantic receipt and readback: %j', async text => {
    const root = path.join(TEST_ROOT, `replace-${Date.now()}-${Math.random()}`), provider = fakeProvider(), module = createModule(root, provider), context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const result = await module.executeCapability(request('computer.window.type', { windowRef: WINDOW_REF,
        observationId: (observed.output as any).observationId, elementId: ELEMENT_ID, text, textMode: 'replace' }), context);
      expect(result).toMatchObject({ ok: true, output: { textVerification: { textMode: 'replace', valueVerifiedAfterDispatch: true,
        textSha256: createHash('sha256').update(text).digest('hex') } } });
      expect((provider.act as ReturnType<typeof vi.fn>).mock.calls[0][0].action).toMatchObject({ text, textMode: 'replace' });
    } finally { await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(['missing', 'mode', 'bytes', 'readback', 'dispatch'])('rejects text semantics receipt mismatch without retry: %s', async change => {
    const root = path.join(TEST_ROOT, `type-proof-${change}-${Date.now()}`), provider = fakeProvider(), original = provider.act;
    provider.act = vi.fn(async (...args) => {
      const receipt = await original(...args);
      if (change === 'missing') delete receipt.textVerification;
      if (change === 'mode') receipt.textVerification!.textMode = 'replace';
      if (change === 'bytes') receipt.textVerification!.textSha256 = '0'.repeat(64);
      if (change === 'readback') receipt.textVerification!.valueVerifiedAfterDispatch = true;
      if (change === 'dispatch') receipt.dispatchMode = 'uia-semantic';
      return receipt;
    });
    const module = createModule(root, provider), context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const input = { windowRef: WINDOW_REF, observationId: (observed.output as any).observationId, elementId: ELEMENT_ID, text: 'Exact text' };
      expect(await module.executeCapability(request('computer.window.type', input), context)).toMatchObject({ ok: false,
        error: 'computer-action-state-uncertain', output: { performed: 'unknown' } });
      expect((await module.executeCapability(request('computer.window.type', input), context)).ok).toBe(false);
      expect(provider.act).toHaveBeenCalledTimes(1);
    } finally { await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(['  exact \r\n🟠  ', '   '])('preserves the exact supplied Unicode text %j', async text => {
    const root = path.join(TEST_ROOT, `exact-text-${Date.now()}-${Math.random()}`), provider = fakeProvider(), module = createModule(root, provider), context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const result = await module.executeCapability(request('computer.window.type', { windowRef: WINDOW_REF,
        observationId: (observed.output as any).observationId, elementId: ELEMENT_ID, text }), context);
      expect(result.ok).toBe(true); expect(provider.act).toHaveBeenCalledTimes(1);
      expect((provider.act as ReturnType<typeof vi.fn>).mock.calls[0][0].action).toMatchObject({ text, textMode: 'insert' });
    } finally { await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['post-capture', 'post-store', 'audit', 'rejection-event', 'lease-release', 'forged-audit-proof', 'close-verification'])('never reports not-dispatched after native entry: %s', async stage => {
    const root = path.join(TEST_ROOT, `dispatch-truth-${stage}-${Date.now()}`), provider = fakeProvider(), module = createModule(root, provider), context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const capability = stage === 'close-verification' ? 'computer.window.close' : 'computer.window.type';
      const input = { windowRef: WINDOW_REF, observationId: (observed.output as any).observationId,
        ...(stage === 'close-verification' ? {} : { elementId: ELEMENT_ID, text: 'one attempt' }) };
      if (stage === 'post-capture' || stage === 'rejection-event') (provider.act as ReturnType<typeof vi.fn>).mockRejectedValue(new ComputerUseNativeError('window-not-found', 'Owned fixture: window vanished after input.'));
      if (stage === 'post-store') {
        const act = provider.act; provider.act = vi.fn(async (...args) => {
          const receipt = await act(...args); receipt.after!.observedAt = 'invalid-after-native-action'; return receipt;
        });
      }
      if (stage === 'audit') context.audit.mockRejectedValue(Error('owned-audit-write-failed'));
      if (stage === 'forged-audit-proof') context.audit.mockRejectedValue(new ComputerUseNativeError('unrelated-failure', 'Not a native receipt', 'not-dispatched'));
      if (stage === 'close-verification') (provider.act as ReturnType<typeof vi.fn>).mockRejectedValue(new ComputerUseNativeError('window-close-not-verified', 'Owned fixture: close was sent but window stayed visible.', 'may-have-dispatched'));
      if (stage === 'lease-release') vi.spyOn(module.control, 'release').mockImplementation(() => { throw Error('owned-lease-persistence-failed'); });
      if (stage === 'rejection-event') context.emit.mockImplementation(async (event: string) => { if (event === 'computer.action.rejected') throw Error('owned-event-write-failed'); });
      const result = await module.executeCapability(request(capability, input), context);
      expect(result).toMatchObject({ ok: false, error: 'computer-action-state-uncertain', output: { performed: 'unknown', verified: false } });
      if (stage === 'rejection-event') expect((result.metadata as any).computerDispatch.reportingFailed).toBe(true);
      const replay = await module.executeCapability(request(capability, input), context);
      expect(replay.ok).toBe(false); expect(provider.act).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(['before-native', 'native-preflight'])('proves no dispatch from actual stage, not an error-name allowlist: %s', async stage => {
    const root = path.join(TEST_ROOT, `no-dispatch-${stage}-${Date.now()}`), provider = fakeProvider(), module = createModule(root, provider), context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      if (stage === 'before-native') context.emit.mockImplementation(async (event: string) => { if (event === 'computer.action.started') throw Error('owned-before-native-event-failed'); });
      else (provider.act as ReturnType<typeof vi.fn>).mockRejectedValue(new ComputerUseNativeError('new-native-preflight-code', 'Explicit preflight evidence', 'not-dispatched'));
      const result = await module.executeCapability(request('computer.window.type', { windowRef: WINDOW_REF,
        observationId: (observed.output as any).observationId, elementId: ELEMENT_ID, text: 'one attempt' }), context);
      expect(result).toMatchObject({ ok: false, output: { performed: false, requiresFreshObservation: true },
        metadata: { computerDispatch: { nativePreflightRejected: stage === 'native-preflight', mayHaveDispatched: false } } });
      expect(provider.act).toHaveBeenCalledTimes(stage === 'native-preflight' ? 1 : 0);
    } finally { await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });

  it('yields a cursor-conflicting atom without disabling the shared Computer Use session', async () => {
    const root = path.join(TEST_ROOT, `cooperative-yield-${Date.now()}-${Math.random()}`);
    const provider = fakeProvider({
      act: vi.fn(async () => {
        throw new ComputerUseNativeError(
          'user-cursor-takeover',
          'Owned fixture: user moved the shared cursor.',
          'may-have-dispatched',
        );
      }),
    });
    const module = createModule(root, provider), context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const action = await module.executeCapability(request('computer.window.click', {
        windowRef: WINDOW_REF,
        observationId: (observed.output as any).observationId,
        elementId: ELEMENT_ID,
      }), context);
      const persisted = JSON.parse(await readFile(module.control.statePath, 'utf8'));

      expect(action).toMatchObject({
        ok: false,
        error: 'computer-action-state-uncertain',
        output: { performed: 'unknown', verified: false, requiresFreshObservation: true },
      });
      expect(module.control.snapshot()).toMatchObject({ enabled: true, activeLease: null });
      expect(persisted).toMatchObject({ enabled: true, activeLeaseId: null });
      expect(context.emit).toHaveBeenCalledWith('computer.action.yielded', 'computer', expect.objectContaining({
        reason: 'user-cursor-takeover',
        control: expect.objectContaining({ enabled: true }),
      }));
      expect(await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context))
        .toMatchObject({ ok: true });
    } finally { await module.deactivate(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps Monarch Safe outside Computer Use and Owner override input', () => {
    expect(immutableComputerSafeBoundary({ text: 'E:\\MonarchData\\Safe\\safe-v1' })).toBe(true);
    expect(immutableComputerSafeBoundary({ title: 'Monarch Safe' })).toBe(true);
    expect(immutableComputerSafeBoundary({ text: 'открой обычную папку Документы' })).toBe(false);
  });

  it('publishes a bounded truthful capability snapshot from provider and control state', async () => {
    const root = path.join(TEST_ROOT, `capability-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider();
    const module = createModule(root, provider);
    const context = fakeContext();
    try {
      await expect(module.readCapabilitySnapshot()).resolves.toEqual({
        schemaVersion: 1,
        available: true,
        enabled: false,
        surface: 'computer-use',
        invocation: '@Computer Use',
        ownCursor: true,
        observeAnalyzeAct: true,
        emergencyShortcut: 'Ctrl+Alt+Escape',
      });
      await enableComputerUse(module, context);
      await expect(module.readCapabilitySnapshot()).resolves.toMatchObject({
        available: true,
        enabled: true,
      });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves an exact user-named window before bounding the returned list', async () => {
    const root = path.join(TEST_ROOT, `exact-window-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const exactTitle = 'Monarch exact target';
    const targetWindow = {
      ...observation('hwnd:0000000000000099', 'E:\\target.png').window,
      title: exactTitle,
    };
    const provider = fakeProvider({
      listWindows: vi.fn(async () => [
        observation(WINDOW_REF, 'E:\\fixture.png').window,
        targetWindow,
      ]),
    });
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      const listed = await module.executeCapability(request('computer.windows.list', {
        limit: 1,
        exactTitle,
      }), context);

      expect(provider.listWindows).toHaveBeenCalledWith(100, undefined);
      expect(listed).toMatchObject({
        ok: true,
        output: { windows: [{ windowRef: 'hwnd:0000000000000099', title: exactTitle }] },
      });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('collapses equivalent native host aliases before applying a trusted query limit', async () => {
    const root = path.join(TEST_ROOT, `window-alias-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const base = {
      ...observation(WINDOW_REF, 'E:\\fixture.png').window,
      processName: 'ApplicationFrameHost',
      title: 'Калькулятор',
    };
    const provider = fakeProvider({
      listWindows: vi.fn(async () => [
        { ...base, windowRef: 'hwnd:0000000000000041' },
        { ...base, windowRef: 'hwnd:0000000000000042' },
      ]),
    });
    const module = createModule(root, provider);
    const context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const listed = await module.executeCapability(request('computer.windows.list', {
        titleQuery: 'calculator',
        limit: 2,
      }), context);
      expect((listed.output as any).windows).toHaveLength(1);
      expect((listed.output as any).windows[0].windowRef).toBe('hwnd:0000000000000041');
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a natural window query and closes only its fresh exact observation', async () => {
    const root = path.join(TEST_ROOT, `close-window-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const target = {
      ...observation(WINDOW_REF, 'E:\\fixture.png').window,
      processName: 'lghub',
      title: 'Logitech\u00a0G\u00a0HUB',
    };
    const provider = fakeProvider({
      listWindows: vi.fn(async () => [target]),
      observe: vi.fn(async (windowRef, screenshotPath) => ({
        ...observation(windowRef, screenshotPath),
        window: target,
      })),
      act: vi.fn(async (nativeRequest): Promise<ComputerNativeActionReceipt> => ({
        dispatchedAt: new Date().toISOString(),
        actionKind: 'close',
        foregroundVerified: true,
        exactTargetVerified: true,
        dispatchMode: 'windows-message',
        inputLeaseId: nativeRequest.inputLeaseId,
        controlEpoch: nativeRequest.controlEpoch,
        closed: true,
        closedWindowRef: nativeRequest.windowRef,
        cursor: {
          x: 390,
          y: 30,
          style: 'oscar-orange',
          nativeOverlay: true,
          dispatchMode: 'windows-message',
          exactTargetVerifiedAtDispatch: true,
          systemCursorRestored: true,
          userTakeoverDetected: false,
        },
      })),
    });
    const module = createModule(root, provider);
    const context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const listed = await module.executeCapability(request('computer.windows.list', {
        titleQuery: 'логитеч хаб',
        limit: 2,
      }), context);
      expect(listed).toMatchObject({
        ok: true,
        output: { titleQuery: 'логитеч хаб', windows: [{ windowRef: WINDOW_REF }] },
      });
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const closed = await module.executeCapability(request('computer.window.close', {
        windowRef: WINDOW_REF,
        observationId: String((observed.output as any).observationId),
      }), context);
      expect(closed).toMatchObject({
        ok: true,
        output: {
          performed: true,
          verified: true,
          closed: true,
          ownCursor: { nativeOverlay: true, dispatchMode: 'windows-message' },
        },
      });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('verifies trusted exact text against a fresh UIA observation without consuming it', async () => {
    const root = path.join(TEST_ROOT, `verify-text-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider({
      observe: vi.fn(async (windowRef, screenshotPath) => ({
        ...observation(windowRef, screenshotPath),
        elements: [
          { ...observation(windowRef, screenshotPath).elements[0]!, name: 'Display is 44' },
          { ...observation(windowRef, screenshotPath).elements[0]!, elementId: 'el-result', name: 'Display is 4' },
        ],
      })),
    });
    const module = createModule(root, provider);
    const context = fakeContext();
    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const observationId = String((observed.output as any).observationId);

      const matched = await module.executeCapability(request('computer.window.verify-text', {
        windowRef: WINDOW_REF,
        observationId,
        expectedText: '4',
      }), context);
      const notMatched = await module.executeCapability(request('computer.window.verify-text', {
        windowRef: WINDOW_REF,
        observationId,
        expectedText: '5',
      }), context);

      expect(matched).toMatchObject({ ok: true, output: { verified: true, matched: true, matchedText: 'Display is 4' } });
      expect(notMatched).toMatchObject({ ok: true, output: { verified: true, matched: false } });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('starts fail-closed and persists disabled authority until a direct user enables it', async () => {
    const root = path.join(TEST_ROOT, `default-off-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const module = createModule(root, fakeProvider());
    const context = fakeContext();

    try {
      const persisted = JSON.parse(await readFile(module.control.statePath, 'utf8'));
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context);

      expect(module.control.snapshot()).toMatchObject({ enabled: false, activeLease: null });
      expect(persisted).toMatchObject({ enabled: false, activeLeaseId: null });
      expect(observed).toMatchObject({ ok: false, error: 'computer-use-disabled' });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('revokes the persisted input lease immediately and never claims success for an in-flight atom', async () => {
    const root = path.join(TEST_ROOT, `stop-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    let nativeStarted!: () => void;
    const started = new Promise<void>((resolve) => { nativeStarted = resolve; });
    const provider = fakeProvider({
      act: vi.fn(async (_request, signal) => {
        nativeStarted();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(abortError());
            return;
          }
          signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        throw new Error('unreachable');
      }),
    });
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context);
      const observationId = String((observed.output as any).observationId);
      const actionPromise = module.executeCapability(request('computer.window.click', {
        windowRef: WINDOW_REF,
        observationId,
        elementId: ELEMENT_ID,
      }), context);

      await started;
      const activeState = JSON.parse(await readFile(module.control.statePath, 'utf8'));
      expect(activeState).toMatchObject({ enabled: true });
      expect(activeState.activeLeaseId).toMatch(/^computer-lease-/);

      const stopped = await module.executeCapability(request('computer.control.stop', {}, {
        requestedBy: 'desktop-emergency-stop',
        source: 'desktop',
      }), context);
      const action = await actionPromise;
      const persisted = JSON.parse(await readFile(module.control.statePath, 'utf8'));

      expect(stopped).toMatchObject({
        ok: true,
        output: { stopped: true, control: { enabled: false, activeLease: null } },
      });
      expect(action).toMatchObject({
        ok: false,
        error: 'computer-action-state-uncertain',
        output: { performed: 'unknown', verified: false, reconciliation: 'fresh-observation-required' },
      });
      expect(persisted).toMatchObject({ enabled: false, activeLeaseId: null });
      expect(provider.act).toHaveBeenCalledTimes(1);
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cooperatively revokes a cancelled Agent lease while keeping Computer Use enabled', async () => {
    const root = path.join(TEST_ROOT, `cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    let nativeStarted!: () => void;
    const started = new Promise<void>((resolve) => { nativeStarted = resolve; });
    const provider = fakeProvider({
      act: vi.fn(async (_request, signal) => {
        nativeStarted();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(abortError());
            return;
          }
          signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        throw new Error('unreachable');
      }),
    });
    const module = createModule(root, provider);
    const context = fakeContext();
    const controller = new AbortController();

    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context);
      const observationId = String((observed.output as any).observationId);
      const beforeEpoch = module.control.snapshot().controlEpoch;
      const actionPromise = module.executeCapability(request('computer.window.click', {
        windowRef: WINDOW_REF,
        observationId,
        elementId: ELEMENT_ID,
      }), context, { signal: controller.signal });

      await started;
      controller.abort(new Error('Agent task cancelled by user.'));
      const action = await actionPromise;
      const persisted = JSON.parse(await readFile(module.control.statePath, 'utf8'));

      expect(action).toMatchObject({
        ok: false,
        error: 'computer-action-state-uncertain',
        output: { performed: 'unknown', verified: false, reconciliation: 'fresh-observation-required' },
      });
      expect(module.control.snapshot()).toMatchObject({
        enabled: true,
        controlEpoch: beforeEpoch + 1,
        activeLease: null,
        logicalCursor: { visible: true, leaseId: null },
      });
      expect(persisted).toMatchObject({
        enabled: true,
        controlEpoch: beforeEpoch + 1,
        activeLeaseId: null,
        logicalCursor: { visible: true, leaseId: null },
      });
      expect(await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context)).toMatchObject({ ok: true });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires a fresh observation and preserves uncertainty when focus rejection has no native preflight proof', async () => {
    const root = path.join(TEST_ROOT, `focus-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider({
      act: vi.fn(async () => {
        throw new ComputerUseNativeError(
          'window-focus-rejected',
          'Windows did not grant foreground focus to the exact target window.',
        );
      }),
    });
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context);
      const observationId = String((observed.output as any).observationId);
      const actionInput = {
        windowRef: WINDOW_REF,
        observationId,
        elementId: ELEMENT_ID,
        text: 'focus recovery fixture',
      };

      const rejected = await module.executeCapability(request('computer.window.type', actionInput), context);
      const repeated = await module.executeCapability(request('computer.window.type', actionInput), context);

      expect(rejected).toMatchObject({
        ok: false,
        error: 'computer-action-state-uncertain',
        output: {
          performed: 'unknown',
          verified: false,
          reconciliation: 'fresh-observation-required',
          requiresFreshObservation: true,
          recoveryCapabilityId: 'computer.window.observe',
        },
      });
      expect(repeated).toMatchObject({
        ok: false,
        error: 'observation-already-consumed',
        output: {
          performed: false,
          requiresFreshObservation: true,
          recoveryCapabilityId: 'computer.window.observe',
        },
      });
      expect(provider.act).toHaveBeenCalledTimes(1);
      expect(await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context)).toMatchObject({ ok: true });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps enable authority with the direct user while stop remains approval-free', async () => {
    const root = path.join(TEST_ROOT, `authority-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const module = createModule(root, fakeProvider());
    const context = fakeContext();

    try {
      await module.executeCapability(request('computer.control.stop', {}, {
        requestedBy: 'desktop-emergency-stop',
        source: 'desktop',
      }), context);
      const modelStart = await module.executeCapability(request('computer.control.start', {}, {
        requestedBy: 'agent:oscar',
        source: 'desktop',
        proposalId: 'proposal_fixture',
      }), context);
      const userStart = await module.executeCapability(request('computer.control.start', {}, {
        requestedBy: 'ui:computer-control',
        source: 'desktop',
      }), context);

      expect(modelStart).toMatchObject({ ok: false, error: 'computer-start-user-required' });
      expect(userStart).toMatchObject({ ok: true, output: { control: { enabled: true } } });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-keys a persisted lease after a runtime crash instead of resuming stale input authority', async () => {
    const root = path.join(TEST_ROOT, `crash-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const context = fakeContext();
    const crashedModule = createModule(root, fakeProvider());
    let recoveredModule: ComputerModule | null = null;

    try {
      await enableComputerUse(crashedModule, context);
      const lease = crashedModule.control.acquire('exec-before-crash', WINDOW_REF);
      const crashedEpoch = lease.controlEpoch;
      recoveredModule = createModule(root, fakeProvider());
      const recovered = recoveredModule.control.snapshot();
      const persisted = JSON.parse(await readFile(recoveredModule.control.statePath, 'utf8'));

      expect(recovered).toMatchObject({ enabled: true, activeLease: null });
      expect(recovered.controlEpoch).toBeGreaterThan(crashedEpoch);
      expect(persisted).toMatchObject({ enabled: true, activeLeaseId: null, controlEpoch: recovered.controlEpoch });
      expect(() => crashedModule.control.assertLease(lease)).toThrowError(/revoked/i);
    } finally {
      await recoveredModule?.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns Oscar own-cursor evidence and a fresh read-after-action observation', async () => {
    const root = path.join(TEST_ROOT, `cursor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider({
      act: vi.fn(async (nativeRequest): Promise<ComputerNativeActionReceipt> => ({
        dispatchedAt: new Date().toISOString(),
        actionKind: nativeRequest.action.kind,
        foregroundVerified: true,
        inputLeaseId: nativeRequest.inputLeaseId,
        controlEpoch: nativeRequest.controlEpoch,
        cursor: {
          x: 120,
          y: 105,
          style: 'oscar-orange',
          nativeOverlay: true,
          systemCursorRestored: true,
          userTakeoverDetected: false,
        },
        after: observation(nativeRequest.windowRef, nativeRequest.afterScreenshotPath, 'after'),
      })),
    });
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context);
      const observationId = String((observed.output as any).observationId);
      const action = await module.executeCapability(request('computer.window.click', {
        windowRef: WINDOW_REF,
        observationId,
        elementId: ELEMENT_ID,
      }), context);

      expect(action).toMatchObject({
        ok: true,
        output: {
          performed: true,
          verified: true,
          beforeObservationId: observationId,
          windowRef: WINDOW_REF,
          ownCursor: {
            style: 'oscar-orange',
            nativeOverlay: true,
            systemCursorRestored: true,
            userTakeoverDetected: false,
          },
          after: { verified: true, windowRef: WINDOW_REF },
        },
      });
      expect((action.output as any).afterObservationId).not.toBe(observationId);
      const nativeRequest = (provider.act as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(nativeRequest.cursorOrigin).toEqual({ x: 210, y: 170 });
      expect(context.emit).toHaveBeenCalledWith('computer.cursor.moved', 'computer', expect.objectContaining({
        style: 'oscar-orange',
      }));
      expect(module.control.snapshot()).toMatchObject({
        activeLease: null,
        logicalCursor: { visible: true, x: 120, y: 105, leaseId: null },
      });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects superseded observations and targetless scrolling before native dispatch', async () => {
    const root = path.join(TEST_ROOT, `stale-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider();
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      const first = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      const second = await module.executeCapability(request('computer.window.observe', { windowRef: WINDOW_REF }), context);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      expect(await module.executeCapability(request('computer.window.click', {
        windowRef: WINDOW_REF,
        observationId: String((first.output as any).observationId),
        elementId: ELEMENT_ID,
      }), context)).toMatchObject({ ok: false, error: 'observation-superseded' });
      expect(await module.executeCapability(request('computer.window.scroll', {
        windowRef: WINDOW_REF,
        observationId: String((second.output as any).observationId),
        deltaY: 120,
      }), context)).toMatchObject({ ok: false, error: 'computer-action-target-invalid' });
      expect(provider.act).not.toHaveBeenCalled();
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a native observation timestamp that is unexpectedly in the future', async () => {
    const root = path.join(TEST_ROOT, `clock-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider({
      observe: vi.fn(async (windowRef, screenshotPath) => ({
        ...observation(windowRef, screenshotPath),
        observedAt: new Date(Date.now() + 60_000).toISOString(),
      })),
    });
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      expect(await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context)).toMatchObject({ ok: false, error: 'native-observation-time-invalid' });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('withholds vision and coordinate actions for an occlusion-sensitive capture but keeps exact UIA actions available', async () => {
    const root = path.join(TEST_ROOT, `occlusion-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider({
      observe: vi.fn(async (windowRef, screenshotPath) => ({
        ...observation(windowRef, screenshotPath),
        screenshot: { ...observation(windowRef, screenshotPath).screenshot, occlusionSafe: false, captureMethod: 'screen-copy' },
      })),
    });
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context);
      const observationId = String((observed.output as any).observationId);

      expect((observed.output as any).screenshot).toMatchObject({
        captureMethod: 'screen-copy',
        occlusionSafe: false,
        pixelActionsAllowed: false,
      });
      expect(await module.executeCapability(request('computer.window.analyze', {
        windowRef: WINDOW_REF,
        observationId,
        objective: 'find button',
      }), context)).toMatchObject({ ok: false, error: 'computer-pixel-capture-not-occlusion-safe' });
      expect(await module.executeCapability(request('computer.window.click', {
        windowRef: WINDOW_REF,
        observationId,
        x: 20,
        y: 20,
      }), context)).toMatchObject({ ok: false, error: 'computer-pixel-capture-not-occlusion-safe' });

      const semanticAction = await module.executeCapability(request('computer.window.click', {
        windowRef: WINDOW_REF,
        observationId,
        elementId: ELEMENT_ID,
      }), context);
      expect(semanticAction).toMatchObject({ ok: true, output: { performed: true, verified: true } });
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the private screenshot ring bounded on disk', async () => {
    const root = path.join(TEST_ROOT, `retention-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const provider = fakeProvider({
      observe: vi.fn(async (windowRef, screenshotPath) => {
        await writeFile(screenshotPath, 'fixture', 'utf8');
        return observation(windowRef, screenshotPath);
      }),
    });
    const module = createModule(root, provider);
    const context = fakeContext();

    try {
      await module.activate(context);
      await enableComputerUse(module, context);
      for (let index = 0; index < 70; index += 1) {
        const observed = await module.executeCapability(request('computer.window.observe', {
          windowRef: WINDOW_REF,
        }), context);
        expect(observed.ok).toBe(true);
      }
      const screenshots = (await readdir(module.observationRoot))
        .filter((name) => /^computer-observation-.*\.png$/u.test(name));
      expect(screenshots).toHaveLength(64);
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves Security context from the exact live observation instead of model input', async () => {
    const root = path.join(TEST_ROOT, `security-context-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const module = createModule(root, fakeProvider());
    const context = fakeContext();

    try {
      await enableComputerUse(module, context);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: WINDOW_REF,
      }), context);
      const observationId = String((observed.output as any).observationId);
      const actionRequest = request('computer.window.type', {
        windowRef: WINDOW_REF,
        observationId,
        elementId: ELEMENT_ID,
        text: 'bounded fixture',
      });
      const capability = module.manifest.capabilities.find((entry) => entry.id === 'computer.window.type')!;
      const trusted = module.resolveSecurityActionContext(actionRequest, capability, context);

      expect(trusted).toMatchObject({
        schemaVersion: 1,
        sourceModuleId: 'computer',
        target: {
          operation: 'computer.window.type',
          observationId,
          window: {
            windowRef: WINDOW_REF,
            processName: 'MonarchFixture',
            title: 'Monarch Computer Use Fixture',
          },
          subject: {
            kind: 'semantic',
            elementId: ELEMENT_ID,
            name: 'Editor',
            controlType: 'Edit',
            password: false,
          },
        },
      });
      expect(JSON.stringify(trusted)).not.toContain('bounded fixture');
      expect(JSON.stringify(trusted)).not.toContain('.png');
    } finally {
      await module.deactivate();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function enableComputerUse(module: ComputerModule, context: any): Promise<void> {
  const result = await module.executeCapability(request('computer.control.start', {}, {
    requestedBy: 'ui:computer-control',
    source: 'desktop',
  }), context);
  expect(result).toMatchObject({ ok: true, output: { control: { enabled: true } } });
}

function createModule(root: string, nativeProvider: ComputerNativeProvider): ComputerModule {
  return new ComputerModule({
    monarchRoot: 'E:\\Monarch',
    runtimeRoot: path.join(root, 'runtime'),
    observationRoot: path.join(root, 'observations'),
    controlStatePath: path.join(root, 'runtime', 'control.json'),
    nativeProvider,
    visionAnalyzer: {
      analyze: vi.fn(async () => ({
        summary: 'fixture',
        visibleText: [],
        targets: [],
        model: 'fixture',
      })),
    },
  });
}

function fakeProvider(overrides: Partial<ComputerNativeProvider> = {}): ComputerNativeProvider {
  return {
    status: vi.fn(async () => ({ available: true, provider: 'fixture' })),
    listWindows: vi.fn(async () => [observation(WINDOW_REF, 'E:\\fixture.png').window]),
    observe: vi.fn(async (windowRef, screenshotPath) => observation(windowRef, screenshotPath)),
    act: vi.fn(async (nativeRequest): Promise<ComputerNativeActionReceipt> => ({
      dispatchedAt: new Date().toISOString(),
      actionKind: nativeRequest.action.kind,
      dispatchMode: nativeRequest.action.kind === 'type' && nativeRequest.action.textMode === 'replace' ? 'uia-semantic' : 'windows-input',
      exactTargetVerified: nativeRequest.action.kind === 'type' && nativeRequest.action.textMode === 'replace',
      ...(nativeRequest.action.kind === 'type' ? { textVerification: { textMode: nativeRequest.action.textMode ?? 'insert',
        textSha256: createHash('sha256').update(nativeRequest.action.text).digest('hex'), valueVerifiedAfterDispatch: nativeRequest.action.textMode === 'replace' } } : {}),
      foregroundVerified: true,
      inputLeaseId: nativeRequest.inputLeaseId,
      controlEpoch: nativeRequest.controlEpoch,
      cursor: {
        x: 120,
        y: 105,
        style: 'oscar-orange',
        nativeOverlay: true,
        systemCursorRestored: true,
        userTakeoverDetected: false,
        dispatchMode: nativeRequest.action.kind === 'type' && nativeRequest.action.textMode === 'replace' ? 'uia-semantic' : 'windows-input',
        exactTargetVerifiedAtDispatch: nativeRequest.action.kind === 'type' && nativeRequest.action.textMode === 'replace',
      },
      after: observation(nativeRequest.windowRef, nativeRequest.afterScreenshotPath, 'after'),
    })),
    ...overrides,
  };
}

function observation(windowRef: string, screenshotPath: string, suffix = 'before'): ComputerNativeObservation {
  return {
    observedAt: new Date().toISOString(),
    window: {
      windowRef,
      processId: 42,
      processInstanceId: PROCESS_INSTANCE_ID,
      processName: 'MonarchFixture',
      title: 'Monarch Computer Use Fixture',
      bounds: { x: 10, y: 20, width: 400, height: 300 },
      minimized: false,
      foreground: true,
    },
    screenshot: {
      path: screenshotPath,
      sha256: `${suffix}`.padEnd(64, '0'),
      perceptualHash: suffix === 'after' ? '0000000000000001' : '0000000000000000',
      width: 400,
      height: 300,
      captureMethod: 'fixture',
      occlusionSafe: true,
    },
    stateFingerprint: `state-${suffix}`,
    focusedElementId: ELEMENT_ID,
    elements: [{
      elementId: ELEMENT_ID,
      name: 'Editor',
      automationId: 'qaEditor',
      className: 'Edit',
      controlType: 'Edit',
      bounds: { x: 50, y: 50, width: 120, height: 70 },
      enabled: true,
      offscreen: false,
      focusable: true,
      focused: true,
      password: false,
      patterns: ['value'],
    }],
    truncated: false,
  };
}

function request(
  capabilityId: string,
  input: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id: `exec_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    intentId: 'intent_computer_fixture',
    moduleId: 'computer',
    capabilityId,
    input,
    createdAt: new Date().toISOString(),
    requestedBy: 'test',
    source: 'smoke',
    confirmed: false,
    ...overrides,
  };
}

function fakeContext(): any {
  return {
    emit: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
  };
}

function abortError(): Error {
  const error = new Error('Computer Use action was cancelled by emergency stop.');
  error.name = 'AbortError';
  return error;
}

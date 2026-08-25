import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  MonarchActionPredicateJsonValue,
  MonarchCapability,
  MonarchExecutionControl,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModuleFactoryContext,
  MonarchModulePackage,
  MonarchTrustedActionContext,
} from '../../core';
import { resolveMonarchRuntimePaths } from '../../core/runtime-paths';
import { computerManifest } from './manifest';
import {
  ComputerUseNativeBridge,
  ComputerUseNativeError,
  type ComputerElementSnapshot,
  type ComputerNativeAction,
  type ComputerNativeActionTarget,
  type ComputerNativeObservation,
  type ComputerNativeProvider,
  type ComputerWindowSummary,
} from './native-bridge';
import {
  ComputerUseControlError,
  ComputerUseControlPlane,
  type ComputerUseCapabilitySnapshotV1,
} from './control-plane';
import {
  OscarComputerVisionAnalyzer,
  type ComputerVisionAnalyzer,
  type ComputerVisionTarget,
} from './vision-analyzer';
import { rankComputerWindowQueryMatches } from './window-query';

const DEFAULT_OBSERVATION_MAX_AGE_MS = 5 * 60_000;
const MAX_STORED_OBSERVATIONS = 64;
const MAX_NATIVE_CLOCK_SKEW_MS = 30_000;
const OBSERVATION_FILE_PATTERN = /^computer-observation-[0-9a-f-]+\.png$/iu;
const TEMPORARY_OBSERVATION_FILE_PATTERN = /^computer-observation-[0-9a-f-]+\.png\.(?:preflight|tmp-[0-9a-f-]+)\.png$/iu;

interface StoredVisionTarget extends ComputerVisionTarget {
  visionTargetId: string;
}

interface StoredComputerObservation {
  observationId: string;
  windowRef: string;
  observedAtMs: number;
  controlEpoch: number;
  consumed: boolean;
  native: ComputerNativeObservation;
  visionTargets: Map<string, StoredVisionTarget>;
}

export interface ComputerModuleOptions {
  monarchRoot?: string;
  runtimeRoot?: string;
  observationRoot?: string;
  controlStatePath?: string;
  observationMaxAgeMs?: number;
  nativeProvider?: ComputerNativeProvider;
  visionAnalyzer?: ComputerVisionAnalyzer;
  now?: () => Date;
}

export class ComputerModule implements MonarchModule {
  readonly manifest = computerManifest;
  readonly monarchRoot: string;
  readonly runtimeRoot: string;
  readonly observationRoot: string;
  readonly control: ComputerUseControlPlane;
  private readonly nativeProvider: ComputerNativeProvider;
  private readonly visionAnalyzer: ComputerVisionAnalyzer;
  private readonly now: () => Date;
  private readonly observationMaxAgeMs: number;
  private readonly observations = new Map<string, StoredComputerObservation>();
  private readonly latestObservationByWindow = new Map<string, string>();
  private readonly retainedObservationArtifacts: string[] = [];

  constructor(options: ComputerModuleOptions = {}) {
    this.monarchRoot = path.resolve(options.monarchRoot || process.cwd());
    const runtimePaths = resolveMonarchRuntimePaths(this.monarchRoot);
    this.runtimeRoot = path.resolve(options.runtimeRoot || path.join(runtimePaths.stateRoot, 'computer-use'));
    this.observationRoot = path.resolve(options.observationRoot || path.join(runtimePaths.generatedRoot, 'computer-use', 'observations'));
    this.now = options.now || (() => new Date());
    this.observationMaxAgeMs = clamp(
      options.observationMaxAgeMs ?? DEFAULT_OBSERVATION_MAX_AGE_MS,
      10_000,
      30 * 60_000,
    );
    this.control = new ComputerUseControlPlane(
      options.controlStatePath || path.join(this.runtimeRoot, 'control.json'),
      this.now,
    );
    this.nativeProvider = options.nativeProvider || new ComputerUseNativeBridge({
      monarchRoot: this.monarchRoot,
      runtimeRoot: path.join(this.runtimeRoot, 'native'),
    });
    this.visionAnalyzer = options.visionAnalyzer || new OscarComputerVisionAnalyzer({ projectRoot: this.monarchRoot });
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await mkdir(this.observationRoot, { recursive: true });
    await this.pruneObservationArtifacts();
    const provider = await this.nativeProvider.status();
    const control = this.control.snapshot();
    const cursorSession = provider.available === true && control.enabled
      ? await this.nativeProvider.startCursorSession?.(this.control.statePath)
      : null;
    await context.emit('computer.activated', this.manifest.id, {
      platform: process.platform,
      provider,
      control,
      cursorSession,
    });
  }

  async deactivate(): Promise<void> {
    this.control.shutdown();
    await this.nativeProvider.stopCursorSession?.();
    this.invalidateObservations();
  }

  async health(): Promise<MonarchExecutionResult> {
    const provider = await this.nativeProvider.status();
    return {
      ok: provider.available === true,
      summary: provider.available === true
        ? 'Computer Use native provider, Action Guard boundary, own logical cursor, and emergency stop are ready.'
        : `Computer Use provider is unavailable: ${String(provider.reason || 'unknown reason')}`,
      output: {
        provider,
        control: this.control.snapshot(),
        verified: provider.available === true,
      },
    };
  }

  async readCapabilitySnapshot(): Promise<ComputerUseCapabilitySnapshotV1> {
    const provider = await this.nativeProvider.status().catch(() => ({ available: false }));
    const control = this.control.snapshot();
    return {
      schemaVersion: 1,
      available: provider.available === true,
      enabled: provider.available === true && control.enabled,
      surface: 'computer-use',
      invocation: '@Computer Use',
      ownCursor: true,
      observeAnalyzeAct: true,
      emergencyShortcut: 'Ctrl+Alt+Escape',
    };
  }

  resolveSecurityActionContext(
    request: MonarchExecutionRequest,
    _capability: MonarchCapability,
    _context: MonarchKernelContext,
  ): MonarchTrustedActionContext | undefined {
    if (![
      'computer.window.click',
      'computer.window.close',
      'computer.window.type',
      'computer.window.key',
      'computer.window.scroll',
    ].includes(request.capabilityId)) {
      return undefined;
    }
    const input = readRecord(request.input);
    const stored = this.requireFreshObservation(input, false);
    return {
      schemaVersion: 1,
      sourceModuleId: this.manifest.id,
      target: {
        operation: request.capabilityId,
        observationId: stored.observationId,
        window: {
          windowRef: stored.windowRef,
          processName: stored.native.window.processName,
          title: stored.native.window.title,
          bounds: jsonBounds(stored.native.window.bounds),
        },
        subject: this.securityTargetFor(request.capabilityId, input, stored),
      },
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    executionControl: MonarchExecutionControl = {},
  ): Promise<MonarchExecutionResult> {
    try {
      if (request.capabilityId === 'computer.control.status') return this.controlStatus();
      if (request.capabilityId === 'computer.control.stop') return this.stop(request, context);
      if (request.capabilityId === 'computer.control.start') return this.start(request, context);
      if (immutableComputerSafeBoundary(request.input)) {
        throw new ComputerUseControlError(
          'monarch-safe-isolated',
          'Computer Use cannot address Monarch Safe under any Security mode or Owner override.',
        );
      }
      this.control.assertEnabled();
      if (request.capabilityId === 'computer.windows.list') return await this.listWindows(request, context, executionControl.signal);
      if (request.capabilityId === 'computer.window.observe') return await this.observe(request, context, executionControl.signal);
      if (request.capabilityId === 'computer.window.analyze') return await this.analyze(request, context, executionControl.signal);
      if (request.capabilityId === 'computer.window.verify-text') return await this.verifyText(request, context);
      if (
        request.capabilityId === 'computer.window.click'
        || request.capabilityId === 'computer.window.close'
        || request.capabilityId === 'computer.window.type'
        || request.capabilityId === 'computer.window.key'
        || request.capabilityId === 'computer.window.scroll'
      ) {
        return await this.act(request, context, executionControl.signal);
      }
      return {
        ok: false,
        summary: `Unsupported Computer Use capability: ${request.capabilityId}`,
        error: 'unsupported-capability',
      };
    } catch (error) {
      return computerFailure(error, request.capabilityId);
    }
  }

  private controlStatus(): MonarchExecutionResult {
    return {
      ok: true,
      summary: this.control.snapshot().enabled ? 'Computer Use is enabled.' : 'Computer Use is stopped.',
      output: { verified: true, control: this.control.snapshot() },
      metadata: { observations: [{ ok: true, code: 'computer-control-read', message: 'Control state read from the runtime authority.' }] },
    };
  }

  private async start(request: MonarchExecutionRequest, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    if (
      request.proposalId
      || request.executionMode
      || /^agent(?::|$)/i.test(request.requestedBy)
      || !['desktop', 'system', 'smoke'].includes(request.source || '')
    ) {
      return {
        ok: false,
        summary: 'Only a direct local user control can enable Computer Use.',
        error: 'computer-start-user-required',
      };
    }
    const snapshot = this.control.start(request.requestedBy);
    const cursorSession = await this.nativeProvider.startCursorSession?.(this.control.statePath);
    this.invalidateObservations();
    await context.emit('computer.control.changed', this.manifest.id, {
      action: 'start',
      requestedBy: request.requestedBy,
      control: snapshot,
    });
    await context.audit('computer-use', 'User enabled Computer Use.', {
      requestedBy: request.requestedBy,
      controlEpoch: snapshot.controlEpoch,
    });
    return {
      ok: true,
      summary: 'Computer Use enabled by direct user action.',
      output: { verified: true, control: snapshot, cursorSession: cursorSession || null },
      metadata: { observations: [{ ok: true, code: 'computer-control-started', message: 'The persisted Computer Use epoch is enabled.' }] },
    };
  }

  private async stop(request: MonarchExecutionRequest, context: MonarchKernelContext): Promise<MonarchExecutionResult> {
    const before = this.control.snapshot();
    const snapshot = this.control.stop(request.requestedBy);
    void this.nativeProvider.stopCursorSession?.().catch(() => undefined);
    this.invalidateObservations();
    await context.emit('computer.control.changed', this.manifest.id, {
      action: 'stop',
      requestedBy: request.requestedBy,
      revokedLeaseId: before.activeLease?.leaseId || null,
      control: snapshot,
    });
    await context.audit('computer-use', 'Computer Use emergency stop revoked input authority.', {
      requestedBy: request.requestedBy,
      revokedLeaseId: before.activeLease?.leaseId || null,
      controlEpoch: snapshot.controlEpoch,
    }, 'warn');
    return {
      ok: true,
      summary: before.activeLease
        ? 'Computer Use stopped; the active Oscar input lease was revoked.'
        : 'Computer Use stopped; all previous observations were invalidated.',
      output: { verified: true, stopped: true, control: snapshot },
      metadata: { observations: [{ ok: true, code: 'computer-emergency-stop', message: 'Input authority is disabled at the persisted control epoch.' }] },
    };
  }

  private async listWindows(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    const input = readRecord(request.input);
    const limit = readInteger(input.limit, 40, 1, 100);
    const exactTitle = optionalString(input.exactTitle, 512);
    const titleQuery = optionalString(input.titleQuery, 160);
    if (exactTitle && titleQuery) {
      throw new ComputerUseControlError('computer-window-query-invalid', 'Choose either exactTitle or titleQuery, never both.');
    }
    const enumerated = await this.nativeProvider.listWindows(exactTitle || titleQuery ? 100 : limit, signal);
    const selectedWindows = exactTitle
      ? enumerated.filter((window) => window.title === exactTitle).slice(0, limit)
      : titleQuery
        ? collapseEquivalentComputerWindowMatches(
            rankComputerWindowQueryMatches(enumerated, titleQuery).map((entry) => entry.window),
          ).slice(0, limit)
        : enumerated;
    const windows = selectedWindows.filter((window) => !immutableComputerSafeBoundary({
      title: window.title,
      processName: window.processName,
    }));
    const observedAt = this.now().toISOString();
    await context.emit('computer.windows.listed', this.manifest.id, {
      requestId: request.id,
      count: windows.length,
      observedAt,
    });
    return {
      ok: true,
      summary: `Observed ${windows.length} controllable Windows window${windows.length === 1 ? '' : 's'}${exactTitle ? ' matching the exact requested title' : titleQuery ? ' matching the trusted window query' : ''}.`,
      output: {
        verified: true,
        windows,
        observedAt,
        ...(exactTitle ? { exactTitle } : {}),
        ...(titleQuery ? { titleQuery } : {}),
      },
      metadata: { observations: [{ ok: true, code: 'computer-window-list', message: 'Native Windows enumeration completed.' }] },
    };
  }

  private async observe(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    const input = readRecord(request.input);
    const windowRef = requiredString(input.windowRef, 'windowRef', 80);
    const observationId = `computer-observation-${randomUUID()}`;
    const screenshotPath = this.screenshotPath(observationId);
    const native = await this.nativeProvider.observe(windowRef, screenshotPath, signal);
    if (native.window.windowRef !== windowRef || native.screenshot.path !== screenshotPath) {
      await rm(screenshotPath, { force: true }).catch(() => undefined);
      throw new ComputerUseNativeError('native-observation-binding-invalid', 'Native observation did not bind to the exact requested window and screenshot path.');
    }
    let stored: StoredComputerObservation;
    try {
      stored = await this.storeObservation(observationId, native);
    } catch (error) {
      await rm(screenshotPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await context.emit('computer.window.observed', this.manifest.id, {
      requestId: request.id,
      observationId,
      windowRef,
      screenshotSha256: native.screenshot.sha256,
      elementCount: native.elements.length,
      truncated: native.truncated,
    });
    return observationResult(stored, 'Fresh window observation captured.');
  }

  private async analyze(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    signal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    const input = readRecord(request.input);
    const stored = this.requireFreshObservation(input, false);
    this.assertPixelTargetingAvailable(stored);
    const objective = requiredString(input.objective, 'objective', 1_000);
    const analysis = await this.visionAnalyzer.analyze({
      screenshotPath: stored.native.screenshot.path,
      screenshotWidth: stored.native.screenshot.width,
      screenshotHeight: stored.native.screenshot.height,
      objective,
      ...(signal ? { signal } : {}),
    });
    this.requireStillFresh(stored);
    const targets = analysis.targets.map((target) => {
      const visionTargetId = `vision-target-${randomUUID()}`;
      const storedTarget: StoredVisionTarget = { ...target, visionTargetId };
      stored.visionTargets.set(visionTargetId, storedTarget);
      return {
        visionTargetId,
        label: target.label,
        description: target.description,
        confidence: target.confidence,
      };
    });
    await context.emit('computer.window.analyzed', this.manifest.id, {
      requestId: request.id,
      observationId: stored.observationId,
      windowRef: stored.windowRef,
      targetCount: targets.length,
      model: analysis.model,
    });
    return {
      ok: true,
      summary: analysis.summary,
      output: {
        verified: true,
        observationId: stored.observationId,
        windowRef: stored.windowRef,
        summary: analysis.summary,
        visibleText: analysis.visibleText,
        targets,
        model: analysis.model,
      },
      metadata: {
        observations: [{ ok: true, code: 'computer-vision-analysis', message: 'Oscar Vision analyzed the exact stored screenshot.' }],
        artifacts: [screenshotArtifact(stored)],
      },
    };
  }

  private async verifyText(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
  ): Promise<MonarchExecutionResult> {
    const input = readRecord(request.input);
    const stored = this.requireFreshObservation(input, false);
    const expectedText = requiredString(input.expectedText, 'expectedText', 500);
    const expected = normalizeObservedText(expectedText);
    const facts = stored.native.elements.flatMap((element) => [element.name, element.value || ''])
      .map((value) => String(value || '').replace(/\s+/gu, ' ').trim())
      .filter(Boolean);
    const matchedText = facts.find((value) => observedTextContains(value, expected)) || '';
    await context.emit('computer.window.observed', this.manifest.id, {
      requestId: request.id,
      observationId: stored.observationId,
      windowRef: stored.windowRef,
      verification: 'exact-text',
      matched: Boolean(matchedText),
    });
    return {
      ok: true,
      summary: matchedText
        ? `Проверил результат в окне: ${expectedText}.`
        : `Точный ожидаемый текст пока не найден в окне: ${expectedText}.`,
      output: {
        verified: true,
        matched: Boolean(matchedText),
        observationId: stored.observationId,
        windowRef: stored.windowRef,
        expectedText,
        ...(matchedText ? { matchedText } : {}),
      },
      metadata: {
        observations: [{
          ok: true,
          code: matchedText ? 'computer-window-text-matched' : 'computer-window-text-not-matched',
          message: matchedText
            ? 'The exact fresh window observation contains the trusted expected text.'
            : 'The exact fresh window observation does not yet contain the trusted expected text.',
        }],
      },
    };
  }

  private async act(
    request: MonarchExecutionRequest,
    context: MonarchKernelContext,
    callerSignal?: AbortSignal,
  ): Promise<MonarchExecutionResult> {
    const input = readRecord(request.input);
    const stored = this.requireFreshObservation(input, false);
    const nativeAction = this.nativeAction(request.capabilityId, input, stored);
    const lease = this.control.acquire(request.id, stored.windowRef, callerSignal);
    try {
      // Acquiring a busy lease or rejecting an invalid target performs no
      // Windows input, so it must not burn the observation. Once this short
      // lease exists, the observation becomes a one-shot action authority.
      this.requireStillFresh(stored);
      if (stored.consumed) {
        throw new ComputerUseControlError('observation-already-consumed', 'Observation already authorized one action and cannot be reused.');
      }
      stored.consumed = true;
      this.control.assertLease(lease);
      const cursor = actionCursor(nativeAction, stored.native);
      const windowBounds = stored.native.window.bounds;
      const cursorOrigin = this.control.logicalCursorOrigin(
        windowBounds.x + windowBounds.width / 2,
        windowBounds.y + windowBounds.height / 2,
      );
      const logicalCursor = this.control.moveLogicalCursor(lease, cursor.x, cursor.y);
      await context.emit('computer.cursor.moved', this.manifest.id, {
        cursor: logicalCursor,
        style: 'oscar-orange',
        inputLeaseId: lease.leaseId,
      });
      await context.emit('computer.action.started', this.manifest.id, {
        requestId: request.id,
        capabilityId: request.capabilityId,
        observationId: stored.observationId,
        windowRef: stored.windowRef,
        inputLeaseId: lease.leaseId,
        controlEpoch: lease.controlEpoch,
      });
      const afterObservationId = `computer-observation-${randomUUID()}`;
      const afterScreenshotPath = this.screenshotPath(afterObservationId);
      const receipt = await this.nativeProvider.act({
        windowRef: stored.windowRef,
        expectedProcessId: stored.native.window.processId,
        expectedTitle: stored.native.window.title,
        expectedBounds: stored.native.window.bounds,
        expectedStateFingerprint: stored.native.stateFingerprint,
        expectedPerceptualHash: stored.native.screenshot.perceptualHash,
        action: nativeAction,
        afterScreenshotPath,
        controlStatePath: this.control.statePath,
        controlEpoch: lease.controlEpoch,
        inputLeaseId: lease.leaseId,
        cursorOrigin,
      }, lease.signal);
      const closeAction = nativeAction.kind === 'close';
      if (
        receipt.inputLeaseId !== lease.leaseId
        || receipt.controlEpoch !== lease.controlEpoch
        || receipt.actionKind !== nativeAction.kind
        || (closeAction
          ? receipt.closed !== true || receipt.closedWindowRef !== stored.windowRef
          : !receipt.after
            || receipt.after.window.windowRef !== stored.windowRef
            || receipt.after.window.processId !== stored.native.window.processId
            || !sameLocalPath(receipt.after.screenshot.path, afterScreenshotPath))
        || receipt.cursor?.style !== 'oscar-orange'
        || receipt.cursor?.nativeOverlay !== true
      ) {
        throw new ComputerUseNativeError('action-verification-invalid', 'Post-action receipt did not verify the exact input lease, Oscar cursor, process, and screenshot path.');
      }
      const userTakeoverDetected = receipt.cursor?.userTakeoverDetected === true;
      const exactSemanticDispatch = receipt.dispatchMode === 'uia-semantic'
        && receipt.exactTargetVerified === true
        && receipt.cursor?.dispatchMode === 'uia-semantic'
        && receipt.cursor?.exactTargetVerifiedAtDispatch === true;
      const exactNativeCloseDispatch = closeAction
        && receipt.dispatchMode === 'windows-message'
        && receipt.exactTargetVerified === true
        && receipt.cursor?.dispatchMode === 'windows-message'
        && receipt.cursor?.exactTargetVerifiedAtDispatch === true;
      let takeoverControl = null;
      if (userTakeoverDetected) {
        takeoverControl = this.control.stop('user-cursor-takeover');
        void this.nativeProvider.stopCursorSession?.().catch(() => undefined);
        this.invalidateObservations();
        await context.emit('computer.control.changed', this.manifest.id, {
          action: 'stop',
          reason: 'user-cursor-takeover',
          control: takeoverControl,
        });
      } else {
        this.control.assertLease(lease);
      }
      if (!receipt.foregroundVerified && !exactSemanticDispatch && !exactNativeCloseDispatch) {
        if (userTakeoverDetected) {
          throw new ComputerUseControlError(
            'user-cursor-takeover-stop',
            'Computer Use stopped after user cursor takeover; a fresh observation is required.',
          );
        }
        throw new ComputerUseNativeError('action-verification-invalid', 'Post-action receipt verified neither exact foreground Windows input nor an exact semantic target dispatch.');
      }
      const actionReceiptId = `computer-action-${randomUUID()}`;
      if (closeAction) {
        this.invalidateObservation(stored);
        await context.emit('computer.action.completed', this.manifest.id, {
          requestId: request.id,
          capabilityId: request.capabilityId,
          actionReceiptId,
          beforeObservationId: stored.observationId,
          windowRef: stored.windowRef,
          closed: true,
          inputLeaseId: lease.leaseId,
          controlEpoch: lease.controlEpoch,
        });
        await context.audit('computer-use', 'Computer Use closed one exact observed Windows window.', {
          requestId: request.id,
          capabilityId: request.capabilityId,
          actionReceiptId,
          beforeObservationId: stored.observationId,
          windowRef: stored.windowRef,
          inputLeaseId: lease.leaseId,
          controlEpoch: lease.controlEpoch,
          dispatchMode: 'windows-message',
        });
        return {
          ok: true,
          summary: `Закрыл окно ${stored.native.window.title}.`,
          output: {
            performed: true,
            verified: true,
            closed: true,
            actionReceiptId,
            beforeObservationId: stored.observationId,
            windowRef: stored.windowRef,
            inputLeaseId: lease.leaseId,
            controlEpoch: lease.controlEpoch,
            ownCursor: {
              style: 'oscar-orange',
              logicalPosition: logicalCursor,
              nativeOverlay: true,
              dispatchMode: 'windows-message',
              exactTargetVerified: true,
              physics: 'critically-damped-spring',
              animation: receipt.cursor?.animation || null,
              systemCursorRestored: receipt.cursor?.systemCursorRestored === true,
              userTakeoverDetected,
            },
          },
          metadata: {
            observations: [{ ok: true, code: 'computer-window-closed', message: 'Native provider verified that the exact observed window is no longer visible.' }],
          },
        };
      }
      if (!receipt.after) {
        throw new ComputerUseNativeError('action-verification-invalid', 'Post-action receipt omitted the exact read-after-action observation.');
      }
      let after: StoredComputerObservation;
      try {
        after = await this.storeObservation(afterObservationId, receipt.after);
      } catch (error) {
        await rm(afterScreenshotPath, { force: true }).catch(() => undefined);
        throw error;
      }
      if (userTakeoverDetected) this.invalidateObservations();
      await context.emit('computer.action.completed', this.manifest.id, {
        requestId: request.id,
        capabilityId: request.capabilityId,
        actionReceiptId,
        beforeObservationId: stored.observationId,
        afterObservationId,
        windowRef: stored.windowRef,
        inputLeaseId: lease.leaseId,
        controlEpoch: lease.controlEpoch,
      });
      await context.audit('computer-use', 'Computer Use dispatched one verified Windows input atom.', {
        requestId: request.id,
        capabilityId: request.capabilityId,
        actionReceiptId,
        beforeObservationId: stored.observationId,
        afterObservationId,
        windowRef: stored.windowRef,
        inputLeaseId: lease.leaseId,
        controlEpoch: lease.controlEpoch,
        dispatchMode: exactSemanticDispatch ? 'uia-semantic' : 'windows-input',
      });
      return {
        ok: true,
        summary: `Computer Use performed one ${receipt.actionKind} action and captured a fresh exact-window receipt.`,
        output: {
          performed: true,
          verified: true,
          actionReceiptId,
          beforeObservationId: stored.observationId,
          afterObservationId,
          windowRef: stored.windowRef,
          inputLeaseId: lease.leaseId,
          controlEpoch: lease.controlEpoch,
          ownCursor: {
            style: 'oscar-orange',
            logicalPosition: logicalCursor,
            nativeOverlay: true,
            dispatchMode: exactSemanticDispatch ? 'uia-semantic' : 'windows-input',
            exactTargetVerified: exactSemanticDispatch,
            physics: 'critically-damped-spring',
            animation: receipt.cursor?.animation || null,
            systemCursorRestored: receipt.cursor?.systemCursorRestored === true,
            userTakeoverDetected,
          },
          ...(takeoverControl ? { computerUseStopped: true, control: takeoverControl } : {}),
          after: publicObservation(after),
        },
        metadata: {
          observations: [{ ok: true, code: 'computer-read-after-action', message: 'Native provider captured a new exact-window observation after one input atom.' }],
          artifacts: [screenshotArtifact(after)],
        },
      };
    } catch (error) {
      if (errorCode(error) === 'user-cursor-takeover') {
        const takeoverControl = this.control.stop('user-cursor-takeover');
        void this.nativeProvider.stopCursorSession?.().catch(() => undefined);
        this.invalidateObservations();
        await context.emit('computer.control.changed', this.manifest.id, {
          action: 'stop',
          reason: 'user-cursor-takeover',
          control: takeoverControl,
        });
      }
      await context.emit('computer.action.rejected', this.manifest.id, {
        requestId: request.id,
        capabilityId: request.capabilityId,
        observationId: stored.observationId,
        windowRef: stored.windowRef,
        inputLeaseId: lease.leaseId,
        error: errorCode(error),
      });
      throw error;
    } finally {
      this.control.release(lease);
    }
  }

  private nativeAction(
    capabilityId: string,
    input: Record<string, unknown>,
    stored: StoredComputerObservation,
  ): ComputerNativeAction {
    if (capabilityId === 'computer.window.click') {
      const target = this.resolvePointTarget(input, stored, true);
      return {
        kind: 'click',
        ...target,
        button: readEnum(input.button, ['left', 'right', 'middle'] as const, 'left'),
        clicks: readInteger(input.clicks, 1, 1, 2) as 1 | 2,
      };
    }
    if (capabilityId === 'computer.window.close') {
      return { kind: 'close' };
    }
    if (capabilityId === 'computer.window.type') {
      const element = this.requireElement(input, stored);
      if (element.password) {
        throw new ComputerUseControlError('password-field-blocked', 'Computer Use never types into an observed password element.');
      }
      const text = requiredString(input.text, 'text', 4_000);
      if (isWindowsExplorerObservation(stored)
        && immutableComputerSafeBoundary(`${element.value || ''}${text}`)) {
        throw new ComputerUseControlError(
          'monarch-safe-isolated',
          'Computer Use cannot construct a Monarch Safe path in File Explorer.',
        );
      }
      return {
        kind: 'type',
        target: nativeTarget(element),
        text,
      };
    }
    if (capabilityId === 'computer.window.key') {
      if (isWindowsExplorerObservation(stored)) {
        throw new ComputerUseControlError(
          'computer-explorer-key-target-blocked',
          'File Explorer keyboard navigation is withheld because it cannot prove the destination excludes Monarch Safe; use exact semantic elements.',
        );
      }
      return {
        kind: 'key',
        key: requiredString(input.key, 'key', 20).toLowerCase(),
        modifiers: readStringArray(input.modifiers, 3),
      };
    }
    const target = this.resolvePointTarget(input, stored, true);
    return {
      kind: 'scroll',
      ...target,
      deltaY: readInteger(input.deltaY, 0, -1_200, 1_200),
    };
  }

  private securityTargetFor(
    capabilityId: string,
    input: Record<string, unknown>,
    stored: StoredComputerObservation,
  ): { [key: string]: MonarchActionPredicateJsonValue } {
    if (capabilityId === 'computer.window.close') {
      return { kind: 'window', label: stored.native.window.title, closeRequested: true };
    }
    if (capabilityId === 'computer.window.type') {
      return semanticSecurityTarget(this.requireElement(input, stored));
    }
    if (capabilityId === 'computer.window.key') {
      const focused = stored.native.focusedElementId
        ? stored.native.elements.find((element) => element.elementId === stored.native.focusedElementId)
        : undefined;
      return focused
        ? semanticSecurityTarget(focused)
        : { kind: 'window', label: stored.native.window.title };
    }

    const elementId = optionalString(input.elementId, 100);
    const visionTargetId = optionalString(input.visionTargetId, 160);
    const hasX = Number.isInteger(input.x);
    const hasY = Number.isInteger(input.y);
    const modes = Number(Boolean(elementId)) + Number(Boolean(visionTargetId)) + Number(hasX && hasY);
    if (hasX !== hasY || modes !== 1) {
      throw new ComputerUseControlError(
        'computer-action-target-invalid',
        'Choose exactly one semantic element, one server-bound vision target, or one x/y coordinate pair.',
      );
    }
    if (elementId) return semanticSecurityTarget(this.requireElement(input, stored));
    if (visionTargetId) {
      this.assertPixelTargetingAvailable(stored);
      const target = stored.visionTargets.get(visionTargetId);
      if (!target) {
        throw new ComputerUseControlError('vision-target-stale-or-missing', 'The visual target is not bound to this exact observation.');
      }
      return {
        kind: 'vision',
        label: target.label,
        description: target.description,
        confidence: target.confidence,
        x: target.x,
        y: target.y,
      };
    }
    this.assertPixelTargetingAvailable(stored);
    return {
      kind: 'coordinate',
      x: readInteger(input.x, -1, 0, stored.native.screenshot.width - 1),
      y: readInteger(input.y, -1, 0, stored.native.screenshot.height - 1),
    };
  }

  private resolvePointTarget(
    input: Record<string, unknown>,
    stored: StoredComputerObservation,
    required: boolean,
  ): { target?: ComputerNativeActionTarget; x?: number; y?: number } {
    const elementId = optionalString(input.elementId, 100);
    const visionTargetId = optionalString(input.visionTargetId, 160);
    const hasX = Number.isInteger(input.x);
    const hasY = Number.isInteger(input.y);
    const modes = Number(Boolean(elementId)) + Number(Boolean(visionTargetId)) + Number(hasX && hasY);
    if (hasX !== hasY || modes > 1 || (required && modes !== 1)) {
      throw new ComputerUseControlError(
        'computer-action-target-invalid',
        'Choose exactly one semantic element, one server-bound vision target, or one x/y coordinate pair.',
      );
    }
    if (elementId) return { target: nativeTarget(this.requireElement(input, stored)) };
    if (visionTargetId) {
      this.assertPixelTargetingAvailable(stored);
      const target = stored.visionTargets.get(visionTargetId);
      if (!target) {
        throw new ComputerUseControlError('vision-target-stale-or-missing', 'The visual target is not bound to this exact observation.');
      }
      return { x: target.x, y: target.y };
    }
    if (hasX && hasY) {
      this.assertPixelTargetingAvailable(stored);
      return {
        x: readInteger(input.x, -1, 0, stored.native.screenshot.width - 1),
        y: readInteger(input.y, -1, 0, stored.native.screenshot.height - 1),
      };
    }
    return {};
  }

  private assertPixelTargetingAvailable(stored: StoredComputerObservation): void {
    if (isWindowsExplorerObservation(stored)) {
      throw new ComputerUseControlError(
        'computer-explorer-pixel-target-blocked',
        'File Explorer actions require an exact semantic UI element so immutable Safe targets can be excluded.',
      );
    }
    if (stored.native.screenshot.occlusionSafe === true) return;
    throw new ComputerUseControlError(
      'computer-pixel-capture-not-occlusion-safe',
      'This window was captured through an occlusion-sensitive screen copy. Pixel analysis and coordinate actions are withheld; use a semantic UI element or capture the unobscured window again.',
    );
  }

  private requireElement(input: Record<string, unknown>, stored: StoredComputerObservation): ComputerElementSnapshot {
    const elementId = requiredString(input.elementId, 'elementId', 100);
    const matches = stored.native.elements.filter((element) => element.elementId === elementId);
    if (matches.length !== 1 || !matches[0]) {
      throw new ComputerUseControlError('element-stale-or-ambiguous', 'The semantic element is missing or ambiguous in the exact observation.');
    }
    if (isWindowsExplorerObservation(stored) && immutableExplorerSafeElement(matches[0])) {
      throw new ComputerUseControlError(
        'monarch-safe-isolated',
        'Computer Use cannot target a Monarch Safe element in File Explorer.',
      );
    }
    return matches[0];
  }

  private requireFreshObservation(
    input: Record<string, unknown>,
    consume: boolean,
  ): StoredComputerObservation {
    const observationId = requiredString(input.observationId, 'observationId', 160);
    const windowRef = requiredString(input.windowRef, 'windowRef', 80);
    const stored = this.observations.get(observationId);
    if (!stored || stored.windowRef !== windowRef) {
      throw new ComputerUseControlError('observation-not-found', 'Observation is not bound to the exact requested window.');
    }
    this.requireStillFresh(stored);
    if (stored.consumed) {
      throw new ComputerUseControlError('observation-already-consumed', 'Observation already authorized one action and cannot be reused.');
    }
    if (consume) stored.consumed = true;
    return stored;
  }

  private requireStillFresh(stored: StoredComputerObservation): void {
    this.control.assertEnabled();
    const snapshot = this.control.snapshot();
    if (stored.controlEpoch !== snapshot.controlEpoch) {
      throw new ComputerUseControlError('observation-control-epoch-stale', 'Observation predates the current Computer Use control epoch.');
    }
    if (this.latestObservationByWindow.get(stored.windowRef) !== stored.observationId) {
      throw new ComputerUseControlError('observation-superseded', 'A newer observation exists for the exact window.');
    }
    if (this.now().getTime() - stored.observedAtMs > this.observationMaxAgeMs) {
      throw new ComputerUseControlError('observation-expired', 'Observation exceeded the bounded action window. Capture a fresh screenshot.');
    }
  }

  private async storeObservation(
    observationId: string,
    native: ComputerNativeObservation,
  ): Promise<StoredComputerObservation> {
    if (immutableComputerSafeBoundary({
      title: native.window.title,
      processName: native.window.processName,
      elements: native.elements.map((element) => ({ name: element.name, value: element.value || '' })),
    })) {
      throw new ComputerUseControlError(
        'monarch-safe-isolated',
        'Computer Use discarded an observation that exposed a Monarch Safe target.',
      );
    }
    const observedAtMs = Date.parse(native.observedAt);
    if (!Number.isFinite(observedAtMs)) {
      throw new ComputerUseNativeError('native-observation-time-invalid', 'Native observation timestamp is invalid.');
    }
    if (observedAtMs > this.now().getTime() + MAX_NATIVE_CLOCK_SKEW_MS) {
      throw new ComputerUseNativeError('native-observation-time-invalid', 'Native observation timestamp is unexpectedly in the future.');
    }
    const stored: StoredComputerObservation = {
      observationId,
      windowRef: native.window.windowRef,
      observedAtMs,
      controlEpoch: this.control.snapshot().controlEpoch,
      consumed: false,
      native,
      visionTargets: new Map(),
    };
    this.observations.set(observationId, stored);
    this.latestObservationByWindow.set(stored.windowRef, observationId);
    while (this.observations.size > MAX_STORED_OBSERVATIONS) {
      const oldestId = this.observations.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.observations.get(oldestId);
      this.observations.delete(oldestId);
      if (oldest && this.latestObservationByWindow.get(oldest.windowRef) === oldestId) {
        this.latestObservationByWindow.delete(oldest.windowRef);
      }
    }
    await this.retainObservationArtifact(native.screenshot.path);
    return stored;
  }

  private async pruneObservationArtifacts(): Promise<void> {
    this.retainedObservationArtifacts.length = 0;
    const entries = await readdir(this.observationRoot, { withFileTypes: true });
    const retained: Array<{ path: string; modifiedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const artifactPath = path.join(this.observationRoot, entry.name);
      if (TEMPORARY_OBSERVATION_FILE_PATTERN.test(entry.name)) {
        await rm(artifactPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (!OBSERVATION_FILE_PATTERN.test(entry.name)) continue;
      const metadata = await stat(artifactPath).catch(() => null);
      if (metadata?.isFile()) retained.push({ path: artifactPath, modifiedAt: metadata.mtimeMs });
    }
    retained.sort((left, right) => left.modifiedAt - right.modifiedAt || left.path.localeCompare(right.path));
    while (retained.length > MAX_STORED_OBSERVATIONS) {
      const oldest = retained.shift();
      if (oldest) await rm(oldest.path, { force: true }).catch(() => undefined);
    }
    this.retainedObservationArtifacts.push(...retained.map((entry) => entry.path));
  }

  private async retainObservationArtifact(artifactPath: string): Promise<void> {
    const resolved = path.resolve(artifactPath);
    if (
      !sameLocalPath(path.dirname(resolved), this.observationRoot)
      || !OBSERVATION_FILE_PATTERN.test(path.basename(resolved))
    ) {
      throw new ComputerUseNativeError(
        'native-observation-path-invalid',
        'Computer Use observation artifact escaped the bounded observation directory.',
      );
    }
    this.retainedObservationArtifacts.push(resolved);
    while (this.retainedObservationArtifacts.length > MAX_STORED_OBSERVATIONS) {
      const oldest = this.retainedObservationArtifacts.shift();
      if (oldest && !sameLocalPath(oldest, resolved)) {
        await rm(oldest, { force: true }).catch(() => undefined);
      }
    }
  }

  private invalidateObservations(): void {
    this.observations.clear();
    this.latestObservationByWindow.clear();
  }

  private invalidateObservation(stored: StoredComputerObservation): void {
    this.observations.delete(stored.observationId);
    if (this.latestObservationByWindow.get(stored.windowRef) === stored.observationId) {
      this.latestObservationByWindow.delete(stored.windowRef);
    }
  }

  private screenshotPath(observationId: string): string {
    return path.join(this.observationRoot, `${observationId}.png`);
  }
}

function collapseEquivalentComputerWindowMatches(
  windows: readonly ComputerWindowSummary[],
): ComputerWindowSummary[] {
  const seen = new Set<string>();
  return windows.filter((window) => {
    const key = [
      normalizeObservedText(window.title),
      normalizeObservedText(window.processName),
      window.bounds.x,
      window.bounds.y,
      window.bounds.width,
      window.bounds.height,
      window.minimized ? 1 : 0,
    ].join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicObservation(stored: StoredComputerObservation): Record<string, unknown> {
  return {
    verified: true,
    observationId: stored.observationId,
    windowRef: stored.windowRef,
    observedAt: stored.native.observedAt,
    window: stored.native.window,
    screenshot: {
      sha256: stored.native.screenshot.sha256,
      width: stored.native.screenshot.width,
      height: stored.native.screenshot.height,
      captureMethod: stored.native.screenshot.captureMethod,
      occlusionSafe: stored.native.screenshot.occlusionSafe,
      pixelActionsAllowed: stored.native.screenshot.occlusionSafe === true,
    },
    focusedElementId: stored.native.focusedElementId,
    elements: stored.native.elements,
    truncated: stored.native.truncated,
  };
}

function normalizeObservedText(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u00A0\u202F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function observedTextContains(value: string, normalizedExpected: string): boolean {
  const normalizedValue = normalizeObservedText(value);
  if (!normalizedExpected || !normalizedValue) return false;
  if (normalizedValue === normalizedExpected) return true;
  if (/\p{L}|\s/u.test(normalizedExpected) && normalizedValue.includes(normalizedExpected)) return true;
  // UI Automation often localizes a calculator display as "Display is 4" or
  // "Отображается 4". Token boundaries prevent expected "4" matching "44".
  const escaped = normalizedExpected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(normalizedValue);
}

function observationResult(stored: StoredComputerObservation, summary: string): MonarchExecutionResult {
  const pixelActionsAllowed = stored.native.screenshot.occlusionSafe === true;
  return {
    ok: true,
    summary: pixelActionsAllowed
      ? summary
      : `${summary} Semantic UI Automation remains available; pixel analysis and coordinates require a fresh unobscured capture.`,
    output: publicObservation(stored),
    metadata: {
      observations: [{
        ok: true,
        code: pixelActionsAllowed ? 'computer-window-observed' : 'computer-window-observed-semantic-only',
        message: pixelActionsAllowed
          ? 'Screenshot and UI Automation tree share one exact native receipt.'
          : 'UI Automation is bound to the exact window, but pixel targeting is withheld because capture was occlusion-sensitive.',
      }],
      artifacts: [screenshotArtifact(stored)],
      warnings: pixelActionsAllowed
        ? []
        : ['Pixel analysis and coordinate actions are unavailable for this occlusion-sensitive capture.'],
    },
  };
}

function screenshotArtifact(stored: StoredComputerObservation): Record<string, unknown> {
  return {
    id: `computer-screenshot-${stored.observationId}`,
    kind: 'image',
    label: `Computer Use · ${stored.native.window.title}`,
    reference: stored.native.screenshot.path,
    checksum: stored.native.screenshot.sha256,
    createdAt: stored.native.observedAt,
  };
}

function nativeTarget(element: ComputerElementSnapshot): ComputerNativeActionTarget {
  return {
    elementId: element.elementId,
    name: element.name,
    automationId: element.automationId,
    className: element.className,
    controlType: element.controlType,
    bounds: element.bounds,
    password: element.password,
  };
}

function semanticSecurityTarget(
  element: ComputerElementSnapshot,
): { [key: string]: MonarchActionPredicateJsonValue } {
  return {
    kind: 'semantic',
    elementId: element.elementId,
    name: element.name,
    automationId: element.automationId,
    className: element.className,
    controlType: element.controlType,
    bounds: jsonBounds(element.bounds),
    enabled: element.enabled,
    offscreen: element.offscreen,
    focused: element.focused,
    password: element.password,
  };
}

function jsonBounds(bounds: { x: number; y: number; width: number; height: number }): {
  [key: string]: MonarchActionPredicateJsonValue;
} {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function actionCursor(action: ComputerNativeAction, observation: ComputerNativeObservation): { x: number; y: number } {
  const relative = action.kind === 'close'
    ? { x: Math.max(0, observation.screenshot.width - 24), y: Math.min(18, Math.max(0, observation.screenshot.height - 1)) }
    : 'target' in action && action.target
    ? {
        x: action.target.bounds.x + Math.floor(action.target.bounds.width / 2),
        y: action.target.bounds.y + Math.floor(action.target.bounds.height / 2),
      }
    : 'x' in action && typeof action.x === 'number' && typeof action.y === 'number'
      ? { x: action.x, y: action.y }
      : observation.focusedElementId
        ? centeredElement(observation.elements.find((element) => element.elementId === observation.focusedElementId))
        : { x: Math.floor(observation.screenshot.width / 2), y: Math.floor(observation.screenshot.height / 2) };
  return {
    x: observation.window.bounds.x + relative.x,
    y: observation.window.bounds.y + relative.y,
  };
}

function centeredElement(element: ComputerElementSnapshot | undefined): { x: number; y: number } {
  return element
    ? {
        x: element.bounds.x + Math.floor(element.bounds.width / 2),
        y: element.bounds.y + Math.floor(element.bounds.height / 2),
      }
    : { x: 0, y: 0 };
}

function computerFailure(error: unknown, capabilityId: string): MonarchExecutionResult {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const actionCapability = [
    'computer.window.click',
    'computer.window.close',
    'computer.window.type',
    'computer.window.key',
    'computer.window.scroll',
  ].includes(capabilityId);
  const uncertainCodes = new Set([
    'computer-action-cancelled',
    'computer-use-stopped',
    'computer-input-lease-revoked',
    'computer-runtime-shutdown',
    'computer-control-revoked',
    'user-cursor-takeover',
    'user-cursor-takeover-stop',
    'windows-input-rejected',
    'native-provider-failed',
    'native-receipt-missing',
    'native-receipt-too-large',
    'native-receipt-invalid',
    'action-verification-invalid',
    'window-close-state-uncertain',
  ]);
  const freshObservationCodes = new Set([
    'observation-already-consumed',
    'observation-stale-window',
    'observation-stale-uia',
    'observation-stale-visual',
    'window-focus-rejected',
    'window-focus-lost',
    'window-occluded',
    'window-not-found',
    'window-unavailable-or-protected',
    'element-stale-or-missing',
    'element-identity-mismatch',
    'element-not-visible',
    'element-focus-failed',
    'cursor-move-failed',
    'window-close-not-verified',
  ]);
  const uncertain = actionCapability && uncertainCodes.has(code);
  const requiresFreshObservation = actionCapability && (uncertain || freshObservationCodes.has(code));
  return {
    ok: false,
    summary: uncertain
      ? `Computer Use stopped during native dispatch; no success is claimed: ${message}`
      : requiresFreshObservation
        ? `Computer Use did not dispatch the requested input; a fresh exact-window observation is required: ${message}`
      : `Computer Use rejected the request: ${message}`,
    error: uncertain ? 'computer-action-state-uncertain' : code,
    output: {
      performed: uncertain ? 'unknown' : false,
      verified: false,
      reconciliation: requiresFreshObservation ? 'fresh-observation-required' : 'not-dispatched',
      ...(requiresFreshObservation ? {
        requiresFreshObservation: true,
        recoveryCapabilityId: 'computer.window.observe',
      } : {}),
    },
    metadata: {
      warnings: uncertain
        ? ['Native dispatch may have started before authority was lost; treat the action state as unknown and observe the exact window again.']
        : requiresFreshObservation
          ? ['The one-shot observation authority was consumed; observe the exact window again before another input atom.']
          : [],
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof ComputerUseControlError || error instanceof ComputerUseNativeError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'computer-action-cancelled';
  return 'computer-use-failed';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function immutableComputerSafeBoundary(value: unknown): boolean {
  const text = stableBoundaryText(value)
    .replaceAll('/', '\\')
    .toLocaleLowerCase('en-US');
  return /(?:^|[^a-z0-9])(?:[a-z]:\\)?monarchdata\\safe(?:\\|$|[^a-z0-9])/iu.test(text)
    || /\bsafe-v1\b/iu.test(text)
    || /\bmonarch[ _-]?safe\b/iu.test(text)
    || /\bmonarchsafe(?:\.exe)?\b/iu.test(text)
    || /(?:frombase64string|encodedcommand|certutil\b[^\r\n]*\bdecode)/iu.test(text);
}

function stableBoundaryText(value: unknown, depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => stableBoundaryText(entry, depth + 1)).join(' ');
  if (typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 256)
    .map(([key, entry]) => `${key} ${stableBoundaryText(entry, depth + 1)}`)
    .join(' ');
}

function isWindowsExplorerObservation(stored: StoredComputerObservation): boolean {
  return /(?:^|\\)explorer(?:\.exe)?$/iu.test(stored.native.window.processName.trim());
}

function immutableExplorerSafeElement(element: ComputerElementSnapshot): boolean {
  const text = `${element.name || ''} ${element.value || ''}`.trim();
  return immutableComputerSafeBoundary(text) || /^(?:safe|monarchdata)$/iu.test(text);
}

function requiredString(value: unknown, label: string, maximum: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maximum) throw new ComputerUseControlError('computer-input-invalid', `${label} is required and bounded.`);
  return text;
}

function optionalString(value: unknown, maximum: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > maximum) throw new ComputerUseControlError('computer-input-invalid', 'Optional Computer Use field is oversized.');
  return text;
}

function readInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ComputerUseControlError('computer-input-invalid', `Integer must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function readStringArray(value: unknown, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== 'string')) {
    throw new ComputerUseControlError('computer-input-invalid', 'Keyboard modifiers are invalid.');
  }
  const result = value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  if (new Set(result).size !== result.length) throw new ComputerUseControlError('computer-input-invalid', 'Keyboard modifiers must be unique.');
  return result;
}

function readEnum<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T[number] : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function sameLocalPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function createComputerModule(context?: MonarchModuleFactoryContext): MonarchModule {
  const workspaceRoot = path.resolve(context?.workspaceRoot || process.cwd());
  const runtimePaths = context?.runtimePaths || resolveMonarchRuntimePaths(workspaceRoot);
  return new ComputerModule({
    monarchRoot: workspaceRoot,
    runtimeRoot: path.join(runtimePaths.stateRoot, 'computer-use'),
    observationRoot: path.join(runtimePaths.generatedRoot, 'computer-use', 'observations'),
    controlStatePath: path.join(runtimePaths.stateRoot, 'computer-use', 'control.json'),
  });
}

export const computerModulePackage: MonarchModulePackage = {
  id: computerManifest.id,
  moduleId: computerManifest.id,
  version: computerManifest.version,
  description: computerManifest.description,
  core: { minVersion: '0.1.0' },
  factory: createComputerModule,
};

export { computerManifest } from './manifest';
export * from './control-plane';
export * from './native-bridge';
export * from './vision-analyzer';

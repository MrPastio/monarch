import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ComputerModule } from '../../src/modules/computer';

const LIVE_QA = process.platform === 'win32' && process.env.MONARCH_COMPUTER_USE_LIVE_QA === '1';
const LIVE_QA_ROOT = process.env.MONARCH_COMPUTER_USE_LIVE_QA_ROOT
  || 'D:\\MonarchQA\\computer-use-live-qa';

describe.skipIf(!LIVE_QA)('Computer Use Windows live acceptance', () => {
  it('observes, clicks, types, and reads back one synthetic exact window', async () => {
    const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const title = `Monarch Computer Use QA ${nonce}`;
    const root = path.join(LIVE_QA_ROOT, nonce);
    const target = await launchQaWindow(title, root);
    const context = {
      emit: vi.fn(async () => undefined),
      audit: vi.fn(async () => undefined),
    } as any;
    const module = new ComputerModule({
      monarchRoot: 'E:\\Monarch',
      runtimeRoot: path.join(root, 'runtime'),
      observationRoot: path.join(root, 'observations'),
      controlStatePath: path.join(root, 'runtime', 'control.json'),
    });

    try {
      await module.activate(context);
      expect(context.emit).toHaveBeenCalledWith('computer.activated', 'computer', expect.objectContaining({
        cursorSession: null,
        control: expect.objectContaining({ enabled: false }),
      }));
      const enabled = await module.executeCapability(request('computer.control.start', {}), context);
      expect(enabled).toMatchObject({
        ok: true,
        output: {
          control: { enabled: true },
          cursorSession: expect.objectContaining({
          started: true,
          persistent: true,
          sizePolicy: 'entire-sprite-max-1.5x-system-cursor',
          preClickWarningMs: 500,
          }),
        },
      });
      const window = await waitForWindow(module, context, title, target);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: window.windowRef,
      }), context);
      expect(observed.ok).toBe(true);
      const before = observed.output as any;
      const button = before.elements.find((element: any) => element.name === 'Commit');
      expect(button).toMatchObject({ controlType: 'Button', password: false });
      await expect(stat(observed.metadata?.artifacts?.[0]?.reference as string)).resolves.toMatchObject({ size: expect.any(Number) });

      const clickStartedAt = Date.now();
      const clicked = await module.executeCapability(request('computer.window.click', {
        windowRef: window.windowRef,
        observationId: before.observationId,
        elementId: button.elementId,
      }), context);
      const clickElapsedMs = Date.now() - clickStartedAt;
      if (!clicked.ok) throw new Error(`Synthetic click failed: ${JSON.stringify(clicked)}`);
      expect(clicked).toMatchObject({
        ok: true,
        output: {
          verified: true,
          ownCursor: { style: 'oscar-orange', nativeOverlay: true },
          after: { windowRef: window.windowRef },
        },
      });
      const clickedOutput = clicked.output as any;
      expect(clickElapsedMs).toBeGreaterThanOrEqual(500);
      expect(clickedOutput.ownCursor.animation).toMatchObject({
        engine: 'oscar-liquid-spring-v1',
        targetFrameRate: 60,
        directionModel: 'continuous-vector-360',
        sizePolicy: 'entire-sprite-max-1.5x-system-cursor',
      });
      expect(clickedOutput.ownCursor.animation.maxVisibleCursorExtentPx).toBe(
        clickedOutput.ownCursor.animation.systemCursorWidthPx * 1.5,
      );
      expect(clickedOutput.ownCursor.animation.frameCount).toBeGreaterThan(55);
      expect(clickedOutput.ownCursor.animation.p95FrameGapMs).toBeLessThanOrEqual(33.34);
      expect(clickedOutput.ownCursor.animation.maxFrameGapMs).toBeLessThanOrEqual(150);
      expect(clickedOutput.ownCursor.animation.directionFrameCount).toBeGreaterThan(0);
      expect(clickedOutput.ownCursor.animation.preClickLeadMs).toBeGreaterThanOrEqual(490);
      expect(clickedOutput.ownCursor.animation.preClickLeadMs).toBeLessThan(650);
      expect(clickedOutput.ownCursor.animation.states).toEqual(expect.arrayContaining([
        'moving',
        'hover',
        'pre-click-vibration',
        'pressed',
        'released',
        'idle-persistent',
      ]));
      if (clickedOutput.ownCursor.dispatchMode === 'uia-semantic') {
        expect(clickedOutput.ownCursor.animation.states).toContain('pressed-dispatch');
      }
      expect(clickedOutput.after.elements.some((element: any) => element.name === 'clicked')).toBe(true);
      expect(module.control.snapshot()).toMatchObject({
        enabled: true,
        activeLease: null,
        logicalCursor: { visible: true, leaseId: null },
      });

      const editor = clickedOutput.after.elements.find((element: any) => (
        element.automationId === 'qaInput' || element.controlType === 'Edit'
      ));
      expect(editor).toBeTruthy();
      const typed = await module.executeCapability(request('computer.window.type', {
        windowRef: window.windowRef,
        observationId: clickedOutput.afterObservationId,
        elementId: editor.elementId,
        text: 'Oscar QA',
      }), context);
      if (!typed.ok) throw new Error(`Synthetic type failed: ${JSON.stringify(typed)}`);
      expect(typed).toMatchObject({
        ok: true,
        output: {
          verified: true,
          ownCursor: { style: 'oscar-orange', nativeOverlay: true },
        },
      });
      const typedOutput = typed.output as any;
      expect(typedOutput.ownCursor.animation).toMatchObject({
        engine: 'oscar-liquid-spring-v1',
        directionModel: 'continuous-vector-360',
        states: expect.arrayContaining(['moving', 'text-precision', 'busy', 'idle-persistent']),
      });
      if (typedOutput.ownCursor.dispatchMode === 'uia-semantic') {
        expect(typedOutput.ownCursor.animation.states).toContain('busy-dispatch');
      }
      expect(typedOutput.ownCursor.animation.p95FrameGapMs).toBeLessThanOrEqual(33.34);
      expect(typedOutput.ownCursor.animation.maxFrameGapMs).toBeLessThanOrEqual(150);
      expect(typedOutput.after.elements.some((element: any) => element.name === 'typed:Oscar QA')).toBe(true);
      const closed = await module.executeCapability(request('computer.window.close', {
        windowRef: window.windowRef,
        observationId: typedOutput.afterObservationId,
      }), context);
      if (!closed.ok) throw new Error(`Synthetic close failed: ${JSON.stringify(closed)}`);
      expect(closed).toMatchObject({
        ok: true,
        output: {
          performed: true,
          verified: true,
          closed: true,
          ownCursor: {
            style: 'oscar-orange',
            nativeOverlay: true,
            dispatchMode: 'windows-message',
            exactTargetVerified: true,
          },
        },
      });
      expect((closed.output as any).ownCursor.animation).toMatchObject({
        engine: 'oscar-liquid-spring-v1',
        preClickLeadMs: expect.any(Number),
        states: expect.arrayContaining(['moving', 'pre-click-vibration', 'pressed', 'released']),
      });
      expect((closed.output as any).ownCursor.animation.preClickLeadMs).toBeGreaterThanOrEqual(490);
    } finally {
      await module.deactivate();
      await terminateExactChild(target);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 90_000);

  it('revokes a native click during its warning phase before the target receives input', async () => {
    const nonce = `stop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const title = `Monarch Computer Use Stop QA ${nonce}`;
    const root = path.join(LIVE_QA_ROOT, nonce);
    const target = await launchQaWindow(title, root);
    const context = {
      emit: vi.fn(async () => undefined),
      audit: vi.fn(async () => undefined),
    } as any;
    const module = createLiveModule(root);

    try {
      await module.activate(context);
      await expectComputerUseEnabled(module, context);
      const window = await waitForWindow(module, context, title, target);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: window.windowRef,
      }), context);
      const before = observed.output as any;
      const button = before.elements.find((element: any) => element.name === 'Commit');
      const action = module.executeCapability(request('computer.window.click', {
        windowRef: window.windowRef,
        observationId: before.observationId,
        elementId: button.elementId,
      }), context);
      await waitForEvent(context.emit, 'computer.action.started', 5_000);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const stopped = await module.executeCapability(request('computer.control.stop', {}), context);
      const result = await action;

      expect(stopped).toMatchObject({ ok: true, output: { stopped: true, control: { enabled: false } } });
      expect(result).toMatchObject({
        ok: false,
        error: 'computer-action-state-uncertain',
        output: { performed: 'unknown', verified: false },
      });
      await expectComputerUseEnabled(module, context);
      const reconciled = await module.executeCapability(request('computer.window.observe', {
        windowRef: window.windowRef,
      }), context);
      expect((reconciled.output as any).elements.some((element: any) => element.name === 'clicked')).toBe(false);
    } finally {
      await module.deactivate();
      await terminateExactChild(target);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it('honors the native user-takeover signal and stops before completing long typing', async () => {
    const nonce = `takeover-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const title = `Monarch Computer Use Takeover QA ${nonce}`;
    const root = path.join(LIVE_QA_ROOT, nonce);
    const target = await launchQaWindow(title, root);
    const context = {
      emit: vi.fn(async () => undefined),
      audit: vi.fn(async () => undefined),
    } as any;
    const module = createLiveModule(root);

    try {
      await module.activate(context);
      await expectComputerUseEnabled(module, context);
      const window = await waitForWindow(module, context, title, target);
      const observed = await module.executeCapability(request('computer.window.observe', {
        windowRef: window.windowRef,
      }), context);
      const before = observed.output as any;
      const editor = before.elements.find((element: any) => element.automationId === 'qaInput');
      expect(editor).toBeTruthy();
      const text = 'Oscar takeover QA '.repeat(220).slice(0, 3_800);
      const action = module.executeCapability(request('computer.window.type', {
        windowRef: window.windowRef,
        observationId: before.observationId,
        elementId: editor.elementId,
        text,
      }), context);
      await waitForEvent(context.emit, 'computer.action.started', 5_000);
      const cursorSessionRoot = path.join(root, 'runtime', 'native', 'cursor-session');
      await waitForPath(path.join(cursorSessionRoot, 'active-visual-lease.json'), 10_000);
      await writeFile(
        path.join(cursorSessionRoot, 'user-takeover.requested'),
        `${new Date().toISOString()}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      const typed = await action;

      expect(typed).toMatchObject({
        ok: false,
        error: 'computer-action-state-uncertain',
        output: { performed: 'unknown', verified: false },
      });
      expect(module.control.snapshot()).toMatchObject({ enabled: false, activeLease: null });
      await expectComputerUseEnabled(module, context);
      const reconciled = await module.executeCapability(request('computer.window.observe', {
        windowRef: window.windowRef,
      }), context);
      expect((reconciled.output as any).elements.some((element: any) => element.name === `typed:${text}`)).toBe(false);
    } finally {
      await module.deactivate();
      await terminateExactChild(target);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it('terminates the persistent Oscar cursor when its owning runtime crashes', async () => {
    const root = path.join(
      LIVE_QA_ROOT,
      `owner-crash-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      const receipt = await runCursorOwnerCrashFixture(root);
      const cursorPid = Number(receipt.pid);
      expect(receipt).toMatchObject({ started: true, persistent: true });
      expect(Number.isSafeInteger(cursorPid) && cursorPid > 0).toBe(true);
      await waitForProcessExit(cursorPid, 8_000);
      expect(processExists(cursorPid)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);
});

function createLiveModule(root: string): ComputerModule {
  return new ComputerModule({
    monarchRoot: 'E:\\Monarch',
    runtimeRoot: path.join(root, 'runtime'),
    observationRoot: path.join(root, 'observations'),
    controlStatePath: path.join(root, 'runtime', 'control.json'),
  });
}

async function expectComputerUseEnabled(module: ComputerModule, context: any): Promise<void> {
  const enabled = await module.executeCapability(request('computer.control.start', {}), context);
  expect(enabled).toMatchObject({ ok: true, output: { control: { enabled: true } } });
}

async function waitForEvent(
  emit: ReturnType<typeof vi.fn>,
  eventName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (emit.mock.calls.some((call) => call[0] === eventName)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${eventName}.`);
}

async function runCursorOwnerCrashFixture(root: string): Promise<Record<string, unknown>> {
  await mkdir(root, { recursive: true });
  const child = spawn(process.execPath, [
    path.resolve('node_modules/tsx/dist/cli.mjs'),
    path.resolve('tests/fixtures/computer-use-cursor-owner-crash.ts'),
    root,
  ], {
    cwd: path.resolve('.'),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-16_000); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (exitCode !== 0) throw new Error(`Cursor owner crash fixture failed (${exitCode}): ${stderr || stdout}`);
  const line = stdout.trim().split(/\r?\n/u).at(-1) || '';
  return JSON.parse(line) as Record<string, unknown>;
}

async function waitForProcessExit(processId: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processExists(processId)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForPath(targetPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const metadata = await stat(targetPath).catch(() => null);
    if (metadata?.isFile()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`QA path did not appear in time: ${targetPath}`);
}

function processExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForWindow(
  module: ComputerModule,
  context: any,
  title: string,
  target: ChildProcess & { qaStderr?: string },
): Promise<any> {
  const deadline = Date.now() + 15_000;
  let lastTitles: string[] = [];
  while (Date.now() < deadline) {
    if (target.exitCode !== null) {
      throw new Error(`Synthetic QA host exited ${target.exitCode}: ${target.qaStderr || 'no stderr'}`);
    }
    const listed = await module.executeCapability(request('computer.windows.list', { limit: 100 }), context);
    if (!listed.ok) {
      throw new Error(`Native window enumeration failed: ${listed.error || 'unknown'} ${listed.summary}`);
    }
    lastTitles = ((listed.output as any)?.windows || []).map((entry: any) => String(entry.title));
    const window = (listed.output as any)?.windows?.find((entry: any) => entry.title === title);
    if (window) return window;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Synthetic Computer Use QA window did not appear: ${title}; stderr=${target.qaStderr || 'none'}; windows=${lastTitles.join(' | ')}`);
}

async function launchQaWindow(title: string, root: string): Promise<ChildProcess & { qaStderr?: string }> {
  await mkdir(root, { recursive: true });
  const compiler = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  const executable = path.join(root, 'monarch-computer-use-qa.exe');
  await runCompiler(compiler, [
    '/nologo',
    '/target:winexe',
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    `/out:${executable}`,
    path.resolve('scripts/fixtures/MonarchComputerUseQaTarget.cs'),
  ]);
  const child = spawn(executable, [title], {
    windowsHide: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  }) as ChildProcess & { qaStderr?: string };
  child.qaStderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    child.qaStderr = `${child.qaStderr || ''}${chunk.toString('utf8')}`.slice(-4_000);
  });
  return child;
}

async function launchCursorMover(root: string, delayMs: number, durationMs: number): Promise<ChildProcess> {
  const compiler = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  const executable = path.join(root, 'monarch-computer-use-cursor-mover.exe');
  const existing = await stat(executable).catch(() => null);
  if (!existing?.isFile()) {
    await runCompiler(compiler, [
      '/nologo',
      '/target:exe',
      '/reference:System.dll',
      `/out:${executable}`,
      path.resolve('tests/fixtures/MonarchComputerUseCursorMover.cs'),
    ]);
  }
  return spawn(executable, [String(delayMs), String(durationMs)], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function runCompiler(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Synthetic QA compilation failed (${code}): ${output.slice(-4_000)}`));
    });
  });
}

async function terminateExactChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  if (!child.killed) child.kill();
  await Promise.race([
    closed,
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function waitForExactChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await Promise.race([
    closed,
    new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('QA child did not exit in time.')), timeoutMs)),
  ]);
}

function request(capabilityId: string, input: Record<string, unknown>): any {
  return {
    id: `exec_live_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    intentId: 'intent_computer_live_qa',
    moduleId: 'computer',
    capabilityId,
    input,
    createdAt: new Date().toISOString(),
    requestedBy: 'computer-use-live-qa',
    source: 'smoke',
    confirmed: false,
  };
}

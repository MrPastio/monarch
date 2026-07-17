import { describe, expect, it } from 'vitest';
import { createOrganicVoiceOrbRenderer } from '../../src/ui/public/modules/oscar-voice-mode.js';

function createRendererHarness() {
  let clock = 0;
  let nextFrameId = 0;
  const frames = new Map<number, (timestamp: number) => void>();
  const documentListeners = new Map<string, Set<() => void>>();
  const gradient = { addColorStop() {} };
  const context = new Proxy({
    createRadialGradient: () => gradient,
  } as Record<string, unknown>, {
    get(target, property) {
      if (property in target) return target[property as string];
      return () => {};
    },
    set(target, property, value) {
      target[property as string] = value;
      return true;
    },
  });
  const canvas = {
    width: 520,
    height: 297,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 520, height: 297 }),
  };
  const orb = {
    clientWidth: 520,
    clientHeight: 297,
    classList: { add() {}, remove() {} },
  };
  const documentObject = {
    hidden: false,
    addEventListener(type: string, listener: () => void) {
      const listeners = documentListeners.get(type) || new Set<() => void>();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: () => void) {
      documentListeners.get(type)?.delete(listener);
    },
  };
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  const windowObject = {
    performance: { now: () => clock },
    devicePixelRatio: 1,
    document: documentObject,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame(callback: (timestamp: number) => void) {
      nextFrameId += 1;
      frames.set(nextFrameId, callback);
      return nextFrameId;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const reducedMotion = {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };
  const renderer = createOrganicVoiceOrbRenderer({
    canvas,
    orb,
    reducedMotion,
    windowObject,
  })!;

  return {
    renderer,
    pendingFrames: () => frames.size,
    step(deltaMs: number) {
      clock += deltaMs;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(clock));
    },
    setHidden(value: boolean) {
      documentObject.hidden = value;
      documentListeners.get('visibilitychange')?.forEach((listener) => listener());
    },
  };
}

function readColorChannels(value: string) {
  return (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
}

describe('voice orb renderer lifecycle', () => {
  it('owns exactly one RAF, smooths telemetry, and bounds resume deltas', () => {
    const harness = createRendererHarness();
    const { renderer } = harness;
    renderer.setVisualState('idle');
    renderer.start();
    renderer.start();
    for (let index = 0; index < 20; index += 1) {
      renderer.setLevels({ level: 1, inputLevel: 1, balance: 1 });
    }
    expect(harness.pendingFrames()).toBe(1);

    harness.step(16);
    expect(harness.pendingFrames()).toBe(1);
    expect(renderer.snapshot().signal.level).toBeGreaterThan(0);
    expect(renderer.snapshot().signal.level).toBeLessThan(0.2);

    const phaseBeforeStall = renderer.snapshot().motionPhase;
    harness.step(5_000);
    const phaseAfterStall = renderer.snapshot().motionPhase;
    expect(phaseAfterStall - phaseBeforeStall).toBeLessThan(0.02);
    expect(harness.pendingFrames()).toBe(1);

    renderer.setVisualState('thinking');
    harness.step(16);
    expect(renderer.snapshot().transitionProgress).toBeGreaterThan(0);
    expect(renderer.snapshot().transitionProgress).toBeLessThan(0.1);
    expect(harness.pendingFrames()).toBe(1);

    harness.setHidden(true);
    expect(harness.pendingFrames()).toBe(0);
    const phaseBeforeResume = renderer.snapshot().motionPhase;
    harness.step(5_000);
    harness.setHidden(false);
    expect(harness.pendingFrames()).toBe(1);
    harness.step(16);
    expect(renderer.snapshot().motionPhase - phaseBeforeResume).toBeLessThan(0.02);

    renderer.stop();
    expect(harness.pendingFrames()).toBe(0);
    renderer.destroy();
    expect(renderer.snapshot()).toMatchObject({ active: false, destroyed: true, frameScheduled: false });
  });

  it('chains rapid state changes from the currently rendered blend without a visual jump', () => {
    const harness = createRendererHarness();
    const { renderer } = harness;
    renderer.start();
    renderer.setVisualState('idle');
    for (let index = 0; index < 12; index += 1) harness.step(15);

    const before = renderer.snapshot().renderedFrame!;
    expect(renderer.snapshot().transitionProgress).toBeGreaterThan(0.2);
    expect(renderer.snapshot().transitionProgress).toBeLessThan(0.3);

    renderer.setVisualState('listening');
    harness.step(16);
    const after = renderer.snapshot().renderedFrame!;

    expect(Math.abs(after.radius - before.radius)).toBeLessThan(0.002);
    expect(Math.abs(after.luminance - before.luminance)).toBeLessThan(0.03);
    expect(Math.abs(after.point0.x - before.point0.x)).toBeLessThan(0.002);
    const beforeHighlight = readColorChannels(before.palette.highlight);
    const afterHighlight = readColorChannels(after.palette.highlight);
    expect(afterHighlight).toHaveLength(3);
    expect(Math.max(...afterHighlight.map((channel, index) => Math.abs(channel - beforeHighlight[index]))))
      .toBeLessThan(4);
    renderer.destroy();
  });
});

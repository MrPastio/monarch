import { describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core';
import {
  createDevicePowerShellEnvironment,
  DeviceModule,
  normalizeApplicationRequest,
  normalizeBrightnessRequest,
  normalizeBrowserRequest,
  normalizeVolumeRequest,
} from '../../src/modules/device';

describe('Device Module', () => {
  it('launches Device PowerShell with an OS-only environment and the bounded request payload', () => {
    const environment = createDevicePowerShellEnvironment(
      { MONARCH_DEVICE_REQUEST_B64: 'bounded-payload' },
      {
        SystemRoot: 'C:\\Windows',
        Path: 'C:\\Windows\\System32',
        USERPROFILE: 'C:\\Users\\test',
        MONARCH_DESKTOP_ATTESTATION_TOKEN: 'must-not-leave-runtime',
        OSCAR_API_TOKEN: 'must-not-leave-runtime',
      },
    );

    expect(environment).toEqual({
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\test',
      MONARCH_DEVICE_REQUEST_B64: 'bounded-payload',
    });
    expect(() => createDevicePowerShellEnvironment({ MONARCH_OTHER: 'no' }, {})).toThrow(
      'Unsupported Device PowerShell environment field',
    );
  });

  it('does not expose the legacy composite desktop capability', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule());
    await kernel.start();

    try {
      const result = await kernel.submitIntent('очисти корзину на компе и закрой активный браузер', 'telegram');
      expect(result.route?.capabilityId).not.toBe('device.desktop.actions');
      expect(kernel.listCapabilities().some((capability) => capability.id === 'device.desktop.actions')).toBe(false);
    } finally {
      await kernel.stop();
    }
  });

  it('routes individual actions without executing them before confirmation', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule());
    await kernel.start();

    try {
      const recycle = await kernel.submitIntent('очисти корзину', 'desktop');
      const browser = await kernel.submitIntent('закрой активный браузер', 'desktop');
      expect(recycle.route?.capabilityId).toBe('device.recycle-bin.empty');
      expect(browser.route?.capabilityId).toBe('device.browser.close-active');
      expect(recycle.execution?.error).toBe('confirmation-required');
      expect(browser.execution?.error).toBe('confirmation-required');
    } finally {
      await kernel.stop();
    }
  });

  it('routes app and browser opening behind device-control confirmation', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule());
    await kernel.start();

    try {
      const app = await kernel.submitIntent('открой калькулятор', 'voice');
      const browser = await kernel.submitIntent('открой сайт example.com', 'voice');
      expect(app.route).toMatchObject({ capabilityId: 'device.app.open', input: { app: 'calculator' } });
      expect(browser.route).toMatchObject({ capabilityId: 'device.browser.open' });
      expect(app.execution?.error).toBe('confirmation-required');
      expect(browser.execution?.error).toBe('confirmation-required');
    } finally {
      await kernel.stop();
    }
  });

  it('routes Telegram, YouTube, volume, brightness, and the real clock through Device', async () => {
    const now = new Date('2026-07-21T20:34:00.000Z');
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule(undefined, () => now));
    await kernel.start();

    try {
      const telegram = await kernel.submitIntent('Оскар, открой Телеграм', 'desktop');
      const youtube = await kernel.submitIntent('Оскар, открой YouTube', 'desktop');
      const volume = await kernel.submitIntent('поставь громкость на 45 процентов', 'desktop');
      const brightness = await kernel.submitIntent('поставь яркость на 55 процентов', 'desktop');
      const clock = await kernel.submitIntent('Оскар, скажи, сколько сейчас времени', 'desktop');

      expect(telegram.route).toMatchObject({ capabilityId: 'device.app.open', input: { app: 'telegram' } });
      expect(youtube.route).toMatchObject({
        capabilityId: 'device.browser.open',
        input: { provider: 'youtube', browser: 'default' },
      });
      expect(volume.route).toMatchObject({ capabilityId: 'device.volume.set', input: { action: 'set', value: 45 } });
      expect(brightness.route).toMatchObject({ capabilityId: 'device.brightness.set', input: { operation: 'set', value: 55 } });
      expect(clock.execution).toMatchObject({
        ok: true,
        output: { observedAt: now.toISOString(), verified: true, authoritative: true, source: 'system-clock' },
      });
      expect(telegram.execution?.error).toBe('confirmation-required');
      expect(youtube.execution?.error).toBe('confirmation-required');
      expect(volume.execution?.error).toBe('confirmation-required');
      expect(brightness.execution?.error).toBe('confirmation-required');
    } finally {
      await kernel.stop();
    }
  });

  it('executes app/browser launch contracts through an injected runner without opening windows', async () => {
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('Get-StartApps')
        ? { opened: true, verified: true, app: 'calculator', displayName: 'Калькулятор', processId: 42 }
        : { opened: true, verified: true, browser: 'default', processId: 43, targetOrigin: 'https://example.com' },
    ));
    const module = new DeviceModule(runner);
    const context = { emit: vi.fn(async () => undefined) } as any;
    const base = {
      id: 'exec_device',
      intentId: 'intent_device',
      moduleId: 'device',
      createdAt: new Date(0).toISOString(),
      requestedBy: 'test',
      confirmed: true,
    };

    const app = await module.executeCapability({
      ...base,
      capabilityId: 'device.app.open',
      input: { app: 'calculator' },
    }, context);
    const browser = await module.executeCapability({
      ...base,
      id: 'exec_browser',
      capabilityId: 'device.browser.open',
      input: { url: 'example.com', browser: 'default' },
    }, context);

    expect(app).toMatchObject({ ok: true, output: { opened: true, text: 'Открыл Калькулятор.' } });
    expect(browser).toMatchObject({ ok: true, output: { opened: true, text: 'Открыл страницу в браузере.' } });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('never reports app success from exit code 0 without a verified window', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      opened: false,
      verified: false,
      app: 'steam',
      displayName: 'Steam',
      processId: 42,
      exitCode: 0,
    }));
    const module = new DeviceModule(runner);
    const result = await module.executeCapability({
      id: 'exec_unverified_app',
      intentId: 'intent_unverified_app',
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'steam' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);

    expect(result).toMatchObject({
      ok: false,
      error: 'app-open-unverified',
      output: { opened: false, verified: false, exitCode: 0 },
    });
  });

  it.each([
    ['app-not-found', 0],
    ['app-ambiguous', 3],
  ])('returns stable app resolution failure %s', async (error, matchCount) => {
    const runner = vi.fn(async () => JSON.stringify({
      opened: false,
      verified: false,
      app: 'fixture',
      error,
      matchCount,
      candidates: matchCount ? ['Fixture A', 'Fixture B', 'Fixture C'] : [],
    }));
    const module = new DeviceModule(runner);
    const result = await module.executeCapability({
      id: `exec_${error}`,
      intentId: `intent_${error}`,
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'fixture' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);

    expect(result).toMatchObject({ ok: false, error, output: { matchCount } });
  });

  it('accepts an already-running/UWP launch only with the same verified receipt contract', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      opened: true,
      verified: true,
      alreadyRunning: true,
      app: 'discord',
      displayName: 'Discord',
      launcher: 'start-apps',
      processId: 501,
    }));
    const module = new DeviceModule(runner);
    const result = await module.executeCapability({
      id: 'exec_running_uwp',
      intentId: 'intent_running_uwp',
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'Discord' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);

    expect(result).toMatchObject({
      ok: true,
      output: {
        opened: true,
        verified: true,
        alreadyRunning: true,
        launcher: 'start-apps',
      },
    });
  });

  it('cancels app launch before dispatch and reconciles cancellation after dispatch', async () => {
    const before = new AbortController();
    before.abort();
    const runner = vi.fn(async () => JSON.stringify({
      opened: true, verified: true, app: 'steam', displayName: 'Steam', processId: 42,
    }));
    const module = new DeviceModule(runner);
    const request = {
      id: 'exec_cancel_app',
      intentId: 'intent_cancel_app',
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'steam' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    };
    await expect(module.executeCapability(
      request,
      { emit: vi.fn(async () => undefined) } as any,
      { signal: before.signal },
    )).resolves.toMatchObject({
      ok: false,
      error: 'device-action-cancelled',
      output: { verified: false, reconciliation: 'not-dispatched', cancellationObservedAfterDispatch: false },
    });
    expect(runner).not.toHaveBeenCalled();

    const after = new AbortController();
    const postDispatchRunner = vi.fn(async () => {
      after.abort();
      return JSON.stringify({
        opened: true, verified: true, app: 'steam', displayName: 'Steam', processId: 43,
      });
    });
    const reconciled = await new DeviceModule(postDispatchRunner).executeCapability(
      { ...request, id: 'exec_cancel_app_after' },
      { emit: vi.fn(async () => undefined) } as any,
      { signal: after.signal },
    );
    expect(reconciled).toMatchObject({
      ok: true,
      output: { opened: true, verified: true, cancellationObservedAfterDispatch: true },
    });

    const uncertainController = new AbortController();
    const uncertain = await new DeviceModule(vi.fn(async () => {
      uncertainController.abort();
      throw new DOMException('Aborted after dispatch', 'AbortError');
    })).executeCapability(
      { ...request, id: 'exec_cancel_app_uncertain' },
      { emit: vi.fn(async () => undefined) } as any,
      { signal: uncertainController.signal },
    );
    expect(uncertain).toMatchObject({
      ok: false,
      error: 'device-action-state-uncertain',
      output: {
        verified: false,
        authoritative: true,
        reconciliation: 'uncertain',
        cancellationObservedAfterDispatch: true,
      },
    });
  });

  it('requires a verified closed window receipt for active browser close', async () => {
    const module = new DeviceModule(vi.fn(async () => JSON.stringify({
      closed: false,
      closeRequested: true,
      verified: false,
      process: 'chrome',
      processId: 71,
      windowHandle: 101,
    })));
    const result = await module.executeCapability({
      id: 'exec_close_browser_unverified',
      intentId: 'intent_close_browser_unverified',
      moduleId: 'device',
      capabilityId: 'device.browser.close-active',
      input: {},
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);
    expect(result).toMatchObject({ ok: false, error: 'browser-close-rejected' });
  });

  it('searches the real Start application registry through a bounded read capability', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      query: 'Photoshop',
      matches: [{ name: 'Adobe Photoshop 2026', appId: 'Adobe.Photoshop' }],
      count: 1,
    }));
    const module = new DeviceModule(runner);
    const context = { emit: vi.fn(async () => undefined) } as any;
    const result = await module.executeCapability({
      id: 'exec_app_search',
      intentId: 'intent_app_search',
      moduleId: 'device',
      capabilityId: 'device.apps.search',
      input: { query: 'Photoshop', limit: 8 },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
    }, context);

    expect(result).toMatchObject({
      ok: true,
      output: {
        query: 'Photoshop',
        count: 1,
        matches: [{ name: 'Adobe Photoshop 2026' }],
      },
    });
    expect(context.emit).toHaveBeenCalledWith('device.apps.searched', 'device', {
      query: 'Photoshop',
      count: 1,
    });
  });

  it('lets a trusted Agent Task launch one resolved app without phrase-level authorization', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      opened: true,
      verified: true,
      app: 'calculator',
      displayName: 'Калькулятор',
      processId: 42,
      launcher: 'direct',
    }));
    const kernel = new MonarchKernel({
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
    });
    kernel.registerModule(new DeviceModule(runner));
    await kernel.start();
    try {
      const executed = await kernel.executeActionProposal({
        capabilityId: 'device.app.open',
        args: { app: 'calculator' },
        expectedEffect: 'Launch the resolved application.',
        verification: [{ kind: 'status', target: 'result.output.opened', value: true }],
        provenance: { source: 'model-tool-call', model: 'fixture', skillIds: [] },
      }, {
        originatingUserText: 'Открой калькулятор.',
        requestedBy: 'agent:agent_task_fixture',
        executionMode: 'agent-runtime',
      });

      expect(executed.result, JSON.stringify(executed.result)).toMatchObject({
        ok: true,
        output: { opened: true, verified: true, performed: true },
      });
    } finally {
      await kernel.stop();
    }
  });

  it('reads and changes built-in display brightness only from verified Windows rereads', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        operation: 'get', before: 72, level: 72, requested: 72, verified: true, performed: false, monitorCount: 1,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        operation: 'set', before: 72, level: 55, requested: 55, verified: true, performed: true, monitorCount: 1,
      }));
    const module = new DeviceModule(runner);
    const context = { emit: vi.fn(async () => undefined) } as any;
    const base = {
      id: 'exec_brightness',
      intentId: 'intent_brightness',
      moduleId: 'device',
      createdAt: new Date(0).toISOString(),
      requestedBy: 'ui:voice-mode',
      confirmed: true,
    };

    const status = await module.executeCapability({
      ...base,
      capabilityId: 'device.brightness.get',
      input: {},
    }, context);
    const changed = await module.executeCapability({
      ...base,
      id: 'exec_brightness_set',
      capabilityId: 'device.brightness.set',
      input: { operation: 'set', value: 55 },
    }, context);

    expect(status).toMatchObject({
      ok: true,
      output: { level: 72, verified: true, text: 'Сейчас яркость экрана 72%.' },
    });
    expect(changed).toMatchObject({
      ok: true,
      output: { before: 72, level: 55, requested: 55, verified: true, text: 'Яркость установлена на 55%.' },
    });
    expect(context.emit).toHaveBeenCalledWith('device.brightness.read', 'device', expect.any(Object));
    expect(context.emit).toHaveBeenCalledWith('device.brightness.changed', 'device', expect.any(Object));
  });

  it('fails closed when Windows does not confirm the requested brightness', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      operation: 'set', before: 72, level: 72, requested: 55, verified: false, performed: true, monitorCount: 1,
    }));
    const module = new DeviceModule(runner);
    const result = await module.executeCapability({
      id: 'exec_brightness_unverified',
      intentId: 'intent_brightness_unverified',
      moduleId: 'device',
      capabilityId: 'device.brightness.set',
      input: { operation: 'set', value: 55 },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'ui:voice-mode',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);

    expect(result).toMatchObject({ ok: false, error: 'brightness-unverified' });
  });

  it('normalizes only safe app names and HTTP browser targets', () => {
    expect(normalizeApplicationRequest('  Visual Studio Code  ')).toBe('vscode');
    expect(normalizeApplicationRequest('Телеграм')).toBe('telegram');
    expect(() => normalizeApplicationRequest('cmd.exe /c calc')).toThrow();
    expect(normalizeBrowserRequest({ query: 'Monarch voice', provider: 'google' })).toMatchObject({
      target: 'https://www.google.com/search?q=Monarch%20voice',
      browser: 'default',
    });
    expect(normalizeBrowserRequest({ provider: 'youtube' })).toMatchObject({
      target: 'https://www.youtube.com/',
      browser: 'default',
      provider: 'youtube',
    });
    expect(() => normalizeBrowserRequest({ url: 'file:///C:/Windows/System32/calc.exe' })).toThrow();
    expect(normalizeBrightnessRequest({ operation: 'set', value: 55 }, true)).toEqual({ operation: 'set', value: 55 });
    expect(normalizeBrightnessRequest({ operation: 'change', delta: -10 }, true)).toEqual({ operation: 'change', delta: -10 });
    expect(normalizeBrightnessRequest({}, false)).toEqual({ operation: 'get' });
    expect(() => normalizeBrightnessRequest({ operation: 'set', value: 101 }, true)).toThrow();
    expect(normalizeVolumeRequest({ action: 'set', value: 45 })).toEqual({ action: 'set', value: 45 });
    expect(normalizeVolumeRequest({ action: 'mute' })).toEqual({ action: 'mute' });
    expect(() => normalizeVolumeRequest({ action: 'set', value: 101 })).toThrow();
  });
});

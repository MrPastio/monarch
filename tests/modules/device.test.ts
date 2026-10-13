import { describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core';
import {
  createDevicePowerShellEnvironment,
  DeviceModule,
  createDeviceModule,
  normalizeApplicationRequest,
  normalizeBrightnessRequest,
  normalizeBrowserRequest,
  normalizeVolumeRequest,
  prepareDevicePowerShellScript,
} from '../../src/modules/device';
import { createDeterministicSecurityModule } from '../fixtures/agent/deterministic-security-module';
import { executeTypedCapability } from '../helpers/typed-capability';

describe('Device Module', () => {
  it('does not warm the application catalog in the default product factory', async () => {
    const module = createDeviceModule();
    const load = vi.spyOn(module as any, 'readInstalledApplicationCatalog');
    await module.activate({ emit: vi.fn(async () => undefined) } as any);
    expect(load).not.toHaveBeenCalled();
  });
  it('forces Windows PowerShell stdin and stdout to UTF-8 before device scripts run', () => {
    const prepared = prepareDevicePowerShellScript("'Калькулятор' | Write-Output");

    expect(prepared).toContain('[Console]::InputEncoding = $utf8');
    expect(prepared).toContain('[Console]::OutputEncoding = $utf8');
    expect(prepared).toContain('$OutputEncoding = $utf8');
    expect(prepared).toContain("'Калькулятор' | Write-Output");
  });

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
      expect(kernel.listCapabilities().some((capability) => capability.id === 'device.desktop.actions')).toBe(false);
    } finally {
      await kernel.stop();
    }
  });

  it('guards exact individual actions without executing them before confirmation', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule());
    await kernel.start();

    try {
      const recycle = await executeTypedCapability(kernel, 'device.recycle-bin.empty', {}, { source: 'desktop' });
      const browser = await executeTypedCapability(kernel, 'device.browser.close-active', {}, { source: 'desktop' });
      expect(recycle.error).toBe('confirmation-required');
      expect(browser.error).toBe('confirmation-required');
    } finally {
      await kernel.stop();
    }
  });

  it('keeps exact app and browser opening behind device-control confirmation', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule());
    await kernel.start();

    try {
      const app = await executeTypedCapability(kernel, 'device.app.open', { app: 'calculator' }, { source: 'voice' });
      const browser = await executeTypedCapability(kernel, 'device.browser.open', {
        url: 'https://example.com', browser: 'default',
      }, { source: 'voice' });
      expect(app.error).toBe('confirmation-required');
      expect(browser.error).toBe('confirmation-required');
    } finally {
      await kernel.stop();
    }
  });

  it('executes or guards exact Telegram, YouTube, volume, brightness, and clock capabilities', async () => {
    const now = new Date('2026-07-21T20:34:00.000Z');
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule(undefined, () => now));
    await kernel.start();

    try {
      const telegram = await executeTypedCapability(kernel, 'device.app.open', { app: 'telegram' }, { source: 'desktop' });
      const youtube = await executeTypedCapability(kernel, 'device.browser.open', {
        provider: 'youtube', browser: 'default',
      }, { source: 'desktop' });
      const volume = await executeTypedCapability(kernel, 'device.volume.set', {
        action: 'set', value: 45,
      }, { source: 'desktop' });
      const brightness = await executeTypedCapability(kernel, 'device.brightness.set', {
        operation: 'set', value: 55,
      }, { source: 'desktop' });
      const clock = await executeTypedCapability(kernel, 'device.system.time.get', { kind: 'time' }, { source: 'desktop' });

      expect(clock).toMatchObject({
        ok: true,
        output: { observedAt: now.toISOString(), verified: true, authoritative: true, source: 'system-clock' },
      });
      expect(telegram.error).toBe('confirmation-required');
      expect(youtube.error).toBe('confirmation-required');
      expect(volume.error).toBe('confirmation-required');
      expect(brightness.error).toBe('confirmation-required');
    } finally {
      await kernel.stop();
    }
  });

  it('executes app/browser launch contracts through an injected runner without opening windows', async () => {
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('$entries = New-Object')
        ? { entries: [{ name: 'Калькулятор', launchId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', source: 'start-apps' }] }
        : script.includes('$candidate = $request.candidate')
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
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('warms one shared application catalog before the first simplified command', async () => {
    let resolveCatalog!: (value: string) => void;
    const catalog = new Promise<string>((resolve) => { resolveCatalog = resolve; });
    const runner = vi.fn(async (script: string) => {
      if (script.includes('$entries = New-Object')) return catalog;
      return JSON.stringify({ opened: true, verified: true, processId: 42 });
    });
    const module = new DeviceModule(
      runner,
      undefined,
      undefined,
      { warmApplicationCatalog: true },
    );
    const context = { emit: vi.fn(async () => undefined) } as any;

    await module.activate(context);
    const opening = module.executeCapability({
      id: 'exec_warm_telegram',
      intentId: 'intent_warm_telegram',
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'телеграм' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'ui:voice-simplified',
      source: 'voice',
      confirmed: false,
    }, context);

    expect(runner).toHaveBeenCalledTimes(1);
    resolveCatalog(JSON.stringify({
      entries: [{
        name: 'Telegram Desktop',
        launchId: 'TelegramMessenger.TelegramDesktop!App',
        source: 'start-apps',
      }],
    }));
    await expect(opening).resolves.toMatchObject({ ok: true, output: { resolvedName: 'Telegram Desktop' } });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('resolves a misspelled application once inside Device and launches only the exact catalog target', async () => {
    const launchRequests: Array<Record<string, unknown>> = [];
    const runner = vi.fn(async (script: string, environment?: NodeJS.ProcessEnv) => {
      if (script.includes('$entries = New-Object')) {
        return JSON.stringify({
          entries: [{ name: 'Paint', launchId: 'Microsoft.Paint_8wekyb3d8bbwe!App', source: 'start-apps' }],
        });
      }
      const encoded = String(environment?.MONARCH_DEVICE_REQUEST_B64 || '');
      launchRequests.push(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
      return JSON.stringify({
        opened: true,
        verified: true,
        displayName: 'Paint',
        processId: 512,
        windowTitle: 'Untitled - Paint',
        launcher: 'start-apps',
      });
    });
    const module = new DeviceModule(runner);
    const context = { emit: vi.fn(async () => undefined) } as any;
    const base = {
      intentId: 'intent_generic_app_resolution',
      moduleId: 'device',
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    };

    const search = await module.executeCapability({
      ...base,
      id: 'exec_generic_app_search',
      capabilityId: 'device.apps.search',
      input: { query: 'пеинт' },
    }, context);
    const opened = await module.executeCapability({
      ...base,
      id: 'exec_generic_app_open',
      capabilityId: 'device.app.open',
      input: { app: 'пеинт' },
    }, context);

    expect(search).toMatchObject({
      ok: true,
      output: { resolution: 'unique', matches: [{ name: 'Paint', matchKind: 'phonetic' }] },
    });
    expect(JSON.stringify(search)).not.toContain('Microsoft.Paint_8wekyb3d8bbwe!App');
    expect(opened).toMatchObject({
      ok: true,
      output: {
        app: 'пеинт',
        displayName: 'Paint',
        resolvedName: 'Paint',
        opened: true,
        verified: true,
      },
    });
    expect(launchRequests).toEqual([{
      app: 'пеинт',
      candidate: expect.objectContaining({
        name: 'Paint',
        launchId: 'Microsoft.Paint_8wekyb3d8bbwe!App',
        source: 'start-apps',
      }),
    }]);
    expect(runner.mock.calls[0]?.[0]).toContain('HKEY_CURRENT_USER\\Software');
    expect(runner.mock.calls[1]?.[0]).toContain("[^\\p{L}\\p{Nd}]");
    expect(runner.mock.calls[1]?.[0]).toContain('shell:AppsFolder\\$([string]$candidate.launchId)');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('fails closed before launch when the catalog has two equally plausible targets', async () => {
    const runner = vi.fn(async () => JSON.stringify({
      entries: [
        { name: 'Steam Video', launchId: 'fixture.steam.video', source: 'start-apps' },
        { name: 'Steam Voice', launchId: 'fixture.steam.voice', source: 'start-apps' },
      ],
    }));
    const result = await new DeviceModule(runner).executeCapability({
      id: 'exec_ambiguous_generic_app',
      intentId: 'intent_ambiguous_generic_app',
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'steam v' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);

    expect(result).toMatchObject({
      ok: false,
      error: 'app-ambiguous',
      output: {
        opened: false,
        verified: false,
        candidates: [{ name: 'Steam Video' }, { name: 'Steam Voice' }],
      },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('never reports app success from exit code 0 without a verified window', async () => {
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('$entries = New-Object')
        ? { entries: [{ name: 'Steam', launchId: 'fixture.steam', source: 'start-apps' }] }
        : {
          opened: false,
          verified: false,
          app: 'steam',
          displayName: 'Steam',
          processId: 42,
          exitCode: 0,
        },
    ));
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
    {
      error: 'app-not-found',
      query: 'fixture',
      entries: [{ name: 'Unrelated Utility', launchId: 'unrelated.utility', source: 'start-apps' }],
      matchCount: 0,
      runnerCalls: 1,
    },
    {
      error: 'app-ambiguous',
      query: 'steam v',
      entries: [
        { name: 'Steam Video', launchId: 'fixture.video', source: 'start-apps' },
        { name: 'Steam Voice', launchId: 'fixture.voice', source: 'start-apps' },
      ],
      matchCount: 2,
      runnerCalls: 1,
    },
  ])('returns stable app resolution failure $error', async ({ error, query, entries, matchCount, runnerCalls }) => {
    const runner = vi.fn(async () => JSON.stringify({ entries }));
    const module = new DeviceModule(runner);
    const result = await module.executeCapability({
      id: `exec_${error}`,
      intentId: `intent_${error}`,
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: query },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);

    expect(result).toMatchObject({ ok: false, error, output: { matchCount } });
    expect(runner).toHaveBeenCalledTimes(runnerCalls);
  });

  it('does not fall back to app-specific launch guesses when the trusted Windows catalog is unavailable', async () => {
    const runner = vi.fn(async () => JSON.stringify({ entries: [] }));
    const result = await new DeviceModule(runner).executeCapability({
      id: 'exec_catalog_unavailable',
      intentId: 'intent_catalog_unavailable',
      moduleId: 'device',
      capabilityId: 'device.app.open',
      input: { app: 'calculator' },
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    }, { emit: vi.fn(async () => undefined) } as any);

    expect(result).toMatchObject({
      ok: false,
      error: 'app-catalog-unavailable',
      output: { opened: false, verified: false, performed: false, catalogSize: 0 },
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('refreshes a reused catalog once when a newly installed application was previously missing', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        entries: [{ name: 'Unrelated Utility', launchId: 'unrelated.utility', source: 'start-apps' }],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        entries: [{ name: 'Paint', launchId: 'Microsoft.Paint!App', source: 'start-apps' }],
      }))
      .mockResolvedValueOnce(JSON.stringify({
        opened: true,
        verified: true,
        displayName: 'Paint',
        processId: 73,
        launcher: 'start-apps',
      }));
    const module = new DeviceModule(runner);
    const context = { emit: vi.fn(async () => undefined) } as any;
    const base = {
      intentId: 'intent_catalog_refresh',
      moduleId: 'device',
      createdAt: new Date(0).toISOString(),
      requestedBy: 'agent:test',
      confirmed: true,
    };
    const initial = await module.executeCapability({
      ...base,
      id: 'exec_catalog_refresh_search',
      capabilityId: 'device.apps.search',
      input: { query: 'пеинт' },
    }, context);
    const opened = await module.executeCapability({
      ...base,
      id: 'exec_catalog_refresh_open',
      capabilityId: 'device.app.open',
      input: { app: 'пеинт' },
    }, context);

    expect(initial).toMatchObject({ ok: true, output: { resolution: 'missing', matches: [] } });
    expect(opened).toMatchObject({ ok: true, output: { resolvedName: 'Paint', verified: true } });
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it('accepts an already-running/UWP launch only with the same verified receipt contract', async () => {
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('$entries = New-Object')
        ? { entries: [{ name: 'Discord', launchId: 'fixture.discord', source: 'start-apps' }] }
        : {
          opened: true,
          verified: true,
          alreadyRunning: true,
          app: 'discord',
          displayName: 'Discord',
          launcher: 'start-apps',
          processId: 501,
        },
    ));
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
    const postDispatchRunner = vi.fn(async (script: string) => {
      if (script.includes('$entries = New-Object')) {
        return JSON.stringify({ entries: [{ name: 'Steam', launchId: 'Steam/steam.exe', source: 'start-apps' }] });
      }
      after.abort();
      return JSON.stringify({ opened: true, verified: true, app: 'steam', displayName: 'Steam', processId: 43 });
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
    const uncertain = await new DeviceModule(vi.fn(async (script: string) => {
      if (script.includes('$entries = New-Object')) {
        return JSON.stringify({ entries: [{ name: 'Steam', launchId: 'Steam/steam.exe', source: 'start-apps' }] });
      }
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
      entries: [{ name: 'Adobe Photoshop 2026', launchId: 'Adobe.Photoshop', source: 'start-apps' }],
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
      resolution: 'unique',
    });
  });

  it('lets a trusted Agent Task launch one resolved app without phrase-level authorization', async () => {
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('$entries = New-Object')
        ? { entries: [{ name: 'Калькулятор', launchId: 'fixture.calculator', source: 'start-apps' }] }
        : {
          opened: true,
          verified: true,
          app: 'calculator',
          displayName: 'Калькулятор',
          processId: 42,
          launcher: 'start-apps',
        },
    ));
    const kernel = new MonarchKernel({
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        autonomyMode: 'workspace-autonomous',
      },
    });
    kernel.registerModule(new DeviceModule(runner));
    kernel.registerModule(createDeterministicSecurityModule());
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
    expect(normalizeApplicationRequest('Telegram.')).toBe('telegram');
    expect(normalizeApplicationRequest('Фигму')).toBe('Фигму');
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

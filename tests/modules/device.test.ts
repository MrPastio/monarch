import { describe, expect, it, vi } from 'vitest';
import { MonarchKernel } from '../../src/core';
import {
  DeviceModule,
  normalizeApplicationRequest,
  normalizeBrightnessRequest,
  normalizeBrowserRequest,
} from '../../src/modules/device';

describe('Device Module', () => {
  it('routes the combined Telegram desktop example behind one confirmation', async () => {
    const kernel = new MonarchKernel();
    kernel.registerModule(new DeviceModule());
    await kernel.start();

    try {
      const result = await kernel.submitIntent('очисти корзину на компе и закрой активный браузер', 'telegram');
      expect(result.route?.capabilityId).toBe('device.desktop.actions');
      expect(result.route?.input).toEqual({ emptyRecycleBin: true, closeActiveBrowser: true });
      expect(result.execution?.error).toBe('confirmation-required');
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
      expect(app.route).toMatchObject({ capabilityId: 'device.app.open', input: { app: 'калькулятор' } });
      expect(browser.route).toMatchObject({ capabilityId: 'device.browser.open' });
      expect(app.execution?.error).toBe('confirmation-required');
      expect(browser.execution?.error).toBe('confirmation-required');
    } finally {
      await kernel.stop();
    }
  });

  it('executes app/browser launch contracts through an injected runner without opening windows', async () => {
    const runner = vi.fn(async (script: string) => JSON.stringify(
      script.includes('Get-StartApps')
        ? { opened: true, app: 'calculator', displayName: 'Калькулятор', processId: 42 }
        : { opened: true, browser: 'default', processId: 43, targetOrigin: 'https://example.com' },
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
    expect(normalizeApplicationRequest('  Visual Studio Code  ')).toBe('Visual Studio Code');
    expect(() => normalizeApplicationRequest('cmd.exe /c calc')).toThrow();
    expect(normalizeBrowserRequest({ query: 'Monarch voice', provider: 'google' })).toMatchObject({
      target: 'https://www.google.com/search?q=Monarch%20voice',
      browser: 'default',
    });
    expect(() => normalizeBrowserRequest({ url: 'file:///C:/Windows/System32/calc.exe' })).toThrow();
    expect(normalizeBrightnessRequest({ operation: 'set', value: 55 }, true)).toEqual({ operation: 'set', value: 55 });
    expect(normalizeBrightnessRequest({ operation: 'change', delta: -10 }, true)).toEqual({ operation: 'change', delta: -10 });
    expect(normalizeBrightnessRequest({}, false)).toEqual({ operation: 'get' });
    expect(() => normalizeBrightnessRequest({ operation: 'set', value: 101 }, true)).toThrow();
  });
});

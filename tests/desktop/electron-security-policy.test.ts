import { describe, expect, it } from 'vitest';
import {
  isTrustedRuntimeUrl,
  readExternalHttpUrl,
  shouldAllowDesktopPermission,
} from '../../desktop/electron/security-policy.mjs';

describe('Electron security policy', () => {
  const runtimeUrl = 'http://127.0.0.1:4317';

  it('opens only ordinary HTTP links outside Electron child windows', () => {
    expect(readExternalHttpUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(readExternalHttpUrl('http://example.com/')).toBe('http://example.com/');
    expect(readExternalHttpUrl('file:///C:/Windows/System32/calc.exe')).toBeNull();
    expect(readExternalHttpUrl('javascript:alert(1)')).toBeNull();
    expect(readExternalHttpUrl('monarch://settings')).toBeNull();
  });

  it('keeps main-window navigation on the exact local runtime origin', () => {
    expect(isTrustedRuntimeUrl('http://127.0.0.1:4317/chat', runtimeUrl)).toBe(true);
    expect(isTrustedRuntimeUrl('http://127.0.0.1:4318/chat', runtimeUrl)).toBe(false);
    expect(isTrustedRuntimeUrl('https://example.com/', runtimeUrl)).toBe(false);
  });

  it('grants only audio media to the main local runtime contents', () => {
    const base = {
      permission: 'media',
      requestingUrl: `${runtimeUrl}/`,
      runtimeUrl,
      mediaTypes: ['audio'],
      isMainFrame: true,
      isMainWebContents: true,
    };
    expect(shouldAllowDesktopPermission(base)).toBe(true);
    expect(shouldAllowDesktopPermission({ ...base, mediaTypes: ['video'] })).toBe(false);
    expect(shouldAllowDesktopPermission({ ...base, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(shouldAllowDesktopPermission({ ...base, permission: 'geolocation' })).toBe(false);
    expect(shouldAllowDesktopPermission({ ...base, requestingUrl: 'https://example.com/' })).toBe(false);
    expect(shouldAllowDesktopPermission({ ...base, isMainFrame: false })).toBe(false);
    expect(shouldAllowDesktopPermission({ ...base, isMainWebContents: false })).toBe(false);
  });
});

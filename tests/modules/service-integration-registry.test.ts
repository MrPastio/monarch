import { describe, expect, it, vi } from 'vitest';
import { createServiceIntegrationRegistry, registerServiceIntegrationIpc } from '../../desktop/electron/service-integration-registry.mjs';

function entry(id: string) {
  const close = vi.fn(async () => undefined);
  const serverClose = vi.fn(async () => undefined);
  return { close, serverClose, value: {
    id,
    envPrefix: `MONARCH_${id.toUpperCase()}_HOST`,
    status: vi.fn(async () => ({ connected: false })),
    connect: vi.fn(async input => ({ connected: true, input })),
    disconnect: vi.fn(async () => ({ connected: false })),
    startServer: vi.fn(async () => ({ endpoint: `http://127.0.0.1:1234/${id}`,
      bearerToken: 'a'.repeat(64), close: serverClose })),
    close,
    messages: { status: `${id} status`, connect: `${id} connect`, disconnect: `${id} disconnect`,
      [`${id}:specific`]: `${id} exact` },
  } };
}

describe('Desktop service integration registry', () => {
  it('starts descriptors once and projects only ephemeral runtime bindings', async () => {
    const gmail = entry('gmail');
    const calendar = entry('calendar');
    const registry = createServiceIntegrationRegistry([gmail.value, calendar.value]);
    await registry.startAll();
    await registry.startAll();
    expect(gmail.value.startServer).toHaveBeenCalledOnce();
    expect(registry.runtimeEnvironment()).toEqual({
      MONARCH_GMAIL_HOST_ENDPOINT: 'http://127.0.0.1:1234/gmail',
      MONARCH_GMAIL_HOST_TOKEN: 'a'.repeat(64),
      MONARCH_CALENDAR_HOST_ENDPOINT: 'http://127.0.0.1:1234/calendar',
      MONARCH_CALENDAR_HOST_TOKEN: 'a'.repeat(64),
    });
    await registry.closeAll();
    expect(calendar.close).toHaveBeenCalledOnce();
    expect(calendar.serverClose).toHaveBeenCalledOnce();
    expect(registry.runtimeEnvironment().MONARCH_GMAIL_HOST_TOKEN).toBe('');
  });

  it('uses one exact trusted IPC surface for every registered service', async () => {
    const handlers = new Map<string, Function>();
    const ipcMain = { handle: vi.fn((name: string, handler: Function) => handlers.set(name, handler)) };
    const calendar = entry('calendar');
    const registry = createServiceIntegrationRegistry([calendar.value]);
    const assertTrustedRenderer = vi.fn();
    registerServiceIntegrationIpc({ ipcMain, registry, assertTrustedRenderer });
    await expect(handlers.get('monarch:integration-connect')?.({ sender: 1 }, {
      serviceId: 'calendar', input: { permissions: { read: true } },
    })).resolves.toMatchObject({ connected: true });
    expect(assertTrustedRenderer).toHaveBeenCalledOnce();
    expect(() => handlers.get('monarch:integration-disconnect')?.({}, {
      serviceId: 'calendar', confirmed: false,
    })).toThrow('не подтверждено');
  });

  it('sanitizes broker failures through descriptor-owned public messages', async () => {
    const calendar = entry('calendar');
    calendar.value.connect.mockRejectedValueOnce(Error('refresh_token=private'));
    calendar.value.connect.mockRejectedValueOnce(Error('calendar:specific'));
    const registry = createServiceIntegrationRegistry([calendar.value]);
    await expect(registry.invoke('calendar', 'connect', {})).rejects.toThrow('calendar connect');
    await expect(registry.invoke('calendar', 'connect', {})).rejects.toThrow('calendar exact');
  });
});

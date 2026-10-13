import { describe, expect, it, vi } from 'vitest';
import { CalendarModule } from '../../src/modules/calendar';
import { calendarManifest } from '../../src/modules/calendar/manifest';
import { MonarchKernel, resolveAgentCapabilityMetadata } from '../../src/core';

describe('Google Calendar service module', () => {
  it('exposes only typed capabilities without phrase activators or deletion', () => {
    expect(calendarManifest.capabilities.map(item => item.id)).toEqual([
      'calendar.connection.status', 'calendar.calendars.list', 'calendar.events.list',
      'calendar.event.create', 'calendar.event.update',
    ]);
    expect(calendarManifest.capabilities.every(item => item.routing === undefined)).toBe(true);
    expect(calendarManifest.capabilities.filter(item => item.agent?.effectProfile?.mutation === 'none')
      .every(item => item.agent?.idempotency === 'idempotent')).toBe(true);
    expect(calendarManifest.capabilities.some(item => /delete|acl/iu.test(item.id))).toBe(false);
    expect(() => calendarManifest.capabilities.forEach(resolveAgentCapabilityMetadata)).not.toThrow();
  });

  it('dispatches one typed broker operation and forwards cancellation', async () => {
    const request = vi.fn(async () => ({ events: [{ id: 'event_1' }] }));
    const module = new CalendarModule({ available: true, request } as never);
    const input = { calendarId: 'primary', timeMin: '2026-09-13T10:00:00Z', timeMax: '2026-09-14T10:00:00Z' };
    await expect(module.executeCapability({ capabilityId: 'calendar.events.list', input } as never))
      .resolves.toMatchObject({ ok: true, output: { events: [{ id: 'event_1' }] } });
    expect(request).toHaveBeenCalledWith('events.list', input, undefined);
  });

  it('does not add an artificial Kernel confirmation to Direct Access event creation', async () => {
    const request = vi.fn(async () => ({ id: 'event_1' }));
    const kernel = new MonarchKernel({ agencyStateDirectory: false,
      permissionProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'on-request', autonomyMode: 'full-local' } });
    kernel.registerModule(new CalendarModule({ available: true, request } as never));
    await kernel.start();
    try {
      const result = await kernel.execute({
        id: 'exec_calendar_create', intentId: 'intent_calendar_create', moduleId: 'calendar',
        capabilityId: 'calendar.event.create', input: { calendarId: 'primary', summary: 'Agent work',
          start: '2026-09-13T10:00:00Z', end: '2026-09-13T11:00:00Z' },
        createdAt: new Date(0).toISOString(), requestedBy: 'agent:calendar-fixture', source: 'desktop',
        executionMode: 'agent-runtime', confirmed: false,
      });
      expect(result).toMatchObject({ ok: true, output: { id: 'event_1' } });
      expect(request).toHaveBeenCalledOnce();
    } finally { await kernel.stop(); }
  });
});

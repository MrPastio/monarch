import type { MonarchModulePackage } from '../../core';
import { BrokeredServiceModule, type ServiceHostTransport } from '../service-host';
import { CalendarHostTransport } from './host-transport';
import { calendarManifest } from './manifest';

export class CalendarModule extends BrokeredServiceModule {
  constructor(transport: ServiceHostTransport = new CalendarHostTransport()) {
    super({
      manifest: calendarManifest,
      transport,
      operationByCapability: {
        'calendar.connection.status': 'status',
        'calendar.calendars.list': 'calendars.list',
        'calendar.events.list': 'events.list',
        'calendar.event.create': 'event.create',
        'calendar.event.update': 'event.update',
      },
      summarize: summaryFor,
      failureSummary: calendarFailure,
    });
  }
}

function summaryFor(operation: string, output: Record<string, unknown>): string {
  if (operation === 'status') return output.connected ? 'Google Calendar connected.' : 'Google Calendar is not connected.';
  if (operation === 'calendars.list') return `Google Calendar returned ${Array.isArray(output.calendars) ? output.calendars.length : 0} calendars.`;
  if (operation === 'events.list') return `Google Calendar returned ${Array.isArray(output.events) ? output.events.length : 0} events.`;
  if (operation === 'event.create') return 'Google Calendar event created.';
  return 'Google Calendar event updated.';
}

function calendarFailure(code: string): string {
  if (code === 'calendar:not-connected') return 'Google Calendar не подключён. Открой Настройки → Интеграции.';
  if (code === 'calendar:permission-required' || code === 'calendar:scope-required') {
    return 'Для этого действия не выдано нужное разрешение Google Calendar.';
  }
  if (code === 'calendar:authentication') return 'Подключение Google Calendar истекло. Подключи аккаунт заново.';
  if (code === 'calendar:send-updates-required') return 'Для участников явно укажи, кому Google должен отправить уведомления.';
  if (code === 'calendar:conflict') return 'Событие уже изменилось. Сначала перечитай его и повтори действие с новым ETag.';
  return 'Google Calendar не выполнил запрос.';
}

export const calendarModulePackage: MonarchModulePackage = {
  id: calendarManifest.id,
  moduleId: calendarManifest.id,
  version: calendarManifest.version,
  description: calendarManifest.description,
  core: { minVersion: '0.1.0' },
  factory: () => new CalendarModule(),
};

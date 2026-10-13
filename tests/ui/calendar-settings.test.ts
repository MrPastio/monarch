import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeCalendarStatus } from '../../src/ui/public/modules/calendar-settings.js';

const html = readFileSync('src/ui/public/index.html', 'utf8');
const source = readFileSync('src/ui/public/modules/calendar-settings.js', 'utf8');
const preload = readFileSync('desktop/electron/preload.cjs', 'utf8');
const main = readFileSync('desktop/electron/main.mjs', 'utf8');

describe('Google Calendar settings surface', () => {
  it('normalizes a bounded credential-free status', () => {
    expect(normalizeCalendarStatus({ connected: true, account: 'owner@example.com', calendarName: 'Owner',
      refreshToken: 'must-not-render', permissions: { read: true, manage: false, delete: true } })).toEqual({
      connected: true, account: 'owner@example.com', calendarName: 'Owner',
      permissions: { read: true, manage: false },
    });
  });

  it('uses the registry IPC and keeps Calendar consent separate from Gmail', () => {
    expect(html).toContain('id="calendar-connect-form"');
    expect(html).toContain('Подключение Gmail не расширяется и не переиспользуется автоматически');
    expect(html).toContain('Удалять календари, события и правила доступа он не умеет');
    expect(source).toContain("integrations.connect('calendar', input)");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
    expect(preload).toContain("ipcRenderer.invoke('monarch:integration-connect', { serviceId, input })");
    expect(main).toContain("id: 'calendar', envPrefix: 'MONARCH_CALENDAR_HOST'");
  });
});

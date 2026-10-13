import { createGoogleOAuthController } from './google-oauth-controller.mjs';
import { CALENDAR_SCOPES } from './calendar-secret-broker.mjs';

const CALENDAR_LIST_ENDPOINT = 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250';

function fail(code) { throw Error(code); }

function exactPermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['read', 'manage'].includes(key))
    || Object.values(value).some(item => typeof item !== 'boolean')) fail('calendar:oauth-input');
  const permissions = { read: value.read === true, manage: value.manage === true };
  if (!permissions.read && !permissions.manage) fail('calendar:oauth-scope');
  return {
    scopes: [CALENDAR_SCOPES.calendarListRead,
      ...(permissions.manage ? [CALENDAR_SCOPES.eventsWrite] : [CALENDAR_SCOPES.eventsRead])],
    permissions,
  };
}

export function createCalendarOAuthController(options) {
  return createGoogleOAuthController({
    ...options,
    serviceId: 'calendar',
    serviceName: 'Google Calendar',
    prepareGrant: exactPermissions,
    verifyGrant: async ({ fetchJson }) => {
      const payload = await fetchJson(CALENDAR_LIST_ENDPOINT, { maximum: 512 * 1024 });
      const calendars = Array.isArray(payload.items) ? payload.items : [];
      const primary = calendars.find(item => item?.primary === true);
      const account = String(primary?.id || '').trim();
      const calendarName = String(primary?.summaryOverride || primary?.summary || '').trim();
      if (!account || account.length > 320 || /[\u0000-\u001f\u007f]/u.test(account)
        || calendarName.length > 512) fail('calendar:oauth-profile');
      return { account, calendarName };
    },
  });
}

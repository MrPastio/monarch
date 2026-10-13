import type { MonarchAgentCapabilityMetadataInput, MonarchModuleManifest } from '../../core';

const readAgent: MonarchAgentCapabilityMetadataInput = {
  idempotency: 'idempotent',
  cancellation: 'supported',
  estimatedLatency: 'short',
  computeClass: 'light',
  requiredCredentials: ['google-calendar-owner-oauth-read'],
  supportedSources: ['desktop', 'voice', 'api', 'system'],
  effectProfile: {
    mutation: 'none',
    targetScope: 'external-service',
    reversibility: 'manual',
    dataSensitivity: 'private',
    communication: 'third-party',
    financialImpact: false,
    identityImpact: false,
    securityImpact: false,
    privilege: 'normal',
  },
};

const writeAgent: MonarchAgentCapabilityMetadataInput = {
  idempotency: 'non-idempotent',
  cancellation: 'supported',
  estimatedLatency: 'short',
  computeClass: 'light',
  requiredCredentials: ['google-calendar-owner-oauth-manage'],
  supportedSources: ['desktop', 'voice', 'api', 'system'],
  effectProfile: {
    mutation: 'persistent',
    targetScope: 'external-service',
    reversibility: 'manual',
    dataSensitivity: 'private',
    communication: 'third-party',
    financialImpact: false,
    identityImpact: true,
    securityImpact: false,
    privilege: 'normal',
  },
};

const calendarId = { type: 'string', minLength: 1, maxLength: 1024 } as const;
const dateTime = { type: 'string', minLength: 16, maxLength: 64 } as const;
const attendees = { type: 'array', items: { type: 'string' }, maxItems: 50 } as const;
const sendUpdates = { type: 'string', enum: ['none', 'all', 'externalOnly'] } as const;

export const calendarManifest: MonarchModuleManifest = {
  id: 'calendar',
  name: 'Google Calendar',
  version: '0.1.0',
  stage: 'alpha',
  kind: 'domain',
  description: 'Owner-connected Google calendars and events through a protected Desktop credential broker.',
  owns: ['calendar', 'events', 'schedule', 'availability'],
  permissions: ['read', 'network'],
  events: ['calendar.activated'],
  capabilities: [
    {
      id: 'calendar.connection.status', moduleId: 'calendar', title: 'Check Google Calendar connection', risk: 'read',
      description: 'Return connection state and granted action classes without exposing OAuth credentials.',
      agent: { ...readAgent, requiredCredentials: [], estimatedLatency: 'instant',
        effectProfile: { ...readAgent.effectProfile, reversibility: 'automatic', communication: 'none' } },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      id: 'calendar.calendars.list', moduleId: 'calendar', title: 'List Google calendars', risk: 'network',
      description: 'List bounded calendar metadata for the separately connected Google Calendar account.',
      agent: readAgent,
      inputSchema: { type: 'object', properties: { maxResults: { type: 'number', minimum: 1, maximum: 50 } },
        additionalProperties: false },
    },
    {
      id: 'calendar.events.list', moduleId: 'calendar', title: 'List Google Calendar events', risk: 'network',
      description: 'Read a bounded event window of at most 366 days from one exact calendar.',
      agent: readAgent,
      inputSchema: { type: 'object', properties: { calendarId, timeMin: dateTime, timeMax: dateTime,
        query: { type: 'string', maxLength: 2048 }, maxResults: { type: 'number', minimum: 1, maximum: 50 } },
      required: ['calendarId', 'timeMin', 'timeMax'], additionalProperties: false },
    },
    {
      id: 'calendar.event.create', moduleId: 'calendar', title: 'Create Google Calendar event', risk: 'network',
      description: 'Create one timed event. Inviting attendees requires an explicit notification policy.',
      agent: writeAgent,
      inputSchema: { type: 'object', properties: { calendarId,
        summary: { type: 'string', minLength: 1, maxLength: 4096 },
        description: { type: 'string', maxLength: 16384 }, location: { type: 'string', maxLength: 4096 },
        start: dateTime, end: dateTime, timeZone: { type: 'string', maxLength: 128 }, attendees, sendUpdates },
      required: ['calendarId', 'summary', 'start', 'end'], additionalProperties: false },
    },
    {
      id: 'calendar.event.update', moduleId: 'calendar', title: 'Update Google Calendar event', risk: 'network',
      description: 'Conditionally update one exact event using its ETag. Attendee changes require an explicit notification policy.',
      agent: writeAgent,
      inputSchema: { type: 'object', properties: { calendarId,
        eventId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,1024}$' },
        etag: { type: 'string', minLength: 3, maxLength: 1026 },
        summary: { type: 'string', minLength: 1, maxLength: 4096 },
        description: { type: 'string', maxLength: 16384 }, location: { type: 'string', maxLength: 4096 },
        start: dateTime, end: dateTime, timeZone: { type: 'string', maxLength: 128 }, attendees, sendUpdates },
      required: ['calendarId', 'eventId', 'etag'], additionalProperties: false },
    },
  ],
};

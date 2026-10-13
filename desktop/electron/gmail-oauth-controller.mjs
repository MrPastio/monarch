import { createGoogleOAuthController } from './google-oauth-controller.mjs';
import { GMAIL_SCOPES } from './gmail-secret-broker.mjs';

const PROFILE_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

function fail(code) { throw Error(code); }

function exactPermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['search', 'read', 'compose'].includes(key))
    || Object.values(value).some(item => typeof item !== 'boolean')) fail('gmail:oauth-input');
  const permissions = { search: value.search === true, read: value.read === true, compose: value.compose === true };
  const scopes = [];
  // Gmail forbids q under gmail.metadata. The broker separately enforces body-read consent.
  if (permissions.search || permissions.read) scopes.push(GMAIL_SCOPES.read);
  if (permissions.compose) scopes.push(GMAIL_SCOPES.compose);
  if (scopes.length === 0) fail('gmail:oauth-scope');
  return { scopes, permissions };
}

export function createGmailOAuthController(options) {
  return createGoogleOAuthController({
    ...options,
    serviceId: 'gmail',
    serviceName: 'Gmail',
    prepareGrant: exactPermissions,
    verifyGrant: async ({ fetchJson }) => {
      const profile = await fetchJson(PROFILE_ENDPOINT);
      const email = String(profile.emailAddress || '').trim();
      if (!/^[^\s@]+@[^\s@]+$/u.test(email) || email.length > 320) fail('gmail:oauth-profile');
      return { email };
    },
  });
}

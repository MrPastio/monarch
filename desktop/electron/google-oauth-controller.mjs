import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALLBACK_PATH = '/oauth2/callback';

function serviceError(serviceId, suffix) { return Error(`${serviceId}:oauth-${suffix}`); }
function fail(serviceId, suffix) { throw serviceError(serviceId, suffix); }

function exactObject(value, keys, serviceId, suffix = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) fail(serviceId, suffix);
  return value;
}

function clientId(value, serviceId) {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{20,256}\.apps\.googleusercontent\.com$/u.test(result)) fail(serviceId, 'client');
  return result;
}

function clientSecret(value, serviceId) {
  const result = String(value || '').trim();
  if (result.length > 512 || /[\u0000-\u001f\u007f]/u.test(result)) fail(serviceId, 'client');
  return result;
}

async function responseJson(response, serviceId, maximum = 64 * 1024) {
  if (!response?.body) fail(serviceId, 'provider');
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(length) && length > maximum) fail(serviceId, 'provider');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        fail(serviceId, 'provider');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(serviceId, 'provider'); }
  if (!response.ok) fail(serviceId, response.status === 400 || response.status === 401 ? 'denied' : 'provider');
  return result;
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function browserPage(serviceName, ok) {
  const title = ok ? 'Разрешение получено' : `${serviceName} не подключён`;
  const detail = ok
    ? 'Monarch завершает проверку. Можно вернуться в приложение.'
    : 'Вернись в Monarch и повтори подключение.';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090909;color:#fff;font:16px system-ui}main{max-width:32rem;margin:2rem;padding:2rem;border:1px solid #ff9c3555;border-radius:24px;background:#ffffff0d;box-shadow:0 24px 80px #0008}b{color:#ffad55;font-size:1.35rem}p{color:#ccc;line-height:1.55}</style></head><body><main><b>${title}</b><p>${detail}</p></main></body></html>`;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolve => server.close(() => resolve()));
}

/** Shared loopback OAuth 2.0 + PKCE flow for independently consented Google services. */
export function createGoogleOAuthController({
  serviceId,
  serviceName,
  broker,
  openExternal,
  prepareGrant,
  verifyGrant,
  fetchImpl = fetch,
  timeoutMs = 5 * 60_000,
}) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(serviceId || '')
    || typeof serviceName !== 'string' || !serviceName.trim()
    || !broker || typeof broker.saveOAuthGrant !== 'function'
    || typeof openExternal !== 'function' || typeof prepareGrant !== 'function'
    || typeof verifyGrant !== 'function' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) fail(serviceId || 'google', 'configuration');
  let active = null;

  async function connect(raw) {
    if (active) fail(serviceId, 'in-progress');
    const input = exactObject(raw, ['clientId', 'clientSecret', 'permissions'], serviceId);
    const oauthClientId = clientId(input.clientId, serviceId);
    const oauthClientSecret = clientSecret(input.clientSecret, serviceId);
    const prepared = prepareGrant(input.permissions);
    if (!prepared || !Array.isArray(prepared.scopes) || prepared.scopes.length < 1
      || new Set(prepared.scopes).size !== prepared.scopes.length
      || prepared.scopes.some(scope => typeof scope !== 'string' || !scope.startsWith('https://www.googleapis.com/auth/'))
      || !prepared.permissions || typeof prepared.permissions !== 'object' || Array.isArray(prepared.permissions)) {
      fail(serviceId, 'scope');
    }
    const scopes = [...prepared.scopes].sort();
    const permissions = { ...prepared.permissions };
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let finish;
    const callback = new Promise((resolve, reject) => { finish = { resolve, reject }; });
    let settled = false;
    const settle = (kind, value) => {
      if (settled) return;
      settled = true;
      finish[kind](value);
    };
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
          response.end('Not found');
          return;
        }
        if (!equalSecret(url.searchParams.get('state'), state)) fail(serviceId, 'state');
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code || code.length > 4096) fail(serviceId, 'denied');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
        response.end(browserPage(serviceName, true));
        settle('resolve', code);
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
        response.end(browserPage(serviceName, false));
        settle('reject', /^[-a-z0-9]+:oauth-[a-z-]+$/u.test(error?.message || '')
          ? error : serviceError(serviceId, 'callback'));
      }
    });
    let timeout;
    active = { server, cancel: () => settle('reject', serviceError(serviceId, 'cancelled')) };
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }).catch(() => fail(serviceId, 'callback'));
      const address = server.address();
      if (!address || typeof address === 'string') fail(serviceId, 'callback');
      const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const authorization = new URL(AUTHORIZATION_ENDPOINT);
      authorization.search = new URLSearchParams({
        client_id: oauthClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      const expired = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(serviceError(serviceId, 'timeout')), timeoutMs);
      });
      await openExternal(authorization.toString());
      const code = await Promise.race([callback, expired]);
      const signal = AbortSignal.timeout(60_000);
      const token = await responseJson(await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: oauthClientId,
          ...(oauthClientSecret ? { client_secret: oauthClientSecret } : {}),
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
        signal,
      }), serviceId);
      if (typeof token.access_token !== 'string' || token.access_token.length < 16
        || typeof token.refresh_token !== 'string' || token.refresh_token.length < 16) fail(serviceId, 'token');
      const granted = new Set(String(token.scope || '').split(/\s+/u).filter(Boolean));
      if (scopes.some(scope => !granted.has(scope))) fail(serviceId, 'scope');
      const verified = await verifyGrant({
        accessToken: token.access_token,
        fetchJson: async (url, options = {}) => responseJson(await fetchImpl(url, {
          method: options.method || 'GET',
          redirect: 'error',
          headers: { authorization: `Bearer ${token.access_token}`, ...(options.headers || {}) },
          signal,
        }), serviceId, options.maximum),
      });
      if (!verified || typeof verified !== 'object' || Array.isArray(verified)) fail(serviceId, 'profile');
      await broker.saveOAuthGrant({
        clientId: oauthClientId,
        ...(oauthClientSecret ? { clientSecret: oauthClientSecret } : {}),
        refreshToken: token.refresh_token,
        scopes,
        permissions,
        ...verified,
        connectedAt: new Date().toISOString(),
      });
      return broker.status();
    } catch (error) {
      if (new RegExp(`^${serviceId}:oauth-[a-z-]+$`, 'u').test(error?.message || '')) throw error;
      throw serviceError(serviceId, 'provider');
    } finally {
      clearTimeout(timeout);
      if (active?.server === server) active = null;
      await closeServer(server);
    }
  }

  async function close() {
    const current = active;
    if (!current) return;
    current.cancel();
    await closeServer(current.server);
  }

  return { connect, close };
}

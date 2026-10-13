import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const BASE = '/internal/astra/v3/model-turns';
const MAX_BODY_BYTES = 640 * 1024;
const errorCode = /^[a-z0-9-]{1,96}$/u;

/** Source-preview-only authenticated loopback facade for the runtime's existing
 * AstraPreparedModelClient. The bearer token and host object never cross preload. */
export async function startAstraMaxModelServer(options) {
  if (!['source-preview-v1', 'native-desktop'].includes(options?.mode) || !validHost(options.host)) fail('options');
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from('Bearer ' + token);
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (!authorized(request.headers.authorization, expected)) { send(response, 401, { detail: { code: 'authentication-required' } }); return; }
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const method = request.method || '';
      let result;
      if (url.pathname === BASE && method === 'POST') result = options.host.open(await body(request));
      else if (url.pathname === BASE + '/settle-request' && method === 'POST') result = options.host.settleRequest(await body(request));
      else {
        const match = new RegExp('^' + BASE.replaceAll('/', '\\/') + '/([A-Za-z0-9_-]{1,96})(?:/(prepare|generate))?$').exec(url.pathname);
        if (!match) { send(response, 404, { detail: { code: 'route-unavailable' } }); return; }
        const turnId = match[1], operation = match[2] || '';
        if (!operation && method === 'GET') result = options.host.inspect(turnId);
        else if (!operation && method === 'DELETE') result = options.host.cancel(turnId);
        else if (operation === 'prepare' && method === 'POST') {
          const input = await body(request);
          if (!input || Object.keys(input).length !== 1 || typeof input.surface !== 'string') fail('prepare-request');
          result = options.host.prepare(turnId, input.surface);
        } else if (operation === 'generate' && method === 'POST') {
          const input = await body(request);
          if (!input || Object.keys(input).length !== 2 || typeof input.preparedId !== 'string' || typeof input.promptDigest !== 'string') fail('generate-request');
          // Transport loss is not a cancellation authority. The runtime may
          // have crashed after the paid provider request was accepted; the
          // main-owned host must finish and retain that exact result so the
          // restarted runtime can reconcile it. A deliberate task cancel uses
          // the authenticated DELETE route below and still aborts the host.
          result = await options.host.generate(turnId, input);
        } else { send(response, 405, { detail: { code: 'method-not-allowed' } }); return; }
      }
      send(response, 200, result);
    } catch (error) {
      const code = safeCode(error);
      send(response, code === 'model-busy' ? 429 : code === 'provider-failed' ? 502 : 409, { detail: { code } });
    }
  });
  server.requestTimeout = 605_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); fail('listen'); }
  const descriptor = options.host.descriptor();
  if (!validDescriptor(descriptor)) { server.close(); fail('host-descriptor'); }
  let closed = false;
  return Object.freeze({ endpoint: `http://127.0.0.1:${address.port}`, bearerToken: token,
    hostGeneration: descriptor.hostGeneration, modelDigest: descriptor.modelDigest,
    modelDigests: Object.freeze({ ...descriptor.modelDigests }),
    ...(descriptor.dynamicMaxCloud === true ? { dynamicMaxCloud: true } : {}),
    close: async () => {
      if (closed) return; closed = true; options.host.close();
      await new Promise(resolve => server.close(resolve));
    } });
}

function validHost(value) {
  return value && ['descriptor', 'open', 'prepare', 'generate', 'inspect', 'cancel', 'settleRequest', 'close']
    .every(name => typeof value[name] === 'function');
}
function validDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![3, 4].includes(Object.keys(value).length) || !Object.keys(value).every(key =>
      ['hostGeneration', 'modelDigest', 'modelDigests', 'dynamicMaxCloud'].includes(key))
    || value.dynamicMaxCloud !== undefined && value.dynamicMaxCloud !== true
    || typeof value.hostGeneration !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/u.test(value.hostGeneration)
    || typeof value.modelDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.modelDigest)
    || !value.modelDigests || typeof value.modelDigests !== 'object' || Array.isArray(value.modelDigests)) return false;
  const entries = Object.entries(value.modelDigests);
  return entries.length >= 1 && entries.length <= 3
    && entries.every(([modelId, digest]) => (['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'].includes(modelId)
      || value.dynamicMaxCloud === true && /^max-cloud:(?:openai|anthropic|gemini|openrouter|deepseek|mistral|xai|together|fireworks|cerebras|nvidia):[a-zA-Z0-9][a-zA-Z0-9._/:@+-]{0,159}$/u.test(modelId))
      && typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(digest))
    && new Set(entries.map(([, digest]) => digest)).size === entries.length
    && entries.some(([, digest]) => digest === value.modelDigest);
}
function authorized(value, expected) {
  if (typeof value !== 'string') return false;
  const candidate = Buffer.from(value);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
async function body(request) {
  const type = String(request.headers['content-type'] || '').toLowerCase();
  if (!type.startsWith('application/json')) fail('content-type');
  const chunks = []; let total = 0;
  for await (const chunk of request) {
    total += chunk.length; if (total > MAX_BODY_BYTES) fail('body-budget'); chunks.push(chunk);
  }
  if (total === 0) fail('body-required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('body-json'); }
}
function send(response, status, value) {
  if (response.writableEnded || response.destroyed) return;
  const payload = JSON.stringify(value);
  response.writeHead(status, { 'Content-Length': Buffer.byteLength(payload) }); response.end(payload);
}
function safeCode(error) {
  const value = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (errorCode.test(value)) return value;
  const message = error instanceof Error ? error.message : '';
  const match = /^astra-max-(?:prepared-host|model-server):([a-z0-9-]{1,96})$/u.exec(message);
  return match?.[1] || 'host-request-failed';
}
function fail(code) { throw Object.assign(Error('astra-max-model-server:' + code), { code }); }

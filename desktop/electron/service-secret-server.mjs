import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;

export async function startServiceSecretServer({ serviceId, operation, maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(serviceId || '')) throw Error('service-host:id');
  if (typeof operation !== 'function') throw Error('service-host:operation');
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) throw Error('service-host:request-budget');
  const bearerToken = randomBytes(32).toString('hex');
  const endpointPath = `/${serviceId}`;
  const server = http.createServer(async (request, response) => {
    const controller = new AbortController();
    const abort = () => controller.abort(`${serviceId}:client-disconnected`);
    request.once('aborted', abort);
    response.once('close', () => { if (!response.writableFinished) abort(); });
    try {
      if (request.method !== 'POST' || request.url !== endpointPath) throw Error(`${serviceId}:host-request`);
      const provided = String(request.headers.authorization || '').replace(/^Bearer\s+/iu, '');
      const left = Buffer.from(provided);
      const right = Buffer.from(bearerToken);
      if (left.length !== right.length || !timingSafeEqual(left, right)) {
        throw Error(`${serviceId}:host-authentication`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxRequestBytes) throw Error(`${serviceId}:host-budget`);
        chunks.push(Buffer.from(chunk));
      }
      const body = exactEnvelope(JSON.parse(Buffer.concat(chunks).toString('utf8')), serviceId);
      const result = await operation(body.operation, body.input, controller.signal);
      if (controller.signal.aborted || response.destroyed) return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result }));
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      const code = validServiceError(error?.message, serviceId) ? error.message : `${serviceId}:host-request`;
      response.writeHead(code === `${serviceId}:host-authentication` ? 401 : 400,
        { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: code }));
    } finally {
      request.removeListener('aborted', abort);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}${endpointPath}`,
    bearerToken,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function exactEnvelope(value, serviceId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['operation', 'input'].includes(key))
    || typeof value.operation !== 'string'
    || !/^[a-z][a-z0-9.-]{0,127}$/u.test(value.operation)
    || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
    throw Error(`${serviceId}:host-request`);
  }
  return value;
}

function validServiceError(value, serviceId) {
  return typeof value === 'string' && value.startsWith(`${serviceId}:`)
    && /^[a-z][a-z0-9-]*:[a-z0-9-]+$/u.test(value);
}

import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const PUBLIC_FAILURES = new Set(('busy cancelled unavailable caller-cancelled provider-rate-limited provider-unavailable provider-rejected safety-blocked-input safety-blocked-output safety-model-unavailable safety-json safety-schema credential-invalid encryption-unavailable protected-record model-not-allowed model-not-available proposal-transport-schema provider-body provider-choice provider-choices provider-content provider-content-type provider-finish provider-json provider-message provider-models provider-output-truncated provider-request-budget provider-response provider-response-budget response-schema-const-enum response-schema-root response-schema-strict-object response-schema-strict-required response-schema-union response-transport-schema not-configured connection connection-changed consent-required credential-rejected authentication unauthorized rate-limit quota provider-rate-limit provider-timeout timeout model model-retired model-unavailable model-not-found permission forbidden request messages reasoning schema response-schema response-rejected verification input-budget context-too-large output-budget empty-output truncated proposal-json proposal-schema json-validation-failed safety-blocked image-model-unavailable image-message image-budget image-format image-integrity provider-request-rejected credential-unavailable encrypted-storage-unavailable').split(' '));

const MAX_BODY_BYTES = 36 * 1024 * 1024;

/** Only a closed code crosses the host boundary. The Groq provider prefixes a
 * rejected call with its stage (`primary-`, `safety-input-`, `safety-output-`);
 * dropping those to `unavailable` hid every such cause behind "check the key". */
function publicFailure(error) {
  const candidate = /^(?:astra-max-[a-z-]+:)?([a-z][a-z0-9-]{0,80})$/.exec(String(error?.message || ''))?.[1];
  if (PUBLIC_FAILURES.has(candidate)) return candidate;
  const unstaged = /^(?:primary|safety-input|safety-output)-(.+)$/.exec(candidate || '')?.[1];
  return PUBLIC_FAILURES.has(unstaged) ? unstaged : 'unavailable';
}

/** Dedicated main/runtime channel. Never exported to preload, never accepts provider URLs or keys. */
export async function startAstraMaxNativeServer({ complete, stream, status, requestTimeoutMs = 600_000 }) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 600_000) throw Error('astra-max-native:timeout-config');
  const bearerToken = randomBytes(32).toString('hex');
  const authorization = Buffer.from('Bearer ' + bearerToken);
  const controllers = new Set();
  const server = http.createServer(async (request, response) => {
    const supplied = Buffer.from(String(request.headers.authorization || ''));
    const send = (status, value) => {
      if (!response.destroyed && !response.writableEnded && !response.headersSent) response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
    };
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)
      || request.headers.origin) return send(403, { error: 'forbidden' });
    // Whether the selected provider has a ready connection. The runtime uses it
    // to choose the agent's default model; it carries no key, provider body or
    // account detail - one boolean.
    if (request.method === 'POST' && request.url === '/status' && typeof status === 'function') {
      try { return send(200, { configured: (await status()) === true }); } catch { return send(200, { configured: false }); }
    }
    const streaming = request.url === '/stream' && typeof stream === 'function';
    if (request.method !== 'POST' || (request.url !== '/complete' && !streaming)) return send(404, { error: 'route' });
    if (controllers.size >= 2) return send(429, { error: 'busy' });
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => { controller.abort('provider-timeout'); send(504, { error: 'provider-timeout' }); }, requestTimeoutMs);
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return send(413, { error: 'input-budget' });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (controller.signal.aborted) throw Error('cancelled');
      if (streaming) {
        // One JSON object per line: {"delta"}, then {"done","model"} or {"error"}.
        // Errors after the head is sent travel as a final line, never as a body.
        const iterator = stream(input, controller.signal);
        const first = await iterator.next();
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        try {
          for (let item = first; !item.done; item = await iterator.next()) {
            if (controller.signal.aborted) throw Error('cancelled');
            response.write(JSON.stringify(item.value) + '\n');
          }
        } catch (error) {
          response.write(JSON.stringify({ error: controller.signal.aborted ? 'cancelled' : publicFailure(error) }) + '\n');
        }
        response.end();
        return;
      }
      const result = await complete(input, controller.signal);
      if (!controller.signal.aborted) send(200, result);
      else send(408, { error: controller.signal.reason === 'provider-timeout' ? 'provider-timeout' : 'cancelled' });
    } catch (error) {
      // Do not serialize provider bodies, prompts or credentials across the host boundary.
      send(502, { error: controller.signal.aborted ? controller.signal.reason === 'provider-timeout' ? 'provider-timeout' : 'cancelled' : publicFailure(error) });
    } finally { clearTimeout(timer); controllers.delete(controller); }
  });
  server.requestTimeout = 605_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return Object.freeze({ endpoint: `http://127.0.0.1:${server.address().port}/complete`, bearerToken,
    close: async () => { for (const controller of controllers) controller.abort();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
}

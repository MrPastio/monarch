import { isMaxNativeRole, maxNativeModel } from './max-native-contract';
import { ASTRA_MAX_NATIVE_REQUEST_BYTES, type AstraMaxMessageV1 } from './max-provider-contract';

// Consume the bootstrap capability once. Untrusted tool/Python children must not
// inherit it through process.env. The provider key never enters this process.
const inheritedHost = Object.freeze({ MONARCH_MAX_NATIVE_ENDPOINT: process.env.MONARCH_MAX_NATIVE_ENDPOINT,
  MONARCH_MAX_NATIVE_TOKEN: process.env.MONARCH_MAX_NATIVE_TOKEN });
delete process.env.MONARCH_MAX_NATIVE_ENDPOINT;
delete process.env.MONARCH_MAX_NATIVE_TOKEN;

/** Whether the host's selected MAX provider has a ready connection. A host
 * exists even with no key; choosing MAX by default from its mere presence sent
 * agent work to a provider that could only answer `not-configured`. Any failure
 * reads as "not ready": this only picks a default, it never grants anything. */
export async function isMaxNativeConfigured(signal?: AbortSignal, env: NodeJS.ProcessEnv = inheritedHost): Promise<boolean> {
  const endpoint = env.MONARCH_MAX_NATIVE_ENDPOINT, token = env.MONARCH_MAX_NATIVE_TOKEN;
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/complete$/.test(endpoint)
    || !token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const timeout = AbortSignal.timeout(5_000);
  try {
    const response = await fetch(endpoint.replace(/\/complete$/u, '/status'), { method: 'POST',
      headers: { Authorization: 'Bearer ' + token }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) return false;
    const value = await response.json() as { configured?: unknown };
    return value?.configured === true;
  } catch { return false; }
}

/** Runtime has a transient loopback capability, never the Groq credential. No fallback or retry. */
export async function requestMaxNative(input: { role: string; messages: AstraMaxMessageV1[];
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined; maxTokens?: number | undefined; responseSchema?: Record<string, unknown> },
  signal?: AbortSignal, env: NodeJS.ProcessEnv = inheritedHost): Promise<{ text: string; model: string }> {
  if (!isMaxNativeRole(input.role)) throw Error('astra-max-native:model');
  const endpoint = env.MONARCH_MAX_NATIVE_ENDPOINT;
  const token = env.MONARCH_MAX_NATIVE_TOKEN;
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/complete$/.test(endpoint)
    || !token || !/^[a-f0-9]{64}$/.test(token)) throw Error('astra-max-native:not-configured');
  if (Buffer.byteLength(JSON.stringify(input)) > ASTRA_MAX_NATIVE_REQUEST_BYTES) throw Error('astra-max-native:input-budget');
  const timeout = AbortSignal.timeout(610_000);
  const boundSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const fail = (code: string): never => { throw Error('astra-max-native:' + code); };
  const aborted = () => { if (signal?.aborted) fail('cancelled'); if (timeout.aborted) fail('provider-timeout'); };
  aborted();
  let response: Response;
  try {
    response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json' }, body: JSON.stringify(input), redirect: 'error',
      signal: boundSignal });
  } catch {
    throw Error('astra-max-native:' + (signal?.aborted ? 'cancelled'
      : timeout.aborted ? 'provider-timeout' : 'unavailable'));
  }
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (!response.body) throw Error('astra-max-native:empty-output');
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read(); aborted(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 4 * 1024 * 1024) fail('output-budget');
      chunks.push(part.value);
    }
  } catch (error) {
    aborted();
    if ((error as Error)?.message === 'astra-max-native:output-budget') throw error;
    fail('response-interrupted');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  aborted();
  let value: { text?: unknown; model?: unknown; error?: unknown };
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('response-invalid');
    value = parsed;
  } catch { return fail('response-invalid'); }
  if (!response.ok) throw Error('astra-max-native:' + (typeof value.error === 'string' && /^[a-z0-9-]{1,80}$/.test(value.error) ? value.error : 'unavailable'));
  if (typeof value.text !== 'string' || !value.text.trim() || typeof value.model !== 'string'
    || value.model !== maxNativeModel(input.role)) throw Error('astra-max-native:output-binding');
  return { text: value.text, model: value.model };
}

/** The same loopback capability, answer streamed line by line as it is written. */
export async function* streamMaxNativeAnswer(input: { role: string; messages: AstraMaxMessageV1[];
  reasoningEffort?: 'low' | 'medium' | 'high' | undefined; maxTokens?: number | undefined },
  signal?: AbortSignal, env: NodeJS.ProcessEnv = inheritedHost): AsyncGenerator<string, { model: string; stopReason: 'stop' | 'length' }> {
  if (!isMaxNativeRole(input.role)) throw Error('astra-max-native:model');
  const endpoint = env.MONARCH_MAX_NATIVE_ENDPOINT;
  const token = env.MONARCH_MAX_NATIVE_TOKEN;
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/complete$/.test(endpoint)
    || !token || !/^[a-f0-9]{64}$/.test(token)) throw Error('astra-max-native:not-configured');
  if (Buffer.byteLength(JSON.stringify(input)) > ASTRA_MAX_NATIVE_REQUEST_BYTES) throw Error('astra-max-native:input-budget');
  const timeout = AbortSignal.timeout(610_000);
  const boundSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const fail = (code: string): never => { throw Error('astra-max-native:' + code); };
  const aborted = () => { if (signal?.aborted) fail('cancelled'); if (timeout.aborted) fail('provider-timeout'); };
  aborted();
  let response: Response;
  try {
    response = await fetch(endpoint.replace(/\/complete$/u, '/stream'), { method: 'POST', headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json' }, body: JSON.stringify(input), redirect: 'error', signal: boundSignal });
  } catch {
    throw Error('astra-max-native:' + (signal?.aborted ? 'cancelled' : timeout.aborted ? 'provider-timeout' : 'unavailable'));
  }
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: unknown } | null;
    throw Error('astra-max-native:' + (typeof value?.error === 'string' && /^[a-z0-9-]{1,80}$/.test(value.error) ? value.error : 'unavailable'));
  }
  if (!response.body) fail('empty-output');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '', size = 0, model = '', stopReason: 'stop' | 'length' = 'stop';
  try {
    while (!model) {
      const part = await reader.read(); aborted(); if (part.done) break;
      size += part.value.byteLength; if (size > 4 * 1024 * 1024) fail('output-budget');
      buffer += decoder.decode(part.value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let value: { delta?: unknown; done?: unknown; model?: unknown; error?: unknown; stopReason?: unknown };
        try { value = JSON.parse(line); } catch { return fail('response-invalid'); }
        if (typeof value.error === 'string') fail(/^[a-z0-9-]{1,80}$/.test(value.error) ? value.error : 'unavailable');
        if (typeof value.delta === 'string') { if (value.delta) yield value.delta; continue; }
        if (value.done === true && typeof value.model === 'string') {
          model = value.model;
          if (value.stopReason === 'length') stopReason = 'length';
          break;
        }
      }
    }
  } catch (error) {
    aborted();
    if (error instanceof Error && error.message.startsWith('astra-max-native:')) throw error;
    fail('response-interrupted');
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (!model) fail('response-interrupted');
  if (model !== maxNativeModel(input.role)) fail('output-binding');
  return { model, stopReason };
}

import { createHash } from 'node:crypto';
import { astraJournalJson, type AstraJson } from './journal';
import type { AstraTokenizerBinding } from './context-engine';
import { type AstraModelHostProvider, type AstraModelHostIdentity } from './model-host-provider';

// Only an explicitly supplied, authenticated loopback host. Never resolve an
// arbitrary provider, read credentials/config, follow redirects or select models.
export interface AstraPreparedModelBinding extends AstraTokenizerBinding {
  framingDigest: string; contextTokens: number; safetyTokens: number;
  profile: 'monarch.astra-v3-prepared-text.internal.v1';
}
export interface AstraModelTurn {
  memoryValidityToken?: string;
  turnId: string; hostGeneration: string; executionId: string; state: string; reason: string | null;
  slotReserved: boolean; binding: AstraPreparedModelBinding; remainingMs: number;
  preparedId: string | null; prepareCount: number; authority: 'none'; persistence: 'process-local';
}
export interface AstraPreparedModelInput {
  turnId: string; hostGeneration: string; preparedId: string; surfaceDigest: string; promptDigest: string;
  schemaDigest: string; tokenCount: number; promptUtf8Bytes: number; reservedOutputTokens: number;
  fits: boolean; binding: AstraPreparedModelBinding;
}
export interface AstraPreparedModelOutput {
  turnId: string; hostGeneration: string; preparedId: string; text: string; finishReason: 'stop' | 'length';
  authority: 'none'; surfaceDigest: string; promptDigest: string; schemaDigest: string;
  inputTokens: number; binding: AstraPreparedModelBinding;
}
export interface AstraModelOpenRequest {
  memoryValidityToken?: string;
  /** Exact dynamic provider/model role. Omitted for closed local/native maps. */
  modelId?: string;
  requestId: string; executionId: string; expectedModelDigest: string; responseSchema: AstraJson;
  maxOutputTokens: number; timeoutMs?: number; lane?: 'interactive' | 'agent' | 'coder' | 'background'; notAfterMs?: number;
}
export interface AstraModelRecoverySnapshot {
  hostGeneration: string; requestId: string; requestDigest: string; executionId: string; expectedModelDigest: string;
  schemaDigest: string; maxOutputTokens: number; notAfterMs: number; turnId: string;
  state: 'generated' | 'cancelled' | 'cancelling'; reason: string | null; quiescent: boolean; slotReserved: boolean;
  prepared: AstraPreparedModelInput | null; output: AstraPreparedModelOutput | null;
  authority: 'none'; persistence: 'process-local';
}
export class AstraModelClientError extends Error {
  constructor(readonly code: string) { super('astra-model-client:' + code); }
}
const sha = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
// Counting reaches past any model window: the context engine counts a long
// history before compacting it, and the host answers `fits: false` instead of
// failing. The former 131072 cap rejected that honest count as a binding
// fault (live: `tokenizer-unavailable` after ~20 rounds of written files).
const MAX_COUNTED_TOKENS = 786_432;
function check(value: unknown, code: string): asserts value { if (!value) throw new AstraModelClientError(code); }
function record(value: unknown): Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'response-object'); return value as Record<string, unknown>;
}
function binding(value: unknown): AstraPreparedModelBinding {
  const b = record(value);
  check(b.profile === 'monarch.astra-v3-prepared-text.internal.v1' && id(b.driverGeneration)
    && digest(b.modelDigest) && digest(b.tokenizerDigest) && digest(b.framingDigest)
    && integer(b.contextTokens, 256, 262_144) && integer(b.safetyTokens, 1, 1024), 'driver-binding');
  return structuredClone(b) as unknown as AstraPreparedModelBinding;
}
function sameBinding(left: AstraPreparedModelBinding, right: unknown): void {
  check(astraJournalJson(json(left)) === astraJournalJson(json(binding(right))), 'driver-changed');
}
const states = new Set(['queued', 'preparing-driver', 'ready', 'preparing', 'prepared', 'generating', 'generated', 'cancelling', 'cancelled']);
const MAX_MODEL_OUTPUT_TOKENS = 65_536;
const MAX_MODEL_TIMEOUT_MS = 600_000;
const MAX_MODEL_OUTPUT_BYTES = 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 3 * 1024 * 1024;

export class AstraPreparedModelClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private opening = 0;
  private readonly sessions = new Map<string, { requestId: string; executionId: string; binding: AstraPreparedModelBinding; outputTokens: number; schemaDigest: string; memoryValidityToken?: string; settled: boolean }>();

  constructor(private readonly options: { deployment: 'isolated-validation'; endpoint: string; bearerToken: string;
    hostGeneration: string; timeoutMs?: number; fetch?: typeof fetch; hostProvider?: AstraModelHostProvider }) {
    check(options.deployment === 'isolated-validation', 'deployment');
    const url = new URL(options.endpoint);
    check(url.protocol === 'http:' && url.hostname === '127.0.0.1' && integer(Number(url.port), 1, 65535)
      && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'owned-loopback-required');
    check(typeof options.bearerToken === 'string' && /^[\x21-\x7e]{1,4096}$/u.test(options.bearerToken), 'explicit-credential-required');
    check(id(options.hostGeneration), 'host-generation');
    this.base = url.origin + '/internal/astra/v3/model-turns';
    this.timeoutMs = options.timeoutMs ?? 65000;
    check(integer(this.timeoutMs, 20, 610_000), 'deadline-budget');
  }

  descriptor(): { hostGeneration: string; endpointDigest: string } {
    return { hostGeneration: this.options.hostGeneration, endpointDigest: sha(this.base) };
  }

  async forNewAttempt(signal?: AbortSignal): Promise<AstraPreparedModelClient> {
    if (!this.options.hostProvider) return this;
    const binding = await this.options.hostProvider.ensureFresh('model-attempt', signal);
    const { hostProvider: _provider, ...options } = this.options;
    return new AstraPreparedModelClient({ ...options, ...binding });
  }

  forDescriptor(identity: AstraModelHostIdentity): AstraPreparedModelClient | undefined {
    const binding = this.options.hostProvider?.lookup(identity);
    if (binding) {
      const { hostProvider: _provider, ...options } = this.options;
      return new AstraPreparedModelClient({ ...options, ...binding });
    }
    const own = this.descriptor();
    return own.hostGeneration === identity.hostGeneration && own.endpointDigest === identity.endpointDigest ? this : undefined;
  }

  hostExited(identity: AstraModelHostIdentity): boolean { return this.options.hostProvider?.isQuiescent(identity) === true; }

  async waitForHostExit(identity: AstraModelHostIdentity, signal: AbortSignal): Promise<void> {
    check(this.options.hostProvider, 'host-exit-evidence-unavailable');
    await this.options.hostProvider.waitForExit(identity, signal);
  }

  async open(input: AstraModelOpenRequest, signal?: AbortSignal): Promise<AstraModelTurn> {
    check(id(input.requestId) && id(input.executionId) && digest(input.expectedModelDigest)
      && (input.modelId === undefined || typeof input.modelId === 'string' && /^[\x21-\x7e]{1,200}$/u.test(input.modelId))
      && (input.memoryValidityToken === undefined || digest(input.memoryValidityToken))
      && integer(input.maxOutputTokens, 1, MAX_MODEL_OUTPUT_TOKENS)
      && integer(input.timeoutMs ?? 60000, 20, MAX_MODEL_TIMEOUT_MS)
      && (input.notAfterMs === undefined || integer(input.notAfterMs, 1, Number.MAX_SAFE_INTEGER)), 'request');
    const copied = JSON.parse(astraJournalJson(json(input))) as typeof input;
    const schema = astraJournalJson(copied.responseSchema);
    check(Buffer.byteLength(schema) <= 24000, 'schema-size');
    const replay = [...this.sessions.values()].some(session => session.requestId === copied.requestId);
    check(this.opening < 32 && (replay || this.sessions.size + this.opening < 32), 'client-turn-budget');
    this.opening++;
    try {
      const raw = record(await this.request('', 'POST', json(copied), signal));
      const turn = this.turn(raw);
      check(turn.memoryValidityToken === copied.memoryValidityToken, 'memory-guard-binding');
      check(turn.executionId === input.executionId && turn.binding.modelDigest === input.expectedModelDigest
        && ['ready', 'prepared', 'generated'].includes(turn.state), 'turn-not-ready');
      check(this.sessions.has(turn.turnId) || this.sessions.size < 32, 'client-turn-budget');
      const existing = this.sessions.get(turn.turnId), session = { requestId: copied.requestId, executionId: copied.executionId,
        binding: turn.binding, outputTokens: copied.maxOutputTokens, schemaDigest: sha(schema),
        ...(copied.memoryValidityToken === undefined ? {} : { memoryValidityToken: copied.memoryValidityToken }) };
      if (existing) check(existing.requestId === session.requestId && existing.executionId === session.executionId && existing.outputTokens === session.outputTokens
        && existing.schemaDigest === session.schemaDigest
        && existing.memoryValidityToken === session.memoryValidityToken
        && astraJournalJson(json(existing.binding)) === astraJournalJson(json(session.binding)), 'turn-replay-conflict');
      this.sessions.set(turn.turnId, { ...structuredClone(session), settled: !turn.slotReserved && turn.state === 'generated' });
      return turn;
    } finally { this.opening--; }
  }

  async settleRequest(input: AstraModelOpenRequest & { notAfterMs: number }, signal?: AbortSignal): Promise<AstraModelRecoverySnapshot> {
    const copied = JSON.parse(astraJournalJson(json(input))) as typeof input;
    check(id(copied.requestId) && id(copied.executionId) && digest(copied.expectedModelDigest)
      && (copied.modelId === undefined || typeof copied.modelId === 'string' && /^[\x21-\x7e]{1,200}$/u.test(copied.modelId))
      && (copied.memoryValidityToken === undefined || digest(copied.memoryValidityToken))
      && integer(copied.maxOutputTokens, 1, MAX_MODEL_OUTPUT_TOKENS)
      && integer(copied.notAfterMs, 1, Number.MAX_SAFE_INTEGER), 'recovery-request');
    const schemaDigest = sha(astraJournalJson(copied.responseSchema));
    const requestDigest = sha(astraJournalJson({ execution: copied.executionId, model: copied.expectedModelDigest,
      ...(copied.modelId === undefined ? {} : { modelId: copied.modelId }),
      schema: copied.responseSchema, output: copied.maxOutputTokens, deadline: copied.timeoutMs ?? 60000,
      lane: copied.lane ?? 'agent', notAfterMs: copied.notAfterMs,
      ...(copied.memoryValidityToken === undefined ? {} : { memoryValidityToken: copied.memoryValidityToken }) }));
    const raw = record(await this.request('/settle-request', 'POST', json(copied), signal ?? AbortSignal.timeout(5000)));
    this.host(raw);
    check(raw.requestId === copied.requestId && raw.executionId === copied.executionId && raw.requestDigest === requestDigest
      && raw.expectedModelDigest === copied.expectedModelDigest && raw.schemaDigest === schemaDigest
      && raw.maxOutputTokens === copied.maxOutputTokens && raw.notAfterMs === copied.notAfterMs
      && id(raw.turnId) && ['generated', 'cancelled', 'cancelling'].includes(String(raw.state))
      && typeof raw.slotReserved === 'boolean' && typeof raw.quiescent === 'boolean'
      && (raw.reason === null || typeof raw.reason === 'string' && /^[a-z0-9-]{1,96}$/u.test(raw.reason))
      && raw.quiescent === (!raw.slotReserved && ['generated', 'cancelled'].includes(String(raw.state)))
      && raw.authority === 'none' && raw.persistence === 'process-local', 'recovery-binding');
    if (raw.prepared !== null) {
      const prepared = record(raw.prepared); this.host(prepared); const b = binding(prepared.binding);
      check(b.modelDigest === copied.expectedModelDigest && prepared.turnId === raw.turnId && id(prepared.preparedId)
        && digest(prepared.surfaceDigest) && digest(prepared.promptDigest) && prepared.schemaDigest === schemaDigest
        && prepared.reservedOutputTokens === copied.maxOutputTokens && integer(prepared.tokenCount, 1, MAX_COUNTED_TOKENS)
        && integer(prepared.promptUtf8Bytes, 1, 786432)
        && prepared.fits === (prepared.tokenCount + copied.maxOutputTokens + b.safetyTokens <= b.contextTokens), 'recovery-prepared-binding');
    }
    if (raw.output !== null) {
      check(raw.state === 'generated' && raw.quiescent && raw.prepared !== null, 'recovery-output-state');
      const output = record(raw.output), prepared = record(raw.prepared); this.host(output); sameBinding(binding(prepared.binding), output.binding);
      check(output.turnId === raw.turnId && output.preparedId === prepared.preparedId
        && output.surfaceDigest === prepared.surfaceDigest && output.promptDigest === prepared.promptDigest
        && output.schemaDigest === prepared.schemaDigest && output.inputTokens === prepared.tokenCount
        && ['stop', 'length'].includes(String(output.finishReason)) && output.authority === 'none'
        && typeof output.text === 'string' && Buffer.byteLength(output.text) > 0
        && Buffer.byteLength(output.text) <= MAX_MODEL_OUTPUT_BYTES, 'recovery-output-binding');
    } else check(raw.state !== 'generated', 'recovery-output-missing');
    const owned = this.sessions.get(raw.turnId);
    if (owned && raw.quiescent) owned.settled = true;
    return structuredClone(raw) as unknown as AstraModelRecoverySnapshot;
  }

  async prepare(turnId: string, surface: string, signal?: AbortSignal): Promise<AstraPreparedModelInput> {
    const session = this.session(turnId);
    check(typeof surface === 'string' && Buffer.byteLength(surface) > 0 && Buffer.byteLength(surface) <= 524288, 'surface-size');
    const value = record(await this.request('/' + turnId + '/prepare', 'POST', { surface }, signal));
    this.host(value); sameBinding(session.binding, value.binding);
    const bound = { turn: value.turnId === turnId, id: id(value.preparedId), surface: value.surfaceDigest === sha(surface),
      prompt: digest(value.promptDigest), schema: value.schemaDigest === session.schemaDigest,
      tokens: integer(value.tokenCount, 1, MAX_COUNTED_TOKENS), bytes: integer(value.promptUtf8Bytes, 1, 786432),
      reserved: value.reservedOutputTokens === session.outputTokens, fits: typeof value.fits === 'boolean' };
    // Names which part of the host's answer did not match; the code alone hid it.
    if (!Object.values(bound).every(Boolean)) console.error(JSON.stringify({ diagnostic: 'astra-prepared-input-binding',
      failed: Object.entries(bound).filter(([, ok]) => !ok).map(([key]) => key).join(','),
      reserved: value.reservedOutputTokens, expected: session.outputTokens, tokenCount: String(value.tokenCount), bytes: String(value.promptUtf8Bytes) }));
    check(Object.values(bound).every(Boolean), 'prepared-input-binding');
    check(value.fits === ((value.tokenCount as number) + session.outputTokens + session.binding.safetyTokens <= session.binding.contextTokens), 'prepared-capacity-binding');
    return structuredClone(value) as unknown as AstraPreparedModelInput;
  }

  async generate(prepared: AstraPreparedModelInput, signal?: AbortSignal): Promise<AstraPreparedModelOutput> {
    const session = this.session(prepared.turnId);
    this.host(prepared as unknown as Record<string, unknown>); sameBinding(session.binding, prepared.binding);
    check(id(prepared.preparedId) && digest(prepared.promptDigest) && prepared.schemaDigest === session.schemaDigest
      && prepared.reservedOutputTokens === session.outputTokens && prepared.fits, 'prepared-input-binding');
    const value = record(await this.request('/' + prepared.turnId + '/generate', 'POST',
      { preparedId: prepared.preparedId, promptDigest: prepared.promptDigest }, signal));
    this.host(value); sameBinding(session.binding, value.binding);
    check(value.turnId === prepared.turnId && value.preparedId === prepared.preparedId
      && value.surfaceDigest === prepared.surfaceDigest && value.promptDigest === prepared.promptDigest
      && value.schemaDigest === prepared.schemaDigest && value.inputTokens === prepared.tokenCount
      && ['stop', 'length'].includes(String(value.finishReason)) && value.authority === 'none'
      && typeof value.text === 'string' && Buffer.byteLength(value.text) > 0
      && Buffer.byteLength(value.text) <= MAX_MODEL_OUTPUT_BYTES, 'generation-input-binding');
    session.settled = true;
    return structuredClone(value) as unknown as AstraPreparedModelOutput;
  }

  async inspect(turnId: string, signal?: AbortSignal): Promise<AstraModelTurn> {
    const session = this.session(turnId);
    const turn = this.turn(await this.request('/' + turnId, 'GET', undefined, signal));
    check(turn.memoryValidityToken === session.memoryValidityToken, 'memory-guard-binding');
    check(turn.turnId === turnId && turn.executionId === session.executionId, 'turn-binding'); sameBinding(session.binding, turn.binding);
    session.settled = !turn.slotReserved && ['generated', 'cancelled'].includes(turn.state);
    return turn;
  }

  async cancel(turnId: string): Promise<AstraModelTurn> {
    const session = this.session(turnId);
    // Independent short deadline: caller's aborted signal must not prevent the
    // exact cancellation request from reaching its already-owned backend turn.
    const turn = this.turn(await this.request('/' + turnId, 'DELETE', undefined, AbortSignal.timeout(5000)));
    check(turn.memoryValidityToken === session.memoryValidityToken, 'memory-guard-binding');
    check(turn.turnId === turnId && turn.executionId === session.executionId, 'turn-binding'); sameBinding(session.binding, turn.binding);
    session.settled = !turn.slotReserved && ['generated', 'cancelled'].includes(turn.state);
    return turn;
  }

  forget(turnId: string): void { check(this.session(turnId).settled, 'turn-not-settled'); this.sessions.delete(turnId); }

  private session(turnId: string) {
    check(id(turnId), 'turn-identity'); const session = this.sessions.get(turnId); check(session, 'unowned-turn'); return session;
  }
  private host(value: Record<string, unknown>): void { check(value.hostGeneration === this.options.hostGeneration, 'host-changed'); }
  private turn(value: unknown): AstraModelTurn {
    const raw = record(value); this.host(raw);
    check(id(raw.turnId) && id(raw.executionId) && states.has(String(raw.state)) && typeof raw.slotReserved === 'boolean'
      && (raw.memoryValidityToken === undefined || digest(raw.memoryValidityToken))
      && (raw.reason === null || typeof raw.reason === 'string' && /^[a-z0-9-]{1,96}$/u.test(raw.reason))
      && integer(raw.remainingMs, 0, MAX_MODEL_TIMEOUT_MS) && integer(raw.prepareCount, 0, 8)
      && (raw.preparedId === null || id(raw.preparedId)) && raw.authority === 'none' && raw.persistence === 'process-local', 'turn-response');
    binding(raw.binding);
    return structuredClone(raw) as unknown as AstraModelTurn;
  }

  private async request(suffix: string, method: 'GET' | 'POST' | 'DELETE', body?: AstraJson, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs), combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.base + suffix, { method, redirect: 'error', signal: combined,
        headers: { Authorization: 'Bearer ' + this.options.bearerToken, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: astraJournalJson(body) }) });
    } catch {
      throw new AstraModelClientError(signal?.aborted ? 'caller-cancelled' : timeout.aborted ? 'transport-deadline' : 'transport-unavailable');
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      await response.body?.cancel().catch(() => undefined);
      throw new AstraModelClientError('response-content-type');
    }
    const reader = response.body?.getReader(); check(reader, 'response-body');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        check(size <= MAX_MODEL_RESPONSE_BYTES, 'response-byte-budget'); chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof AstraModelClientError) throw error;
      throw new AstraModelClientError(combined.aborted ? 'transport-deadline' : 'transport-body-failed');
    } finally { reader.releaseLock(); }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      astraJournalJson(value as AstraJson);
    } catch { throw new AstraModelClientError('response-json-invalid'); }
    if (!response.ok) {
      const detail = record(value).detail;
      const code = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>).code : undefined;
      throw new AstraModelClientError(typeof code === 'string' && /^[a-z0-9-]{1,96}$/u.test(code) ? code : 'host-request-refused');
    }
    return value;
  }
}

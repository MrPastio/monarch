import { createHash } from 'node:crypto';
import { AstraJournalError, astraJournalJson, type AstraJson, type AstraJournalAccess } from './journal';

// Internal ContextPlan compiler, not a native protocol body or MemoryAuthority.
// No token/character heuristic is accepted: the host supplies the selected driver's
// exact tokenizer for this ENTIRE serialized surface, including its envelope/tools.
// Product driver framing, durable-memory retrieval and delta sessions remain separate.
export type AstraMandatoryKind = 'goal' | 'authority' | 'workflow' | 'budget' | 'privacy' | 'capability' | 'receipt' | 'evidence';
export interface AstraContextItem { ref: string; text: string }
export interface AstraContextSource {
  executionId: string; revision: number;
  mandatory: Array<AstraContextItem & { kind: AstraMandatoryKind }>;
  optional: Array<AstraContextItem & { kind: 'narrative' | 'recalled-memory' }>;
}
export interface AstraTokenizerBinding { driverGeneration: string; modelDigest: string; tokenizerDigest: string }
export interface AstraContextPlan {
  executionId: string; sourceRevision: number; sourceDigest: string; surfaceDigest: string; surface: string;
  tokenCount: number; utf8Bytes: number; tokenizer: AstraTokenizerBinding; budgetDigest: string;
  omittedRefs: string[]; compaction: null | {
    authorityEligible: false; sourceRangeDigest: string; beforeTokens: number; afterTokens: number; savedBytes: number;
  };
}
export type AstraContextResult = { status: 'ready'; plan: AstraContextPlan }
  | { status: 'blocked'; code: 'stale-source' | 'context-busy' | 'context-capacity-insufficient' | 'compaction-failed' | 'tokenizer-unavailable' };
interface ContextCheckpoint {
  schemaVersion: 'monarch.astra-v3-context.internal.v1'; armed: boolean;
  attemptKey: string | null;
  pending: { sourceDigest: string; sourceRevision: number; attemptKey: string } | null;
  active: AstraContextPlan | null;
}
export interface AstraContextLimits {
  hardTokens: number; softTokens: number; rearmTokens: number; reservedOutputTokens: number;
  hardBytes: number; recentNarrativeItems: number; minimumSavedTokens: number; tokenizerTimeoutMs: number;
}
const digest = (value: string): string => 'sha256:' + createHash('sha256').update(value).digest('hex');
const json = (value: unknown): AstraJson => JSON.parse(JSON.stringify(value)) as AstraJson;
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('astra-context:' + code); }
const kinds = new Set(['goal', 'authority', 'workflow', 'budget', 'privacy', 'capability', 'receipt', 'evidence']);
const defaults: AstraContextLimits = { hardTokens: 8192, softTokens: 6144, rearmTokens: 4096,
  reservedOutputTokens: 1024, hardBytes: 262144, recentNarrativeItems: 4, minimumSavedTokens: 64, tokenizerTimeoutMs: 2000 };

/** Pure structural admission, also used before durable model-work queueing. */
export function validateAstraContextSource(source: AstraContextSource, executionId = source.executionId): void {
  check(/^[a-zA-Z0-9_-]{1,96}$/u.test(executionId) && source.executionId === executionId
    && Number.isSafeInteger(source.revision) && source.revision >= 0, 'source-scope');
  check(Array.isArray(source.mandatory) && source.mandatory.length <= 128
    && Array.isArray(source.optional) && source.optional.length <= 256, 'item-budget');
  check(['goal', 'authority', 'workflow', 'budget'].every(kind => source.mandatory.some(item => item.kind === kind)), 'mandatory-minimum');
  const all = [...source.mandatory, ...source.optional];
  check(all.every(item => /^[a-zA-Z0-9_-]{1,96}$/u.test(item.ref) && typeof item.text === 'string' && Buffer.byteLength(item.text) <= 262144)
    && new Set(all.map(item => item.ref)).size === all.length, 'item-shape');
  check(source.mandatory.every(item => kinds.has(item.kind))
    && source.optional.every(item => item.kind === 'narrative' || item.kind === 'recalled-memory'), 'item-kind');
  check(source.optional.filter(item => item.kind === 'recalled-memory')
    .reduce((bytes, item) => bytes + Buffer.byteLength(astraJournalJson(json({ ...item, authorityEligible: false }))), 0) <= 4096, 'memory-byte-budget');
}

export class AstraContextEngine {
  private readonly limits: AstraContextLimits;
  private flight: { digest: string; promise: Promise<AstraContextResult> } | undefined;
  private readonly tokenizer: AstraTokenizerBinding;
  constructor(private readonly options: {
    deployment: 'isolated-validation'; journal: AstraJournalAccess; executionId: string; tokenizer: AstraTokenizerBinding;
    countTokens: (surface: string, signal: AbortSignal) => Promise<number>;
    isCurrent: (revision: number, sourceDigest: string) => boolean;
    limits?: Partial<AstraContextLimits>;
  }) {
    check(options.deployment === 'isolated-validation' && /^[a-zA-Z0-9_-]{1,96}$/u.test(options.executionId), 'scope');
    this.limits = { ...defaults, ...options.limits };
    const l = this.limits;
    check(Object.values(l).every(value => Number.isSafeInteger(value) && value >= 0)
      && l.hardTokens <= 262_144 && l.rearmTokens < l.softTokens && l.softTokens < l.hardTokens
      && l.reservedOutputTokens < l.rearmTokens && l.hardBytes >= 512 && l.hardBytes <= 524288
      && l.recentNarrativeItems <= 32 && l.minimumSavedTokens > 0
      && l.tokenizerTimeoutMs >= 10 && l.tokenizerTimeoutMs <= 10000, 'limits');
    this.tokenizer = structuredClone(options.tokenizer);
    check(Object.values(this.tokenizer).every(value => typeof value === 'string' && value.length > 0 && value.length <= 128)
      && ['driverGeneration', 'modelDigest', 'tokenizerDigest'].every(key => key in this.tokenizer), 'tokenizer-binding');
  }

  prepare(source: AstraContextSource): Promise<AstraContextResult> {
    // Copy and validate before the first await; mutations by a caller cannot alter
    // the source after digesting it. No getters/non-JSON values are evaluated here.
    const encoded = astraJournalJson(source as unknown as AstraJson);
    const frozen = JSON.parse(encoded) as AstraContextSource;
    this.validate(frozen);
    const sourceDigest = digest(encoded), requestDigest = digest(encoded + astraJournalJson(json(this.tokenizer)));
    if (this.flight) {
      if (this.flight.digest === requestDigest) return this.flight.promise;
      return Promise.resolve({ status: 'blocked', code: 'context-busy' });
    }
    const promise = this.compile(frozen, sourceDigest).catch((error: unknown): AstraContextResult => {
      if (error instanceof AstraJournalError && ['revision-conflict', 'idempotency-conflict'].includes(error.code)) {
        return { status: 'blocked', code: 'stale-source' };
      }
      throw error; // Storage/integrity faults are NOT a benign capacity/refusal result.
    }).finally(() => { this.flight = undefined; });
    this.flight = { digest: requestDigest, promise };
    return promise;
  }

  active(): AstraContextPlan | null { return this.state().checkpoint.active; }

  private async compile(source: AstraContextSource, sourceDigest: string): Promise<AstraContextResult> {
    if (!this.options.isCurrent(source.revision, sourceDigest)) return { status: 'blocked', code: 'stale-source' };
    let state = this.state();
    const previous = state.checkpoint.active;
    if (previous && (previous.sourceRevision > source.revision
      || (previous.sourceRevision === source.revision && previous.sourceDigest !== sourceDigest))) return { status: 'blocked', code: 'stale-source' };
    const budgetDigest = digest(astraJournalJson(json({ compiler: 'optional-recall-pressure-v2', limits: this.limits })));
    const attemptKey = digest(sourceDigest + astraJournalJson(json(this.tokenizer)) + budgetDigest);
    if (previous?.sourceDigest === sourceDigest && previous.budgetDigest === budgetDigest
      && astraJournalJson(json(previous.tokenizer)) === astraJournalJson(json(this.tokenizer))) {
      // A restarted engine may have a smaller capacity. Cached counts do not bypass it.
      if (this.fits(previous.tokenCount, previous.utf8Bytes)) return { status: 'ready', plan: previous };
    }
    const render = (omitted: Set<string>, rangeDigest?: string): string => astraJournalJson(json({
      schemaVersion: 'monarch.astra-v3-context-surface.internal.v1',
      executionId: source.executionId, sourceRevision: source.revision,
      mandatory: source.mandatory,
      data: [
        ...(rangeDigest ? [{ kind: 'compaction-summary', authorityEligible: false,
          text: `Optional context (${omitted.size} items) is omitted. This marker is not a semantic summary, evidence, or permission to retrieve additional data.`, sourceRangeDigest: rangeDigest }] : []),
        ...source.optional.filter(item => !omitted.has(item.ref)).map(item => ({ ...item, authorityEligible: false })),
      ],
    }));
    const original = render(new Set()), originalBytes = Buffer.byteLength(original);
    let beforeTokens: number;
    try { beforeTokens = await this.count(original); }
    catch (error) { tokenizerFailure('original', error); return { status: 'blocked', code: 'tokenizer-unavailable' }; }
    if (!this.options.isCurrent(source.revision, sourceDigest)) return { status: 'blocked', code: 'stale-source' };
    let surface = original, tokens = beforeTokens, omittedRefs: string[] = [];
    let compaction: AstraContextPlan['compaction'] = null;
    const hardPressure = !this.fits(beforeTokens, originalBytes);
    const softPressure = beforeTokens + this.limits.reservedOutputTokens >= this.limits.softTokens;
    if ((hardPressure || (softPressure && state.checkpoint.armed))
      && (state.checkpoint.attemptKey !== attemptKey || state.checkpoint.pending?.attemptKey === attemptKey)) {
      const narrative = source.optional.filter(item => item.kind === 'narrative');
      let eligible = narrative.slice(0, Math.max(0, narrative.length - this.limits.recentNarrativeItems));
      const recalled = source.optional.filter(item => item.kind === 'recalled-memory');
      if (eligible.length || hardPressure && recalled.length) {
        // Durable bracket start never replaces the active projection. A crash/failure
        // between this and activation leaves the old active plan intact.
        if (state.checkpoint.pending?.attemptKey !== attemptKey) state = this.commit(state.revision,
          { ...state.checkpoint, attemptKey, pending: { sourceDigest, sourceRevision: source.revision, attemptKey } }, 'compaction.prepared');
        omittedRefs = eligible.map(item => item.ref);
        let sourceRangeDigest = digest(astraJournalJson(json(eligible)));
        let compacted = eligible.length ? render(new Set(omittedRefs), sourceRangeDigest) : original;
        let compactedTokens: number;
        try {
          compactedTokens = eligible.length ? await this.count(compacted) : beforeTokens;
          if (!this.options.isCurrent(source.revision, sourceDigest)) return { status: 'blocked', code: 'stale-source' };
          // Optional recall cannot make an otherwise usable mandatory + recent
          // working context fail. One bounded extra count, never a model call.
          if (!this.fits(compactedTokens, Buffer.byteLength(compacted)) && recalled.length) {
            eligible = [...eligible, ...recalled];
            omittedRefs = eligible.map(item => item.ref);
            sourceRangeDigest = digest(astraJournalJson(json(eligible)));
            compacted = render(new Set(omittedRefs), sourceRangeDigest);
            compactedTokens = await this.count(compacted);
          }
        }
        catch (error) {
          tokenizerFailure('compacted', error);
          this.commit(state.revision, { ...state.checkpoint, pending: null, armed: false }, 'compaction.tokenizer-failed');
          return { status: 'blocked', code: 'tokenizer-unavailable' };
        }
        if (!this.options.isCurrent(source.revision, sourceDigest)) return { status: 'blocked', code: 'stale-source' };
        const savedBytes = originalBytes - Buffer.byteLength(compacted);
        if ((beforeTokens - compactedTokens >= this.limits.minimumSavedTokens
          || hardPressure && this.fits(compactedTokens, Buffer.byteLength(compacted))) && savedBytes > 0) {
          surface = compacted; tokens = compactedTokens;
          compaction = { authorityEligible: false, sourceRangeDigest, beforeTokens, afterTokens: tokens, savedBytes };
        } else {
          omittedRefs = [];
          this.commit(state.revision, { ...state.checkpoint, pending: null, attemptKey, armed: false }, 'compaction.rejected');
          state = this.state();
          if (hardPressure) return { status: 'blocked', code: 'compaction-failed' };
        }
      }
    }
    const utf8Bytes = Buffer.byteLength(surface);
    if (!this.fits(tokens, utf8Bytes)) {
      if (state.checkpoint.pending) this.commit(state.revision,
        { ...state.checkpoint, pending: null, attemptKey, armed: false }, 'compaction.capacity-insufficient');
      return { status: 'blocked', code: 'context-capacity-insufficient' };
    }
    const plan: AstraContextPlan = { executionId: source.executionId, sourceRevision: source.revision, sourceDigest, surfaceDigest: digest(surface), surface,
      tokenCount: tokens, utf8Bytes, tokenizer: this.tokenizer, budgetDigest, omittedRefs, compaction };
    if (!this.options.isCurrent(source.revision, sourceDigest)) return { status: 'blocked', code: 'stale-source' };
    const armed = tokens + this.limits.reservedOutputTokens < this.limits.rearmTokens ? true
      : compaction || state.checkpoint.attemptKey === attemptKey ? false : state.checkpoint.armed;
    this.commit(state.revision, { schemaVersion: 'monarch.astra-v3-context.internal.v1', active: plan, pending: null,
      attemptKey: compaction ? attemptKey : state.checkpoint.attemptKey, armed }, 'context.activated');
    return { status: 'ready', plan: structuredClone(plan) };
  }

  private validate(source: AstraContextSource): void {
    // Memory is an already-admitted optional projection; this compiler does not
    // retrieve/promote/persist long-term facts or infer cross-chat consent.
    validateAstraContextSource(source, this.options.executionId);
  }
  private fits(tokens: number, bytes: number): boolean {
    return tokens + this.limits.reservedOutputTokens <= this.limits.hardTokens && bytes <= this.limits.hardBytes;
  }
  private async count(surface: string): Promise<number> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort('tokenizer-deadline'); reject(new Error('tokenizer-deadline'));
      }, this.limits.tokenizerTimeoutMs); });
      const tokens = await Promise.race([this.options.countTokens(surface, controller.signal), timeout]);
      check(Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 10_000_000, 'token-count');
      return tokens;
    } finally { if (timer) clearTimeout(timer); }
  }
  private state(): { revision: number; checkpoint: ContextCheckpoint } {
    const snapshot = this.options.journal.read(this.streamId());
    if (!snapshot) return { revision: 0, checkpoint: { schemaVersion: 'monarch.astra-v3-context.internal.v1',
      armed: true, attemptKey: null, pending: null, active: null } };
    const checkpoint = snapshot.checkpoint as unknown as ContextCheckpoint;
    check(checkpoint.schemaVersion === 'monarch.astra-v3-context.internal.v1', 'checkpoint');
    if (checkpoint.active) check(checkpoint.active.executionId === this.options.executionId
      && digest(checkpoint.active.surface) === checkpoint.active.surfaceDigest
      && Buffer.byteLength(checkpoint.active.surface) === checkpoint.active.utf8Bytes, 'projection-integrity');
    return { revision: snapshot.revision, checkpoint };
  }
  private commit(revision: number, checkpoint: ContextCheckpoint, type: string): { revision: number; checkpoint: ContextCheckpoint } {
    this.options.journal.append({ streamId: this.streamId(), requestId: 'context_' + revision, expectedRevision: revision,
      checkpoint: json(checkpoint), events: [{ type, sourceDigest: checkpoint.pending?.sourceDigest ?? checkpoint.active?.sourceDigest ?? null }] });
    return this.state();
  }
  private streamId(): string { return 'context_' + this.options.executionId; }
}

/** Which counter failure became `tokenizer-unavailable`: an error code, never
 * surface text. Every kind (oversized surface, prepare budget, deadline, stale
 * source) otherwise reached the task as the same opaque code. */
function tokenizerFailure(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ diagnostic: 'astra-context-tokenizer-failed', stage,
    code: message.replace(/[^A-Za-z0-9:_-]/gu, '?').slice(0, 120) }));
}

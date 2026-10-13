import { compileAstraMemoryRecall, validateAstraMemoryQuery, type AstraMemoryRecallSnapshot } from './memory-recall';

export interface AstraRecallPolicy { enabled: boolean; revision: string }
export interface AstraRecallRequest {
  source: 'desktop' | 'api' | 'telegram';
  privacy: 'persistent' | 'incognito' | 'safe';
  destination: 'local' | 'max';
  operation: 'analyze' | 'draft' | 'observe' | 'literal-create';
  query: string;
}
export type AstraRecallAdmission =
  | { status: 'omitted'; reason: 'scope-excluded' | 'disabled' | 'unavailable' | 'cancelled' | 'stale-policy' }
  | { status: 'prepared'; snapshot: AstraMemoryRecallSnapshot; policyRevision: string; admitBefore: number };

/** Host-only preparation. No store, write-back, provider selection or default
 * activation. The owner must atomically retain a prepared snapshot with the
 * task, and fence every subsequent model dispatch against its current policy.
 * A prepared value expires before admission; it is not a renewable permission. */
export class AstraMemoryRecallAdmission {
  constructor(private readonly ports: {
    policy: () => AstraRecallPolicy;
    retrieve: (query: string, signal: AbortSignal) => Promise<unknown>;
    timeoutMs?: number;
    now?: () => number;
  }) {
    if (!Number.isSafeInteger(ports.timeoutMs ?? 500) || (ports.timeoutMs ?? 500) < 1
      || (ports.timeoutMs ?? 500) > 2_000) throw Error('astra-recall-admission:timeout');
  }

  async prepare(request: AstraRecallRequest, signal?: AbortSignal): Promise<AstraRecallAdmission> {
    if (!eligible(request)) return { status: 'omitted', reason: 'scope-excluded' };
    if (signal?.aborted) return { status: 'omitted', reason: 'cancelled' };
    const policy = this.policy();
    if (!policy?.enabled) return { status: 'omitted', reason: 'disabled' };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      // Deadline also covers a faulty transport that ignores AbortSignal. No
      // unhandled late rejection and no late result can enter the task context.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Error('recall-timeout')); }, this.ports.timeoutMs ?? 500);
      });
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(Error('recall-aborted')), { once: true });
      });
      const raw = await Promise.race([this.ports.retrieve(request.query, controller.signal), timeout, cancelled]);
      const snapshot = compileAstraMemoryRecall(raw, request.query);
      if (!this.samePolicy(policy)) return { status: 'omitted', reason: 'stale-policy' };
      if (signal?.aborted) return { status: 'omitted', reason: 'cancelled' };
      return { status: 'prepared', snapshot, policyRevision: policy.revision, admitBefore: this.now() + 1_000 };
    } catch {
      return { status: 'omitted', reason: signal?.aborted ? 'cancelled' : 'unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }

  /** Mandatory immediately before the owner's synchronous admission commit. */
  isPolicyCurrent(revision: string): boolean {
    return typeof revision === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(revision)
      && this.samePolicy({ enabled: true, revision });
  }

  isAdmissible(request: AstraRecallRequest, admission: AstraRecallAdmission): boolean {
    if (!eligible(request) || admission.status !== 'prepared' || !Number.isSafeInteger(admission.admitBefore)
      || this.now() >= admission.admitBefore || admission.admitBefore > this.now() + 1_000
      || !this.samePolicy({ enabled: true, revision: admission.policyRevision })) return false;
    try { validateAstraMemoryQuery(admission.snapshot, request.query); return true; } catch { return false; }
  }

  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private policy(): AstraRecallPolicy | null {
    try {
      const value = this.ports.policy();
      return value && typeof value.enabled === 'boolean' && typeof value.revision === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value.revision) ? { ...value } : null;
    } catch { return null; }
  }
  private samePolicy(expected: AstraRecallPolicy): boolean {
    const current = this.policy();
    return Boolean(current?.enabled && current.revision === expected.revision);
  }
}

function eligible(request: AstraRecallRequest): boolean {
  return request?.source === 'desktop' && request.privacy === 'persistent' && request.destination === 'local'
    && ['analyze', 'draft'].includes(request.operation) && typeof request.query === 'string'
    && request.query.trim().length > 0 && Buffer.byteLength(request.query) <= 8192;
}

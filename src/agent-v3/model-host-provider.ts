import { createHash } from 'node:crypto';

export interface AstraModelHostBinding {
  endpoint: string; bearerToken: string; hostGeneration: string; hostPid?: number;
  modelDigest: string; modelDigests?: Readonly<Record<string, string>>;
}
export interface AstraModelHostIdentity { hostGeneration: string; endpointDigest: string }
export function astraModelHostIdentity(binding: AstraModelHostBinding): AstraModelHostIdentity {
  return { hostGeneration: binding.hostGeneration, endpointDigest: 'sha256:' + createHash('sha256')
    .update(new URL(binding.endpoint).origin + '/internal/astra/v3/model-turns').digest('hex') };
}
function key(identity: AstraModelHostIdentity): string { return identity.endpointDigest + '/' + identity.hostGeneration; }
function validate(binding: AstraModelHostBinding): AstraModelHostBinding {
  const url = new URL(binding.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/'
    || url.username || url.password || url.search || url.hash
    || !/^[A-Za-z0-9_-]{1,96}$/.test(binding.hostGeneration)
    || !/^[\x21-\x7e]{1,4096}$/.test(binding.bearerToken)
    || !/^sha256:[a-f0-9]{64}$/.test(binding.modelDigest)
    || binding.hostPid !== undefined && (!Number.isSafeInteger(binding.hostPid) || binding.hostPid < 1)) {
    throw Error('astra-model-host:binding');
  }
  return structuredClone(binding);
}

/** Credentials stay in memory. An authenticated new descriptor is not an exit receipt. */
export class AstraModelHostProvider {
  private binding: AstraModelHostBinding;
  private refresh: Promise<AstraModelHostBinding> | undefined;
  private readonly bindings = new Map<string, AstraModelHostBinding>();
  constructor(initial: AstraModelHostBinding, private readonly options: {
    discover: () => Promise<AstraModelHostBinding>;
    exited: (binding: AstraModelHostBinding) => boolean;
  }) { this.binding = validate(initial); this.bindings.set(key(astraModelHostIdentity(initial)), this.binding); }
  current(): AstraModelHostBinding { return structuredClone(this.binding); }
  lookup(identity: AstraModelHostIdentity): AstraModelHostBinding | undefined {
    const binding = this.bindings.get(key(identity)); return binding && structuredClone(binding);
  }
  isQuiescent(identity: AstraModelHostIdentity): boolean {
    const binding = this.bindings.get(key(identity));
    return !!binding && this.options.exited(structuredClone(binding));
  }
  async ensureFresh(_reason: string, signal?: AbortSignal): Promise<AstraModelHostBinding> {
    signal?.throwIfAborted();
    if (!this.refresh) {
      this.refresh = Promise.resolve().then(() => this.options.discover()).then(value => {
        const next = validate(value), id = key(astraModelHostIdentity(next)), prior = this.bindings.get(id);
        if (prior && (prior.hostPid !== next.hostPid || prior.bearerToken !== next.bearerToken))
          throw Error('astra-model-host:identity-conflict');
        if (!prior && this.bindings.size >= 256) throw Error('astra-model-host:history-budget');
        this.bindings.set(id, next); this.binding = next; return next;
      }).finally(() => { this.refresh = undefined; });
    }
    const pending = this.refresh;
    const result = signal ? await new Promise<AstraModelHostBinding>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    }) : await pending;
    signal?.throwIfAborted(); return structuredClone(result);
  }
  async waitForExit(identity: AstraModelHostIdentity, signal: AbortSignal): Promise<void> {
    while (!this.isQuiescent(identity)) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 25);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}

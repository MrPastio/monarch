import type {
  MonarchExecutionControl,
  MonarchExecutionRequest,
  MonarchExecutionResult,
  MonarchKernelContext,
  MonarchModule,
  MonarchModuleManifest,
} from '../../core';

export interface ServiceHostBinding {
  endpoint?: string | undefined;
  token?: string | undefined;
}

export interface ServiceHostTransport {
  readonly available: boolean;
  request<T>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

export interface LoopbackServiceHostOptions extends ServiceHostBinding {
  serviceId: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 75_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Shared fail-closed transport for a service broker owned by the Desktop host. */
export class LoopbackServiceHostTransport implements ServiceHostTransport {
  readonly #serviceId: string;
  readonly #endpoint: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;

  constructor(options: LoopbackServiceHostOptions) {
    this.#serviceId = validateServiceId(options.serviceId);
    this.#endpoint = String(options.endpoint || '');
    this.#token = String(options.token || '');
    this.#timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeout');
    this.#maxResponseBytes = positiveInteger(options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES, 'response-budget');
    if (Boolean(this.#endpoint) !== Boolean(this.#token)
      || this.#endpoint && (!validLoopbackEndpoint(this.#endpoint, this.#serviceId)
        || !/^[a-f0-9]{64}$/u.test(this.#token))) {
      throw Error(`${this.#serviceId}:host-binding`);
    }
  }

  get available(): boolean { return Boolean(this.#endpoint && this.#token); }

  async request<T>(operation: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!this.available) throw Error(`${this.#serviceId}:host-unavailable`);
    if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(operation)) throw Error(`${this.#serviceId}:host-operation`);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, input }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.body) throw Error(`${this.#serviceId}:host-response`);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.#maxResponseBytes) {
          await reader.cancel();
          throw Error(`${this.#serviceId}:host-budget`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result?: T; error?: string };
    const error = typeof payload.error === 'string' && validServiceError(payload.error, this.#serviceId)
      ? payload.error : `${this.#serviceId}:host-response`;
    if (!response.ok || payload.result === undefined) throw Error(error);
    return payload.result;
  }
}

export interface BrokeredServiceModuleOptions {
  manifest: MonarchModuleManifest;
  transport: ServiceHostTransport;
  operationByCapability: Readonly<Record<string, string>>;
  summarize(operation: string, output: Record<string, unknown>): string;
  failureSummary(code: string): string;
}

/** Shared typed capability adapter. It never routes from phrases or keywords. */
export class BrokeredServiceModule implements MonarchModule {
  readonly manifest: MonarchModuleManifest;
  readonly #transport: ServiceHostTransport;
  readonly #operationByCapability: Readonly<Record<string, string>>;
  readonly #summarize: BrokeredServiceModuleOptions['summarize'];
  readonly #failureSummary: BrokeredServiceModuleOptions['failureSummary'];

  constructor(options: BrokeredServiceModuleOptions) {
    this.manifest = options.manifest;
    this.#transport = options.transport;
    this.#operationByCapability = Object.freeze({ ...options.operationByCapability });
    this.#summarize = options.summarize;
    this.#failureSummary = options.failureSummary;
    validateServiceId(this.manifest.id);
    const declared = new Set(this.manifest.capabilities.map(capability => capability.id));
    if (declared.size !== Object.keys(this.#operationByCapability).length
      || Object.keys(this.#operationByCapability).some(capabilityId => !declared.has(capabilityId))) {
      throw Error(`${this.manifest.id}:capability-map`);
    }
  }

  async activate(context: MonarchKernelContext): Promise<void> {
    await context.emit(`${this.manifest.id}.activated`, this.manifest.id,
      { brokerAvailable: this.#transport.available });
  }

  async health(): Promise<MonarchExecutionResult> {
    return {
      ok: true,
      summary: this.#transport.available
        ? `${this.manifest.name} credential broker is available.`
        : `${this.manifest.name} is not connected.`,
      output: { brokerAvailable: this.#transport.available },
    };
  }

  async executeCapability(
    request: MonarchExecutionRequest,
    _context?: MonarchKernelContext,
    control?: MonarchExecutionControl,
  ): Promise<MonarchExecutionResult> {
    const operation = this.#operationByCapability[request.capabilityId];
    if (!operation) return {
      ok: false,
      summary: `Unsupported ${this.manifest.name} capability.`,
      error: 'unsupported-capability',
    };
    try {
      const output = await this.#transport.request<Record<string, unknown>>(
        operation,
        request.input as Record<string, unknown>,
        control?.signal,
      );
      return { ok: true, summary: this.#summarize(operation, output), output };
    } catch (error) {
      if (control?.signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : '';
      const code = validServiceError(message, this.manifest.id)
        ? message : `${this.manifest.id}:request-failed`;
      return { ok: false, summary: this.#failureSummary(code), error: code };
    }
  }
}

function validateServiceId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(value)) throw Error('service-host:id');
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw Error(`service-host:${field}`);
  return resolved;
}

function validLoopbackEndpoint(value: string, serviceId: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === 'http:'
      && url.hostname === '127.0.0.1'
      && Number.isInteger(port) && port >= 1 && port <= 65_535
      && url.pathname === `/${serviceId}`
      && url.username === '' && url.password === ''
      && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

function validServiceError(value: string, serviceId: string): boolean {
  return value.startsWith(`${serviceId}:`) && /^[a-z][a-z0-9-]*:[a-z0-9-]+$/u.test(value);
}

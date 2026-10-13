// Consume the bootstrap credential during module initialization, before any
// runtime modules launch their integrations. Children must not inherit it.
const bootstrapBinding = {
  MONARCH_TELEGRAM_HOST_ENDPOINT: process.env.MONARCH_TELEGRAM_HOST_ENDPOINT,
  MONARCH_TELEGRAM_HOST_TOKEN: process.env.MONARCH_TELEGRAM_HOST_TOKEN,
};
delete process.env.MONARCH_TELEGRAM_HOST_TOKEN;

export class TelegramSecretTransport {
  readonly endpoint: string;
  readonly #bearer: string;
  constructor(environment = bootstrapBinding) {
    this.endpoint = environment.MONARCH_TELEGRAM_HOST_ENDPOINT ?? '';
    this.#bearer = environment.MONARCH_TELEGRAM_HOST_TOKEN ?? '';
    if (this.endpoint && (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/telegram$/u.test(this.endpoint) || !/^[a-f0-9]{64}$/u.test(this.#bearer))) throw Error('telegram:host-binding');
  }
  get available(): boolean { return Boolean(this.endpoint && this.#bearer); }
  async request<T>(input: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (!this.available) throw Error('telegram:host-unavailable');
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', headers: {
      Authorization: `Bearer ${this.#bearer}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(75_000)]) : AbortSignal.timeout(75_000) });
    if (!response.body) throw Error('telegram:host-request');
    const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > 29 * 1024 * 1024) { await reader.cancel(); throw Error('telegram:host-budget'); } chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { result: T; error?: string };
    if (!response.ok) throw Error(/^telegram:api-\d{3}$/u.test(payload.error ?? '') ? payload.error : 'telegram:host-request');
    return payload.result;
  }
}

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

export class MonarchSecretBridge {
  constructor({ resolveSecret, now = () => Date.now(), randomBytesFactory = randomBytes }) {
    if (typeof resolveSecret !== 'function') throw new TypeError('resolveSecret is required.');
    this.resolveSecret = resolveSecret;
    this.now = now;
    this.randomBytesFactory = randomBytesFactory;
    this.capabilities = new Map();
    this.server = null;
    this.pipeName = null;
  }

  issueCapability({ secretId, consumerId, ttlMs = 30_000 }) {
    if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/i.test(String(secretId || ''))) {
      throw new TypeError('Invalid secret identifier.');
    }
    if (!/^[a-z0-9][a-z0-9._:-]{1,127}$/i.test(String(consumerId || ''))) {
      throw new TypeError('Invalid secret consumer.');
    }
    const token = this.randomBytesFactory(32).toString('base64url');
    this.capabilities.set(token, {
      secretId,
      consumerId,
      expiresAt: this.now() + Math.min(Math.max(ttlMs, 1_000), 60_000),
    });
    return Object.freeze({ token, pipeName: this.pipeName, expiresAt: this.now() + ttlMs });
  }

  async start() {
    if (process.platform !== 'win32') throw new Error('Monarch SecretBridge is Windows-only.');
    if (this.server) return this.pipeName;
    this.pipeName = `\\\\.\\pipe\\Monarch.SecretBridge.${process.pid}.${this.randomBytesFactory(16).toString('hex')}`;
    this.server = createServer((socket) => {
      socket.setEncoding('utf8');
      let payload = '';
      socket.on('data', async (chunk) => {
        payload += chunk;
        if (payload.length > 4096) {
          socket.destroy();
          return;
        }
        if (!payload.includes('\n')) return;
        try {
          const request = JSON.parse(payload.slice(0, payload.indexOf('\n')));
          const capability = this.capabilities.get(request.capability);
          this.capabilities.delete(request.capability);
          if (!capability || capability.expiresAt < this.now()) throw new Error('capability-denied');
          const value = await this.resolveSecret({
            secretId: capability.secretId,
            consumerId: capability.consumerId,
          });
          socket.end(`${JSON.stringify({ ok: true, secret: value })}\n`);
        } catch {
          socket.end(`${JSON.stringify({ ok: false, error: 'capability-denied' })}\n`);
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ path: this.pipeName, readableAll: false, writableAll: false }, resolve);
    });
    return this.pipeName;
  }

  async stop() {
    this.capabilities.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
    this.pipeName = null;
  }
}

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the real utility message loop with a synthetic vault and ports.
// No Electron process, filesystem vault, keys or user state are involved.
const source = readFileSync(new URL('../../desktop/safe/runtime.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');

class FixtureError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function fixture() {
  const parent = new EventEmitter() as EventEmitter & { postMessage: (message: any) => void };
  const port = new EventEmitter() as EventEmitter & { postMessage: (message: any) => void; start: () => void; close: () => void };
  const parentResponses: any[] = [];
  const responses: any[] = [];
  parent.postMessage = (message) => parentResponses.push(message);
  port.postMessage = (message) => responses.push(message);
  port.start = () => {};
  port.close = () => {};
  let unlocked = true;
  let releaseRead: (() => void) | undefined;
  let readStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const data = new Uint8Array([11, 22, 33]);
  const calls: string[] = [];
  class FixtureVault {
    initialize() { return Promise.resolve(); }
    status() { return { unlocked }; }
    lock() { calls.push('lock'); unlocked = false; return this.status(); }
    list() { calls.push('list'); if (!unlocked) throw new FixtureError('vault-locked', 'Locked'); return { files: [] }; }
    unlockWithPin() { calls.push('unlock'); unlocked = true; return Promise.resolve(this.status()); }
    async readFile() {
      calls.push('read'); readStarted!();
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return { bytes: data };
    }
  }
  runInNewContext(source, {
    process: { env: { MONARCH_SAFE_ROOT: 'synthetic-only' }, parentPort: parent, on: () => {} },
    SafeVault: FixtureVault, SafeVaultError: FixtureError,
    verifySafeCapabilityToken: () => false, Buffer, Uint8Array, console,
  });
  parent.emit('message', { data: { type: 'connect', capabilityKey: new Uint8Array(32) }, ports: [port] });
  const request = (id: string, action: string, payload = {}) => port.emit('message', { data: { id, action, payload } });
  const service = (id: string, action: string) => parent.emit('message', { data: { type: 'service-request', id, action } });
  const flush = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
  return { request, service, flush, calls, responses, parentResponses, started, data, release: () => releaseRead!() };
}

describe('Safe utility lock queue on synthetic ports', () => {
  it('invalidates an in-flight read and queued unlock when a host lock arrives', async () => {
    const f = fixture();
    await f.flush();
    f.request('reading', 'readFile');
    await f.started;
    f.request('queued-unlock', 'unlockPin', { pin: 'synthetic' });
    f.service('host-lock', 'chatLock');
    f.release();
    await f.flush();
    for (const id of ['reading', 'queued-unlock']) {
      expect(f.responses.find((r) => r.id === id)).toMatchObject({ ok: false, error: { code: 'vault-locked' } });
    }
    expect([...f.data]).toEqual([0, 0, 0]);
    expect(f.calls).toEqual(['read', 'lock']);
    expect(f.parentResponses.find((r) => r.id === 'host-lock')).toMatchObject({ ok: true, result: { unlocked: false } });
    f.request('fresh-unlock', 'unlockPin', { pin: 'synthetic' });
    await f.flush();
    expect(f.responses.find((r) => r.id === 'fresh-unlock')).toMatchObject({ ok: true, result: { unlocked: true } });
  });

  it('bounds the pending queue but still admits the host lock', async () => {
    const f = fixture();
    await f.flush();
    f.request('reading', 'readFile');
    await f.started;
    for (let i = 0; i < 40; i++) f.request(`list-${i}`, 'list');
    const rejected = f.responses.filter((r) => r.error?.code === 'safe-runtime-busy');
    expect(rejected).toHaveLength(9); // Active read counts toward the cap of 32.
    f.service('host-lock', 'chatLock');
    f.release();
    await f.flush();
    expect(f.calls).toEqual(['read', 'lock']);
    expect(f.parentResponses.find((r) => r.id === 'host-lock')).toMatchObject({ ok: true, result: { unlocked: false } });
    expect(f.responses.filter((r) => r.error?.code === 'vault-locked')).toHaveLength(32);
  });

  it('holds new renderer requests until all pending host locks complete', async () => {
    const f = fixture();
    await f.flush();
    f.request('reading', 'readFile');
    await f.started;
    f.service('lock-1', 'chatLock');
    f.service('lock-2', 'chatLock');
    f.request('too-early-unlock', 'unlockPin', { pin: 'synthetic' });
    f.release();
    await f.flush();
    // This request runs after both lock barriers and may authenticate afresh.
    expect(f.calls).toEqual(['read', 'lock', 'lock', 'unlock']);
    expect(f.parentResponses.filter((r) => r.type === 'service-response')).toHaveLength(2);
    expect(f.responses.find((r) => r.id === 'too-early-unlock')).toMatchObject({ ok: true, result: { unlocked: true } });
  });
});

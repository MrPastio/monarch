import { expect, it } from 'vitest';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { respondWithRequestError, streamFileToResponse } from '../../src/app/http-server';

it('cuts the response instead of crashing the server when a file cannot be read after headers', async () => {
  const missing = path.join(tmpdir(), `monarch-missing-${process.pid}-${Date.now()}.png`);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '10' });
    streamFileToResponse(missing, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const outcome = await new Promise<string>((resolve) => {
      get({ host: '127.0.0.1', port, path: '/asset.png' }, (response) => {
        response.on('data', () => undefined);
        response.on('end', () => resolve('ended'));
        response.on('error', () => resolve('cut'));
        response.on('aborted', () => resolve('cut'));
      }).on('error', () => resolve('cut'));
    });
    expect(outcome).toBe('cut');
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('cuts a started reply on a late handler error instead of throwing from the error path', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: run\n\n');
    expect(() => respondWithRequestError(request, response, new Error('late failure'))).not.toThrow();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const outcome = await new Promise<string>((resolve) => {
      get({ host: '127.0.0.1', port, path: '/api/coder/runs/x/stream' }, (response) => {
        response.on('data', () => undefined);
        response.on('end', () => resolve('ended'));
        response.on('error', () => resolve('cut'));
        response.on('aborted', () => resolve('cut'));
      }).on('error', () => resolve('cut'));
    });
    expect(outcome).toBe('cut');
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('serves the app document with a strict CSP that hashes its own inline scripts', async () => {
  const { createHash } = await import('node:crypto');
  const { documentSecurityHeaders } = await import('../../src/app/http-server');
  const inline = "document.documentElement.dataset.theme = 'light';";
  const headers = documentSecurityHeaders(`<head><script>${inline}</script><script type="module" src="/app.js"></script><script data-src="x">${inline}2</script></head>`);
  const hash = createHash('sha256').update(inline, 'utf8').digest('base64');
  expect(headers['Content-Security-Policy']).toContain(`script-src 'self' 'sha256-${hash}'`);
  // An inline script with a data-src attribute is still inline and hashed.
  expect(headers['Content-Security-Policy']).toContain(`'sha256-${createHash('sha256').update(inline + '2', 'utf8').digest('base64')}'`);
  expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
  expect(headers['Content-Security-Policy']).toContain("connect-src 'self'");
  expect(headers['Content-Security-Policy']).not.toContain('unsafe-eval');
  expect(headers['X-Content-Type-Options']).toBe('nosniff');
});

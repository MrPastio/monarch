import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Electron main-process module without type declarations.
import { installMainDiagnosticsMirror } from '../../desktop/electron/main-diagnostics-log.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function fakeStream() {
  const written: string[] = [];
  return { written, write(chunk: string | Uint8Array) { written.push(String(chunk)); return true; } };
}

describe('main-process diagnostics mirror', () => {
  it('keeps structured diagnostics, split across writes, and nothing else', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-main-diag-')); roots.push(root);
    const filePath = path.join(root, 'logs', 'main-diagnostics.jsonl');
    const stream = fakeStream();
    const mirror = installMainDiagnosticsMirror({ filePath, stream });
    stream.write('{"diagnostic":"astra-max-cloud-http","provider":"openai",');
    stream.write('"status":400,"errorParam":"temperature"}\nplain output that is not a diagnostic\n');
    stream.write(Buffer.from('{"diagnostic":"second"}\n'));
    await mirror.flush();
    mirror.uninstall();
    expect(stream.written.join('')).toContain('plain output');
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.entry.diagnostic)).toEqual(['astra-max-cloud-http', 'second']);
    expect(lines[0].entry).toMatchObject({ status: 400, errorParam: 'temperature' });
  });

  it('rotates once at the size limit instead of growing without bound', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'monarch-main-diag-')); roots.push(root);
    const filePath = path.join(root, 'main-diagnostics.jsonl');
    await writeFile(filePath, 'x'.repeat(900));
    const stream = fakeStream();
    const mirror = installMainDiagnosticsMirror({ filePath, maxBytes: 920, stream });
    stream.write('{"diagnostic":"after-rotation"}\n');
    await mirror.flush();
    expect(await readFile(filePath + '.1', 'utf8')).toBe('x'.repeat(900));
    expect(await readFile(filePath, 'utf8')).toContain('after-rotation');
  });
});

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const verifier = path.resolve('scripts/verify-relative-import-graph.mjs');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('packaged relative import graph', () => {
  it('accepts the complete renderer and Electron module graphs', () => {
    expect(() => execFileSync(process.execPath, [
      verifier,
      path.resolve('src/ui/public'),
      path.resolve('desktop/electron'),
    ], { stdio: 'pipe' })).not.toThrow();
  });

  it('fails closed when a relative module is absent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'monarch-import-graph-'));
    temporaryRoots.push(root);
    writeFileSync(path.join(root, 'entry.js'), "import './missing.js';\n", 'utf8');

    const result = spawnSync(process.execPath, [verifier, root], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('entry.js -> ./missing.js');
  });
});

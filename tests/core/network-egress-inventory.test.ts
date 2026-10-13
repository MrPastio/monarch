import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Stage 1 of the Monarch Security program: no file may open a network
 * connection unless it is in the reviewed inventory with its exact number of
 * call sites. A new fetch, socket or HTTP client — or a new file with one —
 * fails here until someone records where its data goes. */

type Entry = { calls: number; imports: boolean; scope: 'external' | 'loopback' | 'configured'; purpose: string; recipients?: string[] };
const inventory = JSON.parse(readFileSync(path.resolve('tests/fixtures/network-egress-inventory.json'), 'utf8')) as {
  files: Record<string, Entry>;
};

const TS_IMPORT = /from ['"](?:node:)?(?:https?|net|tls|undici|ws|dgram)['"]|require\(['"](?:node:)?(?:https?|net|tls|undici|ws|dgram)['"]\)/;
const PY_IMPORT = /^\s*(?:import|from)\s+(?:httpx|requests|urllib\.request|socket|ddgs|aiohttp|huggingface_hub|websockets)\b/m;
const TS_CALL = /\b(?:fetch|fetchImpl|undiciFetch|fetchFn|fetcher|safeFetch)\s*\(|\bhttps?\.(?:request|get)\s*\(|\b(?:net|tls)\.(?:connect|createConnection)\s*\(|\bnew WebSocket\s*\(|\bshell\.openExternal\s*\(|\(this\.options\.fetch \?\? fetch\)\s*\(/g;

function scan(): Record<string, { calls: number; imports: boolean }> {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard',
    'src', 'desktop', 'oscar/backend/oscar_agent', 'security/src', 'shared'], { encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter(file => /\.(?:ts|mts|cts|js|mjs|cjs|py)$/.test(file))
    .filter(file => !file.startsWith('src/ui/public/'))
    .filter(file => !/\.(?:test|spec)\./.test(file));
  const found: Record<string, { calls: number; imports: boolean }> = {};
  for (const file of files) {
    let source: string;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    const python = file.endsWith('.py');
    const imports = python ? PY_IMPORT.test(source) : TS_IMPORT.test(source);
    const calls = python ? 0 : (source.match(TS_CALL) || []).length;
    if (imports || calls) found[file] = { calls, imports };
  }
  return found;
}

describe('network egress inventory', () => {
  const found = scan();

  it('records every file that can reach the network, with its exact call sites', () => {
    const unrecorded = Object.keys(found).filter(file => !inventory.files[file]);
    expect(unrecorded, 'new network code: add it to tests/fixtures/network-egress-inventory.json').toEqual([]);
    const changed = Object.entries(found)
      .filter(([file, actual]) => inventory.files[file]
        && (inventory.files[file]!.calls !== actual.calls || inventory.files[file]!.imports !== actual.imports))
      .map(([file, actual]) => `${file}: recorded ${JSON.stringify({ calls: inventory.files[file]!.calls, imports: inventory.files[file]!.imports })}, found ${JSON.stringify(actual)}`);
    expect(changed, 'network call sites changed: review and update the inventory').toEqual([]);
  });

  it('keeps no stale entries', () => {
    expect(Object.keys(inventory.files).filter(file => !found[file])).toEqual([]);
  });

  it('names a scope, a purpose and, for external traffic, the recipients', () => {
    for (const [file, entry] of Object.entries(inventory.files)) {
      expect(['external', 'loopback', 'configured'], file).toContain(entry.scope);
      expect(entry.purpose.length, file).toBeGreaterThan(3);
      if (entry.scope === 'external' && entry.calls > 0) expect(entry.recipients?.length, file).toBeGreaterThan(0);
    }
  });
});

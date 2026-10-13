import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findAgentContextSecretPath,
  normalizeAgentBudget,
  redactAgentContextValue,
} from '../../src/agent-protocol';

const root = process.cwd();
const sourceRoot = path.join(root, 'src');
const legacyAgentRoot = path.join(sourceRoot, 'agent');

describe('runtime-neutral Agent protocol boundary', () => {
  it('does not ship the retired Agent Runtime V2 source tree', async () => {
    const entries = await readdir(legacyAgentRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    expect(entries).toEqual([]);
  });

  it('keeps product TypeScript free of legacy src/agent imports', async () => {
    const violations: string[] = [];
    for (const file of await TypeScriptFiles(sourceRoot)) {
      const source = await readFile(file, 'utf8');
      for (const specifier of relativeModuleSpecifiers(source)) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (resolved === legacyAgentRoot || isWithin(legacyAgentRoot, resolved)) {
          violations.push(`${path.relative(root, file).replaceAll('\\', '/')}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('normalizes public V3 budgets without importing the archived runtime', () => {
    expect(normalizeAgentBudget({ maxSteps: 9_999, maxModelTurns: 0, maxComputeClass: 'heavy' })).toEqual({
      maxSteps: 512,
      maxModelTurns: 1,
      maxToolCalls: 48,
      maxWallTimeMs: 15 * 60 * 1_000,
      maxFailures: 6,
      maxConsecutiveNoProgress: 4,
      maxComputeClass: 'heavy',
    });
  });

  it('redacts and detects credentials through the runtime-neutral protocol utility', () => {
    const input = { nested: { accessToken: 'synthetic-github-token-never-expose' }, note: 'Bearer top-secret-token' };
    const redacted = redactAgentContextValue(input);
    expect(findAgentContextSecretPath(input, 'request')).toBe('request.nested.accessToken');
    expect(JSON.stringify(redacted.value)).not.toContain('never_expose');
    expect(JSON.stringify(redacted.value)).not.toContain('top-secret-token');
    expect(redacted.redactions.map((entry) => entry.reason)).toEqual(
      expect.arrayContaining(['secret-key', 'secret-pattern']),
    );
  });
});

async function TypeScriptFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await TypeScriptFiles(target));
    else if (entry.isFile() && target.endsWith('.ts')) output.push(target);
  }
  return output;
}

function relativeModuleSpecifiers(source: string): string[] {
  const output: string[] = [];
  const pattern = /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier?.startsWith('.')) output.push(specifier);
  }
  return output;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

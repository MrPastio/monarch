import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** A child process that cannot start emits 'error' instead of 'exit'. With no
 * listener that is an uncaught exception, and the server or the desktop main
 * process ends with it (found live for the Oscar Python backend and the native
 * cursor host). Every spawned child must have an 'error' listener in the same
 * file; a temporary listener inside a spawn-wait helper also counts only when
 * the variable gets a lasting one. */
function sources(root: string, extensions: string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) files.push(...sources(full, extensions));
    else if (extensions.includes(path.extname(entry))) files.push(full);
  }
  return files;
}

describe('spawned processes', () => {
  it('always have an error listener', () => {
    const missing: string[] = [];
    for (const file of [...sources(path.resolve('src'), ['.ts']), ...sources(path.resolve('desktop/electron'), ['.mjs'])]) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:(?:const|let)\s+)?\b(\w+)\s*=\s*(?:\w+\.)?(?:spawn|spawnProcess)\(/gu)) {
        const name = match[1]!;
        const listener = new RegExp(`\\b${name}\\.(?:on|once)\\(\\s*'error'`, 'u');
        if (!listener.test(text)) missing.push(`${path.relative(process.cwd(), file)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

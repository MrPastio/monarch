import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** A raw backspace once replaced \b in three regexes (an escaping slip while
 * editing through a shell) and silently changed what they matched. Source
 * files never need these control characters. */
function files(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|mts|mjs|js|css|html)$/u.test(entry)) out.push(full);
  }
  return out;
}

describe('source hygiene', () => {
  it('has no backspace, vertical-tab or form-feed characters in source files', () => {
    const offenders = [...files(path.resolve('src')), ...files(path.resolve('desktop/electron')), ...files(path.resolve('tests'))]
      .filter(file => /[\u0008\u000b\u000c]/u.test(readFileSync(file, 'utf8')))
      .map(file => path.relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });
});

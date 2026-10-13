import { describe, expect, it } from 'vitest';
import { parseCoderChanges } from '../../src/app/coder-agent-controller';

describe('Coder review changes', () => {
  it('pairs git status entries with their own patches and keeps untracked files patch-free', () => {
    const changes = parseCoderChanges([
      '## main...origin/main [ahead 1]',
      ' M src/app.ts',
      'R  old.ts -> new name.ts',
      '?? notes.md',
      ' D gone.ts',
    ].join('\n'), [
      'diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-a', '+b',
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
    ].join('\n'));
    expect(changes.branch).toBe('main');
    expect(changes.files.map(file => [file.path, file.state, Boolean(file.patch)])).toEqual([
      ['src/app.ts', 'modified', true], ['new name.ts', 'renamed', false], ['notes.md', 'untracked', false], ['gone.ts', 'deleted', true],
    ]);
    expect(changes.files[0]!.patch).toContain('+b');
    expect(changes.files[0]!.patch).not.toContain('gone.ts');
  });

  it('names the branch of a repository without commits', () => {
    expect(parseCoderChanges('## No commits yet on main\n?? a.txt', '').branch).toBe('main');
  });
});

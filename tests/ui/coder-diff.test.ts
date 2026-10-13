// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { coderDiffHunks, coderLineDiff, coderProposedContent, renderCoderDiff } from '../../src/ui/public/modules/coder-diff.js';

describe('Coder approval diff', () => {
  it('derives the proposed text the way the Coder module applies it', () => {
    expect(coderProposedContent('coder.files.write', { content: 'x' }, 'old')).toBe('x');
    expect(coderProposedContent('coder.files.patch', { replacements: [{ oldText: 'b', newText: '$&B' }] }, 'abc')).toBe('a$&Bc');
    expect(coderProposedContent('coder.files.patch', { replacements: [{ oldText: 'a', newText: 'z' }] }, 'aa')).toBeNull();
    expect(coderProposedContent('coder.files.delete', {}, 'a')).toBeNull();
  });

  it('marks added and removed lines with their numbers', () => {
    const rows = coderLineDiff('one\ntwo\nthree', 'one\n2\nthree\nfour')!;
    expect(rows.filter(row => row.type !== 'same')).toEqual([
      { type: 'del', text: 'two', oldNo: 2 },
      { type: 'add', text: '2', newNo: 2 },
      { type: 'add', text: 'four', newNo: 4 },
    ]);
    expect(coderLineDiff('', 'a')).toEqual([{ type: 'add', text: 'a', newNo: 1 }]);
  });

  it('keeps context around changes and renders a stat line', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l10', 'L10');
    const rows = coderLineDiff(before, after)!;
    expect(coderDiffHunks(rows)).toHaveLength(1);
    expect(coderDiffHunks(rows)[0]).toHaveLength(8);
    const node = renderCoderDiff('src/a.ts', rows);
    expect(node.querySelector('header small')?.textContent).toBe('+1 −1');
  });
});

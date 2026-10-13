import { describe, expect, it } from 'vitest';
import { boundedOutputPreview } from '../../src/agent-v3/agent-task-profile';

describe('bounded tool output preview for the model', () => {
  it('keeps sizes, counts and continuation fields when the content does not fit', () => {
    const output = { path: 'E:/Monarch/package.json', sizeBytes: 35_000, lineCount: 812, nextOffset: 30_000, truncated: true,
      content: '{"name":"monarch",' + '"x":1,'.repeat(6000) + '"dependencies":{}}' };
    const preview = boundedOutputPreview(output, 4096) as typeof output;
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(4096);
    expect(preview).toMatchObject({ sizeBytes: 35_000, lineCount: 812, nextOffset: 30_000, truncated: true, path: output.path });
    expect(preview.content.startsWith('{"name":"monarch",')).toBe(true);
    expect(preview.content).toContain('обрезано');
  });
  it('returns an output that already fits unchanged', () => {
    expect(boundedOutputPreview({ lineCount: 3, content: 'a\nb\nc' }, 4096)).toEqual({ lineCount: 3, content: 'a\nb\nc' });
  });
});

import { describe, expect, it } from 'vitest';
import { createLatestRequestOwner } from '../../src/ui/public/modules/latest-request-owner.js';

describe('latest request owner', () => {
  it('lets only the newest overlapping request commit', () => {
    const owner = createLatestRequestOwner();
    const slowOldRequest = owner.begin();
    const fastNewRequest = owner.begin();

    expect(owner.isCurrent(fastNewRequest)).toBe(true);
    expect(owner.isCurrent(slowOldRequest)).toBe(false);
  });

  it('rejects a slow old response after a faster replacement has committed', async () => {
    const owner = createLatestRequestOwner();
    const applied: string[] = [];
    let releaseSlow!: () => void;
    let releaseFast!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const fast = new Promise<void>((resolve) => { releaseFast = resolve; });
    const run = async (label: string, completion: Promise<void>) => {
      const token = owner.begin();
      await completion;
      if (owner.isCurrent(token)) applied.push(label);
    };

    const slowRequest = run('stale-old-list', slow);
    const fastRequest = run('fresh-list-after-create', fast);
    releaseFast();
    await fastRequest;
    releaseSlow();
    await slowRequest;

    expect(applied).toEqual(['fresh-list-after-create']);
  });

  it('invalidates an in-flight request before a state transition', () => {
    const owner = createLatestRequestOwner();
    const staleRequest = owner.begin();

    owner.invalidate();

    expect(owner.isCurrent(staleRequest)).toBe(false);
    expect(owner.isCurrent(owner.begin())).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects malformed request ownership token %s',
    (requestId) => {
      const owner = createLatestRequestOwner();
      owner.begin();

      expect(owner.isCurrent(requestId)).toBe(false);
    },
  );
});

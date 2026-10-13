import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPublicNetworkAddress } from '../../src/core/network-address-policy';
import { safeFetch } from '../../src/modules/custom-tools';

const fixture = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'network-address-policy.json'), 'utf8')) as {
  cases: Array<{ address: string; public: boolean }>;
};

describe('public network address policy', () => {
  it.each(fixture.cases)('$address → public=$public', ({ address, public: expected }) => {
    expect(isPublicNetworkAddress(address)).toBe(expected);
  });

  it('judges every textual form of an address the same', () => {
    for (const form of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '[::ffff:7f00:1]', '::FFFF:7F00:1']) {
      expect(isPublicNetworkAddress(form)).toBe(false);
    }
  });

  it('refuses a bracketed IPv4-mapped literal before any connection', async () => {
    await expect(safeFetch('http://[::ffff:7f00:1]:4317/api/system'))
      .rejects.toThrow('Local and private network fetch targets are blocked');
  });
});

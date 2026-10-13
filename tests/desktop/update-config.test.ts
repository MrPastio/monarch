import { describe, expect, it } from 'vitest';
import {
  MONARCH_UPDATE_SITES_ORIGIN,
  MONARCH_UPDATE_VERCEL_ORIGIN,
  createMonarchUpdateEndpoints,
} from '../../desktop/electron/update-config.mjs';

describe('Monarch update endpoints', () => {
  it('checks canonical GitHub metadata, the official Sites endpoint and the Vercel site by default', () => {
    expect(createMonarchUpdateEndpoints()).toEqual([
      expect.objectContaining({ id: 'github' }),
      {
        id: 'sites',
        manifestUrl: `${MONARCH_UPDATE_SITES_ORIGIN}/api/releases/stable/manifest.json`,
        signatureUrl: `${MONARCH_UPDATE_SITES_ORIGIN}/api/releases/stable/manifest.sig`,
      },
      {
        id: 'vercel',
        manifestUrl: `${MONARCH_UPDATE_VERCEL_ORIGIN}/api/releases/stable/manifest.json`,
        signatureUrl: `${MONARCH_UPDATE_VERCEL_ORIGIN}/api/releases/stable/manifest.sig`,
      },
    ]);
  });

  it('rejects an insecure or path-scoped Sites origin', () => {
    expect(() => createMonarchUpdateEndpoints({ sitesOrigin: 'http://example.test' })).toThrow();
    expect(() => createMonarchUpdateEndpoints({ sitesOrigin: 'https://example.test/path' })).toThrow();
    expect(() => createMonarchUpdateEndpoints({ vercelOrigin: 'http://example.test' })).toThrow();
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  encodeManifest,
  getExpiryStatus,
  prepareManifest,
  refreshManifest,
  signManifestBytes,
  validateChannelManifest,
  verifyManifestSignature,
} from '../../release/lib/channel-manifest.mjs';

const baseManifest = {
  schemaVersion: 1,
  sequence: 1,
  channel: 'stable',
  version: '0.1.5',
  publishedAt: '2026-07-20T12:00:00Z',
  expiresAt: '2026-10-18T12:00:00Z',
  minimumUpdaterVersion: '0.1.5',
  minimumLauncherVersion: '1.0.0',
  available: true,
  withdrawnReason: null,
  revokedVersions: [],
  releaseNotesUrl: 'https://github.com/MrPastio/monarch-releases/releases/tag/v0.1.5',
  compatibility: {
    runtimeVersion: 'runtime-2026.07.1',
    backendEnvironment: 'backend-0.1.5',
    dataSchemaVersion: 1,
    minimumReadableDataSchema: 1,
    maximumReadableDataSchema: 1,
    minimumModelCatalogSchema: 1,
    maximumModelCatalogSchema: 1,
  },
  asset: {
    url: 'https://github.com/MrPastio/monarch-releases/releases/download/v0.1.5/Monarch-Setup-0.1.5.exe',
    mirrors: [],
    size: 12,
    sha256: 'a'.repeat(64),
    fileName: 'Monarch-Setup-0.1.5.exe',
  },
  keyId: 'monarch-release-2026-01',
};

function keyPair() {
  return generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

describe('signed Monarch channel manifest', () => {
  it('accepts the four-component Monarch patch version used by public hotfixes', () => {
    const release = {
      ...baseManifest,
      version: '0.2.3.2',
      minimumUpdaterVersion: '0.2.3.2',
      releaseNotesUrl: 'https://github.com/MrPastio/monarch-releases/releases/tag/v0.2.3.2',
      asset: {
        ...baseManifest.asset,
        url: 'https://github.com/MrPastio/monarch-releases/releases/download/v0.2.3.2/Monarch-Setup-0.2.3.2.exe',
        fileName: 'Monarch-Setup-0.2.3.2.exe',
      },
    };
    expect(validateChannelManifest(release).version).toBe('0.2.3.2');
  });

  it('validates the safe unpublished bootstrap state', async () => {
    const bootstrap = JSON.parse(
      await readFile(path.join(process.cwd(), 'release/examples/stable-bootstrap.json'), 'utf8'),
    );
    expect(validateChannelManifest(bootstrap)).toEqual(bootstrap);
    expect(bootstrap.available).toBe(false);
    expect(bootstrap.asset).toBeNull();
    expect(bootstrap.sequence).toBe(0);
  });

  it('signs exact bytes and rejects even a whitespace-only byte change', () => {
    const { privateKey, publicKey } = keyPair();
    const bytes = encodeManifest(baseManifest);
    const signature = signManifestBytes(bytes, privateKey);
    expect(verifyManifestSignature(bytes, signature, publicKey)).toMatchObject({
      sequence: 1,
      version: '0.1.5',
    });

    const changedBytes = Buffer.from(bytes.toString('utf8').replace('  "sequence"', '   "sequence"'));
    expect(() => verifyManifestSignature(changedBytes, signature, publicKey)).toThrow(
      'signature verification failed',
    );
  });

  it('rejects an unavailable manifest that still carries an installer', () => {
    expect(() =>
      validateChannelManifest({
        ...baseManifest,
        available: false,
        withdrawnReason: 'Withdrawn',
      }),
    ).toThrow('asset must be null');
  });

  it('rejects mutable or mismatched installer paths', () => {
    expect(() =>
      validateChannelManifest({
        ...baseManifest,
        asset: {
          ...baseManifest.asset,
          url: 'https://example.com/latest/Monarch-Setup.exe',
        },
      }),
    ).toThrow('immutable MrPastio/monarch-releases release path');
  });

  it('prepares installer size and SHA-256 from the actual file', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'monarch-release-test-'));
    const installer = path.join(temp, 'Monarch-Setup-0.1.5.exe');
    await writeFile(installer, Buffer.from('installer bytes'));
    const { schemaVersion: _schema, sequence: _sequence, publishedAt: _published, expiresAt: _expires, ...spec } =
      baseManifest;
    const manifest = await prepareManifest({
      spec: {
        ...spec,
        asset: {
          url: baseManifest.asset.url,
          mirrors: [],
          fileName: baseManifest.asset.fileName,
        },
      },
      installerPath: installer,
      sequence: 7,
      publishedAt: '2026-07-20T12:00:00Z',
      expiresAt: '2026-10-18T12:00:00Z',
    });
    expect(manifest.sequence).toBe(7);
    expect(manifest.asset).toMatchObject({
      size: 15,
      sha256: 'e34210a6de4f653edf588301431c3d69a633638cbf587345cc50a7fed9f38f4c',
    });
  });

  it('refreshes metadata without changing the release asset', () => {
    const refreshed = refreshManifest(baseManifest, new Date('2026-09-20T00:00:00Z'));
    expect(refreshed.sequence).toBe(2);
    expect(refreshed.version).toBe(baseManifest.version);
    expect(refreshed.asset).toEqual(baseManifest.asset);
    expect(refreshed.publishedAt).toBe('2026-09-20T00:00:00Z');
    expect(refreshed.expiresAt).toBe('2026-12-19T00:00:00Z');
    expect(getExpiryStatus(refreshed, new Date('2026-12-06T00:00:00Z'))).toMatchObject({
      refreshDue: true,
      urgent: true,
      expired: false,
    });
  });
});

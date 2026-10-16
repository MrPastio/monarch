import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MonarchUpdateService,
  compareSemver,
  createUpdateAvailableNotifier,
  startBackgroundUpdateChecks,
  verifySignedManifest,
} from '../../desktop/electron/update-service.mjs';

const NOW = Date.parse('2026-07-20T12:00:00.000Z');
const INSTALLER = Buffer.from('MZabcdef', 'ascii');
const INSTALLER_SHA256 = 'e0432b317fc402ed980f7a0d2a07c8121bc41ab5616e489200bbcb992959f00f';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEYS = { 'monarch-release-test': publicKey };

function manifest(sequence = 1, version = '0.2.0') {
  return {
    schemaVersion: 1,
    sequence,
    channel: 'stable',
    version,
    publishedAt: '2026-07-20T12:00:00.000Z',
    expiresAt: '2026-10-18T12:00:00.000Z',
    minimumUpdaterVersion: '0.1.5',
    minimumLauncherVersion: '1.0.0',
    available: true,
    withdrawnReason: null,
    revokedVersions: [],
    releaseNotesUrl: `https://monarch.example/updates/v${version}`,
    compatibility: {
      runtimeVersion: '2026.08.0',
      backendEnvironment: `backend-${version}`,
      dataSchemaVersion: 5,
      minimumReadableDataSchema: 4,
      maximumReadableDataSchema: 5,
      minimumModelCatalogSchema: 1,
      maximumModelCatalogSchema: 2,
    },
    asset: {
      url: `https://github.com/MrPastio/monarch-releases/releases/download/v${version}/Monarch-Setup-${version}.exe`,
      mirrors: [],
      size: INSTALLER.length,
      sha256: INSTALLER_SHA256,
      fileName: `Monarch-Setup-${version}.exe`,
    },
    keyId: 'monarch-release-test',
  };
}

function signed(input: ReturnType<typeof manifest>, formatting = 0) {
  const bytes = Buffer.from(JSON.stringify(input, null, formatting), 'utf8');
  const signature = sign(null, bytes, privateKey).toString('base64');
  return { bytes, signature: Buffer.from(`${signature}\n`, 'ascii') };
}

function endpoints() {
  return [
    {
      id: 'github',
      manifestUrl: 'https://github-metadata.example/manifest.json',
      signatureUrl: 'https://github-metadata.example/manifest.sig',
    },
    {
      id: 'sites',
      manifestUrl: 'https://sites-mirror.example/api/releases/stable/manifest.json',
      signatureUrl: 'https://sites-mirror.example/api/releases/stable/manifest.sig',
    },
  ];
}

async function tempRoot() {
  return mkdtemp(path.join(os.tmpdir(), 'monarch-update-test-'));
}

function metadataFetch(candidates: {
  github: ReturnType<typeof signed>;
  sites: ReturnType<typeof signed>;
}) {
  return async (urlValue: URL | string) => {
    const url = String(urlValue);
    const source = url.includes('sites-mirror') ? candidates.sites : candidates.github;
    return new Response(url.endsWith('.sig') ? source.signature : source.bytes, {
      status: 200,
      headers: { 'Content-Type': url.endsWith('.sig') ? 'text/plain' : 'application/json' },
    });
  };
}

describe('Monarch UpdateService signed manifest boundary', () => {
  it('orders Monarch patch revisions with three or four numeric components', () => {
    expect(compareSemver('0.2.3.2', '0.2.3.1')).toBe(1);
    expect(compareSemver('0.2.3', '0.2.3.0')).toBe(0);
    expect(compareSemver('0.2.3.1', '0.2.4')).toBe(-1);
  });

  it('accepts a signed four-component Monarch release', () => {
    const payload = signed(manifest(2, '0.2.3.2'), 2);
    expect(verifySignedManifest({
      bytes: payload.bytes,
      signatureBytes: payload.signature,
      publicKeys: PUBLIC_KEYS,
      now: NOW,
    }).version).toBe('0.2.3.2');
  });

  it('does not offer a release that is already installed', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(3, '0.2.3.4'));
    const service = new MonarchUpdateService({
      currentVersion: '0.2.3.4',
      updaterVersion: '0.2.3.4',
      endpoints: endpoints(),
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({ github: payload, sites: payload }),
    });

    await expect(service.check()).resolves.toMatchObject({
      state: 'up-to-date',
      currentVersion: '0.2.3.4',
      reason: 'latest-version-installed',
    });
  });

  it('does not query or install the stable channel from a development workspace', async () => {
    const root = await tempRoot();
    let fetchCalls = 0;
    const service = new MonarchUpdateService({
      currentVersion: '0.2.3.2',
      endpoints: endpoints(),
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('development must not contact the release channel');
      },
      installationPolicy: {
        mode: 'development',
        canInstall: false,
        reason: 'development-workspace',
      },
    });

    await expect(service.check()).resolves.toMatchObject({
      state: 'up-to-date',
      reason: 'development-workspace',
      release: null,
      installation: { mode: 'development', canInstall: false },
    });
    expect(fetchCalls).toBe(0);
  });

  it('blocks a stale ready installer when the current process is a development workspace', async () => {
    const root = await tempRoot();
    let installerLaunches = 0;
    const service = new MonarchUpdateService({
      currentVersion: '0.2.3.2',
      endpoints: endpoints(),
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      launchInstaller: async () => {
        installerLaunches += 1;
        return { launched: true };
      },
      installationPolicy: {
        mode: 'development',
        canInstall: false,
        reason: 'development-workspace',
      },
    });
    await service.initialize();
    service.state = 'ready-to-install';
    service.release = manifest(3, '0.2.3.4');
    service.readyInstallerPath = path.join(root, 'Monarch-Setup-0.2.3.4.exe');

    await expect(service.install()).resolves.toMatchObject({
      state: 'up-to-date',
      reason: 'development-workspace',
      release: null,
    });
    expect(installerLaunches).toBe(0);
  });

  it('verifies the exact manifest bytes and rejects reserialized or changed bytes', () => {
    const release = manifest();
    const payload = signed(release, 2);

    expect(verifySignedManifest({
      bytes: payload.bytes,
      signatureBytes: payload.signature,
      publicKeys: PUBLIC_KEYS,
      now: NOW,
    }).sequence).toBe(1);

    const reserialized = Buffer.from(JSON.stringify(release), 'utf8');
    expect(() => verifySignedManifest({
      bytes: reserialized,
      signatureBytes: payload.signature,
      publicKeys: PUBLIC_KEYS,
      now: NOW,
    })).toThrow(/signature is invalid/i);
  });

  it('selects the highest signed sequence and prefers GitHub for an equal sequence', async () => {
    const root = await tempRoot();
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: endpoints(),
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({
        github: signed(manifest(9)),
        sites: signed(manifest(10)),
      }),
    });

    const newerMirror = await service.check();
    expect(newerMirror.state).toBe('update-available');
    expect(newerMirror.release?.source).toBe('sites');
    expect(newerMirror.sources).toContainEqual({ id: 'github', status: 'stale-mirror', sequence: 9 });

    const equalRoot = await tempRoot();
    const equalService = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: endpoints(),
      publicKeys: PUBLIC_KEYS,
      updateRoot: equalRoot,
      now: () => NOW,
      fetchImpl: metadataFetch({
        github: signed(manifest(11)),
        sites: signed(manifest(11)),
      }),
    });
    expect((await equalService.check()).release?.source).toBe('github');
  });

  it('persists anti-replay sequence and fails closed when every source goes backwards', async () => {
    const root = await tempRoot();
    const first = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: endpoints(),
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({
        github: signed(manifest(12)),
        sites: signed(manifest(12)),
      }),
    });
    expect((await first.check()).state).toBe('update-available');

    const replayed = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: endpoints(),
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({
        github: signed(manifest(11)),
        sites: signed(manifest(10)),
      }),
    });
    const result = await replayed.check();
    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('manifest-replay');
  });

  it('rejects reuse of an accepted sequence with different signed bytes', async () => {
    const root = await tempRoot();
    const first = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({
        github: signed(manifest(13, '0.2.0')),
        sites: signed(manifest(13, '0.2.0')),
      }),
    });
    expect((await first.check()).state).toBe('update-available');

    const conflicting = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({
        github: signed(manifest(13, '0.2.1')),
        sites: signed(manifest(13, '0.2.1')),
      }),
    });
    const result = await conflicting.check();
    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('manifest-sequence-conflict');
  });

  it('fails closed with an empty production keyring', async () => {
    const root = await tempRoot();
    const payload = signed(manifest());
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: {},
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({ github: payload, sites: payload }),
    });

    const result = await service.check();
    expect(result.state).toBe('failed');
    expect(result.sources).toEqual([{ id: 'github', status: 'unknown-signing-key' }]);
  });

  it('accepts a signed unpublished bootstrap channel with sequence zero and no asset', async () => {
    const root = await tempRoot();
    const unpublished = {
      ...manifest(1, '0.1.5'),
      sequence: 0,
      publishedAt: '2026-07-20T12:00:00Z',
      expiresAt: '2026-10-18T12:00:00Z',
      available: false,
      withdrawnReason: 'Bootstrap has not been published.',
      asset: null,
    } as unknown as ReturnType<typeof manifest>;
    const payload = signed(unpublished);
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({ github: payload, sites: payload }),
    });

    const result = await service.check();
    expect(result.state).toBe('up-to-date');
    expect(result.release?.sequence).toBe(0);
    expect(result.release?.size).toBeNull();
  });
});

describe('Monarch UpdateService download boundary', () => {
  it('pauses, resumes only with matching ETag/Content-Range, then verifies size, MZ and SHA-256', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(20));
    let assetRequests = 0;
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      diskReserveBytes: 0,
      fetchImpl: async (urlValue: URL | string, init?: RequestInit) => {
        const url = String(urlValue);
        if (!url.includes('/releases/download/')) {
          return metadataFetch({ github: payload, sites: payload })(url);
        }
        assetRequests += 1;
        if (assetRequests === 1) {
          expect(init?.headers).toEqual({});
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(INSTALLER.subarray(0, 4));
              controller.enqueue(INSTALLER.subarray(4));
              controller.close();
            },
          }), {
            status: 200,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(INSTALLER.length),
              ETag: '"installer-v1"',
            },
          });
        }
        expect(init?.headers).toEqual({ Range: 'bytes=4-' });
        return new Response(INSTALLER.subarray(4), {
          status: 206,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': '4',
            'Content-Range': 'bytes 4-7/8',
            ETag: '"installer-v1"',
          },
        });
      },
    });
    let pauseIssued = false;
    service.on('state', (state) => {
      if (!pauseIssued && state.state === 'downloading' && state.progress?.downloaded === 4) {
        pauseIssued = true;
        service.pause();
      }
    });

    expect((await service.check()).state).toBe('update-available');
    const paused = await service.download();
    expect(paused.state).toBe('paused');
    expect(paused.progress?.downloaded).toBe(4);

    const ready = await service.resume();
    expect(ready.state).toBe('ready-to-install');
    expect(ready.progress?.percent).toBe(100);
    expect(JSON.stringify(ready)).not.toContain(root);
    expect(JSON.stringify(ready)).not.toContain('/releases/download/');
    expect(await readFile(path.join(root, 'Monarch-Setup-0.2.0.exe'))).toEqual(INSTALLER);
  });

  it('rejects HTML returned in place of the installer', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(21));
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      diskReserveBytes: 0,
      fetchImpl: async (urlValue: URL | string) => {
        const url = String(urlValue);
        if (!url.includes('/releases/download/')) {
          return metadataFetch({ github: payload, sites: payload })(url);
        }
        return new Response('<html />', {
          status: 200,
          headers: {
            'Content-Type': 'text/html',
            'Content-Length': '8',
          },
        });
      },
    });

    await service.check();
    const result = await service.download();
    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('invalid-installer-content-type');
  });

  it('rejects cross-origin asset redirects without writing a trusted installer', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(22));
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      diskReserveBytes: 0,
      fetchImpl: async (urlValue: URL | string) => {
        const url = String(urlValue);
        if (!url.includes('/releases/download/')) {
          return metadataFetch({ github: payload, sites: payload })(url);
        }
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://attacker.example/Monarch-Setup.exe' },
        });
      },
    });

    await service.check();
    const result = await service.download();
    expect(result.state).toBe('failed');
    expect(result.error?.code).toBe('unsafe-redirect');
  });

  it('keeps renderer intents argument-free and does not expose URL or path controls', async () => {
    const preload = await readFile(path.resolve('desktop/electron/preload.cjs'), 'utf8');
    const main = await readFile(path.resolve('desktop/electron/main.mjs'), 'utf8');

    for (const intent of ['check', 'download', 'install', 'pause', 'resume', 'cancel', 'discard']) {
      expect(preload).toContain(`${intent}: () => ipcRenderer.invoke('monarch:update-intent', '${intent}')`);
    }
    expect(preload).not.toMatch(/update[^:\n]*:\s*\([^)]*(url|path|command)/i);
    expect(main).toContain("ipcMain.handle('monarch:update-intent', async (event, intent) =>");
    expect(main).toContain('assertTrustedMainRenderer(event);');
  });

  it('keeps cancellation and discard separate', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(23));
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      diskReserveBytes: 0,
      fetchImpl: async (urlValue: URL | string) => {
        const url = String(urlValue);
        if (!url.includes('/releases/download/')) {
          return metadataFetch({ github: payload, sites: payload })(url);
        }
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(INSTALLER.subarray(0, 2));
            controller.enqueue(INSTALLER.subarray(2));
            controller.close();
          },
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(INSTALLER.length),
            ETag: '"v1"',
          },
        });
      },
    });
    await service.check();
    const partialPath = path.join(root, 'Monarch-Setup-0.2.0.exe.partial');
    let cancelIssued = false;
    service.on('state', (state) => {
      if (!cancelIssued && state.state === 'downloading' && state.progress?.downloaded === 2) {
        cancelIssued = true;
        service.cancel();
      }
    });

    expect((await service.download()).state).toBe('cancelled');
    expect(await readFile(partialPath)).toHaveLength(2);
    expect((await service.discard()).state).toBe('idle');
    await expect(readFile(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function assetResponse(chunks: Buffer[], { status = 200, headers = {} as Record<string, string>, failAfter = false } = {}) {
  const queue = [...chunks];
  return new Response(new ReadableStream({
    pull(controller) {
      const chunk = queue.shift();
      if (chunk) controller.enqueue(chunk);
      else if (failAfter) controller.error(new TypeError('terminated'));
      else controller.close();
    },
  }), {
    status,
    headers: { 'Content-Type': 'application/octet-stream', ETag: '"installer-v1"', ...headers },
  });
}

describe('Monarch UpdateService recovery', () => {
  it('continues an interrupted download from its checkpoint after a network failure', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(30));
    const ranges: unknown[] = [];
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      diskReserveBytes: 0,
      fetchImpl: async (urlValue: URL | string, init?: RequestInit) => {
        const url = String(urlValue);
        if (!url.includes('/releases/download/')) return metadataFetch({ github: payload, sites: payload })(url);
        ranges.push(init?.headers);
        if (ranges.length === 1) {
          return assetResponse([INSTALLER.subarray(0, 4)], {
            headers: { 'Content-Length': String(INSTALLER.length) },
            failAfter: true,
          });
        }
        return assetResponse([INSTALLER.subarray(4)], {
          status: 206,
          headers: { 'Content-Length': '4', 'Content-Range': 'bytes 4-7/8' },
        });
      },
    });

    await service.check();
    const failed = await service.download();
    expect(failed.state).toBe('failed');
    expect(failed.error?.code).toBe('network-error');

    expect((await service.check()).state).toBe('update-available');
    const ready = await service.download();
    expect(ready.error).toBeNull();
    expect(ready.state).toBe('ready-to-install');
    expect(ranges[1]).toEqual({ Range: 'bytes=4-' });
    expect(await readFile(path.join(root, 'Monarch-Setup-0.2.0.exe'))).toEqual(INSTALLER);
  });

  it('reuses a verified installer from an earlier session and replaces a corrupt one', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(31));
    let assetRequests = 0;
    const create = () => new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      diskReserveBytes: 0,
      fetchImpl: async (urlValue: URL | string) => {
        const url = String(urlValue);
        if (!url.includes('/releases/download/')) return metadataFetch({ github: payload, sites: payload })(url);
        assetRequests += 1;
        return assetResponse([INSTALLER], { headers: { 'Content-Length': String(INSTALLER.length) } });
      },
    });
    const installerPath = path.join(root, 'Monarch-Setup-0.2.0.exe');

    await writeFile(installerPath, INSTALLER);
    const reused = create();
    await reused.check();
    expect((await reused.download()).state).toBe('ready-to-install');
    expect(assetRequests).toBe(0);

    await writeFile(installerPath, Buffer.from('MZcorrupt', 'ascii'));
    const replaced = create();
    await replaced.check();
    expect((await replaced.download()).state).toBe('ready-to-install');
    expect(assetRequests).toBe(1);
    expect(await readFile(installerPath)).toEqual(INSTALLER);
  });

  it('refuses a check that would replace a paused or ready update', async () => {
    const root = await tempRoot();
    const payload = signed(manifest(32));
    const service = new MonarchUpdateService({
      currentVersion: '0.1.5',
      endpoints: [endpoints()[0]],
      publicKeys: PUBLIC_KEYS,
      updateRoot: root,
      now: () => NOW,
      fetchImpl: metadataFetch({ github: payload, sites: payload }),
    });
    await service.check();
    for (const state of ['paused', 'ready-to-install', 'installing']) {
      service.state = state;
      const result = await service.check();
      expect(result.state).toBe(state);
      expect(result.intentError?.code).toBe('update-in-progress');
      expect(result.release?.version).toBe('0.2.0');
    }
  });

  it('re-checks in the background only from a resting state', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(async () => undefined);
      const service = { installationPolicy: { canInstall: true }, state: 'up-to-date', activeOperation: null, check };
      const stop = startBackgroundUpdateChecks(service, { intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(check).toHaveBeenCalledTimes(1);
      service.state = 'downloading';
      await vi.advanceTimersByTimeAsync(3000);
      expect(check).toHaveBeenCalledTimes(1);
      service.state = 'failed';
      await vi.advanceTimersByTimeAsync(1000);
      expect(check).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(check).toHaveBeenCalledTimes(2);

      // The first check comes shortly after start, not only after the interval.
      const early = vi.fn(async () => undefined);
      const stopEarly = startBackgroundUpdateChecks({ installationPolicy: { canInstall: true }, state: 'idle', activeOperation: null, check: early }, { intervalMs: 60_000, initialDelayMs: 500 });
      await vi.advanceTimersByTimeAsync(500);
      expect(early).toHaveBeenCalledTimes(1);
      stopEarly();

      const blocked = vi.fn();
      startBackgroundUpdateChecks({ installationPolicy: { canInstall: false }, state: 'idle', check: blocked }, { intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(blocked).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('announces each new version once and never for a blocked install', () => {
    const show = vi.fn();
    const announce = createUpdateAvailableNotifier(show);
    expect(announce({ state: 'checking' })).toBe(false);
    expect(announce({ state: 'update-available', release: { version: '0.3.0.99' } })).toBe(true);
    expect(announce({ state: 'update-available', release: { version: '0.3.0.99' } })).toBe(false);
    expect(announce({ state: 'update-available', release: { version: '0.3.1.0' }, installation: { canInstall: false } })).toBe(false);
    expect(announce({ state: 'update-available', release: { version: '0.3.1.0' } })).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
  });
});

import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const DEMO_KEY_ID = 'monarch-update-demo';
const DEFAULT_DEMO_VERSION = '0.2.3.3';

export function createUpdateDemoRuntime(options = {}) {
  const version = options.version || DEFAULT_DEMO_VERSION;
  const installerSize = Math.max(64 * 1024, Number(options.installerSize) || 2 * 1024 * 1024);
  const chunkSize = Math.max(16 * 1024, Number(options.chunkSize) || 128 * 1024);
  const chunkDelayMs = Math.max(0, Number.isFinite(Number(options.chunkDelayMs)) ? Number(options.chunkDelayMs) : 90);
  const installDelayMs = Math.max(0, Number.isFinite(Number(options.installDelayMs)) ? Number(options.installDelayMs) : 650);
  const now = Number(options.now) || Date.now();
  const installer = Buffer.alloc(installerSize);
  installer.write('MZ', 0, 'ascii');
  for (let index = 2; index < installer.length; index += 1) installer[index] = index % 251;

  const fileName = `Monarch-Setup-${version}.exe`;
  const assetUrl = `https://github.com/MrPastio/monarch-releases/releases/download/v${version}/${fileName}`;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const manifest = {
    schemaVersion: 1,
    sequence: 9001,
    channel: 'stable',
    version,
    publishedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    minimumUpdaterVersion: '0.2.3.2',
    minimumLauncherVersion: '1.0.0',
    available: true,
    withdrawnReason: null,
    revokedVersions: [],
    releaseNotesUrl: `https://github.com/MrPastio/monarch-releases/releases/tag/v${version}`,
    compatibility: {
      runtimeVersion: '2026.08.0-demo',
      backendEnvironment: `backend-${version}-demo`,
      dataSchemaVersion: 5,
      minimumReadableDataSchema: 4,
      maximumReadableDataSchema: 5,
      minimumModelCatalogSchema: 1,
      maximumModelCatalogSchema: 2,
    },
    asset: {
      url: assetUrl,
      mirrors: [],
      size: installer.length,
      sha256: createHash('sha256').update(installer).digest('hex'),
      fileName,
    },
    keyId: DEMO_KEY_ID,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const signatureBytes = Buffer.from(`${sign(null, manifestBytes, privateKey).toString('base64')}\n`, 'ascii');
  const endpoints = [
    {
      id: 'github',
      manifestUrl: 'https://demo-github.monarch.invalid/stable/manifest.json',
      signatureUrl: 'https://demo-github.monarch.invalid/stable/manifest.sig',
    },
    {
      id: 'sites',
      manifestUrl: 'https://demo-sites.monarch.invalid/api/releases/stable/manifest.json',
      signatureUrl: 'https://demo-sites.monarch.invalid/api/releases/stable/manifest.sig',
    },
  ];

  return {
    version,
    endpoints,
    publicKeys: { [DEMO_KEY_ID]: publicKey },
    fetchImpl: async (urlValue, init = {}) => {
      const url = String(urlValue);
      if (url.endsWith('/manifest.json')) {
        return byteResponse(manifestBytes, 'application/json');
      }
      if (url.endsWith('/manifest.sig')) {
        return byteResponse(signatureBytes, 'text/plain');
      }
      if (url === assetUrl) {
        const rangeStart = readRangeStart(init.headers);
        const start = rangeStart === null ? 0 : rangeStart;
        const body = installer.subarray(start);
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
          ETag: '"monarch-update-demo"',
        };
        if (start > 0) headers['Content-Range'] = `bytes ${start}-${installer.length - 1}/${installer.length}`;
        return new Response(createChunkedStream(body, { chunkSize, chunkDelayMs }), {
          status: start > 0 ? 206 : 200,
          headers,
        });
      }
      return new Response('Not found', { status: 404 });
    },
    launchInstaller: async ({ signal, beginInstallation }) => {
      await delay(installDelayMs, signal);
      beginInstallation();
      await delay(installDelayMs, signal);
      return { launched: false, demo: true };
    },
  };
}

function byteResponse(bytes, contentType) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(bytes.length),
    },
  });
}

function readRangeStart(headersValue) {
  const headers = new Headers(headersValue || {});
  const match = /^bytes=(\d+)-$/i.exec(headers.get('range') || '');
  return match ? Number(match[1]) : null;
}

function createChunkedStream(bytes, { chunkSize, chunkDelayMs }) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      if (chunkDelayMs > 0) await delay(chunkDelayMs);
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

function delay(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('Update demo cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

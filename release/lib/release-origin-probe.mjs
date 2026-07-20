export async function probeGitHubReleaseOrigin({
  url,
  fetchImpl = globalThis.fetch,
  minimumBytes = 1,
  rangeBytes = 1024 * 1024,
}) {
  const initial = readGitHubReleaseUrl(url);
  const head = await fetchTrustedRedirects(initial, {
    method: 'HEAD',
    fetchImpl,
  });
  if (!head.response.ok) throw new Error(`Release HEAD returned HTTP ${head.response.status}.`);
  const size = readIntegerHeader(head.response.headers.get('content-length'));
  if (size === null || size < minimumBytes) {
    throw new Error(`Release asset is smaller than the required ${minimumBytes} bytes.`);
  }
  const etag = head.response.headers.get('etag');
  if (!etag) throw new Error('Release origin did not return ETag.');
  if (!/\bbytes\b/i.test(head.response.headers.get('accept-ranges') || '')) {
    throw new Error('Release origin did not advertise byte ranges.');
  }

  const requestedEnd = Math.min(size, rangeBytes) - 1;
  const ranged = await fetchTrustedRedirects(initial, {
    method: 'GET',
    headers: { Range: `bytes=0-${requestedEnd}` },
    fetchImpl,
  });
  if (ranged.response.status !== 206) {
    throw new Error(`Release Range returned HTTP ${ranged.response.status}, expected 206.`);
  }
  const contentRange = ranged.response.headers.get('content-range');
  if (contentRange !== `bytes 0-${requestedEnd}/${size}`) {
    throw new Error(`Unexpected Content-Range: ${contentRange || '(missing)'}.`);
  }
  const bytes = Buffer.from(await ranged.response.arrayBuffer());
  if (bytes.length !== requestedEnd + 1) {
    throw new Error('Range response byte count does not match Content-Range.');
  }
  const rangeEtag = ranged.response.headers.get('etag');
  if (rangeEtag && rangeEtag !== etag) {
    throw new Error('ETag changed between HEAD and Range requests.');
  }

  return Object.freeze({
    ok: true,
    sourceUrl: initial.href,
    finalHost: head.url.hostname,
    size,
    etag,
    acceptRanges: true,
    range: Object.freeze({
      status: 206,
      bytes: bytes.length,
      contentRange,
    }),
  });
}

async function fetchTrustedRedirects(initial, {
  fetchImpl,
  method,
  headers = {},
}) {
  let current = initial;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    const response = await fetchImpl(current, {
      method,
      headers,
      redirect: 'manual',
      cache: 'no-store',
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: current };
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('GitHub release redirect is missing Location.');
    const next = new URL(location, current);
    if (!isTrustedReleaseRedirect(initial, current, next)) {
      throw new Error(`Release origin redirected to an untrusted host: ${next.hostname}.`);
    }
    current = next;
  }
  throw new Error('GitHub release asset exceeded the redirect limit.');
}

function readGitHubReleaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || !/^\/MrPastio\/(?:monarch|monarch-releases)\/releases\/download\/[^/]+\/[^/]+$/.test(url.pathname)
  ) {
    throw new Error('Probe URL must be a trusted MrPastio GitHub release asset.');
  }
  return url;
}

function isTrustedReleaseRedirect(initial, current, next) {
  if (next.protocol !== 'https:' || next.username || next.password) return false;
  if (next.origin === current.origin) return true;
  if (initial.hostname !== 'github.com') return false;
  return [
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com',
    'github-releases.githubusercontent.com',
  ].includes(next.hostname);
}

function readIntegerHeader(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

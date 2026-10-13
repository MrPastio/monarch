const GITHUB_UPDATE_ENDPOINT = Object.freeze({
  id: 'github',
  manifestUrl: 'https://raw.githubusercontent.com/MrPastio/monarch-releases/main/channels/stable/manifest.json',
  signatureUrl: 'https://raw.githubusercontent.com/MrPastio/monarch-releases/main/channels/stable/manifest.sig',
});

export const MONARCH_UPDATE_SITES_ORIGIN = 'https://monarch-local-ai.mrpastio.chatgpt.site';
// The public site on Vercel serves the same signed bytes; it keeps metadata
// reachable if the older Sites deployment is retired.
export const MONARCH_UPDATE_VERCEL_ORIGIN = 'https://monarch-site-sigma.vercel.app';

export const MONARCH_RELEASE_KEY_ID = 'monarch-release-2026-01';

export function createMonarchUpdateEndpoints({
  sitesOrigin = MONARCH_UPDATE_SITES_ORIGIN,
  vercelOrigin = MONARCH_UPDATE_VERCEL_ORIGIN,
} = {}) {
  const endpoints = [GITHUB_UPDATE_ENDPOINT];
  if (sitesOrigin) endpoints.push(siteEndpoint('sites', sitesOrigin));
  if (vercelOrigin) endpoints.push(siteEndpoint('vercel', vercelOrigin));
  return Object.freeze(endpoints);
}

function siteEndpoint(id, value) {
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
    throw new Error(`Monarch ${id} update origin must be an HTTPS origin without a path or credentials.`);
  }
  return Object.freeze({
    id,
    manifestUrl: new URL('/api/releases/stable/manifest.json', origin).href,
    signatureUrl: new URL('/api/releases/stable/manifest.sig', origin).href,
  });
}

export const MONARCH_UPDATE_ENDPOINTS = createMonarchUpdateEndpoints();

export const MONARCH_RELEASE_PUBLIC_KEYS = Object.freeze({
  [MONARCH_RELEASE_KEY_ID]: [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAc+A+0TWnG0GP/56r00f+lVMfdSKXAhek4xyRvWu6dCA=',
    '-----END PUBLIC KEY-----',
    '',
  ].join('\n'),
});

const GITHUB_UPDATE_ENDPOINT = Object.freeze({
  id: 'github',
  manifestUrl: 'https://raw.githubusercontent.com/MrPastio/monarch-releases/main/channels/stable/manifest.json',
  signatureUrl: 'https://raw.githubusercontent.com/MrPastio/monarch-releases/main/channels/stable/manifest.sig',
});

export const MONARCH_RELEASE_KEY_ID = 'monarch-release-2026-01';

export function createMonarchUpdateEndpoints({ sitesOrigin = '' } = {}) {
  const endpoints = [GITHUB_UPDATE_ENDPOINT];
  if (sitesOrigin) {
    const origin = new URL(sitesOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/') {
      throw new Error('MONARCH_UPDATE_SITES_ORIGIN must be an HTTPS origin without a path or credentials.');
    }
    endpoints.push(Object.freeze({
      id: 'sites',
      manifestUrl: new URL('/api/releases/stable/manifest.json', origin).href,
      signatureUrl: new URL('/api/releases/stable/manifest.sig', origin).href,
    }));
  }
  return Object.freeze(endpoints);
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

export function readExternalHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function isTrustedRuntimeUrl(value, runtimeUrl) {
  try {
    return new URL(String(value || '')).origin === new URL(String(runtimeUrl || '')).origin;
  } catch {
    return false;
  }
}

export function shouldAllowDesktopPermission({
  permission,
  requestingUrl,
  runtimeUrl,
  mediaTypes = [],
  isMainFrame = true,
  isMainWebContents = false,
}) {
  if (!['media', 'geolocation'].includes(permission) || !isMainFrame || !isMainWebContents) {
    return false;
  }
  if (!isTrustedRuntimeUrl(requestingUrl, runtimeUrl)) {
    return false;
  }
  if (permission === 'geolocation') return true;
  const normalizedTypes = mediaTypes.map((value) => String(value || '').toLowerCase()).filter(Boolean);
  return normalizedTypes.length > 0 && normalizedTypes.every((value) => value === 'audio');
}

/** F-10: a link from page content (model answers) opens in the browser only
 * after the person confirmed it, unless they turned that off in the Monarch
 * Security policy center (`links.confirmOpen`). A level that cannot be read
 * means asking: an unavailable policy never weakens the default. */
export async function shouldOpenContentLink({ url, readLevel, confirm }) {
  const target = readExternalHttpUrl(url);
  if (!target) return false;
  let level = 'always';
  try {
    const read = await readLevel();
    if (read === 'off') level = 'off';
  } catch {
    level = 'always';
  }
  if (level === 'off') return true;
  try {
    return (await confirm(target)) === true;
  } catch {
    return false;
  }
}

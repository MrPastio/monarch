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
  if (permission !== 'media' || !isMainFrame || !isMainWebContents) {
    return false;
  }
  if (!isTrustedRuntimeUrl(requestingUrl, runtimeUrl)) {
    return false;
  }
  const normalizedTypes = mediaTypes.map((value) => String(value || '').toLowerCase()).filter(Boolean);
  return normalizedTypes.length > 0 && normalizedTypes.every((value) => value === 'audio');
}

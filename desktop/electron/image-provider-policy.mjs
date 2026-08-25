export const PERCHANCE_IMAGE_PROVIDER_URL = 'https://perchance.org/ai-text-to-image-generator';
export const IMAGE_PROVIDER_DEFAULT_ZOOM = 0.9;

export function isAllowedImageProviderUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && (url.hostname === 'perchance.org' || url.hostname.endsWith('.perchance.org'));
  } catch {
    return false;
  }
}

export function resolveImageProviderEntryUrl(value) {
  return isAllowedImageProviderUrl(value) ? String(value) : PERCHANCE_IMAGE_PROVIDER_URL;
}

export function resolveImageProviderZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return IMAGE_PROVIDER_DEFAULT_ZOOM;
  return Math.min(1.15, Math.max(0.75, Math.round(zoom * 20) / 20));
}

export function resolveEmbeddedImageProviderBounds(value, hostSize) {
  const hostWidth = Math.max(0, Math.floor(Number(hostSize?.width) || 0));
  const hostHeight = Math.max(0, Math.floor(Number(hostSize?.height) || 0));
  if (hostWidth < 480 || hostHeight < 360) return null;

  const x = clampInteger(value?.x, 0, hostWidth - 320);
  const y = clampInteger(value?.y, 0, hostHeight - 260);
  const width = clampInteger(value?.width, 320, hostWidth - x);
  const height = clampInteger(value?.height, 260, hostHeight - y);
  return { x, y, width, height };
}

function clampInteger(value, minimum, maximum) {
  const number = Math.round(Number(value));
  const normalized = Number.isFinite(number) ? number : minimum;
  return Math.min(Math.max(minimum, maximum), Math.max(minimum, normalized));
}

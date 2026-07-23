import path from 'node:path';

const MONARCH_VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?$/;

export function resolveDesktopUpdatePolicy({
  isPackaged,
  demoMode = false,
  fallbackVersion,
  installRoot,
  payloadRoot,
  installedDescriptor,
  installedPointer,
  installedLayout,
} = {}) {
  const fallback = readVersion(fallbackVersion) || '0.0.0';
  if (demoMode) {
    return Object.freeze({
      mode: 'demo',
      canInstall: true,
      currentVersion: fallback,
      reason: null,
    });
  }

  if (!isPackaged) {
    return Object.freeze({
      mode: 'development',
      canInstall: false,
      currentVersion: fallback,
      reason: 'development-workspace',
    });
  }

  const descriptorVersion = readVersion(installedDescriptor?.appVersion);
  const pointerVersion = readVersion(installedPointer?.currentVersion);
  const layoutReady = Boolean(
    installRoot
    && payloadRoot
    && installedLayout?.schemaVersion === 1
    && samePath(installedLayout?.payloadRoot, payloadRoot),
  );
  if (!layoutReady || !descriptorVersion || !pointerVersion) {
    return Object.freeze({
      mode: 'unsupported',
      canInstall: false,
      currentVersion: descriptorVersion || pointerVersion || fallback,
      reason: 'installed-layout-missing',
    });
  }
  if (descriptorVersion !== pointerVersion) {
    return Object.freeze({
      mode: 'unsupported',
      canInstall: false,
      currentVersion: descriptorVersion,
      reason: 'installed-version-mismatch',
    });
  }

  return Object.freeze({
    mode: 'installed',
    canInstall: true,
    currentVersion: descriptorVersion,
    reason: null,
  });
}

function readVersion(value) {
  const normalized = String(value || '').trim();
  return MONARCH_VERSION.test(normalized) ? normalized : null;
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

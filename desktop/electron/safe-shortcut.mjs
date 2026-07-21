import path from 'node:path';

export function safeShortcutPath(desktopPath) {
  if (!path.isAbsolute(desktopPath)) throw new TypeError('Desktop path must be absolute.');
  return path.join(desktopPath, 'Monarch Safe.lnk');
}

export function buildSafeShortcutDetails({ executablePath, appEntryPath, iconPath, packaged = false }) {
  if (!path.isAbsolute(executablePath)) throw new TypeError('Executable path must be absolute.');
  const args = packaged
    ? '--safe'
    : `${quoteWindowsArgument(appEntryPath)} --safe`;
  return {
    target: executablePath,
    cwd: packaged ? path.dirname(executablePath) : path.dirname(appEntryPath),
    args,
    description: 'Открыть изолированное хранилище Monarch Safe',
    icon: path.isAbsolute(iconPath) ? iconPath : executablePath,
    iconIndex: 0,
    appUserModelId: 'Monarch.Safe',
  };
}

function quoteWindowsArgument(value) {
  const input = String(value || '');
  return `"${input.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

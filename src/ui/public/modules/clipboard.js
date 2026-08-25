function resolveRuntimeValue(explicitValue, key) {
  if (explicitValue !== undefined) return explicitValue;
  return globalThis[key];
}

function copyWithTemporarySelection(text, documentRef) {
  if (!documentRef?.body || typeof documentRef.createElement !== 'function') return false;
  const previousFocus = documentRef.activeElement;
  const textarea = documentRef.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.inset = '-9999px auto auto -9999px';
  textarea.style.opacity = '0';
  documentRef.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = documentRef.execCommand?.('copy') === true;
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    previousFocus?.focus?.();
  }
  return copied;
}

export async function copyTextToClipboard(value, options = {}) {
  const text = String(value ?? '');
  const windowRef = resolveRuntimeValue(options.windowRef, 'window');
  const navigatorRef = resolveRuntimeValue(options.navigatorRef, 'navigator');
  const desktop = options.desktop !== undefined ? options.desktop : windowRef?.monarchDesktop;
  const clipboard = options.clipboard !== undefined ? options.clipboard : navigatorRef?.clipboard;
  const documentRef = resolveRuntimeValue(options.documentRef, 'document');

  if (typeof desktop?.copyText === 'function') {
    try {
      if (await desktop.copyText(text)) return true;
    } catch {
      // Continue to browser and selection fallbacks.
    }
  }

  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Browser previews may deny async clipboard access.
    }
  }

  return copyWithTemporarySelection(text, documentRef);
}

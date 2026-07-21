export const SAFE_SECURITY_POLICY_DEFAULTS = Object.freeze({
  autoLockMs: 5 * 60 * 1000,
  clipboardMode: 'blocked',
  minimizeAction: 'close',
  lockOnBlur: true,
  clearClipboardOnLock: true,
});

const ALLOWED_AUTO_LOCK_MS = new Set([
  0,
  30 * 1000,
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
]);
const CLIPBOARD_MODES = new Set(['blocked', 'copy-only', 'read-write']);
const MINIMIZE_ACTIONS = new Set(['close', 'lock', 'keep-unlocked']);

export function normalizeSafeSecurityPolicy(value) {
  const source = value && typeof value === 'object' ? value : {};
  const autoLockMs = Number(source.autoLockMs);
  return {
    autoLockMs: ALLOWED_AUTO_LOCK_MS.has(autoLockMs)
      ? autoLockMs
      : SAFE_SECURITY_POLICY_DEFAULTS.autoLockMs,
    clipboardMode: CLIPBOARD_MODES.has(source.clipboardMode)
      ? source.clipboardMode
      : SAFE_SECURITY_POLICY_DEFAULTS.clipboardMode,
    minimizeAction: MINIMIZE_ACTIONS.has(source.minimizeAction)
      ? source.minimizeAction
      : SAFE_SECURITY_POLICY_DEFAULTS.minimizeAction,
    lockOnBlur: source.lockOnBlur === undefined
      ? SAFE_SECURITY_POLICY_DEFAULTS.lockOnBlur
      : source.lockOnBlur === true,
    clearClipboardOnLock: source.clearClipboardOnLock === undefined
      ? SAFE_SECURITY_POLICY_DEFAULTS.clearClipboardOnLock
      : source.clearClipboardOnLock === true,
  };
}

export function assessSafeSecurityPolicy(value) {
  const policy = normalizeSafeSecurityPolicy(value);
  const warnings = [];
  if (policy.autoLockMs === 0) warnings.push('Автоблокировка отключена. Safe останется открытым до ручной блокировки или системной границы.');
  else if (policy.autoLockMs > 30 * 60 * 1000) warnings.push('Пароль будет запрошен только после долгого периода бездействия.');
  if (policy.clipboardMode === 'copy-only') warnings.push('Данные можно копировать из Safe в системный буфер обмена.');
  if (policy.clipboardMode === 'read-write') warnings.push('Системный буфер обмена доступен в обе стороны и может переносить данные за границу Safe.');
  if (policy.minimizeAction === 'keep-unlocked') warnings.push('При сворачивании окно может остаться разблокированным.');
  if (!policy.lockOnBlur) warnings.push('Потеря фокуса сама по себе не заблокирует Safe.');
  if (policy.clipboardMode !== 'blocked' && !policy.clearClipboardOnLock) warnings.push('Safe не будет очищать системный буфер при блокировке.');
  return {
    level: warnings.length >= 2 || policy.autoLockMs === 0 || policy.clipboardMode === 'read-write'
      ? 'low'
      : warnings.length
        ? 'balanced'
        : 'strong',
    warnings,
    policy,
  };
}

export function safeAutoLockLabel(milliseconds) {
  const value = Number(milliseconds);
  if (value === 0) return 'Никогда';
  if (value < 60_000) return `${Math.round(value / 1000)} сек`;
  return `${Math.round(value / 60_000)} мин`;
}

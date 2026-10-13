import { createSafeCapabilityToken } from '../safe/capability-token.mjs';

export function sameSafeFileContext(a, b) {
  return Boolean(a && b && ['action', 'resourceId', 'name', 'location', 'sessionId', 'resourceVersion', 'payloadDigest'].every((key) => a[key] === b[key]));
}

// The caller supplies identities/proposed bytes only. All displayed metadata comes
// from the utility's authenticated manifest, and is rechecked after the dialog.
export async function authorizeSafeFiles({ action, value, key, prepare, prompt, isCurrent }) {
  const batch = action === 'deleteFile' && Array.isArray(value?.files);
  const files = batch ? value.files : [value];
  if (!files.length || files.length > 100) throw new Error('safe-authorization-invalid-count');
  const ids = files.map((file) => file?.id);
  if (ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) || new Set(ids).size !== ids.length) throw new Error('safe-authorization-invalid-id');
  const proposals = [];
  for (const id of ids) {
    if (!isCurrent()) throw new Error('safe-authorization-session-changed');
    proposals.push(await prepare({ id, action, ...(action === 'writeFile' ? { bytes: value.bytes, mime: value.mime, text: value.text } : {}) }));
  }
  if (!isCurrent()) throw new Error('safe-authorization-session-changed');
  const describe = (file) => `«${clean(file.name)}» · ${clean(file.location)} · ${file.resourceId}`;
  const deleting = action === 'deleteFile';
  const confirmed = await prompt({
    title: deleting ? 'Удалить выбранные файлы?' : 'Сохранить новую версию?',
    message: proposals.length === 1 ? describe(proposals[0]) : `Файлов к удалению: ${proposals.length}`,
    detail: `${proposals.length > 1 ? proposals.map(describe).join('\n') + '\n\n' : ''}${deleting ? 'Активные ключи выбранных версий будут уничтожены. Снимки и внешние копии остаются вне контроля Safe.' : 'Подтверждение действует только для этой версии и отправленного содержимого. Активный ключ предыдущей версии будет уничтожен.'}`,
    confirmLabel: deleting ? `Удалить · ${proposals.length}` : 'Сохранить версию',
    tone: deleting ? 'danger' : 'primary',
  });
  if (!confirmed || !isCurrent()) return null;
  for (let i = 0; i < ids.length; i++) {
    const current = await prepare({ id: ids[i], action, ...(action === 'writeFile' ? { bytes: value.bytes, mime: value.mime, text: value.text } : {}) });
    if (!isCurrent() || !sameSafeFileContext(proposals[i], current)) throw new Error('safe-authorization-proposal-changed');
  }
  const tokens = proposals.map((binding) => ({ id: binding.resourceId, capabilityToken: createSafeCapabilityToken({ key, action, resourceId: binding.resourceId, binding }) }));
  return batch ? { tokens } : tokens[0].capabilityToken;
}

function clean(value) { return String(value || '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' '); }

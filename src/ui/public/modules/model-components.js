import { escapeHtml } from './utils.js';

export function formatManagedBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  return `${(bytes / (1024 ** 3)).toFixed(2)} ГБ`;
}

/** The first component is the model itself; the rest are optional extras such
 * as speculative decoding and vision. Treating a missing extra as a missing
 * model told the owner to download 19 GB he already had installed. */
export function missingOptionalComponents(provisioned) {
  if (!provisioned || !provisioned.installed) return [];
  return (provisioned.components || []).slice(1).filter((component) => component.phase !== 'ready');
}

export function renderOptionalComponentNote(missing) {
  if (!missing.length) return '';
  const bytes = missing.reduce((sum, component) => sum + (Number(component.expectedBytes) || 0), 0);
  const names = missing.map((component) => component.label).join(', ');
  return `<p class="model-install-note">Модель установлена и работает. Не хватает дополнений: ${escapeHtml(names)} — ${formatManagedBytes(bytes)}. Без них модель отвечает, но медленнее и без разбора изображений.</p>`;
}

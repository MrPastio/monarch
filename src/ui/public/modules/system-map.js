// Settings -> System: what Monarch is made of right now. Modules and their
// state come from the live Kernel snapshot (`system.runtimeContract.modules`);
// this file only names groups and states in plain Russian.
const GROUPS = Object.freeze([
  ['all', 'Все'], ['domain', 'Возможности'], ['tooling', 'Инструменты'], ['runtime', 'Модели и агент'], ['system', 'Система'],
]);
const STATE_LABELS = Object.freeze({
  active: 'Работает', registered: 'Загружен', inactive: 'Выключен', failed: 'Ошибка',
});

export function systemMapModules(system, group = 'all') {
  const modules = Array.isArray(system?.runtimeContract?.modules) ? system.runtimeContract.modules : [];
  return modules
    .filter(module => group === 'all' || module.kind === group)
    .map(module => ({
      id: String(module.id || ''),
      name: String(module.name || module.id || '').replace(/^Monarch\s+/u, ''),
      kind: String(module.kind || ''),
      status: STATE_LABELS[module.status] ? module.status : 'registered',
      capabilities: Number(module.capabilities) || 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'));
}

export function renderSystemMap(system, group, escapeHtml) {
  const modules = systemMapModules(system, group);
  const all = systemMapModules(system);
  const working = all.filter(module => module.status === 'active').length;
  const filters = GROUPS.map(([id, label]) => (
    `<button type="button" role="radio" data-system-map-group="${id}" aria-checked="${id === group}">${label}</button>`
  )).join('');
  const rows = modules.map(module => (
    `<li data-status="${escapeHtml(module.status)}"><span class="system-map-dot" aria-hidden="true"></span><strong>${escapeHtml(module.name)}</strong><small>${escapeHtml(STATE_LABELS[module.status])} · действий: ${module.capabilities}</small></li>`
  )).join('');
  return `<p class="system-map-summary">Модулей: ${all.length}, работают: ${working}</p>
    <div class="system-map-filters" role="radiogroup" aria-label="Группа модулей">${filters}</div>
    ${rows ? `<ul class="system-map-list">${rows}</ul>` : '<p class="system-map-empty">В этой группе модулей нет.</p>'}`;
}

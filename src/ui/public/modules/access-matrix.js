// Settings -> Access: "what happens with each action" per autonomy mode.
// Rows come from the runtime (`permissionMatrix` in the state snapshot), which
// is built from the same rules the Kernel gate evaluates; this file only names
// them in plain Russian.
const MODE_LABELS = Object.freeze({
  guided: 'Всегда спрашивать',
  'workspace-autonomous': 'Самостоятельно в проекте',
  'full-local': 'Самостоятельно на устройстве',
});
const RISK_LABELS = Object.freeze({
  read: 'Чтение файлов',
  write: 'Запись и создание',
  execute: 'Запуск команд',
  network: 'Интернет и внешние адреса',
  delete: 'Удаление',
  money: 'Деньги и платежи',
});
const DECISION_LABELS = Object.freeze({ allow: 'Сам', confirm: 'Спросит', deny: 'Запрещено' });

export function renderAccessMatrix(rows, activeMode, escapeHtml) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const risks = rows[0].cells.map(cell => cell.risk).filter(risk => RISK_LABELS[risk]);
  const head = `<thead><tr><th scope="col">Действие</th>${rows.map(row => (
    `<th scope="col" data-mode="${escapeHtml(row.autonomyMode)}"${row.autonomyMode === activeMode ? ' data-active="true" aria-current="true"' : ''}>${escapeHtml(MODE_LABELS[row.autonomyMode] || row.autonomyMode)}</th>`
  )).join('')}</tr></thead>`;
  const body = risks.map(risk => `<tr><th scope="row">${escapeHtml(RISK_LABELS[risk])}</th>${rows.map(row => {
    const mode = row.cells.find(cell => cell.risk === risk)?.mode || 'deny';
    const active = row.autonomyMode === activeMode ? ' data-active="true"' : '';
    return `<td data-decision="${escapeHtml(mode)}"${active}><span>${escapeHtml(DECISION_LABELS[mode] || mode)}</span></td>`;
  }).join('')}</tr>`).join('');
  return `${head}<tbody>${body}</tbody>`;
}

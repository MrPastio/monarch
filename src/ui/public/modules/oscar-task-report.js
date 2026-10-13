// Finished-task summary under Oscar's answer: what was done, what the person
// approved or rejected, what the rules refused. Rows come from the turn's
// terminal projection (`taskReport`), built on the host from task activities.
const STATE_LABELS = Object.freeze({
  done: 'Сделано', approved: 'Ты разрешил', rejected: 'Ты отклонил', denied: 'Запрещено правилами', failed: 'Не получилось',
});
const STATES = new Set(Object.keys(STATE_LABELS));

export function readOscarTaskReport(events) {
  if (!Array.isArray(events)) return [];
  const report = [...events].reverse().find(event => event?.type === 'agent.progress' && Array.isArray(event.payload?.taskReport))?.payload.taskReport;
  return (report || []).filter(entry => entry && typeof entry.title === 'string' && STATES.has(entry.state))
    .slice(0, 24).map(entry => ({ title: entry.title.slice(0, 200), state: entry.state }));
}

export function renderOscarTaskReport(report, escapeHtml) {
  if (!Array.isArray(report) || report.length === 0) return '';
  const counts = { done: 0, approved: 0, rejected: 0, denied: 0, failed: 0 };
  for (const entry of report) counts[entry.state] += 1;
  const summary = [
    counts.done ? `сделано ${counts.done}` : '',
    counts.approved ? `разрешил ты ${counts.approved}` : '',
    counts.rejected ? `отклонено ${counts.rejected}` : '',
    counts.denied ? `запрещено ${counts.denied}` : '',
    counts.failed ? `не получилось ${counts.failed}` : '',
  ].filter(Boolean).join(' · ');
  const rows = report.map(entry => (
    `<li data-report-state="${escapeHtml(entry.state)}"><span>${escapeHtml(STATE_LABELS[entry.state])}</span>${escapeHtml(entry.title.replace(/^Ты разрешил: /u, ''))}</li>`
  )).join('');
  return `<details class="oscar-task-report"><summary>Итог задачи <small>${escapeHtml(summary)}</small></summary><ol>${rows}</ol></details>`;
}

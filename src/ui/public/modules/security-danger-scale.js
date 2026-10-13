// Security -> Mode: where on the 0..100% risk scale this mode lets an action
// through, checks it again, or asks. Segments come from the runtime
// (`dangerScale`, built from the Kernel's own rule); examples are the latest
// real assessments from the Security danger log.
const RESPONSE_LABELS = Object.freeze({
  allow: 'Сразу', 'enhanced-readback': 'С проверкой', confirm: 'Спросит тебя', observe: 'Только журнал',
});

export function renderSecurityDangerScale(segments, examples, escapeHtml) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const bands = segments.map(segment => {
    const width = segment.to - segment.from + 1;
    return `<span class="danger-band" data-response="${escapeHtml(segment.response)}" style="flex-grow:${width}"><b>${escapeHtml(RESPONSE_LABELS[segment.response] || segment.response)}</b><small>${segment.from === 0 ? 'до' : 'от'} ${segment.from === 0 ? segment.to : segment.from}%</small></span>`;
  }).join('');
  // The same action assessed at the same risk many times is one mark and one
  // "×N" chip, not five identical rows.
  const grouped = [];
  for (const example of (examples || []).slice(0, 12)) {
    const score = Math.round(Math.max(0, Math.min(100, Number(example.score) || 0)));
    const found = grouped.find(entry => entry.score === score && entry.label === example.label);
    if (found) found.count += 1; else grouped.push({ score, label: example.label, count: 1 });
  }
  const shown = grouped.slice(0, 5);
  const marks = shown.map(example => (
    `<i class="danger-mark" style="left:${example.score}%" title="${escapeHtml(`${example.label}: ${example.score}%`)}"></i>`
  )).join('');
  const legend = shown.map(example => (
    `<li><span>${example.score}%</span>${escapeHtml(example.label)}${example.count > 1 ? `<em>×${example.count}</em>` : ''}</li>`
  )).join('');
  const confirmFrom = segments.find(segment => segment.response === 'confirm')?.from;
  const title = confirmFrom !== undefined ? `Шкала риска · спросит тебя от ${confirmFrom}%`
    : segments.every(segment => segment.response === 'observe') ? 'Шкала риска · Security только записывает, ничего не останавливает'
      : 'Шкала риска · Security ничего не останавливает';
  return `<p class="danger-scale-title">${escapeHtml(title)}</p>
    <div class="danger-scale-track">${bands}${marks}</div>
    ${legend ? `<ol class="danger-scale-examples" aria-label="Последние оценённые действия">${legend}</ol>` : '<p class="danger-scale-empty">Когда Оскар начнёт действовать, здесь появятся его последние действия на этой шкале.</p>'}`;
}

const ACTION_LABELS = [
  [/delete|trash|remove/u, 'Удаление'],
  [/command|shell|terminal|execute|run\b/u, 'Команда'],
  [/network|web|http|fetch|search/u, 'Интернет'],
  [/write|patch|create|save|move|rename|copy/u, 'Запись файла'],
  [/read|list|open|get|status/u, 'Чтение'],
];
export function plainDangerActionLabel(capabilityId) {
  const id = String(capabilityId || '').toLowerCase();
  return ACTION_LABELS.find(([pattern]) => pattern.test(id))?.[1] || 'Действие';
}

export function dangerScaleExamples(records) {
  if (!Array.isArray(records)) return [];
  return records.filter(entry => entry?.type === 'security.danger.assessed' && entry.assessment)
    .slice(-5).reverse()
    .map(entry => ({ score: Number(entry.assessment.dangerProbability) || 0, label: plainDangerActionLabel(entry.capabilityId) }));
}

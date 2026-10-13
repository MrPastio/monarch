// "Было / стало" for a Coder write before the person approves it. The proposed
// text is derived exactly as the Coder module applies it (whole-file write or
// exact single-occurrence replacements), so the preview never shows a change
// the approval would not make.
const MAX_DIFF_LINES = 2000;

export function coderProposedContent(capabilityId, args, current) {
  if (capabilityId === 'coder.files.write') return typeof args?.content === 'string' ? args.content : null;
  if (capabilityId !== 'coder.files.patch' || typeof current !== 'string' || !Array.isArray(args?.replacements)) return null;
  let content = current;
  for (const replacement of args.replacements) {
    if (typeof replacement?.oldText !== 'string' || !replacement.oldText || typeof replacement.newText !== 'string') return null;
    if (content.split(replacement.oldText).length - 1 !== 1) return null;
    content = content.replace(replacement.oldText, () => replacement.newText);
  }
  return content;
}

/** Line diff by longest common subsequence; null when either side is too long. */
export function coderLineDiff(before, after) {
  const a = String(before ?? '').split(/\r?\n/u), b = String(after ?? '').split(/\r?\n/u);
  if (before === '') a.length = 0;
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 }); i += 1; j += 1; }
    else if (i < a.length && (j >= b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) { rows.push({ type: 'del', text: a[i], oldNo: i + 1 }); i += 1; }
    else { rows.push({ type: 'add', text: b[j], newNo: j + 1 }); j += 1; }
  }
  return rows;
}

/** Changed lines with up to `context` unchanged lines around them. */
export function coderDiffHunks(rows, context = 3) {
  const keep = new Uint8Array(rows.length);
  rows.forEach((row, index) => {
    if (row.type === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(rows.length - 1, index + context); k += 1) keep[k] = 1;
  });
  const hunks = [];
  let current = null;
  rows.forEach((row, index) => {
    if (!keep[index]) { current = null; return; }
    if (!current) { current = []; hunks.push(current); }
    current.push(row);
  });
  return hunks;
}

export function renderCoderDiff(path, rows) {
  const section = document.createElement('section');
  section.className = 'coder-diff';
  const header = document.createElement('header');
  const title = document.createElement('strong'); title.textContent = path;
  const added = rows.filter(row => row.type === 'add').length, removed = rows.filter(row => row.type === 'del').length;
  const stat = document.createElement('small'); stat.textContent = `+${added} −${removed}`;
  header.append(title, stat);
  section.append(header);
  const hunks = coderDiffHunks(rows);
  if (!hunks.length) {
    const same = document.createElement('p'); same.textContent = 'Содержимое не меняется.'; section.append(same);
    return section;
  }
  for (const hunk of hunks) {
    const block = document.createElement('div'); block.className = 'coder-diff-hunk'; block.setAttribute('role', 'table');
    for (const row of hunk) {
      const line = document.createElement('div'); line.className = 'coder-diff-line'; line.dataset.type = row.type; line.setAttribute('role', 'row');
      const number = document.createElement('span'); number.className = 'coder-diff-no'; number.textContent = String(row.type === 'del' ? row.oldNo : row.newNo);
      const mark = document.createElement('span'); mark.className = 'coder-diff-mark'; mark.textContent = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ';
      mark.setAttribute('aria-label', row.type === 'add' ? 'добавлено' : row.type === 'del' ? 'удалено' : 'без изменений');
      const code = document.createElement('code'); code.textContent = row.text;
      line.append(number, mark, code); block.append(line);
    }
    section.append(block);
  }
  return section;
}

import { state } from './state.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function readErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function readUserFacingFailure(result, fallback = 'Не удалось выполнить действие.') {
  const candidate = result?.userFacing || result?.result?.userFacing || result?.execution?.userFacing;
  return typeof candidate?.message === 'string' && candidate.message.trim()
    ? candidate.message.trim()
    : fallback;
}

export function renderError(message) {
  return `
    <div class="error-state">
      <strong>Что-то сломалось</strong>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

export function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function readNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function initials(value) {
  return String(value || 'M')
    .split(/\s|-/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function formatRuntimeStatus(status) {
  switch (status) {
  case 'active':
  case 'ready':
    return 'готово';
  case 'present':
    return 'готова';
  case 'experimental':
    return 'эксперимент';
  case 'runner-missing':
    return 'runner ожидает';
  case 'model-missing':
    return 'нет модели';
  case 'missing':
    return 'нет данных';
  default:
    return status;
  }
}

export function readOscarBackend(oscarState) {
  return oscarState?.status?.backend || null;
}

export function readOscarModelStatus(oscarState) {
  const backend = readOscarBackend(oscarState);
  return backend?.modelStatus && typeof backend.modelStatus === 'object'
    ? backend.modelStatus
    : null;
}

export function readOscarModeLabel(oscarState, modelStatus = null) {
  const mStatus = modelStatus || readOscarModelStatus(oscarState);
  if (mStatus?.fallback_active) {
    return 'fallback mock';
  }
  if (mStatus?.mock) {
    return 'mock';
  }
  if (mStatus?.loaded) {
    return formatOscarTierLabel(mStatus.active_tier || oscarState?.gemmaTier);
  }
  const selected = oscarState?.gemmaTier && oscarState.gemmaTier !== 'none'
    ? formatOscarTierLabel(oscarState.gemmaTier)
    : 'Auto router';
  return oscarState?.web ? `web + ${selected}` : selected;
}

function formatOscarTierLabel(tier) {
  switch (tier) {
  case 'gemma4-fast':
  case 'gemma_low':
    return 'Fast';
  case 'weak':
    return 'Local Fast 1.5B';
  case 'gemma4-balanced':
  case 'gemma_high':
  case 'gemma':
  case 'medium':
    return 'Medium';
  case 'gemma4-deepthinking':
  case 'powerful':
  case 'reasoning':
    return 'Pro';
  case 'gemma4-31b':
    return 'Extra';
  default:
    return tier || 'локальный runtime';
  }
}

export function readOscarMemoryCount(memoryStats) {
  if (!memoryStats || typeof memoryStats !== 'object') {
    return 0;
  }
  const candidates = [
    memoryStats.active_memories,
    memoryStats.memories,
    memoryStats.records,
    memoryStats.count,
    memoryStats.total,
    memoryStats.total_records,
    memoryStats.chunks,
    memoryStats.documents,
  ];
  const count = candidates.find((value) => Number.isFinite(value));
  return Number.isFinite(count) ? count : 0;
}

export function readOscarMemoryLabel(memoryStats) {
  if (!memoryStats || typeof memoryStats !== 'object') {
    return '0 памяти';
  }

  const chunks = Number.isFinite(memoryStats.chunks) ? memoryStats.chunks : null;
  const documents = Number.isFinite(memoryStats.documents) ? memoryStats.documents : null;
  const memories = Number.isFinite(memoryStats.active_memories)
    ? memoryStats.active_memories
    : Number.isFinite(memoryStats.memories)
      ? memoryStats.memories
      : null;
  if (memories !== null) {
    return `${memories} восп. · ${documents ?? 0} док.`;
  }
  if (chunks !== null && documents !== null) {
    return `${chunks} фрагм. · ${documents} док.`;
  }
  if (chunks !== null) {
    return `${chunks} фрагм.`;
  }
  if (documents !== null) {
    return `${documents} док.`;
  }
  return `${readOscarMemoryCount(memoryStats)} памяти`;
}

export function readOscarAnswer(result) {
  const response = result.output?.response;
  if (response && typeof response === 'object') {
    if (typeof response.answer === 'string' && response.answer.trim()) {
      return response.answer.trim();
    }
    if (typeof response.content === 'string' && response.content.trim()) {
      return response.content.trim();
    }
    if (typeof response.message === 'string' && response.message.trim()) {
      return response.message.trim();
    }
  }
  return summarizeOutput(result.output) || result.summary || 'Oscar вернул пустой ответ.';
}

export function readOscarSources(response) {
  if (!response || typeof response !== 'object') {
    return [];
  }
  const sources = Array.isArray(response.sources) ? response.sources : [];
  const seen = new Set();
  return sources.filter(s => {
    const rawUrl = s?.url || s?.href || '';
    const rawTitle = s?.title || s?.label || '';
    const keyStr = (typeof s === 'string') ? s : (rawUrl || rawTitle || JSON.stringify(s));
    const key = String(keyStr).trim().toLowerCase();
    
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function formatOscarContent(content) {
  let text = sanitizeVisibleAssistantContent(content);
  
  // Cut template phrases
  const templatePhrases = [
    /^(?:Конечно|Вот(?: ваш)? код|Я готов помочь|Надеюсь, это поможет|Давайте|Давай|С удовольствием|Обязательно)[!.,:]?\s*/i,
    /\n(?:Надеюсь, это поможет|Обращайся|Всегда готов помочь)[!.,:]?\s*$/i
  ];
  for (const regex of templatePhrases) {
    text = text.replace(regex, '');
  }
  text = normalizeRepeatedOrderedListMarkers(text);

  const parts = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const textBefore = text.slice(lastIndex, match.index);
    if (textBefore.trim()) {
      parts.push(`<div class="oscar-text-part">${renderOscarMarkdown(textBefore)}</div>`);
    }
    const lang = String(match[1] || 'code').trim() || 'code';
    const code = String(match[2] || '');
    parts.push(`
      <div class="oscar-code-block${match[3] ? '' : ' is-streaming'}">
        <div class="oscar-code-header">
          <span>${escapeHtml(lang)}${match[3] ? '' : ' · пишется'}</span>
          <button type="button" class="oscar-copy-btn" aria-label="Скопировать весь код">Скопировать</button>
        </div>
        <pre><code>${escapeHtml(code)}</code></pre>
      </div>
    `);
    lastIndex = pattern.lastIndex;
  }
  
  const textAfter = text.slice(lastIndex);
  if (textAfter.trim()) {
    parts.push(`<div class="oscar-text-part">${renderOscarMarkdown(textAfter)}</div>`);
  }
  
  return parts.join('');
}

export function sanitizeVisibleAssistantContent(content) {
  return sanitizeOutsideCodeFences(String(content || ''), sanitizeVisibleAssistantSegment);
}

function sanitizeOutsideCodeFences(source, sanitizer) {
  const pattern = /```[\s\S]*?```/g;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    result += sanitizer(source.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = pattern.lastIndex;
  }
  result += sanitizer(source.slice(lastIndex));
  return result;
}

function sanitizeVisibleAssistantSegment(segment) {
  const withoutHiddenCommands = segment
    .replace(/\s*\[\[(?:MONARCH_ACTION|MONARCH_COMMAND):[\s\S]*?\]\]\s*/gi, '\n')
    .replace(/\s*\[\[(?:MONARCH_ACTION|MONARCH_COMMAND):[\s\S]*$/gi, '');
  return hideServiceJsonBlocks(withoutHiddenCommands.replace(
    /<\|?\/?toolcall\|?>\s*call:\s*[a-z0-9_.-]+\s*(?:\{[^{}]*\})?\s*(?:<\|?\/?toolcall\|?>)?/gi,
    'Служебный вызов инструмента скрыт: действие должно выполняться через Monarch capability-роутер.'
  ));
}

function hideServiceJsonBlocks(segment) {
  let result = '';
  let cursor = 0;
  while (cursor < segment.length) {
    const start = segment.indexOf('{', cursor);
    if (start === -1) {
      result += segment.slice(cursor);
      break;
    }
    const end = findBalancedJsonEnd(segment, start);
    const blockEnd = end === -1 ? findUnbalancedServiceJsonEnd(segment, start) : end + 1;
    if (blockEnd === -1) {
      result += segment.slice(cursor);
      break;
    }
    const block = segment.slice(start, blockEnd);
    result += segment.slice(cursor, start);
    result += isServiceJsonBlock(block) ? '\nСлужебные детали скрыты.\n' : block;
    cursor = blockEnd;
  }
  return result.replace(/(?:\n\s*Служебные детали скрыты\.\s*){2,}/g, '\nСлужебные детали скрыты.\n');
}

function findBalancedJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findUnbalancedServiceJsonEnd(text, start) {
  const rest = text.slice(start);
  const paragraphBreak = rest.search(/\n\s*\n/);
  if (paragraphBreak > 0) return start + paragraphBreak;
  return text.length;
}

function isServiceJsonBlock(block) {
  const compact = block.replace(/\s+/g, ' ');
  if (compact.length < 80) return false;
  return /"(?:projectRoot|apiBase|knownEndpoints|astraCapabilities|tool_results|toolResults|actionInput|capabilityId|confirmationToken)"\s*:/i.test(compact)
    || (/"mode"\s*:/i.test(compact) && /"(?:oscar|monarch|capabilities|workspaceRoot)"\s*:/i.test(compact));
}

function renderOscarMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let listType = '';
  let listItems = [];
  let listStart = 1;
  let displayMath = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${renderOscarInline(paragraph.join('\n'))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) return;
    const startAttribute = listType === 'ol' && listStart > 1 ? ` start="${listStart}"` : '';
    blocks.push(`<${listType}${startAttribute}>${listItems.map(item => `<li>${renderOscarInline(item)}</li>`).join('')}</${listType}>`);
    listType = '';
    listItems = [];
    listStart = 1;
  };

  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    const line = rawLine.trim();

    if (displayMath !== null) {
      const closeIndex = line.indexOf('$$');
      if (closeIndex >= 0) {
        displayMath.push(line.slice(0, closeIndex));
        blocks.push(`<div class="oscar-math-block" role="math">${renderOscarMath(displayMath.join(' '))}</div>`);
        displayMath = null;
        const remainder = line.slice(closeIndex + 2).trim();
        if (remainder) paragraph.push(remainder);
      } else {
        displayMath.push(line);
      }
      continue;
    }

    if (!line) {
      flushTextBlocks();
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushTextBlocks();
      blocks.push('<hr>');
      continue;
    }

    const tableHeader = parseOscarMarkdownTableRow(line);
    const tableDivider = parseOscarMarkdownTableRow(lines[lineIndex + 1] || '');
    if (tableHeader && isOscarMarkdownTableDivider(tableDivider, tableHeader.length)) {
      flushTextBlocks();
      const rows = [];
      lineIndex += 2;
      while (lineIndex < lines.length) {
        const row = parseOscarMarkdownTableRow(lines[lineIndex]);
        if (!row) {
          lineIndex -= 1;
          break;
        }
        rows.push(normalizeOscarTableRow(row, tableHeader.length));
        lineIndex += 1;
      }
      if (lineIndex >= lines.length) lineIndex = lines.length;
      blocks.push(renderOscarTable(tableHeader, rows));
      continue;
    }

    if (line.startsWith('$$')) {
      flushTextBlocks();
      const mathLine = line.slice(2);
      const closeIndex = mathLine.indexOf('$$');
      if (closeIndex >= 0) {
        blocks.push(`<div class="oscar-math-block" role="math">${renderOscarMath(mathLine.slice(0, closeIndex))}</div>`);
        const remainder = mathLine.slice(closeIndex + 2).trim();
        if (remainder) paragraph.push(remainder);
      } else {
        displayMath = [mathLine];
      }
      continue;
    }

    if (looksLikePlainMath(line)) {
      flushTextBlocks();
      blocks.push(`<div class="oscar-math-block" role="math">${renderOscarMath(line)}</div>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushTextBlocks();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderOscarInline(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = unordered ? 'ul' : 'ol';
      if (listType && listType !== nextType) flushList();
      if (!listType && ordered) listStart = Number(ordered[1]) || 1;
      listType = nextType;
      listItems.push(unordered ? unordered[1] : ordered[2]);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushTextBlocks();
      blocks.push(`<blockquote>${renderOscarInline(quote[1])}</blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(`${line}${/ {2,}$/.test(rawLine) ? '  ' : ''}`);
  }

  if (displayMath !== null) {
    blocks.push(`<div class="oscar-math-block" role="math">${renderOscarMath(displayMath.join(' '))}</div>`);
  }
  flushTextBlocks();
  return blocks.join('');
}

function parseOscarMarkdownTableRow(source) {
  let row = String(source || '').trim();
  if (!row.includes('|')) return null;
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  const cells = row.split('|').map(cell => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isOscarMarkdownTableDivider(cells, expectedColumns) {
  return Array.isArray(cells)
    && cells.length === expectedColumns
    && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function normalizeOscarTableRow(cells, columns) {
  return Array.from({ length: columns }, (_unused, index) => cells[index] || '');
}

function renderOscarTable(header, rows) {
  return `<div class="oscar-table-wrap"><table class="oscar-table"><thead><tr>${header.map(cell => `<th>${renderOscarInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${renderOscarInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderOscarInline(source) {
  const tokens = [];
  const hold = (html) => {
    const marker = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return marker;
  };

  let text = String(source || '');
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => hold(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\\\(([^\n]+?)\\\)/g, (_match, formula) => hold(`<span class="oscar-math-inline" role="math">${renderOscarMath(formula)}</span>`));
  text = text.replace(/\\\[([^\n]+?)\\\]/g, (_match, formula) => hold(`<span class="oscar-math-inline" role="math">${renderOscarMath(formula)}</span>`));
  text = text.replace(/\$(?!\$)([^$\n]+)\$/g, (_match, formula) => hold(`<span class="oscar-math-inline" role="math">${renderOscarMath(formula)}</span>`));
  text = text.replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) =>
    hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`));

  let html = escapeHtml(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  html = html.replace(/([\p{L}\p{N})\]])\s*\*\s*([\p{L}\p{N}(\[])/gu, '$1 × $2');
  html = html.replace(/\+\/-/g, '±').replace(/&lt;=/g, '≤').replace(/&gt;=/g, '≥').replace(/-&gt;/g, '→');
  html = html.replace(/ {2}\n/g, '<br>');
  html = html.replace(/\n/g, ' ');
  return html.replace(/\uE000(\d+)\uE001/g, (_match, index) => tokens[Number(index)] || '');
}

function renderOscarMath(source) {
  const formula = normalizePlainMathSource(String(source || '').trim());
  const equation = splitMathEquationFraction(formula);
  if (equation) {
    const prefix = equation.prefix ? `${renderMathSequence(equation.prefix)} = ` : '';
    return `${prefix}<span class="oscar-math-frac"><span>${renderMathSequence(equation.numerator)}</span><span>${renderMathSequence(equation.denominator)}</span></span>`;
  }
  return renderMathSequence(formula);
}

function renderMathSequence(source) {
  const symbols = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ', lambda: 'λ',
    mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', phi: 'φ', omega: 'ω',
    Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', cdot: '·', times: '×', approx: '≈',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', infty: '∞', pm: '±',
    to: '→', rightarrow: '→', leftarrow: '←', degree: '°', div: '÷',
  };
  let html = '';
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('+/-', index)) { html += '±'; index += 3; continue; }
    if (source.startsWith('<=', index)) { html += '≤'; index += 2; continue; }
    if (source.startsWith('>=', index)) { html += '≥'; index += 2; continue; }
    if (source.startsWith('!=', index)) { html += '≠'; index += 2; continue; }
    if (source.startsWith('->', index)) { html += '→'; index += 2; continue; }
    if (source[index] === '\\') {
      const command = /^\\([A-Za-z]+)/.exec(source.slice(index));
      if (!command) { html += '\\'; index += 1; continue; }
      const name = command[1];
      index += command[0].length;
      if (name === 'frac') {
        const numerator = readMathGroup(source, index);
        const denominator = numerator ? readMathGroup(source, numerator.next) : null;
        if (numerator && denominator) {
          html += `<span class="oscar-math-frac"><span>${renderMathSequence(numerator.content)}</span><span>${renderMathSequence(denominator.content)}</span></span>`;
          index = denominator.next;
          continue;
        }
      }
      if (name === 'sqrt') {
        const radicand = readMathGroup(source, index);
        if (radicand) {
          html += `<span class="oscar-math-sqrt"><span aria-hidden="true">√</span><span>${renderMathSequence(radicand.content)}</span></span>`;
          index = radicand.next;
          continue;
        }
      }
      if (name === 'text' || name === 'mathrm') {
        const text = readMathGroup(source, index);
        if (text) {
          html += `<span class="oscar-math-text">${escapeHtml(text.content)}</span>`;
          index = text.next;
          continue;
        }
      }
      html += symbols[name] || escapeHtml(`\\${name}`);
      continue;
    }
    if (source[index] === '^' || source[index] === '_') {
      const tag = source[index] === '^' ? 'sup' : 'sub';
      const group = readMathGroup(source, index + 1, true);
      if (group) {
        html += `<${tag}>${renderMathSequence(group.content)}</${tag}>`;
        index = group.next;
        continue;
      }
    }
    if (source[index] === '{') {
      const group = readMathGroup(source, index);
      if (group) {
        html += renderMathSequence(group.content);
        index = group.next;
        continue;
      }
    }
    if (source[index] === '*') { html += '×'; index += 1; continue; }
    html += escapeHtml(source[index]);
    index += 1;
  }
  return html;
}

function readMathGroup(source, start, allowSingle = false) {
  while (source[start] === ' ') start += 1;
  if (source[start] !== '{') {
    return allowSingle && source[start]
      ? { content: source[start], next: start + 1 }
      : null;
  }
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { content: source.slice(start + 1, index), next: index + 1 };
  }
  return null;
}

function normalizePlainMathSource(source) {
  let result = source.replace(/\*\*/g, '^');
  let index = 0;
  while ((index = result.search(/\bsqrt\s*\(/i)) >= 0) {
    const open = result.indexOf('(', index);
    const close = findMatchingParen(result, open);
    if (close < 0) break;
    result = `${result.slice(0, index)}\\sqrt{${result.slice(open + 1, close)}}${result.slice(close + 1)}`;
  }
  return result;
}

function findMatchingParen(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function splitMathEquationFraction(source) {
  const equals = source.indexOf('=');
  const prefix = equals >= 0 ? source.slice(0, equals).trim() : '';
  const expression = equals >= 0 ? source.slice(equals + 1).trim() : source;
  const slash = findTopLevelSlash(expression);
  if (slash < 0) return null;
  const numerator = stripOuterParens(expression.slice(0, slash).trim());
  const denominator = stripOuterParens(expression.slice(slash + 1).trim());
  if (!numerator || !denominator) return null;
  return { prefix, numerator, denominator };
}

function findTopLevelSlash(source) {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ('({['.includes(source[index])) depth += 1;
    if (')}]'.includes(source[index])) depth = Math.max(0, depth - 1);
    if (source[index] === '/' && depth === 0) return index;
  }
  return -1;
}

function stripOuterParens(source) {
  let result = source.trim();
  while (result.startsWith('(') && findMatchingParen(result, 0) === result.length - 1) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function looksLikePlainMath(line) {
  const value = String(line || '').trim();
  if (value.length < 3 || value.length > 180 || !/[=≈≤≥]/.test(value)) return false;
  if (/https?:\/\//i.test(value) || /<[^>]*>/.test(value)) return false;
  const proseWords = value.match(/[А-Яа-яЁё]{4,}/g) || [];
  return proseWords.length <= 2 && /(?:\^|\*|\/|sqrt\s*\(|√|[+−-]\s*\d|\\frac|\\sqrt)/i.test(value);
}

export function parseCodeCanvasesFromText(text, sourceLabel = 'Ответ модели') {
  const sourceText = String(text || '');
  const blocks = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
  let match;

  while ((match = pattern.exec(sourceText)) !== null) {
    const code = String(match[2] || '');
    if (!code.trim()) {
      continue;
    }
    blocks.push({
      language: String(match[1] || 'code').trim() || 'code',
      code,
      sourceLabel,
      complete: match[3] === '```',
    });
  }

  return blocks;
}

export function summarizeOutput(output) {
  if (!output) {
    return '';
  }

  const securityPayload = output?.payload && typeof output.payload === 'object' ? output.payload : output;
  if (typeof securityPayload?.running === 'boolean' || typeof securityPayload?.protection_state === 'string') {
    const running = securityPayload.running === true;
    const protectedNow = securityPayload.protection_state === 'protected';
    const profile = securityPayload.profile && typeof securityPayload.profile === 'object'
      ? securityPayload.profile
      : {};
    const incidents = securityPayload.incidents && typeof securityPayload.incidents === 'object'
      ? securityPayload.incidents
      : {};
    const modelPolicy = securityPayload.model_policy && typeof securityPayload.model_policy === 'object'
      ? securityPayload.model_policy
      : {};
    const sensorCount = Number(securityPayload.heartbeat?.sensor_count ?? securityPayload.sensor_count ?? 0);
    const rows = [
      `Защита: ${running ? (protectedNow ? 'работает, состояние защищено' : 'работает, требуется внимание') : 'остановлена'}`,
      profile.label || profile.level ? `Профиль: ${profile.label || profile.level}` : '',
      sensorCount > 0 ? `Активных датчиков: ${sensorCount}` : '',
      Number.isFinite(Number(incidents.open)) ? `Открытых инцидентов: ${Number(incidents.open)}` : '',
      Number.isFinite(Number(incidents.decision_required)) ? `Ожидают решения: ${Number(incidents.decision_required)}` : '',
      typeof modelPolicy.enabled === 'boolean'
        ? `Команды Oscar: ${modelPolicy.enabled ? 'разрешены' : 'отключены'}${modelPolicy.enabled ? ` · подтверждение ${modelPolicy.confirmation_mode === 'always' ? 'всегда' : 'по уровню риска'}` : ''}`
        : '',
    ].filter(Boolean);
    return `${running && protectedNow ? 'Monarch Security работает штатно.' : running ? 'Monarch Security работает, но требует внимания.' : 'Monarch Security сейчас остановлен.'}\n\n${rows.map((row) => `- ${row}`).join('\n')}`;
  }
  if (Array.isArray(securityPayload?.scans) && securityPayload?.summary && typeof securityPayload.summary === 'object') {
    const summary = securityPayload.summary;
    const processScan = securityPayload.scans.find((scan) => scan?.name === 'processes');
    const processResults = Array.isArray(processScan?.results) ? processScan.results : [];
    const processHigh = processResults.filter((item) => Number(item?.assessment?.score || 0) >= 65);
    const processMedium = processResults.filter((item) => Number(item?.assessment?.score || 0) >= 35).length;
    const processNames = processHigh
      .map((item) => previewPath(item?.assessment?.event?.subject || 'неизвестный процесс'))
      .filter(Boolean)
      .slice(0, 5);
    const highTotal = Number(summary.high_or_higher || 0);
    const rows = [
      Number.isFinite(processScan?.events) ? `Проверено текущих процессов: ${processScan.events}` : '',
      `Процессов среднего риска или выше: ${processMedium}`,
      `Процессов высокого риска: ${processHigh.length}`,
      `Всего системных событий проверено: ${Number(summary.events || 0)}`,
      `Событий высокого риска во всех сенсорах: ${highTotal}`,
    ].filter(Boolean);
    const findings = processNames.length > 0
      ? `\n\nПроцессы, требующие внимания:\n${processNames.map((name) => `- ${name}`).join('\n')}`
      : '';
    return `${processHigh.length > 0 ? 'Обнаружены процессы, требующие дополнительной проверки.' : 'Процессов с высоким уровнем риска не обнаружено.'}\n\n${rows.map((row) => `- ${row}`).join('\n')}${findings}`;
  }
  if (securityPayload?.summary && typeof securityPayload.summary === 'object') {
    const summary = securityPayload.summary;
    const rows = [
      Number.isFinite(summary.active_connections) ? `Активных подключений: ${summary.active_connections}` : '',
      Number.isFinite(summary.listeners) ? `Слушающих портов: ${summary.listeners}` : '',
      Number.isFinite(summary.neighbors) ? `Сетевых соседей: ${summary.neighbors}` : '',
      Number.isFinite(summary.profiles) ? `Сетевых профилей: ${summary.profiles}` : '',
      Number.isFinite(summary.untrusted_profiles) ? `Не отмечено доверенными профилей: ${summary.untrusted_profiles}` : '',
      Number.isFinite(summary.high_attention) ? `Требуют повышенного внимания: ${summary.high_attention}` : '',
    ].filter(Boolean);
    if (rows.length > 0) {
      const highAttention = Number(summary.high_attention || 0);
      return `${highAttention > 0 ? 'Есть сетевые элементы, требующие внимания.' : 'Опасных сетевых подключений с высоким уровнем риска не обнаружено.'}\n\n${rows.map((row) => `- ${row}`).join('\n')}`;
    }
  }

  if (typeof output.workspaceRoot === 'string' && output.workspaceRoot.trim()) {
    return `Точный путь рабочего пространства: \`${output.workspaceRoot.trim()}\``;
  }
  if (typeof output.path === 'string' && output.path.trim() && typeof output.content !== 'string') {
    const details = [
      Number.isFinite(output.bytes) ? `${output.bytes} байт` : '',
      output.alreadyExists ? 'уже существовало' : '',
    ].filter(Boolean).join(' · ');
    return `Путь: \`${output.path.trim()}\`${details ? `\n${details}` : ''}`;
  }

  if (output.record?.text) {
    return `memory.record: ${output.record.text}`;
  }
  if (Array.isArray(output.records)) {
    return `${output.records.length} записей памяти\n${output.records.map((record) => `- ${record.text}`).slice(0, 4).join('\n')}`;
  }
  if (Array.isArray(output.modules)) {
    return `${output.modules.length} modules\n${output.modules.map((module) => `- ${module.id || module.moduleId || module.name}`).slice(0, 8).join('\n')}`;
  }
  if (Array.isArray(output.capabilities)) {
    return `${output.capabilities.length} ${pluralRu(output.capabilities.length, 'возможность', 'возможности', 'возможностей')}\n${
      output.capabilities
        .map((capability) => `- ${capability.id || capability.title || capability.moduleId || 'capability'}${capability.risk ? ` · ${capability.risk}` : ''}`)
        .slice(0, 12)
        .join('\n')
    }`;
  }
  if (Array.isArray(output.matches)) {
    const query = output.query ? ` по "${output.query}"` : '';
    const lines = output.matches
      .map((match) => `- ${previewPath(match.path)}${match.line ? `:${match.line}` : ''} ${match.preview || ''}`.trim())
      .slice(0, 12)
      .join('\n');
    return `${output.matches.length} ${pluralRu(output.matches.length, 'совпадение', 'совпадения', 'совпадений')}${query}${lines ? `\n${lines}` : ''}`;
  }
  if (Array.isArray(output.entries)) {
    return `${output.entries.length} ${pluralRu(output.entries.length, 'элемент', 'элемента', 'элементов')}\n${
      output.entries
        .map((entry) => `- ${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.name || previewPath(entry.path)}`)
        .slice(0, 20)
        .join('\n')
    }`;
  }
  if (typeof output.content === 'string' && output.path) {
    const header = `Файл: ${previewPath(output.path)}${Number.isFinite(output.sizeBytes) ? ` · ${output.sizeBytes} байт` : ''}`;
    return `${header}\n${output.content.slice(0, 1200)}`;
  }
  if (Array.isArray(output.pipeline)) {
    return output.pipeline.map((step) => `${step.label}: ${step.status}`).slice(0, 8).join('\n');
  }

  try {
    return JSON.stringify(output, null, 2).slice(0, 640);
  } catch {
    return String(output);
  }
}

function previewPath(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .filter((part) => !/^[A-Za-z]:$/.test(part))
    .slice(-4)
    .join('/');
}

function pluralRu(count, one, few, many) {
  const mod10 = Math.abs(count) % 10;
  const mod100 = Math.abs(count) % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return one;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return few;
  }
  return many;
}

export function statusPill(label, color, options = {}) {
  const ariaLabel = options.ariaLabel || '';
  const title = options.title || ariaLabel;
  const ariaAttr = ariaLabel ? ` aria-label="${escapeHtml(ariaLabel)}"` : '';
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="pill ${escapeHtml(color)}"${ariaAttr}${titleAttr}><span class="dot"></span><span class="pill-label">${escapeHtml(label)}</span></span>`;
}

export function keyValueRow(label, value) {
  return `
    <div class="key-value-row">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

export function miniMeta(label, value) {
  return `
    <span>
      <small>${escapeHtml(label)}</small>
      ${escapeHtml(value)}
    </span>
  `;
}

export function metricCard(value, label) {
  return `
    <div class="metric-card">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

export function previewItem(label, value) {
  return `
    <div class="preview-item">
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

export function routeSummaryState(lastIntent) {
  if (!lastIntent) {
    return { label: 'Готов', tone: 'idle' };
  }
  if (!lastIntent.route) {
    return { label: 'Без маршрута', tone: 'blocked' };
  }
  if (lastIntent.execution?.error === 'confirmation-required') {
    return { label: 'Нужно подтверждение', tone: 'amber' };
  }
  if (lastIntent.execution?.ok) {
    return { label: 'Выполнено', tone: 'green' };
  }
  if (lastIntent.execution?.error) {
    return { label: 'Сбой выполнения', tone: 'red' };
  }
  return { label: 'Маршрут найден', tone: 'green' };
}

export function confirmationBanner(text, confirmation, plan = null) {
  const token = confirmation?.token || '';
  const writeStep = plan?.steps?.find((step) => step.capabilityId === 'workspace.files.write');

  if (writeStep) {
    const filename = writeStep.input.path.split(/[/\\]/).pop() || writeStep.input.path;
    return `
      <div class="permission-banner workspace-write-confirm">
        <div>
          <strong>Подтверждение записи файла</strong>
          <p>Обнаружен запрос на изменение файла <code>${escapeHtml(filename)}</code> в рабочей области.</p>
        </div>

        <div class="diff-preview-wrapper">
          <div class="diff-preview-header">
            <span>Предосмотр изменений: ${escapeHtml(writeStep.input.path)}</span>
          </div>
          <div id="diff-preview-container" class="diff-preview-content loading">
            <span class="spinner"></span> Вычисление diff-превью...
          </div>
        </div>

        <div class="button-row">
          <button class="primary-button" type="button" data-testid="confirm-intent" data-intent="${escapeHtml(text)}" data-confirm="true" data-confirmation-token="${escapeHtml(token)}">Подтвердить запись</button>
          <button class="secondary-button" type="button" data-testid="cancel-intent">Отмена</button>
        </div>
      </div>
    `;
  }

  const reason = confirmation?.reason || 'Действие требует явного подтверждения пользователя.';
  return `
    <div class="permission-banner">
      <div>
        <strong>Нужно подтверждение</strong>
        <p>${escapeHtml(reason)}</p>
      </div>
      <div class="button-row">
        <button class="primary-button" type="button" data-testid="confirm-intent" data-intent="${escapeHtml(text)}" data-confirm="true" data-confirmation-token="${escapeHtml(token)}">Подтвердить</button>
        <button class="secondary-button" type="button" data-testid="cancel-intent">Отмена</button>
      </div>
    </div>
  `;
}

export function computeInlineDiff(oldText, newText) {
  const oldLines = oldText ? oldText.split(/\r?\n/) : [];
  const newLines = newText ? newText.split(/\r?\n/) : [];

  if (oldLines.length === 0 && newLines.length === 0) {
    return '<div class="diff-line empty">Файл пуст</div>';
  }

  if (oldLines.length === 0) {
    return newLines.map(line => `<div class="diff-line added">+ ${escapeHtml(line)}</div>`).join('');
  }

  let diffHtml = '';
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length) {
      if (oldLines[i] === newLines[j]) {
        diffHtml += `<div class="diff-line unchanged">  ${escapeHtml(oldLines[i])}</div>`;
        i++;
        j++;
      } else {
        let foundMatch = false;
        for (let k = 1; k < 5; k++) {
          if (i + k < oldLines.length && oldLines[i + k] === newLines[j]) {
            for (let d = 0; d < k; d++) {
              diffHtml += `<div class="diff-line deleted">- ${escapeHtml(oldLines[i + d])}</div>`;
            }
            i += k;
            foundMatch = true;
            break;
          }
          if (j + k < newLines.length && oldLines[i] === newLines[j + k]) {
            for (let a = 0; a < k; a++) {
              diffHtml += `<div class="diff-line added">+ ${escapeHtml(newLines[j + a])}</div>`;
            }
            j += k;
            foundMatch = true;
            break;
          }
        }
        if (!foundMatch) {
          diffHtml += `<div class="diff-line deleted">- ${escapeHtml(oldLines[i])}</div>`;
          diffHtml += `<div class="diff-line added">+ ${escapeHtml(newLines[j])}</div>`;
          i++;
          j++;
        }
      }
    } else if (i < oldLines.length) {
      diffHtml += `<div class="diff-line deleted">- ${escapeHtml(oldLines[i])}</div>`;
      i++;
    } else if (j < newLines.length) {
      diffHtml += `<div class="diff-line added">+ ${escapeHtml(newLines[j])}</div>`;
      j++;
    }
  }
  return diffHtml;
}

export function createOscarMessage(role, content, label, meta = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    role,
    content,
    label,
    reasoning: meta.reasoning || '',
    pending: meta.pending || false,
    error: meta.error || false,
    sources: meta.sources || [],
    streamEvents: Array.isArray(meta.streamEvents) ? meta.streamEvents : [],
    streamPhase: typeof meta.streamPhase === 'string' ? meta.streamPhase : '',
    researchFlow: meta.researchFlow === true,
    routeConsent: meta.routeConsent && typeof meta.routeConsent === 'object' ? { ...meta.routeConsent } : null,
    usage: meta.usage && typeof meta.usage === 'object' ? meta.usage : null,
    showTrace: meta.showTrace === true,
    sendActive: meta.sendActive === true,
    action: meta.action || null,
    attachments: Array.isArray(meta.attachments) ? meta.attachments : [],
    createdAt: typeof meta.createdAt === 'string' && meta.createdAt ? meta.createdAt : new Date().toISOString()
  };
}

export function replacePendingOscarMessage(newMessage) {
  if (!state.oscar) {
    state.oscar = { messages: [] };
  }
  const messages = state.oscar.messages || [];
  const pendingIndex = messages.findIndex(m => m.pending);
  if (pendingIndex !== -1) {
    const pendingMessage = messages[pendingIndex];
    const pendingId = pendingMessage?.id;
    messages[pendingIndex] = pendingId
      ? { ...newMessage, id: pendingId, createdAt: pendingMessage.createdAt || newMessage.createdAt }
      : newMessage;
  } else {
    messages.push(newMessage);
  }
  state.oscar.messages = messages;
}

export function syncThreadDOM(container, newHtml) {
  if (!container) return;
  const template = document.createElement('div');
  template.innerHTML = newHtml;
  if (container.children.length === 0 || container.querySelector('.oscar-empty-focus') || container.querySelector('.empty-state')) {
    container.innerHTML = newHtml;
    return;
  }

  // A token must only change text nodes. Replacing a card's innerHTML here
  // restarts its CSS entrance animation and makes the whole answer flicker.
  syncDomChildren(container, template);
}

function syncDomChildren(currentParent, nextParent) {
  const currentNodes = Array.from(currentParent.childNodes);
  const nextNodes = Array.from(nextParent.childNodes);
  const sharedLength = Math.min(currentNodes.length, nextNodes.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const currentNode = currentNodes[index];
    const nextNode = nextNodes[index];
    if (!canSyncDomNode(currentNode, nextNode)) {
      currentNode.replaceWith(nextNode.cloneNode(true));
      continue;
    }
    if (currentNode.nodeType === Node.TEXT_NODE) {
      if (currentNode.nodeValue !== nextNode.nodeValue) currentNode.nodeValue = nextNode.nodeValue;
      continue;
    }
    if (currentNode.nodeType !== Node.ELEMENT_NODE) {
      if (currentNode.nodeValue !== nextNode.nodeValue) currentNode.nodeValue = nextNode.nodeValue;
      continue;
    }
    syncDomAttributes(currentNode, nextNode);
    syncDomChildren(currentNode, nextNode);
  }

  for (let index = sharedLength; index < nextNodes.length; index += 1) {
    currentParent.append(nextNodes[index].cloneNode(true));
  }
  for (let index = currentNodes.length - 1; index >= nextNodes.length; index -= 1) {
    currentNodes[index].remove();
  }
}

function canSyncDomNode(currentNode, nextNode) {
  if (currentNode.nodeType !== nextNode.nodeType) return false;
  if (currentNode.nodeType !== Node.ELEMENT_NODE) return true;
  if (currentNode.tagName !== nextNode.tagName) return false;
  const currentId = currentNode.getAttribute('data-message-id');
  const nextId = nextNode.getAttribute('data-message-id');
  return !currentId || !nextId || currentId === nextId;
}

function syncDomAttributes(currentElement, nextElement) {
  for (const attribute of Array.from(currentElement.attributes)) {
    if (!nextElement.hasAttribute(attribute.name)) currentElement.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(nextElement.attributes)) {
    if (currentElement.getAttribute(attribute.name) !== attribute.value) {
      currentElement.setAttribute(attribute.name, attribute.value);
    }
  }
}

export function renderOscarMessage(message) {
  const isUser = message.role === 'user';
  const pendingClass = message.pending ? 'pending' : '';
  const errorClass = message.error ? 'error' : '';
  const streamPhase = message.pending ? inferOscarStreamPhase(message) : '';
  const streamPhaseAttr = streamPhase ? ` data-stream-phase="${escapeHtml(streamPhase)}"` : '';
  const routeConsentClass = message.pending && message.routeConsent ? ' route-consent' : '';
  const researchFlowClass = message.pending && message.researchFlow ? ' research-flow' : '';

  if (isUser) {
    const sendActiveAttr = message.sendActive ? ' data-send-active="true"' : '';
    const sendSyncHtml = message.sendActive
      ? `<span class="message-send-sync" aria-hidden="true">${Array.from({ length: 8 }).map(() => '<span></span>').join('')}</span>`
      : '';
    const attachmentsHtml = Array.isArray(message.attachments) && message.attachments.length
      ? `<div class="message-attachments">${message.attachments.map((attachment) => {
          const source = attachment.preview_url || `data:${attachment.mime_type};base64,${attachment.data_base64}`;
          return `<img src="${escapeHtml(source)}" alt="${escapeHtml(attachment.name || 'Изображение')}">`;
        }).join('')}</div>`
      : '';
    return `
      <div class="oscar-message user" data-message-id="${escapeHtml(message.id)}"${sendActiveAttr}>
        <div class="oscar-message-card">
          <div class="message-meta-row">
            <div class="message-meta">${escapeHtml(message.label || 'ты')}${sendSyncHtml}</div>
            <div class="oscar-message-actions">
              <button type="button" data-message-copy="${escapeHtml(message.id)}" aria-label="Копировать сообщение" title="Копировать сообщение">${copyIcon()}</button>
              <button type="button" data-message-edit="${escapeHtml(message.id)}" aria-label="Редактировать сообщение" title="Редактировать сообщение">${editIcon()}</button>
            </div>
          </div>
          ${attachmentsHtml}
          <div class="message-text">${escapeHtml(message.content)}</div>
        </div>
      </div>
    `;
  } else {
    const visibleContent = String(message.content || '').trim();
    const workTimerHtml = renderOscarWorkTimer(message);
    const isThinkingOnly = message.pending
      && !visibleContent
      && !message.error
      && !message.action
      && !message.routeConsent
      && !message.researchFlow;
    if (isThinkingOnly) {
      const thinkingLabel = formatOscarStreamPhase(streamPhase);
      return `
        <div class="oscar-message assistant pending thinking-only" data-message-id="${escapeHtml(message.id)}"${streamPhaseAttr}>
          ${workTimerHtml}
          <div class="oscar-thinking-only" role="status" aria-label="${escapeHtml(thinkingLabel)}">
            <span class="oscar-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="oscar-thinking-copy">
              <strong>${escapeHtml(thinkingLabel)}</strong>
              <small>${escapeHtml(formatOscarStreamHint(streamPhase))}</small>
            </span>
          </div>
        </div>
      `;
    }

    const sourcesHtml = Array.isArray(message.sources) && message.sources.length > 0
      ? `<div class="source-list">
           ${message.sources.map(s => `
             <span class="source-chip" title="${escapeHtml(typeof s === 'string' ? s : s.url || s.snippet || '')}">
               ${escapeHtml(typeof s === 'string' ? s : s.title || s.url || 'source')}
             </span>
           `).join('')}
         </div>`
      : '';

    const reasoningHtml = message.showTrace && message.reasoning
      ? `<details class="oscar-reasoning-block" ${message.pending ? 'open' : ''}>
           <summary>Рассуждение модели</summary>
           <div class="oscar-reasoning-content" style="white-space: pre-wrap; font-size: 0.9em; opacity: 0.8; margin-top: 8px;">${escapeHtml(message.reasoning)}</div>
         </details>`
      : '';

    const streamEventsHtml = message.showTrace && message.pending && Array.isArray(message.streamEvents) && message.streamEvents.length > 0
      ? `<div class="oscar-stream-trace" aria-label="Ход генерации">
           ${message.streamEvents.slice(-5).map((event) => {
             const label = event?.label || event?.kind || 'событие';
             const detail = event?.detail || label;
             return `
               <span class="oscar-stream-event" title="${escapeHtml(detail)}">
                 <span class="oscar-stream-dot"></span>${escapeHtml(label)}
               </span>
             `;
           }).join('')}
         </div>`
      : '';

    const liveStageHtml = message.pending && !message.routeConsent
      ? renderOscarLiveStage(message, streamPhase)
      : '';

    const routeConsentHtml = message.pending && message.routeConsent
      ? renderOscarRouteConsent(message.routeConsent)
      : '';

    const grantOptions = Array.isArray(message.action?.grantOptions) ? message.action.grantOptions : ['once'];
    const actionButtons = grantOptions.map((scope) => `<button type="button" class="claude-primary-btn" data-oscar-confirm-action data-message-id="${escapeHtml(message.id)}" data-action-text="${escapeHtml(message.action?.text || '')}" data-confirmation-token="${escapeHtml(message.action?.confirmationToken || '')}" data-grant-scope="${scope === 'task' ? 'task' : 'once'}">${scope === 'task' ? 'Разрешить для задачи' : escapeHtml(message.action?.label || 'Разрешить один раз')}</button>`).join('');
    const actionHtml = message.action?.confirmationToken
      ? `<div class="oscar-action-card">
           <div>
             <strong>Monarch Access</strong>
             <span>${escapeHtml(message.action.risk || 'действие')} · точная область, бюджет и срок контролируются Policy Kernel</span>
           </div>
           <div class="oscar-action-buttons">${actionButtons}</div>
         </div>`
      : '';

    const usageHtml = !message.pending && !message.error ? renderOscarUsage(message.usage) : '';
    const modelNoteHtml = renderOscarModelNote(message, streamPhase);
    const speechHtml = !message.pending && !message.error && visibleContent
      ? `<div class="oscar-speech-actions">
           <button type="button" class="oscar-speech-button" data-message-speak="${escapeHtml(message.id)}" data-speech-state="idle" aria-label="Озвучить весь ответ Oscar" aria-pressed="false" title="Озвучить весь ответ Oscar">
             ${speakerIcon()}
           </button>
           <span class="oscar-speech-status" data-speech-status="${escapeHtml(message.id)}" role="status" aria-live="polite"></span>
         </div>`
      : '';

    const contentHtml = message.pending
      ? `<div class="oscar-text-part oscar-streaming-text">${escapeHtml(sanitizeVisibleAssistantContent(message.content))}</div>`
      : formatOscarContent(message.content);

    return `
      <div class="oscar-message assistant ${pendingClass} ${errorClass}${routeConsentClass}${researchFlowClass}" data-message-id="${escapeHtml(message.id)}"${streamPhaseAttr}>
        ${workTimerHtml}
        <div class="avatar oscar-avatar">O</div>
        <div class="oscar-message-card">
          <div class="message-meta-row">
            <div class="message-meta">Oscar</div>
            <div class="oscar-message-actions">
              <button type="button" data-message-copy="${escapeHtml(message.id)}" aria-label="Копировать ответ Oscar" title="Копировать ответ Oscar">${copyIcon()}</button>
            </div>
          </div>
          ${reasoningHtml}
          ${streamEventsHtml}
          ${routeConsentHtml}
          ${liveStageHtml}
          <div class="message-text">${contentHtml}</div>
          ${speechHtml}
          ${modelNoteHtml}
          ${actionHtml}
          ${sourcesHtml}
          ${usageHtml}
        </div>
      </div>
    `;
  }
}

function renderOscarLiveStage(message, phase) {
  const label = formatOscarStreamPhase(phase);
  const researchTimeline = message.researchFlow ? renderOscarResearchTimeline(phase) : '';
  return `
    <div class="oscar-research-activity">
      <div class="oscar-live-stage" data-phase="${escapeHtml(phase || 'route')}" aria-label="${escapeHtml(label)}" aria-live="polite">
        <span class="oscar-live-rail" aria-hidden="true">
          ${Array.from({ length: 8 }).map(() => '<span></span>').join('')}
        </span>
        <span class="oscar-live-copy">
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(formatOscarStreamHint(phase))}</small>
        </span>
        ${message.researchFlow ? '<span class="oscar-research-live-badge">в процессе</span>' : ''}
      </div>
      ${researchTimeline}
    </div>
  `;
}

const OSCAR_RESEARCH_STEPS = [
  { label: 'План', phases: ['route', 'research-plan'] },
  { label: 'Источники', phases: ['research-search'] },
  { label: 'Чтение', phases: ['research-read'] },
  { label: 'Синтез', phases: ['research-synthesize'] },
  { label: 'Проверка', phases: ['research-reflect', 'research-verify', 'research-revise'] },
  { label: 'Итог', phases: ['research-finalize', 'write'] },
];

function renderOscarResearchTimeline(phase, options = {}) {
  const normalizedPhase = String(phase || 'route');
  const requestedIndex = OSCAR_RESEARCH_STEPS.findIndex((step) => step.phases.includes(normalizedPhase));
  const currentIndex = Number.isInteger(options.currentIndex)
    ? Math.max(0, Math.min(options.currentIndex, OSCAR_RESEARCH_STEPS.length - 1))
    : Math.max(0, requestedIndex);
  const waiting = options.waiting === true;
  return `
    <ol class="oscar-research-timeline" aria-label="Этапы исследования">
      ${OSCAR_RESEARCH_STEPS.map((step, index) => {
        const state = waiting ? 'upcoming' : index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
        return `
          <li data-step-state="${state}"${state === 'current' ? ' aria-current="step"' : ''}>
            <span>${String(index + 1).padStart(2, '0')}</span>
            <strong>${escapeHtml(step.label)}</strong>
          </li>
        `;
      }).join('')}
    </ol>
  `;
}

function renderOscarRouteConsent(consent) {
  const state = ['accepted', 'denied'].includes(consent.state) ? consent.state : 'waiting';
  const webSearch = consent.webSearch === true;
  const pro = consent.pro === true;
  const title = state === 'accepted'
    ? webSearch ? 'Исследование запускается' : 'Pro включён для этого ответа'
    : state === 'denied'
      ? webSearch ? 'Отвечаю без исследования' : 'Остаюсь на Medium'
      : String(consent.title || 'Подтвердить выбранный маршрут?');
  const description = state === 'waiting'
    ? String(consent.description || '')
    : state === 'accepted'
      ? webSearch ? 'Готовлю план и подключаю публичные источники.' : 'Продолжаю на более глубокой модели.'
      : webSearch ? 'Интернет-доступ не используется для этого ответа.' : 'Продолжаю без переключения модели.';
  const chips = [
    webSearch ? 'Публичные источники' : 'Локальная модель',
    webSearch ? 'Несколько проходов' : pro ? 'Глубокий анализ' : 'Обычный ответ',
    'Только один ответ',
  ];
  return `
    <section class="oscar-inline-consent" data-consent-state="${state}" aria-label="${escapeHtml(webSearch ? 'Подтверждение исследования' : 'Выбор модели')}">
      <div class="oscar-inline-consent-heading">
        <span class="oscar-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>
          <small>Oscar · ${webSearch ? 'исследование' : 'маршрут ответа'}</small>
          <strong>${escapeHtml(title)}</strong>
        </span>
      </div>
      <p>${escapeHtml(description)}</p>
      <div class="oscar-consent-chips" aria-label="Параметры маршрута">
        ${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join('')}
      </div>
      ${webSearch ? renderOscarResearchTimeline('route', { waiting: state === 'waiting' }) : ''}
      ${state === 'waiting' ? `
        <div class="oscar-route-consent-actions">
          <button type="button" data-oscar-route-decision="deny">${escapeHtml(consent.denyLabel || 'Продолжить без этого')}</button>
          <button type="button" class="primary" data-oscar-route-decision="allow">${escapeHtml(consent.allowLabel || 'Разрешить')}</button>
        </div>
      ` : `
        <div class="oscar-consent-transition" role="status" aria-live="polite">
          <span></span>${escapeHtml(state === 'accepted' ? 'Перехожу к следующему этапу' : 'Обновляю маршрут ответа')}
        </div>
      `}
    </section>
  `;
}

function renderOscarModelNote(message, phase) {
  if (message.error) return '';
  if (message.pending) return '';
  const label = String(message.label || '').trim();
  const usageModelLabel = !message.pending && message.usage
    ? formatUsageModel(message.usage.model_tier || message.usage.model || '')
    : '';
  if (!message.pending && label && usageModelLabel && label === usageModelLabel) {
    return '';
  }
  const latestEvent = Array.isArray(message.streamEvents) && message.streamEvents.length
    ? message.streamEvents[message.streamEvents.length - 1]
    : null;
  const phaseLabel = message.pending ? formatOscarStreamPhase(phase) : '';
  const detail = message.pending ? String(latestEvent?.detail || latestEvent?.label || '').trim() : '';
  const parts = [label, phaseLabel, detail]
    .filter(Boolean)
    .filter((part, index, list) => list.indexOf(part) === index);
  if (parts.length === 0) return '';
  return `<div class="message-model-note">${escapeHtml(parts.join(' · '))}</div>`;
}

function inferOscarStreamPhase(message) {
  if (message.streamPhase) return message.streamPhase;
  const events = Array.isArray(message.streamEvents) ? message.streamEvents : [];
  const latest = [...events].reverse().find((event) => event && (event.kind || event.label || event.detail));
  const statusText = `${latest?.kind || ''} ${latest?.label || ''} ${latest?.detail || ''}`.toLowerCase();
  if (/error|ошиб|fallback/.test(statusText)) return 'error';
  if (/research-finalize|research-decision|формирую окончательный|данных достаточно/.test(statusText)) return 'research-finalize';
  if (/research-revise|пересобираю вывод/.test(statusText)) return 'research-revise';
  if (/research-reflect|проверяю полноту|пробел|противореч/.test(statusText)) return 'research-reflect';
  if (/research-verify|проверяю вывод/.test(statusText)) return 'research-verify';
  if (/research-synthesize|синтезирую/.test(statusText)) return 'research-synthesize';
  if (/research-read|читаю|сверяю источники/.test(statusText)) return 'research-read';
  if (/research-search|исследую направление/.test(statusText)) return 'research-search';
  if (/research-plan|планирую исследование|план исследования/.test(statusText)) return 'research-plan';
  if (/source|sources|источник|источники|поиск|контекст|search|web|internet/.test(statusText)) return 'search';
  if (/token|пишу|текст|ответ|фрагм|replace|уточн/.test(statusText)) return 'write';
  return 'route';
}

function formatOscarStreamPhase(phase) {
  switch (phase) {
  case 'research-reflect': return 'Проверяю полноту';
  case 'research-revise': return 'Пересобираю вывод';
  case 'research-finalize': return 'Формирую итог';
  case 'research-plan': return 'Планирую исследование';
  case 'research-search': return 'Исследую источники';
  case 'research-read': return 'Читаю материалы';
  case 'research-synthesize': return 'Синтезирую вывод';
  case 'research-verify': return 'Проверяю вывод';
  case 'search': return 'Ищу источники';
  case 'write': return 'Пишу ответ';
  case 'error': return 'Проверяю сбой';
  case 'route':
  default:
    return 'Подбираю маршрут';
  }
}

function formatOscarStreamHint(phase) {
  switch (phase) {
  case 'research-reflect': return 'Ищу пробелы и противоречия';
  case 'research-revise': return 'Уточняю ответ с новым контекстом';
  case 'research-finalize': return 'Собираю полный детальный ответ';
  case 'research-plan': return 'Разделяю вопрос на проверяемые направления';
  case 'research-search': return 'Ищу независимые подтверждения';
  case 'research-read': return 'Собираю факты и противоречия';
  case 'research-synthesize': return 'Отделяю факты от сценариев';
  case 'research-verify': return 'Сверяю утверждения и ссылки';
  case 'search': return 'Собираю свежий контекст';
  case 'write': return 'Ответ появляется по мере готовности';
  case 'error': return 'Сохраняю уже полученную часть';
  case 'route':
  default:
    return 'Выбираю лучший путь ответа';
  }
}

function renderOscarUsage(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const tokenCount = Number(usage.total_tokens || usage.token_count || 0);
  const modelLabel = formatUsageModel(usage.model_tier || usage.model || '');
  if (!tokenCount && !modelLabel) return '';
  const parts = [];
  if (modelLabel) parts.push(modelLabel);
  if (tokenCount) parts.push(`${usage.estimated ? '≈' : ''}${Math.round(tokenCount).toLocaleString('ru-RU')} токенов`);
  return `<div class="oscar-message-usage">${escapeHtml(parts.join(' · '))}</div>`;
}

function renderOscarWorkTimer(message) {
  if (message.error) return '';
  const startedAt = String(message.createdAt || '');
  const startedMs = Date.parse(startedAt);
  const elapsedMs = message.pending
    ? Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0
    : Number(message.usage?.elapsed_ms || 0);
  if (!message.pending && elapsedMs <= 0) return '';
  const label = message.pending ? 'Работает' : 'Завершено за';
  const pendingAttrs = message.pending
    ? ` data-oscar-work-timer data-work-started-at="${escapeHtml(startedAt)}" role="timer" aria-live="off"`
    : '';
  return `
    <div class="oscar-work-timer${message.pending ? ' is-running' : ' is-complete'}"${pendingAttrs}>
      <span aria-hidden="true"></span>
      <strong>${escapeHtml(label)} ${escapeHtml(formatOscarWorkDuration(elapsedMs))}</strong>
    </div>
  `;
}

export function formatOscarWorkDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs || 0) / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}д ${hours}ч`;
  if (totalHours > 0) return `${totalHours}ч ${String(minutes).padStart(2, '0')}м`;
  if (totalMinutes > 0) return `${totalMinutes}м ${String(seconds).padStart(2, '0')}с`;
  return `${totalSeconds}с`;
}

function formatUsageModel(value) {
  switch (String(value || '').toLowerCase()) {
  case 'gemma4-fast': case 'weak': case 'gemma_low': return 'Fast';
  case 'gemma4-balanced': case 'medium': case 'gemma': case 'gemma_high': case 'vision': return 'Medium';
  case 'gemma4-deepthinking': case 'powerful': case 'reasoning': return 'Pro';
  case 'gemma4-31b': return 'Extra';
  case 'system': return 'Monarch';
  default: return '';
  }
}

function normalizeRepeatedOrderedListMarkers(source) {
  return String(source || '').split(/(\n{3,})/).map((segment) => {
    const markers = [...segment.matchAll(/^\s*(\d+)[.)]\s+/gm)];
    if (markers.length < 2 || markers.some((match) => match[1] !== '1')) return segment;
    let index = 0;
    return segment.replace(/^(\s*)1([.)])\s+/gm, (_match, indent, suffix) => {
      index += 1;
      return `${indent}${index}${suffix} `;
    });
  }).join('');
}

function copyIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
}

function speakerIcon() {
  return '<span class="oscar-speaker-icon" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4Z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path></svg><span class="oscar-speaker-bars"><i></i><i></i><i></i></span></span>';
}

function editIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>';
}

export function looksLikeAgentAction(text) {
  const value = String(text || '');
  const action = /(?:^|[\s"'`{[(.,:])(?:создай|создать|запиши|записать|сохрани|сохранить|измени|изменить|замени|заменить|добавь|добавить|удали|удалить|очисти|опустоши|закрой|перемести|скопируй|прочитай|прочитать|открой|покажи|показать|посмотри|посмотреть|просмотри|просмотреть|перечисли|найди|ищи|проверь|проверить|проведи|провести|выполни|выполнить|приступи|приступить|начни|начать|сделай|сделать|выдай|выдать|сканируй|запусти|останови|выгрузи|запомни|вспомни|включи|выключи|содержимое|содержание|create|write|save|edit|replace|append|delete|remove|clear|empty|close|move|copy|read|open|show|view|inspect|browse|list|find|search|check|scan|start|stop|unload|remember|recall|enable|disable|run|perform|begin|proceed|contents)(?=$|[\s"'`}\]),.!?:;])/i.test(value);
  const naturalListing = /(?:какие|названи\w*|перечисл\w*|содержим\w*).{0,64}(?:файл\w*|папк\w*|директор\w*|workspace|рабоч\w*\s+стол)/i.test(value);
  const locationQuestion = /^(?:что\s+(?:лежит|находится)|что\s+внутри).*(?:папк|директор|workspace|пут)/i.test(value);
  const workspaceRootQuestion = /(?:где|какой|укажи|покажи|назови|дай|where|what).{0,80}(?:путь|адрес|находится|расположен|path|location|located).{0,80}(?:workspace|рабоч[^\s]*\s+пространств[^\s]*)|(?:workspace|рабоч[^\s]*\s+пространств[^\s]*).{0,80}(?:путь|адрес|path|location)/i.test(value);
  const explicitCapability = /\b(?:workspace\.(?:files\.)?|memory\.|models\.|diagnostics\.|security\.)[a-z0-9_.-]+/i.test(value);
  return action || naturalListing || locationQuestion || workspaceRootQuestion || explicitCapability;
}

export function shouldPreDispatchAgentAction(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^\{[\s\S]*"(?:capability|capabilityId|name)"\s*:/i.test(value)) return true;
  const workspaceRootQuestion = /(?:где|какой|укажи|покажи|назови|дай|where|what).{0,80}(?:путь|адрес|находится|расположен|path|location|located).{0,80}(?:workspace|рабоч[^\s]*\s+пространств[^\s]*)|(?:workspace|рабоч[^\s]*\s+пространств[^\s]*).{0,80}(?:путь|адрес|находится|расположен|path|location|located)/i.test(value);
  return workspaceRootQuestion || isAtomicWorkspaceMutation(value);
}

function isAtomicWorkspaceMutation(value) {
  const mutationKinds = [
    /(?:\b(?:create|make|mkdir)\b|(?:создай|создать|сделай|сделать)).{0,96}(?:\b(?:folder|directory)\b|папк|директор)/i,
    /(?:\b(?:create|write|save|overwrite)\b|(?:создай|создать|запиши|записать|сохрани|сохранить|перезапиши)).{0,96}(?:\b(?:file|document)\b|файл|документ)/i,
    /(?:\b(?:append|add)\b|(?:допиши|добавь)).{0,80}(?:\bfile\b|файл)/i,
    /(?:\breplace\b|(?:замени|заменить)).{0,80}(?:\bfile\b|файл)/i,
    /(?:\b(?:copy|duplicate)\b|(?:скопируй|дублируй)).{0,80}(?:\b(?:file|folder|directory)\b|файл|папк|директор)/i,
    /(?:\b(?:move|rename)\b|(?:перемести|переименуй)).{0,80}(?:\b(?:file|folder|directory)\b|файл|папк|директор)/i,
    /(?:\b(?:delete|remove|trash)\b|(?:удали|удалить|убери|сотри)).{0,80}(?:\b(?:file|folder|directory)\b|файл|папк|директор)/i,
  ].filter((pattern) => pattern.test(value));
  if (mutationKinds.length !== 1) return false;

  const actionVerbs = value.match(/\b(?:create|make|mkdir|write|save|overwrite|append|add|replace|copy|duplicate|move|rename|delete|remove|trash)\b|(?:создай|создать|сделай|сделать|запиши|записать|сохрани|сохранить|перезапиши|допиши|добавь|замени|заменить|скопируй|дублируй|перемести|переименуй|удали|удалить|убери|сотри)/gi) || [];
  return actionVerbs.length === 1;
}

export function executionNeedsAuthoritativeReceipt(execution) {
  if (execution?.ok !== true) return false;
  const effect = String(execution?.metadata?.policy?.riskVector?.effect || '').trim().toLowerCase();
  return Boolean(effect && effect !== 'none' && effect !== 'read');
}

export function resolveContextualAgentAction(text, contextText = '') {
  const value = String(text || '').trim();
  const context = String(contextText || '');
  const pathFollowup = /^(?:укажи\s+)?(?:более\s+)?(?:(?:точный|полный|абсолютный)\s+)?путь(?:\s+до\s+(?:него|не[её]|этого))?[?.!]*$|^(?:более\s+)?(?:точный|полный|абсолютный)\s+путь[?.!]*$/i.test(value);
  const workspaceContext = /workspace|рабоч[^\s]*\s+пространств[^\s]*|Monarch Workspace/i.test(context);
  if (pathFollowup && workspaceContext) {
    return 'Укажи точный путь рабочего пространства Monarch';
  }

  const recentDirectory = extractRecentWorkspaceDirectory(context);
  if (recentDirectory && isContextualTextFileRequest(value)) {
    return buildContextualTextFileAction(recentDirectory, extractInlineTextFileContent(value));
  }
  if (recentDirectory && isPlainTextFileContentFollowup(value, context)) {
    return buildContextualTextFileAction(recentDirectory, value);
  }

  const proceedFollowup = /^(?:приступ(?:ай|айте|и|ите)|нач(?:инай|инайте|ни|ните)|выполн(?:яй|яйте|и|ите)|делай(?:те)?|запускай(?:те)?|давай(?:те)?(?:\s+нач(?:нем|н[её]м|инай|инайте))?)(?:\s+(?:к\s+)?выполнению)?(?:\s+(?:всего|всему|всё|все))?(?:\s+по\s+очереди)?[.!]*$/i.test(value);
  if (proceedFollowup && /\b(?:security|environment|workspace|models|diagnostics)\.[a-z0-9_.-]+/i.test(context)) {
    if (/процесс|process|security\.(?:scan|status)/i.test(context)) {
      return 'Проведи полный аудит безопасности текущих процессов и системы через Monarch Security';
    }
    return 'Выполни системную диагностику и сформируй диагностический отчет';
  }

  return value;
}

function isContextualTextFileRequest(value) {
  return /(?:в\s+(?:этой|ней|папке|там)|туда).{0,80}(?:создай|создать|сделай|сделать|create|make).{0,48}(?:текстов\w*\s+файл|txt\s+file|text\s+file|файл)|(?:создай|создать|сделай|сделать|create|make).{0,48}(?:текстов\w*\s+файл|txt\s+file|text\s+file|файл).{0,80}(?:в\s+(?:этой|ней|папке)|там|туда)/i.test(value);
}

function isPlainTextFileContentFollowup(value, context) {
  if (!value || value.length > 1200 || looksLikeAgentAction(value)) return false;
  return /(?:какой\s+текст|укажи\s+(?:текст|содержим)|что\s+(?:поместить|записать)).{0,160}(?:файл|документ)/i.test(context);
}

function extractRecentWorkspaceDirectory(context) {
  const matches = [];
  const patterns = [
    /"path"\s*:\s*"([A-Za-z]:\\\\[^"]+)"/gi,
    /\b(?:Created directory|Directory already exists|Создал папку|Папка уже существует)[:\s]+([A-Za-z]:\\[^\n`"}]+|[A-Za-z0-9_. -]+(?:[\\/][A-Za-z0-9_. -]+)+)/gi,
    /\b(?:Путь|Path):\s*`?([A-Za-z]:\\[^`\n]+)`?/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(context)) !== null) {
      const candidate = normalizeContextPath(match[1] || '');
      if (candidate && !/\.[a-z0-9]{1,12}$/i.test(candidate)) {
        matches.push(candidate);
      }
    }
  }
  return matches.at(-1) || '';
}

function buildContextualTextFileAction(directory, content) {
  const filePath = joinContextPath(directory, 'note.txt');
  const normalizedContent = String(content || '').trim();
  return normalizedContent
    ? `создай файл ${quoteActionText(filePath)} с текстом ${quoteActionText(normalizedContent)}`
    : `создай файл ${quoteActionText(filePath)}`;
}

function extractInlineTextFileContent(value) {
  const match = String(value || '').match(/(?:с\s+текстом|с\s+содержимым|текстом|content|with\s+text)\s*[:\-]?\s*(.+)$/i);
  return match?.[1]?.trim().replace(/^["'`]|["'`]$/g, '') || '';
}

function joinContextPath(directory, fileName) {
  const base = normalizeContextPath(directory).replace(/[\\/]+$/g, '');
  const separator = base.includes('\\') ? '\\' : '/';
  return `${base}${separator}${fileName}`;
}

function normalizeContextPath(value) {
  return String(value || '')
    .replace(/\\\\/g, '\\')
    .replace(/[.,;:]+$/g, '')
    .trim();
}

function quoteActionText(value) {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

export function looksLikeProtectedAgentAction(text) {
  return /(?:файл|папк|директор|workspace|рабоч\w*\s+стол|диск|проект|репозитор|памят|memory|модел|model|безопас|security|систем|system|процесс|process|приложен|\bapp\b|служб|service|корзин|recycle\s*bin|браузер|browser)/i.test(String(text || ''));
}

export function extractOscarActionProposal(text) {
  const raw = String(text || '');
  if (globalThis.__MONARCH_LEGACY_ACTION_MARKERS__ !== true) {
    return {
      command: '',
      commands: [],
      reason: '',
      content: raw.replace(/\s*\[\[MONARCH_COMMAND:[\s\S]*?\]\]\s*/gi, '\n').trim(),
      rejected: raw.includes('[[MONARCH_COMMAND:') ? ['legacy-marker-disabled'] : [],
    };
  }
  const matches = [...raw.matchAll(/\[\[MONARCH_COMMAND:([\s\S]*?)\]\]/gi)];
  const rejected = [];
  let command = '';
  let commands = [];
  let reason = '';
  for (const match of matches.slice(0, 4)) {
    try {
      const proposal = JSON.parse(String(match[1] || ''));
      const keys = proposal && typeof proposal === 'object' && !Array.isArray(proposal)
        ? Object.keys(proposal)
        : [];
      const commandText = typeof proposal?.command === 'string' ? proposal.command.trim() : '';
      const structuredInput = proposal?.input ?? proposal?.parameters;
      const structuredSingle = /^[a-z][a-z0-9-]*(?:\.[a-z0-9_-]+)+$/i.test(commandText)
        && structuredInput
        && typeof structuredInput === 'object'
        && !Array.isArray(structuredInput);
      const candidateCommands = structuredSingle
        ? serializeCapabilityPlanCommands([{ capability: commandText, parameters: structuredInput }])
        : commandText
          ? [commandText]
          : serializeCapabilityPlanCommands(proposal?.commands);
      const candidate = candidateCommands[0] || '';
      const candidateReason = typeof proposal?.reason === 'string' ? proposal.reason.trim() : '';
      const allowedKeys = structuredSingle
        ? new Set(['command', 'parameters', 'input', 'reason'])
        : new Set(['command', 'commands', 'reason']);
      if (!candidate || candidate.length > 2000 || candidateReason.length > 500
        || keys.some((key) => !allowedKeys.has(key))
        || (keys.includes('command') && keys.includes('commands'))
        || (keys.includes('parameters') && keys.includes('input'))) {
        rejected.push('invalid-command-schema');
        continue;
      }
      if (!command) {
        command = candidate;
        commands = candidateCommands;
        reason = candidateReason;
      } else {
        rejected.push('multiple-commands');
      }
    } catch {
      rejected.push('invalid-command-json');
    }
  }
  return {
    command,
    commands,
    reason,
    content: raw.replace(/\s*\[\[MONARCH_COMMAND:[\s\S]*?\]\]\s*/gi, '\n').trim(),
    rejected,
  };
}

function serializeCapabilityPlanCommands(commands) {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 3) return [];
  const serialized = [];
  for (const command of commands) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) return [];
    const keys = Object.keys(command);
    if (keys.some((key) => !['capability', 'capabilityId', 'parameters', 'input'].includes(key))) return [];
    const capabilityId = String(command.capabilityId || command.capability || '').trim();
    const input = command.input ?? command.parameters;
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9_-]+)+$/i.test(capabilityId)
      || !input || typeof input !== 'object' || Array.isArray(input)) return [];
    const normalizedInput = { ...input };
    if (capabilityId === 'workspace.files.write' && normalizedInput.content == null) {
      normalizedInput.content = '';
    }
    serialized.push(JSON.stringify({ capability: capabilityId, parameters: normalizedInput }));
  }
  return serialized;
}

export const extractOscarActionActivator = extractOscarActionProposal;

export function createThinkParser() {
  let buffer = '';
  let inThink = false;
  let content = '';
  let reasoning = '';

  return {
    processChunk(chunk) {
      buffer += chunk;
      
      while (buffer.length > 0) {
        if (inThink) {
          const closeIdx = buffer.indexOf('</think>');
          if (closeIdx !== -1) {
            reasoning += buffer.slice(0, closeIdx);
            buffer = buffer.slice(closeIdx + 8);
            inThink = false;
          } else {
            const lastLt = buffer.lastIndexOf('<');
            if (lastLt !== -1 && '</think>'.startsWith(buffer.slice(lastLt))) {
              if (lastLt > 0) {
                reasoning += buffer.slice(0, lastLt);
              }
              buffer = buffer.slice(lastLt);
              break;
            } else {
              reasoning += buffer;
              buffer = '';
            }
          }
        } else {
          const openIdx = buffer.indexOf('<think>');
          if (openIdx !== -1) {
            if (openIdx > 0) {
              content += buffer.slice(0, openIdx);
            }
            buffer = buffer.slice(openIdx + 7);
            inThink = true;
          } else {
            const lastLt = buffer.lastIndexOf('<');
            if (lastLt !== -1 && '<think>'.startsWith(buffer.slice(lastLt))) {
              if (lastLt > 0) {
                content += buffer.slice(0, lastLt);
              }
              buffer = buffer.slice(lastLt);
              break;
            } else {
              content += buffer;
              buffer = '';
            }
          }
        }
      }
    },
    getContent(flush = false) {
      return content + (flush && !inThink ? buffer : '');
    },
    getReasoning(flush = false) {
      return reasoning + (flush && inThink ? buffer : '');
    }
  };
}

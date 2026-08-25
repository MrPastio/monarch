export interface WorkspaceFileArguments {
  path: string;
  content: string;
  overwrite: boolean;
}

/** Canonical argument extraction for atomic workspace file writes. */
export function buildWorkspaceFileArguments(text: string): WorkspaceFileArguments {
  const value = String(text || '').trim();
  return {
    path: extractWorkspaceFilePath(value),
    content: extractExactWorkspaceFileContent(value) ?? extractWorkspaceFileContent(value),
    overwrite: /\b(?:overwrite|replace)\b|(?:перезапиши|замени)/i.test(value),
  };
}

/**
 * Compile only explicit path + exact-byte file requirements from user text.
 * Unquoted terminal sentence punctuation is grammar, while punctuation that
 * belongs to the bytes must be quoted by the user.
 */
export function parseExactWorkspaceFileWrites(text: string): WorkspaceFileArguments[] {
  const value = String(text || '').trim();
  if (!value) return [];
  const results: WorkspaceFileArguments[] = [];
  for (const clause of splitAtomicWriteClauses(value)) {
    if (!isExplicitWorkspaceWriteInstruction(clause)) continue;
    const targetPath = extractWorkspaceFilePath(clause);
    const content = extractExactWorkspaceFileContent(clause);
    if (!targetPath || content === null) continue;
    results.push({
      path: targetPath,
      content,
      overwrite: /\b(?:overwrite|replace)\b|(?:перезапиши|замени)/iu.test(clause),
    });
  }
  const unique = new Map<string, WorkspaceFileArguments>();
  for (const result of results) {
    unique.set(result.path.replace(/\\/gu, '/').toLocaleLowerCase('en-US'), result);
  }
  return [...unique.values()];
}

export function hasCompleteWorkspaceFileArguments(text: string): boolean {
  const input = buildWorkspaceFileArguments(text);
  return Boolean(input.path && input.content !== '');
}

/**
 * Extract an explicit user-assigned local object name (for example
 * `назови её цветок` or `call it flower`). This is intentionally separate
 * from path extraction: a display name must never smuggle path separators.
 */
export function extractWorkspaceObjectName(text: string): string {
  const value = String(text || '').trim();
  if (!value) return '';

  const quoted = value.match(
    /(?:назови|назвать|именуй|назов[её]м|name|call)\s+(?:(?:е[её]|его|их|it|them|(?:эту|этот|the)\s+(?:папку|директорию|файл|документ|folder|directory|file|document))\s+)?(?:как\s+|as\s+)?(["'`])([^\r\n]+?)\1/iu,
  )?.[2];
  if (quoted) return normalizeWorkspaceObjectName(quoted);

  const bare = value.match(
    /(?:назови|назвать|именуй|назов[её]м|name|call)\s+(?:(?:е[её]|его|их|it|them|(?:эту|этот|the)\s+(?:папку|директорию|файл|документ|folder|directory|file|document))\s+)?(?:как\s+|as\s+)?([\p{L}\p{N}_.-]+(?:\s+[\p{L}\p{N}_.-]+){0,4}?)(?=\s*(?:$|[.,;!?]|(?:и|а|затем|потом|and|then)\s+(?:укажи|покажи|создай|сделай|запиши|открой|show|give|create|make|write|open)\b))/iu,
  )?.[1];
  return normalizeWorkspaceObjectName(bare || '');
}

function normalizeWorkspaceObjectName(value: string): string {
  const normalized = value.trim().replace(/[.,;:!?]+$/g, '');
  if (!normalized || normalized.length > 120 || /[\0\r\n\\/:*?"<>|]/.test(normalized)) return '';
  if (/^(?:it|them|name|title|folder|directory|file|document|е[её]|его|их|имя|название|папка|директория|файл|документ)$/iu.test(normalized)) return '';
  return normalized;
}

function extractWorkspaceFilePath(text: string): string {
  const quotedPath = Array.from(text.matchAll(/["'`](.+?)["'`]/g))
    .map((match) => match[1]?.trim() || '')
    .find(looksLikeFilePath);
  if (quotedPath) return trimTrailingPunctuation(quotedPath);

  const absolutePath = text.match(
    /(?:^|[\s(])([A-Za-z]:[\\/][^<>:"|?*\r\n]*?\.[A-Za-z0-9]{1,12})(?=$|[\s,;.!?)])/u,
  )?.[1]?.trim();
  if (absolutePath) return trimTrailingPunctuation(absolutePath);

  const objectMatch = text.match(
    /(?:^|\s)(?:file|document|path|файл|файла|документ|путь)\s+(?:named\s+|called\s+|с\s+именем\s+)?(["'`].+?["'`]|[^\s,;]+)/i,
  );
  const objectPath = trimQuoted(objectMatch?.[1] || '');
  if (looksLikeFilePath(objectPath)) return trimTrailingPunctuation(objectPath);

  const token = text.match(
    /(?:^|[\s(])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s,;:"'`()]+(?:[\\/][^\s,;:"'`()]+)*\.[A-Za-z0-9]{1,12})(?=$|[\s,;:)])/,
  )?.[1];
  return trimTrailingPunctuation(token || '');
}

function extractExactWorkspaceFileContent(text: string): string | null {
  const marker = /(?:must\s+contain\s+exactly|(?:should|needs?\s+to)\s+contain\s+exactly|contains?\s+(?:the\s+)?exact\s+text|with\s+(?:the\s+)?exact\s+text|с\s+точн(?:ым|ой)\s+(?:текстом|строкой)|долж(?:ен|на|но)?\s+содержать\s+точно)\s*[:\-]?\s*/iu.exec(text);
  if (!marker) return null;
  const remainder = text.slice(marker.index + marker[0].length).trim();
  if (!remainder) return null;
  const quote = remainder[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = remainder.indexOf(quote, 1);
    return end > 0 ? remainder.slice(1, end) : null;
  }
  const boundary = remainder.search(
    /[.!?](?=\s*(?:$|(?:and\s+then\s+|and\s+|then\s+)?(?:create|write|save|verify|check|open|read)\b|(?:и\s+|затем\s+|потом\s+)?(?:создай|запиши|сохрани|проверь|открой|прочитай)\b))/iu,
  );
  const content = (boundary >= 0 ? remainder.slice(0, boundary) : remainder).trim();
  return content || null;
}

function splitAtomicWriteClauses(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let quote = '';
  const push = (end: number) => {
    const clause = text.slice(start, end).trim();
    if (clause) clauses.push(clause);
  };
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index] || '';
    if (quote) {
      if (current === quote && !isEscapedAt(text, index)) quote = '';
      continue;
    }
    if ((current === '"' || current === "'" || current === '`') && !isWordApostrophe(text, index)) {
      quote = current;
      continue;
    }
    if (current === ';' || current === '\r' || current === '\n') {
      push(index);
      while (index + 1 < text.length && /[;\r\n]/u.test(text[index + 1] || '')) index += 1;
      start = index + 1;
      continue;
    }
    if (!/\s/u.test(current)) continue;
    const boundary = text.slice(index).match(
      /^\s+(?=(?:and\s+then|and|then)\s+(?:create|write|save|overwrite|replace)\b|(?:и|затем|потом)\s+(?:создай|запиши|сохрани|перезапиши|замени)(?=$|\s|[.,;:!?]))/iu,
    )?.[0];
    if (!boundary) continue;
    push(index);
    index += boundary.length - 1;
    start = index + 1;
  }
  push(text.length);
  return clauses;
}

function isExplicitWorkspaceWriteInstruction(clause: string): boolean {
  const normalized = clause.trim();
  if (!normalized) return false;
  const writeVerb = /\b(?:create|write|save|overwrite|replace)\b|(?:создай|запиши|сохрани|перезапиши|замени)(?=$|\s|[.,;:!?])/iu.exec(normalized);
  const declarativeExactState = /^(?:(?:the\s+)?(?:file|document|path)\b|(?:файл|документ|путь)(?=$|\s|[.,;:!?]))[\s\S]{0,500}\b(?:must|should|needs?\s+to)\s+contain\s+exactly\b|^(?:файл|документ)(?=$|\s|[.,;:!?])[\s\S]{0,500}долж(?:ен|на|но)?\s+содержать\s+точно(?=$|\s|[.,;:!?])/iu.test(normalized);
  if (declarativeExactState) return true;
  if (!writeVerb) return declarativeExactState;
  const prefix = normalized.slice(0, writeVerb.index).trim();
  if (/\b(?:do\s+not|don't|never|without|avoid)\b|(?:^|\s)(?:не|никогда|нельзя)(?:\s|$)|не\s+надо/iu.test(prefix)) {
    return false;
  }
  if (/\b(?:explain|describe|discuss|show\s+how|tell\s+me\s+how|how\s+to|what\s+if)\b|(?:объясни|опиши|расскажи|покажи\s+как|как\s+)(?:\s|$)/iu.test(prefix)) {
    return false;
  }
  return /^(?:(?:and\s+then|and|then)\s+)?(?:(?:please|can\s+you|could\s+you|would\s+you|i\s+(?:need|want)\s+you\s+to)\s+)?(?:create|write|save|overwrite|replace)\b|^(?:(?:и|затем|потом)\s+)?(?:(?:пожалуйста|можешь|нужно)\s+)?(?:создай|запиши|сохрани|перезапиши|замени)(?=$|\s|[.,;:!?])/iu.test(normalized);
}

function isEscapedAt(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isWordApostrophe(value: string, index: number): boolean {
  return value[index] === "'"
    && /[\p{L}\p{N}]/u.test(value[index - 1] || '')
    && /[\p{L}\p{N}]/u.test(value[index + 1] || '');
}

function extractWorkspaceFileContent(text: string): string {
  const marker = text.match(
    /(?:with\s+(?:text|content)|content\s*:|с\s+(?:текстом|содержимым)|текстом\s*:|(?:и\s+)?напиши(?:\s+(?:в\s+(?:него|ней|файл)))?|and\s+write(?:\s+(?:to|into)\s+it)?)\s*[:\-]?\s*([\s\S]+)$/i,
  );
  if (marker?.[1] !== undefined) return trimMatchingQuotes(marker[1].trim());

  const quoted = Array.from(text.matchAll(/["'`](.+?)["'`]/g)).map((match) => match[1] || '');
  const nonPath = quoted.find((candidate) => !looksLikeFilePath(candidate));
  return nonPath ? nonPath.trim() : '';
}

function looksLikeFilePath(value: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.[A-Za-z0-9]{1,12}$/.test(value)
    || /^[^\\/:*?"<>|\s]+\.[A-Za-z0-9]{1,12}$/.test(value);
}

function trimMatchingQuotes(value: string): string {
  if (value.length >= 2 && /["'`]/.test(value[0] || '') && value.at(-1) === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

function trimQuoted(value: string): string {
  return value.trim().replace(/^["'`]|["'`]$/g, '');
}

function trimTrailingPunctuation(value: string): string {
  return value.trim().replace(/[!?,;:]+$/g, '');
}

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
    content: extractWorkspaceFileContent(value),
    overwrite: /\b(?:overwrite|replace)\b|(?:перезапиши|замени)/i.test(value),
  };
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
  const objectMatch = text.match(
    /(?:^|\s)(?:file|document|path|файл|файла|документ|путь)\s+(?:named\s+|called\s+|с\s+именем\s+)?(["'`].+?["'`]|[^\s,;]+)/i,
  );
  const objectPath = trimQuoted(objectMatch?.[1] || '');
  if (looksLikeFilePath(objectPath)) return trimTrailingPunctuation(objectPath);

  const quotedPath = Array.from(text.matchAll(/["'`](.+?)["'`]/g))
    .map((match) => match[1]?.trim() || '')
    .find(looksLikeFilePath);
  if (quotedPath) return trimTrailingPunctuation(quotedPath);

  const token = text.match(
    /(?:^|[\s(])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[^\s,;:"'`()]+(?:[\\/][^\s,;:"'`()]+)*\.[A-Za-z0-9]{1,12})(?=$|[\s,;:)])/,
  )?.[1];
  return trimTrailingPunctuation(token || '');
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

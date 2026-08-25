import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildWorkspaceFileArguments, extractWorkspaceObjectName } from './argument-builder';
import { resolveKnownUserFolder } from './filesystem-policy';

export type MonarchWritableKnownFolder = 'desktop' | 'downloads';

export interface MonarchKnownFolderFileRequest extends Record<string, unknown> {
  knownFolder: MonarchWritableKnownFolder;
  basename: string;
  content: string;
  overwrite: boolean;
}

export interface MonarchKnownFolderTarget {
  knownFolder: MonarchWritableKnownFolder;
  basename: string;
  root: string;
  path: string;
}

export function parseKnownFolderFileRequest(textInput: string): MonarchKnownFolderFileRequest | null {
  const text = String(textInput || '').trim();
  const knownFolder = detectWritableKnownFolder(text);
  const writesFile = /(?:write|create|save|make|запиши|записать|создай|создать|сделай|сохранить|сохрани).{0,64}(?:text\s+file|file|document|текстов[а-яё]*\s+файл|файл|документ)/iu.test(text)
    || /(?:text\s+file|file|document|текстов[а-яё]*\s+файл|файл|документ).{0,64}(?:on|in|на|в)\s+(?:the\s+)?(?:desktop|downloads?|рабоч[а-яё]*\s+стол|загрузк)/iu.test(text);
  if (!knownFolder || !writesFile) return null;

  const fileArguments = buildWorkspaceFileArguments(text);
  const assignedName = extractAssignedFileName(text);
  let basename = assignedName || fileArguments.path || extractWorkspaceObjectName(text);
  basename = basename.trim().replace(/^['"`]|['"`]$/gu, '').replace(/[!,;:?]+$/gu, '');
  // A known-folder mutation must never invent an anonymous `.txt` target.
  // If grammar cannot prove one explicit leaf name, leave the task unresolved.
  if (!basename) return null;
  if (isTextFileRequest(text) && !/\.[\p{L}\p{N}]{1,12}$/u.test(basename)) {
    basename = `${basename}.txt`;
  }
  basename = normalizeKnownFolderBasename(basename);
  if (!basename) return null;

  return {
    knownFolder,
    basename,
    content: hasExplicitFileContentMarker(text) ? fileArguments.content : '',
    overwrite: fileArguments.overwrite,
  };
}

export function normalizeKnownFolderBasename(valueInput: string): string {
  const basename = String(valueInput || '').trim();
  if (!basename || basename.length > 255 || basename === '.' || basename === '..') return '';
  if (/[\u0000-\u001F\u007F\\/:*?"<>|]/u.test(basename)) return '';
  if (/[. ]$/u.test(basename)) return '';
  if (path.basename(basename) !== basename || path.win32.basename(basename) !== basename) return '';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(basename)) return '';
  return basename;
}

export function isWritableKnownFolder(value: string): value is MonarchWritableKnownFolder {
  return value === 'desktop' || value === 'downloads';
}

export function resolveKnownFolderTarget(input: unknown): MonarchKnownFolderTarget | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const knownFolder = typeof record.knownFolder === 'string' ? record.knownFolder.trim() : '';
  const basename = typeof record.basename === 'string'
    ? normalizeKnownFolderBasename(record.basename)
    : '';
  if (!isWritableKnownFolder(knownFolder) || !basename) return null;
  const root = resolveKnownUserFolder(knownFolder);
  if (!root) return null;
  return {
    knownFolder,
    basename,
    root: path.resolve(root),
    path: path.resolve(root, basename),
  };
}

export function resolveKnownFolderRequestTarget(requestText: string): MonarchKnownFolderTarget | null {
  const request = parseKnownFolderFileRequest(requestText);
  return request ? resolveKnownFolderTarget(request) : null;
}

export function knownFolderWriteOutputMatchesRequest(requestText: string, outputValue: unknown): boolean {
  const request = parseKnownFolderFileRequest(requestText);
  const target = request ? resolveKnownFolderTarget(request) : null;
  if (!request || !target || !outputValue || typeof outputValue !== 'object' || Array.isArray(outputValue)) return false;
  const output = outputValue as Record<string, unknown>;
  const expectedBytes = Buffer.from(request.content, 'utf8');
  const expectedSha256 = createHash('sha256').update(expectedBytes).digest('hex');
  return output.verified === true
    && output.knownFolder === request.knownFolder
    && output.basename === request.basename
    && typeof output.path === 'string'
    && sameCanonicalFilesystemPath(output.path, target.path)
    && output.bytes === expectedBytes.byteLength
    && output.readbackSha256 === expectedSha256;
}

export function knownFolderWriteInputMatchesRequest(requestText: string, inputValue: unknown): boolean {
  const expected = parseKnownFolderFileRequest(requestText);
  if (!expected || !inputValue || typeof inputValue !== 'object' || Array.isArray(inputValue)) return false;
  const input = inputValue as Record<string, unknown>;
  return input.knownFolder === expected.knownFolder
    && input.basename === expected.basename
    && input.content === expected.content
    && input.overwrite === false;
}

export function sameCanonicalFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left).replace(/[\\/]+$/u, '');
  const normalizedRight = path.resolve(right).replace(/[\\/]+$/u, '');
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function detectWritableKnownFolder(text: string): MonarchWritableKnownFolder | '' {
  if (/\bdesktop\b|рабоч[^\s]*\s+стол|(?:^|\s)на\s+стол(?:е)?(?:$|[\s,.;!?])/iu.test(text)) return 'desktop';
  if (/\bdownloads?\b|загрузк/iu.test(text)) return 'downloads';
  return '';
}

function extractAssignedFileName(text: string): string {
  const marker = /(?:file|document|файл(?:а|у|ом|е)?|документ(?:а|у|ом|е)?)\s+(?:named|called|с\s+именем|под\s+названием)\s+/iu.exec(text);
  if (!marker) return '';
  const remainder = text.slice(marker.index + marker[0].length).trim();
  const quoted = remainder.match(/^(["'`])([^\r\n]+?)\1/u)?.[2];
  if (quoted) return quoted.trim();
  return remainder.match(
    /^([\p{L}\p{N}_.-]+(?:\s+[\p{L}\p{N}_.-]+){0,7}?)(?=\s*(?:$|[.,;!?]|(?:on|in|at|to)\s+(?:the\s+)?(?:desktop|downloads?)(?=$|\s|[.,;!?])|(?:на|в)\s+(?:рабоч\p{L}*\s+стол\p{L}*|загрузк\p{L}*)(?=$|\s|[.,;!?])|(?:with|and|с|и)\s+(?:text\p{L}*|content\p{L}*|текст\p{L}*|содержим\p{L}*|напиши\p{L}*|write\p{L}*)(?=$|\s|[.,;!?])))/iu,
  )?.[1]?.trim() || '';
}

function isTextFileRequest(text: string): boolean {
  return /\btext(?:ual)?\s+(?:file|document)\b|текстов[а-яё]*\s+(?:файл|документ)/iu.test(text);
}

function hasExplicitFileContentMarker(text: string): boolean {
  return /(?:with\s+(?:text|content)|content\s*:|с\s+(?:текстом|содержимым)|текстом\s*:|(?:и\s+)?напиши(?:\s+(?:в\s+(?:него|ней|файл)))?|and\s+write(?:\s+(?:to|into)\s+it)?)/iu.test(text);
}

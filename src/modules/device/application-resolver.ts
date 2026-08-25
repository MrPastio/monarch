export type InstalledApplicationSource = 'start-apps' | 'app-path';

export interface InstalledApplicationCatalogEntry {
  name: string;
  launchId: string;
  source: InstalledApplicationSource;
  executableName?: string;
}

export interface RankedInstalledApplication extends InstalledApplicationCatalogEntry {
  score: number;
  matchKind: 'exact' | 'layout' | 'transliteration' | 'phonetic' | 'fuzzy';
}

export type InstalledApplicationResolution =
  | { status: 'missing'; candidates: RankedInstalledApplication[] }
  | { status: 'ambiguous'; candidates: RankedInstalledApplication[] }
  | { status: 'unique'; selected: RankedInstalledApplication; candidates: RankedInstalledApplication[] };

interface IdentityVariant {
  value: string;
  kind: RankedInstalledApplication['matchKind'];
}

const ENTRY_IDENTITY_TARGET_CACHE = new WeakMap<InstalledApplicationCatalogEntry, ReturnType<typeof buildEntryIdentityTargets>>();

const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ћ: 'c', ђ: 'd', љ: 'lj', њ: 'nj', џ: 'dz',
});

const RU_KEYBOARD_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  й: 'q', ц: 'w', у: 'e', к: 'r', е: 't', н: 'y', г: 'u', ш: 'i', щ: 'o', з: 'p', х: '[', ъ: ']',
  ф: 'a', ы: 's', в: 'd', а: 'f', п: 'g', р: 'h', о: 'j', л: 'k', д: 'l', ж: ';', э: "'",
  я: 'z', ч: 'x', с: 'c', м: 'v', и: 'b', т: 'n', ь: 'm', б: ',', ю: '.',
});

const UK_KEYBOARD_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  ...RU_KEYBOARD_TO_LATIN,
  і: 's', ї: ']', є: "'", ґ: '\\',
});

const LATIN_TO_RU_KEYBOARD = invertKeyboardLayout(RU_KEYBOARD_TO_LATIN);
const LATIN_TO_UK_KEYBOARD = invertKeyboardLayout(UK_KEYBOARD_TO_LATIN);
const GENERIC_LAUNCH_ID_TOKENS = new Set([
  'app', 'application', 'com', 'exe', 'launcher', 'microsoft', 'net', 'org',
  'package', 'shell', 'squirrel', 'windows',
]);

/**
 * Rank the real Windows application catalog without an application-specific
 * alias list. User spelling, keyboard layout, Cyrillic transliteration,
 * vendor prefixes and small typos are handled by one deterministic scorer.
 */
export function rankInstalledApplications(
  queryValue: unknown,
  entriesValue: readonly InstalledApplicationCatalogEntry[],
  limit = 8,
): RankedInstalledApplication[] {
  const query = comparableText(queryValue);
  if (!query) return [];
  const entries = deduplicateCatalog(entriesValue);
  const queryVariants = identityVariants(query);
  const ranked = entries.map((entry) => rankEntry(queryVariants, entry));
  return ranked
    .filter((entry) => entry.score >= 0.5)
    .sort((left, right) => (
      right.score - left.score
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      || left.launchId.localeCompare(right.launchId)
    ))
    .slice(0, Math.max(1, Math.min(50, Math.trunc(limit) || 8)));
}

export function resolveInstalledApplication(
  queryValue: unknown,
  entries: readonly InstalledApplicationCatalogEntry[],
): InstalledApplicationResolution {
  const query = comparableText(queryValue);
  const candidates = rankInstalledApplications(query, entries, 8);
  return resolveRankedInstalledApplications(query, candidates);
}

export function resolveRankedInstalledApplications(
  queryValue: unknown,
  candidatesValue: readonly RankedInstalledApplication[],
): InstalledApplicationResolution {
  const query = comparableText(queryValue);
  const candidates = [...candidatesValue].slice(0, 8);
  const selected = candidates[0];
  if (!selected) return { status: 'missing', candidates: [] };

  const compactLength = query.replace(/\s/gu, '').length;
  const automaticThreshold = compactLength <= 2
    ? 0.995
    : compactLength === 3
      ? 0.94
      : compactLength <= 5
        ? 0.88
        : 0.84;
  if (selected.score < automaticThreshold) {
    return { status: 'missing', candidates: candidates.slice(0, 5) };
  }

  const runnerUp = candidates.find((entry) => !sameApplicationIdentity(entry, selected));
  const margin = runnerUp ? selected.score - runnerUp.score : 1;
  const selectedQueryExact = entryMatchesExactVariant(selected, query);
  if (runnerUp && margin < 0.08 && !selectedQueryExact) {
    return {
      status: 'ambiguous',
      candidates: candidates.filter((entry) => selected.score - entry.score < 0.08).slice(0, 5),
    };
  }
  return { status: 'unique', selected, candidates: candidates.slice(0, 5) };
}

export function sanitizeInstalledApplicationCatalog(value: unknown): InstalledApplicationCatalogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: InstalledApplicationCatalogEntry[] = [];
  for (const raw of value.slice(0, 2_000)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const name = boundedCatalogValue(record.name, 160);
    const launchId = boundedCatalogValue(record.launchId ?? record.appId, 2_048);
    if (record.source !== 'start-apps' && record.source !== 'app-path') continue;
    const source = record.source;
    const executableName = boundedCatalogValue(record.executableName, 160);
    if (!name || !launchId) continue;
    if (source === 'start-apps' && !isApplicationLaunchId(launchId)) continue;
    entries.push({ name, launchId, source, ...(executableName ? { executableName } : {}) });
  }
  return deduplicateCatalog(entries);
}

export function comparableApplicationText(value: unknown): string {
  return comparableText(value);
}

function rankEntry(
  queryVariants: readonly IdentityVariant[],
  entry: InstalledApplicationCatalogEntry,
): RankedInstalledApplication {
  const targets = entryIdentityTargets(entry);
  let bestScore = 0;
  let bestKind: RankedInstalledApplication['matchKind'] = 'fuzzy';
  const queryTokenCount = queryVariants[0]?.value.split(' ').filter(Boolean).length || 1;
  for (const target of targets) {
    for (const segment of comparableSegments(target.value, queryTokenCount)) {
      for (const query of queryVariants) {
        const queryCompactLength = query.value.replace(/\s/gu, '').length;
        const segmentCompactLength = segment.replace(/\s/gu, '').length;
        const coverage = Math.min(queryCompactLength, segmentCompactLength)
          / Math.max(1, Math.max(queryCompactLength, segmentCompactLength));
        const segmentWeight = segment === target.value ? 1 : 0.72 + (0.22 * coverage);
        const score = similarityScore(query.value, segment) * target.weight * segmentWeight;
        if (score > bestScore) {
          bestScore = score;
          bestKind = query.kind === 'exact' ? target.kind : query.kind;
        }
      }
    }
  }
  return { ...entry, score: roundedScore(bestScore), matchKind: bestKind };
}

function entryMatchesExactVariant(entry: InstalledApplicationCatalogEntry, query: string): boolean {
  const queryValues = new Set(identityVariants(query).map((variant) => variant.value));
  return entryIdentityTargets(entry).some((target) => queryValues.has(target.value));
}

function entryIdentityTargets(entry: InstalledApplicationCatalogEntry): Array<{
  value: string;
  weight: number;
  kind: RankedInstalledApplication['matchKind'];
}> {
  const cached = ENTRY_IDENTITY_TARGET_CACHE.get(entry);
  if (cached) return cached;
  const targets = buildEntryIdentityTargets(entry);
  ENTRY_IDENTITY_TARGET_CACHE.set(entry, targets);
  return targets;
}

function buildEntryIdentityTargets(entry: InstalledApplicationCatalogEntry): Array<{
  value: string;
  weight: number;
  kind: RankedInstalledApplication['matchKind'];
}> {
  const appPath = entry.source === 'app-path';
  const values: Array<{ value: unknown; weight: number }> = [
    { value: entry.name, weight: appPath ? 0.96 : 1 },
    { value: entry.executableName, weight: appPath ? 0.82 : 0.92 },
    // AUMIDs commonly preserve the invariant English product identity while
    // the visible Start name is localized by Windows. Extract only the product
    // portion and keep packaging/vendor tokens out of the match surface.
    ...launchProductIdentities(entry.launchId).map((value) => ({
      value,
      weight: appPath ? 0.68 : 0.94,
    })),
    // Launch identifiers are execution data, not user-facing product names.
    // Keep them as a weak recovery signal only; they must never outrank the
    // visible name or executable identity and silently redirect a request.
    { value: entry.launchId, weight: appPath ? 0.55 : 0.6 },
  ];
  const targets: Array<{ value: string; weight: number; kind: RankedInstalledApplication['matchKind'] }> = [];
  for (const source of values) {
    const normalized = comparableText(expandApplicationIdentity(source.value));
    if (!normalized) continue;
    // The query is corrected for keyboard layout in both directions. Repeating
    // those transformations for every catalog field multiplies work and adds
    // gibberish candidates without increasing recall.
    for (const variant of identityVariants(normalized, false)) {
      targets.push({ value: variant.value, weight: source.weight, kind: variant.kind });
    }
  }
  return uniqueBy(targets, (entryValue) => `${entryValue.value}\u0000${entryValue.weight}`);
}

function launchProductIdentities(launchIdValue: unknown): string[] {
  const launchId = String(launchIdValue || '').trim();
  if (!launchId || /^[a-z][a-z\d+.-]*:/iu.test(launchId) || /[\\/]/u.test(launchId)) return [];
  const packageIdentity = launchId
    .split('!', 1)[0]!
    .replace(/_[a-z\d]{8,}$/iu, '');
  const normalized = comparableText(expandApplicationIdentity(packageIdentity));
  if (!normalized) return [];
  const productTokens = uniqueBy(
    normalized
      .split(' ')
      .filter((token) => (
        token.length > 1
        && !GENERIC_LAUNCH_ID_TOKENS.has(token)
        && !/^(?=.*\d)[a-z\d]{8,}$/u.test(token)
      )),
    (token) => token,
  );
  return productTokens.length > 0 ? [productTokens.join(' ')] : [];
}

function expandApplicationIdentity(value: unknown): string {
  return String(value || '')
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .replace(/([\p{L}])([\p{N}])/gu, '$1 $2')
    .replace(/([\p{N}])([\p{L}])/gu, '$1 $2');
}

function identityVariants(value: string, includeKeyboardLayouts = true): IdentityVariant[] {
  const normalized = comparableText(value);
  const variants: IdentityVariant[] = [{ value: normalized, kind: 'exact' }];
  const transliterated = transliterateCyrillic(normalized);
  if (transliterated && transliterated !== normalized) variants.push({ value: transliterated, kind: 'transliteration' });
  const layouts = includeKeyboardLayouts
    ? [
        comparableText([...normalized].map((character) => RU_KEYBOARD_TO_LATIN[character] ?? character).join('')),
        comparableText([...normalized].map((character) => UK_KEYBOARD_TO_LATIN[character] ?? character).join('')),
        comparableText([...normalized].map((character) => LATIN_TO_RU_KEYBOARD[character] ?? character).join('')),
        comparableText([...normalized].map((character) => LATIN_TO_UK_KEYBOARD[character] ?? character).join('')),
      ]
    : [];
  for (const layout of layouts) {
    if (layout && layout !== normalized) variants.push({ value: layout, kind: 'layout' });
  }
  const layoutTransliterations = layouts.map((layout) => transliterateCyrillic(layout));
  for (const layout of layoutTransliterations) {
    if (layout && layout !== normalized) variants.push({ value: layout, kind: 'layout' });
  }
  for (const base of [normalized, transliterated, ...layouts, ...layoutTransliterations]) {
    for (const phonetic of [phoneticLatin(base, 'soft'), phoneticLatin(base, 'hard')]) {
      if (phonetic.replace(/\s/gu, '').length >= 3 && phonetic !== base) {
        variants.push({ value: phonetic, kind: 'phonetic' });
      }
    }
  }
  const priority: Record<RankedInstalledApplication['matchKind'], number> = {
    exact: 0,
    layout: 1,
    transliteration: 2,
    phonetic: 3,
    fuzzy: 4,
  };
  return uniqueBy(
    variants.filter((entry) => Boolean(entry.value)).sort((left, right) => priority[left.kind] - priority[right.kind]),
    (entry) => entry.value,
  );
}

function transliterateCyrillic(value: string): string {
  return comparableText([...value].map((character) => CYRILLIC_TO_LATIN[character] ?? character).join(''));
}

function phoneticLatin(value: string, mode: 'soft' | 'hard'): string {
  return comparableText(value)
    .replace(/shch/gu, 'sh')
    .replace(/zh/gu, 's')
    .replace(/ph/gu, 'f')
    .replace(/kh/gu, mode === 'hard' ? 'k' : 'h')
    .replace(/ch/gu, mode === 'hard' ? 'k' : 'ch')
    .replace(/ck/gu, 'k')
    .replace(/qu/gu, 'kv')
    .replace(/c(?=[aou])/gu, 'k')
    .replace(/c(?=[eiy])/gu, 's')
    .replace(/q/gu, 'k')
    .replace(/[wv]/gu, 'v')
    .replace(/[zj]/gu, 's')
    .replace(/(?:iy|yi|ij|ji|y)/gu, 'i')
    .replace(/[aeiou]+/gu, 'a')
    .replace(/a\b/gu, '')
    .replace(/(.)\1+/gu, '$1');
}

function comparableSegments(value: string, queryTokenCount: number): string[] {
  const tokens = value.split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const segments = [value];
  const minimum = Math.max(1, queryTokenCount - 1);
  const maximum = Math.min(tokens.length, queryTokenCount + 1);
  for (let width = minimum; width <= maximum; width += 1) {
    for (let index = 0; index + width <= tokens.length; index += 1) {
      segments.push(tokens.slice(index, index + width).join(' '));
    }
  }
  return [...new Set(segments)];
}

function similarityScore(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const compactLeft = left.replace(/\s/gu, '');
  const compactRight = right.replace(/\s/gu, '');
  if (compactLeft === compactRight) return 0.995;
  const shortest = Math.min(compactLeft.length, compactRight.length);
  const longest = Math.max(compactLeft.length, compactRight.length);
  if (shortest >= 3 && (compactLeft.startsWith(compactRight) || compactRight.startsWith(compactLeft))) {
    return 0.9 + (0.06 * shortest / longest);
  }
  if (shortest >= 4 && (compactLeft.includes(compactRight) || compactRight.includes(compactLeft))) {
    return 0.86 + (0.06 * shortest / longest);
  }
  const bigramSimilarity = diceCoefficient(compactLeft, compactRight);
  const bigramScore = bigramSimilarity * 0.86;
  const lengthGap = longest - shortest;
  const shouldMeasureEditDistance = lengthGap <= 2
    && (longest <= 6 || bigramSimilarity >= 0.2);
  if (!shouldMeasureEditDistance) return bigramScore;
  const distance = damerauLevenshtein(compactLeft, compactRight);
  if (distance === 1 && shortest >= 4) return 0.9;
  if (distance === 2 && shortest >= 7) return 0.84;
  const editSimilarity = 1 - (distance / Math.max(1, longest));
  return Math.max(editSimilarity * 0.9, bigramScore);
}

function damerauLevenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) matrix[row]![0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0]![column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + cost,
      );
      if (
        row > 1
        && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]
      ) {
        matrix[row]![column] = Math.min(matrix[row]![column]!, matrix[row - 2]![column - 2]! + cost);
      }
    }
  }
  return matrix[left.length]![right.length]!;
}

function diceCoefficient(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const rightPairs = new Map<string, number>();
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    rightPairs.set(pair, (rightPairs.get(pair) || 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    const remaining = rightPairs.get(pair) || 0;
    if (remaining <= 0) continue;
    overlap += 1;
    rightPairs.set(pair, remaining - 1);
  }
  return (2 * overlap) / ((left.length - 1) + (right.length - 1));
}

function comparableText(value: unknown): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function deduplicateCatalog(entries: readonly InstalledApplicationCatalogEntry[]): InstalledApplicationCatalogEntry[] {
  const selected: InstalledApplicationCatalogEntry[] = [];
  for (const entry of entries) {
    const name = comparableText(entry.name);
    const launchId = String(entry.launchId || '').trim();
    if (!name || !launchId || !['start-apps', 'app-path'].includes(entry.source)) continue;
    const exactIndex = selected.findIndex((candidate) => (
      candidate.source === entry.source
      && candidate.launchId.toLocaleLowerCase('en-US') === launchId.toLocaleLowerCase('en-US')
    ));
    if (exactIndex >= 0) continue;

    // Start Apps and App Paths often expose the same product through two
    // launch mechanisms. Prefer the shell registration, but keep distinct
    // entries from the same source so a real ambiguity still fails closed.
    const crossSourceIndex = selected.findIndex((candidate) => (
      comparableText(candidate.name) === name
      && candidate.source !== entry.source
    ));
    if (crossSourceIndex >= 0) {
      if (entry.source === 'start-apps') selected[crossSourceIndex] = entry;
      continue;
    }
    selected.push(entry);
  }
  return selected;
}

function sameApplicationIdentity(left: InstalledApplicationCatalogEntry, right: InstalledApplicationCatalogEntry): boolean {
  if (left.source === right.source && left.launchId.toLocaleLowerCase('en-US') === right.launchId.toLocaleLowerCase('en-US')) {
    return true;
  }
  if (comparableText(left.name) !== comparableText(right.name)) return false;
  if (left.source !== right.source) return true;
  const leftExecutable = comparableText(left.executableName || '');
  const rightExecutable = comparableText(right.executableName || '');
  return Boolean(leftExecutable && rightExecutable && leftExecutable === rightExecutable);
}

function boundedCatalogValue(value: unknown, maximum: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001F\u007F]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum)
    : '';
}

function isApplicationLaunchId(value: string): boolean {
  if (/^(?:https?|file):/iu.test(value)) return false;
  return !/\.(?:url|website|chm|rtf|html?|pdf)(?:$|[?#])/iu.test(value);
}

function roundedScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

function invertKeyboardLayout(layout: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(layout).map(([localized, latin]) => [latin, localized]),
  ));
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

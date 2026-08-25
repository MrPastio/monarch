import type { ComputerWindowSummary } from './native-bridge';

export interface ComputerWindowQueryMatch {
  window: ComputerWindowSummary;
  score: number;
}

/**
 * Rank a user-authored window/app name without granting fuzzy input authority.
 * The caller must still require exactly one result before observing or acting.
 */
export function rankComputerWindowQueryMatches(
  windows: readonly ComputerWindowSummary[],
  queryValue: unknown,
): ComputerWindowQueryMatch[] {
  const queries = normalizedComputerWindowQueryVariants(queryValue);
  if (queries.length === 0) return [];
  return windows
    .map((window, index) => {
      const title = normalizeComputerWindowQuery(window.title);
      const process = normalizeComputerWindowQuery(window.processName);
      const combined = `${title} ${process}`.trim();
      const candidateTokens = combined.split(' ').filter(Boolean);
      const score = Math.max(0, ...queries.map((query) => {
        const queryTokens = query.split(' ').filter(Boolean);
        if (title === query || process === query) return 1_000;
        if (title.includes(query) || process.includes(query)) return 900;
        if (queryTokens.length > 0 && queryTokens.every((token) => (
          candidateTokens.some((candidate) => windowTokenMatches(token, candidate))
        ))) {
          return 700 + queryTokens.reduce((total, token) => (
            total + Math.max(0, ...candidateTokens.map((candidate) => tokenSimilarityScore(token, candidate)))
          ), 0);
        }
        return 0;
      }));
      return { window, score, index };
    })
    .filter((entry) => entry.score >= 700)
    .sort((left, right) => (
      right.score - left.score
      || Number(left.window.minimized) - Number(right.window.minimized)
      || Number(right.window.foreground) - Number(left.window.foreground)
      || left.index - right.index
    ))
    .map(({ window, score }) => ({ window, score }));
}

export function computerWindowMatchesQuery(
  window: Pick<ComputerWindowSummary, 'title' | 'processName'>,
  queryValue: unknown,
): boolean {
  const queries = normalizedComputerWindowQueryVariants(queryValue);
  if (queries.length === 0) return false;
  const title = normalizeComputerWindowQuery(window.title);
  const process = normalizeComputerWindowQuery(window.processName);
  const candidateTokens = `${title} ${process}`.trim().split(' ').filter(Boolean);
  return queries.some((query) => {
    const queryTokens = query.split(' ').filter(Boolean);
    return title === query
      || process === query
      || title.includes(query)
      || process.includes(query)
      || (queryTokens.length > 0 && queryTokens.every((token) => (
        candidateTokens.some((candidate) => windowTokenMatches(token, candidate))
      )));
  });
}

export function normalizeComputerWindowQuery(value: unknown): string {
  return transliterateCyrillic(String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU'))
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
}

function normalizedComputerWindowQueryVariants(value: unknown): string[] {
  const normalized = normalizeComputerWindowQuery(value);
  if (!normalized) return [];
  const aliases: Record<string, string[]> = {
    calculator: ['kalkulyator'],
    kalkulyator: ['calculator'],
  };
  return [...new Set([normalized, ...(aliases[normalized] || [])])];
}

function windowTokenMatches(query: string, candidate: string): boolean {
  if (query === candidate || query.includes(candidate) || candidate.includes(query)) return true;
  const maximumDistance = query.length >= 8 ? 2 : 1;
  return query.length >= 3
    && candidate.length >= 3
    && Math.abs(query.length - candidate.length) <= maximumDistance
    && boundedLevenshtein(query, candidate, maximumDistance) <= maximumDistance;
}

function tokenSimilarityScore(query: string, candidate: string): number {
  if (query === candidate) return 40;
  if (query.includes(candidate) || candidate.includes(query)) return 30;
  const maximumDistance = query.length >= 8 ? 2 : 1;
  const distance = boundedLevenshtein(query, candidate, maximumDistance);
  return distance <= maximumDistance ? 20 - (distance * 4) : 0;
}

function boundedLevenshtein(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_entry, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        (current[rightIndex - 1] || 0) + 1,
        (previous[rightIndex] || 0) + 1,
        (previous[rightIndex - 1] || 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length] || 0;
}

function transliterateCyrillic(value: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  return [...value].map((character) => map[character] ?? character).join('');
}

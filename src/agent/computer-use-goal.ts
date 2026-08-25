import { resolveOscarFunctionInvocation } from '../core/oscar-function-invocation';

export type TrustedComputerUseEffectKind = 'click' | 'type' | 'key' | 'scroll';

export interface TrustedExactComputerUseGoal {
  exactTitle: string;
  effectKind: TrustedComputerUseEffectKind;
}

export type TrustedComputerUseWindowGoal =
  | { targetKind: 'exact-title'; target: string; effectKind: TrustedComputerUseEffectKind | 'close' }
  | { targetKind: 'title-query'; target: string; effectKind: 'close' };

const EXACT_TITLE_PATTERNS = [
  /точн\p{L}*\s+заголов\p{L}*\s*[«“„"']([^\r\n«»“”„"']{1,512})[»”“"']/giu,
  /\bexact\s+(?:window\s+)?title\s*[«“„"']([^\r\n«»“”„"']{1,512})[»”“"']/giu,
] as const;

/**
 * Extract only a title that the trusted user request labels as exact. A quoted
 * application name by itself is not enough authority to bind a native window.
 */
export function trustedExactComputerWindowTitle(requestValue: unknown): string {
  const request = typeof requestValue === 'string' ? requestValue : '';
  const matches = new Set<string>();
  for (const pattern of EXACT_TITLE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of request.matchAll(pattern)) {
      const title = match[1]?.replace(/\s+/gu, ' ').trim();
      if (title) matches.add(title);
    }
  }
  return matches.size === 1 ? [...matches][0]! : '';
}

/**
 * Recognize only a single explicit Computer Use effect in the original user
 * request. This grammar authorizes read-only preflight; it never authors the
 * effectful input atom, which remains a model decision verified by Kernel.
 */
export function parseTrustedExactComputerUseGoal(requestValue: unknown): TrustedExactComputerUseGoal | null {
  const request = typeof requestValue === 'string' ? requestValue : '';
  const exactTitle = trustedExactComputerWindowTitle(request);
  if (!exactTitle) return null;

  const effectText = request
    .replaceAll(exactTitle, ' ')
    .replace(/\b(?:do\s+not|don't|never)\s+(?:click|press|type|enter|scroll)\b[^.!?;]*/giu, ' ')
    .replace(/(?:^|[.!?;]\s*)(?:никогда\s+не|не)\s+(?:нажимай|нажми|кликай|кликни|вводи|введи|печатай|напечатай|прокручивай|прокрути)[^.!?;]*/giu, ' ')
    // A permissive fallback is not the requested effect. For example,
    // "при необходимости можешь кликнуть по полю" must not turn one exact
    // typing request into an ambiguous click+type goal and lose the bounded
    // runtime preflight.
    .replace(/(?:при\s+необходимости|если\s+нужно|опционально)[^.!?;]{0,80}(?:можешь|можно)[^.!?;]{0,40}(?:нажать|кликнуть|ввести|напечатать|прокрутить)[^.!?;]*/giu, ' ')
    .replace(/\b(?:optionally|if\s+needed|if\s+necessary)[^.!?;]{0,80}\b(?:may|can)\s+(?:click|press|type|enter|scroll)\b[^.!?;]*/giu, ' ');
  const matches = new Set<TrustedComputerUseEffectKind>();
  if (/(?:нажми|нажать|кликни|кликнуть|щёлкни|щелкни|\bclick\b)/iu.test(effectText)) matches.add('click');
  if (/(?:введи|ввести|напечатай|напечатать|\btype\b)/iu.test(effectText)) matches.add('type');
  if (/(?:клавиш\p{L}*|\b(?:send|press)\s+(?:a\s+)?key\b)/iu.test(effectText)) matches.add('key');
  if (/(?:прокрут\p{L}*|\bscroll\b)/iu.test(effectText)) matches.add('scroll');

  // "Press a key" is not a pointer click even though both may use "press".
  if (matches.has('key')) matches.delete('click');
  return matches.size === 1 ? { exactTitle, effectKind: [...matches][0]! } : null;
}

/**
 * Compile only a single explicitly requested Computer Use window effect.
 * Natural names are accepted solely for close, where a read-only query must
 * still resolve to exactly one window before the one-shot close action exists.
 */
export function parseTrustedComputerUseWindowGoal(requestValue: unknown): TrustedComputerUseWindowGoal | null {
  const request = typeof requestValue === 'string' ? requestValue : '';
  const exact = parseTrustedExactComputerUseGoal(request);
  if (exact) {
    return { targetKind: 'exact-title', target: exact.exactTitle, effectKind: exact.effectKind };
  }

  const exactTitle = trustedExactComputerWindowTitle(request);
  if (exactTitle && hasOnePositiveCloseIntent(request.replaceAll(exactTitle, ' '))) {
    return { targetKind: 'exact-title', target: exactTitle, effectKind: 'close' };
  }

  const invocation = resolveOscarFunctionInvocation(request);
  if (invocation?.id !== 'computer-use') return null;
  const closeMatch = invocation.requestText.match(
    /^(?:please\s+)?(?:закрой|закрыть|close|quit|exit)\s+(?:(?:окно|приложение|программу|app|window)\s+)?(.{1,160}?)\s*[.!?]?$/iu,
  );
  const target = closeMatch?.[1]
    ?.replace(/^[«“„"']+|[»”„"']+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (
    !target
    || target.length > 160
    || /[;\r\n]/u.test(target)
    || /(?:^|\s)(?:и\s+затем|а\s+потом|then|after\s+that)(?:\s|$)/iu.test(target)
  ) return null;
  return { targetKind: 'title-query', target, effectKind: 'close' };
}

function hasOnePositiveCloseIntent(value: string): boolean {
  const positive = value.match(/(?:\b(?:close|quit|exit)\b|закрой|закрыть)/giu) || [];
  const negative = value.match(/(?:\b(?:do\s+not|don't|never)\s+(?:close|quit|exit)\b|(?:никогда\s+не|не)\s+(?:закрывай|закрой|закрыть))/giu) || [];
  return positive.length === 1 && negative.length === 0;
}

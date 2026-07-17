export type VoiceBrightnessIntentKind = 'none' | 'action' | 'status' | 'clarification';

export interface VoiceBrightnessIntent {
  kind: VoiceBrightnessIntentKind;
  normalizedText: string;
  slots: Record<string, string>;
}

/**
 * Extracts only high-confidence display-brightness commands. Ambiguous or
 * negated phrases stay model-free and must be clarified before Device runs.
 */
export function classifyVoiceBrightnessIntent(value: string): VoiceBrightnessIntent {
  const source = String(value || '');
  const text = normalizeBrightnessText(source);
  if (!text) return brightnessIntent('none', text);

  const namedDomain = /(?:^|\s)(?:яркост\p{L}*|brightness)(?=\s|$)/u.test(text);
  const screenDomain = /(?:^|\s)(?:экран\p{L}*|диспле\p{L}*|display|screen)(?=\s|$)/u.test(text);
  const raises = /(?:^|\s)(?:увеличь|увеличьте|увеличить|повысь|повысьте|повысить|подними|поднимите|поднять|ярче|светлее|raise|increase|brighter)(?=\s|$)/u.test(text);
  const lowers = /(?:^|\s)(?:уменьши|уменьшите|уменьшить|понизь|понизьте|понизить|опусти|опустите|опустить|темнее|тусклее|lower|decrease|dimmer)(?=\s|$)/u.test(text);
  if (!namedDomain && !(screenDomain && (raises || lowers)) && !raises && !lowers) {
    return brightnessIntent('none', text);
  }

  const hasSetVerb = /(?:^|\s)(?:поставь|поставьте|поставить|установи|установите|установить|сделай|сделайте|сделать|выставь|выставьте|выставить|задай|задайте|задать|измени|измените|изменить|верни|верните|вернуть|set)(?=\s|$)/u.test(text);
  const hasCommand = hasSetVerb || raises || lowers;
  const informational = /(?:^|\s)(?:почему|зачем|как\s+(?:работает|изменить|настроить|поставить|установить)|что\s+такое|что\s+будет\s+если|стоит\s+ли|надо\s+ли)(?=\s|$)/u.test(text);
  if (informational) return brightnessIntent('none', text);

  const commandNegated = /(?:^|\s)не(?:\s+надо|\s+нужно)?\s+(?:поставь|установи|сделай|выставь|задай|измени|верни|увеличь|повысь|подними|уменьши|понизь|опусти|set|raise|lower|increase|decrease)(?=\s|$)/u.test(text);
  if (commandNegated) {
    return brightnessIntent('clarification', text, {
      intent: 'clarification',
      missing: 'affirmative-command',
    });
  }

  const looksLikeStatus = !hasCommand && (
    /(?:^|\s)(?:сейчас|какая|какой|сколько|покажи|показать|скажи|узнай|узнать|проверь|проверить|стоит|установлена|установлен|выставлена|выставлен)(?=\s|$)/u.test(text)
    || /^(?:яркост\p{L}*|brightness)$/u.test(text)
    || (/[?？]/u.test(source) && !/(?:^|\s)(?:почему|зачем|как|что\s+такое)(?=\s|$)/u.test(text))
  );

  const amount = readBrightnessPercentage(text);
  const maximum = /(?:^|\s)(?:максимум|максимальной|максимальную|полную|сто\s+процентов)(?=\s|$)/u.test(text);
  const minimum = /(?:^|\s)(?:минимум|минимальной|минимальную|нулевую|ноль\s+процентов)(?=\s|$)/u.test(text);
  const ellipticalSet = !hasCommand && !looksLikeStatus && (
    /^(?:яркост\p{L}*|brightness)\s+на\s+(?:100|[1-9]?\d|максимум|минимум|полную|нулевую)(?:\s*(?:%|процент\p{L}*))?$/u.test(text)
    || /^(?:яркост\p{L}*|brightness)\s+на\s+(?:ноль|сто)(?:\s+процент\p{L}*)?$/u.test(text)
  );

  if ((raises || lowers) && !(raises && lowers)) {
    const delta = (amount ?? 10) * (raises ? 1 : -1);
    return brightnessIntent('action', text, {
      operation: 'change',
      delta: String(delta),
    });
  }

  if ((hasSetVerb || ellipticalSet) && (maximum || minimum || amount !== null)) {
    const level = maximum ? 100 : minimum ? 0 : amount!;
    return brightnessIntent('action', text, {
      operation: 'set',
      value: String(level),
    });
  }

  if (!hasCommand && looksLikeStatus) {
    return brightnessIntent('status', text, { operation: 'get' });
  }

  if (namedDomain || screenDomain || hasCommand || amount !== null || maximum || minimum) {
    return brightnessIntent('clarification', text, {
      intent: 'clarification',
      missing: hasCommand ? 'operation-or-level' : 'command',
    });
  }

  return brightnessIntent('none', text);
}

function normalizeBrightnessText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}%]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function brightnessIntent(
  kind: VoiceBrightnessIntentKind,
  normalizedText: string,
  slots: Record<string, string> = {},
): VoiceBrightnessIntent {
  return {
    kind,
    normalizedText,
    slots: kind === 'none' ? slots : { domain: 'brightness', ...slots },
  };
}

function readBrightnessPercentage(text: string): number | null {
  const numeric = text.match(/(?:^|\s)(100|[1-9]?\d)\s*%?(?=\s|$)/u);
  if (numeric) return boundedPercent(Number(numeric[1]));
  if (/(?:^|\s)половин\p{L}*(?=\s|$)/u.test(text)) return 50;

  const values: Record<string, number> = {
    ноль: 0, один: 1, одна: 1, два: 2, три: 3, четыре: 4, пять: 5,
    шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
    одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
    пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18,
    девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40,
    пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80,
    девяносто: 90, сто: 100,
  };
  const tokens = text.split(' ');
  for (let index = 0; index < tokens.length; index += 1) {
    const first = values[tokens[index]!];
    if (first === undefined) continue;
    const second = values[tokens[index + 1]!] ?? 0;
    const combined = first >= 20 && first < 100 && second > 0 && second < 10 ? first + second : first;
    return boundedPercent(combined);
  }
  return null;
}

function boundedPercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

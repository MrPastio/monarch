const ONES_MASCULINE = Object.freeze([
  '', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
]);
const ONES_FEMININE = Object.freeze([
  '', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
]);
const TEENS = Object.freeze([
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
]);
const TENS = Object.freeze([
  '', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят',
  'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто',
]);
const HUNDREDS = Object.freeze([
  '', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот',
  'шестьсот', 'семьсот', 'восемьсот', 'девятьсот',
]);
const SCALES = Object.freeze([
  null,
  { feminine: true, forms: ['тысяча', 'тысячи', 'тысяч'] },
  { feminine: false, forms: ['миллион', 'миллиона', 'миллионов'] },
  { feminine: false, forms: ['миллиард', 'миллиарда', 'миллиардов'] },
  { feminine: false, forms: ['триллион', 'триллиона', 'триллионов'] },
]);

const DAY_ORDINALS = Object.freeze([
  '',
  'первое', 'второе', 'третье', 'четвёртое', 'пятое', 'шестое', 'седьмое',
  'восьмое', 'девятое', 'десятое', 'одиннадцатое', 'двенадцатое',
  'тринадцатое', 'четырнадцатое', 'пятнадцатое', 'шестнадцатое',
  'семнадцатое', 'восемнадцатое', 'девятнадцатое', 'двадцатое',
  'двадцать первое', 'двадцать второе', 'двадцать третье', 'двадцать четвёртое',
  'двадцать пятое', 'двадцать шестое', 'двадцать седьмое', 'двадцать восьмое',
  'двадцать девятое', 'тридцатое', 'тридцать первое',
]);
const MONTHS_GENITIVE = Object.freeze([
  '', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]);
const ORDINAL_GENITIVE_UNDER_TWENTY = Object.freeze([
  '', 'первого', 'второго', 'третьего', 'четвёртого', 'пятого', 'шестого',
  'седьмого', 'восьмого', 'девятого', 'десятого', 'одиннадцатого',
  'двенадцатого', 'тринадцатого', 'четырнадцатого', 'пятнадцатого',
  'шестнадцатого', 'семнадцатого', 'восемнадцатого', 'девятнадцатого',
]);
const ORDINAL_GENITIVE_TENS = Object.freeze({
  20: 'двадцатого',
  30: 'тридцатого',
  40: 'сорокового',
  50: 'пятидесятого',
  60: 'шестидесятого',
  70: 'семидесятого',
  80: 'восьмидесятого',
  90: 'девяностого',
});
const ORDINAL_GENITIVE_HUNDREDS = Object.freeze({
  100: 'сотого',
  200: 'двухсотого',
  300: 'трёхсотого',
  400: 'четырёхсотого',
  500: 'пятисотого',
  600: 'шестисотого',
  700: 'семисотого',
  800: 'восьмисотого',
  900: 'девятисотого',
});

const UNIT_DEFINITIONS = Object.freeze([
  { pattern: String.raw`(?:°\s*[cс]|градус(?:а|ов)?\s+цельсия)`, forms: ['градус Цельсия', 'градуса Цельсия', 'градусов Цельсия'] },
  { pattern: String.raw`(?:°\s*f|градус(?:а|ов)?\s+фаренгейта)`, forms: ['градус Фаренгейта', 'градуса Фаренгейта', 'градусов Фаренгейта'] },
  { pattern: String.raw`(?:км\s*/\s*ч|km\s*/\s*h)`, forms: ['километр в час', 'километра в час', 'километров в час'] },
  { pattern: String.raw`(?:м\s*/\s*с|m\s*/\s*s)`, forms: ['метр в секунду', 'метра в секунду', 'метров в секунду'] },
  { pattern: '(?:тб|tb)', forms: ['терабайт', 'терабайта', 'терабайт'] },
  { pattern: '(?:гб|gb)', forms: ['гигабайт', 'гигабайта', 'гигабайт'] },
  { pattern: '(?:мб|mb)', forms: ['мегабайт', 'мегабайта', 'мегабайт'] },
  { pattern: '(?:кб|kb)', forms: ['килобайт', 'килобайта', 'килобайт'] },
  { pattern: '(?:ггц|ghz)', forms: ['гигагерц', 'гигагерца', 'гигагерц'] },
  { pattern: '(?:мгц|mhz)', forms: ['мегагерц', 'мегагерца', 'мегагерц'] },
  { pattern: '(?:кгц|khz)', forms: ['килогерц', 'килогерца', 'килогерц'] },
  { pattern: '(?:гц|hz)', forms: ['герц', 'герца', 'герц'] },
  { pattern: '(?:квт|kw)', forms: ['киловатт', 'киловатта', 'киловатт'] },
  { pattern: '(?:вт|w)', forms: ['ватт', 'ватта', 'ватт'] },
  { pattern: '(?:мг|mg)', forms: ['миллиграмм', 'миллиграмма', 'миллиграммов'] },
  { pattern: '(?:кг|kg)', forms: ['килограмм', 'килограмма', 'килограммов'] },
  { pattern: '(?:гр|g)', forms: ['грамм', 'грамма', 'граммов'] },
  { pattern: '(?:км|km)', forms: ['километр', 'километра', 'километров'] },
  { pattern: '(?:см|cm)', forms: ['сантиметр', 'сантиметра', 'сантиметров'] },
  { pattern: '(?:мм|mm)', forms: ['миллиметр', 'миллиметра', 'миллиметров'] },
  { pattern: '(?:мл|ml)', forms: ['миллилитр', 'миллилитра', 'миллилитров'] },
  { pattern: '(?:л|l)', forms: ['литр', 'литра', 'литров'] },
  { pattern: '(?:м|m)', forms: ['метр', 'метра', 'метров'] },
]);

const NUMBER_PATTERN = String.raw`[+−-]?\d{1,15}(?:[.,]\d{1,6})?`;
const NUMBER_LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}])(?<![\p{L}\p{N}][.,])`;
const NUMBER_RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}])(?![.,]\d)`;
const DATE_PATTERN = /(?<!\d)(0?[1-9]|[12]\d|3[01])[.\/-](0?[1-9]|1[0-2])[.\/-]((?:19|20|21)\d{2})(?!\d)/gu;
const ISO_DATE_PATTERN = /(?<!\d)((?:19|20|21)\d{2})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])(?!\d)/gu;
const TIME_PATTERN = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?!\d)/gu;
const PERCENT_PATTERN = new RegExp(`${NUMBER_LEFT_BOUNDARY}(${NUMBER_PATTERN})\\s*%${NUMBER_RIGHT_BOUNDARY}`, 'giu');
const BARE_NUMBER_PATTERN = new RegExp(`${NUMBER_LEFT_BOUNDARY}(${NUMBER_PATTERN})${NUMBER_RIGHT_BOUNDARY}`, 'giu');

/**
 * Expands Russian numeric notation only for the private TTS payload. The UI
 * continues to render the original answer string unchanged.
 */
export function normalizeRussianSpeechText(value) {
  let text = String(value || '');
  if (!text || !/\d/.test(text)) return text;

  text = text.replace(DATE_PATTERN, (_match, day, month, year) => formatSpokenDate(day, month, year));
  text = text.replace(ISO_DATE_PATTERN, (_match, year, month, day) => formatSpokenDate(day, month, year));
  text = text.replace(TIME_PATTERN, (_match, hours, minutes, seconds) => formatSpokenTime(hours, minutes, seconds));

  for (const unit of UNIT_DEFINITIONS) {
    const matcher = new RegExp(
      `${NUMBER_LEFT_BOUNDARY}(${NUMBER_PATTERN})\\s*(${unit.pattern})${NUMBER_RIGHT_BOUNDARY}`,
      'giu',
    );
    text = text.replace(matcher, (_match, rawNumber) => {
      const numeric = parseSpeechNumber(rawNumber);
      const words = numberToRussianWords(rawNumber);
      const form = numeric.isDecimal ? unit.forms[1] : declineRussian(numeric.integer, unit.forms);
      return `${words} ${form}`;
    });
  }

  text = text.replace(PERCENT_PATTERN, (_match, rawNumber) => {
    const numeric = parseSpeechNumber(rawNumber);
    const words = numberToRussianWords(rawNumber);
    const form = numeric.isDecimal
      ? 'процента'
      : declineRussian(numeric.integer, ['процент', 'процента', 'процентов']);
    return `${words} ${form}`;
  });

  return text.replace(BARE_NUMBER_PATTERN, (_match, rawNumber) => numberToRussianWords(rawNumber));
}

export function numberToRussianWords(value, { feminine = false } = {}) {
  const parsed = parseSpeechNumber(value);
  const sign = parsed.sign < 0 ? 'минус ' : parsed.sign > 0 ? 'плюс ' : '';
  if (!parsed.isDecimal) return `${sign}${integerToRussianWords(parsed.integer, feminine)}`;

  const whole = integerToRussianWords(parsed.integer, true);
  const numerator = Number(parsed.fraction);
  const numeratorWords = integerToRussianWords(numerator, true);
  const wholeForm = declineRussian(parsed.integer, ['целая', 'целых', 'целых']);
  const fractionForms = parsed.fraction.length === 1
    ? ['десятая', 'десятых', 'десятых']
    : parsed.fraction.length === 2
      ? ['сотая', 'сотых', 'сотых']
      : parsed.fraction.length === 3
        ? ['тысячная', 'тысячных', 'тысячных']
        : null;
  if (!fractionForms) {
    const digits = [...parsed.fraction].map((digit) => integerToRussianWords(Number(digit))).join(' ');
    return `${sign}${whole} запятая ${digits}`;
  }
  return `${sign}${whole} ${wholeForm} ${numeratorWords} ${declineRussian(numerator, fractionForms)}`;
}

function parseSpeechNumber(value) {
  const source = String(value || '').trim().replace('−', '-');
  const sign = source.startsWith('-') ? -1 : source.startsWith('+') ? 1 : 0;
  const unsigned = source.replace(/^[+-]/, '').replace(',', '.');
  const [whole = '0', fraction = ''] = unsigned.split('.', 2);
  return {
    sign,
    integer: Number(whole) || 0,
    fraction,
    isDecimal: fraction.length > 0,
  };
}

function integerToRussianWords(value, feminine = false) {
  const integer = Math.max(0, Math.trunc(Number(value) || 0));
  if (integer === 0) return 'ноль';
  const groups = [];
  let remaining = integer;
  let scaleIndex = 0;
  while (remaining > 0 && scaleIndex < SCALES.length) {
    const triad = remaining % 1_000;
    if (triad > 0) {
      const scale = SCALES[scaleIndex];
      const triadWords = triadToRussianWords(
        triad,
        scale ? scale.feminine : feminine,
      );
      if (scale) triadWords.push(declineRussian(triad, scale.forms));
      groups.unshift(triadWords.join(' '));
    }
    remaining = Math.floor(remaining / 1_000);
    scaleIndex += 1;
  }
  return groups.join(' ') || String(integer);
}

function triadToRussianWords(value, feminine) {
  const words = [];
  const hundreds = Math.floor(value / 100);
  const lastTwo = value % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (lastTwo >= 10 && lastTwo <= 19) {
    words.push(TEENS[lastTwo - 10]);
    return words;
  }
  const tens = Math.floor(lastTwo / 10);
  const ones = lastTwo % 10;
  if (tens) words.push(TENS[tens]);
  if (ones) words.push((feminine ? ONES_FEMININE : ONES_MASCULINE)[ones]);
  return words;
}

function declineRussian(value, forms) {
  const integer = Math.abs(Math.trunc(Number(value) || 0));
  const lastHundred = integer % 100;
  if (lastHundred >= 11 && lastHundred <= 14) return forms[2];
  switch (integer % 10) {
  case 1: return forms[0];
  case 2:
  case 3:
  case 4: return forms[1];
  default: return forms[2];
  }
}

function formatSpokenTime(hoursValue, minutesValue, secondsValue) {
  const hours = Number(hoursValue);
  const minutes = Number(minutesValue);
  const parts = [
    `${integerToRussianWords(hours)} ${declineRussian(hours, ['час', 'часа', 'часов'])}`,
    `${integerToRussianWords(minutes)} ${declineRussian(minutes, ['минута', 'минуты', 'минут'])}`,
  ];
  if (secondsValue !== undefined) {
    const seconds = Number(secondsValue);
    parts.push(`${integerToRussianWords(seconds)} ${declineRussian(seconds, ['секунда', 'секунды', 'секунд'])}`);
  }
  return parts.join(' ');
}

function formatSpokenDate(dayValue, monthValue, yearValue) {
  const day = Number(dayValue);
  const month = Number(monthValue);
  const year = Number(yearValue);
  if (!DAY_ORDINALS[day] || !MONTHS_GENITIVE[month]) {
    return `${dayValue}.${monthValue}.${yearValue}`;
  }
  return `${DAY_ORDINALS[day]} ${MONTHS_GENITIVE[month]} ${yearToOrdinalGenitive(year)} года`;
}

function yearToOrdinalGenitive(year) {
  if (year === 2_000) return 'двухтысячного';
  const thousands = Math.floor(year / 1_000);
  const remainder = year % 1_000;
  if (thousands > 0 && remainder > 0) {
    const thousandsText = thousands === 1
      ? 'тысяча'
      : `${integerToRussianWords(thousands, true)} ${declineRussian(thousands, ['тысяча', 'тысячи', 'тысяч'])}`;
    return `${thousandsText} ${ordinalGenitiveUnderThousand(remainder)}`;
  }
  if (remainder > 0) return ordinalGenitiveUnderThousand(remainder);
  return integerToRussianWords(year);
}

function ordinalGenitiveUnderThousand(value) {
  if (value < 20) return ORDINAL_GENITIVE_UNDER_TWENTY[value];
  if (ORDINAL_GENITIVE_TENS[value]) return ORDINAL_GENITIVE_TENS[value];
  if (ORDINAL_GENITIVE_HUNDREDS[value]) return ORDINAL_GENITIVE_HUNDREDS[value];

  const hundreds = Math.floor(value / 100) * 100;
  const remainder = value % 100;
  const prefix = hundreds ? HUNDREDS[hundreds / 100] : '';
  let ending;
  if (remainder < 20) {
    ending = ORDINAL_GENITIVE_UNDER_TWENTY[remainder];
  } else {
    const tens = Math.floor(remainder / 10) * 10;
    const ones = remainder % 10;
    ending = ones
      ? `${TENS[tens / 10]} ${ORDINAL_GENITIVE_UNDER_TWENTY[ones]}`
      : ORDINAL_GENITIVE_TENS[tens];
  }
  return [prefix, ending].filter(Boolean).join(' ');
}

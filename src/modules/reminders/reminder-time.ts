/**
 * Reminder commands typed in the chat («напомни через 20 минут позвонить маме»).
 *
 * Like «запомни …», a reminder is an explicit, local and reversible user command:
 * it is recognised only at the start of the message and never grants any other
 * action. Times are read in the computer's local time zone.
 */

export type MonarchReminderRecurrence = 'none' | 'daily' | 'weekly';

export type ParsedReminderCommand =
  | { kind: 'create'; text: string; dueAt: Date; recurrence: MonarchReminderRecurrence }
  | { kind: 'needs-time'; text: string }
  | { kind: 'list' };

const COMMAND = /^(?:оскар[,!]?\s+)?(?:пожалуйста[,]?\s+)?(?:напомни(?:те)?|напоминай(?:те)?|поставь\s+напоминание|создай\s+напоминание|remind\s+me|set\s+a\s+reminder)(?:\s+мне|\s+me)?(?=[\s,.:!—-]|$)/iu;
const LIST = /^(?:оскар[,!]?\s+)?(?:(?:какие|покажи|список)\s+(?:у\s+меня\s+)?(?:мои\s+)?напоминани[яйе]|мои\s+напоминания|what\s+are\s+my\s+reminders|show\s+(?:my\s+)?reminders|list\s+(?:my\s+)?reminders)\s*[?.!]?$/iu;

const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
});

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  одну: 1, один: 1, одна: 1, две: 2, два: 2, пару: 2, три: 3, четыре: 4, пять: 5, шесть: 6,
  семь: 7, восемь: 8, девять: 9, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30,
  сорок: 40, пятьдесят: 50, a: 1, an: 1, one: 1, two: 2, three: 3, five: 5, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30,
});

const WEEKDAYS: ReadonlyArray<[RegExp, number]> = [
  [/^(?:в\s+)?(?:понедельник|monday)/iu, 1],
  [/^(?:во\s+)?(?:вторник|tuesday)/iu, 2],
  [/^(?:в\s+)?(?:сред[уа]|wednesday)/iu, 3],
  [/^(?:в\s+)?(?:четверг|thursday)/iu, 4],
  [/^(?:в\s+)?(?:пятниц[уа]|friday)/iu, 5],
  [/^(?:в\s+)?(?:суббот[уа]|saturday)/iu, 6],
  [/^(?:в\s+)?(?:воскресенье|sunday)/iu, 0],
];

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  январ: 0, феврал: 1, март: 2, апрел: 3, ма: 4, июн: 5, июл: 6, август: 7, сентябр: 8, октябр: 9, ноябр: 10, декабр: 11,
});

const PART_OF_DAY: Readonly<Record<string, number>> = Object.freeze({
  утром: 9, днём: 13, днем: 13, вечером: 19, ночью: 22,
  morning: 9, afternoon: 13, evening: 19, night: 22, tonight: 21,
});

export function parseReminderCommand(input: string, now: Date = new Date()): ParsedReminderCommand | null {
  const raw = String(input || '').replace(/\s+/gu, ' ').trim();
  if (!raw) return null;
  if (LIST.test(raw)) return { kind: 'list' };
  const command = raw.match(COMMAND);
  if (!command) return null;
  let rest = raw.slice(command[0].length).replace(/^[\s,.:!—-]+/u, '');
  let recurrence: MonarchReminderRecurrence = 'none';
  const repeat = rest.match(/(?:^|\s)(каждый\s+день|ежедневно|every\s+day|daily|каждую\s+неделю|еженедельно|every\s+week|weekly)(?=\s|$|[,.])/iu);
  if (repeat) {
    recurrence = /недел|week/iu.test(repeat[1]!) ? 'weekly' : 'daily';
    rest = cut(rest, repeat.index! + (repeat[0].length - repeat[1]!.length), repeat[1]!.length);
  }

  // Up to two time expressions anywhere in the sentence: a day and a clock time.
  let day: { date: Date; explicitTime: boolean } | null = null;
  let clock: { hours: number; minutes: number } | null = null;
  let relative: Date | null = null;
  for (let pass = 0; pass < 3; pass += 1) {
    const found = findTimeExpression(rest, now);
    if (!found) break;
    rest = cut(rest, found.index, found.length);
    if (found.relative) relative = found.relative;
    if (found.day && !day) day = { date: found.day, explicitTime: false };
    if (found.clock && !clock) clock = found.clock;
  }

  const text = cleanReminderText(rest);
  let dueAt: Date | null = relative;
  if (!dueAt && (day || clock)) {
    const base = day ? new Date(day.date) : new Date(now);
    const time = clock || { hours: 9, minutes: 0 };
    base.setHours(time.hours, time.minutes, 0, 0);
    if (!day && base.getTime() <= now.getTime()) base.setDate(base.getDate() + 1);
    dueAt = base;
  }
  if (!text) return dueAt ? { kind: 'needs-time', text: '' } : null;
  if (!dueAt || dueAt.getTime() <= now.getTime() - 60_000) return { kind: 'needs-time', text };
  return { kind: 'create', text: text.slice(0, 500), dueAt, recurrence };
}

interface TimeMatch {
  index: number;
  length: number;
  relative?: Date;
  day?: Date;
  clock?: { hours: number; minutes: number };
}

function findTimeExpression(value: string, now: Date): TimeMatch | null {
  const candidates: TimeMatch[] = [];
  const add = (match: RegExpMatchArray | null, build: (match: RegExpMatchArray) => Omit<TimeMatch, 'index' | 'length'> | null) => {
    if (!match || match.index === undefined) return;
    const built = build(match);
    if (built) candidates.push({ index: match.index, length: match[0].length, ...built });
  };

  add(value.match(/(?:^|\s)(?:через|in)\s+(полчаса|half\s+an\s+hour)(?=\s|$|[,.])/iu), () => ({ relative: new Date(now.getTime() + 30 * 60_000) }));
  add(value.match(/(?:^|\s)(?:через|in)\s+(?:(\d+(?:[.,]\d+)?|[a-zа-яё]+)\s+)?(сек(?:унд[уы]?)?|мин(?:ут[уы]?)?|час(?:а|ов)?|ч|дн(?:я|ей)|день|сутки|недел[юиь]|seconds?|minutes?|mins?|hours?|days?|weeks?)(?=\s|$|[,.])/iu), (match) => {
    const amount = readAmount(match[1]);
    const unit = readUnit(match[2]!);
    if (amount === null || !unit) return null;
    return { relative: new Date(now.getTime() + Math.round(amount * UNIT_MS[unit]!)) };
  });
  add(value.match(/(?:^|\s)(сегодня|завтра|послезавтра|today|tomorrow)(?=\s|$|[,.])/iu), (match) => {
    const word = match[1]!.toLowerCase();
    const date = startOfDay(now);
    date.setDate(date.getDate() + (word.startsWith('после') ? 2 : word === 'завтра' || word === 'tomorrow' ? 1 : 0));
    return { day: date };
  });
  for (const [pattern, weekday] of WEEKDAYS) {
    add(value.match(new RegExp(`(?:^|\\s)(?:on\\s+)?${pattern.source.slice(1)}(?=\\s|$|[,.])`, 'iu')), () => {
      const date = startOfDay(now);
      const delta = (weekday - date.getDay() + 7) % 7 || 7;
      date.setDate(date.getDate() + delta);
      return { day: date };
    });
  }
  add(value.match(/(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?=\s|$|[,])/u), (match) => {
    const date = new Date(now.getFullYear(), Number(match[2]) - 1, Number(match[1]));
    if (match[3]) date.setFullYear(Number(match[3].length === 2 ? `20${match[3]}` : match[3]));
    else if (date.getTime() < startOfDay(now).getTime()) date.setFullYear(date.getFullYear() + 1);
    return Number.isNaN(date.getTime()) || date.getDate() !== Number(match[1]) ? null : { day: date };
  });
  add(value.match(/(?:^|\s)(\d{1,2})\s+(январ[яь]|феврал[яь]|марта?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|августа?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь])(?=\s|$|[,.])/iu), (match) => {
    const stem = Object.keys(MONTHS).find((key) => match[2]!.toLowerCase().startsWith(key));
    if (stem === undefined) return null;
    const date = new Date(now.getFullYear(), MONTHS[stem]!, Number(match[1]));
    if (date.getTime() < startOfDay(now).getTime()) date.setFullYear(date.getFullYear() + 1);
    return { day: date };
  });
  add(value.match(/(?:^|\s)(?:в|к|at|by)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(утра|дня|вечера|ночи|часов|часа|час|am|pm|a\.m\.|p\.m\.)?(?=\s|$|[,.])/iu), (match) => {
    let hours = Number(match[1]);
    const minutes = Number(match[2] || 0);
    const suffix = String(match[3] || '').toLowerCase();
    if (!match[2] && !suffix && hours > 24) return null;
    if (/вечера|дня|pm|p\.m\./u.test(suffix) && hours < 12) hours += 12;
    if (/ночи/u.test(suffix) && hours === 12) hours = 0;
    if (/утра|am|a\.m\./u.test(suffix) && hours === 12) hours = 0;
    if (hours > 23 || minutes > 59) return null;
    return { clock: { hours, minutes } };
  });
  add(value.match(/(?:^|\s)(утром|днём|днем|вечером|ночью|in\s+the\s+morning|in\s+the\s+afternoon|in\s+the\s+evening|tonight)(?=\s|$|[,.])/iu), (match) => {
    const key = match[1]!.toLowerCase().replace(/^in\s+the\s+/u, '');
    const hours = PART_OF_DAY[key];
    return hours === undefined ? null : { clock: { hours, minutes: 0 } };
  });

  candidates.sort((left, right) => left.index - right.index);
  return candidates[0] || null;
}

function readAmount(value: string | undefined): number | null {
  if (!value) return 1;
  const normalized = value.toLowerCase().replace(',', '.');
  const number = Number(normalized);
  if (Number.isFinite(number) && number > 0) return number;
  return NUMBER_WORDS[normalized] ?? null;
}

function readUnit(value: string): keyof typeof UNIT_MS | null {
  const unit = value.toLowerCase();
  if (/^(?:сек|second)/u.test(unit)) return 'second';
  if (/^(?:мин|minute|min)/u.test(unit)) return 'minute';
  if (/^(?:час|ч$|hour)/u.test(unit)) return 'hour';
  if (/^(?:дн|день|сутки|day)/u.test(unit)) return 'day';
  if (/^(?:недел|week)/u.test(unit)) return 'week';
  return null;
}

function startOfDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function cut(value: string, index: number, length: number): string {
  return `${value.slice(0, index)} ${value.slice(index + length)}`.replace(/\s+/gu, ' ').trim();
}

/** What to remind about, without the linking words left around the time. */
function cleanReminderText(value: string): string {
  let text = value.replace(/\s+/gu, ' ').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    text = text
      .replace(/^[\s,.:;!—-]+/u, '')
      .replace(/^(?:мне|me|пожалуйста|please|о\s+том,?\s+что(?:бы)?|о\s+том|что(?:бы)?|про|об?|to|about|that)(?=\s|$)\s*/iu, '')
      .trim();
  }
  return text.replace(/[\s,;:—-]+$/u, '').replace(/^./u, (letter) => letter.toLocaleUpperCase('ru'));
}

/** «сегодня в 15:30», «завтра в 9:00», «в пятницу в 10:00», «14 октября в 18:00». */
export function describeReminderTime(dueAt: Date, now: Date = new Date()): string {
  const time = dueAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((startOfDay(dueAt).getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (days === 0) return `сегодня в ${time}`;
  if (days === 1) return `завтра в ${time}`;
  if (days === 2) return `послезавтра в ${time}`;
  if (days > 2 && days < 7) {
    const weekday = dueAt.toLocaleDateString('ru-RU', { weekday: 'long' });
    return `${/^(?:вторник)/u.test(weekday) ? 'во' : 'в'} ${weekday.replace(/а$/u, 'у')} в ${time}`;
  }
  return `${dueAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${time}`;
}

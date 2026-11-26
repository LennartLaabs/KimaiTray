import { normalizeText } from "./normalize";

/**
 * German date phrases of the quick entry bar and of voice input: the day an
 * entry belongs to.
 *
 * - "heute", "gestern", "vorgestern" (with "früh", "Abend" … after them)
 * - "am Montag", "letzten Freitag", "vorletzten Dienstag"
 * - "26. November", "am 3. März 2026", "26.11.", "26.11.2026", "am 26."
 *
 * Time tracking looks back: a weekday is the most recent one, a date without
 * a year the most recent one that is not in the future. Several phrases for
 * one day ("heute, 26. November") are all removed; the calendar date wins
 * over the weekday, the weekday over "gestern".
 */
export interface DateParseResult {
  /** Midnight of the named day; `null` when the input names none. */
  day: Date | null;
  /** The input words that do not belong to a date phrase, in order. */
  rest: string[];
  /** The words of the date phrases as typed. */
  phrase: string[];
}

const RELATIVE = new Map([
  ["heute", 0],
  ["gestern", 1],
  ["vorgestern", 2],
]);
/** After "heute" or a weekday these only say when on that day. */
const DAYTIMES = new Set([
  "morgen", "frueh", "vormittag", "mittag", "nachmittag", "abend", "nacht",
]);
const WEEKDAYS = [
  "sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag",
];
const MONTHS = new Map(
  [
    ["januar", "jan"],
    ["februar", "feb"],
    ["maerz", "mrz"],
    ["april", "apr"],
    ["mai"],
    ["juni", "jun"],
    ["juli", "jul"],
    ["august", "aug"],
    ["september", "sep", "sept"],
    ["oktober", "okt"],
    ["november", "nov"],
    ["dezember", "dez"],
  ].flatMap((names, month) => names.map((name) => [name, month] as const)),
);
/** "letzten Freitag": the one before today, even on a Friday. */
const LAST = new Set(["letzten", "letzte", "letzter", "vergangenen", "vorigen"]);
const BEFORE_LAST = new Set(["vorletzten", "vorletzte"]);
const THIS = new Set(["diesen", "diese", "dieser"]);
/** Words that lead into a date and belong to it: "am Montag", "vom 26.11.". */
const LEADS = new Set(["am", "vom", "den", "dem"]);
/** After these, "10.11" is a clock time, not the tenth of November. */
const CLOCK_LEADS = new Set(["seit", "ab", "um", "von", "bis", "gegen"]);
const UNITS = new Set(["h", "std", "stunde", "stunden", "m", "min", "mins", "minute", "minuten"]);
/** A date further back than this is not what a day and month without year mean. */
const MAX_DAYS_BACK = 183;
const DAY_MS = 24 * 60 * 60 * 1000;

const NUMERIC = /^(\d{1,2})\.(\d{1,2})(\.(\d{4}|\d{2})?)?$/;
const DAY_NUMBER = /^(\d{1,2})(\.?)$/;
const YEAR = /^(?:19|20)\d{2}$/;

/** The word without the punctuation of the sentence around it. */
function bare(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}.]+$/u, "");
}

/** Folded for comparing with word lists: "März," → "maerz". */
function fold(raw: string | undefined): string {
  return normalizeText(raw ?? "").replace(/ /g, "");
}

function midnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBefore(today: Date, days: number): Date {
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - days);
}

/** The date, or `null` when the calendar has no such day (31 February). */
function calendarDay(year: number, month: number, day: number): Date | null {
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : null;
}

/**
 * A day and month without a year: this year, unless that is still to come
 * and last year's is recent ("28.12." said in January).
 */
function recentDay(month: number, day: number, today: Date): Date | null {
  const thisYear = calendarDay(today.getFullYear(), month, day);
  if (thisYear && thisYear.getTime() <= today.getTime()) return thisYear;
  const lastYear = calendarDay(today.getFullYear() - 1, month, day);
  if (lastYear && today.getTime() - lastYear.getTime() <= MAX_DAYS_BACK * DAY_MS) {
    return lastYear;
  }
  return thisYear;
}

/** "am 26.": the most recent 26th. */
function recentDayOfMonth(day: number, today: Date): Date | null {
  for (let back = 0; back < 3; back++) {
    const date = calendarDay(today.getFullYear(), today.getMonth() - back, day);
    if (date && date.getTime() <= today.getTime()) return date;
  }
  return null;
}

interface Found {
  day: Date;
  /** Calendar dates outrank weekdays, weekdays outrank "gestern". */
  rank: number;
  start: number;
  used: number;
}

/** Reads a date phrase that begins at `index`. */
function readDate(words: readonly string[], index: number, today: Date): Found | null {
  const word = bare(words[index]);
  const folded = fold(word);
  const next = fold(words[index + 1]);
  const withDaytime = (used: number) => (DAYTIMES.has(fold(words[index + used])) ? used + 1 : used);

  const relative = RELATIVE.get(folded);
  if (relative !== undefined) {
    return { day: daysBefore(today, relative), rank: 1, start: index, used: withDaytime(1) };
  }

  // "letzten Freitag", "Montag".
  const qualifier = LAST.has(folded) ? 1 : BEFORE_LAST.has(folded) ? 2 : THIS.has(folded) ? 0 : -1;
  const weekday = WEEKDAYS.indexOf(qualifier >= 0 ? next : folded);
  if (weekday >= 0) {
    let back = (today.getDay() - weekday + 7) % 7;
    if (qualifier >= 1 && back === 0) back = 7;
    if (qualifier === 2) back += 7;
    const used = qualifier >= 0 ? 2 : 1;
    return { day: daysBefore(today, back), rank: 2, start: index, used: withDaytime(used) };
  }

  // "26.11.", "26.11.2026".
  const numeric = NUMERIC.exec(word);
  if (numeric) {
    const closed = numeric[3] !== undefined;
    const day = Number(numeric[1]);
    const month = Number(numeric[2]) - 1;
    // Without the closing dot it can also be a clock time or an amount.
    if (!closed && (CLOCK_LEADS.has(fold(words[index - 1])) || UNITS.has(next) || next === "uhr")) {
      return null;
    }
    if (month < 0 || month > 11) return null;
    const year = numeric[4];
    const date = year
      ? calendarDay(year.length === 2 ? 2000 + Number(year) : Number(year), month, day)
      : recentDay(month, day, today);
    return date ? { day: date, rank: 3, start: index, used: 1 } : null;
  }

  const number = DAY_NUMBER.exec(word);
  if (!number) return null;
  const day = Number(number[1]);
  // "26. November", "26 Nov 2026".
  const month = MONTHS.get(next);
  if (month !== undefined) {
    const year = bare(words[index + 2]);
    const date = YEAR.test(year)
      ? calendarDay(Number(year), month, day)
      : recentDay(month, day, today);
    return date ? { day: date, rank: 3, start: index, used: YEAR.test(year) ? 3 : 2 } : null;
  }
  // "am 26.": only with the dot and the word in front, or it is any number.
  if (number[2] === "." && LEADS.has(fold(words[index - 1]))) {
    const date = recentDayOfMonth(day, today);
    return date ? { day: date, rank: 3, start: index, used: 1 } : null;
  }
  return null;
}

/** Finds the date phrases in the input and removes them from the words. */
export function parseDate(words: readonly string[], now: Date): DateParseResult {
  const today = midnight(now);
  const found: Found[] = [];
  for (let index = 0; index < words.length; index++) {
    const date = readDate(words, index, today);
    if (!date) continue;
    // "am", "den" and the like in front belong to the phrase.
    while (date.start > 0 && LEADS.has(fold(words[date.start - 1]))) {
      date.start -= 1;
      date.used += 1;
    }
    found.push(date);
    index = date.start + date.used - 1;
  }
  if (found.length === 0) return { day: null, rest: [...words], phrase: [] };

  const inPhrase = (index: number) =>
    found.some((date) => index >= date.start && index < date.start + date.used);
  const best = found.reduce((a, b) => (b.rank > a.rank ? b : a));
  return {
    day: best.day,
    rest: words.filter((_, index) => !inPhrase(index)),
    phrase: words.filter((_, index) => inPhrase(index)),
  };
}

/** Whether both dates lie on the same calendar day. */
export function sameDay(a: Date, b: Date): boolean {
  return midnight(a).getTime() === midnight(b).getTime();
}

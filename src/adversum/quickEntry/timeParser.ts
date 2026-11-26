import { sameDay } from "./dateParser";

/**
 * German time phrases of the quick entry bar.
 *
 * - "seit 9:45", "ab halb 10", "um 14 uhr", "vor 20 min" → a timer that
 *   started in the past (`start`).
 * - "von 10 bis 11", "1,5 h", "90 min" → a finished entry (`range`).
 *
 * Parsing works on the raw words, because normalization would destroy ":"
 * and ",". Words that are not part of a time phrase are left alone.
 *
 * With a `day` other than today (see `dateParser.ts`) the times lie on that
 * day: "von 10 bis 11" is 10:00 to 11:00 there, and a bare duration ("2 h")
 * begins at `DEFAULT_BEGIN_HOUR`, because nothing says when it was. A day
 * with neither is `incomplete`: there is nothing to enter yet.
 */
export type TimeSpec =
  | { kind: "none" }
  | { kind: "start"; begin: Date }
  | { kind: "range"; begin: Date; end: Date }
  /** A time phrase was recognized, but it lies in the future. */
  | { kind: "future" }
  /** Another day was named, but neither a time span nor a duration. */
  | { kind: "incomplete" };

/** Where a duration without a clock time begins on another day. */
export const DEFAULT_BEGIN_HOUR = 9;

export interface TimeParseResult {
  time: TimeSpec;
  /** The input words that do not belong to the time phrase, in order. */
  rest: string[];
  /** The words of the time phrase as typed; empty without one. */
  phrase: string[];
}

interface ClockTime {
  hour: number;
  minute: number;
  /** Whether the hour was given in a form that could also mean afternoon. */
  ambiguous: boolean;
}

const START_WORDS = new Set(["seit", "ab", "um"]);
const MINUTE_UNITS = new Set(["m", "min", "mins", "minute", "minuten"]);
const HOUR_UNITS = new Set(["h", "std", "stunde", "stunden"]);
const NUMBER = String.raw`\d+(?:[.,]\d+)?`;

function lower(word: string | undefined): string {
  return (word ?? "").toLowerCase();
}

function clock(hour: number, minute: number, ambiguous: boolean): ClockTime | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 24 || minute < 0 || minute > 59) {
    return null;
  }
  if (hour === 24 && minute > 0) return null;
  return { hour: hour % 24, minute, ambiguous: ambiguous && hour >= 1 && hour <= 12 };
}

/** Reads a clock time starting at `index`; returns it with the words used. */
function readClock(words: string[], index: number): { time: ClockTime; used: number } | null {
  const first = lower(words[index]);
  const second = lower(words[index + 1]);
  const third = lower(words[index + 2]);
  const hourOf = (word: string) => (/^\d{1,2}$/.test(word) ? Number(word) : NaN);
  const withUhr = (time: ClockTime | null, used: number) => {
    if (!time) return null;
    return { time, used: lower(words[index + used]) === "uhr" ? used + 1 : used };
  };

  if (first === "halb") {
    const hour = hourOf(second);
    // "halb 10" is 9:30.
    return withUhr(clock(hour - 1, 30, true), 2);
  }
  if (first === "viertel" && (second === "nach" || second === "vor")) {
    const hour = hourOf(third);
    return withUhr(
      second === "nach" ? clock(hour, 15, true) : clock(hour - 1, 45, true),
      3,
    );
  }
  const digits = first.match(/^(\d{1,2})(?:[:.h](\d{2}))?$/);
  if (!digits) return null;
  const hasMinutes = digits[2] !== undefined;
  return withUhr(
    clock(Number(digits[1]), hasMinutes ? Number(digits[2]) : 0, true),
    1,
  );
}

function onDay(day: Date, hour: number, minute: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
}

/**
 * The most recent moment today that the clock time can mean. "seit 3" at
 * 15:30 means 15:00, at 9:00 it means 03:00. Returns `null` when every
 * reading lies in the future.
 */
function latestPast(time: ClockTime, now: Date): Date | null {
  const readings = [onDay(now, time.hour, time.minute)];
  if (time.ambiguous && time.hour < 12) {
    readings.push(onDay(now, time.hour + 12, time.minute));
  }
  const past = readings.filter((reading) => reading.getTime() <= now.getTime());
  return past.length > 0 ? past[past.length - 1]! : null;
}

/**
 * The clock time on a day that is over. Nothing there lies in the future, so
 * the hour decides: "von 2 bis 4" was the afternoon, "von 9 bis 11" the
 * morning.
 */
function onOtherDay(time: ClockTime, day: Date): Date {
  const hour = time.ambiguous && time.hour < 7 ? time.hour + 12 : time.hour;
  return onDay(day, hour, time.minute);
}

/** The first reading of the clock time after `begin` (same day). */
function firstAfter(time: ClockTime, begin: Date): Date | null {
  const readings = [onDay(begin, time.hour, time.minute)];
  if (time.ambiguous && time.hour < 12) {
    readings.push(onDay(begin, time.hour + 12, time.minute));
  }
  return readings.find((reading) => reading.getTime() > begin.getTime()) ?? null;
}

/** Minutes of "20", "1,5" … in the given unit; `null` for anything else. */
function minutesOf(amount: string, unit: string): number | null {
  const value = Number(amount.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (MINUTE_UNITS.has(unit)) return Math.round(value);
  if (HOUR_UNITS.has(unit)) return Math.round(value * 60);
  return null;
}

/** Reads a duration such as "20 min", "1,5h" or "1h30" starting at `index`. */
function readDuration(words: string[], index: number): { minutes: number; used: number } | null {
  const first = lower(words[index]);
  const second = lower(words[index + 1]);
  const compound = first.match(/^(\d+)h(\d{1,2})$/);
  if (compound) {
    return { minutes: Number(compound[1]) * 60 + Number(compound[2]), used: 1 };
  }
  const joined = first.match(new RegExp(`^(${NUMBER})([a-z]+)$`));
  if (joined) {
    const minutes = minutesOf(joined[1]!, joined[2]!);
    return minutes === null ? null : { minutes, used: 1 };
  }
  if (new RegExp(`^${NUMBER}$`).test(first)) {
    const minutes = minutesOf(first, second);
    return minutes === null ? null : { minutes, used: 2 };
  }
  return null;
}

const SPOKEN_DURATIONS: [string[], number][] = [
  [["einer", "halben", "stunde"], 30],
  [["einer", "viertelstunde"], 15],
  [["einer", "stunde"], 60],
];

function readSpokenDuration(words: string[], index: number): { minutes: number; used: number } | null {
  for (const [phrase, minutes] of SPOKEN_DURATIONS) {
    if (phrase.every((word, offset) => lower(words[index + offset]) === word)) {
      return { minutes, used: phrase.length };
    }
  }
  return null;
}

/** Finds the first time phrase in the input and removes it from the words. */
export function parseTime(input: string, now: Date, day?: Date | null): TimeParseResult {
  const words = input.trim().split(/\s+/).filter(Boolean);
  const other = day && !sameDay(day, now) ? day : null;
  const tomorrow = other !== null && other.getTime() > now.getTime();
  const found = (time: TimeSpec, index: number, used: number): TimeParseResult => ({
    time: tomorrow ? { kind: "future" } : time,
    rest: [...words.slice(0, index), ...words.slice(index + used)],
    phrase: words.slice(index, index + used),
  });
  const minute = 60_000;

  for (let index = 0; index < words.length; index++) {
    const word = lower(words[index]);

    if (word === "von") {
      const from = readClock(words, index + 1);
      const bisIndex = from ? index + 1 + from.used : -1;
      const to = from && lower(words[bisIndex]) === "bis" ? readClock(words, bisIndex + 1) : null;
      if (from && to) {
        const used = 1 + from.used + 1 + to.used;
        const begin = other ? onOtherDay(from.time, other) : latestPast(from.time, now);
        const end = begin ? firstAfter(to.time, begin) : null;
        return found(
          begin && end ? { kind: "range", begin, end } : { kind: "future" },
          index,
          used,
        );
      }
    }

    if (START_WORDS.has(word)) {
      const at = readClock(words, index + 1);
      if (at) {
        // A timer cannot have been running since some time on another day.
        if (other) return found({ kind: "incomplete" }, index, 1 + at.used);
        const begin = latestPast(at.time, now);
        return found(
          begin ? { kind: "start", begin } : { kind: "future" },
          index,
          1 + at.used,
        );
      }
    }

    if (word === "vor") {
      const ago = readDuration(words, index + 1) ?? readSpokenDuration(words, index + 1);
      if (ago) {
        return found(
          { kind: "start", begin: new Date(now.getTime() - ago.minutes * minute) },
          index,
          1 + ago.used,
        );
      }
    }

    const duration = readDuration(words, index);
    if (duration) {
      const end = other
        ? onDay(other, DEFAULT_BEGIN_HOUR, duration.minutes)
        : new Date(now.getTime());
      return found(
        { kind: "range", begin: new Date(end.getTime() - duration.minutes * minute), end },
        index,
        duration.used,
      );
    }
  }

  const nothing: TimeSpec = tomorrow
    ? { kind: "future" }
    : other
      ? { kind: "incomplete" }
      : { kind: "none" };
  return { time: nothing, rest: words, phrase: [] };
}

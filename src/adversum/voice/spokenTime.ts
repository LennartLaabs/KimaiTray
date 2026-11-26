import { normalizeText } from "../quickEntry/normalize";
import { numberWord } from "./spokenNumbers";

/**
 * Rewrites spoken time phrases into the forms the quick entry time parser
 * reads (`quickEntry/timeParser.ts`):
 *
 * - "seit zehn Uhr dreißig" → "seit 10:30"
 * - "von neun bis halb elf" → "von 9 bis halb 11"
 * - "zwischen acht und neun" → "von 8 bis 9"
 * - "seit einer halben Stunde" → "vor 30 min"
 * - "anderthalb Stunden" → "1,5 h"
 * - "von 14 Uhr bis jetzt" → "von 14 Uhr bis 14:20"
 *
 * Number words are only turned into digits next to a time word, so "Drei
 * Angebote" in a note stays as it was said.
 */

/** One spoken word: as heard, and folded for comparisons ("Zwölf" → "zwoelf"). */
export interface SpokenToken {
  raw: string;
  word: string;
}

export function spokenToken(raw: string): SpokenToken {
  return { raw, word: normalizeText(raw).replace(/ /g, "") };
}

const MINUTE_UNITS = new Set(["minute", "minuten", "min"]);
const HOUR_UNITS = new Set(["stunde", "stunden", "std", "h"]);
/** A number word right after one of these is part of a time. */
const TIME_BEFORE = new Set([
  "seit", "ab", "um", "von", "bis", "vor", "nach", "halb", "viertel", "uhr", "gegen",
]);
/** A number word right before one of these is part of a time. */
const TIME_AFTER = new Set(["uhr", "bis", "vor", "nach", ...MINUTE_UNITS, ...HOUR_UNITS]);
const CLOCK_STARTS = new Set(["seit", "ab", "um", "von", "bis"]);
const NOW_WORDS = new Set(["jetzt", "eben", "gerade", "nun"]);
const HALVES = new Map([
  ["anderthalb", "1,5"],
  ["eineinhalb", "1,5"],
  ["einundeinhalb", "1,5"],
  ["zweieinhalb", "2,5"],
  ["dreieinhalb", "3,5"],
  ["viereinhalb", "4,5"],
]);
const ONE_WORDS = new Set(["ein", "eine", "einer", "einen", "ne", "ner"]);
const QUARTER_HOURS = new Map([
  ["viertelstunde", 15],
  ["dreiviertelstunde", 45],
]);

const INTEGER = /^\d{1,3}$/;
const CLOCK = /^\d{1,2}(?:[:.]\d{2})?$/;
const AMOUNT = /^\d+(?:,\d+)?$/;

function isUnit(word: string | undefined): boolean {
  return word !== undefined && (MINUTE_UNITS.has(word) || HOUR_UNITS.has(word));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Replaces `count` tokens at `index` with the given raw words. */
function splice(tokens: SpokenToken[], index: number, count: number, ...raws: string[]): void {
  tokens.splice(index, count, ...raws.map(spokenToken));
}

/** "anderthalb Stunden", "eine halbe Stunde", "einer Viertelstunde", "eine Stunde". */
function rewriteSpokenDurations(tokens: SpokenToken[]): void {
  for (let index = 0; index < tokens.length; index++) {
    const word = tokens[index]!.word;
    const next = tokens[index + 1]?.word;
    const half = HALVES.get(word);
    if (half && next !== undefined && HOUR_UNITS.has(next)) {
      splice(tokens, index, 2, half, "h");
      continue;
    }
    // An article in front belongs to the phrase: "einer halben Stunde".
    const start = ONE_WORDS.has(word) ? index + 1 : index;
    const first = tokens[start]?.word;
    const second = tokens[start + 1]?.word;
    const quarter = QUARTER_HOURS.get(first ?? "");
    if (quarter) {
      splice(tokens, index, start - index + 1, String(quarter), "min");
    } else if ((first === "halbe" || first === "halben") && second === "stunde") {
      splice(tokens, index, start - index + 2, "30", "min");
    } else if (start > index && isUnit(first)) {
      splice(tokens, index, 2, "1", HOUR_UNITS.has(first!) ? "h" : "min");
    }
  }
}

/** "zwischen acht und neun" → "von acht bis neun". */
function rewriteBetween(tokens: SpokenToken[]): void {
  tokens.forEach((token, index) => {
    if (token.word !== "zwischen") return;
    const and = tokens.findIndex(
      (candidate, position) =>
        position > index && position <= index + 4 && candidate.word === "und",
    );
    if (and < 0) return;
    tokens[index] = spokenToken("von");
    tokens[and] = spokenToken("bis");
  });
}

/** Number words next to a time word become digits. */
function rewriteNumberWords(tokens: SpokenToken[]): void {
  tokens.forEach((token, index) => {
    const value = numberWord(token.word);
    if (value === null) return;
    const before = tokens[index - 1]?.word ?? "";
    const after = tokens[index + 1]?.word ?? "";
    if (TIME_BEFORE.has(before) || TIME_AFTER.has(after)) {
      tokens[index] = spokenToken(String(value));
    }
  });
}

/** Clock times and durations that are spread over several words. */
function rewriteDigits(tokens: SpokenToken[], now: Date): void {
  for (let index = 0; index < tokens.length; index++) {
    const word = tokens[index]!.word;
    const next = tokens[index + 1];
    const third = tokens[index + 2];

    // "10 Uhr 30" → "10:30", unless the 30 starts a duration ("30 Minuten").
    if (
      INTEGER.test(word) &&
      next?.word === "uhr" &&
      third !== undefined &&
      /^\d{1,2}$/.test(third.word) &&
      Number(third.word) < 60 &&
      !isUnit(tokens[index + 3]?.word)
    ) {
      splice(tokens, index, 3, `${word}:${pad(Number(third.word))}`);
      continue;
    }

    // "2 Stunden 30 Minuten", "1 Stunde und 15" → "2h30".
    if (INTEGER.test(word) && next !== undefined && HOUR_UNITS.has(next.word)) {
      const skip = third?.word === "und" ? 1 : 0;
      const minutes = tokens[index + 2 + skip]?.word ?? "";
      if (/^\d{1,2}$/.test(minutes) && Number(minutes) < 60) {
        const unit = MINUTE_UNITS.has(tokens[index + 3 + skip]?.word ?? "") ? 1 : 0;
        splice(tokens, index, 3 + skip + unit, `${word}h${pad(Number(minutes))}`);
        continue;
      }
    }

    if (!CLOCK_STARTS.has(word) && word !== "gegen") continue;

    // "gegen 10" → "um 10".
    if (word === "gegen") {
      if (next !== undefined && CLOCK.test(next.raw)) tokens[index] = spokenToken("um");
      continue;
    }
    if (!next) continue;

    // "bis jetzt" → "bis 14:20".
    if (word === "bis" && NOW_WORDS.has(next.word)) {
      splice(tokens, index + 1, 1, `${now.getHours()}:${pad(now.getMinutes())}`);
      continue;
    }

    // "seit 20 Minuten" is a duration, which the time parser reads after "vor".
    if ((word === "seit" || word === "ab") && AMOUNT.test(next.raw) && isUnit(third?.word)) {
      tokens[index] = spokenToken("vor");
      continue;
    }

    // "kurz nach 10" → "10".
    if (next.word === "kurz" && (third?.word === "nach" || third?.word === "vor")) {
      tokens.splice(index + 1, 2);
      continue;
    }

    // "10 nach 9" → "9:10", "20 vor 10" → "9:40".
    const hour = tokens[index + 3]?.word ?? "";
    if (
      /^\d{1,2}$/.test(next.word) &&
      Number(next.word) < 60 &&
      (third?.word === "nach" || third?.word === "vor") &&
      /^\d{1,2}$/.test(hour)
    ) {
      const minutes = Number(next.word);
      const clock =
        third.word === "nach"
          ? `${Number(hour)}:${pad(minutes)}`
          : `${(Number(hour) + 23) % 24}:${pad(60 - minutes)}`;
      splice(tokens, index + 1, 3, clock);
    }
  }
}

/** "10 bis 11" without "von" in front → "von 10 bis 11". */
function addMissingFrom(tokens: SpokenToken[]): void {
  const until = tokens.findIndex((token) => token.word === "bis");
  if (until < 1) return;
  const start = tokens[until - 1]!.word === "uhr" ? until - 2 : until - 1;
  const from = tokens[start];
  if (!from || !CLOCK.test(from.raw)) return;
  // "halb 10 bis 11": the clock time starts one word earlier.
  const begin = tokens[start - 1]?.word === "halb" ? start - 1 : start;
  if (!CLOCK_STARTS.has(tokens[begin - 1]?.word ?? "")) {
    tokens.splice(begin, 0, spokenToken("von"));
  }
}

export function rewriteSpokenTime(tokens: readonly SpokenToken[], now: Date): SpokenToken[] {
  const result = [...tokens];
  rewriteSpokenDurations(result);
  rewriteBetween(result);
  rewriteNumberWords(result);
  rewriteDigits(result, now);
  addMissingFrom(result);
  return result;
}

import { parseDate } from "../quickEntry/dateParser";
import { normalizeText } from "../quickEntry/normalize";
import { parseTime } from "../quickEntry/timeParser";
import { numberWord } from "../voice/spokenNumbers";
import { rewriteSpokenTime, spokenToken } from "../voice/spokenTime";
import type { Amount, Clause, Extraction, Relation, Vague } from "./types";

/**
 * The rules that split a sentence into activities. They cover the common
 * patterns: activities separated by commas or by "dazwischen", "danach",
 * "vorher", "der Rest", each with a duration, a count ("8 mal kurz") or a
 * time span. What names a task is decided by the caller (`isTask`), because
 * that needs the catalog.
 */

/** What "kurz" and "ein paar Minuten" are taken as. */
export const VAGUE_MINUTES = 5;

const RELATIONS = new Map<string, Relation>([
  ["dazwischen", "within"],
  ["zwischendurch", "within"],
  ["zwischendrin", "within"],
  ["mittendrin", "within"],
  ["waehrenddessen", "within"],
  ["danach", "after"],
  ["anschliessend", "after"],
  ["dann", "after"],
  ["spaeter", "after"],
  ["hinterher", "after"],
  ["nachher", "after"],
  ["davor", "before"],
  ["vorher", "before"],
  ["zuvor", "before"],
]);
const REST_WORDS = new Set(["rest", "restliche", "restlichen", "uebrige", "uebrigen", "ansonsten"]);
const ARTICLES = new Set(["der", "den", "die", "das"]);
const WINDOW_WORDS = new Set(["letzten", "letzte", "vergangenen", "vergangene"]);
const UNKNOWN_COUNTS = new Set(["mehrmals", "mehrfach", "oefter", "oefters", "staendig", "wiederholt"]);
const EACH_WORDS = new Set(["je", "jeweils"]);
const HOURS = new Set(["stunde", "stunden", "std", "h"]);
const MINUTES = new Set(["minute", "minuten", "min"]);
const FRACTIONS = new Map([
  ["halbe", 0.5],
  ["halben", 0.5],
  ["anderthalb", 1.5],
  ["eineinhalb", 1.5],
  ["zweieinhalb", 2.5],
]);

interface Word {
  /** As said, without the punctuation around it. */
  raw: string;
  /** Folded for comparing: "Währenddessen," → "waehrenddessen". */
  word: string;
  /** The sentence pauses after it: a comma or a full stop followed. */
  stop: boolean;
}

function toWord(raw: string): Word {
  const bare = raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
  return {
    raw: bare,
    word: normalizeText(bare).replace(/ /g, ""),
    // "26." and "1." are ordinals, not sentence ends.
    stop: /[,;:!?]$/.test(raw) || /[^\d.]\.+$/.test(raw),
  };
}

function numberOf(word: string): number | null {
  if (/^\d+$/.test(word)) return Number(word);
  return numberWord(word);
}

/** "die letzten 3 Stunden", "in der letzten halben Stunde": minutes, words used. */
function readWindow(words: readonly Word[], index: number): { minutes: number; used: number } | null {
  if (!WINDOW_WORDS.has(words[index]!.word)) return null;
  const next = words[index + 1]?.word ?? "";
  const amount = FRACTIONS.get(next) ?? numberOf(next);
  const unit = words[index + (amount === null ? 1 : 2)]?.word ?? "";
  const factor = HOURS.has(unit) ? 60 : MINUTES.has(unit) ? 1 : 0;
  if (factor === 0) return null;
  return { minutes: Math.round((amount ?? 1) * factor), used: amount === null ? 2 : 3 };
}

/** "8 mal", "achtmal", "8x": the count and the words used. */
function readCount(words: readonly Word[], index: number): { count: number; used: number } | null {
  const word = words[index]!.word;
  const joined = /^(.+?)(?:mal|x)$/.exec(word);
  const alone = joined ? numberOf(joined[1]!) : null;
  if (alone !== null) return { count: alone, used: 1 };
  const count = numberOf(word);
  return count !== null && words[index + 1]?.word === "mal" ? { count, used: 2 } : null;
}

interface ParsedClause extends Clause {
  /** Something was said about how long, how often or in which order. */
  marked: boolean;
}

/** Reads what one clause says about order and amount; the rest is its text. */
function readClause(words: readonly Word[], now: Date, day: Date | null): ParsedClause {
  let relation: Relation = "none";
  let rest = false;
  /** `undefined`: not counted; `null`: counted, but not how often. */
  let count: number | null | undefined;
  let vague: Vague | undefined;
  const kept: Word[] = [];
  for (let index = 0; index < words.length; index++) {
    const { word } = words[index]!;
    const next = words[index + 1]?.word;
    const found = RELATIONS.get(word);
    if (found) {
      relation = found;
    } else if (REST_WORDS.has(word) || (ARTICLES.has(word) && REST_WORDS.has(next ?? ""))) {
      rest = true;
      if (ARTICLES.has(word)) index += 1;
      if (words[index + 1]?.word === "zeit") index += 1;
    } else if (UNKNOWN_COUNTS.has(word) || (word === "immer" && next === "wieder")) {
      count = count ?? null;
      if (word === "immer") index += 1;
    } else if (word === "paar" && (next === "mal" || MINUTES.has(next ?? ""))) {
      if (next === "mal") count = count ?? null;
      else vague = "paar";
      if (kept[kept.length - 1]?.word === "ein") kept.pop();
      index += 1;
    } else if (EACH_WORDS.has(word)) {
      count = count ?? null;
    } else if (word === "kurz") {
      vague = vague ?? "kurz";
    } else {
      const counted = readCount(words, index);
      if (counted) {
        count = counted.count;
        index += counted.used - 1;
      } else {
        kept.push(words[index]!);
      }
    }
  }

  const spoken = rewriteSpokenTime(kept.map((item) => spokenToken(item.raw)), now);
  const timed = parseTime(spoken.map((token) => token.raw).join(" "), now, day);
  let minutes: number | null = null;
  let span: { begin: Date; end: Date } | null = null;
  if (timed.time.kind === "range") {
    if (timed.phrase[0]!.toLowerCase() === "von") span = timed.time;
    else minutes = Math.round((timed.time.end.getTime() - timed.time.begin.getTime()) / 60_000);
  } else if (timed.time.kind === "start") {
    span = { begin: timed.time.begin, end: now };
  }

  let amount: Amount;
  if (rest) amount = { kind: "rest" };
  else if (count !== undefined) {
    const each = minutes ?? (vague ? VAGUE_MINUTES : null);
    amount = { kind: "times", count, each, ...(minutes === null && vague ? { vague } : {}) };
  } else if (span) amount = { kind: "span", begin: span.begin, end: span.end };
  else if (minutes !== null) amount = { kind: "minutes", minutes };
  else if (vague) amount = { kind: "minutes", minutes: VAGUE_MINUTES, vague };
  else amount = { kind: "unknown" };

  return {
    text: timed.rest.join(" "),
    amount,
    relation,
    marked: amount.kind !== "unknown" || relation !== "none",
  };
}

/** Splits at "und" where both sides are an activity with an amount of their own. */
function splitAtAnd(
  words: readonly Word[],
  now: Date,
  day: Date | null,
  isTask: (text: string) => boolean,
): Word[][] {
  const complete = (part: readonly Word[]) => {
    const clause = readClause(part, now, day);
    return clause.amount.kind !== "unknown" && isTask(clause.text);
  };
  for (let index = 1; index < words.length - 1; index++) {
    if (words[index]!.word !== "und") continue;
    const left = words.slice(0, index);
    const right = words.slice(index + 1);
    if (complete(left) && complete(right)) return [left, ...splitAtAnd(right, now, day, isTask)];
  }
  return [[...words]];
}

/**
 * Reads the activities of a sentence. `isTask` tells whether a text names a
 * customer, project or activity; clauses that do not are notes or amounts of
 * the activity next to them.
 */
export function extractClauses(
  sentence: string,
  now: Date,
  isTask: (text: string) => boolean,
): Extraction {
  const cleaned = sentence.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").trim();
  const dated = parseDate(cleaned.split(/\s+/).filter(Boolean), now);
  // What the date phrase took away may have carried the comma.
  const all = dated.rest.map(toWord).filter((item) => item.word !== "");

  // "die letzten 3 Stunden" is the window for all activities.
  let windowMinutes: number | null = null;
  const words: Word[] = [];
  for (let index = 0; index < all.length; index++) {
    const said: ReturnType<typeof readWindow> =
      windowMinutes === null ? readWindow(all, index) : null;
    if (!said) {
      words.push(all[index]!);
      continue;
    }
    windowMinutes = said.minutes;
    while (["in", "der", "den", "die"].includes(words[words.length - 1]?.word ?? "")) words.pop();
    index += said.used - 1;
  }

  // Clauses end at punctuation and begin at words such as "danach".
  const groups: Word[][] = [[]];
  words.forEach((item, index) => {
    const current = groups[groups.length - 1]!;
    const startsRest =
      REST_WORDS.has(item.word) ||
      (ARTICLES.has(item.word) && REST_WORDS.has(words[index + 1]?.word ?? ""));
    const afterArticle = ARTICLES.has(current[current.length - 1]?.word ?? "") && REST_WORDS.has(item.word);
    if ((RELATIONS.has(item.word) || startsRest) && current.length > 0 && !afterArticle) {
      if (current[current.length - 1]!.word === "und") current.pop();
      groups.push([item]);
    } else {
      current.push(item);
    }
    if (item.stop) groups.push([]);
  });

  const day = dated.day;
  const parsed = groups
    .filter((group) => group.length > 0)
    .flatMap((group) => splitAtAnd(group, now, day, isTask))
    .map((group) => readClause(group, now, day));

  // A clause that names no task belongs to the activity next to it: as its
  // note ("…, Roll-Ups für die Messe") or as its amount ("…, eine Stunde").
  const clauses: ParsedClause[] = [];
  let pending: ParsedClause | null = null;
  /** Words said before the first activity; they go with it. */
  let lead = "";
  for (const clause of parsed) {
    const named = clause.text !== "" && isTask(clause.text);
    const previous = clauses[clauses.length - 1];
    if (named) {
      clause.text = `${lead} ${clause.text}`.trim();
      lead = "";
      if (pending && clause.amount.kind === "unknown") {
        clause.amount = pending.amount;
        if (clause.relation === "none") clause.relation = pending.relation;
        clause.marked = true;
      }
      pending = null;
      clauses.push(clause);
    } else if (!clause.marked) {
      if (previous) previous.text = `${previous.text} ${clause.text}`.trim();
      else lead = `${lead} ${clause.text}`.trim();
    } else if (clause.text === "" && previous?.amount.kind === "unknown" && clause.relation === "none") {
      previous.amount = clause.amount;
      previous.marked = true;
    } else if (clause.text === "") {
      // "Danach, 20 Minuten, …": order and amount can come one by one.
      if (pending && clause.amount.kind === "unknown") clause.amount = pending.amount;
      if (pending && clause.relation === "none") clause.relation = pending.relation;
      pending = clause;
    } else {
      // An amount and words, but no task among them.
      clauses.push(clause);
    }
  }

  return {
    clauses: clauses.map(({ text, amount, relation }) => ({ text, amount, relation })),
    windowMinutes,
    day,
  };
}

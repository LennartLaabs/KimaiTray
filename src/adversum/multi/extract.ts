import { parseDate } from "../quickEntry/dateParser";
import { numberWord } from "../voice/spokenNumbers";
import { spokenToken } from "../voice/spokenTime";
import { VAGUE_MINUTES } from "./segment";
import type { Amount, Clause, Extraction, Relation } from "./types";

/**
 * The second way to understand a sentence with several entries: a language
 * model, asked only where the rules are unsure. It extracts what was said
 * and nothing more. It never calculates: sums, the rest and the clock times
 * are `plan.ts`'s job, and the tasks are matched by `draft.ts`.
 *
 * The native side asks the local model first (llama.cpp on this Mac, see
 * `localPrompt.ts`) and, only where the setting allows it, the Claude Code
 * command line of the user's own subscription (`modelApi.ts`,
 * `src-tauri/src/adversum/multi.rs`). Claude Code gets the sentence alone,
 * no list of customers.
 */

export const EXTRACT_INSTRUCTIONS = [
  "You read one German sentence in which someone says what they worked on, and list the activities in it.",
  "Copy what was said. Never calculate, never add up, never invent an activity or a number.",
  "task: the words from the sentence that name the customer, the project, the kind of work and what was done. Leave out amounts, times and filler words.",
  "minutes: the duration said for this activity in minutes ('eine Stunde' is 60, 'eine halbe Stunde' 30). For repeated activities the duration of one occurrence ('je 7 Minuten' is 7). 0 if none was said.",
  "count: how often, if a number was said ('8 mal' is 8), else 0.",
  "repeated: true if it happened several times ('immer wieder', 'mehrmals', '8 mal').",
  "vague: true if the duration was only 'kurz' or 'ein paar Minuten'.",
  "rest: true for 'der Rest' or 'die restliche Zeit'.",
  "relation: 'within' if it interrupted the activity before it ('dazwischen', 'zwischendurch'), 'after' for 'danach' or 'dann', 'before' for 'vorher' or 'davor', else 'none'.",
  "from, to: clock times said for this activity as HH:MM ('von 9 bis 12' is 09:00 and 12:00), else empty.",
  "window_minutes: the time span all activities lie in, if one was said ('die letzten 3 Stunden' is 180), else 0.",
].join("\n");

const NUMBER = { type: "integer" };
const TEXT = { type: "string" };
const FLAG = { type: "boolean" };
/** The shape of the answer, for models that can be held to a JSON schema. */
export const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    window_minutes: NUMBER,
    activities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: TEXT,
          minutes: NUMBER,
          count: NUMBER,
          repeated: FLAG,
          vague: FLAG,
          rest: FLAG,
          relation: { type: "string", enum: ["none", "within", "after", "before"] },
          from: TEXT,
          to: TEXT,
        },
        required: ["task", "minutes", "count", "repeated", "vague", "rest", "relation", "from", "to"],
      },
    },
  },
  required: ["window_minutes", "activities"],
};

const RELATIONS: readonly Relation[] = ["none", "within", "after", "before"];
const MAX_MINUTES = 24 * 60;
const MAX_COUNT = 200;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A positive whole number up to `max`; anything else is "not said". */
function amountOf(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : null;
}

function clockOn(value: unknown, day: Date): Date | null {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(match[1]), Number(match[2]));
}

function clauseOf(value: unknown, day: Date): Clause | null {
  const activity = record(value);
  const text = typeof activity?.task === "string" ? activity.task.trim() : "";
  if (!activity || text === "" || text.length > 300) return null;
  const minutes = amountOf(activity.minutes, MAX_MINUTES);
  const count = amountOf(activity.count, MAX_COUNT);
  const vague = activity.vague === true && minutes === null;
  const from = clockOn(activity.from, day);
  const to = clockOn(activity.to, day);
  let amount: Amount;
  if (activity.rest === true) amount = { kind: "rest" };
  else if (from && to && to.getTime() > from.getTime()) {
    amount = { kind: "span", begin: from, end: to };
  } else if (count !== null || activity.repeated === true) {
    amount = {
      kind: "times",
      count,
      each: minutes ?? (vague ? VAGUE_MINUTES : null),
      ...(vague ? { vague: "kurz" as const } : {}),
    };
  } else if (minutes !== null) amount = { kind: "minutes", minutes };
  else if (vague) amount = { kind: "minutes", minutes: VAGUE_MINUTES, vague: "kurz" };
  else amount = { kind: "unknown" };
  const relation = RELATIONS.find((known) => known === activity.relation) ?? "none";
  return { text, amount, relation };
}

/** The numbers a sentence really contains, in the forms a model may return them. */
interface Said {
  /** Durations in minutes: "eine Stunde" is 60, "à zehn Minuten" 10. */
  minutes: Set<number>;
  /** Any number, as a count: "8 mal", "drei Calls". */
  counts: Set<number>;
  /** Clock times as minutes of the day, mornings also as afternoons. */
  clocks: Set<number>;
}

const HOUR_UNITS = new Set(["h", "std", "stunde", "stunden"]);
const MINUTE_UNITS = new Set(["min", "mins", "minute", "minuten"]);
const CLOCK_LEADS = new Set(["von", "bis", "um", "ab", "seit", "gegen"]);

const FRACTIONS = new Map([
  ["halbe", 0.5],
  ["halben", 0.5],
  ["viertel", 0.25],
  ["dreiviertel", 0.75],
  ["anderthalb", 1.5],
  ["eineinhalb", 1.5],
  ["einundeinhalb", 1.5],
  ["zweieinhalb", 2.5],
  ["dreieinhalb", 3.5],
  ["ein", 1],
  ["eine", 1],
  ["einer", 1],
  ["ne", 1],
]);
const COMPOUNDS = new Map([
  ["viertelstunde", 15],
  ["dreiviertelstunde", 45],
]);

/**
 * Reads every duration, count and clock time out of a sentence. On purpose
 * simpler and more generous than the parser: it does not decide what a
 * number means, only whether it was said.
 */
export function saidNumbers(sentence: string): Said {
  const words = sentence
    .split(/\s+/)
    .map((raw) => raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, ""))
    .filter(Boolean)
    .map((raw) => ({ raw: raw.toLowerCase(), word: spokenToken(raw).word }));
  const said: Said = { minutes: new Set(), counts: new Set(), clocks: new Set() };
  const clock = (hour: number, minute: number) => {
    if (hour > 24 || minute > 59) return;
    said.clocks.add((hour % 24) * 60 + minute);
    // "um 4" may be the afternoon.
    if (hour >= 1 && hour <= 12) said.clocks.add(((hour + 12) % 24) * 60 + minute);
  };
  const unitOf = (word: string | undefined) =>
    HOUR_UNITS.has(word ?? "") ? 60 : MINUTE_UNITS.has(word ?? "") ? 1 : 0;
  words.forEach(({ raw, word }, index) => {
    const before = words[index - 1]?.word ?? "";
    const after = words[index + 1]?.word;

    const joined = /^(.+?)(?:mal|x)$/.exec(word);
    const count = numberWord(word) ?? (joined ? numberWord(joined[1]!) : null);
    if (count !== null) said.counts.add(count);
    for (const digits of raw.match(/\d+/g) ?? []) said.counts.add(Number(digits));

    // "20 min", "1,5 h", "anderthalb Stunden", "eine halbe Stunde".
    const plain = /^\d+(?:,\d+)?$/.test(raw) ? Number(raw.replace(",", ".")) : null;
    const amount = plain ?? numberWord(word) ?? FRACTIONS.get(word) ?? null;
    if (amount !== null && unitOf(after) > 0) said.minutes.add(Math.round(amount * unitOf(after)));
    const compound = COMPOUNDS.get(word);
    if (compound) said.minutes.add(compound);
    // "2h30", "90min", "1,5h".
    const stuck = /^(\d+(?:,\d+)?)(h|std|min)(\d{1,2})?$/.exec(raw);
    if (stuck) {
      const value = Number(stuck[1]!.replace(",", "."));
      said.minutes.add(
        Math.round(stuck[2] === "min" ? value : value * 60) + Number(stuck[3] ?? 0),
      );
    }

    // "von 9", "halb elf", "14:15", "16 Uhr".
    const time = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(raw);
    const hour = time ? Number(time[1]) : numberWord(word);
    if (hour === null) return;
    if (before === "halb") clock(hour - 1, 30);
    else if (CLOCK_LEADS.has(before) || after === "uhr" || time?.[2] !== undefined) {
      clock(hour, Number(time?.[2] ?? 0));
    }
  });
  return said;
}

/**
 * Keeps only what the sentence itself says. A model asked to copy numbers
 * still makes some up, or adds them ("three calls of ten minutes" becomes
 * 30). Every duration, count and clock time of its answer has to occur in
 * the sentence; one that does not is treated as not said, and the review
 * asks for it instead.
 */
export function groundExtraction(extraction: Extraction, sentence: string): Extraction {
  const said = saidNumbers(sentence);
  const minuteOfDay = (date: Date) => date.getHours() * 60 + date.getMinutes();
  const duration = (minutes: number | null, vague: boolean) =>
    minutes !== null && (said.minutes.has(minutes) || (vague && minutes === VAGUE_MINUTES))
      ? minutes
      : null;
  const clauses = extraction.clauses.map((clause): Clause => {
    const { amount } = clause;
    if (amount.kind === "minutes") {
      const minutes = duration(amount.minutes, !!amount.vague);
      return minutes === null ? { ...clause, amount: { kind: "unknown" } } : clause;
    }
    if (amount.kind === "times") {
      return {
        ...clause,
        amount: {
          ...amount,
          count: amount.count !== null && said.counts.has(amount.count) ? amount.count : null,
          each: duration(amount.each, !!amount.vague),
        },
      };
    }
    if (amount.kind === "span") {
      const there =
        said.clocks.has(minuteOfDay(amount.begin)) && said.clocks.has(minuteOfDay(amount.end));
      return there ? clause : { ...clause, amount: { kind: "unknown" } };
    }
    return clause;
  });
  const window = extraction.windowMinutes;
  return {
    ...extraction,
    clauses,
    windowMinutes: window !== null && said.minutes.has(window) ? window : null,
  };
}

/**
 * Checks a model's answer and turns it into an extraction. Whatever does not
 * fit the expected shape is dropped; `null` when nothing usable remains. The
 * day comes from the sentence itself, read by the same rules as always, and
 * numbers the sentence does not contain are dropped (`groundExtraction`).
 */
export function parseModelOutput(output: string, sentence: string, now: Date): Extraction | null {
  let parsed: unknown;
  try {
    // Models like to wrap JSON in a code fence.
    parsed = JSON.parse(output.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
  } catch {
    return null;
  }
  const root = record(parsed);
  if (!root || !Array.isArray(root.activities)) return null;
  const { day } = parseDate(sentence.split(/\s+/).filter(Boolean), now);
  const clauses = root.activities
    .map((activity) => clauseOf(activity, day ?? now))
    .filter((clause): clause is Clause => clause !== null);
  if (clauses.length === 0) return null;
  return groundExtraction(
    { clauses, windowMinutes: amountOf(root.window_minutes, 7 * MAX_MINUTES), day },
    sentence,
  );
}

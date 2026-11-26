import { invoke } from "@tauri-apps/api/core";
import { parseDate } from "../quickEntry/dateParser";
import { VAGUE_MINUTES } from "./segment";
import type { Amount, Clause, DraftSource, Extraction, Relation } from "./types";

/**
 * The second way to understand a sentence with several entries: a language
 * model, asked only where the rules are unsure. It extracts what was said
 * and nothing more. It never calculates: sums, the rest and the clock times
 * are `plan.ts`'s job, and the tasks are matched by `draft.ts`.
 *
 * The native side tries Apple's on-device model first and, unless the
 * setting forbids it, the Claude Code command line of the user's own
 * subscription (`src-tauri/src/adversum/multi.rs`). Only the sentence is
 * handed over, no list of customers.
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

/**
 * Checks a model's answer and turns it into an extraction. Whatever does not
 * fit the expected shape is dropped; `null` when nothing usable remains. The
 * day comes from the sentence itself, read by the same rules as always.
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
  return { clauses, windowMinutes: amountOf(root.window_minutes, 7 * MAX_MINUTES), day };
}

/** Which language models can help, as the native side sees it. */
export interface MultiModelStatus {
  /** The setting: "auto", "device" (on this Mac only) or "off". */
  mode: string;
  /** "available", "missing" (no helper in this build) or why it cannot be used. */
  apple: string;
  /** The Claude Code command line is installed. */
  claude: boolean;
}

export function getMultiModelStatus(): Promise<MultiModelStatus> {
  return invoke("adversum_multi_status");
}

/** Asks a language model for the activities of a sentence; `null` when none can. */
export async function extractWithModel(
  sentence: string,
  now: Date,
): Promise<{ extraction: Extraction; source: DraftSource } | null> {
  const answer = await invoke<{ provider: DraftSource; output: string } | null>(
    "adversum_multi_extract",
    { sentence, instructions: EXTRACT_INSTRUCTIONS, schema: JSON.stringify(EXTRACT_SCHEMA) },
  );
  if (!answer) return null;
  const extraction = parseModelOutput(answer.output, sentence, now);
  return extraction ? { extraction, source: answer.provider } : null;
}

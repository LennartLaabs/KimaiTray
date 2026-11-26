import type { QuickSuggestion } from "../quickEntry/parse";

/**
 * Several entries from one sentence: "Ich hab eine Stunde an DUSW Design
 * gearbeitet, dazwischen 10 Minuten K&K Call".
 *
 * Understanding happens in two steps that both end in an `Extraction`: the
 * rules of `segment.ts`, and where they are unsure a language model
 * (`extract.ts`). Neither calculates. `draft.ts` matches the tasks against
 * the catalog, `plan.ts` does all arithmetic and puts the entries on the
 * clock.
 */

/** How an activity relates to the one said before it. */
export type Relation =
  /** Next to it, in the order said. */
  | "none"
  /** "dazwischen": an interruption inside the previous activity. */
  | "within"
  /** "danach". */
  | "after"
  /** "vorher": it happened before the previous activity. */
  | "before";

/** A duration that was not said as a number. */
export type Vague = "kurz" | "paar";

export type Amount =
  /** "eine Stunde", "10 Minuten", "kurz". */
  | { kind: "minutes"; minutes: number; vague?: Vague }
  /** "8 mal kurz", "immer wieder je 7 Minuten": `null` was not said. */
  | { kind: "times"; count: number | null; each: number | null; vague?: Vague }
  /** "von 9 bis 12". */
  | { kind: "span"; begin: Date; end: Date }
  /** "der Rest": what remains of the time window. */
  | { kind: "rest" }
  /** Nothing was said about how long. */
  | { kind: "unknown" };

/** One activity as it was said, before matching and arithmetic. */
export interface Clause {
  /** The words that name the task and describe it. */
  text: string;
  amount: Amount;
  relation: Relation;
}

export interface Extraction {
  clauses: Clause[];
  /** "die letzten 3 Stunden": the window all activities lie in. */
  windowMinutes: number | null;
  /** The day that was named; `null` for today. */
  day: Date | null;
}

export type DraftSource = "rules" | "apple" | "claude";

export interface DraftItem {
  id: number;
  /** The clause's words, for showing what was understood. */
  text: string;
  /** Tasks this could be, the chosen one first; empty for a break. */
  suggestions: QuickSuggestion[];
  amount: Amount;
  relation: Relation;
  /** Customer or whole task were not said and are taken from the activity before. */
  inherited: boolean;
  /** No word names a task and none came before; the suggestion is only the usual one. */
  guessed: boolean;
  /** "Pause": takes time, but is no entry. */
  gap: boolean;
}

export interface MultiDraft {
  items: DraftItem[];
  windowMinutes: number | null;
  day: Date | null;
  source: DraftSource;
  /** The rules could not place every part; a language model may know better. */
  uncertain: boolean;
}

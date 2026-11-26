import type { QuickCatalog } from "../quickEntry/catalog";
import type { QuickHistory } from "../quickEntry/history";
import { normalizeWords } from "../quickEntry/normalize";
import { parseQuickEntry, scoreWord, type QuickSuggestion } from "../quickEntry/parse";
import { interpretSpoken } from "../voice/spoken";
import { extractClauses } from "./segment";
import type { DraftItem, DraftSource, Extraction, MultiDraft } from "./types";

/**
 * Matches the activities of a sentence against the catalog and decides
 * whether the sentence is several entries at all. A sentence with one task
 * stays the single card it always was.
 */

/** A word names a task from this score on: its name, alias or acronym. */
const NAMES_TASK = 0.85;
/** A longer word may also begin or misspell a name ("Designs"). */
const NAMES_TASK_LOOSELY = 0.6;
const LOOSE_MIN_LENGTH = 5;
/** A word of past notes counts when this many entries had it ("Gigi"). */
const NOTE_WORD_COUNT = 2;
const BREAK_WORDS = new Set(["pause", "mittagspause", "mittag", "kaffeepause", "essen"]);

/** Whether the text is a break: time that passes without an entry. */
function isBreak(text: string): boolean {
  const words = normalizeWords(text).filter((word) => !["eine", "die", "kurze", "mit"].includes(word));
  return words.length > 0 && words.every((word) => BREAK_WORDS.has(word));
}

/** Whether some word of the text names a customer, project or activity. */
export function namesTask(
  text: string,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
): boolean {
  const intent = interpretSpoken(text, now);
  if (intent.kind !== "entry") return false;
  // "telefoniert" names the activity as well as "Telefonat" would.
  if (intent.activityHints.length > 0) return true;
  const entities = [
    ...catalog.customers.values(),
    ...catalog.projects.values(),
    ...catalog.activities.values(),
  ];
  return normalizeWords(intent.text).some((word) => {
    let known = 0;
    for (const count of history.notes.get(word)?.values() ?? []) known += count;
    if (known >= NOTE_WORD_COUNT) return true;
    const needed = word.length >= LOOSE_MIN_LENGTH ? NAMES_TASK_LOOSELY : NAMES_TASK;
    return entities.some((entity) => scoreWord(word, entity) >= needed);
  });
}

function suggestionsFor(
  text: string,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
): QuickSuggestion[] {
  const intent = interpretSpoken(text, now);
  if (intent.kind !== "entry") return [];
  return parseQuickEntry(intent.text, catalog, history, now, {
    noteLead: intent.noteLead,
    activityHints: intent.activityHints,
  }).suggestions;
}

/**
 * The entries a reading of the sentence amounts to; `null` when it is one
 * entry or none, which the single card handles.
 */
export function buildDraft(
  extraction: Extraction,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
  source: DraftSource,
): MultiDraft | null {
  const items: DraftItem[] = [];
  let previous: QuickSuggestion | null = null;
  extraction.clauses.forEach((clause, id) => {
    const base = { id, text: clause.text, amount: clause.amount, relation: clause.relation };
    if (isBreak(clause.text)) {
      items.push({ ...base, suggestions: [], inherited: false, guessed: false, gap: true });
      return;
    }
    const named = namesTask(clause.text, catalog, history, now);
    let suggestions = suggestionsFor(clause.text, catalog, history, now);
    let inherited = false;
    let guessed = !named;
    if (previous && !named) {
      guessed = false;
      inherited = true;
      // Nothing names a task: more of the same, with these words as note.
      const note = suggestions[0]?.note ?? "";
      suggestions = [{ ...previous, note }, ...suggestions.slice(0, -1)];
    } else if (previous && suggestions[0] && !suggestions[0].namesTarget) {
      // Only the activity was said: the customer is the one from before.
      const again = suggestionsFor(`${clause.text} ${previous.combination.customer}`, catalog, history, now);
      if (again[0]?.combination.customerId === previous.combination.customerId) {
        suggestions = again;
        inherited = true;
      }
    }
    items.push({ ...base, suggestions, inherited, guessed, gap: false });
    previous = suggestions[0] ?? previous;
  });

  // Several entries are two or more activities that each say how long or in
  // which order. "DUSW Projektmanagement, Gigi Call seit zehn" names two
  // tasks as well, but it is one entry with a note.
  const certain = items.filter((item) => item.gap || !item.guessed);
  const marked = certain.filter(
    (item) => item.amount.kind !== "unknown" || item.relation !== "none",
  );
  const tasks = items.filter((item) => !item.gap && !item.guessed && item.suggestions.length > 0);
  const several = marked.length >= 2 || (extraction.windowMinutes !== null && certain.length >= 2);
  if (!several || tasks.length < 1) return null;
  return {
    items,
    windowMinutes: extraction.windowMinutes,
    day: extraction.day,
    source,
    uncertain: items.some((item) => !item.gap && (item.guessed || item.suggestions.length === 0)),
  };
}

export interface MultiReading {
  /** The entries, when the sentence is several. */
  draft: MultiDraft | null;
  /**
   * The rules found amounts or an order for several activities but could not
   * tell the tasks apart. A language model may.
   */
  suspect: boolean;
}

/** Reads a sentence with the rules. */
export function readMulti(
  sentence: string,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
): MultiReading {
  const extraction = extractClauses(sentence, now, (text) =>
    namesTask(text, catalog, history, now),
  );
  const draft = buildDraft(extraction, catalog, history, now, "rules");
  const amounts = extraction.clauses.filter((clause) => clause.amount.kind !== "unknown").length;
  const ordered = extraction.clauses.some((clause) => clause.relation !== "none");
  return {
    draft,
    suspect: !draft && extraction.clauses.length > 1 && (amounts >= 2 || ordered),
  };
}

import type { Combination, EntityWords, QuickCatalog } from "./catalog";
import { parseCommand, type QuickCommand } from "./commands";
import { historyScore, type QuickHistory } from "./history";
import { editDistance, normalizeWords } from "./normalize";
import { parseTime, type TimeSpec } from "./timeParser";

export const MAX_SUGGESTIONS = 5;
/** Below this confidence the bar preselects nothing; the user has to choose. */
export const AUTO_SELECT_CONFIDENCE = 0.6;

/** A word counts as naming an entity from this score on. */
const MATCH_THRESHOLD = 0.5;
/** One fully matched word outweighs any difference in history. */
const TEXT_WEIGHT = 10;
const HISTORY_WEIGHT = 3;
/** The lead over the runner-up that counts as unambiguous. */
const CLEAR_LEAD = 0.1;
/**
 * Spoken input: once the note has begun, a later word only names an entity
 * when it does so (almost) exactly. A loose match is more likely part of the
 * note.
 */
const LATE_MATCH_THRESHOLD = 0.85;
/** Spoken input: the best activity hint counts like half a matched word. */
const HINT_SCORE = 0.5;
const HINT_STEP = 0.02;
/** Spoken input: a note word needs this many past entries for full weight. */
const AFFINITY_FULL_COUNT = 3;
/** Evidence from past notes counts as naming the customer from here on. */
const AFFINITY_NAMES_TARGET = 0.5;

/**
 * Words that connect what is said without naming anything ("für", "mit",
 * "das"). In spoken input they neither start the note nor end an entity; in
 * the note they stay only between two note words.
 */
const GLUE_WORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "und", "mit", "fuer", "bei", "beim", "an", "am", "im", "in", "zu", "zum", "zur",
  "von", "vom", "auf", "aus", "ueber", "the",
]);

/** How spoken input differs from typed input; see `voice/spoken.ts`. */
export interface SpokenOptions {
  /** Put in front of the note: "Telefonat" for "… mit Gigi telefoniert". */
  noteLead?: string;
  /** Beginnings of activity names the sentence points to, best first. */
  activityHints?: readonly string[];
}

export interface QuickSuggestion {
  combination: Combination;
  /** Words that named no entity, as the note of the new entry. */
  note: string;
  /** Ranking score: text match plus history. */
  score: number;
  /** Sum of the match scores of the words that named an entity. */
  textScore: number;
  /** How many words named an entity. */
  matchedWords: number;
  /** Whether a word named the customer or the project (not only the activity). */
  namesTarget: boolean;
  /** The normalized words that named each entity. */
  words: Record<EntityKind, string[]>;
}

export interface QuickParseResult {
  /** Set when the input is a command; then there are no suggestions. */
  command: QuickCommand | null;
  time: TimeSpec;
  /** The time phrase as typed ("seit 9:45"); empty without one. */
  timePhrase: string;
  /** Best combinations first, at most `MAX_SUGGESTIONS`. */
  suggestions: QuickSuggestion[];
  /** Confidence in the first suggestion, 0 to 1. */
  confidence: number;
  /** Whether the first suggestion may be started without an explicit choice. */
  autoSelect: boolean;
}

/** How well one typed word names an entity, from 0 (not at all) to 1 (exactly). */
export function scoreWord(word: string, entity: EntityWords): number {
  if (entity.aliases.includes(word) || entity.words.includes(word)) return 1;
  if (word.length >= 2 && word === entity.acronym) return 0.85;
  let best = 0;
  for (const candidate of entity.words) {
    if (word.length >= 2 && candidate.startsWith(word)) {
      best = Math.max(best, 0.7 + 0.25 * (word.length / candidate.length));
    } else if (word.length >= 3 && candidate.includes(word)) {
      best = Math.max(best, 0.55);
    } else if (word.length >= 4) {
      const limit = word.length >= 7 ? 2 : 1;
      const distance = editDistance(word, candidate, limit);
      if (distance <= limit) best = Math.max(best, 0.75 - 0.1 * distance);
    }
  }
  return best;
}

export type EntityKind = "customer" | "project" | "activity";
type Kind = EntityKind;
const KINDS: readonly Kind[] = ["customer", "project", "activity"];

interface Assignment {
  textScore: number;
  matchedWords: number;
  namesTarget: boolean;
  /** Indices of the words that belong to the note, in order. */
  note: number[];
  words: Record<Kind, string[]>;
}

/** The kind that `word` names best among those still open, with its score. */
function bestKind(
  word: string,
  entities: Record<Kind, EntityWords>,
  closed: ReadonlySet<Kind>,
  open: Kind | null,
): { kind: Kind | null; score: number } {
  let kind: Kind | null = null;
  let best = 0;
  for (const candidate of KINDS) {
    if (closed.has(candidate)) continue;
    const score = scoreWord(word, entities[candidate]);
    // On a tie the entity already being named keeps the word.
    if (score > best || (score === best && score > 0 && candidate === open)) {
      kind = candidate;
      best = score;
    }
  }
  return { kind, score: best };
}

/**
 * Reads the words left to right as names of the combination's customer,
 * project and activity. Each of the three can be named once, by one or more
 * consecutive words. The first word that names none of them starts the note,
 * and everything after it belongs to the note too:
 * "dusw pm gigi call" → customer "dusw", activity "pm", note "gigi call",
 * even though "gigi" and "call" are aliases as well.
 */
function assign(words: readonly string[], entities: Record<Kind, EntityWords>): Assignment {
  const closed = new Set<Kind>();
  const named: Record<Kind, string[]> = { customer: [], project: [], activity: [] };
  let open: Kind | null = null;
  let textScore = 0;
  let matchedWords = 0;
  let index = 0;
  for (; index < words.length; index++) {
    const { kind, score } = bestKind(words[index]!, entities, closed, open);
    if (!kind || score < MATCH_THRESHOLD) break;
    if (open && open !== kind) closed.add(open);
    open = kind;
    textScore += score;
    matchedWords += 1;
    named[kind].push(words[index]!);
  }
  return {
    textScore,
    matchedWords,
    namesTarget: named.customer.length + named.project.length > 0,
    note: words.slice(index).map((_, offset) => index + offset),
    words: named,
  };
}

/**
 * The spoken variant: entities can be named anywhere in the sentence, and
 * the words in between form the note. "Gigi Call für DUSW Projektmanagement"
 * → note "Gigi Call", customer "DUSW", activity "Projektmanagement". After
 * the first note word, later words have to name an entity (almost) exactly.
 */
function assignSpoken(
  words: readonly string[],
  entities: Record<Kind, EntityWords>,
): Assignment {
  const closed = new Set<Kind>();
  const named: Record<Kind, string[]> = { customer: [], project: [], activity: [] };
  let open: Kind | null = null;
  let textScore = 0;
  let matchedWords = 0;
  // Each run of note words between entities, glue words included.
  const runs: { index: number; glue: boolean }[][] = [[]];
  let noteStarted = false;
  words.forEach((word, index) => {
    const glue = GLUE_WORDS.has(word);
    // A glue word inside a name ("Haus am See") belongs to that name.
    if (glue && !(open && scoreWord(word, entities[open]) === 1)) {
      runs[runs.length - 1]!.push({ index, glue: true });
      return;
    }
    const { kind, score } = bestKind(word, entities, closed, open);
    if (kind && score >= (noteStarted ? LATE_MATCH_THRESHOLD : MATCH_THRESHOLD)) {
      if (open && open !== kind) closed.add(open);
      open = kind;
      textScore += score;
      matchedWords += 1;
      named[kind].push(word);
      runs.push([]);
      return;
    }
    // A word that names nothing ends the entity being named.
    if (open) closed.add(open);
    open = null;
    noteStarted = true;
    runs[runs.length - 1]!.push({ index, glue: false });
  });
  const note = runs.flatMap((run) => {
    const first = run.findIndex((item) => !item.glue);
    if (first < 0) return [];
    const last = run.length - 1 - [...run].reverse().findIndex((item) => !item.glue);
    return run.slice(first, last + 1).map((item) => item.index);
  });
  return {
    textScore,
    matchedWords,
    namesTarget: named.customer.length + named.project.length > 0,
    note,
    words: named,
  };
}

/**
 * How strongly the note points to a combination, from 0 to 1: past entries
 * whose notes contain the same word ("Gigi") were mostly booked on it, or at
 * least on its customer.
 */
function noteAffinity(
  noteWords: readonly string[],
  combination: Combination,
  history: QuickHistory,
  customerOf: ReadonlyMap<string, number>,
): number {
  let best = 0;
  for (const word of new Set(noteWords)) {
    const byCombination = history.notes.get(word);
    if (!byCombination) continue;
    let total = 0;
    let same = 0;
    let sameCustomer = 0;
    for (const [key, count] of byCombination) {
      total += count;
      if (key === combination.key) same += count;
      if (customerOf.get(key) === combination.customerId) sameCustomer += count;
    }
    const strength = Math.min(1, total / AFFINITY_FULL_COUNT);
    best = Math.max(best, strength * ((0.6 * same) / total + (0.4 * sameCustomer) / total));
  }
  return best;
}

/** Score of the best hint the activity's name begins with; 0 for none. */
function hintScore(activity: EntityWords, hints: readonly string[]): number {
  const index = hints.findIndex((hint) =>
    activity.words.some((word) => word.startsWith(hint)),
  );
  return index < 0 ? 0 : Math.max(0, HINT_SCORE - HINT_STEP * index);
}

/** "gigi call" → "Gigi Call"; a note typed with capitals is kept as typed. */
function formatNote(words: readonly string[]): string {
  const note = words.join(" ");
  if (note !== note.toLowerCase()) return note;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * Turns the text of the quick entry bar into a command or ranked suggestions.
 * Pure: everything it needs is passed in, including the current time.
 *
 * With `spoken`, the text is read as a spoken sentence: free word order,
 * glue words ignored, and the note and activity hints count as evidence for
 * a combination, next to the words that name it.
 */
export function parseQuickEntry(
  input: string,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
  spoken?: SpokenOptions,
): QuickParseResult {
  const command = parseCommand(input);
  if (command) {
    return {
      command,
      time: { kind: "none" },
      timePhrase: "",
      suggestions: [],
      confidence: 1,
      autoSelect: true,
    };
  }

  const { time, rest, phrase } = parseTime(input, now);
  // Each raw word can normalize to several words ("gigi-call"); keep the raw
  // spelling for the note and the normalized words for matching.
  const rawWords = rest.flatMap((raw) => {
    const normalized = normalizeWords(raw);
    return normalized.length === 1
      ? [{ raw, word: normalized[0]! }]
      : normalized.map((word) => ({ raw: word, word }));
  });
  const words = rawWords.map((item) => item.word);

  const customerOf = new Map(
    spoken ? catalog.combinations.map((item) => [item.key, item.customerId]) : [],
  );
  const hints = spoken?.activityHints ?? [];

  const ranked = catalog.combinations.map((combination) => {
    const entities = {
      customer: catalog.customers.get(combination.customerId)!,
      project: catalog.projects.get(combination.projectId)!,
      activity: catalog.activities.get(combination.activityId)!,
    };
    const assignment = spoken ? assignSpoken(words, entities) : assign(words, entities);
    // What speaks for the combination besides the words that name it.
    const affinity = spoken
      ? noteAffinity(
          assignment.note.map((index) => words[index]!),
          combination,
          history,
          customerOf,
        )
      : 0;
    const hint =
      assignment.words.activity.length === 0 ? hintScore(entities.activity, hints) : 0;
    const evidenceScore = assignment.textScore + affinity + hint;
    return {
      combination,
      assignment,
      evidenceScore,
      evidenceCount: assignment.matchedWords + (affinity > 0 ? 1 : 0) + (hint > 0 ? 1 : 0),
      namesTarget: assignment.namesTarget || affinity >= AFFINITY_NAMES_TARGET,
      score:
        TEXT_WEIGHT * evidenceScore +
        HISTORY_WEIGHT * historyScore(combination.key, history, now),
    };
  });

  const anyMatch = ranked.some((item) => item.evidenceCount > 0);
  const candidates = ranked
    .filter((item) => !anyMatch || item.evidenceCount > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.combination.key.localeCompare(b.combination.key),
    );

  const suggestions: QuickSuggestion[] = candidates
    .slice(0, MAX_SUGGESTIONS)
    .map(({ combination, assignment, score, namesTarget }) => ({
      combination,
      note: [
        spoken?.noteLead,
        formatNote(assignment.note.map((index) => rawWords[index]!.raw)),
      ]
        .filter(Boolean)
        .join(" "),
      score,
      textScore: assignment.textScore,
      matchedWords: assignment.matchedWords,
      namesTarget,
      words: assignment.words,
    }));

  const [first, second] = candidates;
  let confidence = 0;
  if (first && first.evidenceCount > 0) {
    const quality = first.evidenceScore / first.evidenceCount;
    const lead = second ? (first.score - second.score) / first.score : 1;
    const clarity = Math.min(1, lead / CLEAR_LEAD);
    confidence = quality * (0.5 + 0.5 * clarity) * (first.namesTarget ? 1 : 0.7);
  }

  return {
    command: null,
    time,
    timePhrase: phrase.join(" "),
    suggestions,
    confidence,
    autoSelect: confidence >= AUTO_SELECT_CONFIDENCE,
  };
}

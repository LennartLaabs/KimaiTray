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

type Kind = "customer" | "project" | "activity";
const KINDS: readonly Kind[] = ["customer", "project", "activity"];

interface Assignment {
  textScore: number;
  matchedWords: number;
  namesTarget: boolean;
  /** Index of the first word that belongs to the note. */
  noteStart: number;
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
  let open: Kind | null = null;
  let textScore = 0;
  let matchedWords = 0;
  let namesTarget = false;
  let index = 0;
  for (; index < words.length; index++) {
    let bestKind: Kind | null = null;
    let bestScore = 0;
    for (const kind of KINDS) {
      if (closed.has(kind)) continue;
      const score = scoreWord(words[index]!, entities[kind]);
      // On a tie the entity already being named keeps the word.
      if (score > bestScore || (score === bestScore && score > 0 && kind === open)) {
        bestKind = kind;
        bestScore = score;
      }
    }
    if (!bestKind || bestScore < MATCH_THRESHOLD) break;
    if (open && open !== bestKind) closed.add(open);
    open = bestKind;
    textScore += bestScore;
    matchedWords += 1;
    if (bestKind !== "activity") namesTarget = true;
  }
  return { textScore, matchedWords, namesTarget, noteStart: index };
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
 */
export function parseQuickEntry(
  input: string,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
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

  const ranked = catalog.combinations.map((combination) => {
    const assignment = assign(words, {
      customer: catalog.customers.get(combination.customerId)!,
      project: catalog.projects.get(combination.projectId)!,
      activity: catalog.activities.get(combination.activityId)!,
    });
    return {
      combination,
      assignment,
      score:
        TEXT_WEIGHT * assignment.textScore +
        HISTORY_WEIGHT * historyScore(combination.key, history, now),
    };
  });

  const anyMatch = ranked.some((item) => item.assignment.matchedWords > 0);
  const candidates = ranked
    .filter((item) => !anyMatch || item.assignment.matchedWords > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.combination.key.localeCompare(b.combination.key),
    );

  const suggestions: QuickSuggestion[] = candidates
    .slice(0, MAX_SUGGESTIONS)
    .map(({ combination, assignment, score }) => ({
      combination,
      note: formatNote(rawWords.slice(assignment.noteStart).map((item) => item.raw)),
      score,
      textScore: assignment.textScore,
      matchedWords: assignment.matchedWords,
      namesTarget: assignment.namesTarget,
    }));

  const [first, second] = suggestions;
  let confidence = 0;
  if (first && first.matchedWords > 0) {
    const quality = first.textScore / first.matchedWords;
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

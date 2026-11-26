import type { Combination, EntityWords, QuickCatalog } from "../quickEntry/catalog";
import { editDistance, normalizeWords } from "../quickEntry/normalize";
import { scoreWord, type EntityKind, type QuickSuggestion } from "../quickEntry/parse";
import type { AliasKind } from "../settings/adversumSettings";

/**
 * Learning from corrections. When voice input proposed one task and the user
 * picked another, a spoken word was probably meant to name it and was not
 * understood: "solartec" for SolarTech NRW, "kaka" for K&K. That word is
 * stored as an alias, so the same slip works next time.
 */

export interface LearnedAlias {
  kind: AliasKind;
  entityId: number;
  /** The spoken word, normalized. */
  alias: string;
  /** Name of the entity it now stands for, for the confirmation. */
  name: string;
}

interface LearnInput {
  /** The cleaned spoken sentence (`SpokenReading.text`). */
  spoken: string;
  /** What voice input put first; `null` when it had no suggestion. */
  proposed: QuickSuggestion | null;
  /** What the user chose instead. */
  chosen: Combination;
  catalog: QuickCatalog;
}

const MATCH = 0.5;
const SIMILAR = 0.5;
const MIN_ALIAS_LENGTH = 3;
/** Words of a sentence that never name a task. */
const NOT_A_NAME = new Set([
  "seit", "von", "bis", "vor", "nach", "uhr", "halb", "viertel", "min", "minute", "minuten",
  "stunde", "stunden", "std", "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen",
  "einem", "einer", "und", "mit", "fuer", "bei", "beim", "auf", "aus", "ueber", "zum", "zur",
  "vom", "the",
]);

const KINDS: readonly { kind: EntityKind; alias: AliasKind }[] = [
  { kind: "customer", alias: "customers" },
  { kind: "project", alias: "projects" },
  { kind: "activity", alias: "activities" },
];

function entityOf(
  catalog: QuickCatalog,
  kind: EntityKind,
  combination: Combination,
): { id: number; name: string; words: EntityWords; all: ReadonlyMap<number, EntityWords> } {
  const [all, id, name] =
    kind === "customer"
      ? ([catalog.customers, combination.customerId, combination.customer] as const)
      : kind === "project"
        ? ([catalog.projects, combination.projectId, combination.project] as const)
        : ([catalog.activities, combination.activityId, combination.activity] as const);
  return { id, name, words: all.get(id)!, all };
}

/** Consonants of a word: "kaka" → "kk". Speech keeps them better than vowels. */
function skeleton(word: string): string {
  return word.replace(/[aeiouy]/g, "");
}

/** How much a word resembles an entity's name, from 0 to 1. */
export function resemblance(word: string, entity: EntityWords): number {
  const targets = [...entity.words, entity.acronym, entity.words.join("")].filter(Boolean);
  let best = 0;
  for (const target of targets) {
    const longest = Math.max(word.length, target.length);
    best = Math.max(best, 1 - editDistance(word, target, longest) / longest);
    if (skeleton(word).length >= 2 && skeleton(word) === skeleton(target)) {
      best = Math.max(best, 0.8);
    }
  }
  return best;
}

/**
 * The aliases a correction teaches, at most one per customer, project and
 * activity. For each of the three that the user changed and that no spoken
 * word names, the word is, in this order:
 *
 * 1. the word that named the wrong entity of that kind in the proposal;
 * 2. a spoken word that names nothing but resembles the right name;
 * 3. for the customer: the only spoken word that names nothing.
 *
 * A word that is the exact name or alias of something else is never taken.
 */
export function aliasesToLearn({ spoken, proposed, chosen, catalog }: LearnInput): LearnedAlias[] {
  const words = [...new Set(normalizeWords(spoken))].filter(
    (word) => word.length >= MIN_ALIAS_LENGTH && !/^\d/.test(word) && !NOT_A_NAME.has(word),
  );
  const targets = KINDS.map(({ kind, alias }) => ({
    kind,
    alias,
    ...entityOf(catalog, kind, chosen),
  }));
  const namesChosen = (word: string) =>
    targets.some((target) => scoreWord(word, target.words) >= MATCH);
  const leftover = words.filter((word) => !namesChosen(word));
  const used = new Set<string>();
  const learned: LearnedAlias[] = [];

  for (const target of targets) {
    if (proposed && entityOf(catalog, target.kind, proposed.combination).id === target.id) {
      continue;
    }
    if (words.some((word) => scoreWord(word, target.words) >= MATCH)) continue;
    const free = leftover.filter((word) => {
      if (used.has(word)) return false;
      // Exactly the name of something else of this kind: not a slip.
      for (const [id, other] of target.all) {
        if (id !== target.id && scoreWord(word, other) === 1) return false;
      }
      return true;
    });
    const misnamed = (proposed?.words[target.kind] ?? []).find((word) => free.includes(word));
    const similar = [...free]
      .map((word) => ({ word, score: resemblance(word, target.words) }))
      .filter((item) => item.score >= SIMILAR)
      .sort((a, b) => b.score - a.score)[0]?.word;
    // Only a customer is guessed from an unrelated word. For project and
    // activity such a word is more likely a note ("DUSW Angebot").
    const only = target.kind === "customer" && free.length === 1 ? free[0] : undefined;
    const alias = misnamed ?? similar ?? only;
    if (!alias) continue;
    used.add(alias);
    learned.push({ kind: target.alias, entityId: target.id, alias, name: target.name });
  }
  return learned;
}

/** Removes learned words from a note: they were names, not part of the note. */
export function withoutLearned(note: string, learned: readonly LearnedAlias[]): string {
  const aliases = new Set(learned.map((item) => item.alias));
  return note
    .split(/\s+/)
    .filter((word) => !normalizeWords(word).some((part) => aliases.has(part)))
    .join(" ");
}

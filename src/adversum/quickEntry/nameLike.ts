import type { EntityWords } from "./catalog";
import { editDistance } from "./normalize";

/**
 * Whether a word that stands for a customer, project or activity is just
 * another way to write its name, or says something of its own.
 *
 * "dusw", "pm" and "solartec" are names: they tell which task is meant and
 * nothing else. "Giuseppe" for a customer and "Call" for the activity
 * "Austausch" also tell what happened, so they belong in the note as well.
 */

const SIMILAR = 0.5;
const MIN_CONTENT_LENGTH = 3;
const MAX_ABBREVIATION_LENGTH = 4;

/** Consonants of a word: "kaka" → "kk". Speech keeps them better than vowels. */
function skeleton(word: string): string {
  return word.replace(/[aeiouy]/g, "");
}

/** How much a word resembles an entity's name, from 0 to 1. */
export function resemblance(word: string, entity: EntityWords): number {
  // Besides each word, the name read together and the acronym, also the
  // acronym's beginnings: "kk" for "K&K Global Solutions".
  const initials = [...entity.acronym].map((_, count) => entity.acronym.slice(0, count + 1));
  const targets = [...entity.words, entity.words.join(""), ...initials.slice(1)].filter(Boolean);
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

/** "pm" for "Projektmanagement": its letters, in order, from the first on. */
function abbreviates(word: string, name: string): boolean {
  if (word.length > MAX_ABBREVIATION_LENGTH || word[0] !== name[0]) return false;
  let position = 0;
  for (const letter of word) {
    position = name.indexOf(letter, position) + 1;
    if (position === 0) return false;
  }
  return true;
}

/**
 * Whether `word` is a spelling, part, slip or abbreviation of the entity's
 * own name. Aliases that are not say something the name does not.
 */
export function isNameLike(word: string, entity: EntityWords): boolean {
  if (word.length < MIN_CONTENT_LENGTH) return true;
  if (word === entity.acronym) return true;
  if (entity.words.some((name) => name.includes(word))) return true;
  if (resemblance(word, entity) >= SIMILAR) return true;
  return abbreviates(word, entity.words.join(""));
}

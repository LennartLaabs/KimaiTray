const COMBINING_MARKS = /\p{M}+/gu;
const NOT_WORD = /[^\p{L}\p{N}]+/gu;

/**
 * Text folded for matching: lowercase, German umlauts and ß written out
 * (ä → ae, ß → ss), other diacritics removed, punctuation turned into spaces.
 */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(NOT_WORD, " ")
    .trim();
}

/** The normalized words of a text. */
export function normalizeWords(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Spellings a typed word may stand for. Someone typing "muller" or "strasse"
 * means "Müller" and "Straße", which normalize to "mueller" and "strasse", so
 * a word is also offered with its umlauts written the short way.
 */
export function wordVariants(word: string): string[] {
  const short = word.replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u");
  return short === word ? [word] : [word, short];
}

/**
 * Edit distance with adjacent transpositions, cut off at `limit`: returns
 * `limit + 1` as soon as the distance is known to exceed it.
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, beforePrevious[j - 2]! + 1);
      }
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return Math.min(previous[b.length]!, limit + 1);
}

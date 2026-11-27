/**
 * Whether two words sound alike in German ears.
 *
 * Speech recognition writes names it does not know the way they sound:
 * "Solartek" for SolarTech, "Dschuseppe" for Giuseppe, "Tschigi" for Gigi.
 * The base is the Kölner Phonetik (a German cousin of Soundex), which turns
 * a word into a code of digits for its consonant sounds. On top of it, the
 * soft "g" and "j" of Italian and English names are also tried as "dsch".
 *
 * Words are expected folded (`normalizeText`): lowercase, no umlauts.
 */

const VOWELS = "aeijouy";
const SOUNDS_MIN_LENGTH = 4;
/** Codes this short say little; the vowels have to agree as well. */
const SHORT_CODE = 3;
const MAX_LENGTH_DIFFERENCE = 4;

/** The Kölner Phonetik code of a word: "mueller" → "657". */
export function colognePhonetic(word: string): string {
  const letters = word.replace(/[^a-z]/g, "");
  let code = "";
  for (let index = 0; index < letters.length; index++) {
    const letter = letters[index]!;
    const before = letters[index - 1] ?? "";
    const after = letters[index + 1] ?? "";
    let digit: string;
    if (VOWELS.includes(letter)) digit = "0";
    else if (letter === "h") digit = "";
    else if (letter === "b") digit = "1";
    else if (letter === "p") digit = after === "h" ? "3" : "1";
    else if (letter === "d" || letter === "t") digit = "csz".includes(after) && after ? "8" : "2";
    else if ("fvw".includes(letter)) digit = "3";
    else if ("gkq".includes(letter)) digit = "4";
    else if (letter === "c") {
      const hard = index === 0 ? "ahkloqrux" : "ahkoqux";
      digit = hard.includes(after) && after && !(before && "sz".includes(before)) ? "4" : "8";
    } else if (letter === "x") digit = before && "ckq".includes(before) ? "8" : "48";
    else if (letter === "l") digit = "5";
    else if (letter === "m" || letter === "n") digit = "6";
    else if (letter === "r") digit = "7";
    else digit = "8";
    code += digit;
  }
  // Runs of the same digit are one sound; vowels only count at the start.
  const collapsed = code.replace(/(\d)\1+/g, "$1");
  return collapsed.charAt(0) + collapsed.slice(1).replace(/0/g, "");
}

/** "Giuseppe" → "dschuseppe", "Gigi" → "dschidschi", "John" → "dschohn". */
function softened(word: string): string {
  return word
    .replace(/gi(?=[aou])/g, "dsch")
    .replace(/g(?=[ei])/g, "dsch")
    .replace(/j/g, "dsch");
}

/** The vowel sounds in order: "maier" and "meyer" both give "Ee". */
function vowelsOf(word: string): string {
  return word
    .replace(/[ae][iy]/g, "E")
    .replace(/a?eu|o[iy]/g, "O")
    .replace(/ie/g, "i")
    .replace(/y/g, "i")
    .replace(/[^aeiouEO]/g, "")
    .replace(/(.)\1+/g, "$1");
}

interface Sound {
  code: string;
  vowels: string;
}

const cache = new Map<string, Sound[]>();

/** The ways a word may sound: as written, and with soft "g" and "j". */
function sounds(word: string): Sound[] {
  let known = cache.get(word);
  if (!known) {
    known = [...new Set([word, softened(word)])].map((spelling) => ({
      code: colognePhonetic(spelling),
      vowels: vowelsOf(spelling),
    }));
    cache.set(word, known);
  }
  return known;
}

/**
 * Whether `heard` sounds like `name`. Both need four letters or more, and a
 * similar length; where the consonants say little (a code of one or two
 * digits), the vowels have to be the same too.
 */
export function soundsLike(heard: string, name: string): boolean {
  if (
    heard.length < SOUNDS_MIN_LENGTH ||
    name.length < SOUNDS_MIN_LENGTH ||
    Math.abs(heard.length - name.length) > MAX_LENGTH_DIFFERENCE
  ) {
    return false;
  }
  return sounds(heard).some((a) =>
    sounds(name).some(
      (b) =>
        a.code.length >= 2 &&
        a.code === b.code &&
        (a.code.length >= SHORT_CODE || a.vowels === b.vowels),
    ),
  );
}

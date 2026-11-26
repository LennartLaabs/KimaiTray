/**
 * German number words as they come out of speech recognition, already
 * normalized ("fünf" → "fuenf", "dreißig" → "dreissig"). Covers what times
 * and durations need: 0 to 99.
 */
const SMALL = new Map<string, number>([
  ["null", 0],
  ["eins", 1],
  ["zwei", 2],
  ["zwo", 2],
  ["drei", 3],
  ["vier", 4],
  ["fuenf", 5],
  ["sechs", 6],
  ["sieben", 7],
  ["acht", 8],
  ["neun", 9],
  ["zehn", 10],
  ["elf", 11],
  ["zwoelf", 12],
  ["dreizehn", 13],
  ["vierzehn", 14],
  ["fuenfzehn", 15],
  ["sechzehn", 16],
  ["siebzehn", 17],
  ["achtzehn", 18],
  ["neunzehn", 19],
]);

const TENS = new Map<string, number>([
  ["zwanzig", 20],
  ["dreissig", 30],
  ["vierzig", 40],
  ["fuenfzig", 50],
  ["sechzig", 60],
  ["siebzig", 70],
  ["achtzig", 80],
  ["neunzig", 90],
]);

const UNITS_IN_COMPOUNDS = new Map<string, number>([
  ["ein", 1],
  ["zwei", 2],
  ["drei", 3],
  ["vier", 4],
  ["fuenf", 5],
  ["sechs", 6],
  ["sieben", 7],
  ["acht", 8],
  ["neun", 9],
]);

/** The number a normalized word stands for, or `null`: "einundzwanzig" → 21. */
export function numberWord(word: string): number | null {
  const direct = SMALL.get(word) ?? TENS.get(word);
  if (direct !== undefined) return direct;
  const [unit, tens] = word.split("und");
  const unitValue = UNITS_IN_COMPOUNDS.get(unit ?? "");
  const tensValue = TENS.get(tens ?? "");
  return unitValue !== undefined && tensValue !== undefined ? tensValue + unitValue : null;
}

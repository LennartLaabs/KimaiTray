import type { QuickCatalog } from "../quickEntry/catalog";
import { historyScore, type QuickHistory } from "../quickEntry/history";
import { contactNames } from "../profile/profileText";
import type { ConnectionAliases } from "../settings/adversumSettings";

/**
 * The text that primes the speech model: the names it should expect. With
 * it, Whisper writes "DUSW", "SolarTech NRW" and "Giuseppe" instead of
 * something that merely sounds alike.
 *
 * Whisper reads at most 224 tokens of prompt, and of an overlong one only
 * the end. So the terms are chosen by relevance and the prompt is kept under
 * a budget: customers by how recently and how often they were booked, each
 * with its contacts and aliases; names that are hard to write first; then
 * colleagues and names from notes, projects, activities and the user's own
 * aliases. What matters most stands last.
 */

/** Whisper's limit is 224 tokens; this leaves room for our estimate to be off. */
export const VOCABULARY_TOKEN_BUDGET = 200;
/** German names come to a bit under three characters per token. */
const CHARS_PER_TOKEN = 2.7;

/** A cautious estimate of how many tokens Whisper makes of a text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Whether a name is one the speech model would hardly guess: capitals inside
 * or throughout ("SolarTech", "DUSW"), digits and signs ("K&K"), or letters
 * that German spelling rarely uses that way ("Giuseppe", "Cheval").
 */
export function isHardToWrite(term: string): boolean {
  return (
    /\p{Ll}\p{Lu}|\p{Lu}{2}|[\d&+]/u.test(term) || /[cqxy]|ph|th|sh|gh|ou|gi|ee|oo/i.test(term)
  );
}

export interface VocabularyOptions {
  /** For ranking customers by use; without it they keep the catalog's order. */
  history?: QuickHistory;
  now?: Date;
  /** Colleagues and names that recur in notes. */
  names?: readonly string[];
  tokenBudget?: number;
}

/**
 * The terms for the prompt, the most relevant first. No term twice,
 * whatever its capitals.
 */
export function rankVocabulary(
  catalog: QuickCatalog,
  aliases: ConnectionAliases | undefined,
  options: VocabularyOptions = {},
): string[] {
  const { history, now = new Date(), names = [] } = options;
  const use = new Map<number, number>();
  const customers = new Map<number, string>();
  for (const item of catalog.combinations) {
    customers.set(item.customerId, item.customer);
    const score = history ? historyScore(item.key, history, now) : 0;
    use.set(item.customerId, Math.max(use.get(item.customerId) ?? 0, score));
  }
  const hardFirst = (terms: string[]) => [
    ...terms.filter(isHardToWrite),
    ...terms.filter((term) => !isHardToWrite(term)),
  ];
  const ranked = [...customers.keys()].sort((a, b) => use.get(b)! - use.get(a)!);
  const own = aliases
    ? [aliases.customers, aliases.projects, aliases.activities].flatMap((byEntity) =>
        Object.values(byEntity).flat(),
      )
    : [];
  const terms = [
    // Every customer's name, then what belongs to each customer.
    ...ranked.flatMap((id) => {
      const profile = catalog.profiles.get(id)!;
      return hardFirst([
        customers.get(id)!,
        ...profile.contacts.flatMap(contactNames),
        ...profile.aliases,
      ]);
    }),
    ...names,
    ...hardFirst([...new Set(catalog.combinations.map((item) => item.project))]),
    ...hardFirst([...new Set(catalog.combinations.map((item) => item.activity))]),
    ...own,
  ];
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = term.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The prompt and the terms that made it into it. */
export interface Vocabulary {
  prompt: string;
  terms: string[];
}

/**
 * Builds the prompt: as many of the ranked terms as the token budget holds,
 * written so that the most relevant stand at the end.
 */
export function buildVocabulary(
  catalog: QuickCatalog,
  aliases: ConnectionAliases | undefined,
  options: VocabularyOptions = {},
): Vocabulary {
  const budget = options.tokenBudget ?? VOCABULARY_TOKEN_BUDGET;
  const terms: string[] = [];
  const write = (chosen: readonly string[]) =>
    chosen.length > 0 ? `Namen: ${[...chosen].reverse().join(", ")}.` : "";
  for (const term of rankVocabulary(catalog, aliases, options)) {
    if (estimateTokens(write([...terms, term])) > budget) continue;
    terms.push(term);
  }
  return { prompt: write(terms), terms };
}

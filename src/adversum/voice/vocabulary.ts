import type { QuickCatalog } from "../quickEntry/catalog";
import type { ConnectionAliases } from "../settings/adversumSettings";

/**
 * The text that primes the speech model: names of everything that can be
 * started, plus the user's aliases. With it, Whisper writes "DUSW",
 * "SolarTech NRW" and "K&K" instead of something that merely sounds alike.
 *
 * Whisper only reads the last part of an overlong prompt, so the most
 * distinctive names come last: names from past notes, projects, activities,
 * aliases, customers.
 */
export function buildVocabulary(
  catalog: QuickCatalog,
  aliases: ConnectionAliases | undefined,
  noteNames: readonly string[] = [],
): string {
  const unique = (names: readonly string[]) => {
    const seen = new Set<string>();
    return names.filter((name) => {
      const key = name.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const { combinations } = catalog;
  if (combinations.length === 0) return "";
  const aliasWords = aliases
    ? [aliases.projects, aliases.activities, aliases.customers].flatMap((byEntity) =>
        Object.values(byEntity).flat(),
      )
    : [];
  const groups: [string, string[]][] = [
    ["Notizen", unique(noteNames)],
    ["Projekte", unique(combinations.map((item) => item.project))],
    ["Tätigkeiten", unique(combinations.map((item) => item.activity))],
    ["Kürzel", unique(aliasWords)],
    ["Kunden", unique(combinations.map((item) => item.customer))],
  ];
  return groups
    .filter(([, names]) => names.length > 0)
    .map(([title, names]) => `${title}: ${names.join(", ")}.`)
    .join(" ");
}

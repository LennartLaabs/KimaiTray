import type { QuickCatalog } from "../quickEntry/catalog";
import type { HistoryEntry } from "../quickEntry/history";
import { normalizeText, normalizeWords } from "../quickEntry/normalize";
import { soundsLike } from "../quickEntry/phonetic";
import { profileWords } from "./profileApi";
import { cleanProfile, contactNames, type Profile } from "./profileText";

/**
 * What the app proposes about profiles by itself: that a customer who is new
 * in Kimai gets one, that a name or term which keeps turning up in a
 * customer's notes is added to it, and where a corrected spelling belongs.
 * Pure functions; `ProfileHints.tsx` shows the proposals and remembers which
 * were answered.
 */

/** Which customers are known, and which new ones still wait for a look. */
export interface KnownCustomers {
  known: number[];
  pending: number[];
}

/**
 * Compares Kimai's customers with the ones seen before. On the very first
 * comparison everybody is known: a new installation does not ask about
 * every customer there is.
 */
export function trackCustomers(
  stored: KnownCustomers | null,
  customerIds: readonly number[],
): KnownCustomers {
  if (!stored) return { known: [...customerIds], pending: [] };
  const known = new Set(stored.known);
  const fresh = customerIds.filter((id) => !known.has(id));
  return {
    known: [...stored.known, ...fresh],
    // Customers that left Kimai (or were hidden) need no profile any more.
    pending: [...stored.pending, ...fresh].filter((id) => customerIds.includes(id)),
  };
}

/** Something to add to a customer's profile. */
export interface ProfileSuggestion {
  customerId: number;
  customer: string;
  /** As it stands in the notes: "Frau Maier", "Messestand". */
  text: string;
  kind: "contacts" | "topics";
  /** Stable per customer and term, for remembering that it was asked. */
  key: string;
}

const SUGGEST_DAYS = 30;
const SUGGEST_MIN_ENTRIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Words of notes that say how one worked, not on what or with whom. */
const GENERIC = new Set([
  "call", "calls", "meeting", "meetings", "telefonat", "telefonate", "termin", "termine",
  "abstimmung", "besprechung", "austausch", "mail", "mails", "email", "emails", "feedback",
  "korrektur", "korrekturen", "update", "updates", "planung", "vorbereitung", "nachbereitung",
  "todo", "todos", "rest", "teil", "runde", "version", "kunde", "kunden", "team", "intern",
  "jour", "fixe", "weekly", "daily", "heute", "gestern", "woche",
]);
const TITLE = /^(?:Frau|Herr)$/;
const WORD = /^\p{Lu}[\p{L}\p{N}&-]{2,}$/u;

/**
 * Names and terms that recur in a customer's notes of the last 30 days and
 * are not in the profile: "Frau Maier" as a contact, "Messestand" as a
 * topic. Most frequent first. `answered` holds the keys of suggestions that
 * were made before.
 */
export function suggestFromNotes(
  entries: readonly HistoryEntry[],
  catalog: QuickCatalog,
  now: Date,
  answered: ReadonlySet<string>,
): ProfileSuggestion[] {
  const customerOf = new Map(
    catalog.combinations.map((item) => [item.projectId, item] as const),
  );
  const named = new Set(
    [...catalog.customers.values(), ...catalog.projects.values(), ...catalog.activities.values()]
      .flatMap((entity) => [...entity.words, ...entity.aliases]),
  );
  const counts = new Map<string, ProfileSuggestion & { count: number }>();
  for (const entry of entries) {
    const age = now.getTime() - entry.begin.getTime();
    const project = customerOf.get(entry.projectId);
    if (!project || age < 0 || age > SUGGEST_DAYS * DAY_MS) continue;
    const words = (entry.description ?? "").split(/[\s,.;:!?()"„“”/]+/).filter(Boolean);
    const seen = new Set<string>();
    words.forEach((word, index) => {
      if (!WORD.test(word) || TITLE.test(word)) return;
      const person = TITLE.test(words[index - 1] ?? "");
      const text = person ? `${words[index - 1]} ${word}` : word;
      const folded = normalizeText(word);
      const key = `${project.customerId}:${folded}`;
      if (
        seen.has(key) ||
        answered.has(key) ||
        named.has(folded) ||
        catalog.team.has(folded) ||
        (!person && GENERIC.has(folded)) ||
        profileWords(catalog.profiles.get(project.customerId)!).has(folded)
      ) {
        return;
      }
      seen.add(key);
      const known = counts.get(key);
      counts.set(key, {
        customerId: project.customerId,
        customer: project.customer,
        // Once seen with a title, it is a person.
        text: person || !known ? text : known.text,
        kind: person || known?.kind === "contacts" ? "contacts" : "topics",
        key,
        count: (known?.count ?? 0) + 1,
      });
    });
  }
  return [...counts.values()]
    .filter((item) => item.count >= SUGGEST_MIN_ENTRIES)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map(({ count: _count, ...suggestion }) => suggestion);
}

/** The profile with the suggestion in it. */
export function withSuggestion(profile: Profile, suggestion: ProfileSuggestion): Profile {
  return cleanProfile(
    suggestion.kind === "contacts"
      ? { ...profile, contacts: [...profile.contacts, { name: suggestion.text, variants: [] }] }
      : { ...profile, topics: [...profile.topics, suggestion.text] },
  );
}

/**
 * The profile with another way a name gets written, learned from a
 * correction ("Dschuseppe" was Giuseppe): with the contact it sounds like,
 * or, when it sounds like none, as an alias of the customer.
 */
export function withVariant(profile: Profile, word: string): Profile {
  const variant = word.charAt(0).toUpperCase() + word.slice(1);
  const folded = normalizeText(word).replace(/ /g, "");
  const index = profile.contacts.findIndex((contact) =>
    contactNames(contact)
      .flatMap(normalizeWords)
      .some((name) => soundsLike(folded, name)),
  );
  if (index < 0) return cleanProfile({ ...profile, aliases: [...profile.aliases, variant] });
  return cleanProfile({
    ...profile,
    contacts: profile.contacts.map((contact, position) =>
      position === index ? { ...contact, variants: [...contact.variants, variant] } : contact,
    ),
  });
}

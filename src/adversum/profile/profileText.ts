/**
 * The profile ("Steckbrief") of a customer, project or activity, kept in the
 * description field of the entity in Kimai so that everyone on the team has
 * it:
 *
 *     Aliasse: Huber, BH
 *     Kontakte: Giuseppe (Gigi), Christian
 *     Themen: Roll-Ups, Messestand, Newsletter
 *
 * Each on a line of its own. Whatever else the description holds is left
 * exactly as it is. Aliases and contacts name the entity in a sentence;
 * topics hint at it when no customer was said. Contacts are for customers.
 */

/** A person at the customer, with other names and spellings they go by. */
export interface Contact {
  name: string;
  /** Nicknames and ways the name gets written: "Gigi", "Dschuseppe". */
  variants: string[];
}

export interface Profile {
  aliases: string[];
  contacts: Contact[];
  topics: string[];
}

export const EMPTY_PROFILE: Profile = { aliases: [], contacts: [], topics: [] };

type Field = keyof Profile;
const LABELS: Record<Field, { write: string; read: string[] }> = {
  aliases: { write: "Aliasse", read: ["aliasse", "aliase", "aliases", "alias"] },
  contacts: { write: "Kontakte", read: ["kontakte", "kontakt", "ansprechpartner", "contacts"] },
  topics: { write: "Themen", read: ["themen", "thema", "topics"] },
};
const FIELDS: readonly Field[] = ["aliases", "contacts", "topics"];
const MAX_ITEMS = 30;
const MAX_ITEM_LENGTH = 60;

function fieldOf(line: string): { field: Field; value: string } | null {
  const match = /^\s*([\p{L}]+)\s*:\s*(.*)$/u.exec(line);
  if (!match) return null;
  const label = match[1]!.toLowerCase();
  const field = FIELDS.find((candidate) => LABELS[candidate].read.includes(label));
  return field ? { field, value: match[2]! } : null;
}

/** Splits at commas and semicolons that are not inside parentheses. */
function splitList(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if ((character === "," || character === ";") && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  return [...items, current];
}

/** Trimmed, without empty ones, each once (whatever its capitals), not too many. */
export function cleanList(items: readonly string[]): string[] {
  const seen = new Set<string>();
  return items
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || item.length > MAX_ITEM_LENGTH || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_ITEMS);
}

/** "Giuseppe (Gigi, Dschuseppe)" → the name with its variants. */
export function parseContact(text: string): Contact | null {
  const match = /^([^()]*)(?:\(([^)]*)\))?/.exec(text)!;
  const [name] = cleanList([match[1]!]);
  if (!name) return null;
  const variants = cleanList((match[2] ?? "").split(/[,;/]/)).filter(
    (variant) => variant.toLowerCase() !== name.toLowerCase(),
  );
  return { name, variants };
}

export function formatContact(contact: Contact): string {
  return contact.variants.length > 0
    ? `${contact.name} (${contact.variants.join(", ")})`
    : contact.name;
}

function cleanContacts(contacts: readonly Contact[]): Contact[] {
  const byName = new Map<string, Contact>();
  for (const contact of contacts) {
    const parsed = parseContact(formatContact(contact));
    if (!parsed) continue;
    const key = parsed.name.toLowerCase();
    const known = byName.get(key);
    byName.set(key, {
      name: known?.name ?? parsed.name,
      variants: cleanList([...(known?.variants ?? []), ...parsed.variants]),
    });
  }
  return [...byName.values()].slice(0, MAX_ITEMS);
}

/** A profile with tidy lists: no blanks, no doubles. */
export function cleanProfile(profile: Profile): Profile {
  return {
    aliases: cleanList(profile.aliases),
    contacts: cleanContacts(profile.contacts),
    topics: cleanList(profile.topics),
  };
}

/** Reads the profile lines out of a description. */
export function parseProfile(comment: string | null | undefined): Profile {
  const profile: Profile = { aliases: [], contacts: [], topics: [] };
  for (const line of (comment ?? "").split(/\r?\n/)) {
    const found = fieldOf(line);
    if (!found) continue;
    const items = splitList(found.value);
    if (found.field === "contacts") {
      profile.contacts.push(...items.flatMap((item) => parseContact(item) ?? []));
    } else {
      profile[found.field].push(...items);
    }
  }
  return cleanProfile(profile);
}

/** The profile as the lines that go into the description; none when it is empty. */
export function profileLines(profile: Profile): string[] {
  const clean = cleanProfile(profile);
  const values: Record<Field, string[]> = {
    aliases: clean.aliases,
    contacts: clean.contacts.map(formatContact),
    topics: clean.topics,
  };
  return FIELDS.filter((field) => values[field].length > 0).map(
    (field) => `${LABELS[field].write}: ${values[field].join(", ")}`,
  );
}

/**
 * The description with this profile in it: earlier profile lines are
 * replaced, everything else stays where and as it was.
 */
export function writeProfile(comment: string | null | undefined, profile: Profile): string {
  const kept = (comment ?? "").split(/\r?\n/).filter((line) => !fieldOf(line));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  const lines = profileLines(profile);
  if (lines.length === 0) return kept.join("\n");
  return [...kept, ...(kept.length > 0 ? [""] : []), ...lines].join("\n");
}

/** Every word a contact may be called by. */
export function contactNames(contact: Contact): string[] {
  return [contact.name, ...contact.variants];
}

/** Whether nothing is in the profile. */
export function isEmptyProfile(profile: Profile): boolean {
  return profile.aliases.length + profile.contacts.length + profile.topics.length === 0;
}

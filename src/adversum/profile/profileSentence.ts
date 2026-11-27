import { normalizeText } from "../quickEntry/normalize";
import {
  cleanProfile,
  parseContact,
  type Contact,
  type Profile,
} from "./profileText";

/**
 * Reads a profile out of what someone says or types about a customer:
 * "Ansprechpartner Sepp Huber und Frau Maier, intern sagen wir Huber, wir
 * machen Website und Google Ads". Rules only: phrases that lead into
 * contacts, into aliases and into topics, and lists after them. The result
 * always goes into a form to be checked; nothing here writes anything.
 *
 * `suggestProfile` proposes what can be told without anyone saying it: the
 * contact Kimai knows, a short form of the company name, its initials and
 * the name in its homepage's address.
 */

type Field = keyof Profile;

/** Phrases that say what the words after them are. Longest first. */
const LEADS: [Field, RegExp][] = [
  [
    "contacts",
    /\b(?:(?:unsere?|der|die|mein[e]?)\s+)?(?:ansprechpartner(?:innen|in)?|ansprechperson(?:en)?|kontaktperson(?:en)?|kontakte?|zust(?:ä|ae)ndig)\b(?:\s+(?:ist|sind|dort|da|w(?:ä|ae)re[n]?))*\s*:?/giu,
  ],
  [
    "aliases",
    /\b(?:(?:intern|kurz|bei uns)\s+)*(?:(?:sagen|nennen)\s+wir(?:\s+(?:sie|ihn|die|den|das|dazu|einfach|nur|auch|intern|kurz))*|hei(?:ß|ss)(?:t|en)\s+(?:die|der|das|sie)(?:\s+(?:bei uns|intern|einfach|nur|auch|kurz))*|k(?:ü|ue)rzel|(?<=^|[,.;:]\s*)alias(?:se)?|abgek(?:ü|ue)rzt|auch bekannt als)\b(?:\s+(?:ist|sind|lautet))*\s*:?/giu,
  ],
  [
    "topics",
    /\b(?:(?:f(?:ü|ue)r\s+(?:die|den|sie|ihn)\s+)?(?:machen|betreuen|bauen|pflegen)\s+wir|wir\s+(?:machen|betreuen|bauen|pflegen|k(?:ü|ue)mmern\s+uns\s+um)|themen|leistungen|aufgaben|es\s+geht\s+um)\b(?:\s+(?:f(?:ü|ue)r\s+(?:die|den|sie|ihn)|sind|ist|dort|da|haupts(?:ä|ae)chlich|vor allem|unter anderem))*\s*:?/giu,
  ],
];
/** Words that open an item without being part of it. */
const ITEM_FILLERS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "auch", "noch", "dort",
  "da", "ist", "sind", "ausserdem", "dann", "und", "so", "halt", "eben", "immer", "deren",
  "ihre", "ihren", "ihr", "seine", "seinen", "unter", "anderem", "vor", "allem",
]);
/** Opens another name for the contact just named: "Giuseppe, genannt Gigi". */
const NICKNAME = /^(?:genannt|alias|spitzname|kurz|auch|oder einfach)\s+/i;

function items(text: string): string[] {
  return text
    .split(/[,;]|\s+(?:und|sowie|oder)\s+|\s+&\s+/)
    .map((item) => {
      const words = item.trim().replace(/[.!?]+$/, "").split(/\s+/);
      while (words.length > 0 && ITEM_FILLERS.has(normalizeText(words[0]!))) words.shift();
      return words.join(" ");
    })
    .filter((item) => /\p{L}/u.test(item));
}

function contactsOf(text: string): Contact[] {
  const contacts: Contact[] = [];
  for (const item of items(text)) {
    const last = contacts[contacts.length - 1];
    if (last && NICKNAME.test(item)) {
      last.variants.push(item.replace(NICKNAME, ""));
      continue;
    }
    // "Giuseppe genannt Gigi", "Giuseppe (Gigi)".
    const [name, ...also] = item.split(/\s+(?:genannt|alias)\s+/i);
    const contact = parseContact(name!);
    if (contact) contacts.push({ ...contact, variants: [...contact.variants, ...also] });
  }
  return contacts;
}

/** Reads contacts, aliases and topics out of a sentence about a customer. */
export function readProfileSentence(sentence: string): Profile {
  const text = sentence.replace(/\s+/g, " ").trim();
  const leads = LEADS.flatMap(([field, pattern]) =>
    [...text.matchAll(pattern)].map((match) => ({
      field,
      start: match.index,
      end: match.index + match[0].length,
    })),
  )
    .sort((a, b) => a.start - b.start || b.end - a.end)
    // A phrase inside a longer one ("Kontakte" in "Kontaktperson") is that one.
    .filter((lead, index, all) => index === 0 || lead.start >= all[index - 1]!.end);

  const profile: Profile = { aliases: [], contacts: [], topics: [] };
  leads.forEach((lead, index) => {
    const segment = text.slice(lead.end, leads[index + 1]?.start ?? text.length);
    if (lead.field === "contacts") profile.contacts.push(...contactsOf(segment));
    else profile[lead.field].push(...items(segment));
  });
  return cleanProfile(profile);
}

/** Both profiles in one: every alias, contact (with all variants) and topic. */
export function mergeProfiles(first: Profile, second: Profile): Profile {
  return cleanProfile({
    aliases: [...first.aliases, ...second.aliases],
    contacts: [...first.contacts, ...second.contacts],
    topics: [...first.topics, ...second.topics],
  });
}

const LEGAL_FORMS =
  /\b(?:gmbh\s*&\s*co\.?\s*kg|gmbh|mbh|ug\s*\(haftungsbeschr(?:ä|ae)nkt\)|ug|ag|kg|ohg|gbr|e\.\s?k\.|e\.\s?v\.|ek|ev|ltd\.?|inc\.?|se|& co\.?)(?=[\s,.]|$)/giu;

/** "Bäckerei Huber GmbH & Co. KG" → "Bäckerei Huber". */
export function shortName(name: string): string {
  return name
    .replace(LEGAL_FORMS, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/[\s,.&-]+$/, "")
    .trim();
}

/** "https://www.baeckerei-huber.de/kontakt" → "baeckerei-huber". */
export function domainName(homepage: string): string {
  const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#:\s]+)/i.exec(homepage.trim())?.[1] ?? "";
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length < 2) return "";
  // "example.co.uk": the name is in front of the two-part ending.
  const twoPart = labels.length > 2 && labels[labels.length - 2]!.length <= 3;
  return labels[labels.length - (twoPart ? 3 : 2)] ?? "";
}

/** What Kimai knows about a customer beyond the description. */
export interface CustomerFacts {
  name: string;
  contact?: string | null;
  homepage?: string | null;
}

/**
 * A first profile for a customer nobody has described yet: the contact from
 * Kimai, and as aliases the name without its legal form, its initials and
 * the name in the homepage's address, where they differ from the name.
 */
export function suggestProfile(customer: CustomerFacts): Profile {
  const short = shortName(customer.name);
  const words = short.split(/[\s-]+/).filter((word) => /^\p{L}/u.test(word));
  const initials = words.length > 1 ? words.map((word) => word[0]!.toUpperCase()).join("") : "";
  const domain = domainName(customer.homepage ?? "");
  const same = (a: string, b: string) => normalizeText(a).replace(/ /g, "") === normalizeText(b).replace(/ /g, "");
  // Nothing that only repeats the name or one of its words: those are
  // understood anyway.
  const nameWords = normalizeText(customer.name).split(" ");
  const aliases = [short, initials, domain].filter(
    (alias) =>
      alias.length > 1 && !same(alias, customer.name) && !nameWords.includes(normalizeText(alias)),
  );
  return cleanProfile({
    aliases: aliases.filter((alias, index) => !aliases.slice(0, index).some((other) => same(alias, other))),
    contacts: items(customer.contact ?? "").flatMap((name) => parseContact(name) ?? []),
    topics: [],
  });
}

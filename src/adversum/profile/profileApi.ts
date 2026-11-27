import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { KimaiApiError, type KimaiClient } from "../../api/kimaiClient";
import { normalizeWords } from "../quickEntry/normalize";
import { QUICK_WINDOW_LABEL, TRAY_WINDOW_LABEL } from "../quickEntry/quickEvents";
import { mergeProfiles, readProfileSentence, type CustomerFacts } from "./profileSentence";
import { cleanProfile, contactNames, writeProfile, type Profile } from "./profileText";

/**
 * Reading and writing profiles in Kimai, and the optional help of Claude
 * Code with a sentence about a customer.
 *
 * A profile lives in the description (`comment`) of the customer, project or
 * activity, so writing it needs the right to edit that entity in Kimai. The
 * description is read fresh right before it is written, and only its profile
 * lines change.
 */

export type ProfileKind = "customers" | "projects" | "activities";

/** Tells the other windows that a description in Kimai has changed. */
export const PROFILES_CHANGED_EVENT = "adversum://profiles-changed";

/** What Kimai holds about one entity, as far as a profile needs it. */
export interface EntityDetails extends CustomerFacts {
  comment: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The entity as Kimai has it right now. */
export async function loadEntity(
  client: KimaiClient,
  kind: ProfileKind,
  id: number,
): Promise<EntityDetails> {
  const entity = await client.get<Record<string, unknown> | null>(`/api/${kind}/${id}`);
  if (typeof entity?.name !== "string") throw new Error("Kimai returned an invalid entity");
  return {
    name: entity.name,
    comment: text(entity.comment),
    contact: text(entity.contact),
    homepage: text(entity.homepage),
  };
}

/** Why a profile could not be written. */
export type SaveProblem = "forbidden" | "failed";

/**
 * Writes the profile into the entity's description in Kimai and returns the
 * new description. Throws a `SaveProblem`.
 */
export async function saveProfile(
  client: KimaiClient,
  kind: ProfileKind,
  id: number,
  profile: Profile,
): Promise<string> {
  try {
    const current = await loadEntity(client, kind, id);
    const comment = writeProfile(current.comment, profile);
    if (comment !== (current.comment ?? "")) {
      await client.patch<unknown>(`/api/${kind}/${id}`, { comment });
    }
    for (const label of [TRAY_WINDOW_LABEL, QUICK_WINDOW_LABEL]) {
      void emitTo(label, PROFILES_CHANGED_EVENT, null).catch(() => undefined);
    }
    return comment;
  } catch (error) {
    const problem: SaveProblem =
      error instanceof KimaiApiError && error.status === 403 ? "forbidden" : "failed";
    throw problem;
  }
}

// ── A sentence about a customer ────────────────────────────────

export const PROFILE_INSTRUCTIONS = [
  "You read one German sentence in which someone describes a customer of theirs, and sort what it says.",
  "Copy words from the sentence. Never invent a name, never translate.",
  "aliases: other names the customer goes by internally ('intern sagen wir Huber').",
  "contacts: the people at the customer, each with name and nicknames ('Giuseppe, genannt Gigi').",
  "topics: what is done for the customer ('wir machen Website und Google Ads').",
  "Leave a list empty when the sentence says nothing for it.",
].join("\n");

const LIST = { type: "array", items: { type: "string" } };
export const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    aliases: LIST,
    contacts: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, nicknames: LIST },
        required: ["name", "nicknames"],
      },
    },
    topics: LIST,
  },
  required: ["aliases", "contacts", "topics"],
};

/**
 * Checks a model's answer about a customer. Only what is made of words of
 * the sentence is kept: a model that was asked to copy still invents.
 */
export function parseProfileAnswer(output: string, sentence: string): Profile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const answer = parsed as Record<string, unknown>;
  const said = new Set(normalizeWords(sentence));
  const grounded = (value: unknown): value is string =>
    typeof value === "string" &&
    normalizeWords(value).length > 0 &&
    normalizeWords(value).every((word) => said.has(word));
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter(grounded) : []);
  const contacts = (Array.isArray(answer.contacts) ? answer.contacts : []).flatMap((item) => {
    const contact = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    return grounded(contact.name)
      ? [{ name: contact.name, variants: strings(contact.nicknames) }]
      : [];
  });
  return cleanProfile({ aliases: strings(answer.aliases), contacts, topics: strings(answer.topics) });
}

/**
 * Reads a sentence about a customer: by the rules, and where the setting
 * allows Claude Code and it is there and willing, with its help on top.
 */
export async function readProfile(sentence: string): Promise<Profile> {
  const byRules = readProfileSentence(sentence);
  const answer = await invoke<string | null>("adversum_profile_extract", {
    sentence,
    instructions: PROFILE_INSTRUCTIONS,
    schema: JSON.stringify(PROFILE_SCHEMA),
  }).catch(() => null);
  const byModel = answer ? parseProfileAnswer(answer, sentence) : null;
  return byModel ? mergeProfiles(byRules, byModel) : byRules;
}

/** Every word of a profile, for telling what is already in it. */
export function profileWords(profile: Profile): Set<string> {
  return new Set(
    [...profile.aliases, ...profile.contacts.flatMap(contactNames), ...profile.topics].flatMap(
      normalizeWords,
    ),
  );
}

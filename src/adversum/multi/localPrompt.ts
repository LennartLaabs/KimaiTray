import type { QuickCatalog } from "../quickEntry/catalog";
import { EXTRACT_INSTRUCTIONS } from "./extract";

/**
 * What the local language model is asked and how its answer is held to JSON.
 *
 * The local model runs on this Mac (llama.cpp in the helper program
 * `kimaitray-llm`), so the names of customers, projects and activities may
 * go into its prompt; they help it tell a task from a note. As everywhere,
 * it only extracts what was said. All arithmetic stays in `plan.ts`.
 */

/** Names beyond this many make the prompt slow without making it better. */
const MAX_NAMES = 60;

/**
 * The answer's shape as a llama.cpp grammar (GBNF): the same fields as
 * `EXTRACT_SCHEMA`, in a fixed order, at most eight activities. Fields that
 * say nothing (0, false, "none", no time) are left out, which keeps the
 * answer short and the wait with it. A model that is held to the grammar
 * cannot answer with anything but this JSON.
 */
export const EXTRACT_GRAMMAR = String.raw`root ::= "{" ("\"window_minutes\":" int ",")? "\"activities\":[" activity ("," activity){0,7} "]}"
activity ::= "{\"task\":" text (",\"minutes\":" int)? (",\"count\":" int)? (",\"repeated\":true")? (",\"vague\":true")? (",\"rest\":true")? (",\"relation\":" relation)? (",\"from\":" time ",\"to\":" time)? "}"
relation ::= "\"within\"" | "\"after\"" | "\"before\""
time ::= "\"" [0-2] [0-9] ":" [0-5] [0-9] "\""
text ::= "\"" [^"\\\x00-\x1F]{1,100} "\""
int ::= [1-9] [0-9]{0,3}`;

/** Worked examples with names that are in no catalog. */
const EXAMPLES = [
  [
    "Zwei Stunden Bäckerei Krume Flyer, zwischendurch 15 Minuten mit Frau Aydin von Optik Lenz telefoniert, danach noch kurz Mails",
    '{"activities":[{"task":"Bäckerei Krume Flyer","minutes":120},{"task":"Optik Lenz Telefonat Frau Aydin","minutes":15,"relation":"within"},{"task":"Mails","vague":true,"relation":"after"}]}',
  ],
  [
    "Die letzten vier Stunden: von 13 bis halb drei Workshop bei Optik Lenz, viermal je 5 Minuten Social Media für Bäckerei Krume, immer wieder kurz Mails, der Rest Buchhaltung",
    '{"window_minutes":240,"activities":[{"task":"Optik Lenz Workshop","from":"13:00","to":"14:30"},{"task":"Bäckerei Krume Social Media","minutes":5,"count":4,"repeated":true},{"task":"Mails","repeated":true,"vague":true},{"task":"Buchhaltung","rest":true}]}',
  ],
  [
    "Eigentlich wollte ich das Logo für Optik Lenz machen, hab dann aber anderthalb Stunden die Website von Bäckerei Krume repariert und je 20 Minuten Angebote für Optik Lenz und Bäckerei Krume geschrieben",
    '{"activities":[{"task":"Bäckerei Krume Website repariert","minutes":90},{"task":"Optik Lenz Angebot","minutes":20,"relation":"after"},{"task":"Bäckerei Krume Angebot","minutes":20}]}',
  ],
] as const;

function listed(names: readonly string[]): string {
  return [...new Set(names)].slice(0, MAX_NAMES).join(", ");
}

/** The instructions for the local model, with the names this user works with. */
export function localInstructions(catalog: QuickCatalog, teamMembers: readonly string[] = []): string {
  const { combinations } = catalog;
  const known = [
    `Customers: ${listed(combinations.map((item) => item.customer))}.`,
    `Projects: ${listed(combinations.map((item) => item.project))}.`,
    `Kinds of work: ${listed(combinations.map((item) => item.activity))}.`,
    ...(teamMembers.length > 0
      ? [`Colleagues (never customers, keep them in task): ${listed(teamMembers)}.`]
      : []),
  ];
  return [
    EXTRACT_INSTRUCTIONS,
    "Leave a field out when it would be 0, false, 'none' or empty.",
    "Only list work that was done. Leave out what was merely planned or wanted.",
    "One activity per customer and kind of work; keep a customer's name in task as it was said.",
    "Names this person works with:",
    ...known,
    "Answer with JSON only.",
    ...EXAMPLES.flatMap(([sentence, answer]) => [`Sentence: ${sentence}`, `JSON: ${answer}`]),
  ].join("\n");
}

/** The request for one sentence. */
export function localInput(sentence: string): string {
  return `Sentence: ${sentence.replace(/\s+/g, " ").trim()}\nJSON:`;
}

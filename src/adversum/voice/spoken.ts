import type { QuickCatalog } from "../quickEntry/catalog";
import type { QuickCommand } from "../quickEntry/commands";
import { parseDate, sameDay } from "../quickEntry/dateParser";
import type { QuickHistory } from "../quickEntry/history";
import { normalizeText } from "../quickEntry/normalize";
import { parseQuickEntry, type QuickParseResult } from "../quickEntry/parse";
import { rewriteSpokenTime, spokenToken, type SpokenToken } from "./spokenTime";

/**
 * Turns a transcribed sentence into what the quick entry parser reads.
 *
 * People do not dictate "dusw pm gigi call seit 10". They say "Äh, ich mache
 * jetzt DUSW Projektmanagement, Gigi Call, seit zehn Uhr" or "Ich hab von 10
 * bis 11 mit Gigi telefoniert". This module removes what carries no meaning,
 * writes times the way the time parser expects them and recognizes the three
 * things a sentence can be: a command, a note for the running timer, or an
 * entry. Pure functions; the catalog matching stays in `quickEntry/parse.ts`.
 */

export type SpokenIntent =
  /** Nothing usable was said. */
  | { kind: "empty" }
  | { kind: "command"; command: QuickCommand }
  /** "Notiz: …": text for the running timer. */
  | { kind: "note"; text: string }
  | {
      kind: "entry";
      /** Cleaned text for `parseQuickEntry`. */
      text: string;
      /** Noun for the note, derived from the verb: "telefoniert" → "Telefonat". */
      noteLead: string;
      /** Beginnings of activity names the verb points to, best first. */
      activityHints: string[];
      /**
       * The work is still going on ("bin seit 30 Minuten im Call", "sind
       * immer noch dran"): a timer that keeps running, never a finished entry.
       */
      running: boolean;
    };

/** What Whisper tends to write for silence or noise. */
const NOISE_START = /^(untertitel|copyright|vielen dank|bis zum naechsten mal)/;
const NOISE = new Set(["", "musik", "applaus", "tschuess", "danke"]);

const NOTE_PREFIX =
  /^(?:(?:und\s+)?(?:eine\s+|als\s+)?notiz(?:\s+dazu)?|notiere?|vermerke?)(?:\s+(?:dir|bitte|mal))*\s*[:,.–—-]?\s+(\S.*)$/i;

const EDGE_PUNCTUATION_START = /^[„“”"'‚‘’«»¿¡(–—-]+/;
const EDGE_PUNCTUATION_END = /[.,;:!?…"“”'‘’«»)–—-]+$/;

const COMMANDS = new Map<string, QuickCommand>([
  ["stop", "stop"],
  ["stopp", "stop"],
  ["stoppe", "stop"],
  ["stoppen", "stop"],
  ["anhalten", "stop"],
  ["beenden", "stop"],
  ["beende", "stop"],
  ["ende", "stop"],
  ["schluss", "stop"],
  ["feierabend", "stop"],
  ["pause", "pause"],
  ["pausiere", "pause"],
  ["pausieren", "pause"],
  ["unterbrechen", "pause"],
  ["weiter", "resume"],
  ["weitermachen", "resume"],
  ["fortsetzen", "resume"],
  ["fortfahren", "resume"],
  ["zurueck", "previous"],
  ["vorherige", "previous"],
  ["vorherigen", "previous"],
  ["letzte", "previous"],
  ["letzten", "previous"],
]);
/** Words that may surround a command: "mach mal Pause", "zurück zur letzten Aufgabe". */
const COMMAND_PADDING = new Set([
  "timer", "den", "die", "das", "dem", "mach", "mache", "machen", "zum", "zur", "zu",
  "aufgabe", "task", "einen", "eine", "ich", "wir", "erstmal", "kurz", "hier", "wieder",
  "bitte", "mal", "jetzt", "aeh", "aehm", "ok", "okay", "so", "und", "dann",
]);

/** Carry no meaning wherever they stand. */
const FILLERS = new Set([
  "aeh", "aehm", "ehm", "oehm", "hm", "hmm", "mh", "bitte", "mal", "halt", "quasi",
  "sozusagen", "eigentlich", "also", "jetzt", "gerade", "eben", "nun", "ich",
  "wir", "hab", "habe", "hatte", "bin", "war", "sind", "waren", "immer", "noch", "dran",
  "dabei", "laeuft",
]);
/**
 * Says that the work is still going on. "seit" needs no entry here: the time
 * parser reads it as a start anyway.
 */
const STILL_RUNNING = /\b(immer noch|noch immer|noch dran|noch dabei|laeuft noch|laeuft gerade)\b/;
/** Says so too, unless the sentence looks back ("hab gerade … gemacht"). */
const NOW_RUNNING =
  /\b(gerade|bin (im|in|am|an|bei|beim|mit|dran|dabei)|sind (im|in|am|an|bei|beim|dran|dabei)|sitze (im|in|am|an|bei|beim))\b/;
const LOOKS_BACK = /\b(hab|habe|haben|hatte|hatten)\b/;
/** Carry no meaning at the start: "starte", "weiter mit dem", "okay, an der". */
const LEAD_INS = new Set([
  "mache", "mach", "arbeite", "sitze", "starte", "start", "starten", "beginne", "fange",
  "erst", "zuerst",
  "fang", "timer", "neuer", "neuen", "zeit", "kommt", "weiter", "okay", "ok", "gut", "so",
  "dann", "als", "naechstes", "und", "mit", "an", "fuer", "bei", "beim", "im", "in", "am",
  "den", "die", "das", "der", "dem", "einen", "eine", "auf", "zu", "zum", "zur",
]);
const TRAILERS = new Set(["danke", "starten", "start", "los", "machen", "timer"]);

interface Verb {
  /** Noun for the note; empty for verbs that only describe working. */
  lead: string;
  hints: string[];
}
const TALK_HINTS = [
  "telefon", "call", "austausch", "abstimmung", "meeting", "besprechung", "kommunikation",
];
const VERB_GROUPS: [string[], Verb][] = [
  [["telefoniert", "telefoniere", "telefonieren"], { lead: "Telefonat", hints: TALK_HINTS }],
  [["gecallt", "gecalled", "calle"], { lead: "Call", hints: TALK_HINTS }],
  [["gesprochen", "spreche", "geredet", "rede"], { lead: "Gespräch", hints: TALK_HINTS }],
  // "Wir besprechen den Messestand": says what the talk is about, no more.
  [["besprechen", "sprechen", "reden", "klaeren"], { lead: "", hints: TALK_HINTS }],
  [
    ["besprochen", "bespreche", "abgestimmt"],
    { lead: "Abstimmung", hints: ["abstimmung", "austausch", "besprechung", "meeting", "call"] },
  ],
  [
    ["getroffen", "treffe"],
    { lead: "Treffen", hints: ["meeting", "termin", "austausch", "besprechung"] },
  ],
  [
    ["gemailt", "maile"],
    { lead: "E-Mail", hints: ["mail", "kommunikation", "korrespondenz", "austausch"] },
  ],
  [
    ["programmiert", "programmiere", "entwickelt", "entwickle"],
    { lead: "", hints: ["entwicklung", "programmierung", "development", "umsetzung"] },
  ],
  [
    ["designt", "designe", "gestaltet", "gestalte"],
    { lead: "", hints: ["design", "gestaltung", "layout", "grafik"] },
  ],
  [
    ["geschnitten", "schneide"],
    { lead: "", hints: ["schnitt", "videoschnitt", "postproduktion", "editing"] },
  ],
  [["gedreht", "drehe"], { lead: "", hints: ["dreh", "videodreh", "produktion"] }],
  [["recherchiert", "recherchiere"], { lead: "", hints: ["recherche", "research"] }],
  [
    ["geplant", "plane", "konzipiert"],
    { lead: "", hints: ["planung", "konzeption", "konzept", "projektmanagement"] },
  ],
  [["getextet", "texte"], { lead: "", hints: ["text", "redaktion", "content"] }],
  [
    [
      "gearbeitet", "gemacht", "gehabt", "gewesen", "gesessen", "angefangen", "begonnen",
      "gestartet",
    ],
    { lead: "", hints: [] },
  ],
];
const VERBS = new Map(VERB_GROUPS.flatMap(([forms, verb]) => forms.map((form) => [form, verb])));

/** Splits a transcript into words without the punctuation around them. */
function tokenize(text: string): SpokenToken[] {
  return text
    .split(/\s+/)
    .map((raw) => raw.replace(EDGE_PUNCTUATION_START, "").replace(EDGE_PUNCTUATION_END, ""))
    .filter(Boolean)
    .map(spokenToken)
    // A token of nothing but symbols ("&", "/") says nothing.
    .filter((token) => token.word !== "");
}

/** The command a sentence stands for when nothing but padding surrounds it. */
function spokenCommand(tokens: readonly SpokenToken[]): QuickCommand | null {
  const core = tokens.filter((token) => !COMMAND_PADDING.has(token.word));
  const [first, ...others] = core.map((token) => COMMANDS.get(token.word) ?? null);
  if (!first || others.some((command) => command !== first)) return null;
  return first;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Reads a transcribed sentence. `now` resolves "bis jetzt". */
export function interpretSpoken(transcript: string, now: Date): SpokenIntent {
  // Sound descriptions such as "[Musik]" or "(lacht)" are not speech.
  const text = transcript
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const folded = normalizeText(text);
  if (NOISE.has(folded) || NOISE_START.test(folded)) return { kind: "empty" };

  const note = NOTE_PREFIX.exec(text);
  if (note) {
    return { kind: "note", text: capitalize(note[1]!.replace(/[.\s]+$/, "")) };
  }

  const heard = tokenize(text);
  const command = spokenCommand(heard);
  if (command) return { kind: "command", command };

  // The day comes out first, so that "26. November" is not read as a time
  // or a note. It goes back in at the end in the form the parser reads.
  const dated = parseDate(text.split(" "), now);
  const day = dated.day
    ? [dated.day.getDate(), dated.day.getMonth() + 1, dated.day.getFullYear()].join(".")
    : null;
  const undated = day ? tokenize(dated.rest.join(" ")) : heard;

  let tokens = rewriteSpokenTime(undated, now).filter((token) => !FILLERS.has(token.word));
  while (tokens.length > 0 && LEAD_INS.has(tokens[0]!.word)) tokens = tokens.slice(1);
  while (tokens.length > 0 && TRAILERS.has(tokens[tokens.length - 1]!.word)) {
    tokens = tokens.slice(0, -1);
  }

  // The first verb that says something decides note and activity hints.
  const verbs = tokens.flatMap((token) => VERBS.get(token.word) ?? []);
  const telling = verbs.find((verb) => verb.lead !== "" || verb.hints.length > 0);
  tokens = tokens.filter((token) => !VERBS.has(token.word));

  if (tokens.length === 0 && !telling) return { kind: "empty" };
  return {
    kind: "entry",
    text: [...tokens.map((token) => token.raw), ...(day ? [day] : [])].join(" "),
    noteLead: telling?.lead ?? "",
    activityHints: telling?.hints ?? [],
    running:
      STILL_RUNNING.test(folded) || (NOW_RUNNING.test(folded) && !LOOKS_BACK.test(folded)),
  };
}

/** What a spoken sentence means for this catalog. */
export type SpokenReading =
  | { kind: "empty" }
  | { kind: "command"; command: QuickCommand }
  | { kind: "note"; text: string }
  | {
      kind: "entry";
      /** The cleaned sentence; also the text for editing it by hand. */
      text: string;
      result: QuickParseResult;
    };

/** Interprets a transcript and matches it against the catalog. */
export function readSpoken(
  transcript: string,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
): SpokenReading {
  const intent = interpretSpoken(transcript, now);
  if (intent.kind !== "entry") return intent;
  const result = parseQuickEntry(intent.text, catalog, history, now, {
    noteLead: intent.noteLead,
    activityHints: intent.activityHints,
  });
  // The parser knows a few more command words ("resume", "back").
  if (result.command) return { kind: "command", command: result.command };
  // "Bin gerade 30 Minuten im Call": a duration of work that still goes on
  // is when it started, not an entry that is over.
  const duration = result.time.kind === "range" && !/^von\b/i.test(result.timePhrase);
  if (intent.running && duration && result.time.kind === "range" && sameDay(result.time.end, now)) {
    return {
      kind: "entry",
      text: intent.text,
      result: { ...result, time: { kind: "start", begin: result.time.begin } },
    };
  }
  return { kind: "entry", text: intent.text, result };
}

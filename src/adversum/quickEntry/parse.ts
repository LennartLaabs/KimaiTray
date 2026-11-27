import type { Combination, EntityWords, QuickCatalog } from "./catalog";
import { parseCommand, type QuickCommand } from "./commands";
import { parseDate } from "./dateParser";
import { historyScore, type QuickHistory } from "./history";
import { isNameLike } from "./nameLike";
import { editDistance, normalizeText, normalizeWords } from "./normalize";
import { soundsLike } from "./phonetic";
import { parseTime, type TimeSpec } from "./timeParser";

export const MAX_SUGGESTIONS = 5;
/** Below this confidence the bar preselects nothing; the user has to choose. */
export const AUTO_SELECT_CONFIDENCE = 0.6;

/** A word counts as naming an entity from this score on. */
const MATCH_THRESHOLD = 0.5;
/** One fully matched word outweighs any difference in history. */
const TEXT_WEIGHT = 10;
const HISTORY_WEIGHT = 3;
/** The lead over the runner-up that counts as unambiguous. */
const CLEAR_LEAD = 0.1;
/**
 * Spoken input: once the note has begun, a later word only names an entity
 * when it does so (almost) exactly. A loose match is more likely part of the
 * note.
 */
const LATE_MATCH_THRESHOLD = 0.85;
/** Spoken input: the best activity hint counts like half a matched word. */
const HINT_SCORE = 0.5;
const HINT_STEP = 0.02;
/** Spoken input: a note word needs this many past entries for full weight. */
const AFFINITY_FULL_COUNT = 3;
/** Evidence from past notes counts as naming the customer from here on. */
const AFFINITY_NAMES_TARGET = 0.5;

/**
 * Words that connect what is said without naming anything ("für", "mit",
 * "das"). In spoken input they neither start the note nor end an entity; in
 * the note they stay only between two note words.
 */
const GLUE_WORDS = new Set([
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "und", "mit", "fuer", "bei", "beim", "an", "am", "im", "in", "zu", "zum", "zur",
  "von", "vom", "auf", "aus", "ueber", "the",
]);
/** Said in front of a name: they belong to it and start no note. */
const TITLES = new Set(["frau", "herr", "dr", "prof"]);
/** Lead into the topic of a talk; after "mit Patrick:" they say nothing. */
const TOPIC_LEADS = new Set(["wegen", "bezueglich", "thema"]);

/** How spoken input differs from typed input; see `voice/spoken.ts`. */
export interface SpokenOptions {
  /** Put in front of the note: "Telefonat" for "… mit Gigi telefoniert". */
  noteLead?: string;
  /** Beginnings of activity names the sentence points to, best first. */
  activityHints?: readonly string[];
}

export interface QuickSuggestion {
  combination: Combination;
  /**
   * The note of the new entry: the words that named no entity, and those
   * that named one but say something of their own ("Call", "Giuseppe").
   */
  note: string;
  /** Ranking score: text match plus history. */
  score: number;
  /** Sum of the match scores of the words that named an entity. */
  textScore: number;
  /** How many words named an entity. */
  matchedWords: number;
  /** Whether a word named the customer or the project (not only the activity). */
  namesTarget: boolean;
  /** The normalized words that named each entity. */
  words: Record<EntityKind, string[]>;
}

export interface QuickParseResult {
  /** Set when the input is a command; then there are no suggestions. */
  command: QuickCommand | null;
  time: TimeSpec;
  /** The day that was named ("gestern", "26.11."); `null` when none was. */
  day: Date | null;
  /** The date and time phrases as typed ("gestern von 9 bis 10"). */
  timePhrase: string;
  /** Best combinations first, at most `MAX_SUGGESTIONS`. */
  suggestions: QuickSuggestion[];
  /** Confidence in the first suggestion, 0 to 1. */
  confidence: number;
  /** Whether the first suggestion may be started without an explicit choice. */
  autoSelect: boolean;
}

/** A word that only sounds like a name counts this much. */
const SOUND_SCORE = 0.6;
/** A note word that is one of the entity's topics counts this much. */
const TOPIC_SCORE = 0.4;

/**
 * The name, alias or contact of the entity that `word` sounds like, when it
 * is not written like any of them: "dschuseppe" → "giuseppe".
 */
export function soundMatch(word: string, entity: EntityWords): string | null {
  return (
    [...entity.aliases, ...entity.words].find((candidate) => soundsLike(word, candidate)) ?? null
  );
}

/** How well one typed word names an entity, from 0 (not at all) to 1 (exactly). */
export function scoreWord(word: string, entity: EntityWords): number {
  const spelled = spellingScore(word, entity);
  if (spelled >= MATCH_THRESHOLD) return spelled;
  return soundMatch(word, entity) ? SOUND_SCORE : spelled;
}

/** How well the word is written like the entity's names; sound aside. */
function spellingScore(word: string, entity: EntityWords): number {
  if (entity.aliases.includes(word) || entity.words.includes(word)) return 1;
  if (word.length >= 2 && word === entity.acronym) return 0.85;
  let best = 0;
  for (const candidate of entity.words) {
    if (word.length >= 2 && candidate.startsWith(word)) {
      best = Math.max(best, 0.7 + 0.25 * (word.length / candidate.length));
    } else if (word.length >= 3 && candidate.includes(word)) {
      best = Math.max(best, 0.55);
    } else if (word.length >= 4) {
      const limit = word.length >= 7 ? 2 : 1;
      const distance = editDistance(word, candidate, limit);
      if (distance <= limit) best = Math.max(best, 0.75 - 0.1 * distance);
    }
  }
  return best;
}

export type EntityKind = "customer" | "project" | "activity";
type Kind = EntityKind;
const KINDS: readonly Kind[] = ["customer", "project", "activity"];

/** One word of the note. */
interface NoteItem {
  index: number;
  /**
   * The entity the word named as well. Such a word stays in the note because
   * it is no mere name: "Call" for the activity "Austausch".
   */
  kept: Kind | null;
  /** A connecting word between two note words ("für", "mit"). */
  glue?: boolean;
  /** A colleague's name: "Patrick" in "Call mit Patrick". */
  team?: boolean;
  /** How the word is really written, when it was only heard alike. */
  as?: string;
}

interface Assignment {
  textScore: number;
  matchedWords: number;
  namesTarget: boolean;
  /** The words that belong to the note, in order. */
  note: NoteItem[];
  words: Record<Kind, string[]>;
  /**
   * Customer and project are named only by words that sound like them
   * ("Solartek"), none that is written like them.
   */
  bySound: boolean;
}

/** Keeps track of whether the target was named by spelling or only by sound. */
class Naming {
  private spelled = false;
  private heard = false;

  /**
   * Records how `word` named the entity of `kind`. Returns the note item
   * for a word that is more than a name, `null` for a mere name.
   */
  take(word: string, index: number, kind: Kind, entity: EntityWords): NoteItem | null {
    const as = spellingScore(word, entity) >= MATCH_THRESHOLD ? null : soundMatch(word, entity);
    if (kind !== "activity") {
      if (as) this.heard = true;
      else this.spelled = true;
    }
    if (isNameLike(as ?? word, entity)) return null;
    return { index, kept: kind, ...(as ? { as } : {}) };
  }

  get bySound(): boolean {
    return this.heard && !this.spelled;
  }
}

/** The kind that `word` names best among those still open, with its score. */
function bestKind(
  word: string,
  entities: Record<Kind, EntityWords>,
  closed: ReadonlySet<Kind>,
  open: Kind | null,
): { kind: Kind | null; score: number } {
  let kind: Kind | null = null;
  let best = 0;
  for (const candidate of KINDS) {
    if (closed.has(candidate)) continue;
    const score = scoreWord(word, entities[candidate]);
    // On a tie the entity already being named keeps the word.
    if (score > best || (score === best && score > 0 && candidate === open)) {
      kind = candidate;
      best = score;
    }
  }
  return { kind, score: best };
}

/**
 * Reads the words left to right as names of the combination's customer,
 * project and activity. Each of the three can be named once, by one or more
 * consecutive words. The first word that names none of them starts the note,
 * and everything after it belongs to the note too:
 * "dusw pm gigi call" → customer "dusw", activity "pm", note "gigi call",
 * even though "gigi" and "call" are aliases as well.
 *
 * A naming word that is more than a name stays in the note: "gigi call"
 * names customer and activity and still tells what was done.
 */
function assign(
  words: readonly string[],
  entities: Record<Kind, EntityWords>,
  team: ReadonlySet<string>,
): Assignment {
  const closed = new Set<Kind>();
  const named: Record<Kind, string[]> = { customer: [], project: [], activity: [] };
  const note: NoteItem[] = [];
  const naming = new Naming();
  let open: Kind | null = null;
  let textScore = 0;
  let matchedWords = 0;
  let index = 0;
  for (; index < words.length; index++) {
    const word = words[index]!;
    const { kind, score } = bestKind(word, entities, closed, open);
    // A colleague's name names no task, whatever it resembles.
    if (!kind || score < MATCH_THRESHOLD || team.has(word)) break;
    if (open && open !== kind) closed.add(open);
    open = kind;
    textScore += score;
    matchedWords += 1;
    named[kind].push(word);
    const kept = naming.take(word, index, kind, entities[kind]);
    if (kept) note.push(kept);
  }
  for (; index < words.length; index++) {
    note.push({ index, kept: null, ...(team.has(words[index]!) ? { team: true } : {}) });
  }
  return {
    textScore,
    matchedWords,
    namesTarget: named.customer.length + named.project.length > 0,
    note,
    words: named,
    bySound: naming.bySound,
  };
}

/**
 * The spoken variant: entities can be named anywhere in the sentence, and
 * the words in between form the note. "Gigi Call für DUSW Projektmanagement"
 * → note "Gigi Call", customer "DUSW", activity "Projektmanagement". After
 * the first note word, later words have to name an entity (almost) exactly.
 */
function assignSpoken(
  words: readonly string[],
  entities: Record<Kind, EntityWords>,
  team: ReadonlySet<string>,
): Assignment {
  const closed = new Set<Kind>();
  const named: Record<Kind, string[]> = { customer: [], project: [], activity: [] };
  let open: Kind | null = null;
  let textScore = 0;
  let matchedWords = 0;
  // Each run of note words between names, glue words included.
  const runs: NoteItem[][] = [[]];
  const naming = new Naming();
  let noteStarted = false;
  words.forEach((word, index) => {
    const run = runs[runs.length - 1]!;
    // A colleague's name is part of the note and nothing else.
    if (team.has(word)) {
      run.push({ index, kept: null, team: true });
      return;
    }
    // "Frau Meier": the title goes with the name that follows.
    if (TITLES.has(word)) {
      run.push({ index, kept: null, glue: true });
      return;
    }
    // A glue word inside a name ("Haus am See") belongs to that name.
    if (GLUE_WORDS.has(word) && !(open && scoreWord(word, entities[open]) === 1)) {
      run.push({ index, kept: null, glue: true });
      return;
    }
    const { kind, score } = bestKind(word, entities, closed, open);
    if (kind && score >= (noteStarted ? LATE_MATCH_THRESHOLD : MATCH_THRESHOLD)) {
      if (open && open !== kind) closed.add(open);
      open = kind;
      textScore += score;
      matchedWords += 1;
      named[kind].push(word);
      // More than a name ("Giuseppe", "Call"): it stays where it was said.
      const kept = naming.take(word, index, kind, entities[kind]);
      if (kept) run.push(kept);
      else runs.push([]);
      return;
    }
    // The name of something already named, said again ("Gigi Call für
    // DUSW"): still a name, not a note.
    const again = KINDS.some(
      (candidate) =>
        closed.has(candidate) &&
        scoreWord(word, entities[candidate]) >= LATE_MATCH_THRESHOLD &&
        isNameLike(word, entities[candidate]),
    );
    if (again) {
      runs.push([]);
      return;
    }
    // A word that names nothing ends the entity being named.
    if (open) closed.add(open);
    open = null;
    noteStarted = true;
    run.push({ index, kept: null });
  });
  const note = runs.flatMap((run) => {
    const first = run.findIndex((item) => !item.glue);
    if (first < 0) return [];
    const last = run.length - 1 - [...run].reverse().findIndex((item) => !item.glue);
    return run.slice(first, last + 1);
  });
  return {
    textScore,
    matchedWords,
    namesTarget: named.customer.length + named.project.length > 0,
    note,
    words: named,
    bySound: naming.bySound,
  };
}

/**
 * How strongly the note points to a combination, from 0 to 1: past entries
 * whose notes contain the same word ("Gigi") were mostly booked on it, or at
 * least on its customer.
 */
function noteAffinity(
  noteWords: readonly string[],
  combination: Combination,
  history: QuickHistory,
  customerOf: ReadonlyMap<string, number>,
): number {
  let best = 0;
  for (const word of new Set(noteWords)) {
    const byCombination = history.notes.get(word);
    if (!byCombination) continue;
    let total = 0;
    let same = 0;
    let sameCustomer = 0;
    for (const [key, count] of byCombination) {
      total += count;
      if (key === combination.key) same += count;
      if (customerOf.get(key) === combination.customerId) sameCustomer += count;
    }
    const strength = Math.min(1, total / AFFINITY_FULL_COUNT);
    best = Math.max(best, strength * ((0.6 * same) / total + (0.4 * sameCustomer) / total));
  }
  return best;
}

/** Score of the best hint the activity's name begins with; 0 for none. */
function hintScore(activity: EntityWords, hints: readonly string[]): number {
  const index = hints.findIndex((hint) =>
    activity.words.some((word) => word.startsWith(hint)),
  );
  return index < 0 ? 0 : Math.max(0, HINT_SCORE - HINT_STEP * index);
}

/** One typed or spoken word and the normalized words it consists of. */
interface InputToken {
  raw: string;
  /** Positions of its normalized words among all words. */
  members: number[];
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The word without the punctuation of the sentence around it. */
function withoutEdgePunctuation(raw: string): string {
  return raw
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}%€$+#]+$/u, "");
}

/**
 * The note as text. The word that decided the activity leads ("Giuseppe
 * Call" → "Call Giuseppe"), like the noun of a spoken verb does ("Telefonat
 * Gigi"). Words keep the spelling they came in, hyphens included; a note
 * without any capital letter gets them ("gigi call" → "Gigi Call").
 */
function formatNote(
  items: readonly NoteItem[],
  words: readonly string[],
  tokens: readonly InputToken[],
  lead: string,
): string {
  // Colleagues are named after the kind of work: "Call mit Patrick".
  const team = items.filter((item) => item.team);
  const others = items.filter(
    (item, position) =>
      !item.team &&
      // The connecting word in front of a colleague's name goes with it.
      !(item.glue && items[position + 1]?.team),
  );
  const leading = others.filter((item) => item.kept === "activity");
  const ordered = [
    ...leading,
    ...others.filter(
      (item, position) =>
        item.kept !== "activity" &&
        // A glue word in front of a word that moved away connects nothing.
        !(item.glue && others[position + 1]?.kept === "activity"),
    ),
  ];
  const inNote = new Set(ordered.map((item) => item.index));
  const written = new Set<InputToken>();
  const tokenOf = (index: number) =>
    tokens.find((candidate) => candidate.members.includes(index))!;
  const pieces: { text: string; kept: boolean; head: boolean; glue: boolean }[] = [];
  for (const item of ordered) {
    const token = tokenOf(item.index);
    const whole = token.members.every((member) => inNote.has(member));
    if (whole && written.has(token)) continue;
    written.add(token);
    // A name that was only heard alike is written the way it is written.
    const text = item.as ?? (whole ? withoutEdgePunctuation(token.raw) : words[item.index]!);
    if (text) {
      pieces.push({
        text,
        kept: item.kept !== null,
        head: item.kept === "activity",
        glue: item.glue === true,
      });
    }
  }

  const plain = pieces.map((piece) => piece.text).join(" ");
  const lowercase = plain === plain.toLowerCase();
  const write = (piece: { text: string; kept: boolean }) => {
    if (!lowercase) return piece.kept ? capitalize(piece.text) : piece.text;
    if (GLUE_WORDS.has(normalizeText(piece.text))) return piece.text;
    return piece.text.replace(/(^|-)(\p{L})/gu, (_, before: string, letter: string) =>
      before + letter.toUpperCase(),
    );
  };
  const head = pieces.filter((piece) => piece.head).map(write);
  if (lead && normalizeText(head[0] ?? "") !== normalizeText(lead)) head.unshift(lead);
  const rest = pieces.filter((piece) => !piece.head);
  if (team.length === 0) return capitalize([...head, ...rest.map(write)].join(" "));

  // "Call mit Patrick: Messestand": what, with whom, about what.
  const idle = (piece: { text: string; glue: boolean } | undefined) =>
    !!piece && (piece.glue || TOPIC_LEADS.has(normalizeText(piece.text)));
  while (idle(rest[0])) rest.shift();
  while (idle(rest[rest.length - 1])) rest.pop();
  const names = team.map((item) => capitalize(withoutEdgePunctuation(tokenOf(item.index).raw)));
  const who = `mit ${names.join(" und ")}`;
  const topic = rest.map(write).join(" ");
  return capitalize(`${[...head, who].join(" ")}${topic ? `: ${topic}` : ""}`);
}

/**
 * Turns the text of the quick entry bar into a command or ranked suggestions.
 * Pure: everything it needs is passed in, including the current time.
 *
 * With `spoken`, the text is read as a spoken sentence: free word order,
 * glue words ignored, and the note and activity hints count as evidence for
 * a combination, next to the words that name it.
 */
export function parseQuickEntry(
  input: string,
  catalog: QuickCatalog,
  history: QuickHistory,
  now: Date,
  spoken?: SpokenOptions,
): QuickParseResult {
  const command = parseCommand(input);
  if (command) {
    return {
      command,
      time: { kind: "none" },
      day: null,
      timePhrase: "",
      suggestions: [],
      confidence: 1,
      autoSelect: true,
    };
  }

  const dated = parseDate(input.trim().split(/\s+/).filter(Boolean), now);
  const { time, rest, phrase } = parseTime(dated.rest.join(" "), now, dated.day);
  // Each raw word can normalize to several words ("gigi-call"); keep the raw
  // spelling for the note and the normalized words for matching.
  const words: string[] = [];
  const tokens: InputToken[] = rest.map((raw) => {
    const normalized = normalizeWords(raw);
    const members = normalized.map((_, offset) => words.length + offset);
    words.push(...normalized);
    return { raw, members };
  });

  const customerOf = new Map(
    spoken ? catalog.combinations.map((item) => [item.key, item.customerId]) : [],
  );
  const hints = spoken?.activityHints ?? [];

  const ranked = catalog.combinations.map((combination) => {
    const entities = {
      customer: catalog.customers.get(combination.customerId)!,
      project: catalog.projects.get(combination.projectId)!,
      activity: catalog.activities.get(combination.activityId)!,
    };
    const assignment = spoken
      ? assignSpoken(words, entities, catalog.team)
      : assign(words, entities, catalog.team);
    // What speaks for the combination besides the words that name it.
    const affinity = spoken
      ? noteAffinity(
          assignment.note
            .filter((item) => item.kept === null && !item.team)
            .map((item) => words[item.index]!),
          combination,
          history,
          customerOf,
        )
      : 0;
    const hint =
      assignment.words.activity.length === 0 ? hintScore(entities.activity, hints) : 0;
    // A note word that is one of the entity's topics ("Roll-Ups") speaks
    // for it, most of all when no customer was said.
    const free = assignment.note.filter((item) => item.kept === null && !item.team);
    const topic = KINDS.some((kind) =>
      free.some((item) => entities[kind].topics?.includes(words[item.index]!)),
    )
      ? TOPIC_SCORE
      : 0;
    const evidenceScore = assignment.textScore + affinity + hint + topic;
    return {
      combination,
      assignment,
      evidenceScore,
      evidenceCount:
        assignment.matchedWords + (affinity > 0 ? 1 : 0) + (hint > 0 ? 1 : 0) + (topic > 0 ? 1 : 0),
      namesTarget: assignment.namesTarget || affinity >= AFFINITY_NAMES_TARGET,
      score:
        TEXT_WEIGHT * evidenceScore +
        HISTORY_WEIGHT * historyScore(combination.key, history, now),
    };
  });

  const anyMatch = ranked.some((item) => item.evidenceCount > 0);
  const candidates = ranked
    .filter((item) => !anyMatch || item.evidenceCount > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.combination.key.localeCompare(b.combination.key),
    );

  const suggestions: QuickSuggestion[] = candidates
    .slice(0, MAX_SUGGESTIONS)
    .map(({ combination, assignment, score, namesTarget }) => ({
      combination,
      note: formatNote(assignment.note, words, tokens, spoken?.noteLead ?? ""),
      score,
      textScore: assignment.textScore,
      matchedWords: assignment.matchedWords,
      namesTarget,
      words: assignment.words,
    }));

  const [first, second] = candidates;
  let confidence = 0;
  if (first && first.evidenceCount > 0) {
    const quality = first.evidenceScore / first.evidenceCount;
    const lead = second ? (first.score - second.score) / first.score : 1;
    const clarity = Math.min(1, lead / CLEAR_LEAD);
    confidence = quality * (0.5 + 0.5 * clarity) * (first.namesTarget ? 1 : 0.7);
  }

  return {
    command: null,
    time,
    day: dated.day,
    timePhrase: [...dated.phrase.map((word) => word.replace(/[,;:!?]+$/, "")), ...phrase].join(
      " ",
    ),
    suggestions,
    confidence,
    // A spoken sentence starts by itself only when it names the customer or
    // the project. What past notes suggest ranks the list, no more.
    // A customer that was only heard alike starts by itself when no other
    // customer comes into question for these words.
    autoSelect:
      confidence >= AUTO_SELECT_CONFIDENCE &&
      (!spoken || !!first?.assignment.namesTarget) &&
      (!first?.assignment.bySound ||
        !candidates.some(
          (other) =>
            other.combination.customerId !== first.combination.customerId &&
            other.assignment.namesTarget,
        )),
  };
}

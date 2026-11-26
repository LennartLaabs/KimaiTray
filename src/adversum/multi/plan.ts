import { sameDay } from "../quickEntry/dateParser";
import { DEFAULT_BEGIN_HOUR } from "../quickEntry/timeParser";
import { VAGUE_MINUTES } from "./segment";
import type { Amount, Relation } from "./types";

/**
 * All arithmetic of multi-entry input: how long each activity was and where
 * it lies on the clock. Pure, so every rule is tested.
 *
 * - Without anything else said, the activities end now and begin the sum of
 *   their durations earlier. "Die letzten 3 Stunden" and explicit times
 *   ("von 9 bis 12") take precedence.
 * - "dazwischen" interrupts the activity before it: that one is split
 *   around the interruption and the total stays (unless `additional`), or it
 *   stays in one piece with the interruption after it (`merge`).
 * - "vorher" moves an activity in front of the one before it; "der Rest" is
 *   what remains of the window.
 * - Existing entries are never overlapped: the plan flows around them.
 */

const MINUTE = 60_000;

/** A stretch of time in milliseconds. */
export interface Interval {
  begin: number;
  end: number;
}

export interface PlanItem {
  id: number;
  amount: Amount;
  relation: Relation;
}

/** How the user changed the reading of one activity. */
export interface PlanChoice {
  /** The interruption comes on top instead of out of the interrupted time. */
  additional?: boolean;
  /** The interrupted activity stays one block, the interruption follows. */
  merge?: boolean;
  /** Answer to "how often?". */
  count?: number;
  /** Answer to "how long?" (each time, for counted activities). */
  minutes?: number;
}

export interface PlanInput {
  items: readonly PlanItem[];
  windowMinutes: number | null;
  day: Date | null;
  now: Date;
  /** Existing entries the plan must not overlap. */
  busy: readonly Interval[];
  choices: Readonly<Record<number, PlanChoice>>;
}

export interface PlanBlock {
  item: number;
  begin: Date;
  end: Date;
}

export type PlanNoteCode =
  /** "kurz" or "ein paar Minuten" was taken as five minutes. */
  | "vague"
  /** The interruption is as long as the activity; it comes on top. */
  | "forcedAdditional"
  /** Moved or split because of an existing entry. */
  | "busy"
  | "future"
  /** Nothing remains for "der Rest". */
  | "noRest"
  /** The activities are longer than the window they should lie in. */
  | "overWindow"
  /** Another day without a clock time: starts at nine. */
  | "defaultStart";

export interface PlanNote {
  /** The activity it is about; `null` for the plan as a whole. */
  item: number | null;
  code: PlanNoteCode;
}

export type QuestionKind = "count" | "each" | "duration" | "rest";

export interface PlanQuestion {
  item: number;
  kind: QuestionKind;
}

export interface Plan {
  blocks: PlanBlock[];
  notes: PlanNote[];
  /** What has to be asked before an activity can be placed. */
  questions: PlanQuestion[];
}

interface Resolved {
  /** `null`: cannot be placed yet, or is "der Rest". */
  minutes: number | null;
  question?: QuestionKind;
  vague?: boolean;
}

/** How long an activity was, from what was said and what was answered. */
export function resolveMinutes(amount: Amount, choice: PlanChoice = {}): Resolved {
  const positive = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
  const answered = positive(choice.minutes);
  switch (amount.kind) {
    case "minutes":
      return { minutes: answered ?? amount.minutes, vague: !!amount.vague && !answered };
    case "times": {
      const count = positive(choice.count) ?? amount.count;
      const each = answered ?? amount.each;
      if (count === null) return { minutes: null, question: "count" };
      if (each === null) return { minutes: null, question: "each" };
      return { minutes: count * each, vague: !!amount.vague && !answered };
    }
    case "span":
      return { minutes: Math.round((amount.end.getTime() - amount.begin.getTime()) / MINUTE) };
    case "rest":
      return { minutes: answered ?? null };
    case "unknown":
      return answered ? { minutes: answered } : { minutes: null, question: "duration" };
  }
}

/** Sorted, merged and on whole minutes. */
function normalizeBusy(busy: readonly Interval[]): Interval[] {
  const sorted = busy
    .map(({ begin, end }) => ({
      begin: Math.floor(begin / MINUTE) * MINUTE,
      end: Math.ceil(end / MINUTE) * MINUTE,
    }))
    .filter((interval) => interval.end > interval.begin)
    .sort((a, b) => a.begin - b.begin);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.begin <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Minutes of `[begin, end)` that existing entries take. */
function busyMinutes(busy: readonly Interval[], begin: number, end: number): number {
  let total = 0;
  for (const interval of busy) {
    total += Math.max(0, Math.min(end, interval.end) - Math.max(begin, interval.begin));
  }
  return total / MINUTE;
}

/** Lays `minutes` of free time forward from `cursor`, around existing entries. */
function placeForward(
  busy: readonly Interval[],
  cursor: number,
  minutes: number,
): { parts: Interval[]; cursor: number } {
  const parts: Interval[] = [];
  let remaining = minutes * MINUTE;
  while (remaining > 0) {
    const inside = busy.find((interval) => interval.begin <= cursor && cursor < interval.end);
    if (inside) {
      cursor = inside.end;
      continue;
    }
    const next = busy.find((interval) => interval.begin > cursor);
    const end = Math.min(cursor + remaining, next?.begin ?? Infinity);
    parts.push({ begin: cursor, end });
    remaining -= end - cursor;
    cursor = end;
  }
  return { parts, cursor };
}

/** Where `minutes` of free time that end at `end` begin. */
function startFor(busy: readonly Interval[], end: number, minutes: number): number {
  let cursor = end;
  let remaining = minutes * MINUTE;
  while (remaining > 0) {
    const inside = busy.find((interval) => interval.begin < cursor && cursor <= interval.end);
    if (inside) {
      cursor = inside.begin;
      continue;
    }
    const previous = [...busy].reverse().find((interval) => interval.end <= cursor);
    const begin = Math.max(cursor - remaining, previous?.end ?? -Infinity);
    remaining -= cursor - begin;
    cursor = begin;
  }
  return cursor;
}

/** One activity with what interrupted it. */
interface Element {
  host: PlanItem;
  inside: PlanItem[];
}

interface Laid {
  element: Element;
  /** Fixed begin for "von 9 bis 12". */
  anchor: number | null;
  /** The pieces in order, each a number of minutes of one activity. */
  pieces: { item: number; minutes: number }[];
  total: number;
}

/** The pieces of an activity of `hostMinutes` and its interruptions. */
function pieces(
  element: Element,
  hostMinutes: number,
  inside: readonly { item: number; minutes: number }[],
  merge: boolean,
): Laid["pieces"] {
  const host = element.host.id;
  if (merge || inside.length === 0) {
    return [{ item: host, minutes: hostMinutes }, ...inside].filter((piece) => piece.minutes > 0);
  }
  const parts = inside.length + 1;
  const base = Math.floor(hostMinutes / parts);
  const extra = hostMinutes % parts;
  const result: Laid["pieces"] = [];
  for (let index = 0; index < parts; index++) {
    result.push({ item: host, minutes: base + (index < extra ? 1 : 0) });
    if (index < inside.length) result.push(inside[index]!);
  }
  return result.filter((piece) => piece.minutes > 0);
}

/** The order on the clock: "vorher" steps in front, "dazwischen" goes inside. */
function group(items: readonly PlanItem[]): Element[] {
  const elements: Element[] = [];
  for (const item of items) {
    const last = elements[elements.length - 1];
    if (item.relation === "within" && last) last.inside.push(item);
    else if (item.relation === "before" && last) {
      elements.splice(elements.length - 1, 0, { host: item, inside: [] });
    } else elements.push({ host: item, inside: [] });
  }
  return elements;
}

/** The activities that something interrupted: these can be split or kept whole. */
export function interruptedItems(items: readonly PlanItem[]): Set<number> {
  return new Set(
    group(items)
      .filter((element) => element.inside.length > 0 && element.host.amount.kind !== "span")
      .map((element) => element.host.id),
  );
}

/** Puts the activities on the clock. */
export function planEntries(input: PlanInput): Plan {
  const { items, choices, windowMinutes } = input;
  const now = Math.floor(input.now.getTime() / MINUTE) * MINUTE;
  const busy = normalizeBusy(input.busy);
  const notes: PlanNote[] = [];
  const questions: PlanQuestion[] = [];
  const note = (item: number | null, code: PlanNoteCode) => {
    if (!notes.some((existing) => existing.item === item && existing.code === code)) {
      notes.push({ item, code });
    }
  };

  const elements = group(items);

  const minutesOf = (item: PlanItem): number | null => {
    const resolved = resolveMinutes(item.amount, choices[item.id]);
    if (resolved.question) questions.push({ item: item.id, kind: resolved.question });
    if (resolved.vague) note(item.id, "vague");
    return resolved.minutes;
  };

  // Everything but "der Rest" first; the rest is what they leave over.
  const lay = (element: Element, hostMinutes: number, anchor: number | null): Laid => {
    const { host } = element;
    const choice = choices[host.id] ?? {};
    const inside = element.inside
      .map((item) => ({ item: item.id, minutes: minutesOf(item) }))
      .filter((piece): piece is { item: number; minutes: number } => piece.minutes !== null);
    const interruption = inside.reduce((sum, piece) => sum + piece.minutes, 0);
    const fixed = anchor !== null;
    let additional = !fixed && !!choice.additional;
    if (!additional && interruption > 0 && hostMinutes - interruption < 1) {
      note(host.id, fixed ? "overWindow" : "forcedAdditional");
      if (fixed) return { element, anchor, pieces: pieces(element, hostMinutes, [], true), total: hostMinutes };
      additional = true;
    }
    const own = additional ? hostMinutes : hostMinutes - interruption;
    return {
      element,
      anchor,
      pieces: pieces(element, own, inside, !!choice.merge),
      total: own + interruption,
    };
  };

  // "Die letzte Stunde DUSW Design, zwischendurch kurz K&K": with a window
  // and no "Rest", the one activity without an amount is what fills it.
  const open = elements.filter(
    ({ host }) => host.amount.kind === "unknown" && choices[host.id]?.minutes === undefined,
  );
  const fills =
    windowMinutes !== null &&
    open.length === 1 &&
    !elements.some(({ host }) => host.amount.kind === "rest")
      ? open[0]!.host.id
      : null;

  const laid: (Laid | { element: Element; rest: true } | null)[] = elements.map((element) => {
    const { host } = element;
    const isRest = host.amount.kind === "rest" || host.id === fills;
    if (isRest && choices[host.id]?.minutes === undefined) {
      return { element, rest: true as const };
    }
    const minutes = minutesOf(host);
    if (minutes === null) return null;
    if (host.amount.kind !== "span") return lay(element, minutes, null);
    const begin = host.amount.begin.getTime();
    const free = minutes - busyMinutes(busy, begin, host.amount.end.getTime());
    if (free < minutes) note(host.id, "busy");
    return lay(element, Math.max(0, Math.round(free)), begin);
  });

  const otherDay = input.day && !sameDay(input.day, input.now) ? input.day : null;
  const dayStart = otherDay
    ? new Date(
        otherDay.getFullYear(),
        otherDay.getMonth(),
        otherDay.getDate(),
        DEFAULT_BEGIN_HOUR,
      ).getTime()
    : null;
  const windowEnd = dayStart !== null && windowMinutes !== null ? dayStart + windowMinutes * MINUTE : now;
  const windowBegin = windowMinutes === null ? null : windowEnd - windowMinutes * MINUTE;
  const known = laid.reduce((sum, entry) => sum + (entry && "total" in entry ? entry.total : 0), 0);

  // "Der Rest" needs a window to be the rest of.
  const complete: Laid[] = [];
  for (const entry of laid) {
    if (!entry) continue;
    if ("total" in entry) {
      complete.push(entry);
      continue;
    }
    const { host } = entry.element;
    if (windowBegin === null) {
      questions.push({ item: host.id, kind: "rest" });
      continue;
    }
    const free = windowMinutes! - busyMinutes(busy, windowBegin, windowEnd);
    const rest = Math.round(free - known);
    if (rest < 1) note(host.id, "noRest");
    else complete.push(lay(entry.element, rest, null));
  }

  const total = complete.reduce((sum, entry) => sum + entry.total, 0);
  const anchorIndex = complete.findIndex((entry) => entry.anchor !== null);
  let cursor: number;
  if (anchorIndex >= 0) {
    const before = complete.slice(0, anchorIndex).reduce((sum, entry) => sum + entry.total, 0);
    cursor = startFor(busy, complete[anchorIndex]!.anchor!, before);
  } else if (windowBegin !== null) {
    cursor = windowBegin;
    const free = windowMinutes! - busyMinutes(busy, windowBegin, windowEnd);
    if (total > free) note(null, "overWindow");
  } else if (dayStart !== null) {
    cursor = dayStart;
    note(null, "defaultStart");
  } else {
    cursor = startFor(busy, now, total);
  }

  const blocks: PlanBlock[] = [];
  for (const entry of complete) {
    if (entry.anchor !== null) cursor = Math.max(cursor, entry.anchor);
    for (const piece of entry.pieces) {
      const expected = cursor;
      const placed = placeForward(busy, cursor, piece.minutes);
      if (placed.parts.length > 1 || placed.parts[0]!.begin !== expected) note(piece.item, "busy");
      for (const part of placed.parts) {
        blocks.push({ item: piece.item, begin: new Date(part.begin), end: new Date(part.end) });
        if (part.end > now) note(piece.item, "future");
      }
      cursor = placed.cursor;
    }
  }
  return { blocks, notes, questions };
}

export { VAGUE_MINUTES };

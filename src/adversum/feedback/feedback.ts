import { invoke } from "@tauri-apps/api/core";
import type { QuickAction } from "../quickEntry/actions";
import type { QuickCatalog } from "../quickEntry/catalog";
import type { QuickParseResult } from "../quickEntry/parse";
import type { TimeSpec } from "../quickEntry/timeParser";

/**
 * "Falsch verstanden": keeps a sentence the app read wrongly, with what it
 * made of it and what the user made of it instead. One JSON line per click,
 * in a local file (`src-tauri/src/adversum/feedback.rs`). Nothing is sent
 * anywhere; the file is read when the rules are improved.
 */

/** One entry, written so that a person can read it in the file. */
export interface DescribedEntry {
  /** "Kunde · Projekt · Aktivität", or "?" when the task is not known. */
  task: string;
  note: string;
  /** Local date and time, "2026-11-26T13:20"; empty for "now". */
  begin: string;
  /** Empty for a timer that keeps running. */
  end: string;
}

export interface MisunderstoodRecord {
  /** When the button was pressed, as ISO time. */
  time: string;
  /** The sentence as it was heard or typed. */
  sentence: string;
  source: "voice" | "typed";
  /** What the app understood. */
  recognized: unknown;
  /** What the user entered instead; `null` when they gave up. */
  corrected: unknown;
}

/** Appends the record to the feedback file and returns the file's path. */
export function saveMisunderstood(record: MisunderstoodRecord): Promise<string> {
  return invoke("adversum_feedback_append", { record });
}

/** "2026-11-26T13:20" in local time. */
export function localMinute(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function describeTime(time: TimeSpec): { begin: string; end: string; time?: string } {
  if (time.kind === "range") return { begin: localMinute(time.begin), end: localMinute(time.end) };
  if (time.kind === "start") return { begin: localMinute(time.begin), end: "" };
  return { begin: "", end: "", ...(time.kind === "none" ? {} : { time: time.kind }) };
}

/** What the confirmation card showed for a sentence that is one entry. */
export function describeReading(result: QuickParseResult): unknown {
  const label = ({ combination }: QuickParseResult["suggestions"][number]) =>
    `${combination.customer} · ${combination.project} · ${combination.activity}`;
  const [first, ...others] = result.suggestions;
  return {
    task: first ? label(first) : "?",
    note: first?.note ?? "",
    ...describeTime(result.time),
    startsByItself: result.autoSelect,
    alsoOffered: others.map(label),
  };
}

/** What the user did instead, from the action that was sent. */
export function describeAction(action: QuickAction, catalog: QuickCatalog): unknown {
  const task = (projectId: number, activityId: number) => {
    const found = catalog.combinations.find(
      (item) => item.projectId === projectId && item.activityId === activityId,
    );
    return found ? `${found.customer} · ${found.project} · ${found.activity}` : "?";
  };
  switch (action.type) {
    case "start":
      return {
        task: task(action.projectId, action.activityId),
        note: action.description,
        begin: action.begin?.slice(0, 16) ?? "",
        end: "",
      };
    case "log":
      return {
        task: task(action.projectId, action.activityId),
        note: action.description,
        begin: action.begin.slice(0, 16),
        end: action.end.slice(0, 16),
      };
    case "batch":
      return action.entries.map(
        (entry): DescribedEntry => ({
          task: task(entry.projectId, entry.activityId),
          note: entry.description,
          begin: entry.begin.slice(0, 16),
          end: entry.end.slice(0, 16),
        }),
      );
    case "command":
      return { command: action.command };
    case "note":
      return { noteForRunningTimer: action.text };
  }
}

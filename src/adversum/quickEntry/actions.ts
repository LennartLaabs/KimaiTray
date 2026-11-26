import { toKimaiLocal } from "../../utils/time";
import type { QuickCommand } from "./commands";
import type { QuickSuggestion } from "./parse";
import type { TimeSpec } from "./timeParser";

/**
 * "switch" replaces the running timer. "interrupt" pauses it, and it resumes
 * by itself when the new task is stopped.
 */
export type QuickStartMode = "switch" | "interrupt";

/** What the pending-timer card shows while the start is in flight. */
export interface QuickPreview {
  projectId: number;
  project: string;
  activity: string;
  projectColor: string;
  activityColor: string;
  customerColor: string;
  description?: string;
}

/** Something the quick entry bar asks the tray window to do. */
export type QuickAction =
  | {
      type: "start";
      mode: QuickStartMode;
      projectId: number;
      activityId: number;
      description: string;
      /** Kimai local time for a start in the past; `null` starts now. */
      begin: string | null;
      /** "Customer · Activity", for the confirmation. */
      label: string;
      preview: QuickPreview;
    }
  | {
      type: "log";
      projectId: number;
      activityId: number;
      description: string;
      begin: string;
      end: string;
      label: string;
    }
  | { type: "command"; command: QuickCommand };

/** The action that starts (or logs) a suggestion with the recognized time. */
export function actionForSuggestion(
  suggestion: QuickSuggestion,
  time: TimeSpec,
  mode: QuickStartMode,
): QuickAction {
  const { combination, note } = suggestion;
  const label = `${combination.customer} · ${combination.activity}`;
  const target = {
    projectId: combination.projectId,
    activityId: combination.activityId,
    description: note,
    label,
  };
  if (time.kind === "range") {
    return {
      type: "log",
      ...target,
      begin: toKimaiLocal(time.begin),
      end: toKimaiLocal(time.end),
    };
  }
  return {
    type: "start",
    mode,
    ...target,
    begin: time.kind === "start" ? toKimaiLocal(time.begin) : null,
    preview: {
      projectId: combination.projectId,
      project: combination.project,
      activity: combination.activity,
      projectColor: "",
      activityColor: combination.activityColor,
      customerColor: combination.customerColor,
      ...(note ? { description: note } : {}),
    },
  };
}

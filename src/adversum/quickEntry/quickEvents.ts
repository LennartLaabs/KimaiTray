import type { QuickAction } from "./actions";

/** Tauri label of the floating quick entry window. */
export const QUICK_WINDOW_LABEL = "adversum-quick";
/** The tray window owns all timer operations and executes quick actions. */
export const TRAY_WINDOW_LABEL = "tray-popup";

/** Native side → quick window: the bar was just shown. */
export const QUICK_SHOWN_EVENT = "adversum://quick-shown";
/** Any window → tray window: run this action. */
export const QUICK_EXECUTE_EVENT = "adversum://quick-execute";
/** Tray window → quick window: outcome of the last action. */
export const QUICK_TOAST_EVENT = "adversum://quick-toast";
/** Any window → tray window: undo the action behind this toast. */
export const QUICK_UNDO_EVENT = "adversum://quick-undo";
/** Native side (Cmd+Z while a toast offers it) → tray window: undo the latest action. */
export const QUICK_UNDO_LATEST_EVENT = "adversum://quick-undo-latest";
/** Native side → tray window: the "previous task" shortcut was pressed. */
export const PREVIOUS_TASK_EVENT = "adversum://previous-task";

export interface QuickExecuteRequest {
  action: QuickAction;
}

export type QuickToastKind =
  | "started"
  | "logged"
  | "stopped"
  | "paused"
  | "resumed"
  | "undone"
  | "nothing"
  | "failed";

/** A short confirmation shown after an action. */
export interface QuickToastData {
  id: number;
  kind: QuickToastKind;
  /** "Customer · Activity"; empty for outcomes without a task. */
  label: string;
  /** Whether "Undo" is offered. */
  undoable: boolean;
}

export interface QuickUndoRequest {
  id: number;
}

/** How long a confirmation stays, and with it the chance to undo. */
export const TOAST_DURATION_MS = 5000;

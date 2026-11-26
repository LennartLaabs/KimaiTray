import type { ContextMenuEntry } from "../../components/contextMenu";

/** A task from the popup's lists, as far as "start in between" needs it. */
export interface BridgeTask {
  projectId: number;
  activityId: number;
  project: string;
  activity: string;
  customer: string;
  description: string;
  projectColor: string;
  activityColor: string;
  customerColor: string;
}

interface PopupQuickHandlers {
  /** Puts typed text into the quick entry bar and focuses it. */
  focus: (text: string) => void;
  /** Starts the task in between: pauses the running timer first. */
  startInterrupt: (task: BridgeTask) => void;
}

/**
 * Connection between upstream popup code and the fork's quick entry layer,
 * which is a sibling component rather than a parent. Empty (and inert) until
 * `AdversumPopupQuick` mounts, which it only does in the running app.
 */
let handlers: PopupQuickHandlers | null = null;

export function registerPopupQuick(next: PopupQuickHandlers | null): void {
  handlers = next;
}

/**
 * Wraps the popup's "typing starts a filter" handler: typed text goes to the
 * quick entry bar when it is present, and to upstream's filter otherwise.
 */
export function typingToQuickEntry(
  upstreamFilter: (text: string) => void,
): (text: string) => void {
  return (text) => {
    if (handlers) handlers.focus(text);
    else upstreamFilter(text);
  };
}

/** The "start in between" entry for a task's context menu, when available. */
export function interruptMenuEntries(
  task: BridgeTask,
  label: string,
  disabled: boolean | undefined,
): ContextMenuEntry[] {
  const current = handlers;
  if (!current) return [];
  return [{ text: label, enabled: !disabled, action: () => current.startInterrupt(task) }];
}

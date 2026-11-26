/**
 * Remembers which running entry is an "in between" task and which paused
 * timer it interrupted, so the paused one can resume when the task stops.
 * Kept in `localStorage` of the tray window, per connection.
 */
export interface InterruptLink {
  /** Kimai id of the "in between" entry. */
  timesheetId: number;
  /** Id of the paused timer (`PausedTimerData.id`) waiting behind it. */
  pausedId: string;
}

function storageKey(connectionId: string): string {
  return `adversum:interrupt:${connectionId}`;
}

export function loadInterruptLink(connectionId: string): InterruptLink | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(connectionId)) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      Number.isInteger((value as InterruptLink).timesheetId) &&
      typeof (value as InterruptLink).pausedId === "string"
    ) {
      const { timesheetId, pausedId } = value as InterruptLink;
      return { timesheetId, pausedId };
    }
  } catch {
    // Unreadable storage means no link.
  }
  return null;
}

export function saveInterruptLink(connectionId: string, link: InterruptLink | null): void {
  try {
    if (link) localStorage.setItem(storageKey(connectionId), JSON.stringify(link));
    else localStorage.removeItem(storageKey(connectionId));
  } catch {
    // Without storage the link only lives for this session.
  }
}

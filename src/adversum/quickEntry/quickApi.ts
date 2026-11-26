import { invoke } from "@tauri-apps/api/core";
import type { KimaiClient } from "../../api/kimaiClient";
import { extractId, type KimaiTimesheetEntry } from "../../api/kimaiTypes";
import { isKimaiTimesheet } from "../../api/kimaiValidation";
import { getTimesheets, restartTimesheet } from "../../api/timesheetApi";
import { parseKimaiDate, toKimaiLocal } from "../../utils/time";
import { HISTORY_DAYS, type HistoryEntry } from "./history";

const HISTORY_PAGE_SIZE = 500;
const HISTORY_MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Quick entry window ─────────────────────────────────────────

export function hideQuickWindow(): Promise<void> {
  return invoke("adversum_quick_hide");
}

/**
 * Shows the window as the confirmation toast at the bottom center of the
 * screen, without taking the keyboard. While `undoable`, the native side holds
 * Cmd+Z as a global shortcut for undoing the action.
 */
export function showQuickToast(undoable: boolean): Promise<void> {
  return invoke("adversum_quick_toast", { undoable });
}

export function resizeQuickWindow(height: number): Promise<void> {
  return invoke("adversum_quick_resize", { height });
}

// ── Kimai ──────────────────────────────────────────────────────

/**
 * The user's entries of the last 90 days, newest first. Kimai pages this
 * list; a request for a page past the end fails, which ends the loop.
 */
export async function fetchHistory(client: KimaiClient, now: Date): Promise<HistoryEntry[]> {
  const first = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  first.setHours(0, 0, 0, 0);
  const begin = toKimaiLocal(first);
  const entries: HistoryEntry[] = [];
  for (let page = 1; page <= HISTORY_MAX_PAGES; page++) {
    let batch: KimaiTimesheetEntry[];
    try {
      batch = await getTimesheets(client, {
        begin,
        size: HISTORY_PAGE_SIZE,
        page,
        orderBy: "begin",
        order: "DESC",
      });
    } catch (error) {
      if (page === 1) throw error;
      break;
    }
    for (const entry of batch) {
      entries.push({
        projectId: extractId(entry.project),
        activityId: extractId(entry.activity),
        begin: parseKimaiDate(entry.begin),
        description: entry.description,
      });
    }
    if (batch.length < HISTORY_PAGE_SIZE) break;
  }
  return entries;
}

interface FinishedEntry {
  projectId: number;
  activityId: number;
  description: string;
  begin: string;
  end: string;
}

/** Creates an entry that already has an end; no timer is started or stopped. */
export async function createFinishedEntry(
  client: KimaiClient,
  entry: FinishedEntry,
): Promise<KimaiTimesheetEntry> {
  const created = await client.post<unknown>("/api/timesheets", {
    project: entry.projectId,
    activity: entry.activityId,
    begin: entry.begin,
    end: entry.end,
    ...(entry.description ? { description: entry.description } : {}),
  });
  if (!isKimaiTimesheet(created)) throw new Error("Kimai returned an invalid time entry");
  return created;
}

/**
 * Starts a running entry with a begin in the past, without stopping others:
 * it brings back a timer that a batch of entries had replaced.
 */
export async function createRunningEntry(
  client: KimaiClient,
  entry: Omit<FinishedEntry, "end">,
): Promise<KimaiTimesheetEntry> {
  const created = await client.post<unknown>("/api/timesheets", {
    project: entry.projectId,
    activity: entry.activityId,
    begin: entry.begin,
    ...(entry.description ? { description: entry.description } : {}),
  });
  if (!isKimaiTimesheet(created)) throw new Error("Kimai returned an invalid time entry");
  return created;
}

/**
 * Lets a stopped entry run again, for "undo". First choice is to clear the
 * entry's end, so it continues as if it had never been stopped. Where Kimai
 * does not accept that, the entry is restarted as a new one, the way
 * upstream resumes timers.
 */
export async function reopenTimesheet(
  client: KimaiClient,
  id: number,
): Promise<KimaiTimesheetEntry> {
  try {
    const reopened = await client.patch<unknown>(`/api/timesheets/${id}`, { end: null });
    if (isKimaiTimesheet(reopened) && reopened.end === null) return reopened;
  } catch {
    // Fall back to a restart below.
  }
  return restartTimesheet(client, id);
}

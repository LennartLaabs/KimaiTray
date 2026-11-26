import { useQuery } from "@tanstack/react-query";
import type { KimaiClient } from "../../api/kimaiClient";
import { extractId, type KimaiTimesheetEntry } from "../../api/kimaiTypes";
import { getTimesheets } from "../../api/timesheetApi";
import { parseKimaiDate, toKimaiLocal } from "../../utils/time";
import type { Interval } from "./plan";

/** The timer that runs while several entries are entered. */
export interface RunningEntry {
  id: number;
  projectId: number;
  activityId: number;
  description: string;
  begin: Date;
}

export interface DayEntries {
  /** Finished entries of the day; new ones must not overlap them. */
  busy: Interval[];
  running: RunningEntry | null;
  /** The entries are known (or could not be loaded, then both are empty). */
  ready: boolean;
}

const EMPTY: Omit<DayEntries, "ready"> = { busy: [], running: null };
const PAGE_SIZE = 200;

/** Sorts a day's entries into finished ones and the running timer. */
export function sortEntries(entries: readonly KimaiTimesheetEntry[]): Omit<DayEntries, "ready"> {
  const busy: Interval[] = [];
  let running: RunningEntry | null = null;
  for (const entry of entries) {
    const begin = parseKimaiDate(entry.begin);
    if (entry.end) {
      busy.push({ begin: begin.getTime(), end: parseKimaiDate(entry.end).getTime() });
    } else if (!running || begin.getTime() > running.begin.getTime()) {
      running = {
        id: entry.id,
        projectId: extractId(entry.project),
        activityId: extractId(entry.activity),
        description: entry.description ?? "",
        begin,
      };
    }
  }
  return { busy, running };
}

/**
 * The user's entries of one day, fresh from Kimai every time a review opens:
 * what is already booked there decides where new entries can go.
 */
export function useDayEntries(client: KimaiClient | null, day: Date): DayEntries {
  const begin = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59);
  const query = useQuery({
    queryKey: ["adversum-day", client?.cacheScope, toKimaiLocal(begin)],
    queryFn: async () =>
      sortEntries(
        await getTimesheets(client!, {
          begin: toKimaiLocal(begin),
          end: toKimaiLocal(end),
          size: PAGE_SIZE,
        }),
      ),
    enabled: !!client,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });
  return { ...(query.data ?? EMPTY), ready: !client || query.isSuccess || query.isError };
}

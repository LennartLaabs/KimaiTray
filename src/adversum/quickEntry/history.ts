import { combinationKey } from "./catalog";

/** One past time entry, reduced to what the ranking needs. */
export interface HistoryEntry {
  projectId: number;
  activityId: number;
  begin: Date;
}

interface CombinationStats {
  count: number;
  /** Begin of the most recent entry, in milliseconds. */
  lastUsed: number;
  /** Entries per hour of day (0–23). */
  hours: number[];
  /** Entries per weekday (0 = Sunday). */
  weekdays: number[];
}

export interface QuickHistory {
  stats: ReadonlyMap<string, CombinationStats>;
  /** Highest entry count of any combination; 0 without history. */
  maxCount: number;
}

export const HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_HALF_LIFE_DAYS = 10;
const FREQUENCY_WEIGHT = 0.5;
const RECENCY_WEIGHT = 0.3;
const PATTERN_WEIGHT = 0.2;

export const EMPTY_HISTORY: QuickHistory = { stats: new Map(), maxCount: 0 };

/** Counts the entries of the last `HISTORY_DAYS` days per combination. */
export function buildHistory(entries: readonly HistoryEntry[], now: Date): QuickHistory {
  const earliest = now.getTime() - HISTORY_DAYS * DAY_MS;
  const stats = new Map<string, CombinationStats>();
  let maxCount = 0;
  for (const entry of entries) {
    const begin = entry.begin.getTime();
    if (!Number.isFinite(begin) || begin < earliest || begin > now.getTime()) continue;
    const key = combinationKey(entry.projectId, entry.activityId);
    let item = stats.get(key);
    if (!item) {
      item = { count: 0, lastUsed: 0, hours: new Array<number>(24).fill(0), weekdays: new Array<number>(7).fill(0) };
      stats.set(key, item);
    }
    item.count += 1;
    item.lastUsed = Math.max(item.lastUsed, begin);
    item.hours[entry.begin.getHours()]! += 1;
    item.weekdays[entry.begin.getDay()]! += 1;
    maxCount = Math.max(maxCount, item.count);
  }
  return { stats, maxCount };
}

/**
 * How likely a combination is right now, from 0 to 1: how often it was used
 * in the last 90 days, how recently, and whether it usually happens around
 * this time of day and on this weekday.
 */
export function historyScore(key: string, history: QuickHistory, now: Date): number {
  const item = history.stats.get(key);
  if (!item) return 0;
  const frequency = Math.log1p(item.count) / Math.log1p(history.maxCount);
  const ageDays = Math.max(0, now.getTime() - item.lastUsed) / DAY_MS;
  const recency = 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
  const hour = now.getHours();
  const aroundNow =
    item.hours[(hour + 23) % 24]! + item.hours[hour]! + item.hours[(hour + 1) % 24]!;
  const pattern =
    0.6 * (aroundNow / item.count) + 0.4 * (item.weekdays[now.getDay()]! / item.count);
  return (
    FREQUENCY_WEIGHT * frequency + RECENCY_WEIGHT * recency + PATTERN_WEIGHT * pattern
  );
}

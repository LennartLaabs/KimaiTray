import { describe, expect, it } from "vitest";
import { buildHistory, EMPTY_HISTORY, HISTORY_DAYS, historyScore } from "./history";

/** Thursday 26 November 2026, 10:20. */
const now = new Date(2026, 10, 26, 10, 20);
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number, hour = 10): Date {
  const date = new Date(now.getTime() - days * DAY);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function entries(projectId: number, activityId: number, begins: Date[]) {
  return begins.map((begin) => ({ projectId, activityId, begin }));
}

describe("buildHistory", () => {
  it("counts entries of the last 90 days per combination", () => {
    const history = buildHistory(
      [
        ...entries(11, 1, [daysAgo(1), daysAgo(7), daysAgo(14, 15)]),
        ...entries(21, 2, [daysAgo(2)]),
        ...entries(11, 1, [daysAgo(HISTORY_DAYS + 1)]),
        ...entries(11, 1, [new Date(now.getTime() + DAY), new Date("invalid")]),
      ],
      now,
    );
    expect(history.maxCount).toBe(3);
    const stats = history.stats.get("11-1")!;
    expect(stats.count).toBe(3);
    expect(stats.lastUsed).toBe(daysAgo(1).getTime());
    expect(stats.hours[10]).toBe(2);
    expect(stats.hours[15]).toBe(1);
    expect(stats.weekdays[3]).toBe(1);
    expect(stats.weekdays[4]).toBe(2);
    expect(history.stats.get("21-2")?.count).toBe(1);
    expect(buildHistory([], now)).toEqual(EMPTY_HISTORY);
  });
});

describe("historyScore", () => {
  it("is zero for a combination that was never used", () => {
    expect(historyScore("1-1", EMPTY_HISTORY, now)).toBe(0);
  });

  it("prefers frequent, recent and habitual combinations", () => {
    const history = buildHistory(
      [
        ...entries(1, 1, Array.from({ length: 20 }, (_, index) => daysAgo(index + 1))),
        ...entries(2, 1, [daysAgo(1), daysAgo(2)]),
        ...entries(3, 1, Array.from({ length: 20 }, (_, index) => daysAgo(index + 60))),
        ...entries(4, 1, Array.from({ length: 20 }, (_, index) => daysAgo(index + 1, 16))),
      ],
      now,
    );
    const frequent = historyScore("1-1", history, now);
    const rare = historyScore("2-1", history, now);
    const stale = historyScore("3-1", history, now);
    const afternoon = historyScore("4-1", history, now);
    expect(frequent).toBeGreaterThan(rare);
    expect(frequent).toBeGreaterThan(stale);
    expect(frequent).toBeGreaterThan(afternoon);
    expect(frequent).toBeLessThanOrEqual(1);
    expect(stale).toBeGreaterThan(0);
    // The same combination scores higher at the time of day it usually runs.
    const atFour = new Date(2026, 10, 26, 16, 5);
    expect(historyScore("4-1", history, atFour)).toBeGreaterThan(afternoon);
    // Hours wrap around midnight.
    const midnight = buildHistory(entries(5, 1, [daysAgo(1, 23)]), now);
    expect(historyScore("5-1", midnight, new Date(2026, 10, 26, 0, 10))).toBeGreaterThan(
      historyScore("5-1", midnight, new Date(2026, 10, 26, 3, 0)),
    );
  });
});

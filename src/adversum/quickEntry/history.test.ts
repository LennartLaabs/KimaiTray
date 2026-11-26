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

  it("remembers which words of past notes went with which combination", () => {
    const history = buildHistory(
      [
        { projectId: 11, activityId: 2, begin: daysAgo(1), description: "Gigi Call" },
        { projectId: 11, activityId: 2, begin: daysAgo(2), description: "Call mit Gigi, Gigi krank" },
        { projectId: 21, activityId: 6, begin: daysAgo(3), description: "Call zu Q3" },
        { projectId: 21, activityId: 6, begin: daysAgo(4), description: null },
        { projectId: 21, activityId: 6, begin: daysAgo(HISTORY_DAYS + 5), description: "Uralt" },
      ],
      now,
    );
    // Once per entry, however often the word occurs in its note.
    expect(history.notes.get("gigi")).toEqual(new Map([["11-2", 2]]));
    expect(history.notes.get("call")).toEqual(
      new Map([
        ["11-2", 2],
        ["21-6", 1],
      ]),
    );
    expect(history.notes.get("mit")).toEqual(new Map([["11-2", 1]]));
    // Too short to say anything, or too old.
    expect(history.notes.has("q3")).toBe(false);
    expect(history.notes.has("zu")).toBe(false);
    expect(history.notes.has("uralt")).toBe(false);
    // Recurring capitalized words, most frequent first, then by alphabet.
    expect(history.noteNames).toEqual(["Call", "Gigi"]);
  });

  it("keeps at most forty recurring names", () => {
    const begin = daysAgo(1);
    const entries = Array.from({ length: 45 }, (_, index) => `Name${index}`).flatMap(
      (name) => [1, 2].map(() => ({ projectId: 1, activityId: 1, begin, description: name })),
    );
    expect(buildHistory(entries, now).noteNames).toHaveLength(40);
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

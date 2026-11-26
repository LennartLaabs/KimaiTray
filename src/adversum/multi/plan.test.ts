import { describe, expect, it } from "vitest";
import { clockText } from "./format";
import { interruptedItems, planEntries, resolveMinutes, type Interval, type PlanInput } from "./plan";
import type { Amount, Relation } from "./types";

/** Thursday 26 November 2026, 14:20 and a few seconds. */
const now = new Date(2026, 10, 26, 14, 20, 12);
const at = (hour: number, minute = 0, date = 26) => new Date(2026, 10, date, hour, minute);
const busyAt = (from: [number, number], to: [number, number]): Interval => ({
  begin: at(...from).getTime(),
  end: at(...to).getTime(),
});
const minutes = (value: number): Amount => ({ kind: "minutes", minutes: value });
const item = (id: number, amount: Amount, relation: Relation = "none") => ({ id, amount, relation });

function plan(input: Partial<PlanInput> & Pick<PlanInput, "items">) {
  const result = planEntries({
    windowMinutes: null,
    day: null,
    now,
    busy: [],
    choices: {},
    ...input,
  });
  return {
    rows: result.blocks.map(
      (block) => `${block.item} ${clockText(block.begin)}–${clockText(block.end)}`,
    ),
    notes: result.notes.map((note) => `${note.item ?? "all"} ${note.code}`),
    questions: result.questions.map((question) => `${question.item} ${question.kind}`),
  };
}

describe("resolveMinutes", () => {
  it("takes what was said, and answers before that", () => {
    expect(resolveMinutes(minutes(60))).toEqual({ minutes: 60, vague: false });
    expect(resolveMinutes({ kind: "minutes", minutes: 5, vague: "kurz" })).toEqual({
      minutes: 5,
      vague: true,
    });
    expect(resolveMinutes({ kind: "minutes", minutes: 5, vague: "kurz" }, { minutes: 8 })).toEqual({
      minutes: 8,
      vague: false,
    });
    expect(resolveMinutes({ kind: "times", count: 8, each: 5, vague: "kurz" })).toEqual({
      minutes: 40,
      vague: true,
    });
    expect(resolveMinutes({ kind: "times", count: null, each: 7 })).toEqual({
      minutes: null,
      question: "count",
    });
    expect(resolveMinutes({ kind: "times", count: null, each: 7 }, { count: 3 })).toEqual({
      minutes: 21,
      vague: false,
    });
    expect(resolveMinutes({ kind: "times", count: 4, each: null })).toEqual({
      minutes: null,
      question: "each",
    });
    expect(resolveMinutes({ kind: "span", begin: at(9), end: at(10, 30) })).toEqual({ minutes: 90 });
    expect(resolveMinutes({ kind: "rest" })).toEqual({ minutes: null });
    expect(resolveMinutes({ kind: "rest" }, { minutes: 20 })).toEqual({ minutes: 20 });
    expect(resolveMinutes({ kind: "unknown" })).toEqual({ minutes: null, question: "duration" });
    expect(resolveMinutes({ kind: "unknown" }, { minutes: 15.4 })).toEqual({ minutes: 15 });
    // Nonsense answers count as none.
    expect(resolveMinutes({ kind: "unknown" }, { minutes: -3 }).question).toBe("duration");
    expect(resolveMinutes({ kind: "unknown" }, { minutes: Number.NaN }).question).toBe("duration");
  });
});

describe("planEntries", () => {
  it("ends now and never overlaps what is already booked", () => {
    // 60 minutes that end at 14:20, around an entry from 13:30 to 14:00.
    expect(
      plan({ items: [item(0, minutes(60))], busy: [busyAt([13, 30], [14, 0])] }),
    ).toEqual({
      rows: ["0 12:50–13:30", "0 14:00–14:20"],
      notes: ["0 busy"],
      questions: [],
    });
    // An entry that ends exactly now pushes everything before it, in one piece.
    expect(
      plan({ items: [item(0, minutes(30))], busy: [busyAt([14, 0], [14, 20])] }).rows,
    ).toEqual(["0 13:30–14:00"]);
    // Entries that touch or overlap each other count as one; an empty one not at all.
    expect(
      plan({
        items: [item(0, minutes(30))],
        busy: [
          busyAt([13, 50], [14, 10]),
          busyAt([14, 0], [14, 20]),
          busyAt([13, 0], [13, 0]),
          busyAt([13, 40], [13, 45]),
        ],
      }).rows,
    ).toEqual(["0 13:15–13:40", "0 13:45–13:50"]);
  });

  it("keeps time spans where they were said and flows around entries inside them", () => {
    expect(
      plan({
        items: [
          item(0, { kind: "span", begin: at(9), end: at(12) }),
          item(1, minutes(30), "after"),
        ],
        busy: [busyAt([10, 0], [10, 30]), busyAt([12, 0], [12, 15])],
      }),
    ).toEqual({
      rows: ["0 9:00–10:00", "0 10:30–12:00", "1 12:15–12:45"],
      notes: ["0 busy", "1 busy"],
      questions: [],
    });
    // What comes before a span ends where the span begins.
    expect(
      plan({
        items: [item(0, minutes(45)), item(1, { kind: "span", begin: at(10), end: at(11) })],
        busy: [busyAt([9, 30], [9, 40])],
      }).rows,
    ).toEqual(["0 9:05–9:30", "0 9:40–10:00", "1 10:00–11:00"]);
    // An interruption as long as the span cannot be inside it.
    expect(
      plan({
        items: [
          item(0, { kind: "span", begin: at(9), end: at(9, 30) }),
          item(1, minutes(30), "within"),
        ],
      }),
    ).toEqual({ rows: ["0 9:00–9:30"], notes: ["0 overWindow"], questions: [] });
  });

  it("fills a window, with the rest or with the one activity that has no amount", () => {
    const window = { windowMinutes: 120 };
    expect(
      plan({ ...window, items: [item(0, minutes(45)), item(1, { kind: "rest" })] }).rows,
    ).toEqual(["0 12:20–13:05", "1 13:05–14:20"]);
    // An existing entry in the window is not part of the rest.
    expect(
      plan({
        ...window,
        items: [item(0, minutes(45)), item(1, { kind: "rest" })],
        busy: [busyAt([13, 0], [13, 30])],
      }).rows,
    ).toEqual(["0 12:20–13:00", "0 13:30–13:35", "1 13:35–14:20"]);
    expect(
      plan({ ...window, items: [item(0, minutes(120)), item(1, { kind: "rest" })] }),
    ).toEqual({ rows: ["0 12:20–14:20"], notes: ["1 noRest"], questions: [] });
    expect(
      plan({ ...window, items: [item(0, minutes(100)), item(1, minutes(40))] }).notes,
    ).toEqual(["all overWindow", "1 future"]);
    // Without a rest the activities start where the window starts.
    expect(
      plan({ ...window, items: [item(0, minutes(30)), item(1, minutes(30))] }).rows,
    ).toEqual(["0 12:20–12:50", "1 12:50–13:20"]);
    // Two activities without an amount: both have to be asked.
    expect(
      plan({ ...window, items: [item(0, { kind: "unknown" }), item(1, { kind: "unknown" })] }),
    ).toEqual({ rows: [], notes: [], questions: ["0 duration", "1 duration"] });
    // A rest that was answered is a plain duration.
    expect(
      plan({ items: [item(0, minutes(30)), item(1, { kind: "rest" })], choices: { 1: { minutes: 20 } } })
        .rows,
    ).toEqual(["0 13:30–14:00", "1 14:00–14:20"]);
    // A rest without a window has to be asked.
    expect(plan({ items: [item(0, minutes(30)), item(1, { kind: "rest" })] })).toEqual({
      rows: ["0 13:50–14:20"],
      notes: [],
      questions: ["1 rest"],
    });
  });

  it("starts at nine on another day", () => {
    const yesterday = new Date(2026, 10, 25);
    expect(
      plan({ day: yesterday, items: [item(0, minutes(60)), item(1, minutes(30), "after")] }),
    ).toEqual({
      rows: ["0 9:00–10:00", "1 10:00–10:30"],
      notes: ["all defaultStart"],
      questions: [],
    });
    expect(
      plan({
        day: yesterday,
        windowMinutes: 120,
        items: [item(0, minutes(30)), item(1, { kind: "rest" })],
      }).rows,
    ).toEqual(["0 9:00–9:30", "1 9:30–11:00"]);
    // Today named explicitly is today.
    expect(plan({ day: new Date(2026, 10, 26), items: [item(0, minutes(60))] }).rows).toEqual([
      "0 13:20–14:20",
    ]);
  });

  it("splits around several interruptions and leaves out what is not known yet", () => {
    expect(
      plan({
        items: [
          item(0, minutes(100)),
          item(1, minutes(10), "within"),
          item(2, minutes(10), "within"),
        ],
      }).rows,
    ).toEqual([
      "0 12:40–13:07",
      "1 13:07–13:17",
      "0 13:17–13:44",
      "2 13:44–13:54",
      "0 13:54–14:20",
    ]);
    // An interruption without a duration is asked for; the hour stays whole.
    expect(
      plan({ items: [item(0, minutes(60)), item(1, { kind: "unknown" }, "within")] }),
    ).toEqual({ rows: ["0 13:20–14:20"], notes: [], questions: ["1 duration"] });
    // "dazwischen" or "vorher" with nothing before them are just activities.
    expect(
      plan({ items: [item(0, minutes(10), "within"), item(1, minutes(10), "before")] }).rows,
    ).toEqual(["1 14:00–14:10", "0 14:10–14:20"]);
    // A span in the future is flagged.
    expect(
      plan({ items: [item(0, { kind: "span", begin: at(14), end: at(15) })] }).notes,
    ).toEqual(["0 future"]);
  });

  it("knows which activities were interrupted", () => {
    const items = [
      item(0, minutes(60)),
      item(1, minutes(10), "within"),
      item(2, { kind: "span", begin: at(9), end: at(10) }),
      item(3, minutes(10), "within"),
      item(4, minutes(20)),
    ];
    // A time span stays as it is, so there is nothing to switch.
    expect([...interruptedItems(items)]).toEqual([0]);
  });
});

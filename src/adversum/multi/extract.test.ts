import { describe, expect, it } from "vitest";

import { parseModelOutput, saidNumbers } from "./extract";

/** Thursday 26 November 2026, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);
const activity = (fields: Record<string, unknown>) => ({
  task: "DUSW Design",
  minutes: 0,
  count: 0,
  repeated: false,
  vague: false,
  rest: false,
  relation: "none",
  from: "",
  to: "",
  ...fields,
});
const answer = (activities: unknown[], window = 0) =>
  JSON.stringify({ window_minutes: window, activities });

describe("parseModelOutput", () => {
  it("turns each kind of amount into what the planner reads", () => {
    const output = answer(
      [
        activity({ minutes: 60 }),
        activity({ task: " K&K Call ", minutes: 10, relation: "within" }),
        activity({ task: "Gigi WhatsApp", count: 8, repeated: true, vague: true }),
        activity({ task: "Designs", minutes: 7, repeated: true }),
        activity({ task: "SolarTech", from: "09:00", to: "12:00", relation: "after" }),
        activity({ task: "K&K Landingpage", rest: true, relation: "before" }),
        activity({ task: "kurz was", vague: true, relation: "sideways" }),
        activity({ task: "ohne Angabe" }),
      ],
      180,
    );
    const sentence =
      "Die letzten 3 Stunden eine Stunde DUSW Design, dazwischen 10 Minuten K&K Call, 8 mal kurz Gigi, immer wieder Designs je 7 Minuten, von 9 bis 12 SolarTech, der Rest K&K Landingpage";
    expect(parseModelOutput(output, sentence, now)).toEqual({
      windowMinutes: 180,
      day: null,
      clauses: [
        { text: "DUSW Design", amount: { kind: "minutes", minutes: 60 }, relation: "none" },
        { text: "K&K Call", amount: { kind: "minutes", minutes: 10 }, relation: "within" },
        {
          text: "Gigi WhatsApp",
          amount: { kind: "times", count: 8, each: 5, vague: "kurz" },
          relation: "none",
        },
        { text: "Designs", amount: { kind: "times", count: null, each: 7 }, relation: "none" },
        {
          text: "SolarTech",
          amount: {
            kind: "span",
            begin: new Date(2026, 10, 26, 9, 0),
            end: new Date(2026, 10, 26, 12, 0),
          },
          relation: "after",
        },
        { text: "K&K Landingpage", amount: { kind: "rest" }, relation: "before" },
        {
          text: "kurz was",
          amount: { kind: "minutes", minutes: 5, vague: "kurz" },
          relation: "none",
        },
        { text: "ohne Angabe", amount: { kind: "unknown" }, relation: "none" },
      ],
    });
  });

  it("reads the day from the sentence and puts clock times on it", () => {
    const output = `\`\`\`json\n${answer([activity({ from: "9:00", to: "10:30" })])}\n\`\`\``;
    expect(parseModelOutput(output, "Gestern von 9 bis halb elf DUSW Design", now)).toEqual({
      windowMinutes: null,
      day: new Date(2026, 10, 25),
      clauses: [
        {
          text: "DUSW Design",
          amount: {
            kind: "span",
            begin: new Date(2026, 10, 25, 9, 0),
            end: new Date(2026, 10, 25, 10, 30),
          },
          relation: "none",
        },
      ],
    });
  });

  it("drops what does not fit and gives up when nothing is left", () => {
    const usable = parseModelOutput(
      answer([
        activity({ task: "" }),
        activity({ task: 7 }),
        "DUSW",
        null,
        activity({ task: "x".repeat(301) }),
        // Numbers that cannot be right are "not said".
        activity({ task: "Call", minutes: 100_000, count: -2, from: "25:00", to: "12:70" }),
        // An end before the begin is no span.
        activity({ task: "Rückwärts", from: "12:00", to: "09:00", minutes: 1.5 }),
      ]),
      "egal",
      now,
    );
    expect(usable?.clauses).toEqual([
      { text: "Call", amount: { kind: "unknown" }, relation: "none" },
      { text: "Rückwärts", amount: { kind: "unknown" }, relation: "none" },
    ]);
    for (const wrong of [
      "keine Ahnung",
      "[]",
      "null",
      '{"activities": "viele"}',
      answer([]),
      answer([activity({ task: "" })]),
    ]) {
      expect(parseModelOutput(wrong, "egal", now)).toBeNull();
    }
  });
});

describe("numbers a model makes up", () => {
  const read = (sentence: string, activities: unknown[], window = 0) =>
    parseModelOutput(answer(activities, window), sentence, now)!;

  it("are dropped, so the review asks instead", () => {
    const made = read(
      "DUSW Design, K&K Call",
      [activity({ minutes: 180 }), activity({ task: "K&K Call", minutes: 180 })],
      180,
    );
    expect(made.windowMinutes).toBeNull();
    expect(made.clauses.map((clause) => clause.amount)).toEqual([
      { kind: "unknown" },
      { kind: "unknown" },
    ]);
    // "Three calls of ten minutes" is 3 × 10, not the 30 a model adds up to.
    const added = read("Drei Calls à zehn Minuten mit K&K", [activity({ minutes: 30 })]);
    expect(added.clauses[0]!.amount).toEqual({ kind: "unknown" });
    const counted = read("Drei Calls à zehn Minuten mit K&K", [
      activity({ minutes: 10, count: 3, repeated: true }),
      activity({ task: "erfunden", minutes: 7, count: 5, repeated: true }),
    ]);
    expect(counted.clauses.map((clause) => clause.amount)).toEqual([
      { kind: "times", count: 3, each: 10 },
      { kind: "times", count: null, each: null },
    ]);
    // A time span needs both of its clock times in the sentence.
    const span = read("Von neun bis halb elf Meeting mit SolarTech, um 4 noch ein Call", [
      activity({ from: "09:00", to: "10:30" }),
      activity({ task: "Call", from: "16:00", to: "17:00" }),
    ]);
    expect(span.clauses[0]!.amount).toMatchObject({ kind: "span" });
    expect(span.clauses[1]!.amount).toEqual({ kind: "unknown" });
  });

  it("stand when the sentence says them, in whatever form", () => {
    const said = (sentence: string) => saidNumbers(sentence);
    expect(
      [
        ...said("anderthalb Stunden, 20 min, 2h30, eine Dreiviertelstunde, 1,5h, zwei Stunden, 90min")
          .minutes,
      ].sort((a, b) => a - b),
    ).toEqual([20, 45, 90, 120, 150]);
    expect([...said("8 mal, dreimal, 2x, zwei Calls").counts].sort((a, b) => a - b)).toEqual([
      2, 3, 8,
    ]);
    // 9:00 and 21:00, 10:30 and 22:30, 14:15, 16:00 (and 4:00).
    expect([...said("von 9 bis halb elf, 14:15 Uhr, um 4, 25 Uhr").clocks].sort((a, b) => a - b))
      .toEqual([240, 540, 630, 855, 960, 1260, 1350]);
    expect(said("ohne Zahlen").minutes.size).toBe(0);
    // "kurz" is five minutes by agreement, not by the sentence.
    expect(
      read("kurz Mails", [activity({ task: "Mails", vague: true })]).clauses[0]!.amount,
    ).toEqual({ kind: "minutes", minutes: 5, vague: "kurz" });
  });
});

import { describe, expect, it } from "vitest";
import { readMulti } from "./draft";
import { catalog, history, now, SENTENCES } from "./fixtures";
import { clockText } from "./format";
import { planEntries, type PlanChoice } from "./plan";

/** What a sentence becomes: one line per block, plus questions and notes. */
function read(sentence: string, choices: Record<number, PlanChoice> = {}) {
  const { draft, suspect } = readMulti(sentence, catalog, history, now);
  if (!draft) return { single: true, suspect };
  const plan = planEntries({
    items: draft.items,
    windowMinutes: draft.windowMinutes,
    day: draft.day,
    now,
    busy: [],
    choices,
  });
  const item = (id: number) => draft.items.find((candidate) => candidate.id === id)!;
  const label = (id: number) => {
    const { gap, suggestions } = item(id);
    if (gap) return "Pause";
    const first = suggestions[0]!;
    const task = `${first.combination.customer.split(" ")[0]} · ${first.combination.activity}`;
    return first.note ? `${task} "${first.note}"` : task;
  };
  return {
    day: draft.day ? `${draft.day.getDate()}.${draft.day.getMonth() + 1}.` : undefined,
    rows: plan.blocks.map(
      (block) => `${clockText(block.begin)}–${clockText(block.end)} ${label(block.item)}`,
    ),
    questions: plan.questions.map((question) => `${label(question.item)}: ${question.kind}`),
    notes: plan.notes.map((note) =>
      note.item === null ? note.code : `${label(note.item)}: ${note.code}`,
    ),
    marks: draft.items
      .filter((candidate) => candidate.inherited || candidate.guessed)
      .map((candidate) => `${label(candidate.id)}: ${candidate.inherited ? "inherited" : "guessed"}`),
  };
}

describe("several entries from one sentence", () => {
  it("1: an interruption splits the hour, the total stays", () => {
    expect(
      read("Ich hab eine Stunde an DUSW Design gearbeitet, dazwischen 10 Minuten K&K Call"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "13:20–13:45 DUSW · Design",
          "13:45–13:55 K&K · Austausch "Call"",
          "13:55–14:20 DUSW · Design",
        ],
      }
    `);
  });

  it("2: a window, a count that was not said, a vague duration and the rest", () => {
    expect(
      read("Die letzten 3 Stunden immer wieder DUSW Designs je 7 Minuten, 8 mal kurz mit Gigi auf WhatsApp, der Rest K&K Landingpage"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [
          "DUSW · Design "Gigi auf WhatsApp": vague",
        ],
        "questions": [
          "DUSW · Design: count",
        ],
        "rows": [
          "11:20–12:00 DUSW · Design "Gigi auf WhatsApp"",
          "12:00–14:20 K&K · Entwicklung",
        ],
      }
    `);
  });

  it("3: clock times first, 'danach' continues from there", () => {
    expect(
      read("Von 9 bis 12 SolarTech, danach eine halbe Stunde Adversum intern"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "9:00–12:00 SolarTech · Entwicklung",
          "12:00–12:30 Adversum · Buchhaltung",
        ],
      }
    `);
  });

  it("4: one customer is one entry, as before", () => {
    expect(
      read("Ich hab eine Stunde an DUSW Design gearbeitet"),
    ).toMatchInlineSnapshot(`
      {
        "single": true,
        "suspect": false,
      }
    `);
  });

  it("5: a note and a duration after commas are still one entry", () => {
    expect(
      read("DUSW Design, Roll-Ups für die Hallenfußball-Meisterschaft, zwei Stunden"),
    ).toMatchInlineSnapshot(`
      {
        "single": true,
        "suspect": false,
      }
    `);
  });

  it("6: two activities joined by 'und'", () => {
    expect(
      read("Eine Stunde DUSW Design und 10 Minuten K&K Call"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "13:10–14:10 DUSW · Design",
          "14:10–14:20 K&K · Austausch "Call"",
        ],
      }
    `);
  });

  it("7: a break takes time without an entry; 'Korrekturen' is more of the same", () => {
    expect(
      read("Zwei Stunden SolarTech Entwicklung, dazwischen eine Viertelstunde Pause, danach 20 Minuten Korrekturen"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [
          "SolarTech · Entwicklung "Korrekturen": inherited",
        ],
        "notes": [],
        "questions": [],
        "rows": [
          "12:00–12:53 SolarTech · Entwicklung",
          "12:53–13:08 Pause",
          "13:08–14:00 SolarTech · Entwicklung",
          "14:00–14:20 SolarTech · Entwicklung "Korrekturen"",
        ],
      }
    `);
  });

  it("8: 'erst … dann'", () => {
    expect(
      read("Erst anderthalb Stunden K&K Landingpage, dann 30 Minuten DUSW Projektmanagement"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "12:20–13:50 K&K · Entwicklung",
          "13:50–14:20 DUSW · Projektmanagement",
        ],
      }
    `);
  });

  it("9: 'vorher' steps in front", () => {
    expect(
      read("DUSW Design eine Stunde, vorher 20 Minuten Adversum Buchhaltung"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "13:00–13:20 Adversum · Buchhaltung",
          "13:20–14:20 DUSW · Design",
        ],
      }
    `);
  });

  it("10: two time spans", () => {
    expect(
      read("Heute von 8 bis 10 SolarTech Entwicklung, von 10 bis 11 Uhr 30 K&K Call mit Patrick"),
    ).toMatchInlineSnapshot(`
      {
        "day": "26.11.",
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "8:00–10:00 SolarTech · Entwicklung",
          "10:00–11:30 K&K · Austausch "Call mit Patrick"",
        ],
      }
    `);
  });

  it("11: another day starts at nine; the verb names the activity", () => {
    expect(
      read("Gestern drei Stunden SolarTech Imagefilm, dazwischen 20 Minuten mit Gigi telefoniert"),
    ).toMatchInlineSnapshot(`
      {
        "day": "25.11.",
        "marks": [],
        "notes": [
          "defaultStart",
        ],
        "questions": [],
        "rows": [
          "9:00–10:20 SolarTech · Entwicklung",
          "10:20–10:40 DUSW · Austausch "Telefonat Gigi"",
          "10:40–12:00 SolarTech · Entwicklung",
        ],
      }
    `);
  });

  it("12: the activity without an amount fills the window", () => {
    expect(
      read("Die letzte Stunde DUSW Design, zwischendurch kurz K&K Call"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [
          "K&K · Austausch "Call": vague",
        ],
        "questions": [],
        "rows": [
          "13:20–13:48 DUSW · Design",
          "13:48–13:53 K&K · Austausch "Call"",
          "13:53–14:20 DUSW · Design",
        ],
      }
    `);
  });

  it("13: the rest of a window", () => {
    expect(
      read("Die letzten zwei Stunden 45 Minuten DUSW Projektmanagement, der Rest Adversum intern"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "12:20–13:05 DUSW · Projektmanagement",
          "13:05–14:20 Adversum · Buchhaltung",
        ],
      }
    `);
  });

  it("14: a count with a duration each", () => {
    expect(
      read("Drei mal je 10 Minuten K&K Call, danach eine Stunde DUSW Design"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "12:50–13:20 K&K · Austausch "Call"",
          "13:20–14:20 DUSW · Design",
        ],
      }
    `);
  });

  it("15: 'mehrmals' asks how often; 'ansonsten' is the rest", () => {
    expect(
      read("Die letzten 2 Stunden mehrmals kurz mit Gigi telefoniert, ansonsten DUSW Design"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [
          "DUSW · Austausch "Telefonat Gigi": count",
        ],
        "rows": [
          "12:20–14:20 DUSW · Design",
        ],
      }
    `);
  });

  it("16: typed, terse", () => {
    expect(
      read("1h dusw design, dazwischen 10 min k&k call"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "13:20–13:45 DUSW · Design",
          "13:45–13:55 K&K · Austausch "Call"",
          "13:55–14:20 DUSW · Design",
        ],
      }
    `);
  });

  it("17: a span, then a duration", () => {
    expect(
      read("Von 13 bis 14 Uhr DUSW Design, danach 20 Minuten K&K Landingpage"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "13:00–14:00 DUSW · Design",
          "14:00–14:20 K&K · Entwicklung",
        ],
      }
    `);
  });

  it("18: three in a row end now", () => {
    expect(
      read("30 Minuten DUSW Projektmanagement, 45 Minuten SolarTech Entwicklung, 15 Minuten Adversum Buchhaltung"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "12:50–13:20 DUSW · Projektmanagement",
          "13:20–14:05 SolarTech · Entwicklung",
          "14:05–14:20 Adversum · Buchhaltung",
        ],
      }
    `);
  });

  it("19: only the activity said: same customer as before", () => {
    expect(
      read("Eine Stunde DUSW Design, danach 20 Minuten Projektmanagement"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [
          "DUSW · Projektmanagement: inherited",
        ],
        "notes": [],
        "questions": [],
        "rows": [
          "13:00–14:00 DUSW · Design",
          "14:00–14:20 DUSW · Projektmanagement",
        ],
      }
    `);
  });

  it("20: counted interruptions", () => {
    expect(
      read("Anderthalb Stunden an der K&K Landingpage gesessen, zwischendurch zweimal kurz Gigi am Telefon"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [
          "DUSW · Design "Gigi am Telefon": vague",
        ],
        "questions": [],
        "rows": [
          "12:50–13:30 K&K · Entwicklung",
          "13:30–13:40 DUSW · Design "Gigi am Telefon"",
          "13:40–14:20 K&K · Entwicklung",
        ],
      }
    `);
  });

  it("21: an interruption longer than the activity comes on top", () => {
    expect(
      read("Eine halbe Stunde DUSW Design, dazwischen 45 Minuten K&K Call"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [
          "DUSW · Design: forcedAdditional",
        ],
        "questions": [],
        "rows": [
          "13:05–13:20 DUSW · Design",
          "13:20–14:05 K&K · Austausch "Call"",
          "14:05–14:20 DUSW · Design",
        ],
      }
    `);
  });

  it("22: a lunch break inside a time span", () => {
    expect(
      read("Von 9 bis 12 SolarTech Entwicklung, dazwischen eine halbe Stunde Mittagspause"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "9:00–10:15 SolarTech · Entwicklung",
          "10:15–10:45 Pause",
          "10:45–12:00 SolarTech · Entwicklung",
        ],
      }
    `);
  });

  it("23: the task first, the duration after it", () => {
    expect(
      read("DUSW Design zwei Stunden und K&K Call eine halbe Stunde"),
    ).toMatchInlineSnapshot(`
      {
        "day": undefined,
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "11:50–13:50 DUSW · Design",
          "13:50–14:20 K&K · Austausch "Call"",
        ],
      }
    `);
  });

  it("24: two names, one entry: the sentence from the first brief", () => {
    expect(
      read("DUSW Projektmanagement, Gigi Call seit zehn Uhr"),
    ).toMatchInlineSnapshot(`
      {
        "single": true,
        "suspect": false,
      }
    `);
  });

  it("25: a weekday", () => {
    expect(
      read("Am Montag von 9 bis 11 DUSW Design, danach eine Stunde K&K Call"),
    ).toMatchInlineSnapshot(`
      {
        "day": "23.11.",
        "marks": [],
        "notes": [],
        "questions": [],
        "rows": [
          "9:00–11:00 DUSW · Design",
          "11:00–12:00 K&K · Austausch "Call"",
        ],
      }
    `);
  });

  it("26: amounts and an order, but no task the rules know", () => {
    expect(
      read("Eine Stunde Dingsbums, danach 20 Minuten Kram"),
    ).toMatchInlineSnapshot(`
      {
        "single": true,
        "suspect": true,
      }
    `);
  });

  it("27: two tasks without any amount are one entry", () => {
    expect(
      read("DUSW Design, K&K Call"),
    ).toMatchInlineSnapshot(`
      {
        "single": true,
        "suspect": false,
      }
    `);
  });

  it("has every sentence in the list the language model is measured with", () => {
    expect(SENTENCES).toHaveLength(27);
    for (const sentence of SENTENCES) expect(read(sentence)).toBeTruthy();
  });

  it("answers and switches change the plan", () => {
    const interrupted = "Ich hab eine Stunde an DUSW Design gearbeitet, dazwischen 10 Minuten K&K Call";
    // On top instead of out of the hour.
    expect(read(interrupted, { 0: { additional: true } }).rows).toEqual([
      "13:10–13:40 DUSW · Design",
      '13:40–13:50 K&K · Austausch "Call"',
      "13:50–14:20 DUSW · Design",
    ]);
    // One block, the interruption after it.
    expect(read(interrupted, { 0: { merge: true } }).rows).toEqual([
      "13:20–14:10 DUSW · Design",
      '14:10–14:20 K&K · Austausch "Call"',
    ]);
    // Six designs of seven minutes: the rest shrinks by 42 minutes.
    const window =
      "Die letzten 3 Stunden immer wieder DUSW Designs je 7 Minuten, 8 mal kurz mit Gigi auf WhatsApp, der Rest K&K Landingpage";
    expect(read(window, { 0: { count: 6 } })).toMatchObject({
      rows: [
        "11:20–12:02 DUSW · Design",
        '12:02–12:42 DUSW · Design "Gigi auf WhatsApp"',
        "12:42–14:20 K&K · Entwicklung",
      ],
      questions: [],
    });
    // "kurz" corrected to three minutes each.
    expect(read(window, { 0: { count: 6 }, 1: { minutes: 3 } }).rows?.[1]).toBe(
      '12:02–12:26 DUSW · Design "Gigi auf WhatsApp"',
    );
  });
});

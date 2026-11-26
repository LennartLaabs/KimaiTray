import { describe, expect, it } from "vitest";
import { buildCatalog } from "../quickEntry/catalog";
import { buildHistory } from "../quickEntry/history";
import { buildDraft, namesTask, readMulti } from "./draft";
import { extractClauses } from "./segment";

/** Thursday 26 November 2026, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);
/** A stand-in for the catalog: these words name tasks. */
const isTask = (text: string) => /dusw|k&k|solartech/i.test(text);

function clauses(sentence: string) {
  return extractClauses(sentence, now, isTask).clauses.map((clause) => {
    const { amount } = clause;
    const said =
      amount.kind === "minutes"
        ? `${amount.minutes} min${amount.vague ? ` (${amount.vague})` : ""}`
        : amount.kind === "times"
          ? `${amount.count ?? "?"} × ${amount.each ?? "?"}${amount.vague ? ` (${amount.vague})` : ""}`
          : amount.kind;
    return `${clause.text} | ${said} | ${clause.relation}`;
  });
}

describe("extractClauses", () => {
  it("reads vague counts and durations", () => {
    expect(clauses("Ein paar mal je 5 Minuten DUSW Design, danach ein paar Minuten K&K Call")).toEqual([
      "DUSW Design | ? × 5 | none",
      "K&K Call | 5 min (paar) | after",
    ]);
    expect(clauses("Dreimal kurz DUSW Design, 2x 10 Minuten K&K Call, öfters SolarTech")).toEqual([
      "DUSW Design | 3 × 5 (kurz) | none",
      "K&K Call | 2 × 10 | none",
      "SolarTech | ? × ? | none",
    ]);
  });

  it("reads the rest in its spellings", () => {
    expect(clauses("Eine Stunde DUSW Design, die restliche Zeit K&K")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K | rest | none",
    ]);
    expect(clauses("Eine Stunde DUSW Design den Rest K&K")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K | rest | none",
    ]);
    expect(clauses("Eine Stunde DUSW Design, Rest K&K")).toHaveLength(2);
  });

  it("starts a clause at 'danach' even without a comma", () => {
    expect(clauses("Eine Stunde DUSW Design und danach 20 Minuten K&K Call")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K Call | 20 min | after",
    ]);
    // "und" alone only splits two complete activities.
    expect(clauses("Eine Stunde DUSW Konzept und Design")).toEqual([
      "DUSW Konzept und Design | 60 min | none",
    ]);
  });

  it("gives an amount said on its own to the activity next to it", () => {
    expect(clauses("Eine Stunde, DUSW Design, danach 20 Minuten K&K Call")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K Call | 20 min | after",
    ]);
    expect(clauses("DUSW Design, eine Stunde, danach K&K Call, 20 Minuten")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K Call | 20 min | after",
    ]);
    // An order said on its own goes with what follows, unless that has one.
    expect(clauses("Eine Stunde DUSW Design. Danach, 20 Minuten, K&K Call")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K Call | 20 min | after",
    ]);
    expect(clauses("Eine Stunde DUSW Design. Danach 10 Minuten, vorher K&K Call")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K Call | 10 min | before",
    ]);
    expect(clauses("Eine Stunde DUSW Design. 20 Minuten, danach, K&K Call")).toEqual([
      "DUSW Design | 60 min | none",
      "K&K Call | 20 min | after",
    ]);
    // An amount nothing follows is dropped.
    expect(clauses("Eine Stunde DUSW Design, danach 20 Minuten")).toEqual([
      "DUSW Design | 60 min | none",
    ]);
  });

  it("keeps words around the activities as their notes", () => {
    expect(
      clauses("Also heute war viel los, eine Stunde DUSW Design, Startseite, danach 20 Minuten K&K"),
    ).toEqual(["Also war viel los DUSW Design Startseite | 60 min | none", "K&K | 20 min | after"]);
    // An amount with words that name no task stays an activity of its own.
    expect(clauses("Eine Stunde DUSW Design, danach 20 Minuten Kram")).toEqual([
      "DUSW Design | 60 min | none",
      "Kram | 20 min | after",
    ]);
  });

  it("reads the window once and leaves other uses of 'letzten' alone", () => {
    const window = extractClauses(
      "In den letzten anderthalb Stunden die letzten Korrekturen DUSW, der Rest K&K",
      now,
      isTask,
    );
    expect(window.windowMinutes).toBe(90);
    expect(window.clauses[0]!.text).toBe("die letzten Korrekturen DUSW");
    expect(extractClauses("Die letzte Stunde DUSW", now, isTask).windowMinutes).toBe(60);
    expect(
      extractClauses("Die letzten Korrekturen DUSW eine Stunde", now, isTask).windowMinutes,
    ).toBeNull();
    expect(extractClauses("Die letzten 45 Minuten DUSW", now, isTask).windowMinutes).toBe(45);
    expect(extractClauses("[Musik] (lacht)", now, isTask)).toEqual({
      clauses: [],
      windowMinutes: null,
      day: null,
    });
  });

  it("takes a start time as a span until now", () => {
    const [clause] = extractClauses("Seit 13 Uhr DUSW Design", now, isTask).clauses;
    expect(clause!.amount).toEqual({ kind: "span", begin: new Date(2026, 10, 26, 13, 0), end: now });
  });
});

describe("matching against the catalog", () => {
  const catalog = buildCatalog(
    [
      { id: 1, name: "DUSW" },
      { id: 3, name: "K&K Global Solutions" },
    ],
    [
      { id: 11, name: "Retainer", customer: 1 },
      { id: 31, name: "Landingpage", customer: 3 },
    ],
    [
      { id: 2, name: "Austausch", project: null },
      { id: 4, name: "Design", project: null },
    ],
  );
  // "Gigi" is no alias here; it only ever appeared in notes of DUSW · Austausch.
  const history = buildHistory(
    [1, 2, 3].map((days) => ({
      projectId: 11,
      activityId: 2,
      begin: new Date(2026, 10, 26 - days, 10, 0),
      description: "Gigi Call",
    })),
    now,
  );

  it("takes a word of past notes as naming the task", () => {
    expect(namesTask("mit Gigi gesprochen", catalog, history, now)).toBe(true);
    expect(namesTask("Gigi", catalog, history, now)).toBe(true);
    expect(namesTask("Patrick", catalog, history, now)).toBe(false);
    // A command or nothing at all names no task.
    expect(namesTask("Stopp", catalog, history, now)).toBe(false);
    expect(namesTask("", catalog, history, now)).toBe(false);
    const { draft } = readMulti(
      "Eine Stunde K&K Design, dazwischen 10 Minuten Gigi",
      catalog,
      history,
      now,
    );
    expect(draft?.items[1]?.suggestions[0]?.combination).toMatchObject({
      customer: "DUSW",
      activity: "Austausch",
    });
  });

  it("carries the task on for a clause that is no entry by itself", () => {
    const draft = buildDraft(
      {
        windowMinutes: null,
        day: null,
        clauses: [
          { text: "DUSW Design", amount: { kind: "minutes", minutes: 60 }, relation: "none" },
          { text: "K&K Design", amount: { kind: "minutes", minutes: 30 }, relation: "after" },
          { text: "weiter", amount: { kind: "minutes", minutes: 10 }, relation: "after" },
        ],
      },
      catalog,
      history,
      now,
      "apple",
    );
    expect(draft?.source).toBe("apple");
    expect(draft?.items[2]).toMatchObject({ inherited: true, guessed: false });
    expect(draft?.items[2]?.suggestions[0]).toMatchObject({
      combination: { customer: "K&K Global Solutions", activity: "Design" },
      note: "",
    });
    // Without a named task there is nothing to enter.
    expect(
      buildDraft(
        {
          windowMinutes: 60,
          day: null,
          clauses: [
            { text: "Pause", amount: { kind: "minutes", minutes: 10 }, relation: "none" },
            { text: "Mittagspause", amount: { kind: "minutes", minutes: 30 }, relation: "after" },
          ],
        },
        catalog,
        history,
        now,
        "rules",
      ),
    ).toBeNull();
  });
});

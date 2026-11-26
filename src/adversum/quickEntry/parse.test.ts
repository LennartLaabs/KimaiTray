import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog";
import { buildHistory, EMPTY_HISTORY } from "./history";
import { AUTO_SELECT_CONFIDENCE, MAX_SUGGESTIONS, parseQuickEntry, scoreWord } from "./parse";

/** Thursday 26 November 2026, 10:20. */
const now = new Date(2026, 10, 26, 10, 20);
const DAY = 24 * 60 * 60 * 1000;

const catalog = buildCatalog(
  [
    { id: 1, name: "DUSW Unternehmensgruppe" },
    { id: 2, name: "Herosmile" },
    { id: 3, name: "Schneider Bau" },
    { id: 4, name: "Müller & Söhne" },
  ],
  [
    { id: 11, name: "Marketing Retainer", customer: 1 },
    { id: 12, name: "Website Relaunch", customer: 1 },
    { id: 21, name: "Marketing Retainer", customer: 2 },
    { id: 22, name: "Social Media", customer: 2 },
    { id: 31, name: "Marketing Retainer", customer: 3 },
    { id: 41, name: "Imagefilm", customer: 4 },
  ],
  [
    { id: 1, name: "Projektmanagement", project: null },
    { id: 2, name: "Austausch", project: null },
    { id: 3, name: "Konzeption", project: null },
    { id: 4, name: "Videoschnitt", project: null },
    { id: 7, name: "Community Management", project: 22 },
  ],
  {
    customers: { "1": ["gigi"] },
    projects: {},
    activities: { "1": ["pm"], "2": ["call", "telefonat", "meeting"] },
  },
);

function times(projectId: number, activityId: number, count: number, hour = 10) {
  return Array.from({ length: count }, (_, index) => {
    const begin = new Date(now.getTime() - (index + 1) * DAY);
    begin.setHours(hour, 0, 0, 0);
    return { projectId, activityId, begin };
  });
}

const history = buildHistory(
  [
    ...times(11, 1, 30),
    ...times(12, 1, 3),
    ...times(21, 1, 10),
    ...times(22, 7, 12),
    ...times(31, 4, 15, 15),
    ...times(11, 2, 6),
  ],
  now,
);

function parse(input: string, withHistory = history) {
  return parseQuickEntry(input, catalog, withHistory, now);
}

function top(input: string, withHistory = history) {
  const [first] = parse(input, withHistory).suggestions;
  if (!first) throw new Error(`no suggestion for "${input}"`);
  const { customer, project, activity } = first.combination;
  return { label: `${customer} · ${project} · ${activity}`, note: first.note };
}

describe("scoreWord", () => {
  const entity = { words: ["marketing", "retainer"], aliases: ["mr1"], acronym: "mr" };

  it("ranks exact, acronym, prefix, typo and substring matches", () => {
    expect(scoreWord("retainer", entity)).toBe(1);
    expect(scoreWord("mr1", entity)).toBe(1);
    expect(scoreWord("mr", entity)).toBe(0.85);
    expect(scoreWord("mark", entity)).toBeCloseTo(0.7 + 0.25 * (4 / 9));
    expect(scoreWord("retainre", entity)).toBeCloseTo(0.65);
    expect(scoreWord("marcketnig", entity)).toBeCloseTo(0.55);
    expect(scoreWord("tain", entity)).toBe(0.55);
    expect(scoreWord("xyz", entity)).toBe(0);
    expect(scoreWord("m", entity)).toBe(0);
    expect(scoreWord("xyzabc", entity)).toBe(0);
  });
});

describe("parseQuickEntry", () => {
  it("resolves the example from the brief", () => {
    expect(top("dusw pm gigi call")).toEqual({
      label: "DUSW Unternehmensgruppe · Marketing Retainer · Projektmanagement",
      note: "Gigi Call",
    });
    const result = parse("dusw pm gigi call");
    expect(result.command).toBeNull();
    expect(result.time).toEqual({ kind: "none" });
    expect(result.autoSelect).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO_SELECT_CONFIDENCE);
    expect(result.suggestions[0]).toMatchObject({ matchedWords: 2, namesTarget: true, textScore: 2 });
  });

  it("uses aliases for customers and activities", () => {
    // Aliases that are more than a name stay in the note, the activity word
    // first: "gigi" is a person, "call" what happened.
    expect(top("gigi call")).toEqual({
      label: "DUSW Unternehmensgruppe · Marketing Retainer · Austausch",
      note: "Call Gigi",
    });
    expect(top("herosmile telefonat rückruf")).toEqual({
      label: "Herosmile · Marketing Retainer · Austausch",
      note: "Telefonat Rückruf",
    });
    // "pm" only abbreviates the activity's name.
    expect(top("herosmile pm rückruf").note).toBe("Rückruf");
  });

  it("lets several words name one entity and keeps typed capitals in the note", () => {
    expect(top("schneider bau marketing retainer videoschnitt Reel für Insta")).toEqual({
      label: "Schneider Bau · Marketing Retainer · Videoschnitt",
      note: "Reel für Insta",
    });
    expect(top("hero social community")).toEqual({
      label: "Herosmile · Social Media · Community Management",
      note: "",
    });
  });

  it("tolerates typos, umlaut spellings and punctuation", () => {
    expect(top("herosmiel konzeption").label).toBe("Herosmile · Marketing Retainer · Konzeption");
    expect(top("muller imagefilm, videoschnitt").label).toBe("Müller & Söhne · Imagefilm · Videoschnitt");
    expect(top("Müller pm").label).toBe("Müller & Söhne · Imagefilm · Projektmanagement");
    expect(top("dusw pm gigi-call").note).toBe("Gigi-Call");
  });

  it("fills in what was not typed from the history", () => {
    // Only the activity is named: the most used customer and project win.
    expect(top("pm").label).toBe("DUSW Unternehmensgruppe · Marketing Retainer · Projektmanagement");
    // Only the customer is named: the usual project and activity win.
    expect(top("herosmile").label).toBe("Herosmile · Social Media · Community Management");
    expect(top("schneider").label).toBe("Schneider Bau · Marketing Retainer · Videoschnitt");
  });

  it("never returns more than five suggestions and ranks matches before history", () => {
    const result = parse("marketing");
    expect(result.suggestions).toHaveLength(MAX_SUGGESTIONS);
    expect(result.suggestions.every((item) => item.combination.project === "Marketing Retainer")).toBe(true);
    expect(result.suggestions[0]?.combination.customer).toBe("DUSW Unternehmensgruppe");
    const scores = result.suggestions.map((item) => item.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("offers the likeliest tasks for empty or unmatched input without preselecting", () => {
    const empty = parse("");
    expect(empty.suggestions).toHaveLength(MAX_SUGGESTIONS);
    expect(empty.suggestions[0]?.combination.key).toBe("11-1");
    expect(empty.confidence).toBe(0);
    expect(empty.autoSelect).toBe(false);

    const unmatched = parse("xyzzy qwert");
    expect(unmatched.suggestions[0]?.note).toBe("Xyzzy Qwert");
    expect(unmatched.autoSelect).toBe(false);
  });

  it("does not preselect when the match is ambiguous or only names an activity", () => {
    // Without history, "marketing pm" fits three customers equally well.
    const ambiguous = parse("marketing pm", EMPTY_HISTORY);
    expect(ambiguous.suggestions.length).toBeGreaterThan(1);
    expect(ambiguous.confidence).toBeLessThan(AUTO_SELECT_CONFIDENCE);
    expect(ambiguous.autoSelect).toBe(false);
    // Stable order for equal scores.
    expect(ambiguous.suggestions.slice(0, 3).map((item) => item.combination.key)).toEqual([
      "11-1", "21-1", "31-1",
    ]);
    // Combinations that fit fewer words follow.
    expect(ambiguous.suggestions[3]?.matchedWords).toBe(1);

    const activityOnly = parse("konzeption", EMPTY_HISTORY);
    expect(activityOnly.suggestions[0]?.namesTarget).toBe(false);
    expect(activityOnly.autoSelect).toBe(false);
  });

  it("is certain when one combination clearly fits best", () => {
    const result = parse("müller imagefilm konzeption", EMPTY_HISTORY);
    expect(result.suggestions[0]?.combination.key).toBe("41-3");
    expect(result.suggestions[1]?.matchedWords).toBe(2);
    expect(result.confidence).toBe(1);
    expect(result.autoSelect).toBe(true);

    const single = buildCatalog(
      [{ id: 1, name: "Solo" }],
      [{ id: 2, name: "Projekt", customer: 1 }],
      [{ id: 3, name: "Arbeit", project: 2 }],
    );
    const only = parseQuickEntry("solo", single, EMPTY_HISTORY, now);
    expect(only.suggestions).toHaveLength(1);
    expect(only.confidence).toBe(1);
  });

  it("extracts time phrases before matching", () => {
    const started = parse("dusw pm seit 9:45 gigi call");
    expect(started.time).toEqual({ kind: "start", begin: new Date(2026, 10, 26, 9, 45) });
    expect(started.suggestions[0]?.note).toBe("Gigi Call");
    expect(started.timePhrase).toBe("seit 9:45");

    const logged = parse("von 9 bis 10 herosmile call abstimmung");
    expect(logged.time).toEqual({
      kind: "range",
      begin: new Date(2026, 10, 26, 9, 0),
      end: new Date(2026, 10, 26, 10, 0),
    });
    expect(logged.suggestions[0]).toMatchObject({
      combination: { customer: "Herosmile", activity: "Austausch" },
      note: "Call Abstimmung",
    });

    expect(parse("dusw pm 1,5 h").time.kind).toBe("range");
    expect(parse("dusw pm seit 11").time).toEqual({ kind: "future" });
  });

  it("takes the day out of the input and puts the time on it", () => {
    const logged = parse("gigi call gestern von 10 bis 11");
    expect(logged.day).toEqual(new Date(2026, 10, 25));
    expect(logged.time).toEqual({
      kind: "range",
      begin: new Date(2026, 10, 25, 10, 0),
      end: new Date(2026, 10, 25, 11, 0),
    });
    expect(logged.timePhrase).toBe("gestern von 10 bis 11");
    expect(logged.suggestions[0]).toMatchObject({
      combination: { customer: "DUSW Unternehmensgruppe", activity: "Austausch" },
      note: "Call Gigi",
    });

    const dated = parse("dusw pm am 24.11., 2 h angebot");
    expect(dated.day).toEqual(new Date(2026, 10, 24));
    expect(dated.timePhrase).toBe("am 24.11. 2 h");
    expect(dated.suggestions[0]?.note).toBe("Angebot");
    expect(parse("dusw pm gestern").time).toEqual({ kind: "incomplete" });
    expect(parse("dusw pm").day).toBeNull();
  });

  it("writes the note cleanly", () => {
    // No punctuation left over, connecting words stay small.
    expect(top("dusw pm angebot, für die messe!").note).toBe("Angebot für die Messe");
    expect(top("dusw pm (rückruf)").note).toBe("Rückruf");
    expect(top("dusw pm ...").note).toBe("");
    // A capital anywhere means the note was written with care.
    expect(top("dusw pm rückruf wegen Angebot").note).toBe("Rückruf wegen Angebot");
    // Part of a hyphenated word names the customer, the rest is the note.
    expect(top("dusw-flyer pm").note).toBe("Flyer Pm");
  });

  it("recognizes commands instead of suggesting tasks", () => {
    for (const [input, command] of [
      ["stop", "stop"], ["pause", "pause"], ["weiter", "resume"], ["zurück", "previous"],
    ] as const) {
      expect(parse(input)).toEqual({
        command,
        time: { kind: "none" },
        day: null,
        timePhrase: "",
        suggestions: [],
        confidence: 1,
        autoSelect: true,
      });
    }
    expect(parse("pause dusw").command).toBeNull();
  });

  it("returns nothing to start for an empty catalog", () => {
    const result = parseQuickEntry("dusw", buildCatalog([], [], []), EMPTY_HISTORY, now);
    expect(result.suggestions).toEqual([]);
    expect(result.confidence).toBe(0);
  });
});

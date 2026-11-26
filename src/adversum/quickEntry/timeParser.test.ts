import { describe, expect, it } from "vitest";
import { parseTime } from "./timeParser";

/** Thursday 26 November 2026. */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 10, 26, hour, minute, 0, 0);
}

const now = at(10, 20);

function start(input: string, when = now) {
  const result = parseTime(input, when);
  if (result.time.kind !== "start") throw new Error(`no start in "${input}": ${result.time.kind}`);
  return { begin: result.time.begin, rest: result.rest.join(" ") };
}

function range(input: string, when = now) {
  const result = parseTime(input, when);
  if (result.time.kind !== "range") throw new Error(`no range in "${input}": ${result.time.kind}`);
  return { begin: result.time.begin, end: result.time.end, rest: result.rest.join(" ") };
}

describe("past start times", () => {
  it.each([
    ["dusw pm seit 9:45", at(9, 45)],
    ["dusw pm seit 9.45 uhr", at(9, 45)],
    ["dusw pm seit 9h45", at(9, 45)],
    ["dusw pm seit 10", at(10, 0)],
    ["dusw pm ab halb 10", at(9, 30)],
    ["dusw pm ab halb 10 uhr", at(9, 30)],
    ["dusw pm um viertel nach 9", at(9, 15)],
    ["dusw pm um viertel vor 10", at(9, 45)],
    ["dusw pm seit 00:30", at(0, 30)],
  ])("%s", (input, begin) => {
    expect(start(input)).toEqual({ begin, rest: "dusw pm" });
  });

  it("keeps the words around the phrase in order", () => {
    expect(start("seit 9 dusw pm call").rest).toBe("dusw pm call");
    expect(start("dusw seit 9 uhr pm call").rest).toBe("dusw pm call");
  });

  it("reads an hour up to 12 as the most recent matching time", () => {
    expect(start("seit 3", at(15, 30)).begin).toEqual(at(15, 0));
    expect(start("seit 3", at(9, 0)).begin).toEqual(at(3, 0));
    expect(start("seit 12", at(13, 0)).begin).toEqual(at(12, 0));
    expect(start("seit 14:15", at(15, 0)).begin).toEqual(at(14, 15));
    expect(start("seit 24", at(15, 0)).begin).toEqual(at(0, 0));
  });

  it.each([
    ["vor 20 min", 20],
    ["vor 20 minuten", 20],
    ["vor 20m", 20],
    ["vor 2 h", 120],
    ["vor 1,5 std", 90],
    ["vor 0.5h", 30],
    ["vor einer stunde", 60],
    ["vor einer halben stunde", 30],
    ["vor einer viertelstunde", 15],
  ])("%s", (phrase, minutes) => {
    expect(start(`dusw ${phrase} pm`)).toEqual({
      begin: new Date(now.getTime() - minutes * 60_000),
      rest: "dusw pm",
    });
  });

  it("flags a start time that has not happened yet", () => {
    expect(parseTime("dusw seit 11", now)).toEqual({
      time: { kind: "future" },
      rest: ["dusw"],
      phrase: ["seit", "11"],
    });
    expect(parseTime("dusw von 9 bis 10 Uhr pm", now).phrase).toEqual(["von", "9", "bis", "10", "Uhr"]);
    expect(parseTime("vor 20 min", now).phrase).toEqual(["vor", "20", "min"]);
    expect(parseTime("dusw 1,5h", now).phrase).toEqual(["1,5h"]);
    expect(parseTime("ab 23:00", at(22, 0)).time).toEqual({ kind: "future" });
  });
});

describe("finished entries", () => {
  it("reads a range with begin and end", () => {
    expect(range("dusw pm von 9 bis 10")).toEqual({ begin: at(9), end: at(10), rest: "dusw pm" });
    expect(range("von 9:15 bis 9:45 uhr dusw")).toEqual({
      begin: at(9, 15), end: at(9, 45), rest: "dusw",
    });
    expect(range("von halb 9 bis viertel nach 9 x")).toEqual({
      begin: at(8, 30), end: at(9, 15), rest: "x",
    });
  });

  it("resolves afternoon ranges and an end after now", () => {
    expect(range("von 2 bis 3", at(16, 0))).toMatchObject({ begin: at(14), end: at(15) });
    expect(range("von 10 bis 11", at(10, 30))).toMatchObject({ begin: at(10), end: at(11) });
    expect(range("von 11 bis 1", at(14, 0))).toMatchObject({ begin: at(11), end: at(13) });
  });

  it("flags a range that cannot be placed", () => {
    expect(parseTime("von 11 bis 12", now).time).toEqual({ kind: "future" });
    expect(parseTime("von 15 bis 14", at(16, 0)).time).toEqual({ kind: "future" });
  });

  it.each([
    ["1,5 h", 90],
    ["1.5h", 90],
    ["90 min", 90],
    ["45m", 45],
    ["2 stunden", 120],
    ["1h30", 90],
  ])("reads the duration %s as an entry ending now", (phrase, minutes) => {
    expect(range(`dusw pm ${phrase}`)).toEqual({
      begin: new Date(now.getTime() - minutes * 60_000),
      end: now,
      rest: "dusw pm",
    });
  });
});

describe("words that are not time phrases", () => {
  it.each([
    "dusw pm gigi call",
    "ab morgen neu",
    "von gigi bis patrick",
    "von 9 dusw",
    "seit 9:99",
    "seit 25",
    "seit 24:30",
    "halb 10",
    "um viertel 9",
    "vor ort",
    "vor einer woche",
    "vor 0 min",
    "4k video",
    "3 kunden",
    "version 2.5",
    "",
  ])("%j is left alone", (input) => {
    const result = parseTime(input, now);
    expect(result.time).toEqual({ kind: "none" });
    expect(result.rest.join(" ")).toBe(input);
    expect(result.phrase).toEqual([]);
  });
});

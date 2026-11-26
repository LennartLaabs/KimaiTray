import { describe, expect, it } from "vitest";
import { parseDate, sameDay } from "./dateParser";

/** Thursday 26 November 2026, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);

function parse(input: string, at = now) {
  return parseDate(input.split(" "), at);
}

function day(input: string, at = now): Date | null {
  return parse(input, at).day;
}

function on(year: number, month: number, date: number): Date {
  return new Date(year, month - 1, date);
}

describe("parseDate", () => {
  it("leaves input without a date alone", () => {
    expect(parse("dusw pm gigi call")).toEqual({
      day: null,
      rest: ["dusw", "pm", "gigi", "call"],
      phrase: [],
    });
    expect(parseDate([], now).day).toBeNull();
  });

  it("reads heute, gestern and vorgestern, with the time of day after them", () => {
    expect(day("heute")).toEqual(on(2026, 11, 26));
    expect(day("Gestern,")).toEqual(on(2026, 11, 25));
    expect(day("vorgestern")).toEqual(on(2026, 11, 24));
    expect(parse("dusw gestern Abend design")).toEqual({
      day: on(2026, 11, 25),
      rest: ["dusw", "design"],
      phrase: ["gestern", "Abend"],
    });
    expect(parse("heute morgen pm").rest).toEqual(["pm"]);
    // Tomorrow is not a day to book time on; the word stays a note.
    expect(parse("morgen pm").day).toBeNull();
  });

  it("reads weekdays as the most recent one", () => {
    expect(day("am Montag")).toEqual(on(2026, 11, 23));
    expect(day("Freitag")).toEqual(on(2026, 11, 20));
    // On a Thursday, "Donnerstag" is today and "letzten Donnerstag" a week ago.
    expect(day("Donnerstag")).toEqual(on(2026, 11, 26));
    expect(day("diesen Donnerstag")).toEqual(on(2026, 11, 26));
    expect(day("letzten Donnerstag")).toEqual(on(2026, 11, 19));
    expect(day("letzten Freitag")).toEqual(on(2026, 11, 20));
    expect(day("vorletzten Dienstag")).toEqual(on(2026, 11, 17));
    expect(parse("am letzten Freitag früh dusw")).toEqual({
      day: on(2026, 11, 20),
      rest: ["dusw"],
      phrase: ["am", "letzten", "Freitag", "früh"],
    });
    // "die letzten 3 Stunden" names no day.
    expect(parse("die letzten 3 Stunden").day).toBeNull();
  });

  it("reads a day with a month name", () => {
    expect(day("26. November")).toEqual(on(2026, 11, 26));
    expect(day("am 3. März")).toEqual(on(2026, 3, 3));
    expect(day("3 Mrz 2025")).toEqual(on(2025, 3, 3));
    expect(parse("call am 20. November 2026, dusw")).toEqual({
      day: on(2026, 11, 20),
      rest: ["call", "dusw"],
      phrase: ["am", "20.", "November", "2026,"],
    });
    expect(day("31. Februar")).toBeNull();
    expect(day("31. Februar 2026")).toBeNull();
  });

  it("reads numeric dates", () => {
    expect(day("26.11.")).toEqual(on(2026, 11, 26));
    expect(day("am 3.11.")).toEqual(on(2026, 11, 3));
    expect(day("03.11.2025")).toEqual(on(2025, 11, 3));
    expect(day("3.11.25")).toEqual(on(2025, 11, 3));
    expect(day("26.11.,")).toEqual(on(2026, 11, 26));
    // Without the closing dot only where it cannot be a time or an amount.
    expect(day("dusw 24.11")).toEqual(on(2026, 11, 24));
    expect(day("seit 10.11")).toBeNull();
    expect(day("1.5 h")).toBeNull();
    expect(day("9.11 Uhr")).toBeNull();
    expect(day("9.45")).toBeNull();
    expect(day("0.0.")).toBeNull();
    expect(day("31.2.")).toBeNull();
  });

  it("takes a day and month without a year as the most recent one", () => {
    // In January, "28.12." was last month.
    expect(day("28.12.", new Date(2027, 0, 5, 9, 0))).toEqual(on(2026, 12, 28));
    // In November, "24.12." is still to come.
    expect(day("24.12.")).toEqual(on(2026, 12, 24));
    // 29 February exists only in some years.
    expect(day("29.2.", new Date(2025, 2, 10))).toBeNull();
    expect(day("29.2.", new Date(2024, 2, 10))).toEqual(on(2024, 2, 29));
  });

  it("reads 'am 26.' as the most recent such day", () => {
    expect(day("am 26.")).toEqual(on(2026, 11, 26));
    expect(day("am 28.")).toEqual(on(2026, 10, 28));
    expect(day("vom 31.", new Date(2026, 2, 5))).toEqual(on(2026, 1, 31));
    expect(day("am 32.")).toBeNull();
    // A bare number is no date: "seit 10." ends a sentence.
    expect(day("seit 10.")).toBeNull();
    expect(day("am 26")).toBeNull();
  });

  it("removes every phrase for the day and prefers the calendar date", () => {
    expect(parse("Giuseppe Call, heute 26. November von 10 bis 11 Uhr.")).toEqual({
      day: on(2026, 11, 26),
      rest: ["Giuseppe", "Call,", "von", "10", "bis", "11", "Uhr."],
      phrase: ["heute", "26.", "November"],
    });
    expect(parse("Montag, den 23. November, dusw")).toEqual({
      day: on(2026, 11, 23),
      rest: ["dusw"],
      phrase: ["Montag,", "den", "23.", "November,"],
    });
    // The weekday outranks "gestern", whichever comes first.
    expect(day("gestern Montag")).toEqual(on(2026, 11, 23));
    expect(day("Montag gestern")).toEqual(on(2026, 11, 23));
  });
});

describe("sameDay", () => {
  it("compares calendar days", () => {
    expect(sameDay(new Date(2026, 10, 26, 0, 0), new Date(2026, 10, 26, 23, 59))).toBe(true);
    expect(sameDay(new Date(2026, 10, 26, 23, 59), new Date(2026, 10, 27, 0, 0))).toBe(false);
  });
});

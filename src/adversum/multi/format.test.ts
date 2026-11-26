import { describe, expect, it } from "vitest";
import { clockText, formatMinutes, parseClock } from "./format";

describe("format", () => {
  it("writes durations and clock times", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(70)).toBe("1 h 10 min");
    expect(formatMinutes(0)).toBe("0 min");
    expect(clockText(new Date(2026, 10, 26, 9, 5))).toBe("9:05");
  });

  it("reads typed clock times on the given day", () => {
    const day = new Date(2026, 10, 25, 17, 0);
    expect(parseClock("9", day)).toEqual(new Date(2026, 10, 25, 9, 0));
    expect(parseClock(" 9:30 ", day)).toEqual(new Date(2026, 10, 25, 9, 30));
    expect(parseClock("0930", day)).toEqual(new Date(2026, 10, 25, 9, 30));
    expect(parseClock("14.05", day)).toEqual(new Date(2026, 10, 25, 14, 5));
    for (const wrong of ["", "abc", "24:00", "9:60", "9:5", "12345"]) {
      expect(parseClock(wrong, day)).toBeNull();
    }
  });
});

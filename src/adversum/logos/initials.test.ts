import { describe, expect, it } from "vitest";
import { avatarColor, customerInitials, readableTextColor } from "./initials";

describe("customerInitials", () => {
  it.each([
    ["DUSW Unternehmensgruppe", "DU"],
    ["adversum", "AD"],
    ["Müller & Söhne GmbH", "MS"],
    ["  3M  ", "3M"],
    ["X", "X"],
    ["über-uns", "ÜU"],
    ["", "?"],
    ["–––", "?"],
  ])("%j → %s", (name, initials) => {
    expect(customerInitials(name)).toBe(initials);
  });
});

describe("avatar colors", () => {
  it("accepts six-digit hex colors and falls back to gray", () => {
    expect(avatarColor("#7A19FF")).toBe("#7A19FF");
    for (const invalid of ["", "#fff", "red", null, undefined, "#12345g"]) {
      expect(avatarColor(invalid)).toBe("#6b7280");
    }
  });

  it("picks readable text for light and dark backgrounds", () => {
    expect(readableTextColor("#ffffff")).toBe("#111827");
    expect(readableTextColor("#fde047")).toBe("#111827");
    expect(readableTextColor("#000000")).toBe("#ffffff");
    expect(readableTextColor("#7a19ff")).toBe("#ffffff");
    expect(readableTextColor("not-a-color")).toBe("#ffffff");
  });
});

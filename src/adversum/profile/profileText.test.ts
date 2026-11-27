import { describe, expect, it } from "vitest";
import {
  cleanList,
  contactNames,
  EMPTY_PROFILE,
  formatContact,
  isEmptyProfile,
  parseContact,
  parseProfile,
  profileLines,
  writeProfile,
} from "./profileText";

const description = [
  "Rechnung immer an die Buchhaltung, nicht an Giuseppe.",
  "Aliasse: Huber, BH",
  "",
  "kontakte : Giuseppe (Gigi, Dschuseppe), Christian; Frau Maier ()",
  "Zahlungsziel: 14 Tage",
  "Themen: Roll-Ups, Messestand, Newsletter, roll-ups",
].join("\n");

describe("parseProfile", () => {
  it("reads the three lines and nothing else", () => {
    expect(parseProfile(description)).toEqual({
      aliases: ["Huber", "BH"],
      contacts: [
        { name: "Giuseppe", variants: ["Gigi", "Dschuseppe"] },
        { name: "Christian", variants: [] },
        { name: "Frau Maier", variants: [] },
      ],
      topics: ["Roll-Ups", "Messestand", "Newsletter"],
    });
  });

  it("is empty for a description without a profile", () => {
    for (const none of [null, undefined, "", "Nur ein Hinweis.\nZahlungsziel: 14 Tage"]) {
      expect(parseProfile(none)).toEqual(EMPTY_PROFILE);
    }
    expect(isEmptyProfile(parseProfile(null))).toBe(true);
    expect(isEmptyProfile(parseProfile("Themen: Flyer"))).toBe(false);
  });

  it("joins lines that come twice and other spellings of the labels", () => {
    expect(
      parseProfile("Alias: A\r\nAliases: B, a\nAnsprechpartner: Eva (Evi)\nKontakt: eva (E.)\nThema: X"),
    ).toEqual({
      aliases: ["A", "B"],
      contacts: [{ name: "Eva", variants: ["Evi", "E."] }],
      topics: ["X"],
    });
  });
});

describe("contacts and lists", () => {
  it("reads and writes a contact with its variants", () => {
    expect(parseContact(" Giuseppe  Rossi ( Gigi / giuseppe rossi ; Beppe ) ")).toEqual({
      name: "Giuseppe Rossi",
      variants: ["Gigi", "Beppe"],
    });
    expect(parseContact("(Gigi)")).toBeNull();
    expect(parseContact("a) b (c")).toEqual({ name: "a", variants: [] });
    expect(formatContact({ name: "Giuseppe", variants: ["Gigi"] })).toBe("Giuseppe (Gigi)");
    expect(formatContact({ name: "Christian", variants: [] })).toBe("Christian");
    expect(contactNames({ name: "Giuseppe", variants: ["Gigi"] })).toEqual(["Giuseppe", "Gigi"]);
  });

  it("tidies lists", () => {
    expect(cleanList([" a ", "", "A", "b  c", "x".repeat(61)])).toEqual(["a", "b c"]);
    expect(cleanList(Array.from({ length: 40 }, (_, index) => `t${index}`))).toHaveLength(30);
  });
});

describe("writeProfile", () => {
  it("replaces the profile lines and leaves the rest as it was", () => {
    const profile = {
      aliases: ["Huber"],
      contacts: [{ name: "Giuseppe", variants: ["Gigi"] }],
      topics: ["Flyer", "Website"],
    };
    expect(writeProfile(description, profile)).toBe(
      [
        "Rechnung immer an die Buchhaltung, nicht an Giuseppe.",
        "",
        "Zahlungsziel: 14 Tage",
        "",
        "Aliasse: Huber",
        "Kontakte: Giuseppe (Gigi)",
        "Themen: Flyer, Website",
      ].join("\n"),
    );
    // Reading back what was written gives the same profile.
    expect(parseProfile(writeProfile(description, profile))).toEqual(profile);
    expect(writeProfile(writeProfile(description, profile), profile)).toBe(
      writeProfile(description, profile),
    );
  });

  it("writes only what there is", () => {
    expect(writeProfile(null, { ...EMPTY_PROFILE, topics: ["Flyer"] })).toBe("Themen: Flyer");
    expect(writeProfile("Hinweis\n\n", EMPTY_PROFILE)).toBe("Hinweis");
    expect(writeProfile("Aliasse: x", EMPTY_PROFILE)).toBe("");
    expect(profileLines({ aliases: [" "], contacts: [{ name: "", variants: ["x"] }], topics: [] })).toEqual(
      [],
    );
  });
});

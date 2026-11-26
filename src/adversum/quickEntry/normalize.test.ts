import { describe, expect, it } from "vitest";
import { editDistance, normalizeText, normalizeWords, wordVariants } from "./normalize";

describe("normalizeText", () => {
  it("lowercases, writes out umlauts and ß, and drops other diacritics", () => {
    expect(normalizeText("Müller & Söhne")).toBe("mueller soehne");
    expect(normalizeText("Straße ÄÖÜ")).toBe("strasse aeoeue");
    expect(normalizeText("Café René")).toBe("cafe rene");
  });

  it("turns punctuation into word breaks", () => {
    expect(normalizeText("  Gigi-Call, (DUSW)!  ")).toBe("gigi call dusw");
    expect(normalizeWords("pm: e-mail / call")).toEqual(["pm", "e", "mail", "call"]);
    expect(normalizeWords("  –  ")).toEqual([]);
  });
});

describe("wordVariants", () => {
  it("adds the short umlaut spelling", () => {
    expect(wordVariants("mueller")).toEqual(["mueller", "muller"]);
    expect(wordVariants("soehne")).toEqual(["soehne", "sohne"]);
    expect(wordVariants("dusw")).toEqual(["dusw"]);
  });
});

describe("editDistance", () => {
  it("counts insertions, deletions, substitutions and transpositions", () => {
    expect(editDistance("projekt", "projekt", 2)).toBe(0);
    expect(editDistance("projekt", "projeckt", 2)).toBe(1);
    expect(editDistance("projekt", "projkt", 2)).toBe(1);
    expect(editDistance("projekt", "prijekt", 2)).toBe(1);
    expect(editDistance("projekt", "porjekt", 2)).toBe(1);
    expect(editDistance("retainer", "retianre", 2)).toBe(2);
  });

  it("stops at the limit", () => {
    expect(editDistance("abc", "abcdefgh", 2)).toBe(3);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBe(3);
    expect(editDistance("kitten", "sitting", 1)).toBe(2);
    expect(editDistance("", "ab", 2)).toBe(2);
  });
});

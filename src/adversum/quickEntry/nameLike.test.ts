import { describe, expect, it } from "vitest";
import { isNameLike, resemblance } from "./nameLike";

const dusw = { words: ["dusw", "unternehmensgruppe"], aliases: ["gigi"], acronym: "du" };
const management = { words: ["projektmanagement"], aliases: ["pm"], acronym: "" };
const exchange = { words: ["austausch"], aliases: ["call"], acronym: "" };
const kk = { words: ["k", "global", "solutions"], aliases: ["kaka"], acronym: "kkgs" };

describe("isNameLike", () => {
  it("takes spellings, parts, slips and abbreviations of the name as the name", () => {
    expect(isNameLike("dusw", dusw)).toBe(true);
    expect(isNameLike("unternehmen", dusw)).toBe(true);
    expect(isNameLike("gruppe", dusw)).toBe(true);
    expect(isNameLike("du", dusw)).toBe(true);
    expect(isNameLike("dsuw", dusw)).toBe(true);
    // The letters of the name in order, from the first on.
    expect(isNameLike("pman", management)).toBe(true);
    expect(isNameLike("pm", management)).toBe(true);
    // Said like the name is written: "K&K".
    expect(isNameLike("kaka", kk)).toBe(true);
    expect(isNameLike("kkgs", kk)).toBe(true);
  });

  it("takes words that say something of their own as content", () => {
    expect(isNameLike("gigi", dusw)).toBe(false);
    expect(isNameLike("giuseppe", dusw)).toBe(false);
    expect(isNameLike("call", exchange)).toBe(false);
    expect(isNameLike("telefonat", exchange)).toBe(false);
    // Starts like the name but its letters do not follow in it.
    expect(isNameLike("pxyz", management)).toBe(false);
    // Too long to be an abbreviation.
    expect(isNameLike("pjktm", management)).toBe(false);
  });
});

describe("resemblance", () => {
  it("is 0 for a name without words", () => {
    expect(resemblance("gigi", { words: [], aliases: [], acronym: "" })).toBe(0);
  });
});

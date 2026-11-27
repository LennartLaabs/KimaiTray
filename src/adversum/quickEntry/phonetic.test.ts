import { describe, expect, it } from "vitest";
import { colognePhonetic, soundsLike } from "./phonetic";

describe("colognePhonetic", () => {
  it("gives the published codes", () => {
    // Examples from the description of the Kölner Phonetik.
    expect(colognePhonetic("mueller")).toBe("657");
    expect(colognePhonetic("wikipedia")).toBe("3412");
    expect(colognePhonetic("breschnew")).toBe("17863");
    expect(colognePhonetic("heinzclassen")).toBe("068586");
    expect(colognePhonetic("")).toBe("");
  });

  it("codes every kind of letter", () => {
    expect(colognePhonetic("aal")).toBe("05");
    expect(colognePhonetic("philipp")).toBe("351");
    expect(colognePhonetic("tschibo")).toBe("81");
    expect(colognePhonetic("cello")).toBe("85");
    expect(colognePhonetic("clown")).toBe("4536");
    expect(colognePhonetic("xaver")).toBe("4837");
    expect(colognePhonetic("jacqueline")).toBe("0456");
    expect(colognePhonetic("knax")).toBe("4648");
    expect(colognePhonetic("bockx")).toBe("148");
    expect(colognePhonetic("k&k")).toBe("4");
  });
});

describe("soundsLike", () => {
  it("hears names the way speech recognition writes them", () => {
    expect(soundsLike("solartek", "solartech")).toBe(true);
    expect(soundsLike("dschuseppe", "giuseppe")).toBe(true);
    expect(soundsLike("tschigi", "gigi")).toBe(true);
    expect(soundsLike("maier", "meyer")).toBe(true);
    expect(soundsLike("schmitt", "schmidt")).toBe(true);
    expect(soundsLike("dschon", "john")).toBe(true);
  });

  it("does not take every word for every name", () => {
    // Same consonants as "Gigi" said softly, but other vowels.
    expect(soundsLike("suche", "gigi")).toBe(false);
    expect(soundsLike("design", "dusw")).toBe(false);
    expect(soundsLike("flyer", "meyer")).toBe(false);
    // Too short, or too different in length.
    expect(soundsLike("ina", "anna")).toBe(false);
    expect(soundsLike("anna", "ina")).toBe(false);
    expect(soundsLike("solar", "solartechnologie")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildDraft, readMulti } from "./draft";
import { parseModelOutput } from "./extract";
import { catalog, history } from "./fixtures";
import { HARD_SENTENCES } from "./hardSentences";
import { amountSignature, draftSignature, matchesExpectation } from "./score";

/** Thursday 26 November 2026, 17:30: late enough for "um 4". */
const evening = new Date(2026, 10, 26, 17, 30);

/** The ideal answer of a model, written out in full. */
function answer(ideal: Record<string, string | number | boolean>[]): string {
  return JSON.stringify({
    window_minutes: 0,
    activities: ideal.map((activity) => ({
      minutes: 0,
      count: 0,
      repeated: false,
      vague: false,
      rest: false,
      relation: "none",
      from: "",
      to: "",
      ...activity,
    })),
  });
}

describe("ten sentences that need more than rules", () => {
  it.each(HARD_SENTENCES.map((hard, index) => [index + 1, hard] as const))(
    "%i: a good reading of the sentence becomes the right entries",
    (_, { sentence, expect: expected, ideal }) => {
      const extraction = parseModelOutput(answer(ideal), sentence, evening);
      expect(extraction).not.toBeNull();
      const draft = buildDraft(extraction!, catalog, history, evening, "local");
      expect(draft?.source).toBe("local");
      expect(draftSignature(draft)).toHaveLength(expected.length);
      expect(matchesExpectation(draftSignature(draft), expected)).toBe(true);
    },
  );

  it("is beyond the rules for most of them", () => {
    const read = HARD_SENTENCES.filter(({ sentence, expect: expected }) =>
      matchesExpectation(
        draftSignature(readMulti(sentence, catalog, history, evening).draft),
        expected,
      ),
    );
    // The rules get the plain "erst … dann … zum Schluss" right and little else.
    expect(read.length).toBeLessThan(HARD_SENTENCES.length / 2);
  });
});

describe("comparing readings", () => {
  it("writes amounts in a short form", () => {
    const at = (hour: number, minute = 0) => new Date(2026, 10, 26, hour, minute);
    expect(amountSignature({ kind: "minutes", minutes: 60 })).toBe("60");
    expect(amountSignature({ kind: "times", count: 3, each: 10 })).toBe("3x10");
    expect(amountSignature({ kind: "times", count: null, each: null })).toBe("?x?");
    expect(amountSignature({ kind: "span", begin: at(9), end: at(10, 30) })).toBe("09:00-10:30");
    expect(amountSignature({ kind: "rest" })).toBe("rest");
    expect(amountSignature({ kind: "unknown" })).toBe("?");
  });

  it("needs the same customers and one of the accepted amounts, in order", () => {
    const expected = [
      { customer: "DUSW", amount: ["60"] },
      { customer: "K&K", amount: ["rest", "?"] },
    ];
    expect(matchesExpectation(["DUSW 60", "K&K ?"], expected)).toBe(true);
    expect(matchesExpectation(["DUSW 60", "K&K 10"], expected)).toBe(false);
    expect(matchesExpectation(["K&K ?", "DUSW 60"], expected)).toBe(false);
    expect(matchesExpectation(["DUSW 60"], expected)).toBe(false);
    expect(draftSignature(null)).toEqual([]);
  });
});

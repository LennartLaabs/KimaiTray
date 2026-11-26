import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  EXTRACT_INSTRUCTIONS,
  EXTRACT_SCHEMA,
  extractWithModel,
  getMultiModelStatus,
  parseModelOutput,
} from "./extract";

/** Thursday 26 November 2026, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);
const activity = (fields: Record<string, unknown>) => ({
  task: "DUSW Design",
  minutes: 0,
  count: 0,
  repeated: false,
  vague: false,
  rest: false,
  relation: "none",
  from: "",
  to: "",
  ...fields,
});
const answer = (activities: unknown[], window = 0) =>
  JSON.stringify({ window_minutes: window, activities });

beforeEach(() => vi.clearAllMocks());

describe("parseModelOutput", () => {
  it("turns each kind of amount into what the planner reads", () => {
    const output = answer(
      [
        activity({ minutes: 60 }),
        activity({ task: " K&K Call ", minutes: 10, relation: "within" }),
        activity({ task: "Gigi WhatsApp", count: 8, repeated: true, vague: true }),
        activity({ task: "Designs", minutes: 7, repeated: true }),
        activity({ task: "SolarTech", from: "09:00", to: "12:00", relation: "after" }),
        activity({ task: "K&K Landingpage", rest: true, relation: "before" }),
        activity({ task: "kurz was", vague: true, relation: "sideways" }),
        activity({ task: "ohne Angabe" }),
      ],
      180,
    );
    expect(parseModelOutput(output, "egal", now)).toEqual({
      windowMinutes: 180,
      day: null,
      clauses: [
        { text: "DUSW Design", amount: { kind: "minutes", minutes: 60 }, relation: "none" },
        { text: "K&K Call", amount: { kind: "minutes", minutes: 10 }, relation: "within" },
        {
          text: "Gigi WhatsApp",
          amount: { kind: "times", count: 8, each: 5, vague: "kurz" },
          relation: "none",
        },
        { text: "Designs", amount: { kind: "times", count: null, each: 7 }, relation: "none" },
        {
          text: "SolarTech",
          amount: {
            kind: "span",
            begin: new Date(2026, 10, 26, 9, 0),
            end: new Date(2026, 10, 26, 12, 0),
          },
          relation: "after",
        },
        { text: "K&K Landingpage", amount: { kind: "rest" }, relation: "before" },
        {
          text: "kurz was",
          amount: { kind: "minutes", minutes: 5, vague: "kurz" },
          relation: "none",
        },
        { text: "ohne Angabe", amount: { kind: "unknown" }, relation: "none" },
      ],
    });
  });

  it("reads the day from the sentence and puts clock times on it", () => {
    const output = `\`\`\`json\n${answer([activity({ from: "9:00", to: "10:30" })])}\n\`\`\``;
    expect(parseModelOutput(output, "Gestern von 9 bis halb elf DUSW Design", now)).toEqual({
      windowMinutes: null,
      day: new Date(2026, 10, 25),
      clauses: [
        {
          text: "DUSW Design",
          amount: {
            kind: "span",
            begin: new Date(2026, 10, 25, 9, 0),
            end: new Date(2026, 10, 25, 10, 30),
          },
          relation: "none",
        },
      ],
    });
  });

  it("drops what does not fit and gives up when nothing is left", () => {
    const usable = parseModelOutput(
      answer([
        activity({ task: "" }),
        activity({ task: 7 }),
        "DUSW",
        null,
        activity({ task: "x".repeat(301) }),
        // Numbers that cannot be right are "not said".
        activity({ task: "Call", minutes: 100_000, count: -2, from: "25:00", to: "12:70" }),
        // An end before the begin is no span.
        activity({ task: "Rückwärts", from: "12:00", to: "09:00", minutes: 1.5 }),
      ]),
      "egal",
      now,
    );
    expect(usable?.clauses).toEqual([
      { text: "Call", amount: { kind: "unknown" }, relation: "none" },
      { text: "Rückwärts", amount: { kind: "unknown" }, relation: "none" },
    ]);
    for (const wrong of [
      "keine Ahnung",
      "[]",
      "null",
      '{"activities": "viele"}',
      answer([]),
      answer([activity({ task: "" })]),
    ]) {
      expect(parseModelOutput(wrong, "egal", now)).toBeNull();
    }
  });
});

describe("the native commands", () => {
  it("asks for the status", async () => {
    invoke.mockResolvedValue({ mode: "auto", apple: "missing", claude: true });
    await expect(getMultiModelStatus()).resolves.toEqual({
      mode: "auto",
      apple: "missing",
      claude: true,
    });
    expect(invoke).toHaveBeenCalledWith("adversum_multi_status");
  });

  it("hands over the sentence with instructions and schema, and checks the answer", async () => {
    invoke.mockResolvedValue({ provider: "claude", output: answer([activity({ minutes: 30 })]) });
    await expect(extractWithModel("30 Minuten DUSW Design", now)).resolves.toEqual({
      source: "claude",
      extraction: {
        windowMinutes: null,
        day: null,
        clauses: [
          { text: "DUSW Design", amount: { kind: "minutes", minutes: 30 }, relation: "none" },
        ],
      },
    });
    expect(invoke).toHaveBeenCalledWith("adversum_multi_extract", {
      sentence: "30 Minuten DUSW Design",
      instructions: EXTRACT_INSTRUCTIONS,
      schema: JSON.stringify(EXTRACT_SCHEMA),
    });
    expect(EXTRACT_INSTRUCTIONS).toContain("Never calculate");
  });

  it("has nothing when no model answered or the answer is useless", async () => {
    invoke.mockResolvedValue(null);
    await expect(extractWithModel("x", now)).resolves.toBeNull();
    invoke.mockResolvedValue({ provider: "apple", output: "Entschuldigung" });
    await expect(extractWithModel("x", now)).resolves.toBeNull();
  });
});

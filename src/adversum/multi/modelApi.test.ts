import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { EXTRACT_INSTRUCTIONS, EXTRACT_SCHEMA } from "./extract";
import { catalog, now } from "./fixtures";
import { EXTRACT_GRAMMAR, localInput, localInstructions } from "./localPrompt";
import {
  deleteBrainModel,
  downloadBrainModel,
  extractWithModel,
  getBrainStatus,
  getMultiModelStatus,
} from "./modelApi";

const answer = JSON.stringify({ activities: [{ task: "DUSW Design", minutes: 30 }] });

beforeEach(() => vi.clearAllMocks());

describe("asking a language model", () => {
  it("asks for the status", async () => {
    invoke.mockResolvedValue({ mode: "device", local: true, claude: false });
    await expect(getMultiModelStatus()).resolves.toEqual({
      mode: "device",
      local: true,
      claude: false,
    });
    expect(invoke).toHaveBeenCalledWith("adversum_multi_status");
  });

  it("hands over the sentence, with the catalog's names for the local model only", async () => {
    invoke.mockResolvedValue({ provider: "local", output: answer });
    await expect(
      extractWithModel("30 Minuten DUSW Design", now, catalog, ["Patrick"]),
    ).resolves.toEqual({
      source: "local",
      extraction: {
        windowMinutes: null,
        day: null,
        clauses: [
          { text: "DUSW Design", amount: { kind: "minutes", minutes: 30 }, relation: "none" },
        ],
      },
    });
    const request = invoke.mock.lastCall![1] as {
      instructions: string;
      local: { instructions: string; input: string; grammar: string };
    };
    expect(invoke.mock.lastCall![0]).toBe("adversum_multi_extract");
    expect(request).toMatchObject({
      sentence: "30 Minuten DUSW Design",
      instructions: EXTRACT_INSTRUCTIONS,
      schema: JSON.stringify(EXTRACT_SCHEMA),
      local: { input: localInput("30 Minuten DUSW Design"), grammar: EXTRACT_GRAMMAR },
    });
    // What Claude Code gets names no customer; what stays on the Mac does.
    expect(request.instructions).not.toContain("DUSW");
    expect(request.local.instructions).toBe(localInstructions(catalog, ["Patrick"]));
    expect(EXTRACT_INSTRUCTIONS).toContain("Never calculate");
  });

  it("has nothing when no model answered or the answer is useless", async () => {
    invoke.mockResolvedValue(null);
    await expect(extractWithModel("x", now, catalog, [])).resolves.toBeNull();
    invoke.mockResolvedValue({ provider: "claude", output: "Entschuldigung" });
    await expect(extractWithModel("x", now, catalog, [])).resolves.toBeNull();
  });
});

describe("the local model's files", () => {
  it("calls the native commands", async () => {
    invoke.mockResolvedValue(undefined);
    await getBrainStatus();
    await downloadBrainModel("gemma-3-4b");
    await deleteBrainModel("qwen-1b5");
    expect(invoke.mock.calls).toEqual([
      ["adversum_brain_status"],
      ["adversum_brain_download", { model: "gemma-3-4b" }],
      ["adversum_brain_delete", { model: "qwen-1b5" }],
    ]);
  });
});

describe("what the local model is asked", () => {
  it("names customers, projects, kinds of work and colleagues, and shows examples", () => {
    const text = localInstructions(catalog, ["Patrick", "Michi"]);
    expect(text).toContain("Customers: DUSW, SolarTech NRW, K&K Global Solutions, Adversum.");
    expect(text).toContain("Projects: Retainer, Imagefilm, Landingpage, Intern.");
    expect(text).toContain("Kinds of work: Projektmanagement, Austausch, Design");
    expect(text).toContain("Colleagues (never customers, keep them in task): Patrick, Michi.");
    expect(text).toContain("Never calculate");
    expect(text.match(/^Sentence: /gm)).toHaveLength(3);
    // Without colleagues the line is left out.
    expect(localInstructions(catalog)).not.toContain("Colleagues");
    expect(localInput("  Eine  Stunde\nDUSW ")).toBe("Sentence: Eine Stunde DUSW\nJSON:");
  });

  it("holds the answer to the fields of the schema", () => {
    for (const field of ["task", "minutes", "count", "repeated", "vague", "rest", "relation", "from", "to"]) {
      expect(EXTRACT_GRAMMAR).toContain(`\\"${field}\\"`);
      expect(Object.keys(EXTRACT_SCHEMA.properties.activities.items.properties)).toContain(field);
    }
    expect(EXTRACT_GRAMMAR.startsWith("root ::=")).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { buildCatalog } from "../quickEntry/catalog";
import { EMPTY_HISTORY } from "../quickEntry/history";
import { parseQuickEntry } from "../quickEntry/parse";
import { describeAction, describeReading, localMinute, saveMisunderstood } from "./feedback";

/** Thursday 26 November 2026, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);
const catalog = buildCatalog(
  [
    { id: 1, name: "DUSW" },
    { id: 3, name: "K&K" },
  ],
  [
    { id: 11, name: "Retainer", customer: 1 },
    { id: 31, name: "Landingpage", customer: 3 },
  ],
  [
    { id: 2, name: "Austausch", project: null },
    { id: 4, name: "Design", project: null },
  ],
);
const read = (text: string) => parseQuickEntry(text, catalog, EMPTY_HISTORY, now, {});

beforeEach(() => vi.clearAllMocks());

describe("keeping a misunderstood sentence", () => {
  it("hands the record to the native side", async () => {
    invoke.mockResolvedValue("/Volumes/AdversumDev/feedback/falsch-verstanden.jsonl");
    const record = {
      time: "2026-11-26T13:20:00.000Z",
      sentence: "DUSW Design",
      source: "voice" as const,
      recognized: { task: "K&K · Landingpage · Design" },
      corrected: null,
    };
    await expect(saveMisunderstood(record)).resolves.toContain("falsch-verstanden.jsonl");
    expect(invoke).toHaveBeenCalledWith("adversum_feedback_append", { record });
  });

  it("writes times as local minutes", () => {
    expect(localMinute(new Date(2026, 0, 5, 9, 7, 59))).toBe("2026-01-05T09:07");
  });

  it("describes what the card showed", () => {
    expect(describeReading(read("DUSW Design Startseite von 9 bis 10"))).toEqual({
      task: "DUSW · Retainer · Design",
      note: "Startseite",
      begin: "2026-11-26T09:00",
      end: "2026-11-26T10:00",
      startsByItself: true,
      alsoOffered: ["DUSW · Retainer · Austausch", "K&K · Landingpage · Design"],
    });
    expect(describeReading(read("DUSW Design seit 13 Uhr"))).toMatchObject({
      begin: "2026-11-26T13:00",
      end: "",
    });
    // Nothing said about time; and a time that cannot be used says which.
    expect(describeReading(read("DUSW Design"))).toMatchObject({ begin: "", end: "" });
    expect(describeReading(read("DUSW Design"))).not.toHaveProperty("time");
    expect(describeReading(read("DUSW Design gestern"))).toMatchObject({ time: "incomplete" });
    const nothing = parseQuickEntry("x", buildCatalog([], [], []), EMPTY_HISTORY, now, {});
    expect(describeReading(nothing)).toMatchObject({ task: "?", note: "", alsoOffered: [] });
  });

  it("describes what was entered instead", () => {
    const target = { projectId: 31, activityId: 2, description: "Call", label: "" };
    const preview = {
      projectId: 31,
      project: "",
      activity: "",
      projectColor: "",
      activityColor: "",
      customerColor: "",
    };
    expect(
      describeAction(
        { type: "start", mode: "switch", ...target, begin: "2026-11-26T13:50:00", preview },
        catalog,
      ),
    ).toEqual({ task: "K&K · Landingpage · Austausch", note: "Call", begin: "2026-11-26T13:50", end: "" });
    expect(
      describeAction({ type: "start", mode: "switch", ...target, begin: null, preview }, catalog),
    ).toMatchObject({ begin: "" });
    expect(
      describeAction(
        { type: "log", ...target, begin: "2026-11-26T09:00:00", end: "2026-11-26T10:00:00" },
        catalog,
      ),
    ).toMatchObject({ begin: "2026-11-26T09:00", end: "2026-11-26T10:00" });
    expect(
      describeAction(
        {
          type: "batch",
          timer: null,
          label: "",
          entries: [
            { projectId: 11, activityId: 4, description: "", begin: "2026-11-26T13:20:00", end: "2026-11-26T13:45:00" },
            { projectId: 99, activityId: 9, description: "x", begin: "2026-11-26T13:45:00", end: "2026-11-26T13:55:00" },
          ],
        },
        catalog,
      ),
    ).toEqual([
      { task: "DUSW · Retainer · Design", note: "", begin: "2026-11-26T13:20", end: "2026-11-26T13:45" },
      { task: "?", note: "x", begin: "2026-11-26T13:45", end: "2026-11-26T13:55" },
    ]);
    expect(describeAction({ type: "command", command: "stop" }, catalog)).toEqual({ command: "stop" });
    expect(describeAction({ type: "note", text: "Angebot" }, catalog)).toEqual({
      noteForRunningTimer: "Angebot",
    });
  });
});

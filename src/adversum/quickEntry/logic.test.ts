// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getTimesheets: vi.fn(),
  restartTimesheet: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../api/timesheetApi", () => ({
  getTimesheets: mocks.getTimesheets,
  restartTimesheet: mocks.restartTimesheet,
}));

import { actionForSuggestion } from "./actions";
import { loadInterruptLink, saveInterruptLink } from "./interruptLink";
import type { QuickSuggestion } from "./parse";
import { interruptMenuEntries, registerPopupQuick, typingToQuickEntry } from "./popupBridge";
import {
  createFinishedEntry,
  fetchHistory,
  hideQuickWindow,
  reopenTimesheet,
  resizeQuickWindow,
  showQuickToast,
} from "./quickApi";

const now = new Date(2026, 10, 26, 10, 20);

const suggestion: QuickSuggestion = {
  combination: {
    key: "11-1",
    customerId: 1,
    customer: "DUSW Unternehmensgruppe",
    customerColor: "#0f766e",
    projectId: 11,
    project: "Marketing Retainer",
    activityId: 1,
    activity: "Projektmanagement",
    activityColor: "#10b981",
  },
  note: "Gigi Call",
  score: 20,
  textScore: 2,
  matchedWords: 2,
  namesTarget: true,
  words: { customer: ["dusw"], project: [], activity: ["pm"] },
};

function timesheet(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    begin: "2026-11-25T09:00:00+0100",
    end: "2026-11-25T10:00:00+0100",
    duration: 3600,
    description: "",
    billable: true,
    tags: [],
    project: 11,
    activity: { id: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  registerPopupQuick(null);
});

describe("actionForSuggestion", () => {
  it("starts now, with the note and a preview for the pending card", () => {
    expect(actionForSuggestion(suggestion, { kind: "none" }, "switch")).toEqual({
      type: "start",
      mode: "switch",
      projectId: 11,
      activityId: 1,
      description: "Gigi Call",
      label: "DUSW Unternehmensgruppe · Projektmanagement",
      begin: null,
      preview: {
        projectId: 11,
        project: "Marketing Retainer",
        activity: "Projektmanagement",
        projectColor: "",
        activityColor: "#10b981",
        customerColor: "#0f766e",
        description: "Gigi Call",
      },
    });
  });

  it("starts in the past with Kimai's local time format", () => {
    const action = actionForSuggestion(
      { ...suggestion, note: "" },
      { kind: "start", begin: new Date(2026, 10, 26, 9, 45) },
      "interrupt",
    );
    expect(action).toMatchObject({ type: "start", mode: "interrupt", begin: "2026-11-26T09:45:00" });
    expect(action.type === "start" && "description" in action.preview).toBe(false);
    expect(actionForSuggestion(suggestion, { kind: "future" }, "switch")).toMatchObject({
      type: "start",
      begin: null,
    });
  });

  it("logs a finished entry for a time range", () => {
    expect(
      actionForSuggestion(
        suggestion,
        { kind: "range", begin: new Date(2026, 10, 26, 9, 0), end: new Date(2026, 10, 26, 10, 30) },
        "switch",
      ),
    ).toEqual({
      type: "log",
      projectId: 11,
      activityId: 1,
      description: "Gigi Call",
      label: "DUSW Unternehmensgruppe · Projektmanagement",
      begin: "2026-11-26T09:00:00",
      end: "2026-11-26T10:30:00",
    });
  });
});

describe("interrupt link storage", () => {
  it("stores one link per connection and clears it again", () => {
    expect(loadInterruptLink("conn")).toBeNull();
    saveInterruptLink("conn", { timesheetId: 9, pausedId: "p1" });
    expect(loadInterruptLink("conn")).toEqual({ timesheetId: 9, pausedId: "p1" });
    expect(loadInterruptLink("other")).toBeNull();
    saveInterruptLink("conn", null);
    expect(loadInterruptLink("conn")).toBeNull();
  });

  it("ignores unreadable or malformed storage", () => {
    for (const stored of ["{", '"text"', '{"timesheetId":"9","pausedId":"p"}', '{"timesheetId":9}']) {
      localStorage.setItem("adversum:interrupt:conn", stored);
      expect(loadInterruptLink("conn")).toBeNull();
    }
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveInterruptLink("conn", { timesheetId: 1, pausedId: "p" })).not.toThrow();
    setItem.mockRestore();
  });
});

describe("popup bridge", () => {
  const task = {
    projectId: 11, activityId: 1, project: "P", activity: "A", customer: "C",
    description: "", projectColor: "", activityColor: "", customerColor: "",
  };

  it("is inert until the quick entry layer registers", () => {
    const upstream = vi.fn();
    typingToQuickEntry(upstream)("d");
    expect(upstream).toHaveBeenCalledWith("d");
    expect(interruptMenuEntries(task, "In between", false)).toEqual([]);
  });

  it("routes typing and context menu starts to the registered layer", () => {
    const handlers = { focus: vi.fn(), startInterrupt: vi.fn() };
    registerPopupQuick(handlers);
    const upstream = vi.fn();
    typingToQuickEntry(upstream)("d");
    expect(handlers.focus).toHaveBeenCalledWith("d");
    expect(upstream).not.toHaveBeenCalled();

    const [entry] = interruptMenuEntries(task, "In between", true);
    expect(entry).toMatchObject({ text: "In between", enabled: false });
    (entry as unknown as { action: () => void }).action();
    expect(handlers.startInterrupt).toHaveBeenCalledWith(task);
    expect(interruptMenuEntries(task, "In between", undefined)[0]).toMatchObject({ enabled: true });
  });
});

describe("quick window commands", () => {
  it("call the native commands", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await hideQuickWindow();
    await showQuickToast(true);
    await resizeQuickWindow(120);
    expect(mocks.invoke.mock.calls).toEqual([
      ["adversum_quick_hide"],
      ["adversum_quick_toast", { undoable: true }],
      ["adversum_quick_resize", { height: 120 }],
    ]);
  });
});

describe("fetchHistory", () => {
  const client = {} as KimaiClient;

  it("reads 90 days of entries page by page", async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => timesheet(index + 1));
    mocks.getTimesheets
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([
        timesheet(501, { project: { id: 21 }, activity: 7, description: "Gigi Call" }),
      ]);
    const entries = await fetchHistory(client, now);
    expect(entries).toHaveLength(501);
    expect(entries[0]).toEqual({
      projectId: 11,
      activityId: 1,
      begin: new Date("2026-11-25T09:00:00+01:00"),
      description: "",
    });
    // The note comes along: spoken input finds tasks through names in notes.
    expect(entries[500]).toMatchObject({ projectId: 21, activityId: 7, description: "Gigi Call" });
    expect(mocks.getTimesheets).toHaveBeenNthCalledWith(1, client, {
      begin: "2026-08-28T00:00:00",
      size: 500,
      page: 1,
      orderBy: "begin",
      order: "DESC",
    });
    expect(mocks.getTimesheets).toHaveBeenNthCalledWith(2, client, expect.objectContaining({ page: 2 }));
  });

  it("treats a failing later page as the end and stops after ten pages", async () => {
    const fullPage = Array.from({ length: 500 }, (_, index) => timesheet(index + 1));
    mocks.getTimesheets.mockResolvedValueOnce(fullPage).mockRejectedValueOnce(new Error("404"));
    await expect(fetchHistory(client, now)).resolves.toHaveLength(500);

    mocks.getTimesheets.mockReset().mockResolvedValue(fullPage);
    await expect(fetchHistory(client, now)).resolves.toHaveLength(5000);
    expect(mocks.getTimesheets).toHaveBeenCalledTimes(10);
  });

  it("fails when the first page fails", async () => {
    mocks.getTimesheets.mockRejectedValue(new Error("offline"));
    await expect(fetchHistory(client, now)).rejects.toThrow("offline");
  });
});

describe("createFinishedEntry", () => {
  const entry = { projectId: 11, activityId: 1, begin: "2026-11-26T09:00:00", end: "2026-11-26T10:00:00" };

  it("posts an entry with begin and end", async () => {
    const post = vi.fn().mockResolvedValue(timesheet(77));
    const client = { post } as unknown as KimaiClient;
    await expect(createFinishedEntry(client, { ...entry, description: "Call" })).resolves.toMatchObject({ id: 77 });
    expect(post).toHaveBeenCalledWith("/api/timesheets", {
      project: 11,
      activity: 1,
      begin: "2026-11-26T09:00:00",
      end: "2026-11-26T10:00:00",
      description: "Call",
    });
    await createFinishedEntry(client, { ...entry, description: "" });
    expect(post.mock.lastCall![1]).not.toHaveProperty("description");
  });

  it("rejects a response that is not a time entry", async () => {
    const client = { post: vi.fn().mockResolvedValue({ ok: true }) } as unknown as KimaiClient;
    await expect(createFinishedEntry(client, { ...entry, description: "" })).rejects.toThrow(
      "Kimai returned an invalid time entry",
    );
  });
});

describe("reopenTimesheet", () => {
  it("clears the end so the entry simply continues", async () => {
    const reopened = timesheet(5, { end: null, duration: null });
    const patch = vi.fn().mockResolvedValue(reopened);
    await expect(reopenTimesheet({ patch } as unknown as KimaiClient, 5)).resolves.toBe(reopened);
    expect(patch).toHaveBeenCalledWith("/api/timesheets/5", { end: null });
    expect(mocks.restartTimesheet).not.toHaveBeenCalled();
  });

  it("restarts the entry where Kimai keeps or rejects the end", async () => {
    const restarted = timesheet(6, { end: null });
    mocks.restartTimesheet.mockResolvedValue(restarted);
    const kept = { patch: vi.fn().mockResolvedValue(timesheet(5)) } as unknown as KimaiClient;
    await expect(reopenTimesheet(kept, 5)).resolves.toBe(restarted);
    const rejecting = { patch: vi.fn().mockRejectedValue(new Error("400")) } as unknown as KimaiClient;
    await expect(reopenTimesheet(rejecting, 5)).resolves.toBe(restarted);
    expect(mocks.restartTimesheet).toHaveBeenCalledTimes(2);
    expect(mocks.restartTimesheet).toHaveBeenCalledWith(rejecting, 5);
  });
});

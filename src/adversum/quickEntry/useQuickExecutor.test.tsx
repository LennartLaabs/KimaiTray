// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KimaiClient } from "../../api/kimaiClient";
import type { PausedTimerData } from "../../api/pauseStore";
import type { ActiveTimer, RecentTask } from "../../types";
import type { QuickAction } from "./actions";

const mocks = vi.hoisted(() => ({
  emitTo: vi.fn(),
  listen: vi.fn(),
  deleteTimesheet: vi.fn(),
  getActiveTimesheets: vi.fn(),
  updateTimesheet: vi.fn(),
  createFinishedEntry: vi.fn(),
  reopenTimesheet: vi.fn(),
  invalidateTimesheets: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: mocks.listen }),
}));
vi.mock("../../api/timesheetApi", () => ({
  deleteTimesheet: mocks.deleteTimesheet,
  getActiveTimesheets: mocks.getActiveTimesheets,
  updateTimesheet: mocks.updateTimesheet,
}));
vi.mock("./quickApi", () => ({
  createFinishedEntry: mocks.createFinishedEntry,
  reopenTimesheet: mocks.reopenTimesheet,
}));
vi.mock("../../hooks/invalidateTimesheets", () => ({
  invalidateTimesheets: mocks.invalidateTimesheets,
}));
vi.mock("../../hooks/timerOperationLock", () => ({ acquireTimerOperation: mocks.acquire }));
vi.mock("../../utils/logger", () => ({ logger: { error: mocks.loggerError } }));

import { loadInterruptLink, saveInterruptLink } from "./interruptLink";
import {
  PREVIOUS_TASK_EVENT,
  QUICK_EXECUTE_EVENT,
  QUICK_TOAST_EVENT,
  QUICK_UNDO_EVENT,
  QUICK_UNDO_LATEST_EVENT,
  TOAST_DURATION_MS,
} from "./quickEvents";
import { useQuickExecutor, type QuickExecutorOptions } from "./useQuickExecutor";

const client = { connectionId: "conn", cacheScope: "conn:1" } as unknown as KimaiClient;

function timer(id: number, project = "Marketing Retainer", activity = "Projektmanagement"): ActiveTimer {
  return {
    id, projectId: 11, activityId: 1, project, activity, projectColor: "", activityColor: "",
    customerColor: "", description: "", tags: [], beginSeconds: 0, beginIso: "",
  };
}

function paused(id: string, lastTimesheetId: number, pausedAt = "2026-11-26T10:00:00.000Z"): PausedTimerData {
  return {
    id, connectionId: "conn", lastTimesheetId, projectId: 11, activityId: 1,
    project: "Marketing Retainer", activity: "Projektmanagement", projectColor: "",
    activityColor: "", customerColor: "", description: "", tags: [], pausedAt,
  };
}

const recent: RecentTask = {
  key: "21-2:Call", projectId: 21, activityId: 2, timesheetId: 90, project: "Social Media",
  activity: "Austausch", customer: "Herosmile", description: "Call", tags: ["a"],
  projectColor: "", activityColor: "", customerColor: "", lastUsed: "today",
};

const startAction: QuickAction = {
  type: "start", mode: "switch", projectId: 21, activityId: 2, description: "Call",
  begin: "2026-11-26T09:45:00", label: "Herosmile · Austausch",
  preview: { projectId: 21, project: "Social Media", activity: "Austausch", projectColor: "", activityColor: "", customerColor: "" },
};

let handlers: Record<string, (event: { payload: unknown }) => void>;
let options: QuickExecutorOptions;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function setup(overrides: Partial<QuickExecutorOptions> = {}) {
  options = { ...options, ...overrides };
  return renderHook((props: QuickExecutorOptions) => useQuickExecutor(props), {
    wrapper,
    initialProps: options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  handlers = {};
  mocks.listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers[event] = handler;
    return vi.fn();
  });
  mocks.emitTo.mockResolvedValue(undefined);
  mocks.acquire.mockReturnValue(mocks.release);
  mocks.invalidateTimesheets.mockResolvedValue(undefined);
  mocks.deleteTimesheet.mockResolvedValue(undefined);
  mocks.getActiveTimesheets.mockResolvedValue([]);
  mocks.updateTimesheet.mockResolvedValue({});
  mocks.reopenTimesheet.mockResolvedValue({});
  options = {
    client,
    connectionId: "conn",
    timersReady: true,
    timers: [],
    pausedTimers: [],
    recentTasks: [],
    busy: false,
    startTask: vi.fn().mockResolvedValue({ id: 500 }),
    pauseTimer: vi.fn(),
    resumeTimer: vi.fn(),
    discardPausedTimer: vi.fn(),
    stopActiveTimer: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("starting a task", () => {
  it("starts it, confirms with an undoable toast and tells the quick window", async () => {
    const { result } = setup({ timers: [timer(7)] });
    await act(() => result.current.execute(startAction));
    expect(options.startTask).toHaveBeenCalledWith(
      { projectId: 21, activityId: 2, description: "Call", begin: "2026-11-26T09:45:00", label: "Herosmile · Austausch" },
      undefined,
      startAction.preview,
    );
    expect(result.current.toast).toEqual({ id: 1, kind: "started", label: "Herosmile · Austausch", undoable: true });
    expect(mocks.emitTo).toHaveBeenCalledWith("adversum-quick", QUICK_TOAST_EVENT, result.current.toast);
    expect(options.pauseTimer).not.toHaveBeenCalled();
  });

  it("starts now without a note and survives a missing quick window", async () => {
    mocks.emitTo.mockRejectedValue(new Error("no window"));
    const { result } = setup();
    await act(() => result.current.execute({ ...startAction, description: "", begin: null }));
    expect(vi.mocked(options.startTask).mock.calls[0]![0]).toEqual({
      projectId: 21, activityId: 2, description: undefined, begin: undefined, label: "Herosmile · Austausch",
    });
    expect(result.current.toast?.kind).toBe("started");
  });

  it("reports a failed start and a missing connection", async () => {
    const { result, rerender } = setup({ startTask: vi.fn().mockResolvedValue(null) });
    await act(() => result.current.execute(startAction));
    expect(result.current.toast).toMatchObject({ kind: "failed", label: "Herosmile · Austausch", undoable: false });

    rerender({ ...options, client: null });
    await act(() => result.current.execute(startAction));
    expect(result.current.toast).toMatchObject({ id: 2, kind: "failed" });
    await act(() => result.current.execute({ type: "command", command: "stop" }));
    expect(result.current.toast).toMatchObject({ kind: "failed", label: "" });
  });

  it("logs and reports an unexpected error", async () => {
    const { result } = setup({ startTask: vi.fn().mockRejectedValue(new Error("boom")) });
    await act(() => result.current.execute(startAction));
    expect(mocks.loggerError).toHaveBeenCalledWith("Quick action failed: Error: boom");
    expect(result.current.toast?.kind).toBe("failed");
  });

  it("drops the toast and the chance to undo after a few seconds", async () => {
    vi.useFakeTimers();
    const { result } = setup();
    await act(() => result.current.execute(startAction));
    expect(result.current.toast).not.toBeNull();
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS));
    expect(result.current.toast).toBeNull();
    await act(() => result.current.undo(1));
    expect(mocks.deleteTimesheet).not.toHaveBeenCalled();
  });
});

describe("undo", () => {
  it("deletes the new entry and lets the stopped ones run again", async () => {
    mocks.getActiveTimesheets.mockResolvedValue([{ id: 8 }]);
    const { result } = setup({ timers: [timer(7), timer(8)] });
    await act(() => result.current.execute(startAction));
    await act(() => result.current.undo(1));
    expect(mocks.acquire).toHaveBeenCalledWith(expect.anything(), "conn:1");
    expect(mocks.deleteTimesheet).toHaveBeenCalledWith(client, 500);
    // Entry 8 kept running under the server's limit; only 7 is reopened.
    expect(mocks.reopenTimesheet.mock.calls).toEqual([[client, 7]]);
    expect(mocks.release).toHaveBeenCalled();
    expect(mocks.invalidateTimesheets).toHaveBeenCalled();
    expect(result.current.toast).toMatchObject({ id: 2, kind: "undone", undoable: false });
    expect(options.discardPausedTimer).not.toHaveBeenCalled();

    // The same toast cannot be undone twice.
    await act(() => result.current.undo(1));
    expect(mocks.deleteTimesheet).toHaveBeenCalledTimes(1);
  });

  it("ignores an unknown toast and reports a busy lock or a failing server", async () => {
    const { result } = setup();
    await act(() => result.current.execute(startAction));
    await act(() => result.current.undo(99));
    expect(mocks.deleteTimesheet).not.toHaveBeenCalled();

    mocks.acquire.mockReturnValueOnce(null);
    await act(() => result.current.undo(1));
    expect(result.current.toast?.kind).toBe("failed");
    expect(mocks.deleteTimesheet).not.toHaveBeenCalled();

    await act(() => result.current.execute(startAction));
    mocks.deleteTimesheet.mockRejectedValueOnce(new Error("gone"));
    await act(() => result.current.undo(result.current.toast!.id));
    expect(mocks.loggerError).toHaveBeenCalledWith("Undo failed: Error: gone");
    expect(result.current.toast?.kind).toBe("failed");
    expect(mocks.release).toHaveBeenCalled();
  });

  it("removes a logged entry without touching timers", async () => {
    mocks.createFinishedEntry.mockResolvedValue({ id: 321 });
    const { result } = setup({ timers: [timer(7)] });
    const log: QuickAction = {
      type: "log", projectId: 21, activityId: 2, description: "", label: "Herosmile · Austausch",
      begin: "2026-11-26T09:00:00", end: "2026-11-26T10:00:00",
    };
    await act(() => result.current.execute(log));
    expect(mocks.createFinishedEntry).toHaveBeenCalledWith(client, log);
    expect(options.startTask).not.toHaveBeenCalled();
    expect(result.current.toast).toMatchObject({ kind: "logged", undoable: true });
    await act(() => result.current.undo(1));
    expect(mocks.deleteTimesheet).toHaveBeenCalledWith(client, 321);
    expect(mocks.getActiveTimesheets).not.toHaveBeenCalled();
  });
});

describe("what voice input adds", () => {
  it("shows what was learned with the confirmation of a start or a logged entry", async () => {
    mocks.createFinishedEntry.mockResolvedValue({ id: 321 });
    const { result } = setup();
    await act(() => result.current.execute(startAction, "„kaka“ = K&K"));
    expect(result.current.toast).toEqual({
      id: 1, kind: "started", label: "Herosmile · Austausch", undoable: true, detail: "„kaka“ = K&K",
    });
    const log: QuickAction = {
      type: "log", projectId: 21, activityId: 2, description: "", label: "Herosmile · Austausch",
      begin: "2026-11-26T09:00:00", end: "2026-11-26T10:00:00",
    };
    await act(() => result.current.execute(log, "„kaka“ = K&K"));
    expect(result.current.toast).toMatchObject({ kind: "logged", detail: "„kaka“ = K&K" });
  });

  it("adds a line to the note of the running timer", async () => {
    const running = { ...timer(7), description: "Gigi Call" };
    const { result, rerender } = setup({ timers: [running] });
    await act(() => result.current.execute({ type: "note", text: "Angebot nachfassen" }));
    expect(mocks.updateTimesheet).toHaveBeenCalledWith(client, 7, {
      description: "Gigi Call\nAngebot nachfassen",
    });
    expect(mocks.invalidateTimesheets).toHaveBeenCalled();
    expect(result.current.toast).toEqual({
      id: 1, kind: "noted", label: "Marketing Retainer · Projektmanagement", undoable: false,
    });

    // A timer without a note gets the text as its note.
    options = { ...options, timers: [timer(8)] };
    rerender(options);
    await act(() => result.current.execute({ type: "note", text: "Erster Eintrag" }));
    expect(mocks.updateTimesheet).toHaveBeenLastCalledWith(client, 8, { description: "Erster Eintrag" });
  });

  it("says so when no timer runs, and reports a failing update", async () => {
    const { result, rerender } = setup();
    await act(() => result.current.execute({ type: "note", text: "Angebot" }));
    expect(result.current.toast).toMatchObject({ kind: "nothing", label: "" });
    expect(mocks.updateTimesheet).not.toHaveBeenCalled();

    mocks.updateTimesheet.mockRejectedValue(new Error("403"));
    options = { ...options, timers: [timer(7)] };
    rerender(options);
    await act(() => result.current.execute({ type: "note", text: "Angebot" }));
    expect(result.current.toast).toMatchObject({ kind: "failed", label: "" });
  });
});

describe("starting in between", () => {
  const between: QuickAction = { ...startAction, mode: "interrupt" };

  it("pauses the running timer, starts the task and remembers the pair", async () => {
    const { result, rerender } = setup({ timers: [timer(7)] });
    let done = false;
    let run: Promise<void> = Promise.resolve();
    act(() => {
      run = result.current.execute(between).then(() => { done = true; });
    });
    expect(options.pauseTimer).toHaveBeenCalledWith(options.timers[0]);
    expect(options.startTask).not.toHaveBeenCalled();
    // The pause has completed: the timer is gone and its paused stand-in exists.
    rerender({ ...options, timers: [], pausedTimers: [paused("p1", 7)] });
    await act(() => run);
    expect(done).toBe(true);
    expect(options.startTask).toHaveBeenCalledTimes(1);
    expect(loadInterruptLink("conn")).toEqual({ timesheetId: 500, pausedId: "p1" });
    expect(result.current.toast).toMatchObject({ kind: "started", undoable: true });
    // The new entry is not listed as running yet; the paused timer must wait.
    expect(options.resumeTimer).not.toHaveBeenCalled();
    rerender({ ...options, timers: [timer(500)], pausedTimers: [paused("p1", 7)] });
    expect(loadInterruptLink("conn")).toEqual({ timesheetId: 500, pausedId: "p1" });

    // Undo reopens the interrupted entry and drops its paused stand-in.
    await act(() => result.current.undo(1));
    expect(mocks.reopenTimesheet.mock.calls).toEqual([[client, 7]]);
    expect(options.discardPausedTimer).toHaveBeenCalledWith("p1");
    expect(loadInterruptLink("conn")).toBeNull();
  });

  it("is a plain start when nothing is running", async () => {
    const { result } = setup();
    await act(() => result.current.execute(between));
    expect(options.pauseTimer).not.toHaveBeenCalled();
    expect(loadInterruptLink("conn")).toBeNull();
    expect(result.current.toast?.kind).toBe("started");
  });

  it("fails while another timer operation runs or when the pause never completes", async () => {
    const { result, rerender } = setup({ timers: [timer(7)], busy: true });
    await act(() => result.current.execute(between));
    expect(options.pauseTimer).not.toHaveBeenCalled();
    expect(result.current.toast?.kind).toBe("failed");

    vi.useFakeTimers();
    rerender({ ...options, busy: false });
    let run: Promise<void> = Promise.resolve();
    act(() => {
      run = result.current.execute(between);
    });
    // Still busy, then the timer is gone but no paused stand-in appears.
    rerender({ ...options, busy: true });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    rerender({ ...options, busy: false, timers: [] });
    await act(() => vi.advanceTimersByTimeAsync(16_000));
    await act(() => run);
    expect(options.startTask).not.toHaveBeenCalled();
    expect(result.current.toast).toMatchObject({ kind: "failed" });
  });

  it("keeps the paused timer when the start fails", async () => {
    const { result, rerender } = setup({
      timers: [timer(7)],
      startTask: vi.fn().mockResolvedValue(null),
    });
    let run: Promise<void> = Promise.resolve();
    act(() => {
      run = result.current.execute(between);
    });
    rerender({ ...options, timers: [], pausedTimers: [paused("p1", 7)] });
    await act(() => run);
    expect(result.current.toast?.kind).toBe("failed");
    expect(loadInterruptLink("conn")).toBeNull();
  });
});

describe("resuming after an in-between task", () => {
  it("resumes the interrupted timer when the task is stopped", async () => {
    saveInterruptLink("conn", { timesheetId: 500, pausedId: "p1" });
    const waiting = [paused("p1", 7)];
    const { rerender } = setup({ timers: [timer(500)], pausedTimers: waiting });
    expect(options.resumeTimer).not.toHaveBeenCalled();
    // Not while another operation is in flight or the list is loading.
    rerender({ ...options, timers: [], pausedTimers: waiting, busy: true });
    rerender({ ...options, timers: [], pausedTimers: waiting, timersReady: false });
    expect(options.resumeTimer).not.toHaveBeenCalled();
    rerender({ ...options, timers: [], pausedTimers: waiting });
    expect(options.resumeTimer).toHaveBeenCalledWith("p1");
    expect(loadInterruptLink("conn")).toBeNull();
  });

  it.each([
    ["the user switched to another task", { timers: [timer(600)], pausedTimers: [paused("p1", 7)] }],
    ["the task itself was paused", { timers: [], pausedTimers: [paused("p1", 7), paused("p2", 500)] }],
    ["the paused timer is gone", { timers: [], pausedTimers: [] }],
  ])("does not resume when %s", (_label, after) => {
    saveInterruptLink("conn", { timesheetId: 500, pausedId: "p1" });
    const { rerender } = setup({ timers: [timer(500)], pausedTimers: [paused("p1", 7)] });
    rerender({ ...options, ...after });
    expect(options.resumeTimer).not.toHaveBeenCalled();
    expect(loadInterruptLink("conn")).toBeNull();
  });

  it("forgets a link from an earlier session whose task is no longer running", () => {
    saveInterruptLink("conn", { timesheetId: 500, pausedId: "p1" });
    setup({ timers: [], pausedTimers: [paused("p1", 7)] });
    expect(options.resumeTimer).not.toHaveBeenCalled();
    expect(loadInterruptLink("conn")).toBeNull();
  });

  it("reads the link of the current connection", () => {
    saveInterruptLink("other", { timesheetId: 1, pausedId: "x" });
    const { rerender } = setup({ connectionId: "" });
    rerender({ ...options, connectionId: "other", timers: [timer(1)] });
    expect(loadInterruptLink("other")).toEqual({ timesheetId: 1, pausedId: "x" });
  });
});

describe("commands", () => {
  it("stops and pauses the running timer", async () => {
    const running = timer(7);
    const { result } = setup({ timers: [running] });
    await act(() => result.current.execute({ type: "command", command: "stop" }));
    expect(options.stopActiveTimer).toHaveBeenCalledWith(running);
    expect(result.current.toast).toMatchObject({
      kind: "stopped", label: "Marketing Retainer · Projektmanagement", undoable: false,
    });
    await act(() => result.current.execute({ type: "command", command: "pause" }));
    expect(options.pauseTimer).toHaveBeenCalledWith(running);
    expect(result.current.toast?.kind).toBe("paused");
  });

  it("resumes the most recently paused timer", async () => {
    const { result } = setup({
      pausedTimers: [paused("old", 1, "2026-11-26T08:00:00.000Z"), paused("new", 2, "2026-11-26T09:00:00.000Z")],
    });
    await act(() => result.current.execute({ type: "command", command: "resume" }));
    expect(options.resumeTimer).toHaveBeenCalledWith("new");
    expect(result.current.toast?.kind).toBe("resumed");
  });

  it("says so when there is nothing to stop, pause, resume or go back to", async () => {
    const { result } = setup();
    for (const command of ["stop", "pause", "resume", "previous"] as const) {
      await act(() => result.current.execute({ type: "command", command }));
      expect(result.current.toast?.kind).toBe("nothing");
    }
    expect(options.startTask).not.toHaveBeenCalled();
  });

  it("switches to the previous task with its note and tags, undoably", async () => {
    const { result, rerender } = setup({ timers: [timer(7)], recentTasks: [recent] });
    await act(() => result.current.execute({ type: "command", command: "previous" }));
    expect(options.startTask).toHaveBeenCalledWith(
      { projectId: 21, activityId: 2, description: "Call", tags: ["a"], label: "Herosmile · Austausch" },
      "21-2:Call",
      recent,
    );
    expect(result.current.toast).toMatchObject({ kind: "started", label: "Herosmile · Austausch", undoable: true });
    await act(() => result.current.undo(1));
    expect(mocks.reopenTimesheet).toHaveBeenCalledWith(client, 7);

    const bare = { ...recent, customer: "", description: "", tags: [] };
    rerender({ ...options, recentTasks: [bare], startTask: vi.fn().mockResolvedValue(null) });
    await act(() => result.current.execute({ type: "command", command: "previous" }));
    expect(result.current.toast).toMatchObject({ kind: "failed", label: "Social Media · Austausch" });
  });
});

describe("requests from other windows and shortcuts", () => {
  it("executes, undoes and switches back on events", async () => {
    const { result, unmount } = setup({ recentTasks: [recent] });
    await waitFor(() => expect(Object.keys(handlers)).toHaveLength(4));

    await act(async () =>
      handlers[QUICK_EXECUTE_EVENT]!({ payload: { action: startAction, learned: "„pm“ = PM" } }),
    );
    await waitFor(() => expect(result.current.toast?.kind).toBe("started"));
    expect(result.current.toast?.detail).toBe("„pm“ = PM");

    await act(async () => handlers[QUICK_UNDO_EVENT]!({ payload: { id: result.current.toast!.id } }));
    await waitFor(() => expect(result.current.toast?.kind).toBe("undone"));

    await act(async () => handlers[PREVIOUS_TASK_EVENT]!({ payload: null }));
    await waitFor(() => expect(options.startTask).toHaveBeenCalledTimes(2));

    // Cmd+Z undoes whatever the current toast offers, and nothing otherwise.
    await waitFor(() => expect(result.current.toast?.undoable).toBe(true));
    mocks.deleteTimesheet.mockClear();
    await act(async () => handlers[QUICK_UNDO_LATEST_EVENT]!({ payload: null }));
    await waitFor(() => expect(result.current.toast?.kind).toBe("undone"));
    expect(mocks.deleteTimesheet).toHaveBeenCalledTimes(1);
    await act(async () => handlers[QUICK_UNDO_LATEST_EVENT]!({ payload: null }));
    expect(mocks.deleteTimesheet).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("survives a window without event support", () => {
    mocks.listen.mockRejectedValue(new Error("no events"));
    const { unmount } = setup();
    expect(() => unmount()).not.toThrow();
  });
});

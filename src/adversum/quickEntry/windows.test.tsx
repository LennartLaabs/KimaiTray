// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings } from "../settings/adversumSettings";
import type { QuickExecutorOptions } from "./useQuickExecutor";

const mocks = vi.hoisted(() => ({
  kimai: { client: null as unknown, isConfigured: true, activeConnectionId: "conn" },
  settings: { settings: {} as unknown },
  getProjects: vi.fn(),
  getCustomers: vi.fn(),
  getActivities: vi.fn(),
  fetchHistory: vi.fn(),
  hideQuickWindow: vi.fn(),
  releaseQuickWindowFocus: vi.fn(),
  resizeQuickWindow: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(),
  onFocusChanged: vi.fn(),
  loadSettings: vi.fn(),
  onSettingsChange: vi.fn(),
  executor: { execute: vi.fn(), undo: vi.fn(), toast: null as unknown },
  useQuickExecutor: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
vi.mock("../../hooks/useKimaiClient", () => ({ useKimaiClient: () => mocks.kimai }));
vi.mock("../../hooks/useLanguageSync", () => ({ useLanguageSync: vi.fn() }));
vi.mock("../settings/useAdversumSettings", () => ({ useAdversumSettings: () => mocks.settings }));
vi.mock("../../api/projectApi", () => ({
  getProjects: mocks.getProjects,
  getCustomers: mocks.getCustomers,
}));
vi.mock("../../api/activityApi", () => ({ getActivities: mocks.getActivities }));
vi.mock("./quickApi", () => ({
  fetchHistory: mocks.fetchHistory,
  hideQuickWindow: mocks.hideQuickWindow,
  releaseQuickWindowFocus: mocks.releaseQuickWindowFocus,
  resizeQuickWindow: mocks.resizeQuickWindow,
}));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: mocks.listen, onFocusChanged: mocks.onFocusChanged }),
}));
vi.mock("../../settings/service", () => ({
  loadSettings: mocks.loadSettings,
  onSettingsChange: mocks.onSettingsChange,
}));
vi.mock("./useQuickExecutor", () => ({ useQuickExecutor: mocks.useQuickExecutor }));
vi.mock("../../utils/logger", () => ({ logger: { error: mocks.loggerError } }));

import { setAdversumDisplay } from "../display/displayStore";
import AdversumPopupQuick from "./AdversumPopupQuick";
import { interruptMenuEntries, typingToQuickEntry } from "./popupBridge";
import QuickEntryWindow from "./QuickEntryWindow";
import {
  QUICK_EXECUTE_EVENT,
  QUICK_SHOWN_EVENT,
  QUICK_TOAST_EVENT,
  QUICK_UNDO_EVENT,
  TOAST_DURATION_MS,
} from "./quickEvents";
import { useQuickEntryData } from "./useQuickEntryData";
import { useQuickTheme } from "./useQuickTheme";

const client = { connectionId: "conn", cacheScope: "conn:1" };
const display = { indicator: "logo" as const, customersByProject: new Map(), logos: new Map([[1, "data:image/png;base64,AAAA"]]) };
const DAY = 86_400_000;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

let windowHandlers: Record<string, (event: { payload: unknown }) => void>;
let focusHandler: (event: { payload: boolean }) => void;
let observed: Element[];
let observerCallback: () => void;

class FakeResizeObserver {
  constructor(callback: () => void) {
    observerCallback = callback;
  }
  observe(element: Element) {
    observed.push(element);
  }
  disconnect() {
    observed = [];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  windowHandlers = {};
  observed = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  mocks.kimai = { client, isConfigured: true, activeConnectionId: "conn" };
  mocks.settings = {
    settings: {
      ...defaultAdversumSettings,
      aliases: { conn: { customers: {}, projects: {}, activities: { "1": ["pm"] } } },
    },
  };
  mocks.getCustomers.mockResolvedValue([{ id: 1, name: "DUSW" }, { id: 2, name: "Herosmile" }]);
  mocks.getProjects.mockResolvedValue([
    { id: 11, name: "Retainer", customer: 1 },
    { id: 21, name: "Social", customer: 2 },
  ]);
  mocks.getActivities.mockResolvedValue([{ id: 1, name: "Projektmanagement", project: null }]);
  mocks.fetchHistory.mockResolvedValue([
    { projectId: 11, activityId: 1, begin: new Date(Date.now() - DAY) },
    { projectId: 11, activityId: 1, begin: new Date(Date.now() - 2 * DAY) },
    { projectId: 21, activityId: 1, begin: new Date(Date.now() - DAY) },
  ]);
  mocks.listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    windowHandlers[event] = handler;
    return vi.fn();
  });
  mocks.onFocusChanged.mockImplementation(async (handler: (event: { payload: boolean }) => void) => {
    focusHandler = handler;
    return vi.fn();
  });
  for (const mock of [mocks.hideQuickWindow, mocks.releaseQuickWindowFocus, mocks.resizeQuickWindow, mocks.emitTo]) {
    mock.mockResolvedValue(undefined);
  }
  mocks.loadSettings.mockResolvedValue({ theme: "dark", accentStyle: "purple" });
  mocks.onSettingsChange.mockResolvedValue(vi.fn());
  mocks.executor = { execute: vi.fn().mockResolvedValue(undefined), undo: vi.fn().mockResolvedValue(undefined), toast: null };
  mocks.useQuickExecutor.mockImplementation(() => mocks.executor);
});
afterEach(() => {
  cleanup();
  setAdversumDisplay(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.documentElement.className = "";
});

describe("useQuickEntryData", () => {
  it("builds the catalog with aliases and the history for a connection", async () => {
    const aliases = { customers: {}, projects: {}, activities: { "1": ["pm"] } };
    const { result } = renderHook(
      () => useQuickEntryData(client as never, true, aliases),
      { wrapper },
    );
    expect(result.current.ready).toBe(false);
    expect(result.current.catalog.combinations).toEqual([]);
    await waitFor(() => expect(result.current.ready).toBe(true));
    await waitFor(() => expect(result.current.history.maxCount).toBe(2));
    expect(result.current.catalog.combinations.map((item) => item.key)).toEqual(["11-1", "21-1"]);
    expect(result.current.catalog.activities.get(1)?.aliases).toEqual(["pm"]);
    expect(mocks.fetchHistory).toHaveBeenCalledWith(client, expect.any(Date));
  });

  it("loads nothing while disabled or without a client", async () => {
    renderHook(() => useQuickEntryData(client as never, false, undefined), { wrapper });
    renderHook(() => useQuickEntryData(null, true, undefined), { wrapper });
    await Promise.resolve();
    expect(mocks.getProjects).not.toHaveBeenCalled();
    expect(mocks.fetchHistory).not.toHaveBeenCalled();
  });
});

describe("useQuickTheme", () => {
  it("applies the theme and accent and follows changes", async () => {
    let change: (settings: unknown) => void = () => undefined;
    mocks.onSettingsChange.mockImplementation(async (callback: (settings: unknown) => void) => {
      change = callback;
      return vi.fn();
    });
    const { unmount } = renderHook(() => useQuickTheme());
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(document.documentElement.dataset.accent).toBe("purple");

    act(() => change({ theme: "light", accentStyle: "green" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.dataset.accent).toBe("green");

    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    act(() => change({ theme: "transparent", accentStyle: "green" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    unmount();
    act(() => change({ theme: "light", accentStyle: "red" }));
    expect(document.documentElement.dataset.accent).toBe("green");
  });

  it("survives a window without settings events", async () => {
    mocks.onSettingsChange.mockRejectedValue(new Error("no events"));
    const { unmount } = renderHook(() => useQuickTheme());
    await waitFor(() => expect(mocks.loadSettings).toHaveBeenCalled());
    expect(() => unmount()).not.toThrow();
  });
});

describe("AdversumPopupQuick", () => {
  const options: QuickExecutorOptions = {
    client: client as never, connectionId: "conn", timersReady: true, timers: [], pausedTimers: [],
    recentTasks: [], busy: false, startTask: vi.fn(), pauseTimer: vi.fn(), resumeTimer: vi.fn(),
    discardPausedTimer: vi.fn(), stopActiveTimer: vi.fn(),
  };
  const task = {
    projectId: 21, activityId: 1, project: "Social", activity: "Projektmanagement",
    customer: "Herosmile", description: "Reel", projectColor: "#111111",
    activityColor: "#222222", customerColor: "#333333",
  };

  it("renders nothing and stays inert outside the running app", () => {
    const { container } = render(<AdversumPopupQuick {...options} />, { wrapper });
    expect(container.innerHTML).toBe("");
    expect(mocks.useQuickExecutor).not.toHaveBeenCalled();
    expect(interruptMenuEntries(task, "x", false)).toEqual([]);
  });

  it("shows the bar, runs its actions and takes over typing", async () => {
    setAdversumDisplay(display);
    const { unmount } = render(<AdversumPopupQuick {...options} />, { wrapper });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());

    const upstream = vi.fn();
    act(() => typingToQuickEntry(upstream)("d"));
    expect(upstream).not.toHaveBeenCalled();
    expect(input.value).toBe("d");
    expect(document.activeElement).toBe(input);

    await waitFor(() => {
      fireEvent.change(input, { target: { value: "dusw pm" } });
      expect(screen.getByRole("option", { selected: true })).toBeTruthy();
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start", projectId: 11, activityId: 1 }),
    );

    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);

    unmount();
    typingToQuickEntry(upstream)("x");
    expect(upstream).toHaveBeenCalledWith("x");
  });

  it("starts a task in between from a context menu", () => {
    setAdversumDisplay(display);
    render(<AdversumPopupQuick {...options} />, { wrapper });
    const [entry] = interruptMenuEntries(task, "In between", false);
    (entry as unknown as { action: () => void }).action();
    expect(mocks.executor.execute).toHaveBeenCalledWith({
      type: "start",
      mode: "interrupt",
      projectId: 21,
      activityId: 1,
      description: "Reel",
      begin: null,
      label: "Herosmile · Projektmanagement",
      preview: {
        projectId: 21, project: "Social", activity: "Projektmanagement", projectColor: "#111111",
        activityColor: "#222222", customerColor: "#333333", description: "Reel",
      },
    });
    const [bare] = interruptMenuEntries({ ...task, customer: "", description: "" }, "In between", false);
    (bare as unknown as { action: () => void }).action();
    const last = mocks.executor.execute.mock.lastCall![0];
    expect(last.label).toBe("Social · Projektmanagement");
    expect(last.preview).not.toHaveProperty("description");
  });

  it("hides the bar behind the new-task form and shows the toast with undo", () => {
    setAdversumDisplay(display);
    mocks.executor = {
      ...mocks.executor,
      toast: { id: 3, kind: "started", label: "DUSW · PM", undoable: true },
    };
    render(<AdversumPopupQuick {...options} hidden busy />, { wrapper });
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByText("adversum.quick.undo"));
    expect(mocks.executor.undo).toHaveBeenCalledWith(3);
  });
});

describe("QuickEntryWindow", () => {
  async function renderWindow() {
    const view = render(<QuickEntryWindow />, { wrapper });
    await waitFor(() => expect(Object.keys(windowHandlers)).toHaveLength(2));
    return view;
  }

  it("sends actions to the tray window and shows its confirmation", async () => {
    const { container } = await renderWindow();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(mocks.resizeQuickWindow).toHaveBeenCalled();
    expect(observed).toHaveLength(1);
    act(() => observerCallback());
    expect(mocks.resizeQuickWindow).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      fireEvent.change(input, { target: { value: "dusw pm" } });
      expect(screen.getByRole("option", { selected: true })).toBeTruthy();
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.emitTo).toHaveBeenCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
      action: expect.objectContaining({ type: "start", projectId: 11 }),
    });
    expect(mocks.releaseQuickWindowFocus).toHaveBeenCalled();
    expect(screen.getByText("adversum.quick.working")).toBeTruthy();
    expect(container.querySelector("[data-quick-stage='sent']")).not.toBeNull();

    // Giving the focus away for the confirmation must not close the bar.
    act(() => focusHandler({ payload: false }));
    expect(mocks.hideQuickWindow).not.toHaveBeenCalled();

    const toast = { id: 9, kind: "started", label: "DUSW · Projektmanagement", undoable: true };
    act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: toast }));
    expect(screen.getByRole("status").textContent).toContain("adversum.quick.toast.started");
    fireEvent.click(screen.getByText("adversum.quick.undo"));
    expect(mocks.emitTo).toHaveBeenCalledWith("tray-popup", QUICK_UNDO_EVENT, { id: 9 });
  });

  it("closes after the confirmation, or when none arrives", async () => {
    await renderWindow();
    vi.useFakeTimers();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "stop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    act(() => vi.advanceTimersByTime(5999));
    expect(mocks.hideQuickWindow).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);

    act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: { id: 1, kind: "stopped", label: "x", undoable: false } }));
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(2);
  });

  it("returns to an empty, focused field every time it is shown", async () => {
    await renderWindow();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "stop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("combobox")).toBeNull();
    act(() => windowHandlers[QUICK_SHOWN_EVENT]!({ payload: null }));
    const fresh = screen.getByRole("combobox") as HTMLInputElement;
    expect(fresh.value).toBe("");
    expect(document.activeElement).toBe(fresh);
  });

  it("closes on Escape and when it loses focus, and ignores foreign confirmations", async () => {
    mocks.hideQuickWindow.mockRejectedValueOnce(new Error("gone"));
    await renderWindow();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mocks.loggerError).toHaveBeenCalledWith("Quick entry window: Error: gone"),
    );
    act(() => focusHandler({ payload: true }));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
    act(() => focusHandler({ payload: false }));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(2);

    act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: { id: 1, kind: "started", label: "x", undoable: true } }));
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("asks for a connection first and survives missing window events", async () => {
    mocks.kimai = { client: null, isConfigured: false, activeConnectionId: "" };
    mocks.listen.mockRejectedValue(new Error("no events"));
    mocks.onFocusChanged.mockRejectedValue(new Error("no events"));
    const { unmount } = render(<QuickEntryWindow />, { wrapper });
    expect(screen.getByText("adversum.quick.notConnected")).toBeTruthy();
    expect(() => unmount()).not.toThrow();
  });
});

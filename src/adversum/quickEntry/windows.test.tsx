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
  showQuickToast: vi.fn(),
  resizeQuickWindow: vi.fn(),
  emitTo: vi.fn(),
  listen: vi.fn(),
  onFocusChanged: vi.fn(),
  loadSettings: vi.fn(),
  onSettingsChange: vi.fn(),
  executor: { execute: vi.fn(), undo: vi.fn(), toast: null as unknown },
  useQuickExecutor: vi.fn(),
  loggerError: vi.fn(),
  os: "macos",
  startVoice: vi.fn(),
  cancelVoice: vi.fn(),
  learnAlias: vi.fn(),
  setVoiceVocabulary: vi.fn(),
  invoke: vi.fn(),
  extractWithModel: vi.fn(),
  saveMisunderstood: vi.fn(),
}));
vi.mock("../feedback/feedback", async (original) => ({
  ...(await original<typeof import("../feedback/feedback")>()),
  saveMisunderstood: mocks.saveMisunderstood,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../multi/modelApi", () => ({ extractWithModel: mocks.extractWithModel }));
vi.mock("../multi/useDayEntries", () => ({
  useDayEntries: () => ({ busy: [], running: null, ready: true }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
    i18n: { language: "de" },
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
  showQuickToast: mocks.showQuickToast,
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
vi.mock("../voice/voiceApi", async (original) => ({
  ...(await original<typeof import("../voice/voiceApi")>()),
  startVoice: mocks.startVoice,
  cancelVoice: mocks.cancelVoice,
  learnAlias: mocks.learnAlias,
  setVoiceVocabulary: mocks.setVoiceVocabulary,
}));
vi.mock("../../utils/logger", () => ({ logger: { error: mocks.loggerError } }));
vi.mock("../../platform", () => ({ currentPlatform: () => ({ os: mocks.os }) }));

import { setAdversumDisplay } from "../display/displayStore";
import AdversumPopupQuick from "./AdversumPopupQuick";
import { interruptMenuEntries, typingToQuickEntry } from "./popupBridge";
import QuickEntryWindow from "./QuickEntryWindow";
import {
  MULTI_REVIEW_EVENT,
  QUICK_EXECUTE_EVENT,
  QUICK_SHOWN_EVENT,
  QUICK_TOAST_EVENT,
  QUICK_UNDO_EVENT,
  TOAST_DURATION_MS,
} from "./quickEvents";
import { VOICE_STATE_EVENT } from "../voice/voiceApi";
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
  mocks.os = "macos";
  for (const mock of [
    mocks.hideQuickWindow, mocks.showQuickToast, mocks.resizeQuickWindow, mocks.emitTo,
    mocks.startVoice, mocks.cancelVoice, mocks.setVoiceVocabulary, mocks.invoke,
    mocks.saveMisunderstood,
  ]) {
    mock.mockResolvedValue(undefined);
  }
  mocks.learnAlias.mockResolvedValue(true);
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

  it("hands a sentence with several entries to the floating window for review", async () => {
    setAdversumDisplay(display);
    render(<AdversumPopupQuick {...options} />, { wrapper });
    const input = screen.getByRole("combobox") as HTMLInputElement;
    const sentence = "1 h dusw pm, danach 30 min herosmile pm";
    fireEvent.focus(input);
    await waitFor(() => {
      fireEvent.change(input, { target: { value: sentence } });
      expect(screen.getByRole("option", { selected: true }).textContent).toBe(
        "2adversum.multi.offer:2",
      );
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.executor.execute).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("adversum_quick_show");
    await waitFor(() =>
      expect(mocks.emitTo).toHaveBeenCalledWith("adversum-quick", MULTI_REVIEW_EVENT, { sentence }),
    );
    // A window that cannot be shown is no reason to fail loudly.
    mocks.invoke.mockRejectedValue(new Error("no window"));
    fireEvent.change(input, { target: { value: sentence } });
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => undefined);
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

  it("has no microphone and sets no vocabulary while voice input is off", async () => {
    setAdversumDisplay(display);
    render(<AdversumPopupQuick {...options} />, { wrapper });
    await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "adversum.voice.speak" })).toBeNull();
    expect(mocks.setVoiceVocabulary).not.toHaveBeenCalled();
  });

  it("offers the microphone and keeps the speech vocabulary current", async () => {
    mocks.settings = {
      settings: { ...(mocks.settings.settings as object), voiceEnabled: true },
    };
    mocks.setVoiceVocabulary.mockRejectedValue(new Error("not the tray window"));
    mocks.startVoice.mockRejectedValue(new Error("no microphone"));
    setAdversumDisplay(display);
    render(<AdversumPopupQuick {...options} />, { wrapper });
    await waitFor(() =>
      expect(mocks.setVoiceVocabulary).toHaveBeenCalledWith(
        "Notizen: Patrick, Michi, Ema, Lennart. Projekte: Retainer, Social. Tätigkeiten: Projektmanagement. Kürzel: pm. Kunden: DUSW, Herosmile.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.speak" }));
    expect(mocks.startVoice).toHaveBeenCalledTimes(1);
  });

  it("shows nothing behind the new-task form, but keeps executing", () => {
    setAdversumDisplay(display);
    const { container } = render(<AdversumPopupQuick {...options} hidden busy />, { wrapper });
    expect(container.innerHTML).toBe("");
    expect(mocks.useQuickExecutor).toHaveBeenCalled();
    expect(interruptMenuEntries(task, "x", false)).toHaveLength(1);
  });
});

describe("QuickEntryWindow", () => {
  async function renderWindow() {
    const view = render(<QuickEntryWindow />, { wrapper });
    await waitFor(() => expect(Object.keys(windowHandlers)).toHaveLength(4));
    return view;
  }

  function open() {
    act(() => windowHandlers[QUICK_SHOWN_EVENT]!({ payload: null }));
    return screen.getByRole("combobox") as HTMLInputElement;
  }

  const started = { id: 9, kind: "started", label: "DUSW · Projektmanagement", undoable: true };

  it("renders nothing until it is shown, then an empty focused bar", async () => {
    const { container } = await renderWindow();
    expect(container.querySelector("[data-quick-stage='idle']")?.innerHTML).toBe("");
    // An empty window is not measured into a native size.
    expect(mocks.resizeQuickWindow).not.toHaveBeenCalled();
    expect(observed).toHaveLength(1);

    const input = open();
    expect(document.activeElement).toBe(input);
    expect(container.querySelector("[data-quick-stage='input']")).not.toBeNull();
    const root = container.firstElementChild as HTMLElement;
    root.getBoundingClientRect = () => ({ height: 123.2 }) as DOMRect;
    act(() => observerCallback());
    expect(mocks.resizeQuickWindow).toHaveBeenCalledWith(124);
  });

  it("sends an action to the tray window and closes at once", async () => {
    await renderWindow();
    const input = open();
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "dusw pm" } });
      expect(screen.getByRole("option", { selected: true })).toBeTruthy();
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mocks.emitTo).toHaveBeenCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
      action: expect.objectContaining({ type: "start", projectId: 11 }),
    });
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the confirmation as a toast with undo and takes it away after five seconds", async () => {
    await renderWindow();
    vi.useFakeTimers();
    act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: started }));
    expect(mocks.showQuickToast).toHaveBeenCalledWith(true);
    expect(screen.getByRole("status").textContent).toContain("adversum.quick.toast.started");
    expect(screen.getByRole("button").textContent).toContain("⌘Z");
    fireEvent.click(screen.getByRole("button"));
    expect(mocks.emitTo).toHaveBeenCalledWith("tray-popup", QUICK_UNDO_EVENT, { id: 9 });

    // The follow-up confirmation replaces the first and restarts the clock.
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1000));
    act(() =>
      windowHandlers[QUICK_TOAST_EVENT]!({ payload: { id: 10, kind: "undone", label: "", undoable: false } }),
    );
    expect(mocks.showQuickToast).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("button")).toBeNull();
    act(() => vi.advanceTimersByTime(TOAST_DURATION_MS - 1));
    expect(mocks.hideQuickWindow).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the undo key of the platform", async () => {
    mocks.os = "windows";
    await renderWindow();
    act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: started }));
    expect(screen.getByRole("button").textContent).toContain("Ctrl+Z");
  });

  it("does not replace an open bar with a confirmation from elsewhere", async () => {
    await renderWindow();
    const input = open();
    act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: started }));
    expect(screen.getByRole("combobox")).toBe(input);
    expect(mocks.showQuickToast).not.toHaveBeenCalled();
  });

  it("closes on Escape and when it loses focus, but a toast stays", async () => {
    mocks.hideQuickWindow.mockRejectedValueOnce(new Error("gone"));
    await renderWindow();
    fireEvent.keyDown(open(), { key: "Escape" });
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mocks.loggerError).toHaveBeenCalledWith("Quick entry window: Error: gone"),
    );
    expect(screen.queryByRole("combobox")).toBeNull();

    open();
    act(() => focusHandler({ payload: true }));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
    act(() => focusHandler({ payload: false }));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("combobox")).toBeNull();

    // The toast never has the focus, so losing it means nothing.
    act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: started }));
    act(() => focusHandler({ payload: false }));
    expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  describe("several entries", () => {
    const SEVERAL = "1 h dusw pm, danach 30 min herosmile pm";
    /** Amounts and an order, but no task the catalog knows. */
    const UNKNOWN = "Eine Stunde Dingsbums, danach 20 Minuten Kram";

    function review(container: HTMLElement): HTMLElement | null {
      return container.querySelector("[data-multi-review]");
    }

    it("reviews a typed sentence and sends all entries at once", async () => {
      const { container } = await renderWindow();
      const input = open();
      await waitFor(() => {
        fireEvent.change(input, { target: { value: SEVERAL } });
        expect(container.querySelector("[data-multi-offer]")).not.toBeNull();
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(container.querySelector("[data-quick-stage='multi']")).not.toBeNull();
      expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(2);

      // Neither a click elsewhere nor a confirmation from elsewhere discards it.
      act(() => focusHandler({ payload: false }));
      act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: started }));
      expect(review(container)).not.toBeNull();
      expect(mocks.hideQuickWindow).not.toHaveBeenCalled();

      fireEvent.keyDown(review(container)!, { key: "Enter" });
      expect(mocks.emitTo).toHaveBeenCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
        action: expect.objectContaining({
          type: "batch",
          entries: [
            expect.objectContaining({ projectId: 11, activityId: 1 }),
            expect.objectContaining({ projectId: 21, activityId: 1 }),
          ],
        }),
      });
      expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
      expect(container.querySelector("[data-quick-stage='idle']")).not.toBeNull();
    });

    it("reviews a sentence the popup sent over, and closes with Escape", async () => {
      const { container } = await renderWindow();
      await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());
      await act(async () => undefined);
      act(() => windowHandlers[MULTI_REVIEW_EVENT]!({ payload: { sentence: SEVERAL } }));
      await waitFor(() => expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(2));
      fireEvent.keyDown(review(container)!, { key: "Escape" });
      expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
    });

    it("puts a sentence that is one entry after all back into the bar", async () => {
      const { container } = await renderWindow();
      await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());
      act(() => windowHandlers[MULTI_REVIEW_EVENT]!({ payload: { sentence: "dusw pm" } }));
      await waitFor(() =>
        expect(container.querySelector("[data-quick-stage='input']")).not.toBeNull(),
      );
      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("dusw pm");
    });

    it("sends a spoken sentence with several activities to the review", async () => {
      const { container } = await renderWindow();
      await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());
      await act(async () => undefined);
      act(() =>
        windowHandlers[VOICE_STATE_EVENT]!({
          payload: {
            phase: "result",
            manual: false,
            text: "Eine Stunde DUSW Projektmanagement, danach 30 Minuten Herosmile Projektmanagement.",
          },
        }),
      );
      await waitFor(() => expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(2));
      expect(container.querySelector("[data-voice-phase]")).toBeNull();
    });

    it("asks a model about a spoken sentence the rules cannot split, then shows the usual card", async () => {
      // Models are off unless switched on.
      mocks.settings = {
        settings: { ...(mocks.settings.settings as object), multiModel: "device" },
      };
      mocks.extractWithModel.mockResolvedValue(null);
      const { container } = await renderWindow();
      await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());
      act(() =>
        windowHandlers[VOICE_STATE_EVENT]!({
          payload: { phase: "result", manual: false, text: UNKNOWN },
        }),
      );
      await waitFor(() => expect(mocks.extractWithModel).toHaveBeenCalledTimes(1));
      // Back at the confirmation card, and it stays there.
      await waitFor(() =>
        expect(container.querySelector("[data-quick-stage='voice']")).not.toBeNull(),
      );
      await act(async () => undefined);
      expect(container.querySelector("[data-quick-stage='voice']")).not.toBeNull();
      expect(mocks.extractWithModel).toHaveBeenCalledTimes(1);
    });

    it("keeps a review that was marked as misunderstood, with what was entered instead", async () => {
      const { container } = await renderWindow();
      const input = open();
      await waitFor(() => {
        fireEvent.change(input, { target: { value: SEVERAL } });
        expect(container.querySelector("[data-multi-offer]")).not.toBeNull();
      });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(container.querySelector("[data-misunderstood]")!);
      fireEvent.keyDown(review(container)!, { key: "Enter" });
      expect(mocks.saveMisunderstood).toHaveBeenCalledWith({
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        sentence: SEVERAL,
        source: "typed",
        recognized: expect.objectContaining({ readBy: "rules" }),
        corrected: [
          expect.objectContaining({ task: "DUSW · Retainer · Projektmanagement" }),
          expect.objectContaining({ task: "Herosmile · Social · Projektmanagement" }),
        ],
      });

      // Marked and then discarded: kept without a correction. A file that
      // cannot be written is logged, no more.
      mocks.saveMisunderstood.mockRejectedValue(new Error("disk full"));
      act(() => windowHandlers[MULTI_REVIEW_EVENT]!({ payload: { sentence: SEVERAL } }));
      await waitFor(() => expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(2));
      fireEvent.click(container.querySelector("[data-misunderstood]")!);
      fireEvent.keyDown(review(container)!, { key: "Escape" });
      expect(mocks.saveMisunderstood.mock.lastCall![0]).toMatchObject({ corrected: null });
      await waitFor(() =>
        expect(mocks.loggerError).toHaveBeenCalledWith(expect.stringContaining("disk full")),
      );
    });

    it("asks no model by default", async () => {
      expect(defaultAdversumSettings.multiModel).toBe("off");
      const { container } = await renderWindow();
      await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());
      act(() =>
        windowHandlers[VOICE_STATE_EVENT]!({
          payload: { phase: "result", manual: false, text: UNKNOWN },
        }),
      );
      await act(async () => undefined);
      expect(container.querySelector("[data-quick-stage='voice']")).not.toBeNull();
      expect(mocks.extractWithModel).not.toHaveBeenCalled();
    });
  });

  describe("voice input", () => {
    /** Delivers a transcribed sentence once the catalog is there to match it. */
    async function hear(text: string) {
      await renderWindow();
      await waitFor(() => expect(mocks.fetchHistory).toHaveBeenCalled());
      act(() =>
        windowHandlers[VOICE_STATE_EVENT]!({ payload: { phase: "result", manual: false, text } }),
      );
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    }

    it("keeps a misunderstood sentence with what was typed instead, or with nothing", async () => {
      await hear("Herosteil pm");
      fireEvent.click(document.querySelector("[data-misunderstood]")!);
      const input = screen.getByRole("combobox") as HTMLInputElement;
      expect(input.value).toBe("Herosteil pm");
      await waitFor(() => {
        fireEvent.change(input, { target: { value: "herosmile pm" } });
        expect(screen.getByRole("option", { selected: true }).textContent).toContain("Herosmile");
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(mocks.saveMisunderstood).toHaveBeenCalledTimes(1);
      expect(mocks.saveMisunderstood).toHaveBeenCalledWith({
        time: expect.any(String),
        sentence: "Herosteil pm",
        source: "voice",
        recognized: expect.objectContaining({ task: "DUSW · Retainer · Projektmanagement" }),
        corrected: expect.objectContaining({ task: "Herosmile · Social · Projektmanagement" }),
      });

      // Given up instead of corrected.
      act(() =>
        windowHandlers[VOICE_STATE_EVENT]!({
          payload: { phase: "result", manual: false, text: "Herosteil Projektmanagement" },
        }),
      );
      await waitFor(() => expect(document.querySelector("[data-misunderstood]")).not.toBeNull());
      fireEvent.click(document.querySelector("[data-misunderstood]")!);
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
      expect(mocks.saveMisunderstood).toHaveBeenCalledTimes(2);
      expect(mocks.saveMisunderstood.mock.lastCall![0]).toMatchObject({
        sentence: "Herosteil Projektmanagement",
        corrected: null,
      });
    });

    /** The first row (DUSW, by history) is preselected; Herosmile is the second. */
    function chooseHerosmile() {
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("Herosmile");
    }

    it("takes the bar's place and closes like it", async () => {
      const { container } = await renderWindow();
      act(() =>
        windowHandlers[VOICE_STATE_EVENT]!({ payload: { phase: "recording", manual: false } }),
      );
      expect(container.querySelector("[data-quick-stage='voice']")).not.toBeNull();
      expect(container.querySelector("[data-voice-phase='recording']")).not.toBeNull();

      // A confirmation from elsewhere does not interrupt the recording.
      act(() => windowHandlers[QUICK_TOAST_EVENT]!({ payload: started }));
      expect(container.querySelector("[data-voice-phase='recording']")).not.toBeNull();

      act(() =>
        windowHandlers[VOICE_STATE_EVENT]!({ payload: { phase: "transcribing", manual: false } }),
      );
      expect(container.querySelector("[data-voice-phase='transcribing']")).not.toBeNull();

      // Clicking elsewhere hides the window, which also ends the recording.
      act(() => focusHandler({ payload: false }));
      expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
      expect(container.querySelector("[data-quick-stage='idle']")).not.toBeNull();
    });

    it("runs what was understood and stores what a correction taught", async () => {
      mocks.learnAlias.mockRejectedValueOnce(new Error("store is read-only"));
      await hear("Herosteil pm");
      chooseHerosmile();
      fireEvent.keyDown(window, { key: "Enter" });
      expect(mocks.learnAlias).toHaveBeenCalledWith("conn", "customers", 2, "herosteil");
      expect(mocks.emitTo).toHaveBeenCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
        action: expect.objectContaining({ type: "start", projectId: 21, description: "" }),
        learned: "„herosteil“ = Herosmile",
      });
      expect(mocks.hideQuickWindow).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(mocks.loggerError).toHaveBeenCalledWith(
          "Quick entry window: Error: store is read-only",
        ),
      );
    });

    it("can be finished by typing, and learns from that correction too", async () => {
      await hear("Herosteil pm");
      fireEvent.keyDown(window, { key: "Tab" });
      const input = screen.getByRole("combobox") as HTMLInputElement;
      expect(input.value).toBe("Herosteil pm");
      expect(document.activeElement).toBe(input);

      await waitFor(() => {
        fireEvent.change(input, { target: { value: "herosmile pm" } });
        expect(screen.getByRole("option", { selected: true }).textContent).toContain("Herosmile");
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(mocks.learnAlias).toHaveBeenCalledWith("conn", "customers", 2, "herosteil");
      expect(mocks.emitTo).toHaveBeenLastCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
        action: expect.objectContaining({ type: "start", projectId: 21 }),
        learned: "„herosteil“ = Herosmile",
      });

      // The next entry is typed from scratch: nothing to learn from.
      const again = open();
      expect(again.value).toBe("");
      await waitFor(() => {
        fireEvent.change(again, { target: { value: "herosmile pm" } });
        expect(screen.getByRole("option", { selected: true })).toBeTruthy();
      });
      fireEvent.keyDown(again, { key: "Enter" });
      expect(mocks.learnAlias).toHaveBeenCalledTimes(1);
      expect(mocks.emitTo).toHaveBeenLastCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
        action: expect.objectContaining({ type: "start", projectId: 21 }),
      });
    });

    it("learns nothing when the edit ends in a command", async () => {
      await hear("Herosteil pm");
      fireEvent.keyDown(window, { key: "Tab" });
      const input = screen.getByRole("combobox");
      fireEvent.change(input, { target: { value: "stopp" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(mocks.emitTo).toHaveBeenLastCalledWith("tray-popup", QUICK_EXECUTE_EVENT, {
        action: { type: "command", command: "stop" },
      });
      expect(mocks.learnAlias).not.toHaveBeenCalled();
    });

    it("starts from the microphone button of the bar when it is switched on", async () => {
      await renderWindow();
      open();
      expect(screen.queryByRole("button", { name: "adversum.voice.speak" })).toBeNull();
      cleanup();

      mocks.settings = {
        settings: { ...(mocks.settings.settings as object), voiceEnabled: true },
      };
      mocks.startVoice.mockRejectedValue(new Error("no microphone"));
      await renderWindow();
      open();
      fireEvent.click(screen.getByRole("button", { name: "adversum.voice.speak" }));
      expect(mocks.startVoice).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(mocks.loggerError).toHaveBeenCalledWith("Quick entry window: Error: no microphone"),
      );
    });
  });

  it("asks for a connection first and survives missing window events", async () => {
    mocks.kimai = { client: null, isConfigured: false, activeConnectionId: "" };
    const first = await renderWindow();
    act(() => windowHandlers[QUICK_SHOWN_EVENT]!({ payload: null }));
    expect(screen.getByText("adversum.quick.notConnected")).toBeTruthy();
    first.unmount();

    mocks.listen.mockRejectedValue(new Error("no events"));
    mocks.onFocusChanged.mockRejectedValue(new Error("no events"));
    const { unmount } = render(<QuickEntryWindow />, { wrapper });
    expect(() => unmount()).not.toThrow();
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalog } from "../quickEntry/catalog";
import { buildHistory, EMPTY_HISTORY } from "../quickEntry/history";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  cancelVoice: vi.fn(),
  finishVoice: vi.fn(),
  openVoicePrivacySettings: vi.fn(),
  reloadModelInternally: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
    i18n: { language: "de" },
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: mocks.listen }),
}));
vi.mock("./voiceApi", async (original) => ({
  ...(await original<typeof import("./voiceApi")>()),
  cancelVoice: mocks.cancelVoice,
  finishVoice: mocks.finishVoice,
  openVoicePrivacySettings: mocks.openVoicePrivacySettings,
  reloadModelInternally: mocks.reloadModelInternally,
}));

import { VOICE_LEVEL_EVENT, VOICE_PARTIAL_EVENT, type VoiceState } from "./voiceApi";
import VoiceStage, { AUTO_START_MS, MESSAGE_MS } from "./VoiceStage";

const catalog = buildCatalog(
  [
    { id: 1, name: "DUSW" },
    { id: 2, name: "Herosmile" },
  ],
  [
    { id: 11, name: "Retainer", customer: 1 },
    { id: 21, name: "Onlineshop", customer: 2 },
  ],
  [
    { id: 1, name: "Projektmanagement", project: null },
    { id: 2, name: "Design", project: null },
  ],
);
const day = 86_400_000;
const history = buildHistory(
  [1, 2, 3].map((days) => ({
    projectId: 11,
    activityId: 1,
    begin: new Date(Date.now() - days * day),
  })),
  new Date(),
);

const onAction = vi.fn();
const onEdit = vi.fn();
const onClose = vi.fn();
let handlers: Record<string, (event: { payload: unknown }) => void>;

function show(state: Partial<VoiceState> & { phase: VoiceState["phase"] }, useCatalog = catalog) {
  return render(
    <VoiceStage
      state={{ manual: false, ...state }}
      catalog={useCatalog}
      history={history}
      onAction={onAction}
      onEdit={onEdit}
      onClose={onClose}
    />,
  );
}

function result(text: string, useCatalog = catalog) {
  return show({ phase: "result", text }, useCatalog);
}

function press(key: string, options: KeyboardEventInit = {}) {
  return fireEvent.keyDown(window, { key, ...options });
}

function selected(): string | null {
  return screen.queryByRole("option", { selected: true })?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  handlers = {};
  mocks.listen.mockImplementation(async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers[event] = handler;
    return vi.fn();
  });
  for (const mock of [mocks.cancelVoice, mocks.finishVoice, mocks.openVoicePrivacySettings]) {
    mock.mockResolvedValue(undefined);
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("while recording", () => {
  it("shows the level and what was understood so far", async () => {
    const { container } = show({ phase: "recording" });
    await act(async () => undefined);
    expect(document.activeElement).toBe(container.querySelector("[data-voice-phase='recording']"));
    expect(screen.getByRole("status").textContent).toBe("adversum.voice.listening");
    expect(screen.getByText("adversum.voice.hintHold")).toBeTruthy();

    act(() => handlers[VOICE_LEVEL_EVENT]!({ payload: 0.5 }));
    expect(container.querySelector("[data-voice-level='0.50']")).not.toBeNull();
    act(() => handlers[VOICE_LEVEL_EVENT]!({ payload: 7 }));
    expect(container.querySelector("[data-voice-level='1.00']")).not.toBeNull();
    act(() => handlers[VOICE_PARTIAL_EVENT]!({ payload: "DUSW Projekt" }));
    expect(screen.getByRole("status").textContent).toBe("DUSW Projekt");
  });

  it("can always be ended by Enter or the button, should the key release get lost", () => {
    show({ phase: "recording" });
    press("Enter");
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.done" }));
    expect(mocks.finishVoice).toHaveBeenCalledTimes(2);
    press("Escape");
    expect(mocks.cancelVoice).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says how it ends when started by a click, a tap or in tap mode", () => {
    show({ phase: "recording", manual: true });
    expect(screen.getByText("adversum.voice.hintManual")).toBeTruthy();
    press("Enter");
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.done" }));
    expect(mocks.finishVoice).toHaveBeenCalledTimes(2);
  });

  it("survives a window without events and failing native calls", async () => {
    mocks.listen.mockRejectedValue(new Error("no events"));
    mocks.finishVoice.mockRejectedValue(new Error("gone"));
    mocks.cancelVoice.mockRejectedValue(new Error("gone"));
    const { unmount } = show({ phase: "recording", manual: true });
    press("Enter");
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.done" }));
    press("Escape");
    await act(async () => undefined);
    expect(() => unmount()).not.toThrow();
  });
});

describe("while transcribing and when nothing came of it", () => {
  it("can still be cancelled", () => {
    show({ phase: "transcribing" });
    expect(screen.getByRole("status").textContent).toBe("adversum.voice.transcribing");
    press("Escape");
    expect(mocks.cancelVoice).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says that nothing was understood and goes away", () => {
    const { container } = show({ phase: "empty" });
    expect(container.querySelector("[data-voice-problem='empty']")?.textContent).toBe(
      "adversum.voice.problem.empty",
    );
    expect(container.querySelector("[data-voice-detail]")).toBeNull();
    press("Escape");
    // Nothing runs any more, so there is nothing to cancel.
    expect(mocks.cancelVoice).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(MESSAGE_MS));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("names the disk the model lies on when it is not connected, and offers the way out", async () => {
    mocks.reloadModelInternally.mockRejectedValue(new Error("offline"));
    show({ phase: "error", reason: "modelVolume", detail: "Adversum" });
    expect(screen.getByRole("alert").textContent).toBe(
      "adversum.voice.problem.modelVolume:Adversum",
    );
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.useInternal" }));
    await act(async () => undefined);
    expect(mocks.reloadModelInternally).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Without a name the sentence still stands.
    cleanup();
    show({ phase: "error", reason: "modelVolume" });
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.problem.modelVolume:");
  });

  it("explains what is missing and leads to the microphone setting", async () => {
    mocks.openVoicePrivacySettings.mockRejectedValue(new Error("no opener"));
    const { container, rerender } = show({ phase: "error", reason: "noModel" });
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.problem.noModel");
    expect(screen.queryByRole("button")).toBeNull();

    rerender(
      <VoiceStage
        state={{ phase: "error", manual: false, reason: "permissionDenied" }}
        catalog={catalog}
        history={history}
        onAction={onAction}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "adversum.voice.openPrivacy" }));
    await act(async () => undefined);
    expect(mocks.openVoicePrivacySettings).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <VoiceStage
        state={{ phase: "error", manual: false }}
        catalog={catalog}
        history={history}
        onAction={onAction}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    expect(container.querySelector("[data-voice-problem='failed']")).not.toBeNull();
  });

  it("names the reason nothing came of a recording, and the concrete error", () => {
    const quiet = show({ phase: "empty", reason: "tooQuiet" });
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.problem.tooQuiet");
    quiet.unmount();

    const { container } = show({
      phase: "error",
      reason: "failed",
      detail: "Whisper: Generic whisper error. Error code: -6",
    });
    expect(container.querySelector("[data-voice-problem='failed']")).not.toBeNull();
    expect(container.querySelector("[data-voice-detail]")?.textContent).toBe(
      "Whisper: Generic whisper error. Error code: -6",
    );
  });
});

describe("the confirmation card", () => {
  it("starts a confident reading by itself after two seconds", () => {
    const { container } = result("DUSW Projektmanagement, Gigi Call");
    expect(container.querySelector("[data-voice-heard]")?.textContent).toBe(
      "„DUSW Projektmanagement, Gigi Call“",
    );
    expect(selected()).toContain("DUSW");
    expect(screen.getByText("adversum.voice.hintAuto")).toBeTruthy();
    const bar = container.querySelector("[data-voice-countdown]") as HTMLElement;
    expect(bar.style.width).toBe("100%");
    act(() => void vi.advanceTimersByTime(20));
    expect(bar.style.width).toBe("0%");

    act(() => void vi.advanceTimersByTime(AUTO_START_MS));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start",
        mode: "switch",
        projectId: 11,
        activityId: 1,
        description: "Gigi Call",
      }),
      [],
    );
    // Whatever comes afterwards does not start it a second time.
    press("Enter");
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("starts at once with Enter, in between with Command+Enter", () => {
    const first = result("DUSW Projektmanagement");
    press("Enter");
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ mode: "switch" }), []);
    act(() => void vi.advanceTimersByTime(AUTO_START_MS));
    expect(onAction).toHaveBeenCalledTimes(1);
    first.unmount();

    result("DUSW Projektmanagement");
    press("Enter", { metaKey: true });
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "interrupt" }), []);
    cleanup();

    result("DUSW Projektmanagement");
    press("Enter", { ctrlKey: true });
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "interrupt" }), []);
  });

  it("stops the countdown on any key except the modifiers", () => {
    const { container } = result("DUSW Projektmanagement");
    press("Meta");
    press("Shift");
    expect(container.querySelector("[data-voice-countdown]")).not.toBeNull();
    press("x");
    expect(container.querySelector("[data-voice-countdown]")).toBeNull();
    expect(screen.getByText("adversum.voice.hintConfirm")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(AUTO_START_MS * 2));
    expect(onAction).not.toHaveBeenCalled();
    // Escape is the stage's: it discards.
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.cancelVoice).not.toHaveBeenCalled();
  });

  it("learns from a correction with the arrow keys", () => {
    // "Heroschmeil" names nothing, so the usual task comes first.
    const { container } = result("Heroschmeil Design");
    // Not sure enough to start by itself, but the first row is preselected.
    expect(container.querySelector("[data-voice-countdown]")).toBeNull();
    expect(screen.getByText("adversum.voice.hintConfirm")).toBeTruthy();
    expect(selected()).toContain("DUSW");

    press("ArrowDown");
    expect(selected()).toContain("Herosmile");
    press("ArrowDown");
    expect(selected()).toContain("Herosmile");
    press("ArrowUp");
    press("ArrowUp");
    expect(selected()).toContain("DUSW");
    press("ArrowDown");
    press("Enter");
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start", projectId: 21, activityId: 2, description: "" }),
      [{ kind: "customers", entityId: 2, alias: "heroschmeil", name: "Herosmile", nameLike: true }],
    );
  });

  it("shows the day and waits when a day has neither time nor duration", () => {
    const { container } = result("Gestern von 9 bis 10 DUSW Design");
    expect(container.querySelector("[data-chip='time']")?.textContent).toMatch(/^Gestern, /);
    expect(container.querySelector("[data-voice-countdown]")).not.toBeNull();
    cleanup();

    const waiting = result("Gestern DUSW Design");
    expect(waiting.container.querySelector("[data-chip='time']")?.textContent).toContain(
      "adversum.quick.incompleteTime",
    );
    expect(waiting.container.querySelector("[data-voice-countdown]")).toBeNull();
    press("Enter");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("takes the first suggestion as it is, also by mouse", () => {
    const { container } = result("DUSW Projektmanagement");
    const [first, second] = screen.getAllByRole("option");
    fireEvent.mouseMove(second!);
    expect(container.querySelector("[data-voice-countdown]")).toBeNull();
    expect(second!.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(first!);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ projectId: 11 }), []);
  });

  it("hands the text over for editing with Tab", () => {
    result("Heroschmeil Design seit 9 Uhr");
    press("Tab");
    expect(onEdit).toHaveBeenCalledWith("Heroschmeil Design seit 9 Uhr", {
      spoken: "Heroschmeil Design seit 9 Uhr",
      proposed: expect.objectContaining({ combination: expect.objectContaining({ key: "11-2" }) }),
    });
    expect(onAction).not.toHaveBeenCalled();
  });

  it("does not start a time in the future by itself", () => {
    vi.setSystemTime(new Date(2026, 10, 26, 9, 0));
    const { container } = result("DUSW Projektmanagement seit 18 Uhr");
    expect(container.querySelector("[data-voice-countdown]")).toBeNull();
    expect(selected()).toContain("DUSW");
    act(() => void vi.advanceTimersByTime(AUTO_START_MS * 2));
    expect(onAction).not.toHaveBeenCalled();
    // Enter accepts it; it then starts now.
    press("Enter");
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start", projectId: 11, begin: null }),
      [],
    );
  });

  it("runs commands and notes after the countdown", () => {
    const { container, unmount } = result("Stopp.");
    expect(container.querySelector("[data-voice-confirm='command']")).not.toBeNull();
    expect(selected()).toContain("adversum.quick.command.stop");
    fireEvent.mouseMove(screen.getByRole("option"));
    press("Tab");
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("option"));
    expect(onAction).toHaveBeenLastCalledWith({ type: "command", command: "stop" }, []);
    unmount();

    result("Notiz: Angebot nachfassen");
    expect(selected()).toContain("Angebot nachfassen");
    act(() => void vi.advanceTimersByTime(AUTO_START_MS));
    expect(onAction).toHaveBeenLastCalledWith({ type: "note", text: "Angebot nachfassen" }, []);
    cleanup();

    result("Notiz: zweite Zeile");
    fireEvent.mouseMove(screen.getByRole("option"));
    fireEvent.mouseDown(screen.getByRole("option"));
    expect(onAction).toHaveBeenLastCalledWith({ type: "note", text: "Zweite Zeile" }, []);
  });

  it("says so when the sentence was noise or nothing can be started", () => {
    const noise = result("[Musik]");
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.problem.empty");
    press("Enter");
    press("ArrowDown");
    expect(onAction).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(MESSAGE_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
    noise.unmount();

    render(
      <VoiceStage
        state={{ phase: "result", manual: false }}
        catalog={buildCatalog([], [], [])}
        history={EMPTY_HISTORY}
        onAction={onAction}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("adversum.voice.problem.empty");
    cleanup();

    result("DUSW Design", buildCatalog([], [], []));
    expect(screen.getByRole("alert").textContent).toBe("adversum.quick.empty");
    // Nothing is selected, so Enter has nothing to start.
    onAction.mockClear();
    press("Enter");
    expect(onAction).not.toHaveBeenCalled();
    press("Tab");
    expect(onEdit).toHaveBeenCalledWith("DUSW Design", { spoken: "DUSW Design", proposed: null });
  });

  it("selects the first suggestion once a late catalog arrives", () => {
    const { rerender } = result("DUSW Projektmanagement", buildCatalog([], [], []));
    expect(selected()).toBeNull();
    rerender(
      <VoiceStage
        state={{ phase: "result", manual: false, text: "DUSW Projektmanagement" }}
        catalog={catalog}
        history={history}
        onAction={onAction}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    expect(selected()).toContain("DUSW");
    // It was not confident when it appeared, so it does not start by itself.
    act(() => void vi.advanceTimersByTime(AUTO_START_MS * 2));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows a new sentence as a new card", () => {
    const { rerender, container } = result("DUSW Projektmanagement");
    press("x");
    expect(container.querySelector("[data-voice-countdown]")).toBeNull();
    rerender(
      <VoiceStage
        state={{ phase: "result", manual: false, text: "Herosmile Design" }}
        catalog={catalog}
        history={history}
        onAction={onAction}
        onEdit={onEdit}
        onClose={onClose}
      />,
    );
    expect(container.querySelector("[data-voice-countdown]")).not.toBeNull();
    expect(selected()).toContain("Herosmile");
  });
});

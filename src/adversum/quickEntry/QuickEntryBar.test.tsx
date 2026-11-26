// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAdversumDisplay } from "../display/displayStore";
import { buildCatalog } from "./catalog";
import { buildHistory, EMPTY_HISTORY } from "./history";
import QuickEntryBar, { completionText } from "./QuickEntryBar";
import QuickToast from "./QuickToast";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));

const catalog = buildCatalog(
  [
    { id: 1, name: "DUSW Unternehmensgruppe", color: "#0f766e" },
    { id: 2, name: "Herosmile" },
  ],
  [
    { id: 11, name: "Marketing Retainer", customer: 1 },
    { id: 21, name: "Marketing Retainer", customer: 2 },
  ],
  [
    { id: 1, name: "Projektmanagement", project: null, color: "#10b981" },
    { id: 2, name: "Austausch", project: null },
  ],
  { customers: { "1": ["gigi"] }, projects: {}, activities: { "1": ["pm"], "2": ["call"] } },
);
const history = buildHistory(
  Array.from({ length: 5 }, (_, index) => ({
    projectId: 11,
    activityId: 1,
    begin: new Date(Date.now() - (index + 1) * 86_400_000),
  })),
  new Date(),
);

const onAction = vi.fn();
const onClose = vi.fn();

function renderBar(props: Partial<React.ComponentProps<typeof QuickEntryBar>> = {}) {
  return render(
    <QuickEntryBar
      catalog={catalog}
      history={history}
      variant="window"
      onAction={onAction}
      onClose={onClose}
      {...props}
    />,
  );
}

function input(): HTMLInputElement {
  return screen.getByRole("combobox") as HTMLInputElement;
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function key(name: string, options: Partial<KeyboardEventInit> = {}) {
  return fireEvent.keyDown(input(), { key: name, ...options });
}

function selectedText(): string | null {
  return screen.queryByRole("option", { selected: true })?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  setAdversumDisplay(null);
});

describe("QuickEntryBar", () => {
  it("suggests likely tasks for an empty field without preselecting one", () => {
    renderBar();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    expect(selectedText()).toBeNull();
    expect(screen.getByText("adversum.quick.choose")).toBeTruthy();
    key("Enter");
    expect(onAction).not.toHaveBeenCalled();
    // Arrow up from "nothing selected" stays there; arrow down picks the first.
    key("ArrowUp");
    expect(selectedText()).toBeNull();
    key("ArrowDown");
    expect(selectedText()).toContain("DUSW Unternehmensgruppe");
    expect(screen.getByText("adversum.quick.hints")).toBeTruthy();
    expect(input().getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { selected: true }).id,
    );
  });

  it("preselects a confident match and starts it with Enter", () => {
    renderBar();
    type("dusw pm gigi call");
    expect(selectedText()).toContain("Marketing Retainer · Projektmanagement");
    expect(screen.getAllByText("Gigi Call").length).toBeGreaterThan(0);
    key("Enter");
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "start",
        mode: "switch",
        projectId: 11,
        activityId: 1,
        description: "Gigi Call",
        begin: null,
      }),
    );
    expect(input().value).toBe("");
  });

  it("starts in between with Cmd or Ctrl and Enter", () => {
    renderBar();
    type("dusw pm");
    key("Enter", { metaKey: true });
    expect(onAction.mock.lastCall![0]).toMatchObject({ mode: "interrupt" });
    type("dusw pm");
    key("Enter", { ctrlKey: true });
    expect(onAction.mock.lastCall![0]).toMatchObject({ mode: "interrupt" });
  });

  it("moves the selection with the arrow keys within the list", () => {
    renderBar();
    type("marketing");
    expect(screen.getAllByRole("option")).toHaveLength(4);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowUp");
    const options = screen.getAllByRole("option");
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    for (let step = 0; step < 10; step++) key("ArrowDown");
    expect(options[3]!.getAttribute("aria-selected")).toBe("true");
    for (let step = 0; step < 10; step++) key("ArrowUp");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("completes the selected suggestion with Tab and leaves Shift+Tab alone", () => {
    renderBar();
    type("dusw pm seit 9:45 gigi call");
    expect(key("Tab", { shiftKey: true })).toBe(true);
    expect(key("Tab")).toBe(false);
    expect(input().value).toBe(
      "DUSW Unternehmensgruppe Marketing Retainer Projektmanagement seit 9:45 Gigi Call ",
    );
    // Without a selection Tab completes the first suggestion.
    type("");
    key("Tab");
    expect(input().value).toBe("DUSW Unternehmensgruppe Marketing Retainer Projektmanagement ");
    expect(
      completionText(
        {
          combination: catalog.combinations[0]!,
          note: "",
          score: 0,
          textScore: 0,
          matchedWords: 0,
          namesTarget: false,
          words: { customer: [], project: [], activity: [] },
        },
        "",
      ),
    ).toBe("DUSW Unternehmensgruppe Marketing Retainer Projektmanagement ");
  });

  it("clears the text with Escape first and closes on the second press", () => {
    renderBar();
    type("dusw");
    key("Escape");
    expect(input().value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows recognized times and warns about future ones", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 26, 10, 20) });
    try {
      const { container } = renderBar();
      type("dusw pm seit 9:45");
      expect(container.querySelector("[data-chip='time']")?.textContent).toMatch(
        /^adversum\.quick\.since:0?9:45/,
      );
      type("dusw pm von 9 bis 10");
      expect(container.querySelector("[data-chip='time']")?.textContent).toMatch(/^0?9:00.*–10:00/);
      key("Enter");
      expect(onAction.mock.lastCall![0]).toMatchObject({
        type: "log",
        begin: "2026-11-26T09:00:00",
        end: "2026-11-26T10:00:00",
      });
      type("dusw pm seit 11");
      const chip = container.querySelector("[data-chip='time']")!;
      expect(chip.textContent).toBe("adversum.quick.futureTime");
      expect(chip.className).toContain("amber");
      type("dusw pm");
      expect(container.querySelector("[data-chip='time']")).toBeNull();
      expect(screen.getAllByRole("option")[0]!.querySelector("[data-chip='note']")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs commands and offers no Tab completion for them", () => {
    renderBar();
    type("pause");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("adversum.quick.command.pause")).toBeTruthy();
    expect(key("Tab")).toBe(true);
    key("Enter");
    expect(onAction).toHaveBeenCalledWith({ type: "command", command: "pause" });

    type("stop");
    fireEvent.mouseMove(screen.getByRole("option"));
    fireEvent.mouseDown(screen.getByRole("option"));
    expect(onAction).toHaveBeenLastCalledWith({ type: "command", command: "stop" });
  });

  it("starts a suggestion with the mouse and selects it on hover", () => {
    renderBar();
    type("marketing");
    const [, second] = screen.getAllByRole("option");
    fireEvent.mouseMove(second!);
    expect(second!.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(second!);
    expect(onAction.mock.lastCall![0]).toMatchObject({ type: "start", mode: "switch" });
    type("marketing");
    fireEvent.mouseDown(screen.getAllByRole("option")[0]!, { metaKey: true });
    expect(onAction.mock.lastCall![0]).toMatchObject({ mode: "interrupt" });
    type("marketing");
    fireEvent.mouseDown(screen.getAllByRole("option")[0]!, { ctrlKey: true });
    expect(onAction.mock.lastCall![0]).toMatchObject({ mode: "interrupt" });
  });

  it("does nothing while disabled or when nothing can be started", () => {
    const { rerender } = renderBar({ disabled: true });
    type("dusw pm");
    key("Enter");
    expect(onAction).not.toHaveBeenCalled();
    expect(input().value).toBe("dusw pm");

    rerender(
      <QuickEntryBar
        catalog={buildCatalog([], [], [])}
        history={EMPTY_HISTORY}
        variant="window"
        onAction={onAction}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("adversum.quick.empty")).toBeTruthy();
    expect(key("Tab")).toBe(true);
    key("Enter");
    key("ArrowDown");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows cached logos and the activity color", () => {
    setAdversumDisplay({
      indicator: "logo",
      customersByProject: new Map(),
      logos: new Map([[1, "data:image/png;base64,AAAA"]]),
    });
    renderBar();
    type("dusw pm");
    const row = screen.getByRole("option", { selected: true });
    expect(row.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(row.querySelector("[data-activity-dot]")).not.toBeNull();
    type("dusw call");
    expect(screen.getAllByRole("option")[0]!.querySelector("[data-activity-dot]")).toBeNull();
  });

  it("as the popup's search field only opens its list while typing", () => {
    const { container } = renderBar({ variant: "popup" });
    expect(container.querySelector("[data-quick-entry='popup']")).not.toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("esc")).toBeNull();
    fireEvent.focus(input());
    expect(screen.queryByRole("listbox")).toBeNull();
    type("dusw");
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(input());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("takes over typed text and the focus on request", () => {
    const { rerender } = renderBar({ variant: "popup", focusRequest: 0, seedText: "x" });
    expect(input().value).toBe("");
    expect(document.activeElement).not.toBe(input());
    rerender(
      <QuickEntryBar
        catalog={catalog}
        history={history}
        variant="popup"
        focusRequest={1}
        seedText="d"
        onAction={onAction}
        onClose={onClose}
      />,
    );
    expect(input().value).toBe("d");
    expect(document.activeElement).toBe(input());
    act(() => type("du"));
    rerender(
      <QuickEntryBar
        catalog={catalog}
        history={history}
        variant="popup"
        focusRequest={1}
        seedText="z"
        onAction={onAction}
        onClose={onClose}
      />,
    );
    expect(input().value).toBe("du");
  });
});

describe("microphone button", () => {
  it("is only there when voice input is on, and starts it without taking the focus", () => {
    const { rerender } = renderBar();
    expect(screen.queryByRole("button", { name: "adversum.voice.speak" })).toBeNull();

    const onVoice = vi.fn();
    rerender(
      <QuickEntryBar
        catalog={catalog}
        history={history}
        variant="window"
        onAction={onAction}
        onClose={onClose}
        onVoice={onVoice}
      />,
    );
    const button = screen.getByRole("button", { name: "adversum.voice.speak" });
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("h-5");
    // The press must not blur the text field.
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    expect(onVoice).toHaveBeenCalledTimes(1);

    rerender(
      <QuickEntryBar
        catalog={catalog}
        history={history}
        variant="popup"
        onAction={onAction}
        onClose={onClose}
        onVoice={onVoice}
      />,
    );
    expect(
      screen.getByRole("button", { name: "adversum.voice.speak" }).querySelector("svg")?.getAttribute("class"),
    ).toContain("h-3.5");
  });
});

describe("QuickToast", () => {
  const toast = { id: 4, kind: "started" as const, label: "DUSW · Projektmanagement", undoable: true };

  it("confirms the action and offers undo by click, naming the key for it", () => {
    const onUndo = vi.fn();
    const { container } = render(<QuickToast toast={toast} onUndo={onUndo} undoKey="⌘Z" />);
    expect(screen.getByRole("status").textContent).toContain(
      "adversum.quick.toast.started:DUSW · Projektmanagement",
    );
    const undo = screen.getByRole("button");
    expect(undo.textContent).toBe("adversum.quick.undo⌘Z");
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-quick-toast='started']")).not.toBeNull();
  });

  it("shows failures and plain confirmations without undo", () => {
    const failed = { id: 5, kind: "failed" as const, label: "", undoable: false };
    const { rerender } = render(<QuickToast toast={failed} onUndo={vi.fn()} undoKey="⌘Z" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("adversum.quick.toast.failed:").className).toContain("text-red-600");
    rerender(
      <QuickToast toast={{ ...failed, kind: "stopped", label: "x" }} onUndo={vi.fn()} undoKey="⌘Z" />,
    );
    expect(screen.getByText("adversum.quick.toast.stopped:x").className).not.toContain("red");
  });

  it("adds a line for what voice input learned", () => {
    const { container, rerender } = render(
      <QuickToast toast={{ ...toast, detail: "„kaka“ = K&K" }} onUndo={vi.fn()} undoKey="⌘Z" />,
    );
    expect(container.querySelector("[data-toast-detail]")?.textContent).toBe(
      "adversum.voice.learned:„kaka“ = K&K",
    );
    rerender(<QuickToast toast={toast} onUndo={vi.fn()} undoKey="⌘Z" />);
    expect(container.querySelector("[data-toast-detail]")).toBeNull();
  });
});

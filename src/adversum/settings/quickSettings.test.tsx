// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAdversumSettings } from "./adversumSettings";

const mocks = vi.hoisted(() => ({
  os: "macos",
  supportsGlobalShortcuts: true,
  kimai: { client: null as unknown, isConfigured: true, activeConnectionId: "conn" },
  settings: { settings: {} as any, update: vi.fn() },
  getCustomers: vi.fn(),
  getProjects: vi.fn(),
  getActivities: vi.fn(),
  getMultiModelStatus: vi.fn(),
}));
vi.mock("../multi/extract", () => ({ getMultiModelStatus: mocks.getMultiModelStatus }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
  }),
}));
vi.mock("../../platform", () => ({
  currentPlatform: () => ({ os: mocks.os }),
  usePlatform: () => ({ os: mocks.os, supportsGlobalShortcuts: mocks.supportsGlobalShortcuts }),
}));
vi.mock("../../hooks/useKimaiClient", () => ({ useKimaiClient: () => mocks.kimai }));
vi.mock("./useAdversumSettings", () => ({ useAdversumSettings: () => mocks.settings }));
vi.mock("../../api/projectApi", () => ({
  getCustomers: mocks.getCustomers,
  getProjects: mocks.getProjects,
}));
vi.mock("../../api/activityApi", () => ({ getActivities: mocks.getActivities }));

import AcceleratorInput, { acceleratorFromKey, formatAccelerator } from "./AcceleratorInput";
import QuickEntrySection, { parseAliasInput } from "./QuickEntrySection";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.os = "macos";
  mocks.supportsGlobalShortcuts = true;
  mocks.kimai = {
    client: { connectionId: "conn", cacheScope: "conn:1" },
    isConfigured: true,
    activeConnectionId: "conn",
  };
  mocks.settings = {
    settings: {
      ...defaultAdversumSettings,
      aliases: {
        conn: { customers: { "1": ["gigi"] }, projects: {}, activities: { "1": ["pm"] } },
        other: { customers: { "9": ["x"] }, projects: {}, activities: {} },
      },
    },
    update: vi.fn().mockResolvedValue(true),
  };
  mocks.getCustomers.mockResolvedValue([
    { id: 2, name: "Herosmile" },
    { id: 1, name: "DUSW Unternehmensgruppe" },
  ]);
  mocks.getProjects.mockResolvedValue([
    { id: 21, name: "Marketing Retainer", customer: 2 },
    { id: 11, name: "Marketing Retainer", customer: 1 },
    { id: 31, name: "Orphan", customer: 404 },
  ]);
  mocks.getActivities.mockResolvedValue([
    { id: 1, name: "Projektmanagement", project: null },
    { id: 6, name: "Reporting", project: 11 },
  ]);
  mocks.getMultiModelStatus.mockResolvedValue({ mode: "auto", apple: "missing", claude: true });
});
afterEach(cleanup);

describe("accelerators", () => {
  const key = (overrides: Partial<Parameters<typeof acceleratorFromKey>[0]>) => ({
    key: "a", code: "KeyA", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    ...overrides,
  });

  it("keeps Control and Command apart", () => {
    expect(acceleratorFromKey(key({ ctrlKey: true, altKey: true, key: " ", code: "Space" }))).toBe(
      "Control+Alt+Space",
    );
    expect(acceleratorFromKey(key({ metaKey: true, shiftKey: true }))).toBe("Shift+Command+A");
    expect(acceleratorFromKey(key({ altKey: true, key: "5", code: "Digit5" }))).toBe("Alt+5");
    expect(acceleratorFromKey(key({ ctrlKey: true, key: "F8", code: "F8" }))).toBe("Control+F8");
  });

  it("needs a modifier and a real key", () => {
    expect(acceleratorFromKey(key({}))).toBeNull();
    expect(acceleratorFromKey(key({ ctrlKey: true, key: "Control", code: "ControlLeft" }))).toBeNull();
    expect(acceleratorFromKey(key({ ctrlKey: true, key: "x", code: "" }))).toBeNull();
  });

  it("formats for macOS and other platforms", () => {
    expect(formatAccelerator("Control+Alt+Space", true)).toBe("⌃⌥Space");
    expect(formatAccelerator("Shift+Command+Z", true)).toBe("⇧⌘Z");
    expect(formatAccelerator("Control+Alt+Z", false)).toBe("Ctrl+Alt+Z");
    expect(formatAccelerator("Command+K", false)).toBe("Super+K");
    expect(formatAccelerator("", true)).toBe("");
  });
});

describe("AcceleratorInput", () => {
  it("records a shortcut and can remove it", () => {
    const onChange = vi.fn();
    render(<AcceleratorInput label="Bar" value="Control+Alt+Space" onChange={onChange} />);
    const record = screen.getByLabelText("Bar: adversum.quickSettings.record");
    expect(record.textContent).toBe("⌃⌥Space");

    fireEvent.click(record);
    expect(record.textContent).toBe("adversum.quickSettings.recording");
    expect(screen.queryByLabelText("Bar: adversum.quickSettings.clear")).toBeNull();
    // A lone modifier keeps recording; the event never reaches the page.
    const modifier = press({ key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(modifier.defaultPrevented).toBe(true);
    expect(record.textContent).toBe("adversum.quickSettings.recording");
    press({ key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(onChange).toHaveBeenCalledWith("Control+Alt+K");
    expect(record.textContent).toBe("⌃⌥Space");

    fireEvent.click(screen.getByLabelText("Bar: adversum.quickSettings.clear"));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("cancels recording with Escape, a second click or losing focus", () => {
    mocks.os = "linux";
    const onChange = vi.fn();
    render(<AcceleratorInput label="Bar" value="" onChange={onChange} />);
    const record = screen.getByLabelText("Bar: adversum.quickSettings.record");
    expect(record.textContent).toBe("adversum.quickSettings.none");
    fireEvent.click(record);
    press({ key: "Escape", code: "Escape" });
    expect(record.textContent).toBe("adversum.quickSettings.none");
    fireEvent.click(record);
    fireEvent.click(record);
    expect(record.textContent).toBe("adversum.quickSettings.none");
    fireEvent.click(record);
    fireEvent.blur(record);
    expect(record.textContent).toBe("adversum.quickSettings.none");
    press({ key: "k", code: "KeyK", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("parseAliasInput", () => {
  it("splits on commas, trims and drops duplicates", () => {
    expect(parseAliasInput(" pm, Projekt-Mgmt ,PM,, ")).toEqual(["pm", "Projekt-Mgmt"]);
    expect(parseAliasInput("")).toEqual([]);
  });
});

describe("QuickEntrySection", () => {
  async function renderSection() {
    render(<QuickEntrySection />, { wrapper });
    await waitFor(() => expect(screen.getByText("DUSW Unternehmensgruppe")).toBeTruthy());
  }

  function aliasField(name: string): HTMLInputElement {
    return screen.getByLabelText(`adversum.quickSettings.aliasesFor:${name}`) as HTMLInputElement;
  }

  it("chooses which language model may help with several entries, and says which are there", async () => {
    await renderSection();
    const models = () => document.querySelector("[data-multi-models]")?.textContent;
    await waitFor(() =>
      expect(models()).toBe(
        "adversum.quickSettings.multiModelApple.missing:missing · adversum.quickSettings.multiModelClaude.found",
      ),
    );
    fireEvent.click(screen.getByText("adversum.quickSettings.multiModelMode.device"));
    expect(mocks.settings.update).toHaveBeenCalledWith("multiModel", "device");

    cleanup();
    mocks.getMultiModelStatus.mockResolvedValue({
      mode: "auto",
      apple: "unavailable: appleIntelligenceNotEnabled",
      claude: false,
    });
    await renderSection();
    await waitFor(() =>
      expect(models()).toBe(
        "adversum.quickSettings.multiModelApple.unavailable:unavailable: appleIntelligenceNotEnabled · adversum.quickSettings.multiModelClaude.missing",
      ),
    );

    // Outside the app, or after the page is gone, there is nothing to show.
    cleanup();
    mocks.getMultiModelStatus.mockRejectedValue(new Error("no native side"));
    await renderSection();
    expect(models()).toBeUndefined();
    cleanup();
    let answer!: (value: unknown) => void;
    mocks.getMultiModelStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<QuickEntrySection />, { wrapper });
    cleanup();
    await act(async () => answer({ mode: "auto", apple: "available", claude: true }));
  });

  it("keeps the list of team members", async () => {
    await renderSection();
    const field = screen.getByLabelText("adversum.quickSettings.team") as HTMLInputElement;
    expect(field.value).toBe("Patrick, Michi, Ema, Lennart");
    // Leaving the field unchanged saves nothing.
    fireEvent.blur(field);
    expect(mocks.settings.update).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "Patrick, Ema , patrick," } });
    fireEvent.keyDown(field, { key: "a" });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.blur(field);
    expect(mocks.settings.update).toHaveBeenCalledWith("teamMembers", ["Patrick", "Ema"]);
  });

  it("saves a recorded shortcut and reports a rejected one", async () => {
    await renderSection();
    const record = screen.getByLabelText(
      "adversum.quickSettings.shortcutQuickEntry: adversum.quickSettings.record",
    );
    fireEvent.click(record);
    press({ key: "j", code: "KeyJ", ctrlKey: true, altKey: true });
    await waitFor(() =>
      expect(mocks.settings.update).toHaveBeenCalledWith("shortcutQuickEntry", "Control+Alt+J"),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    mocks.settings.update.mockResolvedValueOnce(false);
    fireEvent.click(
      screen.getByLabelText("adversum.quickSettings.shortcutPreviousTask: adversum.quickSettings.clear"),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("adversum.quickSettings.shortcutRejected"),
    );
    expect(mocks.settings.update).toHaveBeenLastCalledWith("shortcutPreviousTask", "");
  });

  it("lists customers with their aliases and saves edits for the connection", async () => {
    await renderSection();
    expect(aliasField("DUSW Unternehmensgruppe").value).toBe("gigi");
    expect(aliasField("Herosmile").value).toBe("");

    const field = aliasField("Herosmile");
    fireEvent.change(field, { target: { value: "hero, smile" } });
    field.focus();
    fireEvent.keyDown(field, { key: "a" });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(document.activeElement).not.toBe(field);
    fireEvent.blur(field);
    expect(mocks.settings.update).toHaveBeenCalledWith("aliases", {
      conn: {
        customers: { "1": ["gigi"], "2": ["hero", "smile"] },
        projects: {},
        activities: { "1": ["pm"] },
      },
      other: { customers: { "9": ["x"] }, projects: {}, activities: {} },
    });
  });

  it("removes an entity's aliases and ignores an unchanged field", async () => {
    await renderSection();
    const field = aliasField("DUSW Unternehmensgruppe");
    fireEvent.change(field, { target: { value: " gigi , GIGI" } });
    fireEvent.blur(field);
    expect(mocks.settings.update).not.toHaveBeenCalled();
    expect(field.value).toBe("gigi");

    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.blur(field);
    expect(mocks.settings.update).toHaveBeenCalledWith(
      "aliases",
      expect.objectContaining({
        conn: { customers: {}, projects: {}, activities: { "1": ["pm"] } },
      }),
    );
  });

  it("switches between customers, projects and activities and filters them", async () => {
    await renderSection();
    fireEvent.click(screen.getByText("adversum.quickSettings.aliasKind.projects"));
    const rows = screen.getAllByLabelText(/^adversum\.quickSettings\.aliasesFor:/);
    expect(rows).toHaveLength(3);
    // Same project name for two customers: the customer tells them apart.
    const contexts = rows.map((row) => row.closest("[data-settings-item]")!.textContent);
    expect(contexts).toEqual([
      "Marketing RetainerDUSW Unternehmensgruppe",
      "Marketing RetainerHerosmile",
      "Orphan",
    ]);

    fireEvent.change(screen.getByPlaceholderText("adversum.quickSettings.aliasFilter"), {
      target: { value: "HERO" },
    });
    expect(screen.getAllByLabelText(/^adversum\.quickSettings\.aliasesFor:/)).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText("adversum.quickSettings.aliasFilter"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("adversum.quickSettings.noEntries")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("adversum.quickSettings.aliasFilter"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByText("adversum.quickSettings.aliasKind.activities"));
    expect(aliasField("Projektmanagement").value).toBe("pm");
    const reporting = aliasField("Reporting").closest("[data-settings-item]") as HTMLElement;
    expect(within(reporting).getByText("Marketing Retainer")).toBeTruthy();
    fireEvent.change(aliasField("Reporting"), { target: { value: "report" } });
    fireEvent.blur(aliasField("Reporting"));
    expect(mocks.settings.update.mock.lastCall![1].conn.activities).toEqual({
      "1": ["pm"],
      "6": ["report"],
    });
  });

  it("starts from empty aliases for a connection without any", async () => {
    mocks.settings.settings = { ...defaultAdversumSettings };
    await renderSection();
    fireEvent.change(aliasField("Herosmile"), { target: { value: "hero" } });
    fireEvent.blur(aliasField("Herosmile"));
    expect(mocks.settings.update).toHaveBeenCalledWith("aliases", {
      conn: { customers: { "2": ["hero"] }, projects: {}, activities: {} },
    });
  });

  it("explains missing shortcut support and a missing connection", () => {
    mocks.supportsGlobalShortcuts = false;
    mocks.kimai = { client: null, isConfigured: false, activeConnectionId: "" };
    render(<QuickEntrySection />, { wrapper });
    expect(screen.getByText("shortcuts.waylandUnavailable")).toBeTruthy();
    expect(screen.getByText("adversum.quickSettings.noConnection")).toBeTruthy();
    expect(
      (screen.getByLabelText(
        "adversum.quickSettings.shortcutQuickEntry: adversum.quickSettings.record",
      ) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.getCustomers).not.toHaveBeenCalled();
  });
});

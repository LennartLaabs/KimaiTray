// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalog } from "../quickEntry/catalog";
import { EMPTY_HISTORY } from "../quickEntry/history";

const mocks = vi.hoisted(() => ({
  extractWithModel: vi.fn(),
  useDayEntries: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
    i18n: { language: "de" },
  }),
}));
vi.mock("./extract", () => ({ extractWithModel: mocks.extractWithModel }));
vi.mock("./useDayEntries", () => ({ useDayEntries: mocks.useDayEntries }));
vi.mock("../../utils/logger", () => ({ logger: { warn: mocks.warn } }));

import { readMulti } from "./draft";
import MultiStage from "./MultiStage";
import type { Extraction } from "./types";

const now = new Date(2026, 10, 26, 14, 20);
const catalog = buildCatalog(
  [
    { id: 1, name: "DUSW" },
    { id: 3, name: "K&K Global Solutions" },
  ],
  [
    { id: 11, name: "Retainer", customer: 1 },
    { id: 31, name: "Landingpage", customer: 3 },
  ],
  [
    { id: 2, name: "Austausch", project: null },
    { id: 4, name: "Design", project: null },
  ],
  { customers: {}, projects: {}, activities: { "2": ["call"] } },
);

const CLEAR = "Eine Stunde DUSW Design, dazwischen 10 Minuten K&K Call";
const UNSURE = "Eine Stunde Dingsbums, danach 20 Minuten DUSW Design, danach 10 Minuten K&K Call";
const UNKNOWN = "Eine Stunde Dingsbums, danach 20 Minuten Kram";

const onSubmit = vi.fn();
const onClose = vi.fn();
const onSingle = vi.fn();

function show(sentence: string, useModel: boolean) {
  return render(
    <MultiStage
      sentence={sentence}
      reading={readMulti(sentence, catalog, EMPTY_HISTORY, now)}
      catalog={catalog}
      history={EMPTY_HISTORY}
      client={null}
      useModel={useModel}
      onSubmit={onSubmit}
      onClose={onClose}
      onSingle={onSingle}
    />,
  );
}

const better: Extraction = {
  windowMinutes: null,
  day: null,
  clauses: [
    { text: "DUSW Design", amount: { kind: "minutes", minutes: 60 }, relation: "none" },
    { text: "K&K Call", amount: { kind: "minutes", minutes: 20 }, relation: "after" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now });
  mocks.useDayEntries.mockReturnValue({ busy: [], running: null, ready: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the stage for several entries", () => {
  it("shows the review at once when the rules are sure", () => {
    const { container } = show(CLEAR, true);
    expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(3);
    expect(mocks.extractWithModel).not.toHaveBeenCalled();
    expect(onSingle).not.toHaveBeenCalled();
    expect(mocks.useDayEntries).toHaveBeenCalledWith(null, now);
  });

  it("waits for the day's entries", () => {
    mocks.useDayEntries.mockReturnValue({ busy: [], running: null, ready: false });
    show(CLEAR, false);
    expect(screen.getByRole("status").textContent).toBe("adversum.multi.loading");
  });

  it("lets a language model improve an unsure reading", async () => {
    let answer!: (value: unknown) => void;
    mocks.extractWithModel.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { container } = show(UNSURE, true);
    expect(screen.getByText(/adversum\.multi\.refining/)).toBeTruthy();
    expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(3);
    expect(mocks.extractWithModel).toHaveBeenCalledWith(UNSURE, now);

    await act(async () => answer({ extraction: better, source: "claude" }));
    expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(2);
    expect(screen.getByText(/adversum\.multi\.source\.claude$/)).toBeTruthy();
  });

  it("keeps the rules' reading when the model has nothing better", async () => {
    mocks.extractWithModel.mockResolvedValue({
      extraction: { ...better, clauses: [better.clauses[0]!] },
      source: "apple",
    });
    const { container } = show(UNSURE, true);
    await act(async () => undefined);
    expect(container.querySelectorAll("[data-multi-row]")).toHaveLength(3);
    expect(screen.queryByText(/adversum\.multi\.refining/)).toBeNull();
    // Without a model the unsure reading is shown as it is.
    cleanup();
    mocks.extractWithModel.mockClear();
    show(UNSURE, false);
    expect(mocks.extractWithModel).not.toHaveBeenCalled();
  });

  it("asks a model about a sentence the rules could not split, and falls back to one entry", async () => {
    let answer!: (value: unknown) => void;
    mocks.extractWithModel.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    show(UNKNOWN, true);
    expect(screen.getByRole("status").textContent).toBe("adversum.multi.refining");
    expect(onSingle).not.toHaveBeenCalled();
    await act(async () => answer(null));
    expect(onSingle).toHaveBeenCalledTimes(1);

    // The model found the two activities.
    cleanup();
    onSingle.mockClear();
    mocks.extractWithModel.mockResolvedValue({ extraction: better, source: "apple" });
    const found = show(UNKNOWN, true);
    await act(async () => undefined);
    expect(found.container.querySelectorAll("[data-multi-row]")).toHaveLength(2);
    expect(onSingle).not.toHaveBeenCalled();
  });

  it("is one entry when the model fails or may not be asked", async () => {
    mocks.extractWithModel.mockRejectedValue(new Error("offline"));
    show(UNKNOWN, true);
    await act(async () => undefined);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("offline"));
    expect(onSingle).toHaveBeenCalledTimes(1);

    cleanup();
    onSingle.mockClear();
    show(UNKNOWN, false);
    expect(onSingle).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer that arrives after it was closed", async () => {
    let answer!: (value: unknown) => void;
    mocks.extractWithModel.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { unmount } = show(UNKNOWN, true);
    unmount();
    await act(async () => answer({ extraction: better, source: "apple" }));
    expect(onSingle).not.toHaveBeenCalled();
  });
});

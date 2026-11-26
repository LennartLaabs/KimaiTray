// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCatalog } from "../quickEntry/catalog";
import { EMPTY_HISTORY } from "../quickEntry/history";
import { readMulti } from "./draft";
import MultiReview from "./MultiReview";
import type { Interval } from "./plan";
import type { MultiDraft } from "./types";
import type { RunningEntry } from "./useDayEntries";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      options ? `${key}:${Object.values(options).join(",")}` : key,
    i18n: { language: "de" },
  }),
}));

/** Thursday 26 November 2026, 14:20. */
const now = new Date(2026, 10, 26, 14, 20);
const catalog = buildCatalog(
  [
    { id: 1, name: "DUSW" },
    { id: 2, name: "SolarTech NRW" },
    { id: 3, name: "K&K Global Solutions" },
  ],
  [
    { id: 11, name: "Retainer", customer: 1 },
    { id: 21, name: "Imagefilm", customer: 2 },
    { id: 31, name: "Landingpage", customer: 3 },
  ],
  [
    { id: 1, name: "Projektmanagement", project: null },
    { id: 2, name: "Austausch", project: null },
    { id: 4, name: "Design", project: null },
  ],
  { customers: {}, projects: {}, activities: { "2": ["call"] } },
);

const onSubmit = vi.fn();
const onClose = vi.fn();

function draftOf(sentence: string): MultiDraft {
  const { draft } = readMulti(sentence, catalog, EMPTY_HISTORY, now);
  if (!draft) throw new Error(`"${sentence}" is not several entries`);
  return draft;
}

function show(
  sentence: string,
  props: { busy?: Interval[]; running?: RunningEntry | null; refining?: boolean; draft?: MultiDraft } = {},
) {
  return render(
    <MultiReview
      draft={props.draft ?? draftOf(sentence)}
      catalog={catalog}
      history={EMPTY_HISTORY}
      busy={props.busy ?? []}
      running={props.running ?? null}
      refining={props.refining}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
}

const HOUR = "Eine Stunde DUSW Design, dazwischen 10 Minuten K&K Call";

function rows(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-multi-row]")].map((row) => {
    const [begin, end] = [...row.querySelectorAll<HTMLInputElement>("input[aria-invalid]")];
    return `${begin!.value}–${end!.value} ${row.querySelector("button")!.textContent}`;
  });
}

function root(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>("[data-multi-review]")!;
}

function total(container: HTMLElement): string | null {
  return container.querySelector("[data-multi-total]")!.textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the review of several entries", () => {
  it("shows one row per block and enters them all with Enter", () => {
    const { container } = show(HOUR);
    expect(document.activeElement).toBe(root(container));
    expect(rows(container)).toEqual([
      "13:20–13:45 DUSW · Design",
      "13:45–13:55 K&K Global Solutions · Austausch",
      "13:55–14:20 DUSW · Design",
    ]);
    expect(total(container)).toBe("adversum.multi.total:1 h");
    expect(screen.getByText(/^adversum\.multi\.title:3/)).toBeTruthy();
    expect(screen.getByText("Heute")).toBeTruthy();
    expect([...container.querySelectorAll("[data-multi-duration]")].map((cell) => cell.textContent))
      .toEqual(["25 min", "10 min", "25 min"]);

    fireEvent.keyDown(root(container), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({
      type: "batch",
      timer: null,
      label: "adversum.multi.toastLabel:3,1 h",
      entries: [
        { projectId: 11, activityId: 4, description: "", begin: "2026-11-26T13:20:00", end: "2026-11-26T13:45:00" },
        { projectId: 31, activityId: 2, description: "Call", begin: "2026-11-26T13:45:00", end: "2026-11-26T13:55:00" },
        { projectId: 11, activityId: 4, description: "", begin: "2026-11-26T13:55:00", end: "2026-11-26T14:20:00" },
      ],
    });
  });

  it("switches an interruption between out of the time, on top, and merged", () => {
    const { container } = show(HOUR);
    expect(screen.getByText("adversum.multi.within.included")).toBeTruthy();
    fireEvent.click(screen.getByText("adversum.multi.within.toAdditional"));
    expect(screen.getByText("adversum.multi.within.additional")).toBeTruthy();
    expect(total(container)).toBe("adversum.multi.total:1 h 10 min");
    fireEvent.click(screen.getByText("adversum.multi.within.toIncluded"));
    expect(total(container)).toBe("adversum.multi.total:1 h");

    fireEvent.click(screen.getByText("adversum.multi.within.toMerged"));
    expect(rows(container)).toEqual([
      "13:20–14:10 DUSW · Design",
      "14:10–14:20 K&K Global Solutions · Austausch",
    ]);
    fireEvent.click(screen.getByText("adversum.multi.within.toSplit"));
    expect(rows(container)).toHaveLength(3);
  });

  it("leaves out unchecked rows and takes edited times, notes and tasks", () => {
    const { container } = show(HOUR);
    const [, , last] = screen.getAllByLabelText("adversum.multi.include");
    fireEvent.click(last!);
    expect(total(container)).toBe("adversum.multi.total:35 min");

    const [begin] = screen.getAllByLabelText("adversum.multi.begin");
    fireEvent.change(begin!, { target: { value: "13:00" } });
    expect(total(container)).toBe("adversum.multi.total:55 min");
    const [note] = screen.getAllByLabelText("adversum.multi.noteField");
    fireEvent.change(note!, { target: { value: " Startseite " } });

    // Another task for the call: type, then Enter takes the first match.
    fireEvent.click(screen.getByText("K&K Global Solutions · Austausch"));
    const picker = screen.getByLabelText("adversum.multi.task");
    expect(container.querySelectorAll("[data-multi-option]").length).toBeGreaterThan(0);
    fireEvent.change(picker, { target: { value: "solartech pm" } });
    fireEvent.keyDown(picker, { key: "Enter" });
    expect(screen.queryByLabelText("adversum.multi.task")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("adversum.multi.submit"));
    expect(onSubmit.mock.lastCall![0]).toMatchObject({
      label: "adversum.multi.toastLabel:2,55 min",
      entries: [
        { projectId: 11, activityId: 4, description: "Startseite", begin: "2026-11-26T13:00:00" },
        { projectId: 21, activityId: 1, description: "Call" },
      ],
    });
  });

  it("picks a task by click and closes the picker with Escape first", () => {
    const { container } = show(HOUR);
    fireEvent.click(screen.getAllByText("DUSW · Design")[0]!);
    fireEvent.keyDown(root(container), { key: "Escape" });
    expect(screen.queryByLabelText("adversum.multi.task")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText("DUSW · Design")[0]!);
    // Enter while picking does not enter the entries.
    fireEvent.keyDown(root(container), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("adversum.multi.task"), {
      target: { value: "landingpage projektmanagement" },
    });
    fireEvent.click(container.querySelector("[data-multi-option='31-1']")!);
    // Both blocks of the interrupted activity change with it.
    expect(rows(container)).toEqual([
      "13:20–13:45 K&K Global Solutions · Projektmanagement",
      "13:45–13:55 K&K Global Solutions · Austausch",
      "13:55–14:20 K&K Global Solutions · Projektmanagement",
    ]);

    fireEvent.keyDown(root(container), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not enter rows with a time that cannot be", () => {
    const { container } = show(HOUR);
    const [end] = screen.getAllByLabelText("adversum.multi.end");
    fireEvent.change(end!, { target: { value: "13:10" } });
    expect(container.querySelector("[data-multi-duration]")!.textContent).toBe("–");
    fireEvent.keyDown(root(container), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(end!, { target: { value: "quatsch" } });
    expect(end!.getAttribute("aria-invalid")).toBe("true");
    const [begin] = screen.getAllByLabelText("adversum.multi.begin");
    fireEvent.change(begin!, { target: { value: "" } });
    expect(begin!.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByText("adversum.multi.submit") as HTMLButtonElement).disabled).toBe(true);
    // Switching the plan drops typed times but keeps what was unchecked.
    fireEvent.click(screen.getAllByLabelText("adversum.multi.include")[1]!);
    fireEvent.click(screen.getByText("adversum.multi.within.toMerged"));
    expect(rows(container)[0]).toBe("13:20–14:10 DUSW · Design");
    expect(total(container)).toBe("adversum.multi.total:50 min");
  });

  it("asks what was not said and marks what was assumed", () => {
    const { container } = show(
      "Die letzten 3 Stunden immer wieder DUSW Designs je 7 Minuten, 8 mal kurz K&K Call, der Rest SolarTech",
    );
    expect(container.querySelector("[data-multi-question='count']")!.textContent).toContain(
      "DUSW · Design · adversum.multi.question.count",
    );
    expect(screen.getByText("adversum.multi.hintQuestions")).toBeTruthy();
    expect(container.querySelector("[data-multi-note='vague']")).not.toBeNull();
    fireEvent.keyDown(root(container), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();

    const question = screen.getByLabelText("adversum.multi.question.count");
    fireEvent.change(question, { target: { value: "0" } });
    expect(container.querySelector("[data-multi-question]")).not.toBeNull();
    fireEvent.change(question, { target: { value: "6" } });
    expect(container.querySelector("[data-multi-question]")).toBeNull();
    expect(rows(container)).toEqual([
      "11:20–12:02 DUSW · Design",
      "12:02–12:42 K&K Global Solutions · Austausch",
      "12:42–14:20 SolarTech NRW · Projektmanagement",
    ]);
    expect(total(container)).toBe("adversum.multi.total:3 h");
  });

  it("leaves an activity out instead of answering", () => {
    const { container } = show("Mehrmals je 10 Minuten DUSW Design, danach 20 Minuten K&K Call");
    fireEvent.click(screen.getByText("adversum.multi.leaveOut"));
    expect(rows(container)).toEqual(["14:00–14:20 K&K Global Solutions · Austausch"]);
    // A duration instead of a count is asked the same way.
    cleanup();
    const asked = show("Drei mal DUSW Design, danach 20 Minuten K&K Call");
    fireEvent.change(screen.getByLabelText("adversum.multi.question.each"), {
      target: { value: "15" },
    });
    expect(rows(asked.container)[0]).toBe("13:15–14:00 DUSW · Design");
  });

  it("ends the running timer where the entries begin, replaces it, or keeps it", () => {
    const running: RunningEntry = {
      id: 77,
      projectId: 11,
      activityId: 4,
      description: "",
      begin: new Date(2026, 10, 26, 13, 0),
    };
    const { container } = show(HOUR, { running });
    const chip = () => container.querySelector("[data-multi-timer]")!.textContent;
    expect(chip()).toContain("adversum.multi.timer.cut:DUSW · Design,13:20");
    fireEvent.keyDown(root(container), { key: "Enter" });
    expect(onSubmit.mock.lastCall![0]).toMatchObject({
      timer: { id: 77, end: "2026-11-26T13:20:00" },
    });

    // Kept: its time is taken, the entries lie before it.
    fireEvent.click(screen.getByText("adversum.multi.timer.toKeep"));
    expect(chip()).toContain("adversum.multi.timer.kept:DUSW · Design");
    expect(rows(container)[0]).toBe("12:00–12:25 DUSW · Design");
    fireEvent.keyDown(root(container), { key: "Enter" });
    expect(onSubmit.mock.lastCall![0]).toMatchObject({ timer: null });
    fireEvent.click(screen.getByText("adversum.multi.timer.toAdjust"));
    expect(chip()).toContain("adversum.multi.timer.cut");

    // A timer that began inside the entries' time goes away entirely.
    cleanup();
    const late = show(HOUR, {
      running: { ...running, projectId: 99, begin: new Date(2026, 10, 26, 14, 0) },
    });
    expect(late.container.querySelector("[data-multi-timer]")!.textContent).toContain(
      "adversum.multi.timer.replaced:adversum.multi.timer.unknown",
    );
    fireEvent.keyDown(root(late.container), { key: "Enter" });
    expect(onSubmit.mock.lastCall![0]).toMatchObject({ timer: { id: 77, end: null } });

    // A timer that began after everything is none of the review's business.
    cleanup();
    const after = show(HOUR, {
      running: { ...running, begin: new Date(2026, 10, 26, 14, 20) },
    });
    expect(after.container.querySelector("[data-multi-timer]")).toBeNull();
  });

  it("flows around existing entries and says so", () => {
    const { container } = show(HOUR, {
      busy: [
        { begin: new Date(2026, 10, 26, 13, 50).getTime(), end: new Date(2026, 10, 26, 14, 0).getTime() },
      ],
    });
    expect(rows(container)).toEqual([
      "13:10–13:35 DUSW · Design",
      "13:35–13:45 K&K Global Solutions · Austausch",
      "13:45–13:50 DUSW · Design",
      "14:00–14:20 DUSW · Design",
    ]);
    expect(container.querySelector("[data-multi-note='busy']")).not.toBeNull();
  });

  it("shows a break without entering it, and what was assumed about tasks", () => {
    const { container } = show(
      "Zwei Stunden SolarTech Design, dazwischen eine Viertelstunde Pause, danach 20 Minuten Korrekturen",
    );
    expect(rows(container)[1]).toBe("12:53–13:08 adversum.multi.break");
    const boxes = screen.getAllByLabelText("adversum.multi.include") as HTMLInputElement[];
    expect(boxes[1]!.disabled).toBe(true);
    expect(boxes[1]!.checked).toBe(false);
    expect(screen.getByText("adversum.multi.inherited")).toBeTruthy();
    expect(total(container)).toBe("adversum.multi.total:2 h 5 min");
    fireEvent.keyDown(root(container), { key: "Enter" });
    expect(onSubmit.mock.lastCall![0].entries).toHaveLength(3);
  });

  it("names the day, the model that read the sentence and plan-wide notes", () => {
    const draft: MultiDraft = {
      ...draftOf("Gestern eine Stunde DUSW Design, danach 20 Minuten K&K Call"),
      source: "claude",
    };
    const { container } = show("", { draft, refining: true });
    expect(
      screen.getByText(/^Gestern, 25\.11\. · adversum\.multi\.source\.claude · adversum\.multi\.refining$/),
    ).toBeTruthy();
    expect(container.querySelector("[data-multi-note='defaultStart']")).not.toBeNull();
    expect(rows(container)[0]).toBe("9:00–10:00 DUSW · Design");
  });

  it("marks a guessed task and waits for one where there is none", () => {
    const base = draftOf(HOUR);
    const guessed: MultiDraft = {
      ...base,
      items: [
        { ...base.items[0]!, guessed: true },
        { ...base.items[1]!, suggestions: [], text: "Dingsbums" },
      ],
    };
    const { container } = show("", { draft: guessed });
    expect(screen.getByText("adversum.multi.guessed")).toBeTruthy();
    expect(screen.getByText("adversum.multi.noTask")).toBeTruthy();
    expect((screen.getByText("adversum.multi.submit") as HTMLButtonElement).disabled).toBe(true);
    // Its empty picker offers nothing until something is typed.
    fireEvent.click(screen.getByText("adversum.multi.noTask"));
    expect(container.querySelectorAll("[data-multi-option]")).toHaveLength(0);
    fireEvent.keyDown(screen.getByLabelText("adversum.multi.task"), { key: "Enter" });
    expect(screen.getByText("adversum.multi.noTask")).toBeTruthy();
    fireEvent.click(screen.getByText("adversum.multi.noTask"));
    fireEvent.keyDown(screen.getByLabelText("adversum.multi.task"), { key: "a" });
    fireEvent.change(screen.getByLabelText("adversum.multi.task"), {
      target: { value: "landingpage call" },
    });
    fireEvent.keyDown(screen.getByLabelText("adversum.multi.task"), { key: "Enter" });
    expect((screen.getByText("adversum.multi.submit") as HTMLButtonElement).disabled).toBe(false);
    // An unanswered question of a task without a label shows its words.
    cleanup();
    const asking: MultiDraft = {
      ...base,
      items: [base.items[0]!, { ...guessed.items[1]!, amount: { kind: "unknown" }, relation: "none" }],
    };
    const asked = show("", { draft: asking });
    expect(asked.container.querySelector("[data-multi-question]")!.textContent).toContain("Dingsbums");
  });
});

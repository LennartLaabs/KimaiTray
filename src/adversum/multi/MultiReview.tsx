import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toKimaiLocal } from "../../utils/time";
import { useAdversumDisplay } from "../display/displayStore";
import { localMinute } from "../feedback/feedback";
import CustomerAvatar from "../logos/CustomerAvatar";
import type { BatchEntry, QuickAction } from "../quickEntry/actions";
import type { QuickCatalog } from "../quickEntry/catalog";
import type { QuickHistory } from "../quickEntry/history";
import { parseQuickEntry, type QuickSuggestion } from "../quickEntry/parse";
import { dayLabel } from "../quickEntry/SuggestionRow";
import { clockText, formatMinutes, parseClock } from "./format";
import {
  interruptedItems,
  planEntries,
  type Interval,
  type PlanChoice,
  type PlanNoteCode,
} from "./plan";
import type { DraftItem, MultiDraft } from "./types";
import type { RunningEntry } from "./useDayEntries";

/**
 * The review of several entries before they are entered: one row per block
 * with a check mark, task, note, begin, end and duration, all editable.
 * Assumptions are marked yellow and can be switched; what is missing is asked
 * right there. Enter enters all checked rows, Esc discards.
 */

interface MultiReviewProps {
  draft: MultiDraft;
  catalog: QuickCatalog;
  history: QuickHistory;
  /** Entries of the day that new ones must not overlap. */
  busy: readonly Interval[];
  running: RunningEntry | null;
  /** The reading is being improved by a language model. */
  refining?: boolean;
  onSubmit: (action: QuickAction) => void;
  onClose: () => void;
  /**
   * Shows "Falsch verstanden". Called when a review that was marked so ends:
   * with what the review first showed, and with the entries that were
   * entered instead (`null` when it was discarded).
   */
  onMisunderstood?: (recognized: unknown, corrected: BatchEntry[] | null) => void;
}

interface RowEdit {
  off?: boolean;
  begin?: string;
  end?: string;
}

const INPUT =
  "rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] tabular-nums text-gray-700 hover:border-gray-300 focus:border-[var(--accent)] focus:bg-white focus:outline-none dark:text-gray-200 dark:hover:border-white/20 dark:focus:bg-black/30";
const CHIP =
  "inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
const SWITCH =
  "rounded bg-amber-200/80 px-1 font-semibold hover:bg-amber-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-600 dark:bg-amber-800/60 dark:hover:bg-amber-700";

function taskLabel(suggestion: QuickSuggestion | undefined): string {
  return suggestion ? `${suggestion.combination.customer} · ${suggestion.combination.activity}` : "";
}

export default function MultiReview({
  draft,
  catalog,
  history,
  busy,
  running,
  refining = false,
  onSubmit,
  onClose,
  onMisunderstood,
}: MultiReviewProps) {
  const { t, i18n } = useTranslation();
  const display = useAdversumDisplay();
  const [now] = useState(() => new Date());
  const [choices, setChoices] = useState<Record<number, PlanChoice>>({});
  const [dropped, setDropped] = useState<ReadonlySet<number>>(new Set());
  const [tasks, setTasks] = useState<Record<number, QuickSuggestion>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [keepTimer, setKeepTimer] = useState(false);
  /** The row whose task is being changed, and what was typed for it. */
  const [picking, setPicking] = useState<{ item: number; text: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [flagged, setFlagged] = useState(false);
  /** What the review showed before anything was changed in it. */
  const firstShown = useRef<unknown>(null);

  useEffect(() => rootRef.current?.focus(), []);

  const items = useMemo(
    () => draft.items.filter((item) => !dropped.has(item.id)),
    [draft.items, dropped],
  );
  const plan = useMemo(
    () =>
      planEntries({
        items,
        windowMinutes: draft.windowMinutes,
        day: draft.day,
        now,
        busy:
          keepTimer && running
            ? [...busy, { begin: running.begin.getTime(), end: now.getTime() }]
            : busy,
        choices,
      }),
    [items, draft.windowMinutes, draft.day, now, busy, running, keepTimer, choices],
  );
  const interrupted = useMemo(() => interruptedItems(items), [items]);
  const itemOf = (id: number): DraftItem => draft.items.find((item) => item.id === id)!;
  const taskOf = (item: DraftItem) => tasks[item.id] ?? item.suggestions[0];

  // One row per block; the same activity can have several.
  const seen = new Map<number, number>();
  const rows = plan.blocks.map((block) => {
    const part = seen.get(block.item) ?? 0;
    seen.set(block.item, part + 1);
    const key = `${block.item}:${part}`;
    const edit = edits[key] ?? {};
    const begin = edit.begin === undefined ? block.begin : parseClock(edit.begin, block.begin);
    const end = edit.end === undefined ? block.end : parseClock(edit.end, block.begin);
    const item = itemOf(block.item);
    const valid = !!begin && !!end && end.getTime() > begin.getTime();
    return {
      key,
      item,
      part,
      begin,
      end,
      beginText: edit.begin ?? clockText(block.begin),
      endText: edit.end ?? clockText(block.end),
      valid,
      minutes: valid ? Math.round((end.getTime() - begin.getTime()) / 60_000) : 0,
      on: !edit.off && !item.gap,
    };
  });
  if (firstShown.current === null) {
    firstShown.current = {
      readBy: draft.source,
      entries: rows.map((row) => ({
        task: row.item.gap ? "Pause" : taskLabel(taskOf(row.item)) || "?",
        note: taskOf(row.item)?.note ?? "",
        begin: row.begin ? localMinute(row.begin) : "",
        end: row.end ? localMinute(row.end) : "",
      })),
      asked: plan.questions.map((question) => ({
        task: taskLabel(taskOf(itemOf(question.item))) || itemOf(question.item).text,
        question: question.kind,
      })),
      assumed: plan.notes.map((note) => note.code),
    };
  }
  const entered = rows.filter((row) => row.on);
  const total = entered.reduce((sum, row) => sum + row.minutes, 0);
  const ready =
    plan.questions.length === 0 &&
    entered.length > 0 &&
    entered.every((row) => row.valid && taskOf(row.item));

  // What happens to the running timer: the entries describe its time.
  const firstBegin = Math.min(...entered.filter((row) => row.valid).map((row) => row.begin!.getTime()));
  const overlapsTimer =
    !!running &&
    !keepTimer &&
    entered.some((row) => row.valid && row.end!.getTime() > running.begin.getTime());
  const timerEnd =
    overlapsTimer && firstBegin > running.begin.getTime() ? new Date(firstBegin) : null;
  const runningTask = running
    ? catalog.combinations.find(
        (item) => item.projectId === running.projectId && item.activityId === running.activityId,
      )
    : undefined;
  const runningLabel = runningTask
    ? `${runningTask.customer} · ${runningTask.activity}`
    : t("adversum.multi.timer.unknown");

  const edit = (key: string, change: RowEdit) =>
    setEdits((current) => ({ ...current, [key]: { ...current[key], ...change } }));
  const choose = (item: number, change: PlanChoice) => {
    setChoices((current) => ({ ...current, [item]: { ...current[item], ...change } }));
    // Times typed for the old plan no longer fit the new one.
    setEdits((current) =>
      Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { off: value.off }])),
    );
  };

  const submit = () => {
    if (!ready) return;
    const entries: BatchEntry[] = entered.map((row) => {
      const task = taskOf(row.item)!;
      return {
        projectId: task.combination.projectId,
        activityId: task.combination.activityId,
        description: (notes[row.item.id] ?? task.note).trim(),
        begin: toKimaiLocal(row.begin!),
        end: toKimaiLocal(row.end!),
      };
    });
    if (flagged) onMisunderstood?.(firstShown.current, entries);
    onSubmit({
      type: "batch",
      entries,
      timer: overlapsTimer ? { id: running.id, end: timerEnd ? toKimaiLocal(timerEnd) : null } : null,
      label: t("adversum.multi.toastLabel", {
        count: entries.length,
        duration: formatMinutes(total),
      }),
    });
  };

  const options = picking
    ? picking.text.trim() === ""
      ? itemOf(picking.item).suggestions
      : parseQuickEntry(picking.text, catalog, history, now, {}).suggestions
    : [];
  const pick = (suggestion: QuickSuggestion | undefined) => {
    if (picking && suggestion) {
      // What was typed finds the task; the note stays the one of the row.
      const note = taskOf(itemOf(picking.item))?.note ?? "";
      setTasks((current) => ({ ...current, [picking.item]: { ...suggestion, note } }));
    }
    setPicking(null);
    rootRef.current?.focus();
  };

  const noteText = (code: PlanNoteCode) => t(`adversum.multi.note.${code}`);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-multi-review
      className="outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (picking) pick(undefined);
          else {
            if (flagged) onMisunderstood?.(firstShown.current, null);
            onClose();
          }
        } else if (event.key === "Enter" && !picking) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="flex items-baseline gap-2 px-3.5 pb-1.5 pt-3">
        <span className="text-[13px] font-semibold text-gray-900 dark:text-gray-100">
          {t("adversum.multi.title", { count: entered.length })}
        </span>
        <span className="text-[11px] text-gray-500 dark:text-gray-400">
          {dayLabel(draft.day ?? now, now, i18n.language)}
          {` · ${t(`adversum.multi.source.${draft.source}`)}`}
          {refining && ` · ${t("adversum.multi.refining")}`}
        </span>
      </div>

      {plan.questions.map((question) => {
        const item = itemOf(question.item);
        const counting = question.kind === "count";
        return (
          <div
            key={`question-${question.item}`}
            data-multi-question={question.kind}
            className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:bg-amber-900/25 dark:text-amber-200"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="font-semibold">{taskLabel(taskOf(item)) || item.text}</span>
              {" · "}
              {t(`adversum.multi.question.${question.kind}`)}
            </span>
            <input
              type="number"
              min={1}
              aria-label={t(`adversum.multi.question.${question.kind}`)}
              className="w-14 rounded border border-amber-300 bg-white px-1 py-0.5 text-right text-[11px] tabular-nums text-gray-900 focus:border-[var(--accent)] focus:outline-none dark:border-amber-700 dark:bg-black/30 dark:text-gray-100"
              onChange={(event) => {
                const value = Number(event.target.value);
                if (value > 0) choose(item.id, counting ? { count: value } : { minutes: value });
              }}
            />
            <button
              type="button"
              className={SWITCH}
              onClick={() => setDropped((current) => new Set([...current, item.id]))}
            >
              {t("adversum.multi.leaveOut")}
            </button>
          </div>
        );
      })}

      <div role="table" className="max-h-[340px] overflow-y-auto px-2">
        {rows.map((row) => {
          const task = taskOf(row.item);
          const itemNotes = plan.notes.filter((note) => note.item === row.item.id && row.part === 0);
          const choice = choices[row.item.id] ?? {};
          const open = picking?.item === row.item.id && row.part === 0;
          return (
            <div
              key={row.key}
              role="row"
              data-multi-row={row.key}
              className={`mb-1 rounded-md px-1.5 py-1 ${row.on ? "" : "opacity-50"} ${
                itemNotes.length > 0 || row.item.inherited || row.item.guessed
                  ? "border-l-2 border-amber-400"
                  : "border-l-2 border-transparent"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={t("adversum.multi.include")}
                  checked={row.on}
                  disabled={row.item.gap}
                  onChange={(event) => edit(row.key, { off: !event.target.checked })}
                />
                {task && !row.item.gap && (
                  <CustomerAvatar
                    name={task.combination.customer}
                    color={task.combination.customerColor}
                    logo={display?.logos.get(task.combination.customerId)}
                    size={18}
                    dotColor={task.combination.activityColor || undefined}
                  />
                )}
                <button
                  type="button"
                  disabled={row.item.gap}
                  title={task ? `${task.combination.customer} · ${task.combination.project} · ${task.combination.activity}` : undefined}
                  className="min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-[12px] font-semibold text-gray-800 hover:bg-black/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] dark:text-gray-200 dark:hover:bg-white/10"
                  onClick={() => setPicking({ item: row.item.id, text: "" })}
                >
                  {row.item.gap
                    ? t("adversum.multi.break")
                    : taskLabel(task) || t("adversum.multi.noTask")}
                </button>
                <input
                  aria-label={t("adversum.multi.begin")}
                  aria-invalid={!row.begin}
                  value={row.beginText}
                  onChange={(event) => edit(row.key, { begin: event.target.value })}
                  className={`${INPUT} w-11 text-right ${row.begin ? "" : "text-red-600"}`}
                />
                <span className="text-[11px] text-gray-400">–</span>
                <input
                  aria-label={t("adversum.multi.end")}
                  aria-invalid={!row.valid}
                  value={row.endText}
                  onChange={(event) => edit(row.key, { end: event.target.value })}
                  className={`${INPUT} w-11 text-right ${row.valid ? "" : "text-red-600"}`}
                />
                <span
                  data-multi-duration
                  className="w-16 shrink-0 text-right text-[11px] tabular-nums text-gray-500 dark:text-gray-400"
                >
                  {row.valid ? formatMinutes(row.minutes) : "–"}
                </span>
              </div>

              {open && (
                <div className="ml-6 mt-1 rounded-md border border-black/10 bg-white p-1 dark:border-white/10 dark:bg-[#262626]">
                  <input
                    autoFocus
                    aria-label={t("adversum.multi.task")}
                    placeholder={t("adversum.quick.placeholder")}
                    value={picking.text}
                    onChange={(event) => setPicking({ item: row.item.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        pick(options[0]);
                      }
                    }}
                    className="mb-1 w-full rounded border border-gray-200 bg-transparent px-1.5 py-0.5 text-[12px] text-gray-900 focus:border-[var(--accent)] focus:outline-none dark:border-white/15 dark:text-gray-100"
                  />
                  {options.map((option) => (
                    <button
                      key={option.combination.key}
                      type="button"
                      data-multi-option={option.combination.key}
                      className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] text-gray-700 hover:bg-[var(--accent-light)] dark:text-gray-200"
                      onClick={() => pick(option)}
                    >
                      {option.combination.customer} · {option.combination.project} ·{" "}
                      {option.combination.activity}
                    </button>
                  ))}
                </div>
              )}

              {!row.item.gap && row.part === 0 && (
                <div className="ml-6 mt-0.5 flex flex-wrap items-center gap-1">
                  <input
                    aria-label={t("adversum.multi.noteField")}
                    placeholder={t("adversum.multi.noteField")}
                    value={notes[row.item.id] ?? task?.note ?? ""}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [row.item.id]: event.target.value }))
                    }
                    className={`${INPUT} min-w-[120px] flex-1 text-gray-600 dark:text-gray-300`}
                  />
                  {row.item.inherited && <span className={CHIP}>{t("adversum.multi.inherited")}</span>}
                  {row.item.guessed && <span className={CHIP}>{t("adversum.multi.guessed")}</span>}
                  {itemNotes.map((note) => (
                    <span key={note.code} className={CHIP} data-multi-note={note.code}>
                      {noteText(note.code)}
                    </span>
                  ))}
                  {interrupted.has(row.item.id) && (
                    <span className={CHIP} data-multi-note="within">
                      {t(
                        choice.additional
                          ? "adversum.multi.within.additional"
                          : "adversum.multi.within.included",
                      )}
                      <button
                        type="button"
                        className={SWITCH}
                        onClick={() => choose(row.item.id, { additional: !choice.additional })}
                      >
                        {t(
                          choice.additional
                            ? "adversum.multi.within.toIncluded"
                            : "adversum.multi.within.toAdditional",
                        )}
                      </button>
                      <button
                        type="button"
                        className={SWITCH}
                        onClick={() => choose(row.item.id, { merge: !choice.merge })}
                      >
                        {t(choice.merge ? "adversum.multi.within.toSplit" : "adversum.multi.within.toMerged")}
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(plan.notes.some((note) => note.item === null) || running) && (
        <div className="flex flex-wrap gap-1 px-3.5 pb-1 pt-0.5">
          {plan.notes
            .filter((note) => note.item === null)
            .map((note) => (
              <span key={note.code} className={CHIP} data-multi-note={note.code}>
                {noteText(note.code)}
              </span>
            ))}
          {running && (keepTimer || overlapsTimer) && (
            <span className={CHIP} data-multi-timer>
              {keepTimer
                ? t("adversum.multi.timer.kept", { label: runningLabel })
                : timerEnd
                  ? t("adversum.multi.timer.cut", { label: runningLabel, time: clockText(timerEnd) })
                  : t("adversum.multi.timer.replaced", { label: runningLabel })}
              <button type="button" className={SWITCH} onClick={() => setKeepTimer(!keepTimer)}>
                {t(keepTimer ? "adversum.multi.timer.toAdjust" : "adversum.multi.timer.toKeep")}
              </button>
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-black/5 px-3.5 py-2 dark:border-white/10">
        <span data-multi-total className="text-[12px] font-semibold tabular-nums text-gray-800 dark:text-gray-200">
          {t("adversum.multi.total", { duration: formatMinutes(total) })}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-gray-400 dark:text-gray-500">
          {t(plan.questions.length > 0 ? "adversum.multi.hintQuestions" : "adversum.multi.hint")}
        </span>
        {onMisunderstood && (
          <button
            type="button"
            data-misunderstood
            aria-pressed={flagged}
            title={t("adversum.feedback.reviewHint")}
            onClick={() => setFlagged(!flagged)}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
              flagged
                ? "bg-amber-100 font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                : "text-gray-500 underline decoration-dotted hover:text-[var(--accent)] dark:text-gray-400"
            }`}
          >
            {t(flagged ? "adversum.feedback.flagged" : "adversum.feedback.button")}
          </button>
        )}
        <button
          type="button"
          disabled={!ready}
          onClick={submit}
          className="shrink-0 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-40"
        >
          {t("adversum.multi.submit")}
        </button>
      </div>
    </div>
  );
}

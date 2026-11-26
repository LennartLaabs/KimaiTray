import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAdversumDisplay } from "../display/displayStore";
import CustomerAvatar from "../logos/CustomerAvatar";
import type { QuickStartMode } from "./actions";
import type { QuickCommand } from "./commands";
import type { QuickSuggestion } from "./parse";
import type { TimeSpec } from "./timeParser";

/**
 * One row of the suggestion list, shared by the quick entry bar and the
 * confirmation card of voice input.
 */

function clockTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The day of an entry for the chip: "Heute", "Gestern, 25.11.", "Fr., 20.11."
 * and with the year when it is not this one.
 */
export function dayLabel(day: Date, now: Date, language: string): string {
  const midnight = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((midnight(now) - midnight(day)) / 86_400_000);
  const near = daysAgo >= 0 && daysAgo <= 2;
  const date = new Intl.DateTimeFormat(language, {
    ...(near ? {} : { weekday: "short" }),
    day: "numeric",
    month: "numeric",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(day);
  if (!near) return date;
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
    -daysAgo,
    "day",
  );
  const word = relative.charAt(0).toUpperCase() + relative.slice(1);
  return daysAgo === 0 ? word : `${word}, ${date}`;
}

export function TimeChip({ time, day = null }: { time: TimeSpec; day?: Date | null }) {
  const { t, i18n } = useTranslation();
  if (time.kind === "none") return null;
  const warning = time.kind === "future" || time.kind === "incomplete";
  const date = day ? `${dayLabel(day, new Date(), i18n.language)} · ` : "";
  return (
    <span
      data-chip="time"
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
        warning
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      }`}
    >
      {date}
      {time.kind === "start"
        ? t("adversum.quick.since", { time: clockTime(time.begin) })
        : time.kind === "range"
          ? `${clockTime(time.begin)}–${clockTime(time.end)}`
          : t(
              time.kind === "future"
                ? "adversum.quick.futureTime"
                : "adversum.quick.incompleteTime",
            )}
    </span>
  );
}

interface QuickRowProps {
  id: string;
  selected: boolean;
  onSelect: () => void;
  onRun: (mode: QuickStartMode) => void;
  children: ReactNode;
}

export function QuickRow({ id, selected, onSelect, onRun, children }: QuickRowProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseMove={onSelect}
      onMouseDown={(event) => {
        // Keep the text field focused; a blur would close the list first.
        event.preventDefault();
        onRun(event.metaKey || event.ctrlKey ? "interrupt" : "switch");
      }}
      className={`flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 ${
        selected ? "bg-[var(--accent-light)]" : ""
      }`}
    >
      {children}
    </div>
  );
}

/** Logo, customer, "project · activity", and the note and time as chips. */
export function SuggestionContent({
  suggestion,
  time,
  day = null,
}: {
  suggestion: QuickSuggestion;
  time: TimeSpec;
  /** The day that was named, shown in front of the time. */
  day?: Date | null;
}) {
  const display = useAdversumDisplay();
  const { combination, note } = suggestion;
  return (
    <>
      <CustomerAvatar
        name={combination.customer}
        color={combination.customerColor}
        logo={display?.logos.get(combination.customerId)}
        size={20}
        dotColor={combination.activityColor || undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-gray-800 dark:text-gray-200">
          {combination.customer}
        </span>
        <span className="block truncate text-[10px] text-gray-500 dark:text-gray-400">
          {combination.project} · {combination.activity}
        </span>
      </span>
      <span className="flex max-w-[45%] shrink-0 items-center gap-1">
        {note && (
          <span
            data-chip="note"
            className="truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300"
          >
            {note}
          </span>
        )}
        <TimeChip time={time} day={day} />
      </span>
    </>
  );
}

export function CommandContent({ command }: { command: QuickCommand }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300">
        ⌘
      </span>
      <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">
        {t(`adversum.quick.command.${command}`)}
      </span>
    </>
  );
}

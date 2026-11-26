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

export function TimeChip({ time }: { time: TimeSpec }) {
  const { t } = useTranslation();
  if (time.kind === "none") return null;
  const warning = time.kind === "future";
  return (
    <span
      data-chip="time"
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
        warning
          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
      }`}
    >
      {time.kind === "start"
        ? t("adversum.quick.since", { time: clockTime(time.begin) })
        : time.kind === "range"
          ? `${clockTime(time.begin)}–${clockTime(time.end)}`
          : t("adversum.quick.futureTime")}
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
}: {
  suggestion: QuickSuggestion;
  time: TimeSpec;
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
        <TimeChip time={time} />
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

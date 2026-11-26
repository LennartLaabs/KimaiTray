import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAdversumDisplay } from "../display/displayStore";
import CustomerAvatar from "../logos/CustomerAvatar";
import { actionForSuggestion, type QuickAction, type QuickStartMode } from "./actions";
import type { QuickCatalog } from "./catalog";
import type { QuickHistory } from "./history";
import { parseQuickEntry, type QuickSuggestion } from "./parse";
import type { TimeSpec } from "./timeParser";

interface QuickEntryBarProps {
  catalog: QuickCatalog;
  history: QuickHistory;
  /** "window": the floating bar. "popup": the search field of the tray popup. */
  variant: "window" | "popup";
  /** Every new value clears the field, fills in `seedText` and focuses it. */
  focusRequest?: number;
  seedText?: string;
  disabled?: boolean;
  onAction: (action: QuickAction) => void;
  /** Escape on an empty field. */
  onClose: () => void;
}

function clockTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** The text that names a suggestion unambiguously, for Tab completion. */
export function completionText(suggestion: QuickSuggestion, timePhrase: string): string {
  const { customer, project, activity } = suggestion.combination;
  return `${[customer, project, activity, timePhrase, suggestion.note].filter(Boolean).join(" ")} `;
}

export default function QuickEntryBar({
  catalog,
  history,
  variant,
  focusRequest = 0,
  seedText = "",
  disabled = false,
  onAction,
  onClose,
}: QuickEntryBarProps) {
  const { t } = useTranslation();
  const display = useAdversumDisplay();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(-1);
  const [focused, setFocused] = useState(false);

  const result = useMemo(
    () => parseQuickEntry(text, catalog, history, new Date()),
    [text, catalog, history],
  );
  const { suggestions, command } = result;

  useEffect(() => {
    setSelected(result.autoSelect ? 0 : -1);
  }, [result]);

  useEffect(() => {
    if (focusRequest === 0) return;
    setText(seedText);
    inputRef.current?.focus();
    // Only a new request refocuses; a changed seed alone does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  const open = variant === "window" || (focused && text.trim() !== "");
  const rowCount = command ? 1 : suggestions.length;

  const submit = (index: number, mode: QuickStartMode) => {
    if (disabled) return;
    if (command) {
      onAction({ type: "command", command });
    } else {
      const suggestion = suggestions[index];
      if (!suggestion) return;
      onAction(actionForSuggestion(suggestion, result.time, mode));
    }
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.min(rowCount - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => (index > 0 ? index - 1 : index));
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit(selected, event.metaKey || event.ctrlKey ? "interrupt" : "switch");
    } else if (event.key === "Tab" && !event.shiftKey && suggestions.length > 0) {
      event.preventDefault();
      setText(completionText(suggestions[Math.max(0, selected)]!, result.timePhrase));
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (text) setText("");
      else onClose();
    }
  };

  const activeId = selected >= 0 && selected < rowCount ? `${listId}-${selected}` : undefined;
  const windowed = variant === "window";

  return (
    <div className={windowed ? "" : "relative z-30 mx-3 mt-2"} data-quick-entry={variant}>
      <div
        className={
          windowed
            ? "flex items-center gap-3 px-4 py-3.5"
            : "flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 focus-within:border-[var(--accent)] dark:border-gray-700 dark:bg-white/[0.04]"
        }
      >
        <svg
          aria-hidden="true"
          className={`shrink-0 text-gray-400 dark:text-gray-500 ${windowed ? "h-5 w-5" : "h-3.5 w-3.5"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <circle cx="11" cy="11" r="7" />
          <path strokeLinecap="round" d="M20 20l-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label={t("adversum.quick.placeholder")}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          placeholder={t("adversum.quick.placeholder")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className={`min-w-0 flex-1 bg-transparent text-gray-900 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500 ${
            windowed ? "text-[17px]" : "text-xs"
          }`}
        />
        {windowed && (
          <kbd className="shrink-0 rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[10px] text-gray-400 dark:border-gray-700 dark:text-gray-500">
            esc
          </kbd>
        )}
      </div>

      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={t("adversum.quick.suggestions")}
          className={
            windowed
              ? "border-t border-gray-200/70 p-1.5 dark:border-white/10"
              : "absolute inset-x-0 top-full mt-1 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-gray-700 dark:bg-[#232323]"
          }
        >
          {command ? (
            <Row
              id={`${listId}-0`}
              selected={selected === 0}
              onSelect={() => setSelected(0)}
              onRun={() => submit(0, "switch")}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300">
                ⌘
              </span>
              <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">
                {t(`adversum.quick.command.${command}`)}
              </span>
            </Row>
          ) : (
            suggestions.map((suggestion, index) => (
              <Row
                key={suggestion.combination.key}
                id={`${listId}-${index}`}
                selected={selected === index}
                onSelect={() => setSelected(index)}
                onRun={(mode) => submit(index, mode)}
              >
                <CustomerAvatar
                  name={suggestion.combination.customer}
                  color={suggestion.combination.customerColor}
                  logo={display?.logos.get(suggestion.combination.customerId)}
                  size={20}
                  dotColor={suggestion.combination.activityColor || undefined}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-gray-800 dark:text-gray-200">
                    {suggestion.combination.customer}
                  </span>
                  <span className="block truncate text-[10px] text-gray-500 dark:text-gray-400">
                    {suggestion.combination.project} · {suggestion.combination.activity}
                  </span>
                </span>
                <span className="flex max-w-[45%] shrink-0 items-center gap-1">
                  {suggestion.note && (
                    <span
                      data-chip="note"
                      className="truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-white/10 dark:text-gray-300"
                    >
                      {suggestion.note}
                    </span>
                  )}
                  <TimeChip time={result.time} />
                </span>
              </Row>
            ))
          )}
          {rowCount === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-gray-500 dark:text-gray-400">
              {t("adversum.quick.empty")}
            </p>
          )}
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
            {rowCount > 0 && selected < 0
              ? t("adversum.quick.choose")
              : t("adversum.quick.hints")}
          </p>
        </div>
      )}
    </div>
  );
}

function TimeChip({ time }: { time: TimeSpec }) {
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

interface RowProps {
  id: string;
  selected: boolean;
  onSelect: () => void;
  onRun: (mode: QuickStartMode) => void;
  children: React.ReactNode;
}

function Row({ id, selected, onSelect, onRun, children }: RowProps) {
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

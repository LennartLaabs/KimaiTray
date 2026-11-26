import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import MicIcon from "../voice/MicIcon";
import { actionForSuggestion, type QuickAction, type QuickStartMode } from "./actions";
import type { QuickCatalog } from "./catalog";
import type { QuickHistory } from "./history";
import { parseQuickEntry, type QuickSuggestion } from "./parse";
import { CommandContent, QuickRow, SuggestionContent } from "./SuggestionRow";

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
  /** Shows a microphone button that starts voice input. */
  onVoice?: () => void;
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
  onVoice,
}: QuickEntryBarProps) {
  const { t } = useTranslation();
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
        {onVoice && (
          <button
            type="button"
            aria-label={t("adversum.voice.speak")}
            title={t("adversum.voice.speak")}
            // Keeps the field focused until voice input takes over.
            onMouseDown={(event) => event.preventDefault()}
            onClick={onVoice}
            className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-black/5 hover:text-[var(--accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] dark:text-gray-500 dark:hover:bg-white/10"
          >
            <MicIcon className={windowed ? "h-5 w-5" : "h-3.5 w-3.5"} />
          </button>
        )}
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
            <QuickRow
              id={`${listId}-0`}
              selected={selected === 0}
              onSelect={() => setSelected(0)}
              onRun={() => submit(0, "switch")}
            >
              <CommandContent command={command} />
            </QuickRow>
          ) : (
            suggestions.map((suggestion, index) => (
              <QuickRow
                key={suggestion.combination.key}
                id={`${listId}-${index}`}
                selected={selected === index}
                onSelect={() => setSelected(index)}
                onRun={(mode) => submit(index, mode)}
              >
                <SuggestionContent suggestion={suggestion} time={result.time} />
              </QuickRow>
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

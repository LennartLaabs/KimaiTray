import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { actionForSuggestion, type QuickAction, type QuickStartMode } from "../quickEntry/actions";
import type { QuickCatalog } from "../quickEntry/catalog";
import type { QuickHistory } from "../quickEntry/history";
import type { QuickSuggestion } from "../quickEntry/parse";
import { CommandContent, QuickRow, SuggestionContent } from "../quickEntry/SuggestionRow";
import { aliasesToLearn, withoutLearned, type LearnedAlias } from "./learn";
import MicIcon from "./MicIcon";
import { readSpoken } from "./spoken";
import {
  cancelVoice,
  finishVoice,
  openVoicePrivacySettings,
  reloadModelInternally,
  VOICE_LEVEL_EVENT,
  VOICE_PARTIAL_EVENT,
  type VoiceState,
} from "./voiceApi";

/** A confident reading starts by itself after this long. */
export const AUTO_START_MS = 2000;
/** How long "nothing understood" and problems stay on screen. */
export const MESSAGE_MS = 6000;

const NO_SUGGESTIONS: QuickSuggestion[] = [];

/** What a hand-edited voice input started from, for learning aliases. */
export interface VoiceOrigin {
  spoken: string;
  proposed: QuickSuggestion | null;
}

interface VoiceStageProps {
  state: VoiceState;
  catalog: QuickCatalog;
  history: QuickHistory;
  /** Runs what was said; `learned` are aliases a correction taught. */
  onAction: (action: QuickAction, learned: LearnedAlias[]) => void;
  /** Continue by typing, with the understood text in the bar. */
  onEdit: (text: string, origin: VoiceOrigin) => void;
  onClose: () => void;
}

function ignore(): void {
  // The window is closing or the native side is gone; nothing to do.
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="shrink-0 rounded border border-gray-200 px-1.5 py-0.5 font-mono text-[10px] text-gray-400 dark:border-gray-700 dark:text-gray-500">
      {children}
    </kbd>
  );
}

/**
 * Voice input in the quick entry window: the overlay while recording and
 * transcribing, then the confirmation card. Escape always discards.
 */
export default function VoiceStage({
  state,
  catalog,
  history,
  onAction,
  onEdit,
  onClose,
}: VoiceStageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const busy = state.phase === "recording" || state.phase === "transcribing";
  const recording = state.phase === "recording";

  // No text field holds the focus here; the card itself takes the keys.
  useEffect(() => {
    // The root element is always rendered, so the ref is set by now.
    rootRef.current!.focus();
  }, [state.phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (busy) void cancelVoice().catch(ignore);
        onClose();
      } else if (event.key === "Enter" && recording) {
        // Also while the key is held: a way out if its release gets lost.
        event.preventDefault();
        void finishVoice().catch(ignore);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, recording, onClose]);

  return (
    <div ref={rootRef} tabIndex={-1} data-voice-phase={state.phase} className="outline-none">
      {state.phase === "recording" ? (
        <Recording manual={state.manual} />
      ) : state.phase === "transcribing" ? (
        <Transcribing />
      ) : state.phase === "result" ? (
        <Confirm
          // A new sentence is a new card, with a fresh countdown.
          key={state.text}
          text={state.text ?? ""}
          catalog={catalog}
          history={history}
          onAction={onAction}
          onEdit={onEdit}
          onClose={onClose}
        />
      ) : (
        <Message state={state} onClose={onClose} />
      )}
    </div>
  );
}

function Recording({ manual }: { manual: boolean }) {
  const { t } = useTranslation();
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState("");

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const listeners = [
      currentWindow.listen<number>(VOICE_LEVEL_EVENT, ({ payload }) => setLevel(payload)),
      currentWindow.listen<string>(VOICE_PARTIAL_EVENT, ({ payload }) => setPartial(payload)),
    ];
    return () => {
      for (const listener of listeners) {
        void listener.then((unlisten) => unlisten()).catch(ignore);
      }
    };
  }, []);

  const shown = Math.max(0, Math.min(1, level));
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span
        data-voice-level={shown.toFixed(2)}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500 text-white"
      >
        {/* The halo grows with the voice. */}
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-red-500/30 transition-transform duration-100"
          style={{ transform: `scale(${1 + shown * 0.9})` }}
        />
        <MicIcon className="relative h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span
          role="status"
          className={`block truncate text-[15px] ${
            partial ? "text-gray-900 dark:text-gray-100" : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {partial || t("adversum.voice.listening")}
        </span>
        <span className="block truncate text-[11px] text-gray-400 dark:text-gray-500">
          {t(manual ? "adversum.voice.hintManual" : "adversum.voice.hintHold")}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void finishVoice().catch(ignore)}
        className="shrink-0 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        {t("adversum.voice.done")}
      </button>
      <Kbd>esc</Kbd>
    </div>
  );
}

function Transcribing() {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span
        aria-hidden="true"
        className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-gray-300 border-t-[var(--accent)] dark:border-gray-600"
      />
      <span role="status" className="min-w-0 flex-1 text-[15px] text-gray-500 dark:text-gray-400">
        {t("adversum.voice.transcribing")}
      </span>
      <Kbd>esc</Kbd>
    </div>
  );
}

/** "Nothing understood" and the reasons voice input could not start. */
function Message({ state, onClose }: { state: VoiceState; onClose: () => void }) {
  const { t } = useTranslation();
  useEffect(() => {
    const timer = setTimeout(onClose, MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [onClose]);

  const reason = state.reason ?? (state.phase === "error" ? "failed" : "empty");
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <MicIcon className="h-5 w-5 shrink-0 text-gray-400 dark:text-gray-500" />
      <span
        role="alert"
        data-voice-problem={reason}
        className="min-w-0 flex-1 text-[14px] text-gray-700 dark:text-gray-300"
      >
        {reason === "modelVolume"
          ? t("adversum.voice.problem.modelVolume", { volume: state.detail ?? "" })
          : t(`adversum.voice.problem.${reason}`)}
        {state.detail && reason !== "modelVolume" && (
          <span
            data-voice-detail
            className="mt-0.5 block break-words font-mono text-[11px] text-gray-500 dark:text-gray-400"
          >
            {state.detail}
          </span>
        )}
      </span>
      {reason === "modelVolume" && (
        <button
          type="button"
          onClick={() => {
            // The download goes on after the overlay is gone.
            void reloadModelInternally().catch(ignore);
            onClose();
          }}
          className="shrink-0 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {t("adversum.voice.useInternal")}
        </button>
      )}
      {reason === "permissionDenied" && (
        <button
          type="button"
          onClick={() => {
            void openVoicePrivacySettings().catch(ignore);
            onClose();
          }}
          className="shrink-0 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[13px] font-semibold text-white hover:bg-[var(--accent-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {t("adversum.voice.openPrivacy")}
        </button>
      )}
      <Kbd>esc</Kbd>
    </div>
  );
}

interface ConfirmProps {
  text: string;
  catalog: QuickCatalog;
  history: QuickHistory;
  onAction: (action: QuickAction, learned: LearnedAlias[]) => void;
  onEdit: (text: string, origin: VoiceOrigin) => void;
  onClose: () => void;
}

/**
 * The confirmation card. A confident reading starts by itself after two
 * seconds, shown by a shrinking bar; an uncertain one waits. Enter starts at
 * once, ↑/↓ pick another suggestion, Tab continues by typing. Any of these
 * stops the countdown.
 */
function Confirm({ text, catalog, history, onAction, onEdit, onClose }: ConfirmProps) {
  const { t } = useTranslation();
  const listId = useId();
  const reading = useMemo(
    () => readSpoken(text, catalog, history, new Date()),
    [text, catalog, history],
  );
  const suggestions = reading.kind === "entry" ? reading.result.suggestions : NO_SUGGESTIONS;
  const rowCount = reading.kind === "entry" ? suggestions.length : reading.kind === "empty" ? 0 : 1;
  const confident =
    reading.kind === "command" ||
    reading.kind === "note" ||
    (reading.kind === "entry" &&
      reading.result.autoSelect &&
      reading.result.time.kind !== "future" &&
      reading.result.time.kind !== "incomplete" &&
      suggestions.length > 0);

  // The first row is always preselected, so Enter accepts it. Only a
  // confident reading also starts by itself.
  const [selected, setSelected] = useState(rowCount > 0 ? 0 : -1);
  const [counting, setCounting] = useState(confident);
  // Right after the app started, the catalog can arrive after the sentence.
  useEffect(() => {
    if (rowCount > 0) setSelected((index) => (index < 0 ? 0 : index));
  }, [rowCount]);
  const [shrunk, setShrunk] = useState(false);
  const done = useRef(false);

  const run = (index: number, mode: QuickStartMode) => {
    if (done.current) return;
    if (reading.kind === "command") {
      done.current = true;
      onAction({ type: "command", command: reading.command }, []);
    } else if (reading.kind === "note") {
      done.current = true;
      onAction({ type: "note", text: reading.text }, []);
    } else if (reading.kind === "entry") {
      const suggestion = suggestions[index];
      // A day without a time or duration is nothing that can be entered yet.
      if (!suggestion || reading.result.time.kind === "incomplete") return;
      done.current = true;
      // Taking anything but the first suggestion is a correction.
      const learned =
        index === 0
          ? []
          : aliasesToLearn({
              spoken: reading.text,
              proposed: suggestions[0]!,
              chosen: suggestion.combination,
              catalog,
            });
      onAction(
        actionForSuggestion(
          { ...suggestion, note: withoutLearned(suggestion.note, learned) },
          reading.result.time,
          mode,
        ),
        learned,
      );
    }
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!counting) return;
    // Start the bar's transition on the frame after it was drawn full.
    const frame = requestAnimationFrame(() => setShrunk(true));
    const timer = setTimeout(() => runRef.current(0, "switch"), AUTO_START_MS);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [counting]);

  // Nothing to choose from: the card goes away by itself.
  useEffect(() => {
    if (rowCount > 0) return;
    const timer = setTimeout(onClose, MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [rowCount, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape belongs to the stage; modifier keys alone change nothing.
      if (event.key === "Escape" || ["Meta", "Control", "Shift", "Alt"].includes(event.key)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        runRef.current(selected, event.metaKey || event.ctrlKey ? "interrupt" : "switch");
        return;
      }
      setCounting(false);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((index) => Math.min(rowCount - 1, index + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((index) => (index > 0 ? index - 1 : index));
      } else if (event.key === "Tab" && reading.kind === "entry") {
        event.preventDefault();
        onEdit(reading.text, { spoken: reading.text, proposed: suggestions[0] ?? null });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, rowCount, reading, suggestions, onEdit]);

  const choose = (index: number) => {
    setCounting(false);
    setSelected(index);
  };

  return (
    <div data-voice-confirm={reading.kind}>
      <div className="flex items-center gap-3 px-4 pb-2 pt-3">
        <MicIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />
        <span
          data-voice-heard
          className="min-w-0 flex-1 truncate text-[13px] italic text-gray-500 dark:text-gray-400"
        >
          „{text}“
        </span>
        <Kbd>esc</Kbd>
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t("adversum.quick.suggestions")}
        aria-activedescendant={selected >= 0 ? `${listId}-${selected}` : undefined}
        className="border-t border-gray-200/70 p-1.5 dark:border-white/10"
      >
        {reading.kind === "command" && (
          <QuickRow
            id={`${listId}-0`}
            selected={selected === 0}
            onSelect={() => choose(0)}
            onRun={() => run(0, "switch")}
          >
            <CommandContent command={reading.command} />
          </QuickRow>
        )}
        {reading.kind === "note" && (
          <QuickRow
            id={`${listId}-0`}
            selected={selected === 0}
            onSelect={() => choose(0)}
            onRun={() => run(0, "switch")}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] text-gray-600 dark:bg-white/10 dark:text-gray-300">
              ✎
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-gray-800 dark:text-gray-200">
                {t("adversum.voice.addNote")}
              </span>
              <span className="block truncate text-[10px] text-gray-500 dark:text-gray-400">
                {reading.text}
              </span>
            </span>
          </QuickRow>
        )}
        {reading.kind === "entry" &&
          suggestions.map((suggestion, index) => (
            <QuickRow
              key={suggestion.combination.key}
              id={`${listId}-${index}`}
              selected={selected === index}
              onSelect={() => choose(index)}
              onRun={(mode) => run(index, mode)}
            >
              <SuggestionContent
                suggestion={suggestion}
                time={reading.result.time}
                day={reading.result.day}
              />
            </QuickRow>
          ))}
        {rowCount === 0 && (
          <p role="alert" className="px-2.5 py-2 text-[12px] text-gray-500 dark:text-gray-400">
            {t(reading.kind === "empty" ? "adversum.voice.problem.empty" : "adversum.quick.empty")}
          </p>
        )}
        {rowCount > 0 && (
          <p className="px-2.5 pb-1 pt-1.5 text-[10px] text-gray-400 dark:text-gray-500">
            {t(counting ? "adversum.voice.hintAuto" : "adversum.voice.hintConfirm")}
          </p>
        )}
      </div>
      {counting && (
        <div className="h-[3px] bg-gray-200/70 dark:bg-white/10">
          <div
            data-voice-countdown
            className="h-full bg-[var(--accent)]"
            style={{
              width: shrunk ? "0%" : "100%",
              transition: `width ${AUTO_START_MS}ms linear`,
            }}
          />
        </div>
      )}
    </div>
  );
}

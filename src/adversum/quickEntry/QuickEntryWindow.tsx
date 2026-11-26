import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useKimaiClient } from "../../hooks/useKimaiClient";
import { useLanguageSync } from "../../hooks/useLanguageSync";
import { currentPlatform } from "../../platform";
import { logger } from "../../utils/logger";
import { readMulti, type MultiReading } from "../multi/draft";
import MultiStage from "../multi/MultiStage";
import { useAdversumSettings } from "../settings/useAdversumSettings";
import { aliasesToLearn, type LearnedAlias } from "../voice/learn";
import { learnAlias, startVoice, VOICE_STATE_EVENT, type VoiceState } from "../voice/voiceApi";
import VoiceStage, { type VoiceOrigin } from "../voice/VoiceStage";
import type { QuickAction } from "./actions";
import { combinationKey } from "./catalog";
import { hideQuickWindow, resizeQuickWindow, showQuickToast } from "./quickApi";
import QuickEntryBar from "./QuickEntryBar";
import {
  MULTI_REVIEW_EVENT,
  QUICK_EXECUTE_EVENT,
  QUICK_SHOWN_EVENT,
  QUICK_TOAST_EVENT,
  QUICK_UNDO_EVENT,
  TOAST_DURATION_MS,
  TRAY_WINDOW_LABEL,
  type MultiReviewRequest,
  type QuickToastData,
} from "./quickEvents";
import QuickToast from "./QuickToast";
import { useQuickEntryData } from "./useQuickEntryData";
import { useQuickTheme } from "./useQuickTheme";

type Stage =
  /** Nothing on screen. */
  | { name: "idle" }
  /** The bar is open and has the keyboard. */
  | { name: "input" }
  /** The confirmation of the last quick action, at the bottom of the screen. */
  | { name: "toast"; toast: QuickToastData }
  /** Voice input: recording, transcribing, then the confirmation card. */
  | { name: "voice"; state: VoiceState }
  /** Several entries from one sentence, typed or spoken, under review. */
  | { name: "multi"; sentence: string; reading: MultiReading | null; spoken: boolean };

function report(error: unknown): void {
  logger.error(`Quick entry window: ${String(error)}`);
}

/**
 * The window with the label `adversum-quick`. It shows one of two things:
 *
 * - the **quick entry bar**, opened by the global shortcut. It only collects
 *   input: actions are sent to the tray window, which owns the timer
 *   operations, and the bar closes at once so the user can keep working.
 * - the **confirmation toast** for any quick action, whichever window or
 *   shortcut started it. It appears at the bottom center of the screen for a
 *   few seconds without taking the keyboard.
 * - **voice input** in the bar's place: the native side records and
 *   transcribes, this window shows the progress and then asks for
 *   confirmation of what it understood.
 * - the **review of several entries** when a typed or spoken sentence names
 *   more than one activity (`multi/`). It stays until it is confirmed or
 *   dismissed; clicking elsewhere does not discard what was edited there.
 */
export default function QuickEntryWindow() {
  const { t } = useTranslation();
  useQuickTheme();
  useLanguageSync();
  const { client, isConfigured, activeConnectionId } = useKimaiClient();
  const { settings } = useAdversumSettings();
  const { catalog, history } = useQuickEntryData(
    client,
    isConfigured,
    settings.aliases[activeConnectionId],
    settings.teamMembers,
  );
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const [focus, setFocus] = useState({ request: 0, text: "" });
  /** Set while the bar holds a voice input the user is correcting by hand. */
  const voiceOrigin = useRef<VoiceOrigin | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  /** A spoken sentence the review handed back as a single entry. */
  const singleRef = useRef("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const listeners = [
      currentWindow.listen(QUICK_SHOWN_EVENT, () => {
        voiceOrigin.current = null;
        setStage({ name: "input" });
        setFocus((current) => ({ request: current.request + 1, text: "" }));
      }),
      currentWindow.listen<QuickToastData>(QUICK_TOAST_EVENT, ({ payload }) => {
        // An open bar or voice input is not replaced; the user is busy there.
        const { name } = stageRef.current;
        if (name !== "input" && name !== "voice" && name !== "multi") {
          setStage({ name: "toast", toast: payload });
        }
      }),
      currentWindow.listen<VoiceState>(VOICE_STATE_EVENT, ({ payload }) => {
        setStage({ name: "voice", state: payload });
      }),
      currentWindow.listen<MultiReviewRequest>(MULTI_REVIEW_EVENT, ({ payload }) => {
        setStage({ name: "multi", sentence: payload.sentence, reading: null, spoken: false });
      }),
      currentWindow.onFocusChanged(({ payload: hasFocus }) => {
        // Clicking elsewhere closes the bar and voice input (hiding the
        // window also ends a recording). The toast never has the focus.
        const { name } = stageRef.current;
        if (!hasFocus && (name === "input" || name === "voice")) {
          setStage({ name: "idle" });
          void hideQuickWindow().catch(report);
        }
      }),
    ];
    return () => {
      for (const listener of listeners) {
        void listener.then((unlisten) => unlisten()).catch(() => undefined);
      }
    };
  }, []);

  // Present each toast once it is rendered, and take it away after a while.
  const toast = stage.name === "toast" ? stage.toast : null;
  useEffect(() => {
    if (!toast) return;
    void showQuickToast(toast.undoable).catch(report);
    const timer = setTimeout(() => {
      setStage({ name: "idle" });
      void hideQuickWindow().catch(report);
    }, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  // The native window follows the height of its content.
  useEffect(() => {
    // The root element is always rendered, so the ref is set by now.
    const root = rootRef.current!;
    const fit = () => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height > 0) void resizeQuickWindow(height).catch(report);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const close = useCallback(() => {
    voiceOrigin.current = null;
    setStage({ name: "idle" });
    void hideQuickWindow().catch(report);
  }, []);

  const send = (action: QuickAction, learned: readonly LearnedAlias[] = []) => {
    // The window closes right away; the outcome comes back as a toast.
    close();
    for (const { kind, entityId, alias } of learned) {
      void learnAlias(activeConnectionId, kind, entityId, alias).catch(report);
    }
    const summary = learned.map(({ alias, name }) => `„${alias}“ = ${name}`).join(", ");
    void emitTo(TRAY_WINDOW_LABEL, QUICK_EXECUTE_EVENT, {
      action,
      ...(summary ? { learned: summary } : {}),
    }).catch(report);
  };

  /** An action from the bar; after voice input, what the edit corrected is learned. */
  const sendTyped = (action: QuickAction) => {
    const origin = voiceOrigin.current;
    const chosen =
      origin && (action.type === "start" || action.type === "log")
        ? catalog.combinations.find(
            (item) => item.key === combinationKey(action.projectId, action.activityId),
          )
        : undefined;
    send(
      action,
      origin && chosen ? aliasesToLearn({ ...origin, chosen, catalog }) : [],
    );
  };

  // A spoken sentence with several activities goes to the review instead of
  // the confirmation card.
  const spokenText =
    stage.name === "voice" && stage.state.phase === "result" ? (stage.state.text ?? "") : "";
  useEffect(() => {
    if (!spokenText || singleRef.current === spokenText) return;
    const reading = readMulti(spokenText, catalog, history, new Date());
    const model = settings.multiModel !== "off";
    if (reading.draft || (reading.suspect && model)) {
      setStage({ name: "multi", sentence: spokenText, reading, spoken: true });
    }
  }, [spokenText, catalog, history, settings.multiModel]);

  const edit = useCallback((text: string, origin: VoiceOrigin) => {
    voiceOrigin.current = origin;
    setStage({ name: "input" });
    setFocus((current) => ({ request: current.request + 1, text }));
  }, []);

  return (
    <div ref={rootRef} data-quick-stage={stage.name}>
      {stage.name !== "idle" && (
        <div className="p-3">
          <div className="overflow-hidden rounded-2xl border border-black/10 bg-white/95 shadow-[0_12px_40px_rgba(0,0,0,0.28)] backdrop-blur dark:border-white/10 dark:bg-[#1e1e1e]/95">
            {stage.name === "toast" ? (
              <QuickToast
                toast={stage.toast}
                undoKey={currentPlatform().os === "macos" ? "⌘Z" : "Ctrl+Z"}
                onUndo={() =>
                  void emitTo(TRAY_WINDOW_LABEL, QUICK_UNDO_EVENT, {
                    id: stage.toast.id,
                  }).catch(report)
                }
              />
            ) : !isConfigured ? (
              <p className="px-4 py-3.5 text-[15px] text-gray-500 dark:text-gray-400">
                {t("adversum.quick.notConnected")}
              </p>
            ) : stage.name === "multi" ? (
              <MultiStage
                key={stage.sentence}
                sentence={stage.sentence}
                reading={stage.reading ?? readMulti(stage.sentence, catalog, history, new Date())}
                catalog={catalog}
                history={history}
                client={client}
                useModel={settings.multiModel !== "off"}
                onSubmit={send}
                onClose={close}
                onSingle={() => {
                  // One entry after all: the card for speech, the bar for typing.
                  singleRef.current = stage.sentence;
                  if (stage.spoken) {
                    setStage({
                      name: "voice",
                      state: { phase: "result", manual: false, text: stage.sentence },
                    });
                  } else {
                    setStage({ name: "input" });
                    setFocus((current) => ({ request: current.request + 1, text: stage.sentence }));
                  }
                }}
              />
            ) : stage.name === "voice" ? (
              <VoiceStage
                state={stage.state}
                catalog={catalog}
                history={history}
                client={client}
                onAction={send}
                onEdit={edit}
                onClose={close}
              />
            ) : (
              <QuickEntryBar
                variant="window"
                catalog={catalog}
                history={history}
                focusRequest={focus.request}
                seedText={focus.text}
                onAction={sendTyped}
                onClose={close}
                onMulti={(sentence, reading) =>
                  setStage({ name: "multi", sentence, reading, spoken: false })
                }
                onVoice={
                  settings.voiceEnabled ? () => void startVoice().catch(report) : undefined
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

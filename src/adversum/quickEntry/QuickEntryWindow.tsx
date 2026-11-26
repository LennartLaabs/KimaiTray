import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useKimaiClient } from "../../hooks/useKimaiClient";
import { useLanguageSync } from "../../hooks/useLanguageSync";
import { logger } from "../../utils/logger";
import { useAdversumSettings } from "../settings/useAdversumSettings";
import type { QuickAction } from "./actions";
import { hideQuickWindow, releaseQuickWindowFocus, resizeQuickWindow } from "./quickApi";
import QuickEntryBar from "./QuickEntryBar";
import {
  QUICK_EXECUTE_EVENT,
  QUICK_SHOWN_EVENT,
  QUICK_TOAST_EVENT,
  QUICK_UNDO_EVENT,
  TOAST_DURATION_MS,
  TRAY_WINDOW_LABEL,
  type QuickToastData,
} from "./quickEvents";
import QuickToast from "./QuickToast";
import { useQuickEntryData } from "./useQuickEntryData";
import { useQuickTheme } from "./useQuickTheme";

/** How long the bar waits for the tray window's confirmation. */
const CONFIRMATION_WAIT_MS = 6000;

type Stage =
  | { name: "input" }
  /** An action was sent to the tray window; its confirmation is pending. */
  | { name: "sent" }
  | { name: "toast"; toast: QuickToastData };

function report(error: unknown): void {
  logger.error(`Quick entry window: ${String(error)}`);
}

/**
 * The floating quick entry bar (window label `adversum-quick`). It only
 * collects input: actions are sent to the tray window, which owns the timer
 * operations, and the outcome comes back as a toast.
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
  );
  const [stage, setStage] = useState<Stage>({ name: "input" });
  const [focusRequest, setFocusRequest] = useState(1);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const listeners = [
      currentWindow.listen(QUICK_SHOWN_EVENT, () => {
        setStage({ name: "input" });
        setFocusRequest((request) => request + 1);
      }),
      currentWindow.listen<QuickToastData>(QUICK_TOAST_EVENT, ({ payload }) => {
        // Confirmations of actions started elsewhere are not this bar's business.
        if (stageRef.current.name !== "input") setStage({ name: "toast", toast: payload });
      }),
      currentWindow.onFocusChanged(({ payload: hasFocus }) => {
        // Losing focus closes the bar, unless it gave the focus away itself
        // to show a confirmation.
        if (!hasFocus && stageRef.current.name === "input") void hideQuickWindow().catch(report);
      }),
    ];
    return () => {
      for (const listener of listeners) {
        void listener.then((unlisten) => unlisten()).catch(() => undefined);
      }
    };
  }, []);

  // A confirmation (or the wait for one) closes the bar after a few seconds.
  useEffect(() => {
    if (stage.name === "input") return;
    const timer = setTimeout(
      () => void hideQuickWindow().catch(report),
      stage.name === "toast" ? TOAST_DURATION_MS : CONFIRMATION_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [stage]);

  // The native window follows the height of its content.
  useEffect(() => {
    // The root element is always rendered, so the ref is set by now.
    const root = rootRef.current!;
    const fit = () => void resizeQuickWindow(Math.ceil(root.getBoundingClientRect().height)).catch(report);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const send = (action: QuickAction) => {
    setStage({ name: "sent" });
    void emitTo(TRAY_WINDOW_LABEL, QUICK_EXECUTE_EVENT, { action }).catch(report);
    void releaseQuickWindowFocus().catch(report);
  };

  return (
    <div ref={rootRef} className="p-3" data-quick-stage={stage.name}>
      <div className="overflow-hidden rounded-2xl border border-black/10 bg-white/95 shadow-[0_12px_40px_rgba(0,0,0,0.28)] backdrop-blur dark:border-white/10 dark:bg-[#1e1e1e]/95">
        {stage.name === "toast" ? (
          <QuickToast
            variant="window"
            toast={stage.toast}
            onUndo={() =>
              void emitTo(TRAY_WINDOW_LABEL, QUICK_UNDO_EVENT, { id: stage.toast.id }).catch(report)
            }
          />
        ) : stage.name === "sent" ? (
          <p role="status" className="px-4 py-3.5 text-[15px] text-gray-500 dark:text-gray-400">
            {t("adversum.quick.working")}
          </p>
        ) : !isConfigured ? (
          <p className="px-4 py-3.5 text-[15px] text-gray-500 dark:text-gray-400">
            {t("adversum.quick.notConnected")}
          </p>
        ) : (
          <QuickEntryBar
            variant="window"
            catalog={catalog}
            history={history}
            focusRequest={focusRequest}
            onAction={send}
            onClose={() => void hideQuickWindow().catch(report)}
          />
        )}
      </div>
    </div>
  );
}

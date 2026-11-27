import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useQueryClient } from "@tanstack/react-query";
import { useAdversumDisplay } from "../display/displayStore";
import { useAdversumSettings } from "../settings/useAdversumSettings";
import { logger } from "../../utils/logger";
import { PROFILES_CHANGED_EVENT } from "../profile/profileApi";
import ProfileHints from "../profile/ProfileHints";
import { buildVocabulary, estimateTokens } from "../voice/vocabulary";
import { setVoiceVocabulary, startVoice } from "../voice/voiceApi";
import { registerPopupQuick, type BridgeTask } from "./popupBridge";
import { MULTI_REVIEW_EVENT, QUICK_WINDOW_LABEL } from "./quickEvents";
import QuickEntryBar from "./QuickEntryBar";
import { useQuickEntryData } from "./useQuickEntryData";
import { useQuickExecutor, type QuickExecutorOptions } from "./useQuickExecutor";

interface AdversumPopupQuickProps extends QuickExecutorOptions {
  /** The popup shows something else in place of its lists (new-task form). */
  hidden?: boolean;
}

/**
 * The fork's layer in the tray popup: the quick entry bar as the popup's
 * search field and the executor that runs quick actions from every window.
 * Confirmations are shown by the quick entry window as an overlay at the
 * bottom of the screen, wherever the action came from. Renders nothing
 * outside the running app, where the display store is empty (upstream's own
 * popup tests).
 */
export default function AdversumPopupQuick(props: AdversumPopupQuickProps) {
  return useAdversumDisplay() ? <PopupQuick {...props} /> : null;
}

function PopupQuick({ hidden, ...options }: AdversumPopupQuickProps) {
  const { settings } = useAdversumSettings();
  const { catalog, history, customers, entries } = useQuickEntryData(
    options.client,
    options.timersReady,
    settings.aliases[options.connectionId],
    settings.teamMembers,
  );
  const { execute } = useQuickExecutor(options);
  const [focus, setFocus] = useState({ request: 0, text: "" });
  const executeRef = useRef(execute);
  executeRef.current = execute;

  // The tray window lives as long as the app, so it keeps the speech model's
  // vocabulary current: every name that can be started, and the aliases.
  const aliases = settings.aliases[options.connectionId];
  const vocabulary = useMemo(
    () =>
      settings.voiceEnabled
        ? buildVocabulary(catalog, aliases, {
            history,
            // Colleagues' names are said often and should be written right.
            names: [...settings.teamMembers, ...history.noteNames],
          })
        : null,
    [settings.voiceEnabled, catalog, aliases, history, settings.teamMembers],
  );
  useEffect(() => {
    if (!vocabulary?.prompt) return;
    logger.info(
      `Voice vocabulary: ${vocabulary.terms.length} terms, about ${estimateTokens(vocabulary.prompt)} tokens: ${vocabulary.terms.join(", ")}`,
    );
    void setVoiceVocabulary(vocabulary.prompt).catch(() => undefined);
  }, [vocabulary]);

  // A profile was saved in another window: read Kimai's lists again now.
  const qc = useQueryClient();
  useEffect(() => {
    const listener = getCurrentWindow().listen(PROFILES_CHANGED_EVENT, () => {
      for (const key of ["customers", "projects", "activities"]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    });
    return () => {
      void listener.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [qc]);

  useEffect(() => {
    registerPopupQuick({
      focus: (text) => setFocus((current) => ({ request: current.request + 1, text })),
      startInterrupt: (task: BridgeTask) => {
        void executeRef.current({
          type: "start",
          mode: "interrupt",
          projectId: task.projectId,
          activityId: task.activityId,
          description: task.description,
          begin: null,
          label: `${task.customer || task.project} · ${task.activity}`,
          preview: {
            projectId: task.projectId,
            project: task.project,
            activity: task.activity,
            projectColor: task.projectColor,
            activityColor: task.activityColor,
            customerColor: task.customerColor,
            ...(task.description ? { description: task.description } : {}),
          },
        });
      },
    });
    return () => registerPopupQuick(null);
  }, []);

  if (hidden) return null;
  return (
    <>
      <QuickEntryBar
      variant="popup"
      catalog={catalog}
      history={history}
      focusRequest={focus.request}
      seedText={focus.text}
      disabled={options.busy}
      onAction={(action) => void execute(action)}
      onClose={() => (document.activeElement as HTMLElement | null)?.blur()}
      onVoice={
        settings.voiceEnabled ? () => void startVoice().catch(() => undefined) : undefined
      }
      // The review needs more room than the popup has: it opens in the
      // floating window.
      onMulti={(sentence) =>
        void invoke("adversum_quick_show")
          .then(() => emitTo(QUICK_WINDOW_LABEL, MULTI_REVIEW_EVENT, { sentence }))
          .catch(() => undefined)
      }
      />
      {options.client && (
        <ProfileHints
          client={options.client}
          connectionId={options.connectionId}
          customers={customers}
          entries={entries}
          catalog={catalog}
        />
      )}
    </>
  );
}

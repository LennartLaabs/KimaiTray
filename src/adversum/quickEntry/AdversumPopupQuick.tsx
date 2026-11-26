import { useEffect, useRef, useState } from "react";
import { useAdversumDisplay } from "../display/displayStore";
import { useAdversumSettings } from "../settings/useAdversumSettings";
import { registerPopupQuick, type BridgeTask } from "./popupBridge";
import QuickEntryBar from "./QuickEntryBar";
import QuickToast from "./QuickToast";
import { useQuickEntryData } from "./useQuickEntryData";
import { useQuickExecutor, type QuickExecutorOptions } from "./useQuickExecutor";

interface AdversumPopupQuickProps extends QuickExecutorOptions {
  /** The popup shows something else in place of its lists (new-task form). */
  hidden?: boolean;
}

/**
 * The fork's layer in the tray popup: the quick entry bar as the popup's
 * search field, the executor that runs quick actions from every window, and
 * the confirmation toast. Renders nothing outside the running app, where the
 * display store is empty (upstream's own popup tests).
 */
export default function AdversumPopupQuick(props: AdversumPopupQuickProps) {
  return useAdversumDisplay() ? <PopupQuick {...props} /> : null;
}

function PopupQuick({ hidden, ...options }: AdversumPopupQuickProps) {
  const { settings } = useAdversumSettings();
  const { catalog, history } = useQuickEntryData(
    options.client,
    options.timersReady,
    settings.aliases[options.connectionId],
  );
  const { execute, undo, toast } = useQuickExecutor(options);
  const [focus, setFocus] = useState({ request: 0, text: "" });
  const executeRef = useRef(execute);
  executeRef.current = execute;

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

  return (
    <>
      {!hidden && (
        <QuickEntryBar
          variant="popup"
          catalog={catalog}
          history={history}
          focusRequest={focus.request}
          seedText={focus.text}
          disabled={options.busy}
          onAction={(action) => void execute(action)}
          onClose={() => (document.activeElement as HTMLElement | null)?.blur()}
        />
      )}
      {toast && <QuickToast variant="popup" toast={toast} onUndo={() => void undo(toast.id)} />}
    </>
  );
}

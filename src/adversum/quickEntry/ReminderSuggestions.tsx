import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { emitTo } from "@tauri-apps/api/event";
import { useKimaiClient } from "../../hooks/useKimaiClient";
import { logger } from "../../utils/logger";
import { useAdversumDisplay } from "../display/displayStore";
import CustomerAvatar from "../logos/CustomerAvatar";
import { useAdversumSettings } from "../settings/useAdversumSettings";
import { actionForSuggestion } from "./actions";
import { parseQuickEntry, type QuickSuggestion } from "./parse";
import { QUICK_EXECUTE_EVENT, TRAY_WINDOW_LABEL } from "./quickEvents";
import { useQuickEntryData } from "./useQuickEntryData";

export const REMINDER_SUGGESTION_COUNT = 3;

interface ReminderSuggestionsProps {
  /** Called after a suggestion was sent off, to close the reminder. */
  onStarted: () => void;
}

/**
 * One-click starts on the "no timer running" reminder: the tasks that are
 * most likely right now, taken from the quick entry ranking. Renders nothing
 * outside the running app, where the display store is empty.
 */
export default function ReminderSuggestions(props: ReminderSuggestionsProps) {
  return useAdversumDisplay() ? <Suggestions {...props} /> : null;
}

function Suggestions({ onStarted }: ReminderSuggestionsProps) {
  const { t } = useTranslation();
  const display = useAdversumDisplay();
  const { client, isConfigured, activeConnectionId } = useKimaiClient();
  const { settings } = useAdversumSettings();
  const { catalog, history } = useQuickEntryData(
    client,
    isConfigured,
    settings.aliases[activeConnectionId],
  );
  const suggestions = useMemo(
    () =>
      parseQuickEntry("", catalog, history, new Date())
        // Without history every combination scores zero; that is no suggestion.
        .suggestions.filter((suggestion) => suggestion.score > 0)
        .slice(0, REMINDER_SUGGESTION_COUNT),
    [catalog, history],
  );
  if (suggestions.length === 0) return null;

  const start = (suggestion: QuickSuggestion) => {
    void emitTo(TRAY_WINDOW_LABEL, QUICK_EXECUTE_EVENT, {
      action: actionForSuggestion(suggestion, { kind: "none" }, "switch"),
    }).catch((error) => logger.error(`Reminder start failed: ${String(error)}`));
    onStarted();
  };

  return (
    <section aria-label={t("adversum.reminder.title")} className="mt-9 w-full max-w-2xl">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
        {t("adversum.reminder.title")}
      </h2>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.combination.key}
            type="button"
            onClick={() => start(suggestion)}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/10 px-3.5 py-3 text-left transition hover:bg-white/20 focus:outline-none focus-visible:border-white"
          >
            <CustomerAvatar
              name={suggestion.combination.customer}
              color={suggestion.combination.customerColor}
              logo={display?.logos.get(suggestion.combination.customerId)}
              size={28}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-white">
                {suggestion.combination.customer}
              </span>
              <span className="line-clamp-2 text-xs text-slate-300">
                {suggestion.combination.project} · {suggestion.combination.activity}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

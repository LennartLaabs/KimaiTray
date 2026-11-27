import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Window } from "@tauri-apps/api/window";
import type { KimaiClient } from "../../api/kimaiClient";
import type { QuickCatalog } from "../quickEntry/catalog";
import type { HistoryEntry } from "../quickEntry/history";
import {
  suggestFromNotes,
  trackCustomers,
  withSuggestion,
  type KnownCustomers,
  type ProfileSuggestion,
} from "./hints";
import { saveProfile } from "./profileApi";

/** Settings window: open the profile of this customer. */
export const PROFILE_SETUP_EVENT = "adversum://profile-setup";

interface ProfileHintsProps {
  client: KimaiClient;
  connectionId: string;
  /** The customers as Kimai lists them right now; empty while loading. */
  customers: readonly { id: number; name: string }[];
  entries: readonly HistoryEntry[];
  catalog: QuickCatalog;
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

/**
 * One quiet line in the popup when there is something to do about a
 * profile: a customer that is new in Kimai ("kurz einrichten?"), or a name
 * or term that keeps turning up in a customer's notes ("hinzufügen?"). Each
 * is asked once; the answer is remembered on this Mac.
 */
export default function ProfileHints({
  client,
  connectionId,
  customers,
  entries,
  catalog,
}: ProfileHintsProps) {
  const { t } = useTranslation();
  const knownKey = `adversum-known-customers:${connectionId}`;
  const answeredKey = `adversum-profile-answered:${connectionId}`;
  const [pending, setPending] = useState<number[]>([]);
  const [answered, setAnswered] = useState<string[]>(() => read<string[]>(answeredKey) ?? []);
  const [problem, setProblem] = useState(false);

  // Kimai's customers are read again every few minutes; a new one shows here.
  const ids = customers.map((customer) => customer.id).join(",");
  useEffect(() => {
    if (ids === "") return;
    const next = trackCustomers(read<KnownCustomers>(knownKey), ids.split(",").map(Number));
    localStorage.setItem(knownKey, JSON.stringify(next));
    setPending(next.pending);
  }, [ids, knownKey]);

  const suggestions = useMemo(
    () => suggestFromNotes(entries, catalog, new Date(), new Set(answered)),
    [entries, catalog, answered],
  );

  const forget = (customerId: number) => {
    const stored = read<KnownCustomers>(knownKey);
    const next = (stored?.pending ?? pending).filter((id) => id !== customerId);
    localStorage.setItem(knownKey, JSON.stringify({ known: stored?.known ?? [], pending: next }));
    setPending(next);
  };
  const answer = (suggestion: ProfileSuggestion) => {
    const next = [...answered, suggestion.key];
    localStorage.setItem(answeredKey, JSON.stringify(next));
    setAnswered(next);
  };

  const setUp = async (customerId: number) => {
    forget(customerId);
    const settings = await Window.getByLabel("settings");
    if (!settings) return;
    await settings.show();
    await settings.setFocus();
    await settings.emitTo("settings", "kimai://navigate-section", "adversumQuick");
    await settings.emitTo("settings", PROFILE_SETUP_EVENT, { customerId });
  };
  const add = async (suggestion: ProfileSuggestion) => {
    setProblem(false);
    try {
      const profile = catalog.profiles.get(suggestion.customerId)!;
      await saveProfile(client, "customers", suggestion.customerId, withSuggestion(profile, suggestion));
      answer(suggestion);
    } catch {
      // Not allowed or not reachable: said once, then not asked again.
      setProblem(true);
      answer(suggestion);
    }
  };

  const fresh = customers.find((customer) => customer.id === pending[0]);
  const [suggestion] = suggestions;
  const line =
    "flex items-center gap-2 rounded-md bg-[var(--accent-light)] px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200";
  const button =
    "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold text-[var(--accent)] hover:bg-black/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] dark:hover:bg-white/10";
  const quiet = "shrink-0 rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-black/5 dark:text-gray-400";

  if (fresh) {
    return (
      <div data-profile-hint="new" className="mx-3 mt-1.5">
        <p className={line}>
          <span className="min-w-0 flex-1 truncate">
            {t("adversum.profile.hint.newCustomer", { name: fresh.name })}
          </span>
          <button type="button" className={button} onClick={() => void setUp(fresh.id).catch(() => undefined)}>
            {t("adversum.profile.hint.setUp")}
          </button>
          <button type="button" className={quiet} onClick={() => forget(fresh.id)}>
            {t("adversum.profile.hint.later")}
          </button>
        </p>
      </div>
    );
  }
  if (problem) {
    return (
      <div data-profile-hint="problem" className="mx-3 mt-1.5">
        <p className={line}>
          <span className="min-w-0 flex-1 truncate">{t("adversum.profile.hint.notSaved")}</span>
          <button type="button" className={quiet} onClick={() => setProblem(false)}>
            {t("adversum.profile.hint.ok")}
          </button>
        </p>
      </div>
    );
  }
  if (!suggestion) return null;
  return (
    <div data-profile-hint="suggestion" className="mx-3 mt-1.5">
      <p className={line}>
        <span className="min-w-0 flex-1 truncate">
          {t("adversum.profile.hint.add", { text: suggestion.text, customer: suggestion.customer })}
        </span>
        <button type="button" className={button} onClick={() => void add(suggestion)}>
          {t("adversum.profile.hint.yes")}
        </button>
        <button type="button" className={quiet} onClick={() => answer(suggestion)}>
          {t("adversum.profile.hint.no")}
        </button>
      </p>
    </div>
  );
}

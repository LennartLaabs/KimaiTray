import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getActivities } from "../../api/activityApi";
import { getCustomers, getProjects } from "../../api/projectApi";
import { useKimaiClient } from "../../hooks/useKimaiClient";
import { usePlatform } from "../../platform";
import { Segmented, TextInput, buttonClass } from "../../settings/Controls";
import {
  SettingsList,
  SettingsNote,
  SettingsPage,
  SettingsRow,
  SettingsWarning,
} from "../../settings/SettingsLayout";
import { normalizeText } from "../quickEntry/normalize";
import { PROFILE_SETUP_EVENT } from "../profile/ProfileHints";
import { parseProfile, profileLines } from "../profile/profileText";
import AcceleratorInput from "./AcceleratorInput";
import ProfileEditor from "./ProfileEditor";
import {
  emptyConnectionAliases,
  type AdversumSettings,
  type AliasKind,
} from "./adversumSettings";
import { useAdversumSettings } from "./useAdversumSettings";

const ENTITY_STALE_TIME = 5 * 60 * 1000;
const ALIAS_KINDS: readonly AliasKind[] = ["customers", "projects", "activities"];
type ShortcutKey = "shortcutQuickEntry" | "shortcutPreviousTask";
const SHORTCUTS: readonly ShortcutKey[] = ["shortcutQuickEntry", "shortcutPreviousTask"];

interface AliasEntity {
  id: number;
  name: string;
  /** Kimai's description, which holds the profile. */
  comment: string | null;
  /** Shown under the name, e.g. the customer of a project. */
  context: string;
}

/** "pm, Projekt-Mgmt ,pm" → ["pm", "Projekt-Mgmt"] */
export function parseAliasInput(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(",")
    .map((alias) => alias.trim())
    .filter((alias) => {
      const key = alias.toLowerCase();
      if (!alias || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export default function QuickEntrySection() {
  const { t } = useTranslation();
  const platform = usePlatform();
  const { client, isConfigured, activeConnectionId } = useKimaiClient();
  const { settings, update } = useAdversumSettings();
  const enabled = !!client && isConfigured;
  const scope = client?.cacheScope;
  const [rejected, setRejected] = useState<ShortcutKey | null>(null);
  const [kind, setKind] = useState<AliasKind>("customers");
  const [filter, setFilter] = useState("");
  const [openProfile, setOpenProfile] = useState<number | null>(null);
  const qc = useQueryClient();

  // "Neuer Kunde: X – kurz einrichten?" in the popup leads here.
  useEffect(() => {
    const listener = getCurrentWindow().listen<{ customerId: number }>(
      PROFILE_SETUP_EVENT,
      ({ payload }) => {
        setKind("customers");
        setFilter("");
        setOpenProfile(payload.customerId);
      },
    );
    return () => {
      void listener.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, []);

  const customersQ = useQuery({
    queryKey: ["customers", scope],
    queryFn: () => getCustomers(client!),
    enabled,
    staleTime: ENTITY_STALE_TIME,
  });
  const projectsQ = useQuery({
    queryKey: ["projects", scope],
    queryFn: () => getProjects(client!),
    enabled,
    staleTime: ENTITY_STALE_TIME,
  });
  const activitiesQ = useQuery({
    queryKey: ["activities", scope],
    queryFn: () => getActivities(client!),
    enabled,
    staleTime: ENTITY_STALE_TIME,
  });

  const entities = useMemo<AliasEntity[]>(() => {
    const customers = customersQ.data ?? [];
    const projects = projectsQ.data ?? [];
    const customerName = (id: number) =>
      customers.find((customer) => customer.id === id)?.name ?? "";
    const projectName = (id: number | null) =>
      projects.find((project) => project.id === id)?.name ?? "";
    const list: AliasEntity[] =
      kind === "customers"
        ? customers.map(({ id, name, comment }) => ({ id, name, comment, context: "" }))
        : kind === "projects"
          ? projects.map(({ id, name, customer, comment }) => ({
              id,
              name,
              comment,
              context: customerName(customer),
            }))
          : (activitiesQ.data ?? []).map(({ id, name, project, comment }) => ({
              id,
              name,
              comment,
              context: projectName(project),
            }));
    const query = normalizeText(filter);
    return list
      .filter((entity) => normalizeText(`${entity.name} ${entity.context}`).includes(query))
      .sort((a, b) => a.name.localeCompare(b.name) || a.context.localeCompare(b.context));
  }, [kind, filter, customersQ.data, projectsQ.data, activitiesQ.data]);

  const aliases = settings.aliases[activeConnectionId] ?? emptyConnectionAliases();

  const saveShortcut = async (key: ShortcutKey, accelerator: string) => {
    setRejected(null);
    if (!(await update(key, accelerator))) setRejected(key);
  };

  const saveAliases = (entityId: number, list: string[]) => {
    const { [String(entityId)]: _previous, ...others } = aliases[kind];
    const next: AdversumSettings["aliases"] = {
      ...settings.aliases,
      [activeConnectionId]: {
        ...aliases,
        [kind]: list.length > 0 ? { ...others, [String(entityId)]: list } : others,
      },
    };
    void update("aliases", next);
  };

  return (
    <SettingsPage
      title={t("adversum.quickSettings.title")}
      description={t("adversum.quickSettings.description")}
    >
      {!platform.supportsGlobalShortcuts && (
        <SettingsWarning>{t("shortcuts.waylandUnavailable")}</SettingsWarning>
      )}
      <SettingsList title={t("adversum.quickSettings.shortcuts")}>
        {SHORTCUTS.map((key) => (
          <SettingsRow
            key={key}
            label={t(`adversum.quickSettings.${key}`)}
            description={
              <>
                {t(`adversum.quickSettings.${key}Description`)}
                {rejected === key && (
                  <span role="alert" className="mt-1 block text-red-500 dark:text-red-400">
                    {t("adversum.quickSettings.shortcutRejected")}
                  </span>
                )}
              </>
            }
          >
            <AcceleratorInput
              label={t(`adversum.quickSettings.${key}`)}
              disabled={!platform.supportsGlobalShortcuts}
              value={settings[key]}
              onChange={(accelerator) => void saveShortcut(key, accelerator)}
            />
          </SettingsRow>
        ))}
      </SettingsList>

      <SettingsList>
        <SettingsRow
          label={t("adversum.quickSettings.team")}
          description={t("adversum.quickSettings.teamDescription")}
        >
          <input
            type="text"
            // Shows what is stored again once a save has come back.
            key={settings.teamMembers.join(",")}
            defaultValue={settings.teamMembers.join(", ")}
            spellCheck={false}
            aria-label={t("adversum.quickSettings.team")}
            placeholder={t("adversum.quickSettings.teamPlaceholder")}
            onBlur={(event) => {
              const names = parseAliasInput(event.target.value);
              if (names.join(",") !== settings.teamMembers.join(",")) {
                void update("teamMembers", names);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-[29px] w-[230px] shrink-0 rounded-lg border border-[var(--s-line)] bg-[var(--s-card)] px-2.5 text-[12.5px] text-[var(--s-fg)] outline-none placeholder:text-[var(--s-fg-subtle)] focus:border-[var(--accent)]"
          />
        </SettingsRow>
      </SettingsList>

      {!enabled ? (
        <SettingsNote>{t("adversum.quickSettings.noConnection")}</SettingsNote>
      ) : (
        <SettingsList
          title={t("adversum.quickSettings.aliases")}
          description={t("adversum.quickSettings.aliasesDescription")}
        >
          <div data-settings-item className="flex items-center justify-between gap-3 px-4 py-3">
            <Segmented<AliasKind>
              ariaLabel={t("adversum.quickSettings.aliases")}
              value={kind}
              onChange={setKind}
              options={ALIAS_KINDS.map((value) => ({
                value,
                label: t(`adversum.quickSettings.aliasKind.${value}`),
              }))}
            />
            <div className="w-[180px]">
              <TextInput
                value={filter}
                onChange={setFilter}
                placeholder={t("adversum.quickSettings.aliasFilter")}
              />
            </div>
          </div>
          {entities.map((entity) => (
            <div key={`${kind}-${entity.id}`}>
              <AliasRow
                entity={entity}
                aliases={aliases[kind][String(entity.id)] ?? []}
                onSave={(list) => saveAliases(entity.id, list)}
                profileOpen={openProfile === entity.id}
                onToggleProfile={() =>
                  setOpenProfile((current) => (current === entity.id ? null : entity.id))
                }
              />
              {openProfile === entity.id && client && (
                <ProfileEditor
                  client={client}
                  kind={kind}
                  entity={entity}
                  onSaved={() => void qc.invalidateQueries({ queryKey: [kind, scope] })}
                />
              )}
            </div>
          ))}
          {entities.length === 0 && (
            <p className="px-4 py-3 text-[12px] text-[var(--s-fg-subtle)]">
              {t("adversum.quickSettings.noEntries")}
            </p>
          )}
        </SettingsList>
      )}
    </SettingsPage>
  );
}

/** "Kontakte: Giuseppe (Gigi) · Themen: Flyer": the profile at a glance. */
function profileSummary(comment: string | null): string {
  return profileLines(parseProfile(comment)).join(" · ");
}

interface AliasRowProps {
  profileOpen: boolean;
  onToggleProfile: () => void;
  entity: AliasEntity;
  aliases: readonly string[];
  onSave: (aliases: string[]) => void;
}

function AliasRow({ entity, aliases, onSave, profileOpen, onToggleProfile }: AliasRowProps) {
  const { t } = useTranslation();
  const stored = aliases.join(", ");
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);

  const commit = () => {
    const next = parseAliasInput(draft);
    if (next.join(", ") !== stored) onSave(next);
    else setDraft(stored);
  };

  return (
    <div data-settings-item className="flex min-h-[46px] items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[var(--s-fg)]">{entity.name}</div>
        {entity.context && (
          <div className="truncate text-[11.5px] text-[var(--s-fg-subtle)]">{entity.context}</div>
        )}
        {profileSummary(entity.comment) && (
          <div data-profile-summary className="truncate text-[11px] text-[var(--s-fg-subtle)]">
            {profileSummary(entity.comment)}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-expanded={profileOpen}
        aria-label={t("adversum.profile.openFor", { name: entity.name })}
        className={buttonClass(profileOpen ? "secondary" : "ghost", "sm")}
        onClick={onToggleProfile}
      >
        {t("adversum.profile.open")}
      </button>
      <input
        type="text"
        value={draft}
        spellCheck={false}
        aria-label={t("adversum.quickSettings.aliasesFor", { name: entity.name })}
        placeholder={t("adversum.quickSettings.aliasPlaceholder")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="h-[29px] w-[230px] shrink-0 rounded-lg border border-[var(--s-line)] bg-[var(--s-card)] px-2.5 text-[12.5px] text-[var(--s-fg)] outline-none placeholder:text-[var(--s-fg-subtle)] focus:border-[var(--accent)]"
      />
    </div>
  );
}

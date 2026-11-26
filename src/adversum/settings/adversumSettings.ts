import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Fork-only settings. They are stored apart from upstream's `AppSettings`
 * (own store file, own Rust commands), because upstream rejects every settings
 * key that is not part of `contracts/ipc-contract.json`.
 */

export type CustomerIndicator = "logo" | "dots";

export type AliasKind = "customers" | "projects" | "activities";

/** Alias words per Kimai entity id, e.g. `{ projects: { "12": ["pm"] } }`. */
export type ConnectionAliases = Record<AliasKind, Record<string, string[]>>;

export interface AdversumSettings {
  customerIndicator: CustomerIndicator;
  /** Optional logo.dev publishable key (`pk_…`); empty disables logo.dev. */
  logoDevToken: string;
  shortcutQuickEntry: string;
  shortcutPreviousTask: string;
  /** Quick-entry aliases, keyed by connection id. */
  aliases: Record<string, ConnectionAliases>;
}

export const ADVERSUM_SETTINGS_EVENT = "adversum://settings-changed";

export const defaultAdversumSettings: AdversumSettings = {
  customerIndicator: "logo",
  logoDevToken: "",
  shortcutQuickEntry: "Control+Alt+Space",
  shortcutPreviousTask: "Control+Alt+Z",
  aliases: {},
};

const ALIAS_KINDS: readonly AliasKind[] = ["customers", "projects", "activities"];
const MAX_ALIASES_PER_ENTITY = 20;
const MAX_ALIAS_LENGTH = 64;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string, maximum: number): string {
  return typeof value === "string" && value.length <= maximum ? value : fallback;
}

function normalizeAliasList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const alias = item.trim().slice(0, MAX_ALIAS_LENGTH);
    const key = alias.toLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= MAX_ALIASES_PER_ENTITY) break;
  }
  return aliases;
}

function normalizeAliasMap(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(value)) {
    if (!/^[1-9]\d{0,14}$/.test(id)) continue;
    const aliases = normalizeAliasList(list);
    if (aliases.length > 0) normalized[id] = aliases;
  }
  return normalized;
}

export function emptyConnectionAliases(): ConnectionAliases {
  return { customers: {}, projects: {}, activities: {} };
}

function normalizeAliases(value: unknown): Record<string, ConnectionAliases> {
  if (!isRecord(value)) return {};
  const normalized: Record<string, ConnectionAliases> = {};
  for (const [connectionId, raw] of Object.entries(value)) {
    if (!connectionId || connectionId.length > 256 || !isRecord(raw)) continue;
    const aliases = emptyConnectionAliases();
    for (const kind of ALIAS_KINDS) aliases[kind] = normalizeAliasMap(raw[kind]);
    normalized[connectionId] = aliases;
  }
  return normalized;
}

/** Accepts anything the store may hold and returns complete, valid settings. */
export function normalizeAdversumSettings(raw: unknown): AdversumSettings {
  const value = isRecord(raw) ? raw : {};
  return {
    customerIndicator: value.customerIndicator === "dots" ? "dots" : "logo",
    logoDevToken: stringValue(value.logoDevToken, "", 128).trim(),
    shortcutQuickEntry: stringValue(
      value.shortcutQuickEntry,
      defaultAdversumSettings.shortcutQuickEntry,
      256,
    ),
    shortcutPreviousTask: stringValue(
      value.shortcutPreviousTask,
      defaultAdversumSettings.shortcutPreviousTask,
      256,
    ),
    aliases: normalizeAliases(value.aliases),
  };
}

export async function loadAdversumSettings(): Promise<AdversumSettings> {
  try {
    return normalizeAdversumSettings(await invoke<unknown>("adversum_get_settings"));
  } catch {
    return normalizeAdversumSettings(null);
  }
}

export async function patchAdversumSettings(
  values: Partial<AdversumSettings>,
): Promise<AdversumSettings> {
  return normalizeAdversumSettings(
    await invoke<unknown>("adversum_patch_settings", { values }),
  );
}

export async function onAdversumSettingsChange(
  callback: (settings: AdversumSettings) => void,
): Promise<() => void> {
  return listen<unknown>(ADVERSUM_SETTINGS_EVENT, (event) => {
    callback(normalizeAdversumSettings(event.payload));
  });
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Fork-only settings. They are stored apart from upstream's `AppSettings`
 * (own store file, own Rust commands), because upstream rejects every settings
 * key that is not part of `contracts/ipc-contract.json`.
 */

export type CustomerIndicator = "logo" | "dots";

export type AliasKind = "customers" | "projects" | "activities";

/** Whisper models voice input can use, smallest first. */
export const VOICE_MODELS = ["base", "small", "large-v3-turbo"] as const;
export type VoiceModel = (typeof VOICE_MODELS)[number];

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
  /** Voice input is switched on (the speech model may still be missing). */
  voiceEnabled: boolean;
  voiceModel: VoiceModel;
  /** Folder for speech models; empty means the app data folder. */
  voiceModelDir: string;
  /** Press once to start and once to stop, instead of holding the key. */
  voiceTapMode: boolean;
  shortcutVoice: string;
  /** Identifier of the microphone to record from; empty means the system's input. */
  voiceInputDevice: string;
  /** Keep the last recording as WAV files for diagnosis. */
  voiceDebug: boolean;
  /**
   * Which language model may help to read a sentence with several entries:
   * "off" (rules only, the default: measured on 2026-11-27, no model small
   * enough for every Mac read our hard sentences reliably), "device" (the
   * local model, on this Mac only) or "auto" (the local model, else Claude
   * Code, which sends the sentence to Anthropic).
   */
  multiModel: MultiModelMode;
  /** The local language model to ask. */
  brainModel: BrainModel;
  /** Folder for the local language model's files; empty means the app data folder. */
  brainModelDir: string;
  /**
   * First names of colleagues. In a sentence they are people one works with:
   * they go into the note ("Call mit Patrick") and never decide the customer.
   */
  teamMembers: string[];
}

export const MAX_TEAM_MEMBERS = 50;
const MAX_NAME_LENGTH = 40;

/** The local language models on offer (`src-tauri/src/adversum/brain.rs`). */
export type BrainModel = "gemma-3-4b" | "qwen-1b5";
export const BRAIN_MODELS: readonly BrainModel[] = ["gemma-3-4b", "qwen-1b5"];

export type MultiModelMode = "auto" | "device" | "off";
export const MULTI_MODEL_MODES: readonly MultiModelMode[] = ["off", "device", "auto"];

export const ADVERSUM_SETTINGS_EVENT = "adversum://settings-changed";

export const defaultAdversumSettings: AdversumSettings = {
  customerIndicator: "logo",
  logoDevToken: "",
  shortcutQuickEntry: "Control+Alt+Space",
  shortcutPreviousTask: "Control+Alt+Z",
  aliases: {},
  voiceEnabled: false,
  voiceModel: "small",
  voiceModelDir: "",
  voiceTapMode: false,
  shortcutVoice: "Control+Alt+V",
  voiceInputDevice: "",
  voiceDebug: false,
  multiModel: "off",
  brainModel: "gemma-3-4b",
  brainModelDir: "",
  teamMembers: ["Patrick", "Michi", "Ema", "Lennart"],
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
    voiceEnabled: value.voiceEnabled === true,
    voiceModel: VOICE_MODELS.find((model) => model === value.voiceModel) ?? "small",
    voiceModelDir: stringValue(value.voiceModelDir, "", 1024),
    voiceTapMode: value.voiceTapMode === true,
    shortcutVoice: stringValue(value.shortcutVoice, defaultAdversumSettings.shortcutVoice, 256),
    voiceInputDevice: stringValue(value.voiceInputDevice, "", 512),
    voiceDebug: value.voiceDebug === true,
    multiModel: MULTI_MODEL_MODES.find((mode) => mode === value.multiModel) ?? "off",
    brainModel: BRAIN_MODELS.find((model) => model === value.brainModel) ?? "gemma-3-4b",
    brainModelDir: stringValue(value.brainModelDir, "", 1024),
    teamMembers: Array.isArray(value.teamMembers)
      ? value.teamMembers
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter((name) => name !== "" && name.length <= MAX_NAME_LENGTH)
          .slice(0, MAX_TEAM_MEMBERS)
      : defaultAdversumSettings.teamMembers,
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

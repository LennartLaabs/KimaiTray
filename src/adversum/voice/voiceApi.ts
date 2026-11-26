import { invoke } from "@tauri-apps/api/core";
import type { AliasKind, VoiceModel } from "../settings/adversumSettings";

/**
 * The native side of voice input (`src-tauri/src/adversum/voice/`): recording,
 * transcription with whisper.cpp, speech models and the microphone
 * permission. Everything runs on this machine.
 */

/** Native side → quick window: what the current voice input is doing. */
export const VOICE_STATE_EVENT = "adversum://voice-state";
/** Native side → quick window: input level from 0 to 1, a few times per second. */
export const VOICE_LEVEL_EVENT = "adversum://voice-level";
/** Native side → quick window: what was understood so far (Apple Silicon only). */
export const VOICE_PARTIAL_EVENT = "adversum://voice-partial";
/** Native side → all windows: progress of a model download. */
export const VOICE_DOWNLOAD_EVENT = "adversum://voice-download";
/** Native side → all windows: the user answered the microphone question. */
export const VOICE_PERMISSION_EVENT = "adversum://voice-permission";

export type VoicePermission = "granted" | "denied" | "undetermined";

/** Why a voice input could not start. */
export type VoiceErrorReason =
  | "disabled"
  | "noModel"
  | "permissionDenied"
  | "permissionRequested"
  | "noMicrophone"
  | "failed";

/** Payload of `VOICE_STATE_EVENT`. */
export interface VoiceState {
  phase: "recording" | "transcribing" | "result" | "empty" | "error";
  /** "recording": ends by click or key press, not by releasing the shortcut. */
  manual: boolean;
  /** "error" only. */
  reason?: VoiceErrorReason;
  /** "result" only: what was said. */
  text?: string;
}

export interface VoiceModelStatus {
  id: VoiceModel;
  sizeBytes: number;
  installed: boolean;
}

export interface VoiceDownload {
  model: string;
  state: "progress" | "done" | "cancelled" | "failed";
  received: number;
  total: number;
}

export interface VoiceStatus {
  /** Voice input exists on this platform (macOS). */
  supported: boolean;
  permission: VoicePermission;
  /** Text appears while speaking. */
  liveText: boolean;
  models: VoiceModelStatus[];
  /** Folder the models are in right now. */
  modelDir: string;
  defaultModelDir: string;
  /** A download that is under way. */
  download: VoiceDownload | null;
}

export function getVoiceStatus(): Promise<VoiceStatus> {
  return invoke("adversum_voice_status");
}

/** Resolves when the download has ended; progress arrives as events. */
export function downloadVoiceModel(model: VoiceModel): Promise<void> {
  return invoke("adversum_voice_download", { model });
}

export function cancelVoiceDownload(): Promise<void> {
  return invoke("adversum_voice_cancel_download");
}

export function deleteVoiceModel(model: VoiceModel): Promise<void> {
  return invoke("adversum_voice_delete_model", { model });
}

/** Opens a folder dialog; `null` when it was dismissed. */
export function chooseVoiceModelDir(): Promise<string | null> {
  return invoke("adversum_voice_choose_dir");
}

/** Lets macOS ask for the microphone if it has not yet; returns the state now. */
export function requestVoicePermission(): Promise<VoicePermission> {
  return invoke("adversum_voice_request_permission");
}

export function openVoicePrivacySettings(): Promise<void> {
  return invoke("adversum_voice_open_privacy");
}

/** Starts a recording that ends with `finishVoice` (button instead of key). */
export function startVoice(): Promise<void> {
  return invoke("adversum_voice_start");
}

export function finishVoice(): Promise<void> {
  return invoke("adversum_voice_finish");
}

export function cancelVoice(): Promise<void> {
  return invoke("adversum_voice_cancel");
}

/** Names the speech model should expect; only the tray window may set them. */
export function setVoiceVocabulary(vocabulary: string): Promise<void> {
  return invoke("adversum_voice_set_vocabulary", { vocabulary });
}

/** Stores one alias learned from a correction; resolves to whether it is new. */
export function learnAlias(
  connectionId: string,
  kind: AliasKind,
  entityId: number,
  alias: string,
): Promise<boolean> {
  return invoke("adversum_learn_alias", { connectionId, kind, entityId, alias });
}

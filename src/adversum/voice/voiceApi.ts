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

/** Why a voice input could not start, or why a recording came to nothing. */
export type VoiceErrorReason =
  | "disabled"
  | "noModel"
  /** The models lie on a volume that is not mounted; `detail` names it. */
  | "modelVolume"
  | "permissionDenied"
  | "permissionRequested"
  | "noMicrophone"
  | "failed"
  /** The key was only brushed. */
  | "tooShort"
  /** Silence or steady noise: nothing that rises like speech. */
  | "tooQuiet"
  /** The model wrote nothing, or one of its stock phrases for silence. */
  | "nothing";

/** Payload of `VOICE_STATE_EVENT`. */
export interface VoiceState {
  phase: "recording" | "transcribing" | "result" | "empty" | "error";
  /** "recording": ends by click or key press, not by releasing the shortcut. */
  manual: boolean;
  /** "error" and "empty". */
  reason?: VoiceErrorReason;
  /** "error" only: the concrete message, as it is in the log. */
  detail?: string;
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
  /** Folder that holds the last recording kept for diagnosis. */
  debugDir: string;
  /** The model in use: the chosen one, or another installed one when that is missing. */
  activeModel: VoiceModel | null;
  /** The model folder lies on this volume, which is not mounted. */
  modelVolume: string | null;
}

export interface VoiceDevice {
  id: string;
  name: string;
  /** The system's current input device. */
  isDefault: boolean;
}

/** Where a recording came from and what was done to it. */
export interface VoiceTestResult {
  outcome: "ok" | "tooShort" | "tooQuiet" | "nothing" | "noModel" | "failed";
  /** What the model understood; empty unless `outcome` is "ok". */
  text: string;
  detail: string | null;
  info: { device: string; sampleRate: number; channels: number; sampleFormat: string };
  report: {
    seconds: number;
    channelRms: number[];
    channelPeak: number[];
    /** Counted from 0. */
    usedChannel: number;
    offset: number;
    noiseFloor: number;
    speechLevel: number;
    hasSpeech: boolean;
    gain: number;
    rms: number;
    peak: number;
  };
  /** WAV file as it came from the device. */
  rawPath: string | null;
  /** WAV file as it went to the model (16 kHz mono). */
  preparedPath: string | null;
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

/**
 * Goes back to the model folder on the internal disk and downloads the
 * chosen model there. Resolves when the download has ended.
 */
export function reloadModelInternally(): Promise<void> {
  return invoke("adversum_voice_use_internal");
}

export function openVoicePrivacySettings(): Promise<void> {
  return invoke("adversum_voice_open_privacy");
}

export function getVoiceDevices(): Promise<VoiceDevice[]> {
  return invoke("adversum_voice_devices");
}

/**
 * Starts the microphone test. Rejects with a `VoiceErrorReason`, "busy", or
 * the device's own message. The level arrives as `VOICE_LEVEL_EVENT`.
 */
export function startVoiceTest(): Promise<void> {
  return invoke("adversum_voice_test_start");
}

/** Ends the microphone test and returns what was recorded and understood. */
export function finishVoiceTest(): Promise<VoiceTestResult> {
  return invoke("adversum_voice_test_finish");
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

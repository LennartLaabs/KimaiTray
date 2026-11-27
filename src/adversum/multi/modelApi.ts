import { invoke } from "@tauri-apps/api/core";
import type { QuickCatalog } from "../quickEntry/catalog";
import type { BrainModel } from "../settings/adversumSettings";
import type { VoiceDownload } from "../voice/voiceApi";
import { EXTRACT_INSTRUCTIONS, EXTRACT_SCHEMA, parseModelOutput } from "./extract";
import { EXTRACT_GRAMMAR, localInput, localInstructions } from "./localPrompt";
import type { DraftSource, Extraction } from "./types";

/**
 * The native side of language-model help: asking a model about a sentence,
 * and managing the files of the local one (`src-tauri/src/adversum/multi.rs`
 * and `brain.rs`).
 */

/** Which language models can help, as the native side sees it. */
export interface MultiModelStatus {
  /** "device" (the local model only), "auto" (then Claude Code) or "off". */
  mode: string;
  /** The local model can be asked: its helper and a model file are there. */
  local: boolean;
  /** The Claude Code command line is installed. */
  claude: boolean;
}

export function getMultiModelStatus(): Promise<MultiModelStatus> {
  return invoke("adversum_multi_status");
}

/**
 * Asks a language model for the activities of a sentence; `null` when none
 * can. The local model is given the names of the catalog and of colleagues,
 * which never leave the Mac; Claude Code gets the sentence only.
 */
export async function extractWithModel(
  sentence: string,
  now: Date,
  catalog: QuickCatalog,
  teamMembers: readonly string[],
): Promise<{ extraction: Extraction; source: DraftSource } | null> {
  const answer = await invoke<{ provider: DraftSource; output: string } | null>(
    "adversum_multi_extract",
    {
      sentence,
      instructions: EXTRACT_INSTRUCTIONS,
      schema: JSON.stringify(EXTRACT_SCHEMA),
      local: {
        instructions: localInstructions(catalog, teamMembers),
        input: localInput(sentence),
        grammar: EXTRACT_GRAMMAR,
      },
    },
  );
  if (!answer) return null;
  const extraction = parseModelOutput(answer.output, sentence, now);
  return extraction ? { extraction, source: answer.provider } : null;
}

// ── The local model's files ────────────────────────────────────

export interface BrainStatus {
  /** This build has the helper program that runs the model. */
  helper: boolean;
  models: { id: BrainModel; sizeBytes: number; installed: boolean }[];
  /** The model that would be asked right now. */
  activeModel: BrainModel | null;
  modelDir: string;
  defaultModelDir: string;
  /** The model folder lies on this volume, which is not mounted. */
  modelVolume: string | null;
  /** A download that is under way (of this or of a speech model). */
  download: VoiceDownload | null;
}

export function getBrainStatus(): Promise<BrainStatus> {
  return invoke("adversum_brain_status");
}

/** Resolves when the download has ended; progress comes as download events. */
export function downloadBrainModel(model: BrainModel): Promise<void> {
  return invoke("adversum_brain_download", { model });
}

export function deleteBrainModel(model: BrainModel): Promise<void> {
  return invoke("adversum_brain_delete", { model });
}

import { normalizeText } from "./normalize";

export type QuickCommand = "stop" | "pause" | "resume" | "previous";

const COMMAND_WORDS = new Map<string, QuickCommand>([
  ["stop", "stop"],
  ["stopp", "stop"],
  ["stoppen", "stop"],
  ["ende", "stop"],
  ["pause", "pause"],
  ["pausieren", "pause"],
  ["weiter", "resume"],
  ["fortsetzen", "resume"],
  ["resume", "resume"],
  ["zurueck", "previous"],
  ["zuruck", "previous"],
  ["back", "previous"],
]);

/** The command the input stands for, when it consists of nothing else. */
export function parseCommand(input: string): QuickCommand | null {
  return COMMAND_WORDS.get(normalizeText(input)) ?? null;
}

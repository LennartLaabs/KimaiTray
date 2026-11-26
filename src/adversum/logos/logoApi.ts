import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LogoSource = "manual" | "logodev" | "homepage" | "none";

/** One customer's cached logo state, as kept by `src-tauri/src/adversum/logos.rs`. */
export interface LogoEntry {
  customerId: number;
  source: LogoSource;
  /** `data:image/png;base64,…`, or `null` when no logo was found. */
  dataUrl: string | null;
  /** Older than its cache lifetime; worth fetching again. */
  stale: boolean;
  /** Whether logo.dev was already asked for this result. */
  triedLogoDev: boolean;
}

export interface LogoChange {
  connectionId: string;
  customerId: number;
  /** The customer's current entry; `null` when nothing is cached any more. */
  entry: LogoEntry | null;
}

export const LOGOS_CHANGED_EVENT = "adversum://logos-changed";

export function listLogos(connectionId: string): Promise<LogoEntry[]> {
  return invoke<LogoEntry[]>("adversum_logo_list", { connectionId });
}

export interface FetchLogoRequest {
  connectionId: string;
  customerId: number;
  homepage: string | null;
  logoDevToken: string | null;
  /** Ignore a still-fresh cache entry. */
  force?: boolean;
}

export function fetchLogo(request: FetchLogoRequest): Promise<LogoEntry> {
  return invoke<LogoEntry>("adversum_logo_fetch", { request });
}

export function setManualLogo(
  connectionId: string,
  customerId: number,
  imageBase64: string,
): Promise<LogoEntry> {
  return invoke<LogoEntry>("adversum_logo_set_manual", {
    request: { connectionId, customerId, imageBase64 },
  });
}

export function clearManualLogo(
  connectionId: string,
  customerId: number,
): Promise<LogoEntry | null> {
  return invoke<LogoEntry | null>("adversum_logo_clear_manual", {
    request: { connectionId, customerId },
  });
}

export function onLogoChange(
  callback: (change: LogoChange) => void,
): Promise<() => void> {
  return listen<LogoChange>(LOGOS_CHANGED_EVENT, (event) => callback(event.payload));
}

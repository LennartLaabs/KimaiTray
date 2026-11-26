import { useSyncExternalStore } from "react";
import type { CustomerIndicator } from "../settings/adversumSettings";

/**
 * What the popup needs to draw customer logos. It lives in a module store
 * instead of React context, because `AdversumBridge` is mounted next to the
 * window component, not around it (see `main.tsx`).
 *
 * The store is `null` until the bridge publishes, and stays `null` in
 * upstream's own component tests. Upstream components then render exactly as
 * they do upstream.
 */
export interface DisplayCustomer {
  id: number;
  name: string;
  /** Kimai color of the customer; may be empty. */
  color: string;
}

export interface AdversumDisplayState {
  indicator: CustomerIndicator;
  customersByProject: ReadonlyMap<number, DisplayCustomer>;
  /** Customer id → `data:` URL of the cached logo. */
  logos: ReadonlyMap<number, string>;
}

let state: AdversumDisplayState | null = null;
const listeners = new Set<() => void>();

export function setAdversumDisplay(next: AdversumDisplayState | null): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

export function getAdversumDisplay(): AdversumDisplayState | null {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAdversumDisplay(): AdversumDisplayState | null {
  return useSyncExternalStore(subscribe, getAdversumDisplay, getAdversumDisplay);
}

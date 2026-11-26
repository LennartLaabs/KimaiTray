/**
 * ADVERSUM: the upstream updater points at github.com/Engazan/KimaiTray and
 * would replace this fork with the upstream build. It stays off until the fork
 * publishes its own signed releases (then: set the endpoint and pubkey in
 * tauri.conf.json and return `true` here).
 *
 * Upstream's own unit tests keep exercising the upstream updater code, so the
 * switch is on under Vitest and off in every real build.
 */
export function adversumUpdaterEnabled(): boolean {
  return import.meta.env.MODE === "test";
}

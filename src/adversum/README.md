# Adversum additions

Everything the fork adds on top of upstream KimaiTray lives here (frontend) and
in `src-tauri/src/adversum/` (Rust). Upstream files only carry small hooks
marked `ADVERSUM:`. See the repository `CLAUDE.md` for the fork rules.

## How the pieces connect

- **Fork settings** (`settings/adversumSettings.ts`, `settings/useAdversumSettings.ts`,
  Rust `adversum/settings.rs`): own store file `adversum.json`, commands
  `adversum_get_settings` / `adversum_patch_settings`, change event
  `adversum://settings-changed`. Only the settings window may write.
- **Display store** (`display/displayStore.ts`): module-level store read with
  `useAdversumDisplay()`. `AdversumBridge.tsx` fills it and is mounted in
  `main.tsx` *next to* the window component. The store is `null` in upstream's
  component tests, where upstream components render unchanged.
- **Upstream tests stay untouched.** Fork behavior is switched by the display
  store being filled (app) or empty (upstream tests), never by editing upstream
  test files.

## Modules

| Module | Purpose | Hooks in upstream files |
|---|---|---|
| `updater.ts` | Kill switch for the upstream auto-updater. | `api/updater.ts` (no check), `settings/service.ts` (default `autoUpdate`), `settings/GeneralSection.tsx` (update settings hidden) |
| `AdversumBridge.tsx` | Loads projects, customers, fork settings and logos for a window and publishes them to the display store. | `main.tsx` |
| `display/CustomerIndicator.tsx` | Customer avatar that replaces the color dots in logo mode (20 px in lists, 28 px in roomy timer cards). | `components/ColorDots.tsx` plus a `projectId` prop at each of its call sites; `hooks/useStartTask.ts` (`StartPreview.projectId`) |
| `display/taskLabel.ts` | Customer-first labels for list entries: line 1 customer, line 2 project, activity, note. | `components/FavoriteTaskItem.tsx`, `RecentTaskItem.tsx`, `TodayEntryItem.tsx` |
| `logos/` | Logo cache client (`logoApi.ts`), homepage lookup (`customerHomepage.ts`), loading and background fetching (`useCustomerLogos.ts`), avatar (`CustomerAvatar.tsx`), manual image conversion (`encodeImage.ts`). | none |
| `settings/CustomerLogosSection.tsx`, `settings/navigation.tsx` | Settings page "Customer logos" and the fork's sidebar group. | `windows/Settings.tsx`, `types.ts` (`SettingsSection`), `tauri.conf.json` (`dragDropEnabled: false` on the settings window, so HTML5 file drops work) |

## Customer logos

Source order per customer:

1. Manual logo set in settings (never expires).
2. logo.dev, when a publishable key is configured: `https://img.logo.dev/{domain}?token=…&size=128&format=png&fallback=404`. The domain comes from the customer's Kimai homepage. `fallback=404` makes an unknown company fall through instead of returning a generated monogram.
3. The customer's homepage: largest `apple-touch-icon`, then largest `rel="icon"`, then `/favicon.ico`. SVG icons are skipped.
4. Initials on the Kimai customer color.

Kimai returns `homepage` only from `GET /api/customers/{id}`, so it is fetched
per customer right before a logo lookup. The result of the lookup is cached,
which makes that one detail request per customer and cache period.

All network access happens in `src-tauri/src/adversum/logos.rs`: HTTPS only,
default port only, every resolved address must be public (no private,
loopback, link-local, CGNAT or unique-local ranges), DNS results are pinned,
redirects are followed manually and re-validated (at most 3), 1 MB limit,
5 s connect and 10 s total timeout. Every image is decoded and re-encoded as a
PNG of at most 128 px before it is stored or returned. The webview only ever
receives `data:` URLs, so the CSP is unchanged.

Cache: `<app data>/adversum/logos/<connection id>/<customer id>.{manual.png,auto.png,json}`.
Found logos live 30 days, misses 3 days. Only the tray window fetches in the
background; other windows read the cache and follow `adversum://logos-changed`.

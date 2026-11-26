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
| `settings/CustomerLogosSection.tsx`, `settings/QuickEntrySection.tsx`, `settings/navigation.tsx` | Settings pages "Customer logos" and "Quick entry", and the fork's sidebar group. | `windows/Settings.tsx`, `types.ts` (`SettingsSection`), `tauri.conf.json` (`dragDropEnabled: false` on the settings window, so HTML5 file drops work) |
| `quickEntry/` parser (`normalize.ts`, `timeParser.ts`, `commands.ts`, `catalog.ts`, `history.ts`, `parse.ts`) | Pure functions that turn typed text into a command or ranked suggestions. No React, no I/O. | none |
| `quickEntry/QuickEntryBar.tsx`, `QuickToast.tsx` | The bar and its confirmation, used both in the floating window and as the popup's search field. | none |
| `quickEntry/QuickEntryWindow.tsx` | Window component for the label `adversum-quick`. | `main.tsx` (window routing), `tauri.conf.json` (window), `capabilities/adversum-quick.json` |
| `quickEntry/AdversumPopupQuick.tsx`, `useQuickExecutor.ts`, `popupBridge.ts` | The fork's layer in the tray popup: bar, executor for quick actions from every window, toast, "start in between". | `windows/TrayPopup.tsx` (one component, typing redirect), context menus in `components/FavoriteTaskItem.tsx` and `RecentTaskItem.tsx` |
| `quickEntry/ReminderSuggestions.tsx` | Three one-click starts on the "no timer" reminder. | `windows/TimerReminder.tsx` |

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

## Quick entry

### Parsing (`quickEntry/parse.ts`)

`parseQuickEntry(text, catalog, history, now)` is pure and does three things in order:

1. **Command**: the whole input is `stop`, `pause`, `weiter` or `zurück` (and a few synonyms).
2. **Time phrase** (`timeParser.ts`, on the raw words): `seit 9:45`, `ab halb 10`, `um viertel nach 9`, `vor 20 min` give a start in the past. `von 10 bis 11`, `1,5 h`, `90 min` give a finished entry. A clock hour up to 12 means the most recent matching time ("seit 3" at 15:30 is 15:00). A time in the future is flagged and the task starts now.
3. **Matching**: for every valid combination of customer, project and activity (`catalog.ts`), the remaining words are read left to right as names of its customer, project and activity. Each can be named once, by one or more consecutive words. The first word that names none of them starts the note, and everything after it is note too. That is why `dusw pm gigi call` gives customer DUSW, activity Projektmanagement and the note "Gigi Call", although "gigi" and "call" are aliases as well.

A word matches an entity by alias or exact name word (1.0), acronym of a multi-word name (0.85), prefix (0.7 to 0.95), typo within edit distance 1 or 2 (0.55 to 0.65) or substring (0.55). Text is normalized first: lowercase, umlauts written out, punctuation removed.

Ranking score = 10 × text score + 3 × history score. The history score (`history.ts`, 0 to 1) combines how often the combination was used in the last 90 days, how recently, and whether it usually runs around this time of day and on this weekday. One fully matched word therefore always outweighs history; history fills in what was not typed and breaks ties.

Confidence = match quality × lead over the runner-up × 0.7 if only the activity was named. Below `AUTO_SELECT_CONFIDENCE` (0.6) nothing is preselected, so Enter alone starts nothing and the user has to pick a row.

### Execution

The tray window owns all timer operations (`useStartTask`, `usePauseTimer`, locks, retry queue). `useQuickExecutor` runs there and builds quick actions from those same operations. Other windows only send events:

| Event | From → to | Meaning |
|---|---|---|
| `adversum://quick-shown` | Rust → quick window | The bar was shown: clear and focus. |
| `adversum://quick-execute` | quick window, reminder → tray | Run this `QuickAction`. |
| `adversum://quick-toast` | tray → quick window | Outcome of the last action. |
| `adversum://quick-undo` | quick window → tray | Undo the action behind a toast. |
| `adversum://previous-task` | Rust (shortcut) → tray | Switch to the previous task. |

Windows may only `emitTo` a named window (`core:event:allow-emit-to`); plain `emit` is not permitted by the capabilities.

- **Start** uses `startTask`, with `begin` for a start in the past (same path as upstream's custom start time).
- **Finished entry** posts begin and end directly (`createFinishedEntry`); no timer is touched.
- **Undo** (5 seconds) deletes the new entry and lets the entries that were stopped run again. `reopenTimesheet` first tries to clear the entry's end (`PATCH {end: null}`), so it continues as if never stopped; if Kimai refuses, it falls back to `restart`, which is what upstream does when resuming.
- **Start in between** (⌘Enter in the bar, context menu in the popup): pauses the running timer with upstream's pause, starts the new task and stores an `InterruptLink` (`interruptLink.ts`, `localStorage`). When that task is stopped, the paused timer resumes. It does not resume when the user switched to another task or paused the task itself.
- **Previous task** (shortcut, or `zurück`): starts the newest recent task that is not running. Pressed again it leads back, because by then the roles have swapped.

### Native side (`src-tauri/src/adversum/`)

- `quick.rs`: shows the window at the top center of the monitor under the pointer, hides, resizes to content. `quick_panel.rs` (macOS): hosts the webview in a non-activating `NSPanel`, mirroring upstream's `tray/platform/macos_panel.rs`. Typing into the bar does not activate the app; `adversum_quick_release_focus` hands the keyboard back to the user's application while the confirmation toast stays visible.
- `shortcuts.rs`: registers the two fork shortcuts from the fork settings. Upstream's `register_handlers` calls `unregister_all`, so it ends with a hook that registers ours again. A shortcut the system refuses is not saved (`adversum_patch_settings` registers before it persists).
- Dev check without pressing a shortcut: `ADVERSUM_SHOW_QUICK=1 npm run tauri dev` opens the bar at launch (debug builds only).

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
| `display/TimerCardTitle.tsx` | Customer-first title of the timer cards: line 1 customer, line 2 project and activity. Wraps upstream's title markup and renders it unchanged when the fork display is off. | `components/ActiveTimerCard.tsx`, `PausedTimerCard.tsx`, `PendingTimerCard.tsx` |
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
3. The customer's homepage, first usable image in this order:
   1. `<meta name="msapplication-TileImage">`
   2. `<meta property="og:image">`, only when the image turns out to be about square (aspect ratio up to 1.25). Share images are usually wide photos, which make no logo.
   3. `<link rel="apple-touch-icon">`, largest first
   4. every `<link rel="icon">` variant, largest first
   5. `/favicon.ico`

   SVG images are skipped (they are not rasterized natively). Markup inside scripts, styles and comments is ignored.
4. Initials on the Kimai customer color.

### Homepages and when a logo is looked up again

Kimai returns `homepage` only from `GET /api/customers/{id}`, not from the customer list. `useCustomerHomepages` reads it for every customer: at start, every five minutes, and when the popup gets the focus (at most once a minute). A failed request is kept apart from "no homepage" (`HomepageLookup.failed`); such a customer is left alone until Kimai answers.

Every cached result remembers the homepage it was looked up for. `needsLogoFetch` (frontend) and `is_fresh` (Rust) agree on when it is looked up again:

- nothing is cached yet,
- the homepage in Kimai differs from the cached one (entered, changed or removed): **at once**,
- the result expired: a found logo after 30 days, a miss after **one hour**,
- a logo.dev key is configured that was never tried for this result.

A lookup that fails outright (the fetch command rejects) is not repeated for the same input within ten minutes. Manual logos are never replaced.

Each miss records why (`LogoProblem`: `noHomepage`, `invalidHomepage`, `unreachable`, `httpStatus` with the status as detail, `noIcon`). The settings page shows source, homepage and that reason per customer.

### Network rules

All network access happens in `src-tauri/src/adversum/logos.rs`: HTTPS only, default port only, every resolved address must be public (no private, loopback, link-local, CGNAT or unique-local ranges), DNS results are pinned, redirects are followed manually and re-validated (at most 3, for example from `www.` to the bare domain), 1 MB limit, 5 s connect and 10 s total timeout. Every image is decoded and re-encoded as a PNG of at most 128 px before it is stored or returned. The webview only ever receives `data:` URLs, so the CSP is unchanged.

Cache: `<app data>/adversum/logos/<connection id>/<customer id>.{manual.png,auto.png,json}`. Only the tray window fetches in the background; other windows read the cache and follow `adversum://logos-changed`.

Live check against real websites (needs network): `cargo test adversum::logos -- --ignored --nocapture`.

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
| `adversum://quick-toast` | tray → quick window | Outcome of an action; shown as the toast overlay. |
| `adversum://quick-undo` | quick window → tray | Undo the action behind a toast (click). |
| `adversum://quick-undo-latest` | Rust (Cmd+Z while a toast offers undo) → tray | Undo the latest action. |
| `adversum://previous-task` | Rust (shortcut) → tray | Switch to the previous task. |

Windows may only `emitTo` a named window (`core:event:allow-emit-to`); plain `emit` is not permitted by the capabilities.

- **Start** uses `startTask`, with `begin` for a start in the past (same path as upstream's custom start time).
- **Finished entry** posts begin and end directly (`createFinishedEntry`); no timer is touched.
- **Confirmation**: every quick action, from whichever window or shortcut, is confirmed by a toast. The quick entry window shows it as an overlay at the bottom center of the screen for 5 seconds, without taking the keyboard. The bar itself closes right after Enter.
- **Undo** (while the toast is up): by clicking "Undo", or with Cmd+Z, which the native side registers as a global shortcut only for as long as an undoable toast is visible. Undo deletes the new entry and lets the entries that were stopped run again. `reopenTimesheet` first tries to clear the entry's end (`PATCH {end: null}`), so it continues as if never stopped; if Kimai refuses, it falls back to `restart`, which is what upstream does when resuming.
- **Start in between** (⌘Enter in the bar, context menu in the popup): pauses the running timer with upstream's pause, starts the new task and stores an `InterruptLink` (`interruptLink.ts`, `localStorage`). When that task is stopped, the paused timer resumes. It does not resume when the user switched to another task or paused the task itself.
- **Previous task** (shortcut, or `zurück`): starts the newest recent task that is not running. Pressed again it leads back, because by then the roles have swapped.

### Native side (`src-tauri/src/adversum/`)

- `quick.rs`: one window with two placements on the screen under the pointer. As the **bar** it is horizontally centered with its top edge 20 % below the top of the visible area (below the menu bar); the top edge is fixed and the suggestion list grows downward. As the **toast** it stands at the bottom center and never takes the keyboard. `top_left` is the pure placement math and is unit-tested.
- `quick_panel.rs` (macOS): hosts the webview in a non-activating `NSPanel`, mirroring upstream's `tray/platform/macos_panel.rs`, and places the panel itself in Cocoa screen points (`NSEvent.mouseLocation`, `NSScreen.visibleFrame`). Do not size or move it through the Tauri window: `set_size` keeps the bottom edge fixed, which pushes a growing bar up and off the screen, and `set_position` converts with a single scale factor, which is wrong between monitors of different density.
- `shortcuts.rs`: registers the two fork shortcuts from the fork settings. Upstream's `register_handlers` calls `unregister_all`, so it ends with a hook that registers ours again. A shortcut the system refuses is not saved (`adversum_patch_settings` registers before it persists).
- Dev check without pressing a shortcut (debug builds only): `ADVERSUM_SHOW_QUICK=1 npm run tauri dev` opens the bar at launch and resizes it once, `ADVERSUM_SHOW_QUICK=toast …` shows the toast. The log lines "Quick entry panel placed" give the frame and the visible screen area in points. While the installed app is running, add `-- --config '{"identifier":"io.adversum.kimaitray.devcheck"}'`, because a second instance with the same identifier exits at once.

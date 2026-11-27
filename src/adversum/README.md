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
| `quickEntry/` parser (`normalize.ts`, `dateParser.ts`, `timeParser.ts`, `nameLike.ts`, `commands.ts`, `catalog.ts`, `history.ts`, `parse.ts`) | Pure functions that turn typed text into a command or ranked suggestions. No React, no I/O. | none |
| `quickEntry/QuickEntryBar.tsx`, `QuickToast.tsx` | The bar and its confirmation, used both in the floating window and as the popup's search field. | none |
| `quickEntry/QuickEntryWindow.tsx` | Window component for the label `adversum-quick`. | `main.tsx` (window routing), `tauri.conf.json` (window), `capabilities/adversum-quick.json` |
| `quickEntry/AdversumPopupQuick.tsx`, `useQuickExecutor.ts`, `popupBridge.ts` | The fork's layer in the tray popup: bar, executor for quick actions from every window, toast, "start in between". | `windows/TrayPopup.tsx` (one component, typing redirect), context menus in `components/FavoriteTaskItem.tsx` and `RecentTaskItem.tsx` |
| `quickEntry/ReminderSuggestions.tsx` | Three one-click starts on the "no timer" reminder. | `windows/TimerReminder.tsx` |
| `multi/` (`segment.ts`, `draft.ts`, `plan.ts`, `extract.ts`, `localPrompt.ts`, `modelApi.ts`, `MultiStage.tsx`, `MultiReview.tsx`) | Several entries from one sentence: rules, optional language model, arithmetic and the review before entering. | `quickEntry/QuickEntryBar.tsx` (offer), `QuickEntryWindow.tsx` (stage), `useQuickExecutor.ts` (`batch` action) |
| `voice/spoken.ts`, `spokenTime.ts`, `spokenNumbers.ts` | Pure functions that turn a transcribed sentence into a command, a note or text for the quick entry parser. | none (`quickEntry/parse.ts` has a spoken mode for it) |
| `voice/VoiceStage.tsx`, `learn.ts`, `vocabulary.ts`, `voiceApi.ts` | Recording overlay and confirmation card in the quick entry window, learning aliases from corrections, the vocabulary for the speech model, and the bridge to the native side. | none (rendered by `quickEntry/QuickEntryWindow.tsx`; microphone button in `QuickEntryBar.tsx`) |
| `settings/VoiceSection.tsx` | Settings page "Voice input". | `types.ts` (`SettingsSection`) |
| Rust only: `src-tauri/src/adversum/keystore.rs` | API token access through the signed key helper (`scripts/adversum/keyhelper/`), so macOS does not ask for the keychain after every build. Why and how: repository `CLAUDE.md`, "Code signing and the keychain". | `src-tauri/src/keychain.rs` (three functions try the helper first; own keychain service, separate one for debug builds) |

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
   **Day** (`dateParser.ts`, before the time): `heute`, `gestern`, `vorgestern`, `am Montag`, `letzten Freitag`, `26. November`, `26.11.`, `am 26.` name the day of the entry and never reach the note. Days lie in the past: a weekday is the most recent one, a date without a year the most recent one that is not in the future. On another day than today `von 10 bis 11` lies on that day (hours 1 to 6 are read as afternoon), a bare duration starts at 09:00 (`DEFAULT_BEGIN_HOUR`) because nothing says when it was, and a day with neither is `incomplete`: the chip says so and Enter does nothing. The chip shows the day in front of the time.
3. **Matching**: for every valid combination of customer, project and activity (`catalog.ts`), the remaining words are read left to right as names of its customer, project and activity. Each can be named once, by one or more consecutive words. The first word that names none of them starts the note, and everything after it is note too. That is why `dusw pm gigi call` gives customer DUSW, activity Projektmanagement and the note "Gigi Call", although "gigi" and "call" are aliases as well. A naming word stays in the note when it is more than a name (`nameLike.ts`): an alias that is no spelling, part, slip or abbreviation of the entity's own name, such as a person ("Giuseppe" for a customer) or what was done ("Call" for the activity "Austausch"). The word that decided the activity leads the note: `giuseppe call` → DUSW · Austausch, note "Call Giuseppe". "dusw", "pm" and "design" for an activity called Design are only names and leave the note. Notes keep the spelling they came in, hyphens included, without the punctuation of the sentence; a note typed all lowercase gets capitals.

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
- Dev check without pressing a shortcut (debug builds only): `ADVERSUM_SHOW_QUICK=1 npm run tauri dev` opens the bar at launch and resizes it once, `ADVERSUM_SHOW_QUICK=toast …` shows the toast. The log lines "Quick entry panel placed" give the frame and the visible screen area in points. Tell Lennart before starting a dev instance and quit it afterwards (repository `CLAUDE.md`, "Only the installed app runs"); add `-- --config '{"identifier":"io.adversum.kimaitray.devcheck"}'`, because a second instance with the same identifier exits at once.

### Work that is still going on, and colleagues

"Bin seit 30 Minuten mit Patrick im Call für DUSW, wir besprechen den Messestand, sind immer noch dran" starts a timer that began half an hour ago and keeps running; it is never a finished 30-minute entry.

- **Running or finished** (`voice/spoken.ts`). "seit …" is a start anyway. A bare duration becomes a start as well when the sentence says the work goes on: "immer noch", "noch dran", "läuft noch" always, "gerade", "bin im …", "sitze an …" unless the sentence looks back with "hab …" ("hab gerade 20 Minuten … gemacht" is done). A time span ("von 13 bis 14") is always finished.
- **Colleagues** (setting `teamMembers`, Settings → Quick entry; `QuickCatalog.team`). A colleague's name never names a customer, not as a stored alias, not through past notes, and is never learned as one. It goes into the note after the kind of work: "Call mit Patrick: Messestand" (what, with whom, about what).
- **The customer comes from the sentence.** A spoken sentence starts by itself only when a word names the customer or the project. Otherwise the card shows the ranked suggestions and waits.
- **What ran before** ends at the moment the new task began, not now (`useQuickExecutor.ts`), so the two never overlap; the card says "… endet um 20:54". Undo deletes the new entry and lets the old one run on. A timer that began after the new task's begin is stopped by the switch as usual.

## Several entries from one sentence

"Ich hab eine Stunde an DUSW Design gearbeitet, dazwischen 10 Minuten K&K Call" is two tasks and three entries. Typed or spoken, such a sentence goes to a review instead of the single card (`multi/`).

1. **Rules** (`segment.ts`, always there). The sentence is cut into clauses at commas and at "dazwischen", "danach", "vorher", "der Rest", and at "und" where both sides are an activity with an amount. Each clause gives up what it says about how long (`eine Stunde`, `kurz`), how often (`8 mal`, `immer wieder`, `je 7 Minuten`), when (`von 9 bis 12`) and in which order; the rest is its text. "Die letzten 3 Stunden" is the window for all of them. A clause that names no task is the note or the amount of its neighbour.
2. **Matching** (`draft.ts`). Each clause's text goes through `interpretSpoken` and `parseQuickEntry`, so customers, projects, activities, aliases, verbs and notes mean what they mean everywhere else. A clause with only an activity takes the customer from the one before; one that names nothing is more of the same task. It is several entries only when at least two activities each say how long or in which order (or a window was named). "DUSW Projektmanagement, Gigi Call seit zehn" stays one entry.
3. **Language model**, only where the rules are unsure: a clause with an amount but no task they know. First the local model (`localPrompt.ts`, `modelApi.ts`, native `brain.rs`: llama.cpp in the helper program `kimaitray-llm`, held to JSON by a grammar, given the names of the catalog and of colleagues), when its file was downloaded in Settings → Voice input → "AI model for complex sentences". Second, only in mode "auto", the Claude Code command line of the user's own subscription (`claude -p`, no API key), which gets the sentence alone and sends it to Anthropic. A model extracts and never calculates, and it is not trusted with numbers: `groundExtraction` (`extract.ts`) drops every duration, count and clock time that the sentence does not contain, so the review asks instead of showing something made up. Its answer is then matched and planned like the rules' own. The review names who read the sentence (rules, local model, Claude Code). The rules' reading is on screen at once and a model's answer replaces it when it comes; a sentence the rules could not split at all waits at most eight seconds for a model and then goes on as a single entry.
4. **Arithmetic** (`plan.ts`, pure and tested). Without anything else said the entries end now and begin the sum of their durations earlier; a window and clock times take precedence, and another day starts at 09:00. "dazwischen" splits the activity before it around the interruption with the total unchanged (switchable to "on top" and to "one block"); "vorher" steps in front; "der Rest", or the one activity without an amount, fills the window. "kurz" and "ein paar Minuten" are five minutes, marked as an assumption. A count that was not said ("immer wieder") is asked. Existing entries of the day (`useDayEntries.ts`) are never overlapped: the plan flows around them.
5. **Review** (`MultiReview.tsx` in the quick window; the popup hands its sentence over with `MULTI_REVIEW_EVENT`). One row per block with check mark, task (click to type another), note, begin, end and duration. Assumptions are yellow with their switches, questions sit on top with a field and "leave out". Enter sends one `batch` action to the tray window, Esc discards; clicking elsewhere does not.
6. **Entering** (`useQuickExecutor.ts`). The running timer the entries describe ends where they begin, or is removed when they cover all of it ("keep" in the review leaves it alone and puts the entries before it). Then the entries are created one by one. If a step fails, everything done is taken back. Undo (toast or ⌘Z, five seconds) deletes all created entries and lets the timer run again.

## Voice input

Hold the voice key (default ⌃⌥V), say what you are working on, release. Everything runs on this Mac; macOS only for now.

### From key press to timer

1. **Native side** (`src-tauri/src/adversum/voice/`). `shortcuts.rs` passes both edges of the voice key to a voice thread (`voice/mod.rs`, `request`), which keeps them in order and off the main thread. Held, the key records until it is released; released within 350 ms it was a tap, and the recording runs until the next press (tap mode in the settings makes every press a tap). `recorder.rs` records the selected microphone with cpal on its own thread and keeps the samples as delivered. `audio.rs` (`prepare`) takes the loudest channel instead of a mix (one channel may be dead, or the two may cancel), removes a constant offset, resamples to 16 kHz, decides whether there is speech at all (loud frames must stand out from the quiet ones) and brings quiet speech up to level. `transcribe.rs` runs whisper.cpp through whisper-rs: German, primed with the vocabulary, Metal on Apple Silicon and CPU on Intel; a final run that fails on the GPU is repeated on the CPU. `guard.rs` drops what Whisper invents for silence ("Danke.", "Untertitel …") and the vocabulary coming back. The model stays loaded for ten minutes after the last use. `tauri-plugin-stt` was checked first; it has no initial prompt, which is why whisper-rs is used directly.
2. **Quick entry window.** The native side shows it in the bar's place and sends `adversum://voice-state` (`recording`, `transcribing`, `result`, `empty`, `error`), `adversum://voice-level` and, on Apple Silicon, `adversum://voice-partial` with the text so far. `voice/VoiceStage.tsx` renders the overlay and then the confirmation card.
3. **Reading the sentence** (`voice/spoken.ts`). Removes fillers and lead-ins ("äh", "ich mache jetzt", "starte bitte"), rewrites spoken times for `quickEntry/timeParser.ts` ("seit zehn Uhr dreißig" → "seit 10:30", "zwischen acht und neun" → "von 8 bis 9", "seit einer halben Stunde" → "vor 30 min", "von 14 Uhr bis jetzt"), and recognizes commands ("Stopp", "mach mal Pause", "zurück zur letzten Aufgabe") and notes ("Notiz: …" is added to the running timer). A verb gives the note a noun and hints at the activity: "mit Gigi telefoniert" → note "Telefonat Gigi", activity hints "telefon", "call", "austausch" ….
4. **Matching** (`parseQuickEntry(…, spoken)`). The spoken mode differs from typed input in three ways. Word order is free: entities can be named anywhere, the words in between are the note; after the first note word a later word must name an entity almost exactly. Glue words ("für", "mit", "das") neither start the note nor end a name. And there are two more kinds of evidence: words of *past notes* point to the task they were booked on (`QuickHistory.notes`, so "Gigi" finds DUSW · Austausch), and the verb's activity hints count when no word names the activity.
5. **Confirmation card.** A confident reading (the parser's `autoSelect`, and no time in the future) starts by itself after two seconds, shown by a shrinking bar. Enter starts at once, ↑/↓ pick another suggestion, Tab continues by typing in the bar, Escape discards. Any key stops the countdown. An uncertain reading waits with the first row preselected.
6. **Learning** (`voice/learn.ts`). Taking another suggestion than the first, or correcting the text by hand, teaches aliases: the word that named the wrong entity, a leftover word that resembles the right name, or (customer only) the only leftover word. They are stored with `adversum_learn_alias`, the one settings write the quick windows are allowed, and named in the confirmation toast ("Gemerkt: …"). Wrong ones can be removed under Settings → Schnellstart → Aliasse.

### When it does not work

- Every recording is described in the app log (`~/Library/Logs/io.adversum.kimaitray/`): device, sample rate, channels, format, length, level per channel, channel used, noise floor and speech level, gain, what the model wrote, and the concrete error if there was one. whisper.cpp's own warnings and errors are in the same log (target `whisper_rs`).
- The overlay shows the reason: too short, too quiet or no speech, nothing understood, or the error text itself.
- Settings → Sprachsteuerung → "Mikrofon testen" records a few seconds with a live level, runs the same steps and shows the measurements. Its recording is kept as `last-raw.wav` (as delivered by the device) and `last-16k.wav` (as given to the model) in `<app data>/adversum/voice-debug/`; with "Letzte Aufnahme aufbewahren" on, every voice input is. Only the most recent recording exists at any time.
- To tell an audio problem from a recognition problem, give the kept recording to the model: the ignored test in `voice/session.rs` takes a stereo 48 kHz WAV and also runs it with typical faults (dead channel, opposite signs, offset, very quiet, noise only).

### Speech models

`voice/models.rs`: `base` (148 MB), `small` (488 MB, default) and `large-v3-turbo` (1.6 GB), the `ggml` files of the whisper.cpp repository on Hugging Face. Size and SHA-256 are pinned in the code; a download that matches neither is discarded. Models go to `<app data>/adversum/models` or the folder chosen in the settings (`voiceModelDir`); changing the folder does not move files. This download is the only network access of the feature.

### Vocabulary

The tray window keeps the native side's vocabulary current (`voice/vocabulary.ts`, `adversum_voice_set_vocabulary`): capitalized words that recur in past notes (mostly names such as "Gigi"), project, activity and customer names and all aliases. Whisper reads only the last part of an overlong prompt, so customers come last and the native side cuts from the front.

### Permissions and build

- `src-tauri/Info.plist` has `NSMicrophoneUsageDescription`, and `src-tauri/Entitlements.plist` the audio-input entitlement the hardened runtime requires. macOS ties the permission to the signature, hence the fixed certificate (repository `CLAUDE.md`).
- Building needs `cmake` (whisper.cpp is compiled from source by `whisper-rs-sys`) and the Xcode command line tools.
- A real transcription can be tested without the app: see the ignored test in `voice/transcribe.rs` (speech from `say`, a downloaded model). Run it after any change to `transcribe.rs` or an update of whisper-rs; unit tests cannot catch what it catches.
- Do not use whisper-rs 0.16's `set_abort_callback_safe`: it reads the callback's data with the wrong type and aborts runs at random (whisper error -6). `transcribe.rs` sets the plain callback itself.
- The browser preview simulates recording and transcription (`scripts/adversum/preview/README.md`).

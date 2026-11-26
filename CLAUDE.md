# KimaiTray Adversum (Fork)

Fork of [Engazan/KimaiTray](https://github.com/Engazan/KimaiTray) (Tauri 2, React 19, TypeScript, Rust), a tray app for Kimai time tracking.

- `origin` = https://github.com/LennartLaabs/KimaiTray (our fork, we push to `main`)
- `upstream` = https://github.com/Engazan/KimaiTray (read-only, merge source)

## Fork rules

1. **New features live in their own folders**: `src/adversum/…` (frontend) and `src-tauri/src/adversum/…` (Rust). Fork-only scripts go in `scripts/adversum/`.
2. **Existing upstream files only get minimal hooks**, each marked with `// ADVERSUM:` (or `{/* ADVERSUM: … */}` in JSX). A hook imports or calls into `adversum/`; it does not contain logic. `grep -rn "ADVERSUM:" src src-tauri` lists every hook.
3. **Do not weaken the CSP** in `src-tauri/tauri.conf.json`. Remote images are fetched in Rust and handed to the webview as `data:` URLs.
4. **Identity**: bundle identifier `io.adversum.kimaitray`, product name `KimaiTray Adversum`, keychain service `io.adversum.kimaitray`. Never change these back; they keep settings and credentials separate from an upstream install.
5. **Updater is off** (`src/adversum/updater.ts`, empty `plugins.updater.endpoints`, `createUpdaterArtifacts: false`). Re-enable only with our own signed releases.
6. Keep upstream conventions: i18n keys in all six locale files, Vitest tests next to the code, `npm run check` green before every commit.
7. Fork-only settings are **not** added to `AppSettings`. The upstream settings patch is whitelisted through `contracts/ipc-contract.json`; fork settings have their own store (see Architecture).

## After every fix: install it

Lennart tests in the installed app, so a fix is not done until it runs there. After every fix or feature, in this order and without asking:

1. `npm run check` and the three cargo commands are green.
2. Commit and push to `origin main`.
3. `./scripts/adversum/install.sh`: release build for this Mac, signed with "Adversum Dev", quit the running "KimaiTray Adversum", replace `/Applications/KimaiTray Adversum.app`, start it again. Settings, favorites and the API token survive; they are not in the app bundle.

Build a disk image only when Lennart asks for one for someone else (Patrick): `./scripts/adversum/build-dmg.sh` (universal, Apple Silicon and Intel).

### Only the installed app runs

**Never start the app from the build folder or with `npm run tauri dev` while Lennart uses the installed one**, and never leave such an instance running. If a native check needs a dev instance, tell him first, use `-- --config '{"identifier":"io.adversum.kimaitray.devcheck"}'`, and quit it when done. `install.sh` quits every copy and warns if one outside `/Applications` is still running. Debug builds use the keychain service `io.adversum.kimaitray.dev`, so they cannot touch the real API token.

## Code signing and the keychain

Two separate mechanisms decide whether macOS asks again after a new build. Both are handled by the scripts; do not "simplify" either away.

**1. Signature: certificate "Adversum Dev".** Privacy permissions such as the microphone are tied to the app's *designated requirement*. An ad-hoc signature has a new one with every build. Release builds are therefore signed with a local self-signed certificate:

- Certificate **"Adversum Dev"** (code signing only, valid until November 2036), private key in Lennart's login keychain, trusted for code signing for his user. Created by `./scripts/adversum/setup-signing.sh`; run it again on a new Mac or after the certificate expired.
- `scripts/adversum/signing.sh` (sourced by `install.sh` and `build-dmg.sh`) sets `APPLE_SIGNING_IDENTITY` to it and prints signer and designated requirement after each build. The requirement must read `identifier "io.adversum.kimaitray" and certificate leaf = H"…"` with the same hash every time. Without the certificate the scripts fall back to ad hoc and say so.

**2. Keychain: the key helper.** The certificate alone does *not* keep the keychain quiet (verified 2026-11-26 with a throwaway entry: same signer, same requirement, different build, macOS asked again). Besides its access list, a keychain entry has a partition list. Code without an Apple team ID belongs to the partition `cdhash:<hash of this build>`, so every build is a stranger. A self-chosen team ID is not a way out: macOS kills such a binary at launch (`codesign --team-identifier`, exit 137).

- `scripts/adversum/keyhelper/keyhelper.c` is a tiny program that reads, writes and deletes the entry `io.adversum.kimaitray` and does nothing else. It is built and signed **once** (`keyhelper/build.sh`, cached in `/Volumes/AdversumDev/.cache/keyhelper/`) and then stays byte for byte the same, so "Always Allow" for it lasts.
- `signing.sh` copies it into every build as `Contents/MacOS/kimaitray-keyhelper` and signs the bundle again. In the app, `src-tauri/src/adversum/keystore.rs` runs it for all token access (hooks in `keychain.rs`); the token goes through pipes, not arguments. Debug and ad-hoc builds have no helper and use the keyring crate directly, as upstream does.
- The helper only serves a parent process that is validly signed as `io.adversum.kimaitray` with our certificate (the certificate's hash is compiled in). Started from anything else it exits with status 4.
- **Do not edit `keyhelper.c`, its build flags or the cache without need.** Any change makes a new binary, and macOS asks once more. `build.sh` prints a warning when it builds a new one; tell Lennart before installing such a build.

Dialogs only a human can answer, each once: the trust change in `setup-signing.sh` (password or Touch ID); "codesign wants to sign using key Adversum Dev" at the first build (password, **Always Allow**); the keychain question for `kimaitray-keyhelper` at the first start with a new helper (password, **Always Allow**). Tell Lennart before any step that brings one up. After that, installs are silent.

- A new certificate (expired, deleted, other Mac) means a new helper and a new requirement: the keychain asks once more, and macOS forgets the microphone permission.
- Do not read keychain access lists with `security dump-keychain -a`: it opens a dialog for every entry. `security find-generic-password -s io.adversum.kimaitray` (without `-w`/`-g`) shows the entry's attributes silently. Never read the token itself.
- To check an install for dialogs without seeing the screen: a password or keychain dialog is a running `SecurityAgent` process (`pgrep -x SecurityAgent`).

**For Patrick (any other Mac):** the certificate is self-signed and only trusted on Lennart's Mac. A disk image from `build-dmg.sh` is not notarized, so Gatekeeper blocks the first start; Patrick has to allow it under System Settings → Privacy & Security → "Open Anyway" ("Dennoch öffnen") after each new image. That stays so until we sign and notarize with an Apple Developer ID. The key helper works on his Mac too: he confirms the keychain question once ("Always Allow") and is not asked again by later images, as long as they carry the same helper.

## Environment on Lennart's Mac

The repo lives in an APFS disk image, because the SSD itself is exFAT (no symlinks, so `npm install` fails there).

- Image: `/Volumes/Adversum /Dev.sparsebundle` (note the trailing space in the volume name), mounted at `/Volumes/AdversumDev`.
- Auto-mount: LaunchAgent `~/Library/LaunchAgents/io.adversum.mount-dev.plist` runs `~/Library/Application Support/Adversum/mount-dev-image.sh` at login and whenever a volume is mounted. Log: `~/Library/Logs/adversum-mount-dev.log`. Manual mount: double-click `Dev.sparsebundle` in Finder.
- `node_modules`, `src-tauri/target`, the cargo registry and the npm cache are all inside the image. Only the Rust toolchain (`~/.rustup`, about 560 MB) is on the internal disk.

### Node and the project environment

Node is the system default from Homebrew (`node`, currently 26). `package.json` `engines` allows `^22.22.2 || ^24.15.0 || >=26.0.0`; Node 25 is not supported. `.node-version` (22) is upstream's file for CI and is left untouched.

**Always run npm, node and cargo through `scripts/adversum/env.sh`.** It adds `~/.cargo/bin` to `PATH` and, when the image is mounted, points `CARGO_HOME` and the npm cache into `/Volumes/AdversumDev/.cache`.

```sh
./scripts/adversum/env.sh npm run tauri dev     # run one command
. ./scripts/adversum/env.sh                     # or source it once per shell
```

Node 25 and newer ship a global `sessionStorage`. Upstream's tests assume there is none outside jsdom (true up to Node 24), which leaves one branch of `src/api/deepLink.ts` uncovered and fails the coverage gate. `src/adversum/upstreamCompat.test.ts` covers that branch explicitly. If a merge from upstream fails `npm run check` only on newer Node, look for the same kind of assumption first and add a test there rather than editing upstream's tests.

## Commands

All through `./scripts/adversum/env.sh …` (or after sourcing it):

| Purpose | Command |
|---|---|
| Install dependencies | `npm ci` |
| Run the app in dev mode | `npm run tauri dev` |
| Full frontend gate (version, i18n, lint, tests + coverage, build) | `npm run check` |
| Tests only | `npm test` / `npx vitest run src/adversum` |
| i18n key parity | `npm run i18n:check` |
| Copy new `adversum.*` keys from `en` to sk/cs/uk/es (`--overwrite` after rewording an existing English text) | `node scripts/adversum/i18n-sync.mjs` |
| Rust format / lint / tests (in `src-tauri/`) | `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` |
| Build and install on this Mac | `./scripts/adversum/install.sh` (`--no-build` reuses the last build) |
| One-time: create and trust the signing certificate | `./scripts/adversum/setup-signing.sh` |
| Universal disk image for someone else | `./scripts/adversum/build-dmg.sh` |

Build output: `src-tauri/target/<target>/release/bundle/macos/` (app) and `…/bundle/dmg/` (disk image).

### Browser preview (look at the UI without the native app)

`scripts/adversum/preview/` runs the real frontend in a normal browser against a simulated Tauri backend and sample Kimai data (customers, projects, 90 days of history). Use it to check layout and flows visually; it needs no Kimai instance and no credentials.

```sh
./scripts/adversum/env.sh npm run dev
```

Then open `http://localhost:1420/scripts/adversum/preview/index.html`. Query parameters: `window=tray-popup|settings|timer-reminder|adversum-quick`, `theme=dark`, `layout=…`, `indicator=dots`, `reset=1`. Details and limits: `scripts/adversum/preview/README.md`. When a new native command is added, give it a handler in `fakeTauri.ts`; unhandled commands are logged to the browser console.

### Things that bite

- **Coverage thresholds are 100 % statements/lines/functions and 90 % branches** (`vitest.config.ts`). Every new TypeScript line needs a test. Upstream wraps code that can only run from native menus in `/* v8 ignore start */ … /* v8 ignore stop */`; use that sparingly and only for the same reason.
- `npm run i18n:check` compares all six locales against `en.json`, including `{{placeholders}}`. We translate `en` and `de` by hand; the other four get the English text through `i18n-sync.mjs`.
- `npm run version:check` requires identical versions in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- ESLint runs with `--max-warnings=0`.
- The Rust build compiles whisper.cpp and needs `cmake` (`brew install cmake`). The first build after `cargo clean` takes a few minutes longer because of it.
- The original KimaiTray may be installed and running on this Mac. Both apps register the `kimaitray://` deep-link scheme; do not test deep links while both are installed.

## Merging upstream

```sh
git fetch upstream
git merge upstream/main
```

Conflicts should only appear at `ADVERSUM:` hooks, in `tauri.conf.json` (identifier, product name, updater block) and in the locale files (our keys sit in the top-level `adversum` object at the end of each file). After merging: `npm ci`, `npm run check`, the three cargo commands, then `./scripts/adversum/install.sh` as the smoke test (not `npm run tauri dev`, see "Only the installed app runs").

## Architecture

### Upstream

- `src/main.tsx` picks a window component by Tauri window label: `tray-popup` → `windows/TrayPopup.tsx`, `settings` → `windows/Settings.tsx`, `timer-reminder` → `windows/TimerReminder.tsx`, `changelog` → `windows/Changelog.tsx`. Windows are declared in `src-tauri/tauri.conf.json`, each with its own least-privilege capability file in `src-tauri/capabilities/`.
- `windows/TrayPopup.tsx` composes the UI, the data hooks (`hooks/`) and the tray workflows (`tray/`, see `src/tray/README.md`). All background work (shortcuts, idle detection, reminders) lives in the tray window, which exists for the whole app lifetime.
- Kimai access: `api/kimaiClient.ts` → `api/safeHttp.ts` → Rust command `http_request` (`src-tauri/src/http.rs`). The Rust broker only allows origins that are configured in settings and pins DNS. The webview itself cannot reach the network (CSP `connect-src ipc:`).
- Timer operations: `services/timerService.ts` (`switchTask` = stop what exceeds the limit, then start), `hooks/useStartTask.ts`, `hooks/usePauseTimer.ts` (pause = stop in Kimai and remember locally in `pausedTimers`; resume = start a new entry). All of them share `hooks/timerOperationLock.ts`.
- Time format: Kimai ignores time zones on write. Always send local wall-clock via `utils/time.ts` `toKimaiLocal`, and parse with `parseKimaiDate`.
- Settings: `settings/service.ts` (`mergeSettings` whitelists and normalizes every key), persisted through the Rust command `patch_settings` (`src-tauri/src/store.rs`), which validates keys against `contracts/ipc-contract.json`.
- Global shortcuts: `src-tauri/src/shortcuts.rs` registers the upstream set and emits `kimai://…` events to the tray window; `tray/useTraySystemEvents.ts` listens.
- i18n: `src/shared/i18n/locales/*.json`, six languages.

### Adversum additions

Documented per feature in `src/adversum/README.md`, including every hook into upstream files. In short:

- `src/adversum/updater.ts`: updater kill switch.
- Fork settings: own store file `adversum.json` through `adversum_get_settings` / `adversum_patch_settings` (`src-tauri/src/adversum/settings.rs`), read in React with `useAdversumSettings()`.
- `src/adversum/AdversumBridge.tsx` (mounted in `main.tsx` next to the window component) fills the module-level display store (`display/displayStore.ts`). Upstream components read it through hooks such as `useCustomerIndicator` and `useTaskLabel`. The store is empty in upstream's tests, so upstream tests run unchanged.
- Customer logos: fetched, validated, converted and cached in `src-tauri/src/adversum/logos.rs`, shown by `src/adversum/logos/CustomerAvatar.tsx`, managed in the settings page `src/adversum/settings/CustomerLogosSection.tsx`.
- Quick entry: pure parser and ranking in `src/adversum/quickEntry/` (`parse.ts` and friends), one bar component for the floating window (`QuickEntryWindow.tsx`, window label `adversum-quick`) and the popup's search field. Quick actions are always executed in the tray window by `useQuickExecutor`, which reuses upstream's timer operations; other windows send `adversum://quick-execute` events to it. The native window and the fork's global shortcuts live in `src-tauri/src/adversum/quick.rs`, `quick_panel.rs` and `shortcuts.rs`.
- Voice input: recording (cpal), transcription (whisper.cpp through whisper-rs, German, local) and speech models in `src-tauri/src/adversum/voice/`; reading the sentence in `src/adversum/voice/spoken.ts`, which feeds the quick entry parser's spoken mode; overlay and confirmation card in `src/adversum/voice/VoiceStage.tsx`, shown by the quick entry window. Actions run through the same executor.
- Task switching: "previous task" shortcut, "start in between" with automatic resume, and one-click suggestions on the no-timer reminder, all built on the same executor.

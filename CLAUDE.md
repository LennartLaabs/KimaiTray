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

## Environment on Lennart's Mac

The repo lives in an APFS disk image, because the SSD itself is exFAT (no symlinks, so `npm install` fails there).

- Image: `/Volumes/Adversum /Dev.sparsebundle` (note the trailing space in the volume name), mounted at `/Volumes/AdversumDev`.
- Auto-mount: LaunchAgent `~/Library/LaunchAgents/io.adversum.mount-dev.plist` runs `~/Library/Application Support/Adversum/mount-dev-image.sh` at login and whenever a volume is mounted. Log: `~/Library/Logs/adversum-mount-dev.log`. Manual mount: double-click `Dev.sparsebundle` in Finder.
- `node_modules`, `src-tauri/target`, the cargo registry and the npm cache are all inside the image. Only the Rust toolchain (`~/.rustup`, about 560 MB) is on the internal disk.

### Node 24 for this project

The system default Node is a different major version and does not satisfy `engines`. Node 24 LTS is installed keg-only through Homebrew (`/opt/homebrew/opt/node@24`), so it is not on `PATH` by default.

**Always run npm, node and cargo through `scripts/adversum/env.sh`.** It prepends Node 24 and `~/.cargo/bin` to `PATH` and, when the image is mounted, points `CARGO_HOME` and the npm cache into `/Volumes/AdversumDev/.cache`.

```sh
./scripts/adversum/env.sh npm run tauri dev     # run one command
. ./scripts/adversum/env.sh                     # or source it once per shell
```

`.node-version` (22) is upstream's file for CI and is left untouched.

## Commands

All through `./scripts/adversum/env.sh …` (or after sourcing it):

| Purpose | Command |
|---|---|
| Install dependencies | `npm ci` |
| Run the app in dev mode | `npm run tauri dev` |
| Full frontend gate (version, i18n, lint, tests + coverage, build) | `npm run check` |
| Tests only | `npm test` / `npx vitest run src/adversum` |
| i18n key parity | `npm run i18n:check` |
| Copy new `adversum.*` keys from `en` to sk/cs/uk/es | `node scripts/adversum/i18n-sync.mjs` |
| Rust format / lint / tests (in `src-tauri/`) | `cargo fmt --all -- --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` |
| Release build (.app and .dmg) | `npm run tauri build` |

Build output: `src-tauri/target/release/bundle/dmg/` and `…/bundle/macos/`.

### Things that bite

- **Coverage thresholds are 100 % statements/lines/functions and 90 % branches** (`vitest.config.ts`). Every new TypeScript line needs a test. Upstream wraps code that can only run from native menus in `/* v8 ignore start */ … /* v8 ignore stop */`; use that sparingly and only for the same reason.
- `npm run i18n:check` compares all six locales against `en.json`, including `{{placeholders}}`. We translate `en` and `de` by hand; the other four get the English text through `i18n-sync.mjs`.
- `npm run version:check` requires identical versions in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- ESLint runs with `--max-warnings=0`.
- The original KimaiTray may be installed and running on this Mac. Both apps register the `kimaitray://` deep-link scheme; do not test deep links while both are installed.

## Merging upstream

```sh
git fetch upstream
git merge upstream/main
```

Conflicts should only appear at `ADVERSUM:` hooks, in `tauri.conf.json` (identifier, product name, updater block) and in the locale files (our keys sit in the top-level `adversum` object at the end of each file). After merging: `npm ci`, `npm run check`, the three cargo commands, then a short `npm run tauri dev` smoke test.

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

Documented per feature in `src/adversum/README.md`. In short:

- `src/adversum/updater.ts`: updater kill switch.
- Further modules are added per feature (customer logos, quick entry, task switching); each one is listed in `src/adversum/README.md` together with its hooks into upstream files.

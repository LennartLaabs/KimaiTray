//! Adversum fork additions. Upstream modules only reach in here through
//! hooks marked `ADVERSUM:`; see the repository CLAUDE.md.
pub(crate) mod logos;
pub(crate) mod quick;
#[cfg(target_os = "macos")]
mod quick_panel;
pub(crate) mod settings;
pub(crate) mod shortcuts;

/// Startup work of the fork, called once from `lib.rs` after upstream's setup.
pub(crate) fn setup(app: &tauri::AppHandle) {
    // The fork's shortcuts, also when upstream has none configured.
    shortcuts::register(app);
    // Dev builds can open the quick entry bar at launch, to check the native
    // window without pressing a global shortcut:
    // `ADVERSUM_SHOW_QUICK=1 npm run tauri dev`
    #[cfg(debug_assertions)]
    if std::env::var_os("ADVERSUM_SHOW_QUICK").is_some() {
        quick::show(app);
    }
}

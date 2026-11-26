//! Adversum fork additions. Upstream modules only reach in here through
//! hooks marked `ADVERSUM:`; see the repository CLAUDE.md.
pub(crate) mod logos;
pub(crate) mod quick;
#[cfg(target_os = "macos")]
mod quick_panel;
pub(crate) mod settings;
pub(crate) mod shortcuts;
pub(crate) mod voice;

/// Startup work of the fork, called once from `lib.rs` after upstream's setup.
pub(crate) fn setup(app: &tauri::AppHandle) {
    // The fork's shortcuts, also when upstream has none configured.
    shortcuts::register(app);
    // Dev builds can open the quick entry window at launch, to check its
    // native placement without pressing a global shortcut:
    // `ADVERSUM_SHOW_QUICK=1 npm run tauri dev` (the bar) or
    // `ADVERSUM_SHOW_QUICK=toast npm run tauri dev` (the confirmation toast).
    #[cfg(debug_assertions)]
    match std::env::var("ADVERSUM_SHOW_QUICK").as_deref() {
        Ok("toast") => quick::adversum_quick_toast(app.clone(), false),
        Ok(_) => {
            quick::show(app);
            // A second size shows in the log that the top edge stays put.
            let _ = quick::adversum_quick_resize(app.clone(), 420.0);
        }
        Err(_) => {}
    }
}

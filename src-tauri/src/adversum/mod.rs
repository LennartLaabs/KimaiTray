//! Adversum fork additions. Upstream modules only reach in here through
//! hooks marked `ADVERSUM:`; see the repository CLAUDE.md.
pub(crate) mod brain;
pub(crate) mod keystore;
pub(crate) mod logos;
pub(crate) mod multi;
pub(crate) mod quick;
#[cfg(target_os = "macos")]
mod quick_panel;
pub(crate) mod settings;
pub(crate) mod shortcuts;
pub(crate) mod voice;

/// Startup work of the fork, called once from `lib.rs` after upstream's setup.
/// Where the app is installed on macOS.
const INSTALLED_APP: &str = "/Applications/KimaiTray Adversum.app";

/// Whether an executable at `executable` should hand over to the installed
/// app: it is a copy somewhere else, and the installed app exists.
fn is_stray_copy(executable: &std::path::Path, installed_exists: bool) -> bool {
    installed_exists && !executable.starts_with(INSTALLED_APP)
}

/// A release build that is started from anywhere but `/Applications` while
/// the app is installed there opens the installed one and ends. Build
/// folders keep older copies with the same name, and Spotlight offers them
/// like the real one; running one meant old code on the real data (the
/// speech problems of 2026-11-26 came from that). Debug builds and
/// `ADVERSUM_ALLOW_ANYWHERE=1` are left alone.
pub(crate) fn defer_to_installed_copy() -> bool {
    if !cfg!(all(target_os = "macos", not(debug_assertions)))
        || std::env::var_os("ADVERSUM_ALLOW_ANYWHERE").is_some()
    {
        return false;
    }
    let Ok(executable) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return false;
    };
    if !is_stray_copy(&executable, std::path::Path::new(INSTALLED_APP).is_dir()) {
        return false;
    }
    eprintln!("Not the installed app; opening {INSTALLED_APP} instead.");
    let _ = std::process::Command::new("/usr/bin/open")
        .arg(INSTALLED_APP)
        .status();
    true
}

pub(crate) fn setup(app: &tauri::AppHandle) {
    // Which fork build this is; `install.sh` passes the commit it built.
    log::info!(
        "Adversum build {}",
        option_env!("ADVERSUM_BUILD").unwrap_or("dev")
    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn only_a_copy_outside_applications_hands_over_and_only_to_an_installed_app() {
        let installed = Path::new("/Applications/KimaiTray Adversum.app/Contents/MacOS/kimaitray");
        let built = Path::new(
            "/Volumes/AdversumDev/KimaiTray/src-tauri/target/universal-apple-darwin/release/bundle/macos/KimaiTray Adversum.app/Contents/MacOS/kimaitray",
        );
        assert!(!is_stray_copy(installed, true));
        assert!(is_stray_copy(built, true));
        // Nothing installed: the copy is all there is (first start from the disk image).
        assert!(!is_stray_copy(built, false));
        // Tests are no release build of the app.
        assert!(!defer_to_installed_copy());
    }
}

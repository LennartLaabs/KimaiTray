//! The fork's global shortcuts: toggle the quick entry bar and switch back to
//! the previous task. They are configured in the fork settings and registered
//! next to upstream's shortcuts (`crate::shortcuts`).

use std::str::FromStr;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub(crate) const QUICK_ENTRY_KEY: &str = "shortcutQuickEntry";
pub(crate) const PREVIOUS_TASK_KEY: &str = "shortcutPreviousTask";
const DEFAULT_QUICK_ENTRY: &str = "Control+Alt+Space";
const DEFAULT_PREVIOUS_TASK: &str = "Control+Alt+Z";
const PREVIOUS_TASK_EVENT: &str = "adversum://previous-task";

/// Shortcuts this module currently holds, so they can be released again.
static REGISTERED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The configured accelerators as (quick entry, previous task). A missing key
/// means the default; an empty string switches the shortcut off.
pub(crate) fn configured(settings: &Map<String, Value>) -> (String, String) {
    let value = |key: &str, default: &str| match settings.get(key) {
        Some(Value::String(accelerator)) => accelerator.trim().to_string(),
        _ => default.to_string(),
    };
    (
        value(QUICK_ENTRY_KEY, DEFAULT_QUICK_ENTRY),
        value(PREVIOUS_TASK_KEY, DEFAULT_PREVIOUS_TASK),
    )
}

pub(crate) fn validate(quick_entry: &str, previous_task: &str) -> Result<(), String> {
    let mut ids = Vec::new();
    for accelerator in [quick_entry, previous_task] {
        if accelerator.is_empty() {
            continue;
        }
        let shortcut = Shortcut::from_str(accelerator)
            .map_err(|error| format!("Invalid shortcut {accelerator}: {error}"))?;
        if ids.contains(&shortcut.id()) {
            return Err(format!("Duplicate shortcut: {accelerator}"));
        }
        ids.push(shortcut.id());
    }
    Ok(())
}

/// Registers the given accelerators, replacing whatever this module held.
pub(crate) fn register_with(
    app: &AppHandle,
    quick_entry: &str,
    previous_task: &str,
) -> Result<(), String> {
    validate(quick_entry, previous_task)?;
    if !crate::platform::supports_global_shortcuts() {
        return Ok(());
    }
    let shortcuts = app.global_shortcut();
    let mut registered = REGISTERED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for accelerator in registered.drain(..) {
        // Already gone when upstream re-registered everything.
        let _ = shortcuts.unregister(accelerator.as_str());
    }

    if !quick_entry.is_empty() {
        let handle = app.clone();
        shortcuts
            .on_shortcut(quick_entry, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    super::quick::toggle(&handle);
                }
            })
            .map_err(|error| format!("Quick entry shortcut: {error}"))?;
        registered.push(quick_entry.to_string());
    }

    if !previous_task.is_empty() {
        let handle = app.clone();
        shortcuts
            .on_shortcut(previous_task, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(popup) = handle.get_webview_window("tray-popup") {
                        let _ = popup.emit(PREVIOUS_TASK_EVENT, ());
                    }
                }
            })
            .map_err(|error| format!("Previous task shortcut: {error}"))?;
        registered.push(previous_task.to_string());
    }
    log::info!("Registered Adversum shortcuts: {}", registered.join(", "));
    Ok(())
}

/// Registers the shortcuts from the stored fork settings. Called at startup
/// and whenever upstream has re-registered its own set, which releases ours.
pub(crate) fn register(app: &AppHandle) {
    let (quick_entry, previous_task) = configured(&super::settings::read(app));
    if let Err(error) = register_with(app, &quick_entry, &previous_task) {
        log::error!("Failed to register Adversum shortcuts: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{configured, validate, DEFAULT_PREVIOUS_TASK, DEFAULT_QUICK_ENTRY};
    use serde_json::json;

    #[test]
    fn missing_settings_mean_the_default_shortcuts() {
        let settings = json!({}).as_object().cloned().unwrap();
        assert_eq!(
            configured(&settings),
            (
                DEFAULT_QUICK_ENTRY.to_string(),
                DEFAULT_PREVIOUS_TASK.to_string()
            )
        );
        assert!(validate(DEFAULT_QUICK_ENTRY, DEFAULT_PREVIOUS_TASK).is_ok());
    }

    #[test]
    fn stored_values_win_and_an_empty_string_disables() {
        let settings = json!({"shortcutQuickEntry": " Alt+Space ", "shortcutPreviousTask": ""})
            .as_object()
            .cloned()
            .unwrap();
        assert_eq!(configured(&settings), ("Alt+Space".into(), String::new()));
        assert!(validate("Alt+Space", "").is_ok());
        assert!(validate("", "").is_ok());
    }

    #[test]
    fn invalid_and_duplicate_shortcuts_are_rejected() {
        assert!(validate("not-a-shortcut", "").is_err());
        assert!(validate("Control+Alt+Z", "Control+Alt+Z").is_err());
    }
}

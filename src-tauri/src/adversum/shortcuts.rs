//! The fork's global shortcuts: toggle the quick entry bar, switch back to
//! the previous task, and hold to speak. They are configured in the fork
//! settings and registered next to upstream's shortcuts (`crate::shortcuts`).

use std::str::FromStr;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub(crate) const QUICK_ENTRY_KEY: &str = "shortcutQuickEntry";
pub(crate) const PREVIOUS_TASK_KEY: &str = "shortcutPreviousTask";
pub(crate) const VOICE_KEY: &str = "shortcutVoice";
const DEFAULT_QUICK_ENTRY: &str = "Control+Alt+Space";
const DEFAULT_PREVIOUS_TASK: &str = "Control+Alt+Z";
const DEFAULT_VOICE: &str = "Control+Alt+V";
const PREVIOUS_TASK_EVENT: &str = "adversum://previous-task";

/// Shortcuts this module currently holds, so they can be released again.
static REGISTERED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The fork's accelerators; an empty string means "no shortcut".
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Shortcuts {
    pub(crate) quick_entry: String,
    pub(crate) previous_task: String,
    pub(crate) voice: String,
}

impl Shortcuts {
    fn all(&self) -> [&str; 3] {
        [&self.quick_entry, &self.previous_task, &self.voice]
    }
}

/// The configured accelerators. A missing key means the default; an empty
/// string switches the shortcut off. The voice shortcut only exists while
/// voice input is enabled.
pub(crate) fn configured(settings: &Map<String, Value>) -> Shortcuts {
    let value = |key: &str, default: &str| match settings.get(key) {
        Some(Value::String(accelerator)) => accelerator.trim().to_string(),
        _ => default.to_string(),
    };
    Shortcuts {
        quick_entry: value(QUICK_ENTRY_KEY, DEFAULT_QUICK_ENTRY),
        previous_task: value(PREVIOUS_TASK_KEY, DEFAULT_PREVIOUS_TASK),
        voice: if super::voice::enabled(settings) {
            value(VOICE_KEY, DEFAULT_VOICE)
        } else {
            String::new()
        },
    }
}

pub(crate) fn validate(shortcuts: &Shortcuts) -> Result<(), String> {
    let mut ids = Vec::new();
    for accelerator in shortcuts.all() {
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
pub(crate) fn register_with(app: &AppHandle, wanted: &Shortcuts) -> Result<(), String> {
    validate(wanted)?;
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

    if !wanted.quick_entry.is_empty() {
        let handle = app.clone();
        shortcuts
            .on_shortcut(
                wanted.quick_entry.as_str(),
                move |_app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        super::quick::toggle(&handle);
                    }
                },
            )
            .map_err(|error| format!("Quick entry shortcut: {error}"))?;
        registered.push(wanted.quick_entry.clone());
    }

    if !wanted.previous_task.is_empty() {
        let handle = app.clone();
        shortcuts
            .on_shortcut(
                wanted.previous_task.as_str(),
                move |_app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(popup) = handle.get_webview_window("tray-popup") {
                            let _ = popup.emit(PREVIOUS_TASK_EVENT, ());
                        }
                    }
                },
            )
            .map_err(|error| format!("Previous task shortcut: {error}"))?;
        registered.push(wanted.previous_task.clone());
    }

    if !wanted.voice.is_empty() {
        let handle = app.clone();
        shortcuts
            .on_shortcut(wanted.voice.as_str(), move |_app, _shortcut, event| {
                // Held down means recording, so both edges matter.
                match event.state {
                    ShortcutState::Pressed => super::voice::shortcut_pressed(&handle),
                    ShortcutState::Released => super::voice::shortcut_released(&handle),
                }
            })
            .map_err(|error| format!("Voice shortcut: {error}"))?;
        registered.push(wanted.voice.clone());
    }
    log::info!("Registered Adversum shortcuts: {}", registered.join(", "));
    Ok(())
}

/// Registers the shortcuts from the stored fork settings. Called at startup
/// and whenever upstream has re-registered its own set, which releases ours.
pub(crate) fn register(app: &AppHandle) {
    let shortcuts = configured(&super::settings::read(app));
    if let Err(error) = register_with(app, &shortcuts) {
        log::error!("Failed to register Adversum shortcuts: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        configured, validate, Shortcuts, DEFAULT_PREVIOUS_TASK, DEFAULT_QUICK_ENTRY, DEFAULT_VOICE,
    };
    use serde_json::{json, Map, Value};

    fn settings(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn shortcuts(quick_entry: &str, previous_task: &str, voice: &str) -> Shortcuts {
        Shortcuts {
            quick_entry: quick_entry.into(),
            previous_task: previous_task.into(),
            voice: voice.into(),
        }
    }

    #[test]
    fn missing_settings_mean_the_default_shortcuts_without_voice() {
        let defaults = configured(&settings(json!({})));
        assert_eq!(
            defaults,
            shortcuts(DEFAULT_QUICK_ENTRY, DEFAULT_PREVIOUS_TASK, "")
        );
        assert!(validate(&defaults).is_ok());
    }

    #[test]
    fn stored_values_win_and_an_empty_string_disables() {
        let stored = configured(&settings(
            json!({"shortcutQuickEntry": " Alt+Space ", "shortcutPreviousTask": ""}),
        ));
        assert_eq!(stored, shortcuts("Alt+Space", "", ""));
        assert!(validate(&stored).is_ok());
        assert!(validate(&shortcuts("", "", "")).is_ok());
    }

    #[test]
    fn the_voice_shortcut_exists_while_voice_input_is_enabled() {
        let enabled = configured(&settings(json!({"voiceEnabled": true})));
        assert_eq!(enabled.voice, DEFAULT_VOICE);
        assert!(validate(&enabled).is_ok());
        let custom = configured(&settings(
            json!({"voiceEnabled": true, "shortcutVoice": "Alt+F5"}),
        ));
        assert_eq!(custom.voice, "Alt+F5");
        let off = configured(&settings(
            json!({"voiceEnabled": false, "shortcutVoice": "Alt+F5"}),
        ));
        assert_eq!(off.voice, "");
    }

    #[test]
    fn invalid_and_duplicate_shortcuts_are_rejected() {
        assert!(validate(&shortcuts("not-a-shortcut", "", "")).is_err());
        assert!(validate(&shortcuts("Control+Alt+Z", "Control+Alt+Z", "")).is_err());
        assert!(validate(&shortcuts("Control+Alt+Z", "", "Control+Alt+Z")).is_err());
    }
}

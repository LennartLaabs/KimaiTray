//! Fork-only settings.
//!
//! Upstream validates every key of its `settings` object against
//! `contracts/ipc-contract.json`, so fork settings live in their own store
//! file instead of extending that contract.

use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, WebviewWindow};
use tauri_plugin_store::StoreExt;

use crate::store_persistence::persist_store_value;

const STORE_PATH: &str = "adversum.json";
const SETTINGS_KEY: &str = "settings";
const MAX_SETTINGS_BYTES: usize = 512 * 1024;
const CHANGED_EVENT: &str = "adversum://settings-changed";
const SETTINGS_KEYS: [&str; 5] = [
    "customerIndicator",
    "logoDevToken",
    "shortcutQuickEntry",
    "shortcutPreviousTask",
    "aliases",
];
const WRITER_WINDOWS: [&str; 1] = ["settings"];
static MUTATION: Mutex<()> = Mutex::new(());

pub(crate) fn read(app: &AppHandle) -> Map<String, Value> {
    app.store(STORE_PATH)
        .ok()
        .and_then(|store| store.get(SETTINGS_KEY))
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn apply_patch(
    settings: &mut Map<String, Value>,
    values: Map<String, Value>,
) -> Result<(), String> {
    if values.is_empty() {
        return Err("Adversum settings patch is empty".into());
    }
    if values
        .keys()
        .any(|key| !SETTINGS_KEYS.contains(&key.as_str()))
    {
        return Err("Unknown Adversum settings key".into());
    }
    settings.extend(values);
    let size = serde_json::to_vec(settings)
        .map_err(|_| "Invalid Adversum settings".to_string())?
        .len();
    if size > MAX_SETTINGS_BYTES {
        return Err("Adversum settings are too large".into());
    }
    Ok(())
}

#[tauri::command]
pub fn adversum_get_settings(app: AppHandle) -> Value {
    Value::Object(read(&app))
}

#[tauri::command]
pub fn adversum_patch_settings(
    app: AppHandle,
    window: WebviewWindow,
    values: Map<String, Value>,
) -> Result<Value, String> {
    if !WRITER_WINDOWS.contains(&window.label()) {
        return Err("Window is not authorized to change Adversum settings".into());
    }
    let _transaction = MUTATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let store = app.store(STORE_PATH).map_err(|error| error.to_string())?;
    let mut settings = match store.get(SETTINGS_KEY) {
        Some(Value::Object(settings)) => settings,
        _ => Map::new(),
    };
    let previous_shortcuts = super::shortcuts::configured(&settings);
    apply_patch(&mut settings, values)?;
    let shortcuts = super::shortcuts::configured(&settings);
    if shortcuts != previous_shortcuts {
        // Register first: a shortcut the system refuses must not be saved.
        if let Err(error) = super::shortcuts::register_with(&app, &shortcuts.0, &shortcuts.1) {
            let (quick_entry, previous_task) = previous_shortcuts;
            let _ = super::shortcuts::register_with(&app, &quick_entry, &previous_task);
            return Err(error);
        }
    }
    let value = Value::Object(settings);
    persist_store_value(store.as_ref(), SETTINGS_KEY, Some(value.clone()))?;
    // Persistence is authoritative; a failed broadcast must not fail the save.
    let _ = app.emit(CHANGED_EVENT, value.clone());
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{apply_patch, MAX_SETTINGS_BYTES};
    use serde_json::{json, Map, Value};

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn merges_known_keys_and_keeps_the_rest() {
        let mut settings = object(json!({"customerIndicator": "logo", "logoDevToken": "pk_a"}));
        apply_patch(&mut settings, object(json!({"customerIndicator": "dots"}))).unwrap();
        assert_eq!(settings["customerIndicator"], "dots");
        assert_eq!(settings["logoDevToken"], "pk_a");
    }

    #[test]
    fn rejects_empty_unknown_and_oversized_patches() {
        let mut settings = Map::new();
        assert!(apply_patch(&mut settings, Map::new()).is_err());
        assert!(apply_patch(&mut settings, object(json!({"theme": "dark"}))).is_err());
        let huge = "x".repeat(MAX_SETTINGS_BYTES);
        assert!(apply_patch(&mut settings, object(json!({"logoDevToken": huge}))).is_err());
    }
}

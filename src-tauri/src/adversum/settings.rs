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
const SETTINGS_KEYS: [&str; 13] = [
    "customerIndicator",
    "logoDevToken",
    "shortcutQuickEntry",
    "shortcutPreviousTask",
    "aliases",
    "voiceEnabled",
    "voiceModel",
    "voiceModelDir",
    "voiceTapMode",
    "shortcutVoice",
    "voiceInputDevice",
    "voiceDebug",
    "multiModel",
];
const WRITER_WINDOWS: [&str; 1] = ["settings"];
/// Windows that confirm quick actions may add aliases they learned, and
/// nothing else.
const LEARNER_WINDOWS: [&str; 2] = ["adversum-quick", "tray-popup"];
const ALIASES_KEY: &str = "aliases";
const ALIAS_KINDS: [&str; 3] = ["customers", "projects", "activities"];
const MAX_ALIASES_PER_ENTITY: usize = 20;
const MAX_ALIAS_CHARS: usize = 64;
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
    validate_voice(&values)?;
    settings.extend(values);
    let size = serde_json::to_vec(settings)
        .map_err(|_| "Invalid Adversum settings".to_string())?
        .len();
    if size > MAX_SETTINGS_BYTES {
        return Err("Adversum settings are too large".into());
    }
    Ok(())
}

/// Checks the voice settings of a patch; other keys are normalized by the
/// frontend when it reads them.
fn validate_voice(values: &Map<String, Value>) -> Result<(), String> {
    use super::voice::{models, ENABLED_KEY, TAP_MODE_KEY};
    for key in [ENABLED_KEY, TAP_MODE_KEY, "voiceDebug"] {
        if values.get(key).is_some_and(|value| !value.is_boolean()) {
            return Err("Invalid voice setting".into());
        }
    }
    if let Some(model) = values.get(models::MODEL_KEY) {
        if model.as_str().and_then(models::spec).is_none() {
            return Err("Unknown speech model".into());
        }
    }
    if let Some(mode) = values.get(super::multi::MODE_KEY) {
        if !mode.as_str().is_some_and(super::multi::valid_mode) {
            return Err("Invalid language model setting".into());
        }
    }
    if let Some(device) = values.get("voiceInputDevice") {
        if device.as_str().is_none_or(|id| id.len() > 512) {
            return Err("Invalid microphone".into());
        }
    }
    if let Some(dir) = values.get(models::MODEL_DIR_KEY) {
        models::validate_dir(dir.as_str().ok_or("Invalid model folder")?)?;
    }
    Ok(())
}

/// Adds one alias word for an entity. Returns whether it is new.
fn add_alias(
    settings: &mut Map<String, Value>,
    connection_id: &str,
    kind: &str,
    entity_id: u64,
    alias: &str,
) -> Result<bool, String> {
    let alias = alias.trim();
    if connection_id.is_empty()
        || connection_id.len() > 256
        || !ALIAS_KINDS.contains(&kind)
        || entity_id == 0
        || alias.is_empty()
        || alias.chars().count() > MAX_ALIAS_CHARS
    {
        return Err("Invalid alias".into());
    }
    fn object(value: &mut Value) -> &mut Map<String, Value> {
        if !value.is_object() {
            *value = Value::Object(Map::new());
        }
        value
            .as_object_mut()
            .expect("value was just made an object")
    }
    let connections = object(settings.entry(ALIASES_KEY).or_insert(Value::Null));
    let kinds = object(connections.entry(connection_id).or_insert(Value::Null));
    let entities = object(kinds.entry(kind).or_insert(Value::Null));
    let list = entities
        .entry(entity_id.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !list.is_array() {
        *list = Value::Array(Vec::new());
    }
    let list = list.as_array_mut().expect("value was just made an array");
    let known = list
        .iter()
        .filter_map(Value::as_str)
        .any(|existing| existing.to_lowercase() == alias.to_lowercase());
    if known || list.len() >= MAX_ALIASES_PER_ENTITY {
        return Ok(false);
    }
    list.push(Value::String(alias.to_string()));
    let size = serde_json::to_vec(settings)
        .map_err(|_| "Invalid Adversum settings".to_string())?
        .len();
    if size > MAX_SETTINGS_BYTES {
        return Err("Adversum settings are too large".into());
    }
    Ok(true)
}

/// Stores an alias that voice input learned from a correction: the spoken
/// word that should have named this customer, project or activity.
/// Sets one setting from the native side and tells every window.
pub(crate) fn store_value(app: &AppHandle, key: &str, value: Value) -> Result<(), String> {
    let _transaction = MUTATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let store = app.store(STORE_PATH).map_err(|error| error.to_string())?;
    let mut settings = match store.get(SETTINGS_KEY) {
        Some(Value::Object(settings)) => settings,
        _ => Map::new(),
    };
    settings.insert(key.to_string(), value);
    let value = Value::Object(settings);
    persist_store_value(store.as_ref(), SETTINGS_KEY, Some(value.clone()))?;
    let _ = app.emit(CHANGED_EVENT, value);
    Ok(())
}

#[tauri::command]
pub fn adversum_learn_alias(
    app: AppHandle,
    window: WebviewWindow,
    connection_id: String,
    kind: String,
    entity_id: u64,
    alias: String,
) -> Result<bool, String> {
    if !LEARNER_WINDOWS.contains(&window.label()) {
        return Err("Window is not authorized to learn aliases".into());
    }
    let _transaction = MUTATION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let store = app.store(STORE_PATH).map_err(|error| error.to_string())?;
    let mut settings = match store.get(SETTINGS_KEY) {
        Some(Value::Object(settings)) => settings,
        _ => Map::new(),
    };
    if !add_alias(&mut settings, &connection_id, &kind, entity_id, &alias)? {
        return Ok(false);
    }
    let value = Value::Object(settings);
    persist_store_value(store.as_ref(), SETTINGS_KEY, Some(value.clone()))?;
    let _ = app.emit(CHANGED_EVENT, value);
    Ok(true)
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
        if let Err(error) = super::shortcuts::register_with(&app, &shortcuts) {
            let _ = super::shortcuts::register_with(&app, &previous_shortcuts);
            return Err(error);
        }
    }
    if !super::voice::enabled(&settings) {
        // Switched off (or never on): no recording may keep running.
        super::voice::cancel();
    }
    let value = Value::Object(settings);
    persist_store_value(store.as_ref(), SETTINGS_KEY, Some(value.clone()))?;
    // Persistence is authoritative; a failed broadcast must not fail the save.
    let _ = app.emit(CHANGED_EVENT, value.clone());
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{add_alias, apply_patch, MAX_ALIASES_PER_ENTITY, MAX_SETTINGS_BYTES};
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

    #[test]
    fn voice_settings_are_checked() {
        let mut settings = Map::new();
        let ok = json!({"voiceEnabled": true, "voiceModel": "base", "voiceModelDir": "",
            "voiceTapMode": false, "shortcutVoice": "Control+Alt+V",
            "voiceInputDevice": "coreaudio:abc", "voiceDebug": true, "multiModel": "device"});
        apply_patch(&mut settings, object(ok)).unwrap();
        assert_eq!(settings["voiceModel"], "base");
        for bad in [
            json!({"voiceEnabled": "yes"}),
            json!({"voiceTapMode": 1}),
            json!({"voiceModel": "tiny"}),
            json!({"voiceModel": 3}),
            json!({"voiceModelDir": "relative"}),
            json!({"voiceModelDir": 7}),
            json!({"voiceDebug": "on"}),
            json!({"voiceInputDevice": 3}),
            json!({"voiceInputDevice": "x".repeat(513)}),
            json!({"multiModel": "cloud"}),
            json!({"multiModel": true}),
        ] {
            assert!(apply_patch(&mut settings, object(bad)).is_err());
        }
        assert_eq!(settings["voiceModel"], "base");
    }

    #[test]
    fn learned_aliases_are_added_once() {
        let mut settings = object(json!({"aliases": {"c1": {"customers": {"7": ["dusw"]}}}}));
        assert!(add_alias(&mut settings, "c1", "customers", 7, " Solartec ").unwrap());
        assert!(!add_alias(&mut settings, "c1", "customers", 7, "SOLARTEC").unwrap());
        assert!(!add_alias(&mut settings, "c1", "customers", 7, "DUSW").unwrap());
        assert_eq!(
            settings["aliases"]["c1"]["customers"]["7"],
            json!(["dusw", "Solartec"])
        );
        // Missing levels are created, also over values of the wrong type.
        let mut empty = object(json!({"aliases": "broken"}));
        assert!(add_alias(&mut empty, "c2", "activities", 3, "pm").unwrap());
        assert_eq!(empty["aliases"]["c2"]["activities"]["3"], json!(["pm"]));
        let mut wrong_list = object(json!({"aliases": {"c1": {"projects": {"4": "x"}}}}));
        assert!(add_alias(&mut wrong_list, "c1", "projects", 4, "web").unwrap());
        assert_eq!(wrong_list["aliases"]["c1"]["projects"]["4"], json!(["web"]));
    }

    #[test]
    fn invalid_or_surplus_aliases_are_refused() {
        let mut settings = Map::new();
        assert!(add_alias(&mut settings, "", "customers", 1, "a").is_err());
        assert!(add_alias(&mut settings, "c1", "users", 1, "a").is_err());
        assert!(add_alias(&mut settings, "c1", "customers", 0, "a").is_err());
        assert!(add_alias(&mut settings, "c1", "customers", 1, "  ").is_err());
        assert!(add_alias(&mut settings, "c1", "customers", 1, &"x".repeat(65)).is_err());
        assert!(add_alias(&mut settings, &"c".repeat(257), "customers", 1, "a").is_err());
        for index in 0..MAX_ALIASES_PER_ENTITY {
            assert!(add_alias(&mut settings, "c1", "customers", 1, &format!("a{index}")).unwrap());
        }
        assert!(!add_alias(&mut settings, "c1", "customers", 1, "one-more").unwrap());
        let mut full = object(json!({"logoDevToken": "x".repeat(MAX_SETTINGS_BYTES - 40)}));
        assert!(add_alias(&mut full, "c1", "customers", 1, "alias").is_err());
    }
}

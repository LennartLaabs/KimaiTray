//! Voice input: hold a key, say what you are working on, release.
//!
//! Everything happens on this machine. The microphone is recorded with cpal,
//! transcribed with whisper.cpp (`transcribe.rs`) and the text goes to the
//! quick entry window, whose parser turns it into a timer. No audio or text
//! leaves the computer; the only network access is the one-time download of
//! a speech model (`models.rs`).
//!
//! macOS only for now. On other platforms the commands exist, report
//! "unsupported" and do nothing.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

mod audio;
pub(crate) mod models;
#[cfg(target_os = "macos")]
mod permission;
#[cfg(target_os = "macos")]
mod recorder;
#[cfg(target_os = "macos")]
mod session;
#[cfg(target_os = "macos")]
mod transcribe;

use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, WebviewWindow};

pub(crate) const ENABLED_KEY: &str = "voiceEnabled";
pub(crate) const TAP_MODE_KEY: &str = "voiceTapMode";
/// Whisper uses at most 224 prompt tokens; more text than this is cut off.
const MAX_VOCABULARY_CHARS: usize = 1_000;

/// Names the speech model should expect, set by the tray window.
static VOCABULARY: Mutex<String> = Mutex::new(String::new());

pub(crate) fn enabled(settings: &Map<String, Value>) -> bool {
    settings.get(ENABLED_KEY).and_then(Value::as_bool) == Some(true)
}

pub(crate) fn tap_mode(settings: &Map<String, Value>) -> bool {
    settings.get(TAP_MODE_KEY).and_then(Value::as_bool) == Some(true)
}

fn vocabulary() -> String {
    VOCABULARY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Keeps the end of an overlong vocabulary, on a word boundary: Whisper
/// itself only looks at the last part of its prompt.
pub(crate) fn clamp_vocabulary(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let count = text.chars().count();
    if count <= MAX_VOCABULARY_CHARS {
        return text;
    }
    let tail: String = text.chars().skip(count - MAX_VOCABULARY_CHARS).collect();
    match tail.split_once(' ') {
        Some((_, rest)) => rest.to_string(),
        None => tail,
    }
}

fn require_window(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label {
        Ok(())
    } else {
        Err("Window is not authorized for this voice command".into())
    }
}

/// The key was pressed: starts a recording, or ends it in tap mode.
pub(crate) fn shortcut_pressed(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if !tap_mode(&super::settings::read(app)) {
            session::begin(app, false);
        } else if session::is_recording() {
            session::finish(app);
        } else {
            session::begin(app, true);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The key was released: ends the recording, unless tapping does that.
pub(crate) fn shortcut_released(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if !tap_mode(&super::settings::read(app)) {
        session::finish(app);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Drops a running recording or transcription without a result.
pub(crate) fn cancel() {
    #[cfg(target_os = "macos")]
    session::cancel();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// Voice input exists on this platform.
    supported: bool,
    /// "granted", "denied" or "undetermined".
    permission: &'static str,
    /// Text appears while speaking (needs the GPU).
    live_text: bool,
    models: Vec<models::ModelStatus>,
    model_dir: String,
    default_model_dir: String,
    download: Option<models::DownloadProgress>,
}

#[tauri::command]
pub fn adversum_voice_status(app: AppHandle) -> Result<VoiceStatus, String> {
    let settings = super::settings::read(&app);
    let dir = models::configured_dir(&app, &settings)?;
    #[cfg(target_os = "macos")]
    let (permission, live_text) = (
        permission::status().as_str(),
        transcribe::supports_preview(),
    );
    #[cfg(not(target_os = "macos"))]
    let (permission, live_text) = ("denied", false);
    Ok(VoiceStatus {
        supported: cfg!(target_os = "macos"),
        permission,
        live_text,
        models: models::statuses(&dir),
        model_dir: dir.to_string_lossy().into_owned(),
        default_model_dir: models::default_dir(&app)?.to_string_lossy().into_owned(),
        download: models::active_download(),
    })
}

#[tauri::command]
pub async fn adversum_voice_download(
    app: AppHandle,
    window: WebviewWindow,
    model: String,
) -> Result<(), String> {
    require_window(&window, "settings")?;
    models::download(app, model).await
}

#[tauri::command]
pub fn adversum_voice_cancel_download(window: WebviewWindow) -> Result<(), String> {
    require_window(&window, "settings")?;
    models::cancel_download();
    Ok(())
}

#[tauri::command]
pub fn adversum_voice_delete_model(
    app: AppHandle,
    window: WebviewWindow,
    model: String,
) -> Result<(), String> {
    require_window(&window, "settings")?;
    cancel();
    #[cfg(target_os = "macos")]
    transcribe::unload();
    models::delete(&app, &model)
}

/// Lets the user pick the folder for speech models. Returns `None` when the
/// dialog was dismissed. Saving the choice is up to the settings page.
#[tauri::command]
pub async fn adversum_voice_choose_dir(window: WebviewWindow) -> Result<Option<String>, String> {
    require_window(&window, "settings")?;
    #[cfg(target_os = "macos")]
    {
        let folder = rfd::AsyncFileDialog::new().pick_folder().await;
        Ok(folder.map(|handle| handle.path().to_string_lossy().into_owned()))
    }
    #[cfg(not(target_os = "macos"))]
    Err("Voice input is not available on this platform".into())
}

/// Asks macOS for microphone access when it has not asked yet, and returns
/// the permission as it stands. The answer to a pending question arrives as
/// an `adversum://voice-permission` event.
#[tauri::command]
pub fn adversum_voice_request_permission(app: AppHandle) -> &'static str {
    #[cfg(target_os = "macos")]
    {
        session::request_permission(&app);
        permission::status().as_str()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        "denied"
    }
}

/// Opens the microphone page of the system's privacy settings.
#[tauri::command]
pub fn adversum_voice_open_privacy(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            None::<&str>,
        )
        .map_err(|error| error.to_string())
}

/// Starts a recording from a button; it ends with `adversum_voice_finish`.
#[tauri::command]
pub fn adversum_voice_start(app: AppHandle) {
    #[cfg(target_os = "macos")]
    session::begin(&app, true);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub fn adversum_voice_finish(app: AppHandle) {
    #[cfg(target_os = "macos")]
    session::finish(&app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub fn adversum_voice_cancel() {
    cancel();
}

/// The names of customers, projects, activities and aliases, as one text that
/// primes the speech model.
#[tauri::command]
pub fn adversum_voice_set_vocabulary(
    window: WebviewWindow,
    vocabulary: String,
) -> Result<(), String> {
    require_window(&window, "tray-popup")?;
    if vocabulary.len() > 64 * 1024 {
        return Err("Vocabulary is too large".into());
    }
    *VOCABULARY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = clamp_vocabulary(&vocabulary);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn voice_is_off_and_hold_to_talk_until_set_otherwise() {
        let empty = json!({}).as_object().cloned().unwrap();
        assert!(!enabled(&empty));
        assert!(!tap_mode(&empty));
        let set = json!({"voiceEnabled": true, "voiceTapMode": true})
            .as_object()
            .cloned()
            .unwrap();
        assert!(enabled(&set));
        assert!(tap_mode(&set));
        let wrong = json!({"voiceEnabled": "yes"}).as_object().cloned().unwrap();
        assert!(!enabled(&wrong));
    }

    #[test]
    fn the_vocabulary_keeps_its_end_on_a_word_boundary() {
        assert_eq!(clamp_vocabulary("  DUSW,\n K&K  "), "DUSW, K&K");
        let long = format!("{} Projektmanagement Austausch", "wort ".repeat(400));
        let clamped = clamp_vocabulary(&long);
        assert!(clamped.chars().count() <= MAX_VOCABULARY_CHARS);
        assert!(clamped.ends_with("Projektmanagement Austausch"));
        assert!(clamped.starts_with("wort "));
        let unbroken = "x".repeat(MAX_VOCABULARY_CHARS + 50);
        assert_eq!(
            clamp_vocabulary(&unbroken).chars().count(),
            MAX_VOCABULARY_CHARS
        );
    }
}

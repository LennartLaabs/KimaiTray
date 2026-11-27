//! "Falsch verstanden": sentences the app read wrongly, kept for improving
//! the rules.
//!
//! A click on the button in the confirmation card or in the review appends
//! one line of JSON to `falsch-verstanden.jsonl`: the sentence, what the app
//! made of it and what the user made of it instead. The file is local and
//! stays local. It lives next to the repository on the development volume,
//! where the next session that works on the rules finds it (see CLAUDE.md,
//! "Sentences that were misunderstood"); on a Mac without that volume it
//! goes to the app's data folder.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

/// The development volume: an APFS image from Lennart's SSD.
const DEV_VOLUME: &str = "/Volumes/AdversumDev";
const FOLDER: &str = "feedback";
const FILE: &str = "falsch-verstanden.jsonl";
const MAX_RECORD_BYTES: usize = 32 * 1024;

fn append_line(dir: &Path, line: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(FILE);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(file, "{line}")?;
    Ok(path)
}

/// Appends the record where the rules are worked on, or, when that volume is
/// not there or cannot be written, in the app's own folder.
fn append(volume: &Path, fallback: &Path, record: &Map<String, Value>) -> Result<PathBuf, String> {
    let line = serde_json::to_string(record).map_err(|error| error.to_string())?;
    if line.len() > MAX_RECORD_BYTES {
        return Err("The feedback record is too large".into());
    }
    if volume.is_dir() {
        match append_line(&volume.join(FOLDER), &line) {
            Ok(path) => return Ok(path),
            Err(error) => log::info!("Feedback not written to {}: {error}", volume.display()),
        }
    }
    append_line(&fallback.join(FOLDER), &line)
        .map_err(|error| format!("Cannot write the feedback: {error}"))
}

/// Keeps a misunderstood sentence. Returns the file it went to.
#[tauri::command]
pub fn adversum_feedback_append(
    app: AppHandle,
    window: WebviewWindow,
    record: Value,
) -> Result<String, String> {
    if window.label() != super::quick::WINDOW_LABEL {
        return Err("Window is not authorized to store feedback".into());
    }
    let Value::Object(mut record) = record else {
        return Err("Feedback has to be an object".into());
    };
    record.insert(
        "build".into(),
        Value::String(option_env!("ADVERSUM_BUILD").unwrap_or("dev").into()),
    );
    let fallback = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("adversum");
    let path = append(Path::new(DEV_VOLUME), &fallback, &record)?;
    log::info!("Misunderstood sentence kept in {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(sentence: &str) -> Map<String, Value> {
        json!({"sentence": sentence, "recognized": {"task": "DUSW · Design"}, "corrected": null})
            .as_object()
            .cloned()
            .unwrap()
    }

    #[test]
    fn records_are_appended_line_by_line_on_the_development_volume() {
        let volume = tempfile::tempdir().unwrap();
        let fallback = tempfile::tempdir().unwrap();
        let first = append(volume.path(), fallback.path(), &record("eins")).unwrap();
        let second = append(volume.path(), fallback.path(), &record("zwei\nmit Umbruch")).unwrap();
        assert_eq!(
            first,
            volume.path().join("feedback/falsch-verstanden.jsonl")
        );
        assert_eq!(first, second);
        let lines: Vec<Value> = std::fs::read_to_string(&first)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["sentence"], "zwei\nmit Umbruch");
        assert!(!fallback.path().join("feedback").exists());
    }

    #[test]
    fn without_the_volume_or_when_it_cannot_be_written_the_app_folder_takes_them() {
        let fallback = tempfile::tempdir().unwrap();
        let missing = fallback.path().join("not-mounted");
        let path = append(&missing, fallback.path(), &record("eins")).unwrap();
        assert_eq!(
            path,
            fallback.path().join("feedback/falsch-verstanden.jsonl")
        );

        // A file where the folder should be: the volume is there but unusable.
        let volume = tempfile::tempdir().unwrap();
        std::fs::write(volume.path().join("feedback"), b"x").unwrap();
        let path = append(volume.path(), fallback.path(), &record("zwei")).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap().lines().count(), 2);

        // Nowhere to write, and records that are too large.
        let blocked = volume.path().join("feedback");
        assert!(append(&missing, &blocked, &record("drei")).is_err());
        assert!(append(
            &missing,
            fallback.path(),
            &record(&"x".repeat(MAX_RECORD_BYTES))
        )
        .is_err());
    }
}

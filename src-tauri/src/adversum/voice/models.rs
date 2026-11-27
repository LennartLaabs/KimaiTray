//! The Whisper speech models: which ones exist, where they are stored, and
//! downloading and deleting them.
//!
//! Models are the `ggml` files of whisper.cpp, fetched from its Hugging Face
//! repository. Size and SHA-256 of every file are pinned here; a download
//! that does not match both is discarded.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const MODEL_KEY: &str = "voiceModel";
pub(crate) const MODEL_DIR_KEY: &str = "voiceModelDir";
pub(crate) const DEFAULT_MODEL: &str = "small";
const DOWNLOAD_EVENT: &str = "adversum://voice-download";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// No data for this long ends a download.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

pub(crate) struct ModelSpec {
    pub(crate) id: &'static str,
    pub(crate) file: &'static str,
    pub(crate) size: u64,
    pub(crate) sha256: &'static str,
    /// Where the file is downloaded from.
    pub(crate) url: &'static str,
}

pub(crate) const MODELS: [ModelSpec; 3] = [
    ModelSpec {
        id: "base",
        file: "ggml-base.bin",
        size: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    },
    ModelSpec {
        id: "small",
        file: "ggml-small.bin",
        size: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    },
    ModelSpec {
        id: "large-v3-turbo",
        file: "ggml-large-v3-turbo.bin",
        size: 1_624_555_275,
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    },
];

pub(crate) fn spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|model| model.id == id)
}

/// The model the settings select; the default when none or an unknown one is stored.
pub(crate) fn selected(settings: &Map<String, Value>) -> &'static ModelSpec {
    settings
        .get(MODEL_KEY)
        .and_then(Value::as_str)
        .and_then(spec)
        .unwrap_or_else(|| spec(DEFAULT_MODEL).expect("default model is in the catalog"))
}

/// A user-chosen model folder is an absolute path to an existing directory.
pub(crate) fn validate_dir(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_dir() {
        return Err("The model folder does not exist".into());
    }
    Ok(())
}

pub(crate) fn default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("adversum")
        .join("models"))
}

/// The folder models are stored in: the one from the settings, else the
/// app data folder.
pub(crate) fn configured_dir(
    app: &AppHandle,
    settings: &Map<String, Value>,
) -> Result<PathBuf, String> {
    match settings.get(MODEL_DIR_KEY).and_then(Value::as_str) {
        Some(custom) if !custom.trim().is_empty() => Ok(PathBuf::from(custom.trim())),
        _ => default_dir(app),
    }
}

pub(crate) fn model_path(dir: &Path, model: &ModelSpec) -> PathBuf {
    dir.join(model.file)
}

fn part_path(dir: &Path, model: &ModelSpec) -> PathBuf {
    dir.join(format!("{}.part", model.file))
}

/// A model counts as installed when its file has exactly the pinned size.
/// The checksum is verified once, right after the download.
/// Which model to use when the chosen one is not there: the best that is.
const FALLBACK_ORDER: [&str; 3] = ["large-v3-turbo", "small", "base"];

/// The model to transcribe with: the chosen one, or, when its file is not
/// there (deleted, or never downloaded while another was), the best one that
/// is. Having a model and refusing to use it helps nobody.
pub(crate) fn usable(dir: &Path, settings: &Map<String, Value>) -> Option<&'static ModelSpec> {
    let chosen = selected(settings);
    if is_installed(dir, chosen) {
        return Some(chosen);
    }
    FALLBACK_ORDER
        .iter()
        .filter_map(|id| spec(id))
        .find(|model| is_installed(dir, model))
}

/// The name of the volume a model folder lies on, when that volume is not
/// mounted: "Extern" for `/Volumes/Extern/Modelle` without the disk.
pub(crate) fn missing_volume(dir: &Path) -> Option<String> {
    use std::path::Component;
    if dir.is_dir() {
        return None;
    }
    let mut parts = dir.components();
    match (parts.next(), parts.next(), parts.next()) {
        (
            Some(Component::RootDir),
            Some(Component::Normal(volumes)),
            Some(Component::Normal(name)),
        ) if volumes == "Volumes" => {
            let volume = Path::new("/Volumes").join(name);
            (!volume.is_dir()).then(|| name.to_string_lossy().trim().to_string())
        }
        _ => None,
    }
}

pub(crate) fn is_installed(dir: &Path, model: &ModelSpec) -> bool {
    std::fs::metadata(model_path(dir, model))
        .map(|metadata| metadata.is_file() && metadata.len() == model.size)
        .unwrap_or(false)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelStatus {
    pub(crate) id: &'static str,
    pub(crate) size_bytes: u64,
    pub(crate) installed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadProgress {
    model: String,
    /// "progress", "done", "cancelled" or "failed".
    state: &'static str,
    received: u64,
    total: u64,
}

struct ActiveDownload {
    model: &'static str,
    total: u64,
    received: u64,
    cancel: Arc<AtomicBool>,
}

static DOWNLOAD: Mutex<Option<ActiveDownload>> = Mutex::new(None);

fn download_slot() -> std::sync::MutexGuard<'static, Option<ActiveDownload>> {
    DOWNLOAD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn statuses(dir: &Path) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|model| ModelStatus {
            id: model.id,
            size_bytes: model.size,
            installed: is_installed(dir, model),
        })
        .collect()
}

/// The download that is running right now, for a settings page opened midway.
pub(crate) fn active_download() -> Option<DownloadProgress> {
    download_slot().as_ref().map(|active| DownloadProgress {
        model: active.model.to_string(),
        state: "progress",
        received: active.received,
        total: active.total,
    })
}

fn announce(app: &AppHandle, model: &ModelSpec, state: &'static str, received: u64) {
    let _ = app.emit(
        DOWNLOAD_EVENT,
        DownloadProgress {
            model: model.id.to_string(),
            state,
            received,
            total: model.size,
        },
    );
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

enum Outcome {
    Done,
    Cancelled,
}

async fn fetch(
    app: &AppHandle,
    model: &'static ModelSpec,
    dir: &Path,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Cannot create the model folder: {error}"))?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .user_agent("KimaiTray")
        .build()
        .map_err(|_| "Failed to initialize the download".to_string())?;
    let mut response = client
        .get(model.url)
        .send()
        .await
        .map_err(|error| format!("Download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed: HTTP {}", response.status()));
    }

    let part = part_path(dir, model);
    // Chunks are small, so writing them inline does not hold up the runtime.
    let mut file = std::fs::File::create(&part)
        .map_err(|error| format!("Cannot write the model file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut announced = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(Outcome::Cancelled);
        }
        let chunk = response
            .chunk()
            .await
            .map_err(|error| format!("Download interrupted: {error}"))?;
        let Some(chunk) = chunk else {
            break;
        };
        received += chunk.len() as u64;
        if received > model.size {
            return Err("Download is larger than the model".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|error| format!("Cannot write the model file: {error}"))?;
        if announced.elapsed() >= PROGRESS_INTERVAL {
            announced = Instant::now();
            if let Some(active) = download_slot().as_mut() {
                active.received = received;
            }
            announce(app, model, "progress", received);
        }
    }
    file.flush()
        .map_err(|error| format!("Cannot write the model file: {error}"))?;
    drop(file);

    if received != model.size || hex(&hasher.finalize()) != model.sha256 {
        return Err("The downloaded model failed its integrity check".into());
    }
    std::fs::rename(&part, model_path(dir, model))
        .map_err(|error| format!("Cannot store the model file: {error}"))?;
    Ok(Outcome::Done)
}

/// Downloads a model into the configured folder. Progress goes out as
/// `adversum://voice-download` events; the command resolves when the download
/// has ended one way or the other.
pub(crate) async fn download(app: AppHandle, id: String) -> Result<(), String> {
    let model = spec(&id).ok_or("Unknown speech model")?;
    let dir = configured_dir(&app, &super::super::settings::read(&app))?;
    download_to(app, model, dir).await
}

/// Downloads any model file into a folder, with the same progress events,
/// integrity check and one-at-a-time rule. The local language model
/// (`adversum/brain.rs`) is downloaded through this as well.
pub(crate) async fn download_to(
    app: AppHandle,
    model: &'static ModelSpec,
    dir: PathBuf,
) -> Result<(), String> {
    if is_installed(&dir, model) {
        announce(&app, model, "done", model.size);
        return Ok(());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut slot = download_slot();
        if slot.is_some() {
            return Err("Another model is being downloaded".into());
        }
        *slot = Some(ActiveDownload {
            model: model.id,
            total: model.size,
            received: 0,
            cancel: cancel.clone(),
        });
    }
    announce(&app, model, "progress", 0);
    let outcome = fetch(&app, model, &dir, &cancel).await;
    *download_slot() = None;
    if !matches!(outcome, Ok(Outcome::Done)) {
        // The unfinished file is of no use; a new attempt starts over.
        let _ = std::fs::remove_file(part_path(&dir, model));
    }
    match outcome {
        Ok(Outcome::Done) => {
            log::info!("Model {} downloaded", model.id);
            announce(&app, model, "done", model.size);
            Ok(())
        }
        Ok(Outcome::Cancelled) => {
            announce(&app, model, "cancelled", 0);
            Ok(())
        }
        Err(error) => {
            log::warn!("Model {} download failed: {error}", model.id);
            announce(&app, model, "failed", 0);
            Err(error)
        }
    }
}

pub(crate) fn cancel_download() {
    if let Some(active) = download_slot().as_ref() {
        active.cancel.store(true, Ordering::SeqCst);
    }
}

/// Removes a downloaded model from the configured folder.
pub(crate) fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    let model = spec(id).ok_or("Unknown speech model")?;
    let dir = configured_dir(app, &super::super::settings::read(app))?;
    delete_from(&dir, model)
}

pub(crate) fn delete_from(dir: &Path, model: &ModelSpec) -> Result<(), String> {
    let path = model_path(dir, model);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot delete the model: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_missing_chosen_model_gives_way_to_the_best_installed_one() {
        let dir = tempfile::tempdir().unwrap();
        let install = |id: &str| {
            let model = spec(id).unwrap();
            let file = std::fs::File::create(model_path(dir.path(), model)).unwrap();
            // Sparse: the size is what counts as installed, not the content.
            file.set_len(model.size).unwrap();
        };
        let small = settings(json!({}));
        assert!(usable(dir.path(), &small).is_none());
        install("base");
        assert_eq!(usable(dir.path(), &small).unwrap().id, "base");
        // What happened on 2026-11-26: Small deleted, Large downloaded,
        // the setting still on Small.
        install("large-v3-turbo");
        assert_eq!(usable(dir.path(), &small).unwrap().id, "large-v3-turbo");
        install("small");
        assert_eq!(usable(dir.path(), &small).unwrap().id, "small");
        let base = settings(json!({"voiceModel": "base"}));
        assert_eq!(usable(dir.path(), &base).unwrap().id, "base");
    }

    #[test]
    fn a_folder_on_an_unmounted_volume_is_told_apart_from_a_missing_folder() {
        assert_eq!(
            missing_volume(Path::new("/Volumes/Nicht Da /Modelle/whisper")),
            Some("Nicht Da".to_string())
        );
        assert_eq!(
            missing_volume(Path::new("/Volumes/NichtDa")),
            Some("NichtDa".to_string())
        );
        // An existing folder, a missing folder on the internal disk, and a
        // missing folder on a mounted volume are not this problem.
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(missing_volume(dir.path()), None);
        assert_eq!(missing_volume(&dir.path().join("fehlt")), None);
        assert_eq!(missing_volume(Path::new("/Volumes")), None);
        if let Some(mounted) = std::fs::read_dir("/Volumes")
            .ok()
            .and_then(|mut volumes| volumes.next())
            .and_then(Result::ok)
        {
            assert_eq!(missing_volume(&mounted.path().join("gibt-es-nicht")), None);
        }
    }

    #[test]
    fn the_catalog_offers_three_models_with_small_as_default() {
        assert_eq!(
            MODELS.iter().map(|model| model.id).collect::<Vec<_>>(),
            ["base", "small", "large-v3-turbo"]
        );
        assert_eq!(selected(&settings(json!({}))).id, "small");
        assert_eq!(
            selected(&settings(json!({"voiceModel": "base"}))).id,
            "base"
        );
        assert_eq!(
            selected(&settings(json!({"voiceModel": "tiny"}))).id,
            "small"
        );
        assert!(spec("large-v3-turbo").is_some());
        for model in &MODELS {
            assert_eq!(model.sha256.len(), 64);
            assert!(model.file.starts_with("ggml-") && model.file.ends_with(".bin"));
        }
    }

    #[test]
    fn a_model_is_installed_only_with_its_exact_size() {
        let dir = tempfile::tempdir().unwrap();
        let tiny = ModelSpec {
            id: "test",
            file: "ggml-test.bin",
            size: 4,
            sha256: "",
            url: "",
        };
        assert!(!is_installed(dir.path(), &tiny));
        std::fs::write(model_path(dir.path(), &tiny), b"abc").unwrap();
        assert!(!is_installed(dir.path(), &tiny));
        std::fs::write(model_path(dir.path(), &tiny), b"abcd").unwrap();
        assert!(is_installed(dir.path(), &tiny));
        assert_eq!(
            part_path(dir.path(), &tiny),
            dir.path().join("ggml-test.bin.part")
        );
    }

    #[test]
    fn the_model_folder_must_be_an_existing_absolute_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_dir("").is_ok());
        assert!(validate_dir(dir.path().to_str().unwrap()).is_ok());
        assert!(validate_dir("relative/folder").is_err());
        assert!(validate_dir(dir.path().join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn checksums_are_compared_as_lowercase_hex() {
        assert_eq!(hex(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn statuses_list_every_model() {
        let dir = tempfile::tempdir().unwrap();
        let list = statuses(dir.path());
        assert_eq!(list.len(), 3);
        assert!(list.iter().all(|status| !status.installed));
        assert_eq!(list[1].size_bytes, 487_601_967);
        assert!(active_download().is_none());
    }
}

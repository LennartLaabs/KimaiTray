//! The local language model for sentences the rules cannot read.
//!
//! It runs in a helper program of its own (`src-tauri/llm-helper`,
//! llama.cpp), next to the app's executable: llama.cpp and whisper.cpp each
//! bring their own copy of the ggml library, and one program cannot hold
//! both. The helper is started on the first request, keeps the model in
//! memory and is ended ten minutes after the last one.
//!
//! Model files are handled like speech models: downloaded on request with
//! progress and an integrity check, stored in a folder the user can choose,
//! deleted on request (`voice/models.rs` does the downloading).

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, WebviewWindow};

use super::voice::models::{self, ModelSpec};

pub(crate) const MODEL_KEY: &str = "brainModel";
pub(crate) const MODEL_DIR_KEY: &str = "brainModelDir";
const DEFAULT_MODEL: &str = "gemma-3-4b";
const HELPER: &str = "kimaitray-llm";
/// Loading a model from a slow disk takes a while.
const LOAD_TIMEOUT: Duration = Duration::from_secs(90);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
/// Without a request for this long the helper is ended and its memory freed.
const UNLOAD_AFTER: Duration = Duration::from_secs(10 * 60);

/// The models on offer, chosen by measuring them on our own sentences
/// (`src/adversum/multi/localModel.bench.test.ts`, 2026-11-27, M1): Gemma 3
/// 4B read most of them, Qwen 2.5 1.5B is the small and fast one. Both
/// licenses allow commercial use.
pub(crate) const MODELS: [ModelSpec; 2] = [
    ModelSpec {
        id: "gemma-3-4b",
        file: "google_gemma-3-4b-it-Q4_K_M.gguf",
        size: 2_489_758_112,
        sha256: "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94",
        url: "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf",
    },
    ModelSpec {
        id: "qwen-1b5",
        file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        size: 1_117_320_736,
        sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
        url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    },
];

pub(crate) fn spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|model| model.id == id)
}

fn selected(settings: &Map<String, Value>) -> &'static ModelSpec {
    settings
        .get(MODEL_KEY)
        .and_then(Value::as_str)
        .and_then(spec)
        .unwrap_or_else(|| spec(DEFAULT_MODEL).expect("default model is in the catalog"))
}

/// The folder the models are stored in: the one from the settings, else the
/// same folder in the app data as the speech models.
fn configured_dir(app: &AppHandle, settings: &Map<String, Value>) -> Result<PathBuf, String> {
    match settings.get(MODEL_DIR_KEY).and_then(Value::as_str) {
        Some(custom) if !custom.trim().is_empty() => Ok(PathBuf::from(custom.trim())),
        _ => models::default_dir(app),
    }
}

/// The model to ask: the chosen one, or the other one when only that is there.
fn usable(dir: &Path, settings: &Map<String, Value>) -> Option<&'static ModelSpec> {
    let chosen = selected(settings);
    if models::is_installed(dir, chosen) {
        return Some(chosen);
    }
    MODELS.iter().find(|model| models::is_installed(dir, model))
}

/// The helper next to the app's executable. `ADVERSUM_LLM_HELPER` names
/// another one, for development.
fn helper() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("ADVERSUM_LLM_HELPER").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    let beside = std::env::current_exe().ok()?.parent()?.join(HELPER);
    beside.is_file().then_some(beside)
}

/// The model file that can be asked right now, if helper and model are there.
pub(crate) fn ready_model(app: &AppHandle) -> Option<PathBuf> {
    helper()?;
    let settings = super::settings::read(app);
    let dir = configured_dir(app, &settings).ok()?;
    Some(models::model_path(&dir, usable(&dir, &settings)?))
}

// ── The helper process ─────────────────────────────────────────

struct Running {
    model: PathBuf,
    child: Child,
    input: ChildStdin,
    /// The helper's lines, read by a thread so that waiting can time out.
    lines: Receiver<String>,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);
static USES: AtomicU64 = AtomicU64::new(0);

fn running() -> std::sync::MutexGuard<'static, Option<Running>> {
    RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn start(helper: &Path, model: &Path) -> Result<Running, String> {
    let mut child = Command::new(helper)
        .arg(model)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("The language model helper did not start: {error}"))?;
    let input = child.stdin.take().ok_or("The helper has no input")?;
    let output = child.stdout.take().ok_or("The helper has no output")?;
    let (sender, lines) = channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let mut started = Running {
        model: model.to_path_buf(),
        child,
        input,
        lines,
    };
    let ready = read_reply(&mut started, LOAD_TIMEOUT)?;
    if ready.get("ready").and_then(Value::as_bool) != Some(true) {
        return Err(reply_error(&ready));
    }
    log::info!(
        "Language model loaded: {} ({})",
        model.display(),
        if ready.get("gpu").and_then(Value::as_bool) == Some(true) {
            "GPU"
        } else {
            "CPU"
        }
    );
    Ok(started)
}

fn read_reply(running: &mut Running, timeout: Duration) -> Result<Value, String> {
    let line = running
        .lines
        .recv_timeout(timeout)
        .map_err(|_| "The language model did not answer in time".to_string())?;
    serde_json::from_str(&line).map_err(|_| "The language model gave no JSON".to_string())
}

fn reply_error(reply: &Value) -> String {
    reply
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("The language model failed")
        .to_string()
}

/// The text of a helper reply, or its error.
pub(crate) fn reply_text(reply: &Value) -> Result<String, String> {
    match (
        reply.get("ok").and_then(Value::as_bool),
        reply.get("text").and_then(Value::as_str),
    ) {
        (Some(true), Some(text)) => Ok(text.to_string()),
        _ => Err(reply_error(reply)),
    }
}

/// Ends the helper once `UNLOAD_AFTER` passes without another request.
fn schedule_unload() {
    let use_number = USES.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(UNLOAD_AFTER);
        if USES.load(Ordering::SeqCst) == use_number {
            unload();
        }
    });
}

pub(crate) fn unload() {
    if running().take().is_some() {
        log::info!("Language model unloaded");
    }
}

/// Asks the local model. Blocks until it has answered; not for the main
/// thread. The answer is forced into `grammar` by the helper.
pub(crate) fn ask(
    model: &Path,
    instructions: &str,
    input: &str,
    grammar: &str,
) -> Result<String, String> {
    let helper = helper().ok_or("This build has no language model helper")?;
    let mut slot = running();
    if slot.as_ref().is_some_and(|running| running.model != model) {
        *slot = None;
    }
    if slot.is_none() {
        *slot = Some(start(&helper, model)?);
    }
    let current = slot.as_mut().expect("the helper was just started");
    let request = json!({ "instructions": instructions, "input": input, "grammar": grammar });
    let outcome = writeln!(current.input, "{request}")
        .and_then(|()| current.input.flush())
        .map_err(|error| format!("The language model helper is gone: {error}"))
        .and_then(|()| read_reply(current, ANSWER_TIMEOUT))
        .and_then(|reply| reply_text(&reply));
    if outcome.is_err() {
        // A helper that hangs or broke is not asked again; the next request
        // starts a fresh one.
        *slot = None;
    }
    drop(slot);
    schedule_unload();
    outcome
}

// ── Commands ───────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainStatus {
    /// This build has the helper program.
    helper: bool,
    models: Vec<models::ModelStatus>,
    /// The model that would be asked right now.
    active_model: Option<&'static str>,
    model_dir: String,
    default_model_dir: String,
    /// The model folder lies on this volume, which is not mounted.
    model_volume: Option<String>,
    download: Option<models::DownloadProgress>,
}

fn require_settings(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err("Window is not authorized for this command".into())
    }
}

#[tauri::command]
pub fn adversum_brain_status(app: AppHandle) -> Result<BrainStatus, String> {
    let settings = super::settings::read(&app);
    let dir = configured_dir(&app, &settings)?;
    Ok(BrainStatus {
        helper: helper().is_some(),
        models: MODELS
            .iter()
            .map(|model| models::ModelStatus {
                id: model.id,
                size_bytes: model.size,
                installed: models::is_installed(&dir, model),
            })
            .collect(),
        active_model: usable(&dir, &settings).map(|model| model.id),
        model_dir: dir.to_string_lossy().into_owned(),
        default_model_dir: models::default_dir(&app)?.to_string_lossy().into_owned(),
        model_volume: models::missing_volume(&dir),
        download: models::active_download(),
    })
}

#[tauri::command]
pub async fn adversum_brain_download(
    app: AppHandle,
    window: WebviewWindow,
    model: String,
) -> Result<(), String> {
    require_settings(&window)?;
    let model = spec(&model).ok_or("Unknown language model")?;
    let dir = configured_dir(&app, &super::settings::read(&app))?;
    models::download_to(app, model, dir).await
}

#[tauri::command]
pub fn adversum_brain_delete(
    app: AppHandle,
    window: WebviewWindow,
    model: String,
) -> Result<(), String> {
    require_settings(&window)?;
    let model = spec(&model).ok_or("Unknown language model")?;
    // The file may be the one in memory.
    unload();
    let dir = configured_dir(&app, &super::settings::read(&app))?;
    models::delete_from(&dir, model)
}

/// Whether a value is a usable choice of model.
pub(crate) fn valid_model(id: &str) -> bool {
    spec(id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn install(dir: &Path, id: &str) {
        let model = spec(id).unwrap();
        let file = std::fs::File::create(models::model_path(dir, model)).unwrap();
        file.set_len(model.size).unwrap();
    }

    #[test]
    fn the_catalog_has_two_models_with_gemma_as_default() {
        assert_eq!(
            MODELS.iter().map(|model| model.id).collect::<Vec<_>>(),
            ["gemma-3-4b", "qwen-1b5"]
        );
        for model in &MODELS {
            assert_eq!(model.sha256.len(), 64);
            assert!(model.url.starts_with("https://huggingface.co/"));
            assert!(model.url.ends_with(model.file));
        }
        assert_eq!(selected(&settings(json!({}))).id, "gemma-3-4b");
        assert_eq!(
            selected(&settings(json!({"brainModel": "qwen-1b5"}))).id,
            "qwen-1b5"
        );
        assert_eq!(
            selected(&settings(json!({"brainModel": "gpt"}))).id,
            "gemma-3-4b"
        );
        assert!(valid_model("qwen-1b5") && !valid_model("small"));
    }

    #[test]
    fn the_chosen_model_is_asked_or_the_one_that_is_there() {
        let dir = tempfile::tempdir().unwrap();
        let chosen = settings(json!({}));
        assert!(usable(dir.path(), &chosen).is_none());
        install(dir.path(), "qwen-1b5");
        assert_eq!(usable(dir.path(), &chosen).unwrap().id, "qwen-1b5");
        install(dir.path(), "gemma-3-4b");
        assert_eq!(usable(dir.path(), &chosen).unwrap().id, "gemma-3-4b");
    }

    #[test]
    fn a_reply_is_its_text_or_its_error() {
        assert_eq!(
            reply_text(&json!({"ok": true, "text": "{}"})).unwrap(),
            "{}"
        );
        assert_eq!(
            reply_text(&json!({"ok": false, "error": "too long"})).unwrap_err(),
            "too long"
        );
        assert_eq!(
            reply_text(&json!({})).unwrap_err(),
            "The language model failed"
        );
    }

    /// Asks a real model through the real helper. Needs both:
    ///
    /// ```sh
    /// (cd src-tauri/llm-helper && cargo build --release)
    /// ADVERSUM_LLM_HELPER=$PWD/src-tauri/llm-helper/target/release/kimaitray-llm \
    ///   ADVERSUM_LLM_MODEL=/path/model.gguf \
    ///   cargo test adversum::brain -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs the helper program and a downloaded model"]
    fn a_real_model_answers_within_the_grammar() {
        let model = PathBuf::from(std::env::var("ADVERSUM_LLM_MODEL").expect("ADVERSUM_LLM_MODEL"));
        let grammar = r#"root ::= "{\"minutes\":" [1-9] [0-9]{0,2} "}""#;
        for sentence in ["Eine Stunde Design", "Zwanzig Minuten Mails"] {
            let started = std::time::Instant::now();
            let answer = ask(
                &model,
                "How many minutes does the German sentence say? Answer with JSON.",
                &format!("Sentence: {sentence}\nJSON:"),
                grammar,
            )
            .unwrap();
            println!("{:?}: {sentence} → {answer}", started.elapsed());
            let value: Value = serde_json::from_str(&answer).unwrap();
            assert!(value["minutes"].is_u64());
        }
        // The second request went to the helper that was already running.
        assert!(running().is_some());
        unload();
        assert!(running().is_none());
    }

    /// Talks to a stand-in for the helper: a shell script that says it is
    /// ready and answers every line.
    #[cfg(unix)]
    #[test]
    fn the_helper_is_started_asked_and_ended() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("helper.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho '{\"ready\":true,\"gpu\":false}'\nwhile read -r line; do echo '{\"ok\":true,\"text\":\"{}\"}'; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut running = start(&script, Path::new("/model.gguf")).unwrap();
        writeln!(running.input, "{{}}").unwrap();
        let reply = read_reply(&mut running, Duration::from_secs(5)).unwrap();
        assert_eq!(reply_text(&reply).unwrap(), "{}");
        // Nothing more comes without another request.
        assert!(read_reply(&mut running, Duration::from_millis(100)).is_err());
        drop(running);

        // A helper that reports an error instead of being ready is no helper.
        std::fs::write(
            &script,
            "#!/bin/sh\necho '{\"ok\":false,\"error\":\"no such model\"}'\n",
        )
        .unwrap();
        assert_eq!(
            start(&script, Path::new("/model.gguf")).err().unwrap(),
            "no such model"
        );
        assert!(start(&dir.path().join("missing"), Path::new("/model.gguf")).is_err());
    }
}

//! One voice input from key press to text: record, transcribe, report.
//!
//! The quick entry window shows the progress. It receives
//! `adversum://voice-state` events with the phase ("recording",
//! "transcribing", "result", "empty" or "error"), the input level as
//! `adversum://voice-level` and, where the hardware allows, intermediate
//! text as `adversum://voice-partial`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::recorder::{Recorder, StartError};
use super::transcribe::{self, Quality};
use super::{audio, models, permission};
use crate::adversum::quick::{self, WINDOW_LABEL};

const STATE_EVENT: &str = "adversum://voice-state";
const LEVEL_EVENT: &str = "adversum://voice-level";
const PARTIAL_EVENT: &str = "adversum://voice-partial";
const PERMISSION_EVENT: &str = "adversum://voice-permission";
/// Shorter recordings are a slipped key, not speech.
const MIN_SAMPLES: usize = audio::WHISPER_SAMPLE_RATE as usize * 3 / 10;
const PREVIEW_INTERVAL: Duration = Duration::from_millis(1_200);
const PREVIEW_MIN_SAMPLES: usize = audio::WHISPER_SAMPLE_RATE as usize;

enum Phase {
    Idle,
    Recording(Recorder),
    Transcribing,
}

struct Session {
    /// Changes with every start and cancel; late results of an older
    /// recording are recognized by it and dropped.
    id: u64,
    phase: Phase,
    /// Stops intermediate transcriptions.
    preview_abort: Option<Arc<AtomicBool>>,
    /// Stops the final transcription.
    final_abort: Option<Arc<AtomicBool>>,
}

static SESSION: Mutex<Session> = Mutex::new(Session {
    id: 0,
    phase: Phase::Idle,
    preview_abort: None,
    final_abort: None,
});

fn session() -> MutexGuard<'static, Session> {
    SESSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    phase: &'static str,
    /// For "recording": ends by a click or key press instead of a key release.
    manual: bool,
    /// For "error": what is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    /// For "result": what was said.
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

fn emit_state(app: &AppHandle, phase: &'static str, manual: bool) {
    emit(app, phase, manual, None, None);
}

fn emit(
    app: &AppHandle,
    phase: &'static str,
    manual: bool,
    reason: Option<&'static str>,
    text: Option<String>,
) {
    let _ = app.emit_to(
        WINDOW_LABEL,
        STATE_EVENT,
        StatePayload {
            phase,
            manual,
            reason,
            text,
        },
    );
}

fn fail(app: &AppHandle, reason: &'static str) {
    quick::show_voice(app);
    emit(app, "error", false, Some(reason), None);
}

pub(super) fn is_recording() -> bool {
    matches!(session().phase, Phase::Recording(_))
}

/// Asks for microphone access if macOS has not asked yet.
pub(super) fn request_permission(app: &AppHandle) {
    if permission::status() != permission::Permission::Undetermined {
        return;
    }
    let app = app.clone();
    permission::request(move |granted| {
        log::info!("Microphone access granted: {granted}");
        let _ = app.emit(PERMISSION_EVENT, granted);
    });
}

/// Starts recording and shows the overlay. Does nothing while a recording
/// or transcription is under way.
pub(super) fn begin(app: &AppHandle, manual: bool) {
    let settings = crate::adversum::settings::read(app);
    let mut current = session();
    if !matches!(current.phase, Phase::Idle) {
        return;
    }
    if !super::enabled(&settings) {
        return fail(app, "disabled");
    }
    let model = models::selected(&settings);
    let model_path: PathBuf = match models::configured_dir(app, &settings) {
        Ok(dir) if models::is_installed(&dir, model) => models::model_path(&dir, model),
        _ => return fail(app, "noModel"),
    };
    match permission::status() {
        permission::Permission::Granted => {}
        permission::Permission::Denied => return fail(app, "permissionDenied"),
        permission::Permission::Undetermined => {
            request_permission(app);
            return fail(app, "permissionRequested");
        }
    }

    let level_app = app.clone();
    let recorder = Recorder::start(move |level, full| {
        let _ = level_app.emit_to(WINDOW_LABEL, LEVEL_EVENT, level);
        if full {
            // Ending the recording waits for this thread, so do it elsewhere.
            let app = level_app.clone();
            std::thread::spawn(move || finish(&app));
        }
    });
    let recorder = match recorder {
        Ok(recorder) => recorder,
        Err(StartError::NoMicrophone) => return fail(app, "noMicrophone"),
        Err(StartError::Failed(detail)) => {
            log::warn!("Cannot record: {detail}");
            return fail(app, "failed");
        }
    };
    current.id += 1;
    let id = current.id;
    let preview_abort = Arc::new(AtomicBool::new(false));
    current.phase = Phase::Recording(recorder);
    current.preview_abort = Some(preview_abort.clone());
    current.final_abort = Some(Arc::new(AtomicBool::new(false)));
    drop(current);

    quick::show_voice(app);
    emit_state(app, "recording", manual);

    let app = app.clone();
    std::thread::spawn(move || {
        // Load the model while the user is still speaking.
        transcribe::preload(&model_path);
        if transcribe::supports_preview() {
            preview(&app, id, &model_path, &preview_abort);
        }
    });
}

/// Transcribes what was said so far, again and again, until the recording
/// ends.
fn preview(app: &AppHandle, id: u64, model: &std::path::Path, abort: &Arc<AtomicBool>) {
    loop {
        std::thread::sleep(PREVIEW_INTERVAL);
        let samples = {
            let current = session();
            match &current.phase {
                Phase::Recording(recorder) if current.id == id => recorder.snapshot(),
                _ => return,
            }
        };
        if samples.len() < PREVIEW_MIN_SAMPLES || audio::is_silent(&samples) {
            continue;
        }
        let text = transcribe::transcribe(
            model,
            &samples,
            &super::vocabulary(),
            Quality::Preview,
            abort.clone(),
        );
        if abort.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(text) = text {
            if !text.is_empty() {
                let _ = app.emit_to(WINDOW_LABEL, PARTIAL_EVENT, text);
            }
        }
    }
}

/// Ends the recording and transcribes it. Does nothing without a recording.
pub(super) fn finish(app: &AppHandle) {
    let settings = crate::adversum::settings::read(app);
    let (recorder, id, abort) = {
        let mut current = session();
        match std::mem::replace(&mut current.phase, Phase::Transcribing) {
            Phase::Recording(recorder) => {
                if let Some(preview_abort) = current.preview_abort.take() {
                    preview_abort.store(true, Ordering::Relaxed);
                }
                let abort = current
                    .final_abort
                    .clone()
                    .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
                (recorder, current.id, abort)
            }
            other => {
                current.phase = other;
                return;
            }
        }
    };
    emit_state(app, "transcribing", false);

    let app = app.clone();
    std::thread::spawn(move || {
        let samples = recorder.finish();
        let outcome = if samples.len() < MIN_SAMPLES || audio::is_silent(&samples) {
            Ok(String::new())
        } else {
            let model = models::selected(&settings);
            models::configured_dir(&app, &settings).and_then(|dir| {
                transcribe::transcribe(
                    &models::model_path(&dir, model),
                    &samples,
                    &super::vocabulary(),
                    Quality::Final,
                    abort,
                )
            })
        };
        {
            let mut current = session();
            if current.id != id {
                // Cancelled or replaced meanwhile.
                return;
            }
            current.phase = Phase::Idle;
            current.final_abort = None;
        }
        match outcome {
            Ok(text) if text.is_empty() => emit_state(&app, "empty", false),
            Ok(text) => {
                // The text is the user's speech; it stays out of the log.
                log::info!("Voice input transcribed ({} characters)", text.len());
                emit(&app, "result", false, None, Some(text));
            }
            Err(error) => {
                log::warn!("{error}");
                emit(&app, "error", false, Some("failed"), None);
            }
        }
    });
}

/// Drops a running recording or transcription without a result.
pub(super) fn cancel() {
    let phase = {
        let mut current = session();
        current.id += 1;
        for abort in [current.preview_abort.take(), current.final_abort.take()]
            .into_iter()
            .flatten()
        {
            abort.store(true, Ordering::Relaxed);
        }
        std::mem::replace(&mut current.phase, Phase::Idle)
    };
    // Stopping the recorder waits for its thread; not under the lock.
    drop(phase);
}

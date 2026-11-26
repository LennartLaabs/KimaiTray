//! One voice input from key press to text: record, check, transcribe, report.
//!
//! The quick entry window shows the progress. It receives
//! `adversum://voice-state` events with the phase ("recording",
//! "transcribing", "result", "empty" or "error"), the input level as
//! `adversum://voice-level` and, where the hardware allows, intermediate
//! text as `adversum://voice-partial`.
//!
//! Every recording is described in the log: device, format, levels per
//! channel, what was done to it, what the model wrote. The microphone test
//! of the settings page runs the same steps and always keeps its recording
//! as WAV files; normal recordings are kept only with `voiceDebug` on.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::audio::{self, AudioReport, Prepared};
use super::recorder::{Capture, CaptureInfo, Recorder, StartError};
use super::transcribe::{self, Quality};
use super::{guard, models, permission};
use crate::adversum::quick::{self, WINDOW_LABEL};

const STATE_EVENT: &str = "adversum://voice-state";
const LEVEL_EVENT: &str = "adversum://voice-level";
const PARTIAL_EVENT: &str = "adversum://voice-partial";
const PERMISSION_EVENT: &str = "adversum://voice-permission";
pub(crate) const DEVICE_KEY: &str = "voiceInputDevice";
pub(crate) const DEBUG_KEY: &str = "voiceDebug";
/// Shorter recordings are a slipped key, not speech.
const MIN_SECONDS: f32 = 0.3;
const PREVIEW_INTERVAL: Duration = Duration::from_millis(1_200);
const PREVIEW_MIN_SECONDS: f32 = 1.0;
const RAW_FILE: &str = "last-raw.wav";
const PREPARED_FILE: &str = "last-16k.wav";

enum Phase {
    Idle,
    Recording(Recorder),
    Transcribing,
    /// The microphone test of the settings page.
    Testing(Recorder),
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

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload {
    phase: &'static str,
    /// For "recording": ends by a click or key press instead of a key release.
    manual: bool,
    /// For "error" and "empty": what was missing or wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    /// For "error": the concrete message.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// For "result": what was said.
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

fn emit(app: &AppHandle, payload: StatePayload) {
    let _ = app.emit_to(WINDOW_LABEL, STATE_EVENT, payload);
}

fn emit_phase(app: &AppHandle, phase: &'static str, manual: bool) {
    emit(
        app,
        StatePayload {
            phase,
            manual,
            ..StatePayload::default()
        },
    );
}

fn emit_reason(app: &AppHandle, phase: &'static str, reason: &'static str, detail: Option<String>) {
    emit(
        app,
        StatePayload {
            phase,
            reason: Some(reason),
            detail,
            ..StatePayload::default()
        },
    );
}

fn fail(app: &AppHandle, reason: &'static str, detail: Option<String>) {
    log::warn!(
        "Voice input cannot start: {reason} {}",
        detail.as_deref().unwrap_or_default()
    );
    quick::show_voice(app);
    emit_reason(app, "error", reason, detail);
}

fn device_id(settings: &Map<String, Value>) -> String {
    settings
        .get(DEVICE_KEY)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn keeps_recordings(settings: &Map<String, Value>) -> bool {
    settings.get(DEBUG_KEY).and_then(Value::as_bool) == Some(true)
}

/// Where the last recording is kept for diagnosis.
pub(super) fn debug_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("adversum")
        .join("voice-debug"))
}

/// One line for the log: where the audio came from and what became of it.
pub(super) fn describe(info: &CaptureInfo, report: &AudioReport) -> String {
    format!(
        "device \"{}\", {} Hz, {} channel(s), {}, {:.1} s; channel rms {:?} peak {:?}; \
         used channel {}, offset {:.4}; noise floor {:.4}, speech level {:.4}, speech: {}; \
         gain {:.1}; to the model: rms {:.4} peak {:.4}",
        info.device,
        info.sample_rate,
        info.channels,
        info.sample_format,
        report.seconds,
        report.channel_rms,
        report.channel_peak,
        report.used_channel + 1,
        report.offset,
        report.noise_floor,
        report.speech_level,
        if report.has_speech { "yes" } else { "no" },
        report.gain,
        report.rms,
        report.peak,
    )
}

/// Writes the recording as it came from the device and as it goes to the
/// model. Returns both paths.
fn save_recording(
    dir: &Path,
    capture: &Capture,
    prepared: &Prepared,
) -> Result<(PathBuf, PathBuf), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let raw = dir.join(RAW_FILE);
    let ready = dir.join(PREPARED_FILE);
    std::fs::write(
        &raw,
        audio::wav_bytes(
            &capture.interleaved,
            capture.info.channels,
            capture.info.sample_rate,
        ),
    )
    .map_err(|error| error.to_string())?;
    std::fs::write(
        &ready,
        audio::wav_bytes(&prepared.samples, 1, audio::WHISPER_SAMPLE_RATE),
    )
    .map_err(|error| error.to_string())?;
    Ok((raw, ready))
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

/// "permissionDenied" or "permissionRequested" unless access is granted.
fn check_permission(app: &AppHandle) -> Result<(), &'static str> {
    match permission::status() {
        permission::Permission::Granted => Ok(()),
        permission::Permission::Denied => Err("permissionDenied"),
        permission::Permission::Undetermined => {
            request_permission(app);
            Err("permissionRequested")
        }
    }
}

/// Starts recording and shows the overlay. Does nothing while a recording
/// or transcription is under way. Not for the main thread.
pub(super) fn begin(app: &AppHandle, manual: bool) {
    let settings = crate::adversum::settings::read(app);
    let mut current = session();
    if !matches!(current.phase, Phase::Idle) {
        log::info!("Voice input: already busy, start ignored");
        return;
    }
    if !super::enabled(&settings) {
        return fail(app, "disabled", None);
    }
    let Some(model_path) = installed_model(app, &settings) else {
        // A folder on a disk that is not plugged in is a different problem
        // than a model that was never downloaded.
        let volume = models::configured_dir(app, &settings)
            .ok()
            .and_then(|dir| models::missing_volume(&dir));
        return match volume {
            Some(volume) => fail(app, "modelVolume", Some(volume)),
            None => fail(app, "noModel", None),
        };
    };
    if let Err(reason) = check_permission(app) {
        return fail(app, reason, None);
    }

    let level_app = app.clone();
    let recorder = Recorder::start(&device_id(&settings), move |level, full| {
        let _ = level_app.emit_to(WINDOW_LABEL, LEVEL_EVENT, level);
        if full {
            // Ending the recording waits for this thread, so do it elsewhere.
            let app = level_app.clone();
            std::thread::spawn(move || finish(&app));
        }
    });
    let recorder = match recorder {
        Ok(recorder) => recorder,
        Err(StartError::NoMicrophone) => return fail(app, "noMicrophone", None),
        Err(StartError::Failed(detail)) => return fail(app, "failed", Some(detail)),
    };
    let info = recorder.info();
    log::info!(
        "Voice input: recording from \"{}\" ({} Hz, {} channel(s), {})",
        info.device,
        info.sample_rate,
        info.channels,
        info.sample_format
    );
    current.id += 1;
    let id = current.id;
    let preview_abort = Arc::new(AtomicBool::new(false));
    current.phase = Phase::Recording(recorder);
    current.preview_abort = Some(preview_abort.clone());
    current.final_abort = Some(Arc::new(AtomicBool::new(false)));
    drop(current);

    quick::show_voice(app);
    emit_phase(app, "recording", manual);

    let app = app.clone();
    std::thread::spawn(move || {
        // Load the model while the user is still speaking.
        transcribe::preload(&model_path);
        if transcribe::supports_preview() {
            preview(&app, id, &model_path, &preview_abort);
        }
    });
}

/// Tells the overlay that this recording now ends by a key press or click:
/// the key was only tapped, not held.
pub(super) fn make_manual(app: &AppHandle) {
    if is_recording() {
        emit_phase(app, "recording", true);
    }
}

/// Transcribes what was said so far, again and again, until the recording
/// ends.
fn preview(app: &AppHandle, id: u64, model: &Path, abort: &Arc<AtomicBool>) {
    loop {
        std::thread::sleep(PREVIEW_INTERVAL);
        let capture = {
            let current = session();
            match &current.phase {
                Phase::Recording(recorder) if current.id == id => recorder.snapshot(),
                _ => return,
            }
        };
        let prepared = audio::prepare(
            &capture.interleaved,
            capture.info.channels,
            capture.info.sample_rate,
        );
        if prepared.report.seconds < PREVIEW_MIN_SECONDS || !prepared.report.has_speech {
            continue;
        }
        let transcript = transcribe::transcribe(
            model,
            &prepared.samples,
            &super::vocabulary(),
            Quality::Preview,
            abort.clone(),
        );
        if abort.load(Ordering::Relaxed) {
            return;
        }
        if let Ok(transcript) = transcript {
            if guard::is_plausible(&transcript.text, transcript.no_speech) {
                let _ = app.emit_to(WINDOW_LABEL, PARTIAL_EVENT, transcript.text);
            }
        }
    }
}

/// How a recording ended.
enum Outcome {
    Text(String),
    /// Nothing usable: "tooShort", "tooQuiet" or "nothing".
    Empty(&'static str),
    Failed(String),
}

impl Outcome {
    fn code(&self) -> &'static str {
        match self {
            Outcome::Text(_) => "ok",
            Outcome::Empty(reason) => reason,
            Outcome::Failed(_) => "failed",
        }
    }
}

/// Checks a recording and has the model transcribe it.
fn recognize(
    info: &CaptureInfo,
    prepared: &Prepared,
    model: Option<&Path>,
    abort: Arc<AtomicBool>,
) -> Outcome {
    log::info!("Voice input: {}", describe(info, &prepared.report));
    if prepared.report.seconds < MIN_SECONDS {
        return Outcome::Empty("tooShort");
    }
    if !prepared.report.has_speech {
        return Outcome::Empty("tooQuiet");
    }
    let Some(model) = model else {
        return Outcome::Empty("noModel");
    };
    match transcribe::transcribe(
        model,
        &prepared.samples,
        &super::vocabulary(),
        Quality::Final,
        abort,
    ) {
        Ok(transcript) => {
            log::info!(
                "Voice input: the model wrote \"{}\" (no-speech probability {:.2})",
                transcript.text,
                transcript.no_speech
            );
            if guard::is_plausible(&transcript.text, transcript.no_speech) {
                Outcome::Text(transcript.text)
            } else {
                Outcome::Empty("nothing")
            }
        }
        Err(error) => {
            log::warn!("Voice input: {error}");
            Outcome::Failed(error)
        }
    }
}

/// The model file to transcribe with: the chosen model, or another one that
/// is installed when the chosen one is not.
fn installed_model(app: &AppHandle, settings: &Map<String, Value>) -> Option<PathBuf> {
    let dir = models::configured_dir(app, settings).ok()?;
    let model = models::usable(&dir, settings)?;
    let chosen = models::selected(settings);
    if model.id != chosen.id {
        log::info!(
            "Voice input: the chosen model {} is not installed, using {}",
            chosen.id,
            model.id
        );
    }
    Some(models::model_path(&dir, model))
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
    emit_phase(app, "transcribing", false);

    let app = app.clone();
    std::thread::spawn(move || {
        let capture = recorder.finish();
        let prepared = audio::prepare(
            &capture.interleaved,
            capture.info.channels,
            capture.info.sample_rate,
        );
        if keeps_recordings(&settings) {
            match debug_dir(&app).and_then(|dir| save_recording(&dir, &capture, &prepared)) {
                Ok((raw, _)) => log::info!("Voice input: recording kept at {}", raw.display()),
                Err(error) => log::warn!("Voice input: recording not kept: {error}"),
            }
        }
        let model = installed_model(&app, &settings);
        let outcome = recognize(&capture.info, &prepared, model.as_deref(), abort);
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
            Outcome::Text(text) => emit(
                &app,
                StatePayload {
                    phase: "result",
                    text: Some(text),
                    ..StatePayload::default()
                },
            ),
            Outcome::Empty(reason) => emit_reason(&app, "empty", reason, None),
            Outcome::Failed(error) => emit_reason(&app, "error", "failed", Some(error)),
        }
    });
}

/// Drops a running recording, test or transcription without a result.
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

// ── Microphone test ────────────────────────────────────────────

/// What the microphone test found.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTest {
    /// "ok", "tooShort", "tooQuiet", "nothing", "noModel" or "failed".
    outcome: &'static str,
    text: String,
    detail: Option<String>,
    info: CaptureInfo,
    report: AudioReport,
    /// The recording as it came from the device.
    raw_path: Option<String>,
    /// The recording as it went to the model.
    prepared_path: Option<String>,
}

/// Starts the test recording. The level goes to the settings window.
pub(super) fn test_begin(app: &AppHandle) -> Result<(), String> {
    let settings = crate::adversum::settings::read(app);
    let mut current = session();
    if !matches!(current.phase, Phase::Idle) {
        return Err("busy".into());
    }
    check_permission(app)?;
    let level_app = app.clone();
    let recorder = Recorder::start(&device_id(&settings), move |level, _full| {
        let _ = level_app.emit_to("settings", LEVEL_EVENT, level);
    })
    .map_err(|error| match error {
        StartError::NoMicrophone => "noMicrophone".to_string(),
        StartError::Failed(detail) => detail,
    })?;
    current.id += 1;
    current.phase = Phase::Testing(recorder);
    Ok(())
}

/// Ends the test recording, keeps it as WAV files and transcribes it.
pub(super) fn test_finish(app: &AppHandle) -> Result<VoiceTest, String> {
    let settings = crate::adversum::settings::read(app);
    let (recorder, id) = {
        let mut current = session();
        match std::mem::replace(&mut current.phase, Phase::Transcribing) {
            Phase::Testing(recorder) => (recorder, current.id),
            other => {
                current.phase = other;
                return Err("notTesting".into());
            }
        }
    };
    let capture = recorder.finish();
    let prepared = audio::prepare(
        &capture.interleaved,
        capture.info.channels,
        capture.info.sample_rate,
    );
    let saved = debug_dir(app).and_then(|dir| save_recording(&dir, &capture, &prepared));
    if let Err(error) = &saved {
        log::warn!("Microphone test: recording not kept: {error}");
    }
    let model = installed_model(app, &settings);
    let outcome = recognize(
        &capture.info,
        &prepared,
        model.as_deref(),
        Arc::new(AtomicBool::new(false)),
    );
    {
        let mut current = session();
        if current.id == id {
            current.phase = Phase::Idle;
        }
    }
    let code = outcome.code();
    let (text, detail) = match outcome {
        Outcome::Text(text) => (text, None),
        Outcome::Empty(_) => (String::new(), None),
        Outcome::Failed(error) => (String::new(), Some(error)),
    };
    let paths = saved.ok();
    let display = |path: &PathBuf| path.to_string_lossy().into_owned();
    Ok(VoiceTest {
        outcome: code,
        text,
        detail,
        info: capture.info,
        report: prepared.report,
        raw_path: paths.as_ref().map(|(raw, _)| display(raw)),
        prepared_path: paths.as_ref().map(|(_, ready)| display(ready)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn capture(interleaved: Vec<f32>) -> Capture {
        Capture {
            info: CaptureInfo {
                device: "Test microphone".into(),
                sample_rate: 48_000,
                channels: 2,
                sample_format: "f32".into(),
            },
            interleaved,
        }
    }

    #[test]
    fn device_and_diagnosis_settings_have_quiet_defaults() {
        let empty = settings(json!({}));
        assert_eq!(device_id(&empty), "");
        assert!(!keeps_recordings(&empty));
        let set = settings(json!({"voiceInputDevice": "coreaudio:abc", "voiceDebug": true}));
        assert_eq!(device_id(&set), "coreaudio:abc");
        assert!(keeps_recordings(&set));
        assert!(!keeps_recordings(&settings(json!({"voiceDebug": "yes"}))));
    }

    #[test]
    fn a_recording_is_described_and_kept_as_two_wav_files() {
        let take = capture([0.0, 0.25, 0.0, -0.25].repeat(12_000));
        let prepared = audio::prepare(&take.interleaved, 2, 48_000);
        let line = describe(&take.info, &prepared.report);
        assert!(line.starts_with("device \"Test microphone\", 48000 Hz, 2 channel(s), f32, 0.5 s;"));
        assert!(line.contains("used channel 2"));

        let dir = tempfile::tempdir().unwrap();
        let (raw, ready) =
            save_recording(&dir.path().join("voice-debug"), &take, &prepared).unwrap();
        let (samples, channels, rate) = audio::read_wav(&std::fs::read(&raw).unwrap()).unwrap();
        assert_eq!((channels, rate, samples.len()), (2, 48_000, 48_000));
        let (samples, channels, rate) = audio::read_wav(&std::fs::read(&ready).unwrap()).unwrap();
        assert_eq!((channels, rate, samples.len()), (1, 16_000, 8_000));
        // A folder that cannot be created is reported, not ignored.
        let blocked = dir.path().join("file");
        std::fs::write(&blocked, b"x").unwrap();
        assert!(save_recording(&blocked.join("sub"), &take, &prepared).is_err());
    }

    #[test]
    fn too_short_and_too_quiet_recordings_never_reach_the_model() {
        let info = capture(Vec::new()).info;
        let abort = || Arc::new(AtomicBool::new(false));
        let short = audio::prepare(&vec![0.1; 4_000], 1, 48_000);
        assert_eq!(recognize(&info, &short, None, abort()).code(), "tooShort");
        let silent = audio::prepare(&vec![0.0; 96_000], 1, 48_000);
        assert_eq!(recognize(&info, &silent, None, abort()).code(), "tooQuiet");
        // Speech-like audio without a model to give it to.
        let voice: Vec<f32> = (0..96_000)
            .map(|index| {
                let time = index as f32 / 48_000.0;
                (time * 1_382.0).sin() * (time * 19.0).sin().max(0.0) * 0.1
            })
            .collect();
        let speech = audio::prepare(&voice, 1, 48_000);
        assert_eq!(recognize(&info, &speech, None, abort()).code(), "noModel");
        assert_eq!(Outcome::Text("x".into()).code(), "ok");
        assert_eq!(Outcome::Failed("x".into()).code(), "failed");
    }

    /// The whole way from device samples to text, with a real model and a
    /// spoken sentence, and with the faults microphones have. Needs a stereo
    /// 48 kHz WAV:
    ///
    /// ```sh
    /// say -v Anna -o /tmp/v.aiff "DUSW Projektmanagement, Gigi Call seit zehn Uhr"
    /// afconvert -f WAVE -d LEI16@48000 -c 2 /tmp/v.aiff /tmp/v.wav
    /// ADVERSUM_VOICE_MODEL=/path/ggml-small.bin ADVERSUM_VOICE_WAV=/tmp/v.wav \
    ///   cargo test adversum::voice::session -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs a downloaded model and a recording"]
    fn recordings_with_typical_faults_are_still_understood() {
        let model =
            PathBuf::from(std::env::var("ADVERSUM_VOICE_MODEL").expect("ADVERSUM_VOICE_MODEL"));
        let wav = std::fs::read(std::env::var("ADVERSUM_VOICE_WAV").expect("ADVERSUM_VOICE_WAV"))
            .unwrap();
        let (clean, channels, rate) = audio::read_wav(&wav).expect("a 16-bit WAV file");
        assert_eq!(
            (channels, rate),
            (2, 48_000),
            "convert with -d LEI16@48000 -c 2"
        );
        let mut seed = 99_u32;
        let mut noise = move |amplitude: f32| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((seed >> 8) as f32 / 8_388_608.0 - 1.0) * amplitude
        };
        let frames = |change: &mut dyn FnMut(f32, f32) -> [f32; 2]| -> Vec<f32> {
            clean
                .chunks_exact(2)
                .flat_map(|frame| change(frame[0], frame[1]))
                .collect()
        };
        let cases: Vec<(&str, Vec<f32>, bool)> = vec![
            ("as recorded", clean.clone(), true),
            (
                "channels with opposite sign",
                frames(&mut |l, _| [l, -l]),
                true,
            ),
            ("left channel dead", frames(&mut |_, r| [0.0, r]), true),
            (
                "constant offset",
                frames(&mut |l, r| [l * 0.2 + 0.3, r * 0.2 + 0.3]),
                true,
            ),
            ("very quiet", frames(&mut |l, r| [l * 0.01, r * 0.01]), true),
            (
                "with room noise",
                frames(&mut |l, r| [l * 0.3 + noise(0.01), r * 0.3 + noise(0.01)]),
                true,
            ),
            (
                "only noise",
                frames(&mut |_, _| [noise(0.02), noise(0.02)]),
                false,
            ),
            (
                "only hum",
                (0..96_000 * 2)
                    .map(|i| ((i / 2) as f32 * 0.0065).sin() * 0.05)
                    .collect(),
                false,
            ),
            ("silence", vec![0.0; 96_000 * 2], false),
        ];
        let info = capture(Vec::new()).info;
        for (label, interleaved, understood) in cases {
            let prepared = audio::prepare(&interleaved, 2, 48_000);
            let outcome = recognize(
                &info,
                &prepared,
                Some(&model),
                Arc::new(AtomicBool::new(false)),
            );
            let shown = match &outcome {
                Outcome::Text(text) => format!("\"{text}\""),
                other => other.code().to_string(),
            };
            println!("{label}: {shown}  [{}]", describe(&info, &prepared.report));
            assert_eq!(matches!(outcome, Outcome::Text(_)), understood, "{label}");
        }
    }
}

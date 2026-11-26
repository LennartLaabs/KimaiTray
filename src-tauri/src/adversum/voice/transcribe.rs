//! Speech to text with whisper.cpp, entirely on this machine.
//!
//! The model stays loaded between recordings and is released after a while
//! without use, because it occupies several hundred megabytes of memory.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use super::audio;

/// Without a recording for this long the model is unloaded.
const UNLOAD_AFTER: Duration = Duration::from_secs(10 * 60);
const THREADS: i32 = 4;

struct Engine {
    path: PathBuf,
    gpu: bool,
    // The state borrows nothing from the context in Rust terms, but must not
    // outlive it: fields drop in declaration order, the state first.
    state: WhisperState,
    _context: WhisperContext,
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);
/// Set once a run failed on the GPU and succeeded on the CPU.
static GPU_GAVE_UP: AtomicBool = AtomicBool::new(false);

/// What the model understood.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Transcript {
    pub(crate) text: String,
    /// The model's own estimate that the audio held no speech, 0 to 1.
    pub(crate) no_speech: f32,
}

enum RunError {
    Cancelled,
    Failed(String),
}
static USES: AtomicU64 = AtomicU64::new(0);

fn engine() -> std::sync::MutexGuard<'static, Option<Engine>> {
    ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How thorough a transcription is.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Quality {
    /// The final text of a recording.
    Final,
    /// A quick intermediate text while the recording still runs.
    Preview,
}

/// Live previews need the GPU to keep up; Intel Macs transcribe on the CPU.
pub(crate) fn supports_preview() -> bool {
    cfg!(target_arch = "aarch64")
}

/// Metal is reliable on Apple Silicon only.
fn gpu_wanted() -> bool {
    cfg!(target_arch = "aarch64") && !GPU_GAVE_UP.load(Ordering::Relaxed)
}

fn load(path: &Path, gpu: bool) -> Result<Engine, String> {
    // Sends what whisper.cpp prints to the app's log (warnings and errors;
    // the level is set where the log is configured).
    whisper_rs::install_logging_hooks();
    let mut parameters = WhisperContextParameters::default();
    parameters.use_gpu(gpu);
    let path_text = path.to_str().ok_or("The model path is not valid Unicode")?;
    let context = WhisperContext::new_with_params(path_text, parameters)
        .map_err(|error| format!("Cannot load the speech model: {error}"))?;
    let state = context
        .create_state()
        .map_err(|error| format!("Cannot prepare the speech model: {error}"))?;
    log::info!(
        "Speech model loaded: {} ({})",
        path.display(),
        if gpu { "GPU" } else { "CPU" }
    );
    Ok(Engine {
        path: path.to_path_buf(),
        gpu,
        state,
        _context: context,
    })
}

fn ensure<'a>(
    slot: &'a mut Option<Engine>,
    path: &Path,
    gpu: bool,
) -> Result<&'a mut Engine, String> {
    if slot
        .as_ref()
        .is_some_and(|engine| engine.path != path || engine.gpu != gpu)
    {
        *slot = None;
    }
    if slot.is_none() {
        *slot = Some(load(path, gpu)?);
    }
    Ok(slot.as_mut().expect("engine was just loaded"))
}

/// Loads the model ahead of the first transcription, while the user speaks.
pub(crate) fn preload(path: &Path) {
    if let Err(error) = ensure(&mut engine(), path, gpu_wanted()) {
        log::warn!("{error}");
    }
}

pub(crate) fn unload() {
    if engine().take().is_some() {
        log::info!("Speech model unloaded");
    }
}

/// Whether a model is loaded and free right now.
#[cfg(test)]
pub(crate) fn is_idle_and_loaded() -> bool {
    ENGINE
        .try_lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
}

/// Releases the model once `UNLOAD_AFTER` passes without another use.
fn schedule_unload() {
    let use_number = USES.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(UNLOAD_AFTER);
        if USES.load(Ordering::SeqCst) == use_number {
            unload();
        }
    });
}

/// Asked by whisper.cpp between computation steps; `true` ends the run.
unsafe extern "C" fn abort_requested(user_data: *mut std::ffi::c_void) -> bool {
    // SAFETY: `transcribe` passes a pointer to a live `AtomicBool`.
    unsafe { &*user_data.cast::<AtomicBool>() }.load(Ordering::Relaxed)
}

/// Joins the segments Whisper returned into one line of text.
pub(crate) fn join_segments<'a>(segments: impl IntoIterator<Item = &'a str>) -> String {
    segments
        .into_iter()
        .flat_map(str::split_whitespace)
        .collect::<Vec<_>>()
        .join(" ")
}

/// One run of the model on an engine.
fn run(
    engine: &mut Engine,
    samples: &[f32],
    vocabulary: &str,
    quality: Quality,
    abort: &Arc<AtomicBool>,
) -> Result<Transcript, RunError> {
    let mut params = FullParams::new(match quality {
        Quality::Final => SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: -1.0,
        },
        Quality::Preview => SamplingStrategy::Greedy { best_of: 1 },
    });
    params.set_language(Some("de"));
    params.set_translate(false);
    // Each recording stands alone; only the vocabulary primes the decoder.
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_single_segment(quality == Quality::Preview);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    params.set_temperature(0.0);
    params.set_n_threads(THREADS);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if !vocabulary.is_empty() {
        params.set_initial_prompt(vocabulary);
    }
    // whisper-rs 0.16's `set_abort_callback_safe` hands whisper.cpp a pointer
    // to a boxed trait object but reads it back as the closure itself, so the
    // callback answers from unrelated memory and aborts runs at random
    // (whisper error -6). Hence the plain callback with our own flag.
    // SAFETY: The user data points to the flag inside `abort`, which the
    // caller keeps alive until `full` has returned.
    unsafe {
        params.set_abort_callback(Some(abort_requested));
        params.set_abort_callback_user_data(Arc::as_ptr(abort).cast_mut().cast());
    }

    let outcome = engine.state.full(params, samples);
    if abort.load(Ordering::Relaxed) {
        return Err(RunError::Cancelled);
    }
    // Error -6 is the encoder, -7 the decoder; whisper.cpp's own message is
    // in the log next to this one.
    outcome.map_err(|error| RunError::Failed(format!("Whisper: {error}")))?;
    let mut texts = Vec::new();
    let mut no_speech = 0.0;
    for segment in engine.state.as_iter() {
        let text = segment
            .to_str_lossy()
            .map_err(|error| RunError::Failed(format!("Whisper: {error}")))?;
        texts.push(text.into_owned());
        no_speech += segment.no_speech_probability();
    }
    let segments = texts.len().max(1) as f32;
    Ok(Transcript {
        text: join_segments(texts.iter().map(String::as_str)),
        no_speech: no_speech / segments,
    })
}

/// Transcribes 16 kHz mono speech as German. `vocabulary` primes the model
/// with the names it should expect. A set `abort` flag ends the run early.
///
/// A final run that fails on the GPU is repeated on the CPU, which is slower
/// but does not depend on the graphics memory other programs leave over.
pub(crate) fn transcribe(
    model: &Path,
    samples: &[f32],
    vocabulary: &str,
    quality: Quality,
    abort: Arc<AtomicBool>,
) -> Result<Transcript, String> {
    let padded = audio::pad_for_whisper(samples.to_vec());
    let mut slot = engine();
    let gpu = gpu_wanted();
    let first = run(
        ensure(&mut slot, model, gpu)?,
        &padded,
        vocabulary,
        quality,
        &abort,
    );
    let outcome = match first {
        Err(RunError::Failed(error)) if gpu && quality == Quality::Final => {
            log::warn!("{error} on the GPU; trying once more on the CPU");
            *slot = None;
            let second = run(
                ensure(&mut slot, model, false)?,
                &padded,
                vocabulary,
                quality,
                &abort,
            );
            if second.is_ok() {
                log::warn!("The CPU run worked; the GPU stays off until the app restarts");
                GPU_GAVE_UP.store(true, Ordering::Relaxed);
            }
            second
        }
        other => other,
    };
    drop(slot);
    if quality == Quality::Final {
        schedule_unload();
    }
    outcome.map_err(|error| match error {
        RunError::Cancelled => "Transcription was cancelled".to_string(),
        RunError::Failed(error) => error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_become_one_line() {
        assert_eq!(
            join_segments([" DUSW Projektmanagement,", " Gigi Call  seit zehn Uhr.\n"]),
            "DUSW Projektmanagement, Gigi Call seit zehn Uhr."
        );
        assert_eq!(join_segments([" ", ""]), "");
    }

    /// Runs a real transcription. Needs a model and a 16 kHz mono 16-bit WAV:
    ///
    /// ```sh
    /// say -v Anna -o /tmp/voice.aiff "DUSW Projektmanagement, Gigi Call seit zehn Uhr"
    /// afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/voice.aiff /tmp/voice.wav
    /// ADVERSUM_VOICE_MODEL=/path/ggml-small.bin ADVERSUM_VOICE_WAV=/tmp/voice.wav \
    ///   cargo test adversum::voice -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "needs a downloaded model and a recording"]
    fn transcribes_a_recording_with_the_vocabulary() {
        let model = std::env::var("ADVERSUM_VOICE_MODEL").expect("ADVERSUM_VOICE_MODEL");
        let wav = std::fs::read(std::env::var("ADVERSUM_VOICE_WAV").expect("ADVERSUM_VOICE_WAV"))
            .unwrap();
        let data = wav
            .windows(4)
            .position(|window| window == b"data")
            .expect("a WAV data chunk")
            + 8;
        let samples: Vec<f32> = wav[data..]
            .chunks_exact(2)
            .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0)
            .collect();
        let vocabulary = std::env::var("ADVERSUM_VOICE_PROMPT").unwrap_or_else(|_| {
            "Zeiterfassung: DUSW, SolarTech NRW, K&K, Projektmanagement, Austausch, Gigi.".into()
        });
        for quality in [Quality::Preview, Quality::Final] {
            let started = std::time::Instant::now();
            let text = transcribe(
                Path::new(&model),
                &samples,
                &vocabulary,
                quality,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
            println!(
                "{:?}: {} (no speech {:.2})",
                started.elapsed(),
                text.text,
                text.no_speech
            );
            assert!(!text.text.is_empty());
        }
        // A preview that is cancelled midway must not spoil the next run:
        // this is what happens when the key is released during a preview.
        for delay_ms in [0_u64, 30, 120, 300] {
            let abort = Arc::new(AtomicBool::new(false));
            let trigger = abort.clone();
            let timer = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                trigger.store(true, Ordering::Relaxed);
            });
            let aborted = transcribe(
                Path::new(&model),
                &samples,
                &vocabulary,
                Quality::Preview,
                abort,
            );
            timer.join().unwrap();
            println!("cancelled after {delay_ms} ms: {aborted:?}");
            let after = transcribe(
                Path::new(&model),
                &samples,
                &vocabulary,
                Quality::Final,
                Arc::new(AtomicBool::new(false)),
            );
            println!("run after the cancelled one: {after:?}");
            assert!(after.is_ok_and(|transcript| !transcript.text.is_empty()));
        }
        assert!(is_idle_and_loaded());
        unload();
        assert!(!is_idle_and_loaded());
    }
}

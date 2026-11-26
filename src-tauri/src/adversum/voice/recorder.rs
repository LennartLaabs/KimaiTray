//! Microphone capture for voice input.
//!
//! The audio stream lives on its own thread for as long as a recording runs,
//! because the stream handle must stay on the thread that created it. The
//! thread collects mono samples at the device's rate and reports the input
//! level a few times per second.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};

use super::audio;

/// A recording stops by itself after this long.
pub(crate) const MAX_SECONDS: usize = 60;
const LEVEL_INTERVAL: Duration = Duration::from_millis(60);
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// Why no recording could be started.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartError {
    NoMicrophone,
    Failed(String),
}

struct Shared {
    samples: Mutex<Vec<f32>>,
    /// The most recent input level as `f32` bits.
    level: AtomicU32,
    full: AtomicBool,
}

impl Shared {
    fn samples(&self) -> std::sync::MutexGuard<'_, Vec<f32>> {
        self.samples
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub(crate) struct Recorder {
    shared: Arc<Shared>,
    sample_rate: u32,
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

fn build_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    shared: Arc<Shared>,
    capacity: usize,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels);
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let floats: Vec<f32> = data
                .iter()
                .map(|sample| f32::from_sample(*sample))
                .collect();
            let mono = audio::downmix(&floats, channels);
            shared
                .level
                .store(audio::meter(audio::rms(&mono)).to_bits(), Ordering::Relaxed);
            let mut samples = shared.samples();
            let room = capacity.saturating_sub(samples.len());
            if room < mono.len() {
                shared.full.store(true, Ordering::Relaxed);
            }
            samples.extend_from_slice(&mono[..mono.len().min(room)]);
        },
        |error| log::warn!("Microphone stream: {error}"),
        None,
    )
}

fn open(shared: &Arc<Shared>) -> Result<(cpal::Stream, u32), StartError> {
    let failed = |error: cpal::Error| StartError::Failed(error.to_string());
    let device = cpal::default_host()
        .default_input_device()
        .ok_or(StartError::NoMicrophone)?;
    let supported = device.default_input_config().map_err(failed)?;
    let sample_rate = supported.sample_rate();
    let capacity = sample_rate as usize * MAX_SECONDS;
    let config = supported.config();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build_stream::<f32>(&device, config, shared.clone(), capacity),
        SampleFormat::I16 => build_stream::<i16>(&device, config, shared.clone(), capacity),
        SampleFormat::U16 => build_stream::<u16>(&device, config, shared.clone(), capacity),
        SampleFormat::I32 => build_stream::<i32>(&device, config, shared.clone(), capacity),
        other => {
            return Err(StartError::Failed(format!(
                "Unsupported microphone sample format: {other}"
            )))
        }
    }
    .map_err(failed)?;
    stream.play().map_err(failed)?;
    Ok((stream, sample_rate))
}

impl Recorder {
    /// Starts recording from the default microphone. `on_level` is called
    /// from the recording thread with the input level (0 to 1) and whether
    /// the maximum length is reached.
    pub(crate) fn start(
        on_level: impl Fn(f32, bool) + Send + 'static,
    ) -> Result<Recorder, StartError> {
        let shared = Arc::new(Shared {
            samples: Mutex::new(Vec::new()),
            level: AtomicU32::new(0),
            full: AtomicBool::new(false),
        });
        let (stop, stopped) = mpsc::channel::<()>();
        let (ready, started) = mpsc::channel::<Result<u32, StartError>>();
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("adversum-voice-recorder".into())
            .spawn(move || {
                let stream = match open(&thread_shared) {
                    Ok((stream, sample_rate)) => {
                        let _ = ready.send(Ok(sample_rate));
                        stream
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                let mut reported_full = false;
                // Ends on the stop signal and when the recorder is dropped.
                while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(LEVEL_INTERVAL) {
                    let full = thread_shared.full.load(Ordering::Relaxed);
                    let level = f32::from_bits(thread_shared.level.load(Ordering::Relaxed));
                    on_level(level, full && !reported_full);
                    reported_full |= full;
                }
                drop(stream);
            })
            .map_err(|error| StartError::Failed(error.to_string()))?;
        match started.recv_timeout(START_TIMEOUT) {
            Ok(Ok(sample_rate)) => Ok(Recorder {
                shared,
                sample_rate,
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(StartError::Failed("The microphone did not start".into())),
        }
    }

    /// What was recorded so far, as 16 kHz mono.
    pub(crate) fn snapshot(&self) -> Vec<f32> {
        let samples = self.shared.samples().clone();
        audio::resample_to_whisper(&samples, self.sample_rate)
    }

    /// Stops the recording and returns it as 16 kHz mono.
    pub(crate) fn finish(mut self) -> Vec<f32> {
        self.halt();
        let samples = std::mem::take(&mut *self.shared.samples());
        audio::resample_to_whisper(&samples, self.sample_rate)
    }

    fn halt(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() {
            // The level callback may be the one ending the recording; a
            // thread cannot wait for itself.
            if thread.thread().id() != std::thread::current().id() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.halt();
    }
}

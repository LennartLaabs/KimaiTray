//! Microphone capture for voice input.
//!
//! The audio stream lives on its own thread for as long as a recording runs,
//! because the stream handle must stay on the thread that created it. The
//! thread keeps the samples exactly as the device delivers them (all
//! channels, device rate) and reports the input level a few times per second.
//! Turning them into what the speech model needs is `audio::prepare`.

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use serde::Serialize;

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

/// The device a recording comes from and the format it delivers.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureInfo {
    pub(crate) device: String,
    pub(crate) sample_rate: u32,
    pub(crate) channels: usize,
    pub(crate) sample_format: String,
}

/// Samples as recorded: interleaved channels at the device's rate.
pub(crate) struct Capture {
    pub(crate) info: CaptureInfo,
    pub(crate) interleaved: Vec<f32>,
}

/// An input device for the settings page.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputDevice {
    /// Stable identifier, stored in the settings.
    id: String,
    name: String,
    /// The one the system uses for input right now.
    is_default: bool,
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
    info: CaptureInfo,
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|description| description.to_string())
        .unwrap_or_else(|_| "unknown device".into())
}

/// The microphones the system offers. Listing them opens none of them.
pub(crate) fn devices() -> Vec<InputDevice> {
    let host = cpal::default_host();
    let default = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());
    let Ok(inputs) = host.input_devices() else {
        return Vec::new();
    };
    inputs
        .filter_map(|device| {
            let id = device.id().ok()?.to_string();
            Some(InputDevice {
                is_default: default.as_deref() == Some(id.as_str()),
                name: device_name(&device),
                id,
            })
        })
        .collect()
}

/// The device with the given identifier; the system's input device when the
/// identifier is empty or no longer exists.
fn find_device(device_id: &str) -> Option<cpal::Device> {
    let host = cpal::default_host();
    if !device_id.is_empty() {
        let chosen = cpal::DeviceId::from_str(device_id)
            .ok()
            .and_then(|id| host.device_by_id(&id));
        if chosen.is_some() {
            return chosen;
        }
        log::warn!("The selected microphone is not connected; using the system input");
    }
    host.default_input_device()
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
            shared.level.store(
                audio::block_meter(&floats, channels).to_bits(),
                Ordering::Relaxed,
            );
            let mut samples = shared.samples();
            let room = capacity.saturating_sub(samples.len());
            if room < floats.len() {
                shared.full.store(true, Ordering::Relaxed);
            }
            samples.extend_from_slice(&floats[..floats.len().min(room)]);
        },
        |error| log::warn!("Microphone stream: {error}"),
        None,
    )
}

fn open(shared: &Arc<Shared>, device_id: &str) -> Result<(cpal::Stream, CaptureInfo), StartError> {
    let failed = |error: cpal::Error| StartError::Failed(error.to_string());
    let device = find_device(device_id).ok_or(StartError::NoMicrophone)?;
    let supported = device.default_input_config().map_err(failed)?;
    let info = CaptureInfo {
        device: device_name(&device),
        sample_rate: supported.sample_rate(),
        channels: usize::from(supported.channels()),
        sample_format: supported.sample_format().to_string(),
    };
    let capacity = info.sample_rate as usize * info.channels * MAX_SECONDS;
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
    Ok((stream, info))
}

impl Recorder {
    /// Starts recording from the given microphone (empty: the system's
    /// input). `on_level` is called from the recording thread with the input
    /// level (0 to 1) and whether the maximum length is reached.
    ///
    /// Must not be called on the main thread: opening the device waits for
    /// CoreAudio, which in turn may wait for the main thread.
    pub(crate) fn start(
        device_id: &str,
        on_level: impl Fn(f32, bool) + Send + 'static,
    ) -> Result<Recorder, StartError> {
        let shared = Arc::new(Shared {
            samples: Mutex::new(Vec::new()),
            level: AtomicU32::new(0),
            full: AtomicBool::new(false),
        });
        let (stop, stopped) = mpsc::channel::<()>();
        let (ready, started) = mpsc::channel::<Result<CaptureInfo, StartError>>();
        let thread_shared = shared.clone();
        let device_id = device_id.to_string();
        let thread = std::thread::Builder::new()
            .name("adversum-voice-recorder".into())
            .spawn(move || {
                let stream = match open(&thread_shared, &device_id) {
                    Ok((stream, info)) => {
                        let _ = ready.send(Ok(info));
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
            Ok(Ok(info)) => Ok(Recorder {
                shared,
                info,
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(StartError::Failed("The microphone did not start".into())),
        }
    }

    pub(crate) fn info(&self) -> &CaptureInfo {
        &self.info
    }

    /// What was recorded so far.
    pub(crate) fn snapshot(&self) -> Capture {
        Capture {
            info: self.info.clone(),
            interleaved: self.shared.samples().clone(),
        }
    }

    /// Stops the recording and returns it.
    pub(crate) fn finish(mut self) -> Capture {
        self.halt();
        Capture {
            info: self.info.clone(),
            interleaved: std::mem::take(&mut *self.shared.samples()),
        }
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

#[cfg(test)]
mod tests {
    use super::devices;
    use cpal::traits::{DeviceTrait, HostTrait};

    #[test]
    fn listing_devices_opens_none_and_marks_at_most_one_default() {
        // Works on a machine without any input device too.
        let list = devices();
        assert!(list.iter().filter(|device| device.is_default).count() <= 1);
        assert!(list.iter().all(|device| !device.id.is_empty()));
    }

    /// Prints the input devices and their formats, without opening them.
    #[test]
    #[ignore = "prints this machine's audio inputs"]
    fn list_input_devices() {
        let host = cpal::default_host();
        for device in host.input_devices().unwrap() {
            println!(
                "input: {:?} id {:?} default config {:?}",
                device.description().map(|d| d.to_string()),
                device.id().map(|id| id.to_string()),
                device.default_input_config(),
            );
        }
        println!("{:?}", devices());
    }
}

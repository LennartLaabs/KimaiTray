//! Sample handling for voice input: from what the microphone delivers to the
//! 16 kHz mono Whisper expects, with a check whether there is speech in it
//! at all, a level for the overlay, and WAV files for diagnosis.

pub(crate) const WHISPER_SAMPLE_RATE: u32 = 16_000;
/// Whisper needs at least a second of audio; shorter input is padded.
const MIN_SAMPLES: usize = WHISPER_SAMPLE_RATE as usize;

/// Root mean square of the samples, 0 for none.
pub(crate) fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

/// A 0 to 1 meter value for a signal level. Speech sits around 0.02 to 0.2
/// RMS, so the scale is logarithmic: -60 dB maps to 0, -10 dB to 1.
pub(crate) fn meter(rms: f32) -> f32 {
    if rms <= 0.0 {
        return 0.0;
    }
    let decibel = 20.0 * rms.log10();
    ((decibel + 60.0) / 50.0).clamp(0.0, 1.0)
}

/// Meter value for a block of interleaved samples as it arrives from the
/// device: the loudest channel, without its constant offset.
pub(crate) fn block_meter(interleaved: &[f32], channels: usize) -> f32 {
    let channels = channels.max(1);
    let loudest = (0..channels)
        .map(|index| {
            let mut samples = channel(interleaved, channels, index);
            clean(&mut samples);
            rms(&samples)
        })
        .fold(0.0, f32::max);
    meter(loudest)
}

/// Converts mono samples to 16 kHz. Downsampling averages each source window
/// (a simple low-pass that is plenty for speech); upsampling interpolates.
pub(crate) fn resample_to_whisper(samples: &[f32], source_rate: u32) -> Vec<f32> {
    if source_rate == WHISPER_SAMPLE_RATE || samples.is_empty() || source_rate == 0 {
        return samples.to_vec();
    }
    let ratio = f64::from(source_rate) / f64::from(WHISPER_SAMPLE_RATE);
    let length = (samples.len() as f64 / ratio).floor() as usize;
    let mut output = Vec::with_capacity(length);
    for index in 0..length {
        let start = index as f64 * ratio;
        if ratio > 1.0 {
            let from = start.floor() as usize;
            let to = (((index + 1) as f64 * ratio).ceil() as usize)
                .min(samples.len())
                .max(from + 1);
            let window = &samples[from..to];
            output.push(window.iter().sum::<f32>() / window.len() as f32);
        } else {
            let left = start.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let fraction = (start - left as f64) as f32;
            output.push(samples[left] * (1.0 - fraction) + samples[right] * fraction);
        }
    }
    output
}

/// Pads short recordings with silence up to the minimum Whisper accepts.
pub(crate) fn pad_for_whisper(mut samples: Vec<f32>) -> Vec<f32> {
    if samples.len() < MIN_SAMPLES {
        samples.resize(MIN_SAMPLES, 0.0);
    }
    samples
}

/// Frames of this length are compared to tell speech from steady noise.
const FRAME: usize = WHISPER_SAMPLE_RATE as usize / 50;
/// The loud frames of a recording must reach this level to count as speech.
const MIN_SPEECH_LEVEL: f32 = 0.001_5;
/// Speech rises and falls; steady noise does not. The loud frames must be
/// this much louder than the quiet ones.
const MIN_SPEECH_DYNAMICS: f32 = 2.5;
/// Quiet recordings are amplified until their peaks reach this level.
const TARGET_PEAK: f32 = 0.5;
const MAX_GAIN: f32 = 60.0;

fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0, |peak, sample| peak.max(sample.abs()))
}

/// One channel of interleaved samples.
pub(crate) fn channel(interleaved: &[f32], channels: usize, index: usize) -> Vec<f32> {
    interleaved
        .iter()
        .skip(index)
        .step_by(channels.max(1))
        .copied()
        .collect()
}

/// Replaces values that are not numbers and removes a constant offset, which
/// cheap USB microphones add and which would pass for a loud signal.
/// Returns the offset.
pub(crate) fn clean(samples: &mut [f32]) -> f32 {
    for sample in samples.iter_mut() {
        if !sample.is_finite() {
            *sample = 0.0;
        }
    }
    if samples.is_empty() {
        return 0.0;
    }
    let offset = samples.iter().sum::<f32>() / samples.len() as f32;
    for sample in samples.iter_mut() {
        *sample -= offset;
    }
    offset
}

/// Level of the quiet and of the loud parts of a recording.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Activity {
    /// Level of the quietest tenth of the frames: the noise floor.
    pub(crate) floor: f32,
    /// Level the loudest twentieth of the frames reaches.
    pub(crate) level: f32,
}

impl Activity {
    /// Whether the recording holds something that rises above its own
    /// background the way speech does.
    pub(crate) fn has_speech(self) -> bool {
        self.level >= MIN_SPEECH_LEVEL && self.level >= self.floor * MIN_SPEECH_DYNAMICS
    }
}

pub(crate) fn activity(samples: &[f32]) -> Activity {
    let mut levels: Vec<f32> = samples.chunks(FRAME).map(rms).collect();
    if levels.is_empty() {
        return Activity {
            floor: 0.0,
            level: 0.0,
        };
    }
    levels.sort_by(f32::total_cmp);
    let at = |fraction: f32| levels[((levels.len() - 1) as f32 * fraction) as usize];
    Activity {
        floor: at(0.10),
        level: at(0.95),
    }
}

/// What was recorded and what became of it, for the log and the settings.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioReport {
    pub(crate) sample_rate: u32,
    pub(crate) channels: usize,
    pub(crate) seconds: f32,
    /// Level of each channel as recorded.
    pub(crate) channel_rms: Vec<f32>,
    pub(crate) channel_peak: Vec<f32>,
    /// The channel that was used, counted from 0.
    pub(crate) used_channel: usize,
    pub(crate) offset: f32,
    pub(crate) noise_floor: f32,
    pub(crate) speech_level: f32,
    pub(crate) has_speech: bool,
    pub(crate) gain: f32,
    /// Level of what goes to the speech model.
    pub(crate) rms: f32,
    pub(crate) peak: f32,
}

pub(crate) struct Prepared {
    /// 16 kHz mono, cleaned and brought to a usable level.
    pub(crate) samples: Vec<f32>,
    pub(crate) report: AudioReport,
}

/// Turns interleaved microphone samples into what Whisper gets.
///
/// Channels are not averaged: one of two channels may be dead, and on some
/// devices they carry the signal with opposite sign and would cancel out.
/// The loudest channel is used instead.
pub(crate) fn prepare(interleaved: &[f32], channels: usize, sample_rate: u32) -> Prepared {
    let channels = channels.max(1);
    let mut best: (usize, f32, Vec<f32>, f32) = (0, -1.0, Vec::new(), 0.0);
    let mut channel_rms = Vec::with_capacity(channels);
    let mut channel_peak = Vec::with_capacity(channels);
    for index in 0..channels {
        let mut samples = channel(interleaved, channels, index);
        channel_rms.push(rms(&samples));
        channel_peak.push(peak(&samples));
        let offset = clean(&mut samples);
        let level = rms(&samples);
        if level > best.1 {
            best = (index, level, samples, offset);
        }
    }
    let (used_channel, _, mono, offset) = best;
    let seconds = if sample_rate == 0 {
        0.0
    } else {
        mono.len() as f32 / sample_rate as f32
    };
    let mut samples = resample_to_whisper(&mono, sample_rate);
    let found = activity(&samples);
    let loudest = peak(&samples);
    let gain = if found.has_speech() && loudest > 0.0 {
        (TARGET_PEAK / loudest).clamp(1.0, MAX_GAIN)
    } else {
        1.0
    };
    for sample in samples.iter_mut() {
        *sample *= gain;
    }
    let report = AudioReport {
        sample_rate,
        channels,
        seconds,
        channel_rms,
        channel_peak,
        used_channel,
        offset,
        noise_floor: found.floor,
        speech_level: found.level,
        has_speech: found.has_speech(),
        gain,
        rms: rms(&samples),
        peak: peak(&samples),
    };
    Prepared { samples, report }
}

/// A WAV file (16-bit PCM) of interleaved samples.
pub(crate) fn wav_bytes(interleaved: &[f32], channels: usize, sample_rate: u32) -> Vec<u8> {
    let channels = channels.clamp(1, usize::from(u16::MAX)) as u16;
    let data_len = (interleaved.len() * 2) as u32;
    let block_align = channels * 2;
    let mut bytes = Vec::with_capacity(44 + interleaved.len() * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&(sample_rate * u32::from(block_align)).to_le_bytes());
    bytes.extend_from_slice(&block_align.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_len.to_le_bytes());
    for sample in interleaved {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// Reads a 16-bit PCM WAV file: interleaved samples, channels, sample rate.
#[cfg(test)]
pub(crate) fn read_wav(bytes: &[u8]) -> Option<(Vec<f32>, usize, u32)> {
    let format = bytes.windows(4).position(|window| window == b"fmt ")? + 8;
    let channels = u16::from_le_bytes(bytes.get(format + 2..format + 4)?.try_into().ok()?);
    let sample_rate = u32::from_le_bytes(bytes.get(format + 4..format + 8)?.try_into().ok()?);
    let data = bytes.windows(4).position(|window| window == b"data")? + 8;
    let samples = bytes[data..]
        .chunks_exact(2)
        .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0)
        .collect();
    Some((samples, usize::from(channels), sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_goes_from_silence_to_full_scale() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
        assert_eq!(meter(0.0), 0.0);
        assert_eq!(meter(0.000_1), 0.0);
        assert!((meter(0.031_6) - 0.6).abs() < 0.01);
        assert_eq!(meter(1.0), 1.0);
    }

    #[test]
    fn common_device_rates_are_brought_to_16_khz() {
        let second_at_48k: Vec<f32> = (0..48_000).map(|i| (i % 3) as f32).collect();
        let resampled = resample_to_whisper(&second_at_48k, 48_000);
        assert_eq!(resampled.len(), 16_000);
        // Each output sample is the mean of three inputs: (0 + 1 + 2) / 3.
        assert!(resampled.iter().all(|sample| (sample - 1.0).abs() < 1e-6));

        let second_at_44k = vec![0.25; 44_100];
        let resampled = resample_to_whisper(&second_at_44k, 44_100);
        assert_eq!(resampled.len(), 16_000);
        assert!(resampled.iter().all(|sample| (sample - 0.25).abs() < 1e-6));

        let untouched = resample_to_whisper(&[0.1, 0.2], 16_000);
        assert_eq!(untouched, [0.1, 0.2]);
        assert!(resample_to_whisper(&[], 48_000).is_empty());
        assert_eq!(resample_to_whisper(&[0.5], 0), [0.5]);
    }

    #[test]
    fn low_rates_are_interpolated_upward() {
        let ramp: Vec<f32> = (0..8_000).map(|i| i as f32).collect();
        let resampled = resample_to_whisper(&ramp, 8_000);
        assert_eq!(resampled.len(), 16_000);
        assert_eq!(resampled[0], 0.0);
        assert!((resampled[1] - 0.5).abs() < 1e-6);
        assert!((resampled[2] - 1.0).abs() < 1e-6);
        assert_eq!(*resampled.last().unwrap(), 7_999.0);
    }

    /// A tone that comes and goes like syllables, at 48 kHz.
    fn syllables(amplitude: f32, seconds: usize) -> Vec<f32> {
        (0..48_000 * seconds)
            .map(|index| {
                let time = index as f32 / 48_000.0;
                let envelope = (time * 3.0 * std::f32::consts::TAU).sin().max(0.0);
                (time * 220.0 * std::f32::consts::TAU).sin() * envelope * amplitude
            })
            .collect()
    }

    fn noise(amplitude: f32, samples: usize) -> Vec<f32> {
        let mut seed = 7_u32;
        (0..samples)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed >> 8) as f32 / 8_388_608.0 - 1.0) * amplitude
            })
            .collect()
    }

    fn interleave(left: &[f32], right: &[f32]) -> Vec<f32> {
        left.iter().zip(right).flat_map(|(l, r)| [*l, *r]).collect()
    }

    #[test]
    fn channels_are_taken_apart_and_cleaned() {
        assert_eq!(channel(&[1.0, 2.0, 3.0, 4.0], 2, 1), [2.0, 4.0]);
        assert_eq!(channel(&[1.0, 2.0], 1, 0), [1.0, 2.0]);
        assert_eq!(channel(&[1.0, 2.0], 0, 0), [1.0, 2.0]);
        let mut samples = [0.5, f32::NAN, 0.5, f32::INFINITY];
        assert_eq!(clean(&mut samples), 0.25);
        assert_eq!(samples, [0.25, -0.25, 0.25, -0.25]);
        assert_eq!(clean(&mut []), 0.0);
    }

    #[test]
    fn speech_is_told_from_silence_and_steady_noise() {
        let speech = prepare(&syllables(0.05, 2), 1, 48_000);
        assert!(speech.report.has_speech);
        assert!((speech.report.seconds - 2.0).abs() < 0.01);
        assert_eq!(speech.samples.len(), 32_000);
        // Brought up to a usable level.
        assert!((speech.report.peak - 0.5).abs() < 0.05);
        assert!(speech.report.gain > 5.0);

        let hiss = prepare(&noise(0.05, 96_000), 1, 48_000);
        assert!(!hiss.report.has_speech);
        assert_eq!(hiss.report.gain, 1.0);
        let silence = prepare(&vec![0.0; 48_000], 1, 48_000);
        assert!(!silence.report.has_speech);
        let nothing = prepare(&[], 2, 0);
        assert!(!nothing.report.has_speech);
        assert_eq!(nothing.report.seconds, 0.0);
        assert_eq!(activity(&[]).level, 0.0);

        // Speech over a noise floor still stands out; very faint speech
        // drowning in it does not.
        let voice = syllables(0.05, 2);
        let noisy: Vec<f32> = voice
            .iter()
            .zip(noise(0.005, voice.len()))
            .map(|(a, b)| a + b)
            .collect();
        assert!(prepare(&noisy, 1, 48_000).report.has_speech);
        assert!(!prepare(&syllables(0.000_5, 2), 1, 48_000).report.has_speech);
    }

    #[test]
    fn the_loudest_channel_is_used_instead_of_a_mix() {
        let voice = syllables(0.2, 1);
        let inverted: Vec<f32> = voice.iter().map(|sample| -sample).collect();
        // Opposite signs cancel in a mix; here the signal survives.
        let cancelling = prepare(&interleave(&voice, &inverted), 2, 48_000);
        assert!(cancelling.report.has_speech);
        assert_eq!(cancelling.report.channels, 2);

        let dead_left = prepare(&interleave(&vec![0.0; voice.len()], &voice), 2, 48_000);
        assert_eq!(dead_left.report.used_channel, 1);
        assert!(dead_left.report.has_speech);
        assert_eq!(dead_left.report.channel_peak[0], 0.0);
        assert!(dead_left.report.channel_rms[1] > 0.05);

        // A constant offset is loud by the numbers but not a signal.
        let offset: Vec<f32> = vec![0.4; voice.len()];
        let with_offset = prepare(&interleave(&offset, &voice), 2, 48_000);
        assert_eq!(with_offset.report.used_channel, 1);
        let only_offset = prepare(&offset, 1, 48_000);
        assert!(!only_offset.report.has_speech);
        assert!((only_offset.report.offset - 0.4).abs() < 1e-3);
    }

    #[test]
    fn the_meter_follows_the_loudest_channel_and_ignores_an_offset() {
        let voice = syllables(0.1, 1);
        let silent = vec![0.0; voice.len()];
        let both = block_meter(&interleave(&silent, &voice), 2);
        assert!((both - block_meter(&voice, 1)).abs() < 1e-6);
        assert!(both > 0.5);
        assert_eq!(block_meter(&vec![0.4; 960], 1), 0.0);
        assert_eq!(block_meter(&[], 0), 0.0);
    }

    #[test]
    fn wav_files_round_trip() {
        let bytes = wav_bytes(&[0.0, 0.5, -0.5, 2.0], 2, 48_000);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(bytes.len(), 44 + 8);
        let (samples, channels, rate) = read_wav(&bytes).unwrap();
        assert_eq!((channels, rate), (2, 48_000));
        assert!((samples[1] - 0.5).abs() < 1e-3);
        assert!((samples[2] + 0.5).abs() < 1e-3);
        // Out-of-range values are clipped, not wrapped.
        assert!(samples[3] > 0.99);
        assert!(read_wav(b"not a wav").is_none());
        assert_eq!(wav_bytes(&[0.1], 0, 16_000)[22], 1);
    }

    #[test]
    fn short_recordings_are_padded_to_a_second() {
        assert_eq!(pad_for_whisper(vec![0.5; 100]).len(), 16_000);
        assert_eq!(pad_for_whisper(vec![0.5; 20_000]).len(), 20_000);
    }
}

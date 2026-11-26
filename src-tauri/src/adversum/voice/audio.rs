//! Sample handling for voice input: mixing to mono, resampling to the
//! 16 kHz Whisper expects, and a level for the recording overlay.

pub(crate) const WHISPER_SAMPLE_RATE: u32 = 16_000;
/// Whisper needs at least a second of audio; shorter input is padded.
const MIN_SAMPLES: usize = WHISPER_SAMPLE_RATE as usize;
/// Below this average level the recording holds no speech.
const SILENCE_RMS: f32 = 0.002;

/// Averages interleaved channels into one.
pub(crate) fn downmix(samples: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

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

pub(crate) fn is_silent(samples: &[f32]) -> bool {
    rms(samples) < SILENCE_RMS
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stereo_is_averaged_and_mono_kept() {
        assert_eq!(downmix(&[0.25, 0.75, -1.0, 1.0], 2), [0.5, 0.0]);
        assert_eq!(downmix(&[0.1, 0.2], 1), [0.1, 0.2]);
        assert_eq!(downmix(&[0.25, 0.5, 0.75], 3), [0.5]);
    }

    #[test]
    fn level_goes_from_silence_to_full_scale() {
        assert_eq!(rms(&[]), 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
        assert_eq!(meter(0.0), 0.0);
        assert_eq!(meter(0.000_1), 0.0);
        assert!((meter(0.031_6) - 0.6).abs() < 0.01);
        assert_eq!(meter(1.0), 1.0);
        assert!(is_silent(&[0.000_5; 100]));
        assert!(!is_silent(&[0.05; 100]));
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

    #[test]
    fn short_recordings_are_padded_to_a_second() {
        assert_eq!(pad_for_whisper(vec![0.5; 100]).len(), 16_000);
        assert_eq!(pad_for_whisper(vec![0.5; 20_000]).len(), 20_000);
    }
}

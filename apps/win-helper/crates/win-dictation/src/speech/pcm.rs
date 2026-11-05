//! PCM conversion (`PCM.swift`) plus the downmix and resampling the mac gets from
//! `AVAudioConverter`: every source (pushed PCM, the WASAPI microphone, decoded files) becomes
//! the recognizer's 16 kHz mono 16-bit stream here.
//!
//! s16 → float divides by 32768 and float → s16 multiplies by 32768, so every Int16 survives a
//! round trip exactly; out-of-range floats clip and NaN becomes silence.

use super::params::{PcmEncoding, PcmFormat};

/// The SAPI desktop recognizer's native input.
pub const ENGINE_RATE: u32 = 16_000;

pub fn f32_from_s16le(data: &[u8]) -> Vec<f32> {
    data.chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

pub fn f32_from_f32le(data: &[u8]) -> Vec<f32> {
    data.chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

pub fn s16_clipping(sample: f32) -> i16 {
    if sample.is_nan() {
        return 0;
    }
    let scaled = (sample * 32768.0).round();
    if scaled >= 32767.0 {
        i16::MAX
    } else if scaled <= -32768.0 {
        i16::MIN
    } else {
        scaled as i16
    }
}

pub fn s16le_from_f32(samples: &[f32]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|&s| s16_clipping(s).to_le_bytes())
        .collect()
}

pub fn f32le_from_f32(samples: &[f32]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

/// Converts between the two PCM encodings (same rate and layout).
pub fn convert(data: &[u8], from: PcmEncoding, to: PcmEncoding) -> Vec<u8> {
    match (from, to) {
        (a, b) if a == b => data.to_vec(),
        (PcmEncoding::S16le, _) => f32le_from_f32(&f32_from_s16le(data)),
        (PcmEncoding::F32le, _) => s16le_from_f32(&f32_from_f32le(data)),
    }
}

pub fn decode(data: &[u8], encoding: PcmEncoding) -> Vec<f32> {
    match encoding {
        PcmEncoding::S16le => f32_from_s16le(data),
        PcmEncoding::F32le => f32_from_f32le(data),
    }
}

/// Interleaved frames → mono by averaging the channels.
pub fn downmix(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Re-frames a byte stream into whole frames, carrying a partial frame over to the next push.
#[derive(Clone, Debug)]
pub struct FrameAligner {
    bytes_per_frame: usize,
    carry: Vec<u8>,
}

impl FrameAligner {
    pub fn new(bytes_per_frame: usize) -> Self {
        FrameAligner {
            bytes_per_frame: bytes_per_frame.max(1),
            carry: vec![],
        }
    }

    pub fn pending(&self) -> usize {
        self.carry.len()
    }

    pub fn append(&mut self, data: &[u8]) -> Vec<u8> {
        let mut bytes = std::mem::take(&mut self.carry);
        bytes.extend_from_slice(data);
        let whole = bytes.len() - bytes.len() % self.bytes_per_frame;
        self.carry = bytes.split_off(whole);
        bytes
    }
}

/// Streaming windowed-sinc resampler for mono audio. Downsampling low-passes at 0.9 × the
/// output Nyquist so 48 kHz microphone audio does not alias into the speech band. Output length
/// tracks `input × out/in` exactly over a stream (no drift between pushes).
#[derive(Clone, Debug)]
pub struct Resampler {
    in_rate: u32,
    out_rate: u32,
    /// Input samples not yet fully consumed (with `taps` samples of history before `pos`).
    buf: Vec<f32>,
    /// Position of the next output sample in input samples, relative to `buf[0]`.
    pos: f64,
    step: f64,
    /// Kernel half-width in input samples: `HALF` output-rate zero crossings.
    taps: usize,
    /// `PHASES` precomputed, normalized kernels of `2 × taps + 1` weights each.
    table: Vec<f32>,
    primed: bool,
}

const HALF: usize = 16;
const PHASES: usize = 256;

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let step = in_rate as f64 / out_rate as f64;
        let cutoff = if out_rate < in_rate {
            0.9 * out_rate as f64 / in_rate as f64
        } else {
            1.0
        };
        let taps = (HALF as f64 / cutoff).ceil() as usize;
        let n = 2 * taps + 1;
        let mut table = vec![0f32; (PHASES + 1) * n];
        for p in 0..=PHASES {
            let frac = p as f64 / PHASES as f64;
            let row: Vec<f64> = (0..n)
                .map(|j| kernel(j as f64 - taps as f64 - frac, cutoff, taps as f64))
                .collect();
            let sum: f64 = row.iter().sum();
            for (j, w) in row.iter().enumerate() {
                table[p * n + j] = (w / sum) as f32;
            }
        }
        Resampler {
            in_rate,
            out_rate,
            buf: vec![],
            pos: 0.0,
            step,
            taps,
            table,
            primed: false,
        }
    }

    pub fn is_passthrough(&self) -> bool {
        self.in_rate == self.out_rate
    }

    /// Feeds input and returns the output samples it completes.
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.is_passthrough() {
            return input.to_vec();
        }
        if !self.primed {
            // Zero history so the first output sample is centred on input 0.
            self.buf = vec![0.0; self.taps];
            self.pos = self.taps as f64;
            self.primed = true;
        }
        self.buf.extend_from_slice(input);
        let mut out = vec![];
        while self.pos + self.taps as f64 + 1.0 < self.buf.len() as f64 {
            out.push(self.sample_at(self.pos));
            self.pos += self.step;
        }
        // Drop input that no future output sample can reach.
        let keep_from = (self.pos.floor() as usize).saturating_sub(self.taps + 1);
        if keep_from > 0 {
            self.buf.drain(..keep_from);
            self.pos -= keep_from as f64;
        }
        out
    }

    /// Flushes the tail at the end of a stream (pads with silence).
    pub fn finish(&mut self) -> Vec<f32> {
        if self.is_passthrough() || !self.primed {
            return vec![];
        }
        let end = self.buf.len() as f64; // one past the last real input sample
        self.buf.extend(std::iter::repeat_n(0.0, self.taps + 2));
        let mut out = vec![];
        while self.pos < end {
            out.push(self.sample_at(self.pos));
            self.pos += self.step;
        }
        self.buf.clear();
        self.primed = false;
        out
    }

    fn sample_at(&self, pos: f64) -> f32 {
        let center = pos.floor() as usize;
        let phase = ((pos - center as f64) * PHASES as f64).round() as usize;
        let n = 2 * self.taps + 1;
        let weights = &self.table[phase * n..(phase + 1) * n];
        // `process`/`finish` keep taps samples on both sides of every position they ask for.
        let window = &self.buf[center - self.taps..=center + self.taps];
        window.iter().zip(weights).map(|(x, w)| x * w).sum()
    }
}

/// Blackman-windowed sinc low-pass at `cutoff` (cycles per input sample × 2) over ±`width`.
fn kernel(x: f64, cutoff: f64, width: f64) -> f64 {
    if x.abs() >= width {
        return 0.0;
    }
    let a = std::f64::consts::PI * x * cutoff;
    let sinc = if x.abs() < 1e-9 { 1.0 } else { a.sin() / a };
    let t = (x / width + 1.0) / 2.0;
    let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * t).cos()
        + 0.08 * (4.0 * std::f64::consts::PI * t).cos();
    cutoff * sinc * w
}

/// Pushed or captured PCM in any accepted format → 16 kHz mono s16le, streaming.
#[derive(Clone, Debug)]
pub struct ToEngine {
    encoding: PcmEncoding,
    channels: usize,
    aligner: FrameAligner,
    resampler: Resampler,
}

impl ToEngine {
    pub fn new(format: PcmFormat) -> Self {
        ToEngine {
            encoding: format.encoding,
            channels: format.channels as usize,
            aligner: FrameAligner::new(format.bytes_per_frame()),
            resampler: Resampler::new(format.sample_rate, ENGINE_RATE),
        }
    }

    pub fn push_bytes(&mut self, data: &[u8]) -> Vec<u8> {
        let whole = self.aligner.append(data);
        let samples = decode(&whole, self.encoding);
        self.push_samples(&samples)
    }

    /// Interleaved float frames in this converter's channel layout.
    pub fn push_samples(&mut self, interleaved: &[f32]) -> Vec<u8> {
        let mono = downmix(interleaved, self.channels);
        s16le_from_f32(&self.resampler.process(&mono))
    }

    pub fn finish(&mut self) -> Vec<u8> {
        s16le_from_f32(&self.resampler.finish())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s16_round_trip_is_exact_for_every_value() {
        let all: Vec<u8> = (i16::MIN..=i16::MAX)
            .flat_map(|v| v.to_le_bytes())
            .collect();
        assert_eq!(s16le_from_f32(&f32_from_s16le(&all)), all);
    }

    #[test]
    fn clipping_nan_and_layout() {
        assert_eq!(s16_clipping(2.0), i16::MAX);
        assert_eq!(s16_clipping(-2.0), i16::MIN);
        assert_eq!(s16_clipping(f32::NAN), 0);
        assert_eq!(s16le_from_f32(&[-1.0 / 32768.0]), [0xFF, 0xFF]);
        assert_eq!(f32_from_s16le(&[0x00, 0x80]), [-1.0]);
        // Odd trailing bytes are ignored.
        assert_eq!(f32_from_s16le(&[0, 0, 7]).len(), 1);
        assert_eq!(f32_from_f32le(&[0, 0, 128, 63, 1]), [1.0]);
    }

    #[test]
    fn f32_cross_conversion() {
        let f = f32le_from_f32(&[0.5, -0.25]);
        let s = convert(&f, PcmEncoding::F32le, PcmEncoding::S16le);
        assert_eq!(s, [0x00, 0x40, 0x00, 0xE0]);
        assert_eq!(convert(&s, PcmEncoding::S16le, PcmEncoding::F32le), f);
    }

    #[test]
    fn downmix_averages_channels() {
        assert_eq!(
            downmix(&[1.0, 0.0, 0.5, 0.5, -1.0, 1.0], 2),
            [0.5, 0.5, 0.0]
        );
        assert_eq!(downmix(&[0.1, 0.2], 1), [0.1, 0.2]);
    }

    #[test]
    fn frame_aligner_carries_partial_frames() {
        let mut a = FrameAligner::new(4);
        assert_eq!(a.append(&[1, 2, 3]), Vec::<u8>::new());
        assert_eq!(a.pending(), 3);
        assert_eq!(a.append(&[4, 5, 6, 7, 8, 9]), [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(a.pending(), 1);
    }

    fn sine(rate: u32, hz: f64, secs: f64) -> Vec<f32> {
        (0..(rate as f64 * secs) as usize)
            .map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin() as f32 * 0.5)
            .collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
    }

    /// Correlation with a reference sine of `hz` at `rate` (phase-free magnitude).
    fn tone(x: &[f32], rate: u32, hz: f64) -> f64 {
        let (mut s, mut c) = (0.0, 0.0);
        for (i, &v) in x.iter().enumerate() {
            let t = 2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64;
            s += v as f64 * t.sin();
            c += v as f64 * t.cos();
        }
        2.0 * (s * s + c * c).sqrt() / x.len() as f64
    }

    #[test]
    fn resampling_keeps_length_pitch_and_level_in_streaming_pieces() {
        for (from, to) in [
            (48_000, 16_000),
            (44_100, 16_000),
            (8_000, 16_000),
            (22_050, 16_000),
        ] {
            let input = sine(from, 440.0, 1.0);
            let mut r = Resampler::new(from, to);
            let mut out = vec![];
            for piece in input.chunks(997) {
                out.extend(r.process(piece));
            }
            out.extend(r.finish());
            let expected = (input.len() as f64 * to as f64 / from as f64).round() as i64;
            assert!(
                (out.len() as i64 - expected).abs() <= 1,
                "{from}->{to}: {} vs {expected}",
                out.len()
            );
            let mid = &out[2000..out.len() - 2000];
            assert!(
                (tone(mid, to, 440.0) - 0.5).abs() < 0.02,
                "{from}->{to} amplitude {}",
                tone(mid, to, 440.0)
            );
            assert!((rms(mid) - 0.5 / 2f64.sqrt()).abs() < 0.02);
        }
    }

    #[test]
    fn downsampling_suppresses_aliases() {
        // 12 kHz cannot exist at 16 kHz output: it must be filtered, not folded to 4 kHz.
        let input = sine(48_000, 12_000.0, 0.5);
        let mut r = Resampler::new(48_000, 16_000);
        let mut out = r.process(&input);
        out.extend(r.finish());
        let mid = &out[500..out.len() - 500];
        assert!(rms(mid) < 0.02, "alias energy {}", rms(mid));
        assert!(tone(mid, 16_000, 4_000.0) < 0.02);
    }

    #[test]
    fn to_engine_converts_stereo_48k_float_pushes() {
        let fmt = PcmFormat {
            encoding: PcmEncoding::F32le,
            sample_rate: 48_000,
            channels: 2,
        };
        let mono = sine(48_000, 300.0, 0.5);
        let stereo: Vec<f32> = mono.iter().flat_map(|&s| [s, s]).collect();
        let bytes = f32le_from_f32(&stereo);
        let mut c = ToEngine::new(fmt);
        let mut out = vec![];
        for piece in bytes.chunks(1001) {
            out.extend(c.push_bytes(piece)); // odd sizes split frames
        }
        out.extend(c.finish());
        assert_eq!(out.len() / 2, 8000);
        let s = f32_from_s16le(&out);
        assert!((tone(&s[1000..7000], 16_000, 300.0) - 0.5).abs() < 0.02);
        // 16 kHz mono s16 passes through untouched.
        let fmt = PcmFormat {
            encoding: PcmEncoding::S16le,
            sample_rate: 16_000,
            channels: 1,
        };
        let raw: Vec<u8> = (0..100i16).flat_map(|v| (v * 300).to_le_bytes()).collect();
        assert_eq!(ToEngine::new(fmt).push_bytes(&raw), raw);
    }
}

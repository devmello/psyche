//! Audio files through Media Foundation's source reader (wav, mp3, m4a/aac, wma, flac, …):
//! duration, and one time range decoded to float and converted to the engine format. The reader
//! decodes on demand, so a 10-minute chunk is never decoded ahead of the engine's needs beyond
//! that chunk.

use super::wide;
use crate::error::{CapError, ErrorCode};
use crate::speech::params::{PcmEncoding, PcmFormat};
use crate::speech::pcm::{ToEngine, f32_from_f32le};
use std::path::Path;
use std::sync::OnceLock;
use windows::Win32::Media::MediaFoundation::{
    IMFMediaBuffer, IMFSample, IMFSourceReader, MF_MT_AUDIO_NUM_CHANNELS, MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE,
    MF_PD_DURATION, MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_MEDIASOURCE,
    MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION, MFAudioFormat_Float, MFCreateMediaType, MFCreateSourceReaderFromURL, MFMediaType_Audio,
    MFSTARTUP_NOSOCKET, MFStartup,
};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Variant::VT_I8;
use windows::core::{GUID, PCWSTR};

fn startup() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        // SAFETY: process-wide MF init, never shut down (the helper keeps using it).
        unsafe {
            let _ = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
        }
    });
}

fn unsupported(path: &Path) -> CapError {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    CapError::new(ErrorCode::InvalidParams, "unsupported_audio", format!("{name} is not an audio file this PC can decode"))
}

const FIRST_AUDIO: u32 = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;

pub(crate) struct AudioFile {
    reader: IMFSourceReader,
    pub rate: u32,
    pub channels: u32,
    pub duration_ms: u64,
}

/// Opens `path` decoding the first audio stream to interleaved float at its native rate.
pub(crate) fn open(path: &Path) -> Result<AudioFile, CapError> {
    startup();
    let w = wide(&path.to_string_lossy());
    // SAFETY: MF source reader setup on a COM-initialized thread.
    unsafe {
        let reader: IMFSourceReader = MFCreateSourceReaderFromURL(PCWSTR(w.as_ptr()), None).map_err(|_| unsupported(path))?;
        let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
        reader.SetStreamSelection(FIRST_AUDIO, true).map_err(|_| unsupported(path))?;
        let mt = MFCreateMediaType().map_err(|_| unsupported(path))?;
        mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|_| unsupported(path))?;
        mt.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float).map_err(|_| unsupported(path))?;
        reader.SetCurrentMediaType(FIRST_AUDIO, None, &mt).map_err(|_| unsupported(path))?;
        let cur = reader.GetCurrentMediaType(FIRST_AUDIO).map_err(|_| unsupported(path))?;
        let rate = cur.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).map_err(|_| unsupported(path))?;
        let channels = cur.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).map_err(|_| unsupported(path))?;
        if rate == 0 || channels == 0 {
            return Err(CapError::new(ErrorCode::InvalidParams, "unsupported_audio", "The audio has no sample rate"));
        }
        let pv = reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION).map_err(|_| unsupported(path))?;
        let hns = pv.Anonymous.Anonymous.Anonymous.uhVal;
        Ok(AudioFile { reader, rate, channels, duration_ms: (hns + 5_000) / 10_000 })
    }
}

impl AudioFile {
    /// `from_ms..to_ms` as 16 kHz mono s16le. Frames are trimmed by sample timestamps, so a seek
    /// that lands early (compressed formats seek to a packet) costs no accuracy.
    pub fn read_range(&self, from_ms: u64, to_ms: u64, cancelled: &dyn Fn() -> bool) -> Result<Vec<u8>, CapError> {
        let rate = self.rate as u64;
        let ch = self.channels as usize;
        let from_frame = from_ms * rate / 1000;
        let to_frame = to_ms * rate / 1000;
        let mut conv = ToEngine::new(PcmFormat { encoding: PcmEncoding::F32le, sample_rate: self.rate, channels: self.channels.min(2) });
        let mut out = Vec::with_capacity(((to_ms - from_ms.min(to_ms)) * 32) as usize);
        // SAFETY: MF reads on the thread that opened the reader; buffers are unlocked after use.
        unsafe {
            let mut pos = PROPVARIANT::default();
            (*pos.Anonymous.Anonymous).vt = VT_I8;
            (*pos.Anonymous.Anonymous).Anonymous.hVal = (from_ms * 10_000) as i64;
            self.reader.SetCurrentPosition(&GUID::zeroed(), &pos).map_err(|e| crate::error::win_err("unsupported_audio", "Seeking in the audio failed", &e))?;
            let mut next_frame: Option<u64> = None;
            loop {
                if cancelled() {
                    return Err(CapError::cancelled());
                }
                let mut flags = 0u32;
                let mut ts = 0i64;
                let mut sample: Option<IMFSample> = None;
                self.reader
                    .ReadSample(FIRST_AUDIO, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut sample))
                    .map_err(|e| crate::error::win_err("unsupported_audio", "Decoding the audio failed", &e))?;
                if let Some(sample) = sample {
                    let buf: IMFMediaBuffer = sample.ConvertToContiguousBuffer().map_err(|e| crate::error::win_err("unsupported_audio", "Decoding the audio failed", &e))?;
                    let mut p: *mut u8 = std::ptr::null_mut();
                    let mut len = 0u32;
                    buf.Lock(&mut p, None, Some(&mut len)).map_err(|e| crate::error::win_err("unsupported_audio", "Decoding the audio failed", &e))?;
                    let floats = f32_from_f32le(std::slice::from_raw_parts(p, len as usize));
                    let _ = buf.Unlock();
                    let frames = floats.len() / ch;
                    // Timestamps place the first sample; afterwards frames are contiguous.
                    let start = next_frame.unwrap_or(((ts.max(0) as u64) * rate + 5_000_000) / 10_000_000);
                    next_frame = Some(start + frames as u64);
                    let lo = from_frame.saturating_sub(start).min(frames as u64) as usize;
                    let hi = to_frame.saturating_sub(start).min(frames as u64) as usize;
                    if hi > lo {
                        let slice = &floats[lo * ch..hi * ch];
                        let stereo_or_mono: Vec<f32> = if ch > 2 {
                            // Keep the first two channels (front left/right) for >2-channel files.
                            slice.chunks_exact(ch).flat_map(|f| [f[0], f[1]]).collect()
                        } else {
                            slice.to_vec()
                        };
                        out.extend(conv.push_samples(&stereo_or_mono));
                    }
                    if start + frames as u64 >= to_frame {
                        break;
                    }
                }
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    break;
                }
            }
        }
        out.extend(conv.finish());
        Ok(out)
    }
}

//! Microphone capture with WASAPI (shared mode, event-driven) for the on-device engine. Audio
//! arrives as interleaved float at the device's mix rate and channel count; the pipeline
//! downmixes and resamples it. Microphone privacy denial surfaces as E_ACCESSDENIED from
//! `Activate`/`Initialize` and maps to `permission_missing(microphone)`.

use super::Com;
use crate::error::{CapError, Permission, win_err};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::channel;
use std::thread::JoinHandle;
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, WAIT_OBJECT_0};

/// HRESULT_FROM_WIN32(ERROR_NOT_FOUND): no capture endpoint.
const E_NOTFOUND: windows::core::HRESULT = windows::core::HRESULT(0x8007_0490_u32 as i32);
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IAudioCaptureClient, IAudioClient,
    IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, eCapture, eConsole,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CaptureFormat {
    pub rate: u32,
    pub channels: u32,
}

pub(crate) struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    pub fn stopper(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn map(e: &windows::core::Error) -> CapError {
    if e.code() == E_ACCESSDENIED {
        CapError::permission_missing(Permission::Microphone)
    } else if e.code() == E_NOTFOUND {
        CapError::unavailable("no_input_device", "No microphone is available")
    } else {
        win_err(
            "microphone_start_failed",
            "The microphone could not be started",
            e,
        )
        .retryable()
    }
}

/// Starts capturing the default microphone. `on_audio(interleaved, format)` runs on the capture
/// thread and returns false to stop; `on_end()` runs once when capture ends (stop, device gone
/// or error).
pub(crate) fn start(
    mut on_audio: impl FnMut(&[f32], CaptureFormat) -> bool + Send + 'static,
    on_end: impl FnOnce() + Send + 'static,
) -> Result<Capture, CapError> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = channel::<Result<CaptureFormat, CapError>>();
    let stop2 = stop.clone();
    let thread = std::thread::Builder::new()
        .name("psyche-mic".into())
        .spawn(move || {
            let _com = Com::init();
            // SAFETY: WASAPI setup and capture on this thread.
            let setup = unsafe { open() };
            let (client, capture, event, format) = match setup {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    on_end();
                    return;
                }
            };
            let _ = ready_tx.send(Ok(format));
            let ch = format.channels as usize;
            let mut buf: Vec<f32> = vec![];
            // SAFETY: capture loop on the client this thread initialized.
            unsafe {
                'outer: while !stop2.load(Ordering::SeqCst) {
                    if WaitForSingleObject(event, 100) != WAIT_OBJECT_0 {
                        continue;
                    }
                    loop {
                        let n = match capture.GetNextPacketSize() {
                            Ok(n) => n,
                            Err(_) => break 'outer, // device invalidated: end of input
                        };
                        if n == 0 {
                            break;
                        }
                        let mut data: *mut u8 = std::ptr::null_mut();
                        let mut frames = 0u32;
                        let mut flags = 0u32;
                        if let Err(e) =
                            capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                        {
                            if e.code() == AUDCLNT_E_DEVICE_INVALIDATED {
                                break 'outer;
                            }
                            break;
                        }
                        let count = frames as usize * ch;
                        buf.clear();
                        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                            buf.resize(count, 0.0);
                        } else {
                            buf.extend_from_slice(std::slice::from_raw_parts(
                                data as *const f32,
                                count,
                            ));
                        }
                        let _ = capture.ReleaseBuffer(frames);
                        if !on_audio(&buf, format) {
                            break 'outer;
                        }
                    }
                }
                let _ = client.Stop();
                let _ = CloseHandle(event);
            }
            on_end();
        })
        .map_err(|e| CapError::internal(format!("cannot start microphone capture: {e}")))?;
    match ready_rx.recv() {
        Ok(Ok(_)) => Ok(Capture {
            stop,
            thread: Some(thread),
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err(CapError::internal("microphone capture thread exited")),
    }
}

unsafe fn open() -> Result<
    (
        IAudioClient,
        IAudioCaptureClient,
        windows::Win32::Foundation::HANDLE,
        CaptureFormat,
    ),
    CapError,
> {
    // SAFETY: standard WASAPI shared-mode capture setup.
    unsafe {
        let en: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| map(&e))?;
        let device = en
            .GetDefaultAudioEndpoint(eCapture, eConsole)
            .map_err(|e| map(&e))?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(|e| map(&e))?;
        let mix = client.GetMixFormat().map_err(|e| map(&e))?;
        let (rate, channels) = ((*mix).nSamplesPerSec, (*mix).nChannels as u32);
        CoTaskMemFree(Some(mix as *const _));
        let channels = channels.clamp(1, 2);
        // Float at the device rate; AUTOCONVERTPCM lets the engine convert from its mix format.
        let fmt = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: channels as u16,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * channels * 4,
            nBlockAlign: (channels * 4) as u16,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &fmt, None)
            .map_err(|e| map(&e))?;
        let event = CreateEventW(None, false, false, None).map_err(|e| map(&e))?;
        client.SetEventHandle(event).map_err(|e| map(&e))?;
        let capture: IAudioCaptureClient = client.GetService().map_err(|e| map(&e))?;
        client.Start().map_err(|e| map(&e))?;
        Ok((client, capture, event, CaptureFormat { rate, channels }))
    }
}

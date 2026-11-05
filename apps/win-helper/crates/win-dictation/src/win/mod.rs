//! Live Windows side: UI Automation, SendInput, the clipboard, the low-level keyboard hook,
//! SAPI, Windows.Media.SpeechRecognition, WASAPI, Media Foundation and the privacy settings.

pub(crate) mod clipboard;
pub(crate) mod dictation;
pub(crate) mod hook;
pub(crate) mod input;
pub(crate) mod layout;
pub(crate) mod media;
pub(crate) mod privacy;
pub(crate) mod process;
pub(crate) mod sapi;
pub(crate) mod wasapi;
pub(crate) mod winrt_speech;

use std::sync::OnceLock;
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoIncrementMTAUsage, CoInitializeEx};

/// COM for the current thread (MTA). The process-wide MTA is pinned once with
/// `CoIncrementMTAUsage` and threads are never uninitialized: windows-rs caches WinRT activation
/// factories per process, and tearing the MTA down under them would leave dangling proxies. A
/// thread the core already made STA keeps its apartment (RPC_E_CHANGED_MODE is not an error).
pub(crate) struct Com;

impl Com {
    pub fn init() -> Com {
        static MTA: OnceLock<()> = OnceLock::new();
        MTA.get_or_init(|| {
            // SAFETY: keeps the MTA alive for the process; the cookie is intentionally leaked.
            let _ = unsafe { CoIncrementMTAUsage() };
        });
        // SAFETY: plain COM initialization for this thread.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Com
    }
}

/// UTF-16, NUL-terminated.
pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

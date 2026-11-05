//! `speech.*`: speech-to-text (`transcribe_stream`, `transcribe_file`, `audio_push`, `stop`,
//! `status`), served by `psyche_win_dictation` through the `dictation` adapter. No
//! text-to-speech (owner decision).
//!
//! Privacy: the mac helper never sends audio off the device, so every source uses the on-device
//! SAPI recognizer by default (`speech.status` reports `defaultEngine: "sapi"`). Windows online
//! dictation (`windowsSpeech`) runs only when the caller passes `engine: "windowsSpeech"`.

use crate::node::CapabilityRegistry;

pub fn register(reg: &mut CapabilityRegistry) {
    crate::dictation::register_prefix(reg, "speech.");
}

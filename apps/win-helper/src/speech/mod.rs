//! `speech.*` (wave 2): speech-to-text (`transcribe_stream`, `transcribe_file`, `audio_push`,
//! `stop`, `status`). No text-to-speech (owner decision). Registers nothing yet.

use crate::node::CapabilityRegistry;

pub fn register(_reg: &mut CapabilityRegistry) {}

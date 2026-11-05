//! Recent stream timings; `speech.status` reports the median of the last `window`
//! (`SpeechTimings.swift`, wire `HelperSpeechTimings`).

use super::params::SpeechPreset;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Metric {
    /// Stream start → first non-empty result.
    FirstPartial(SpeechPreset),
    /// End of input → the engine's last final.
    Finalize(SpeechPreset),
}

pub struct Timings {
    window: usize,
    samples: Mutex<HashMap<Metric, Vec<u64>>>,
}

impl Default for Timings {
    fn default() -> Self {
        Timings::new(20)
    }
}

impl Timings {
    pub fn new(window: usize) -> Self {
        Timings { window: window.max(1), samples: Mutex::new(HashMap::new()) }
    }

    pub fn record(&self, m: Metric, ms: u64) {
        let mut s = self.samples.lock().unwrap_or_else(|e| e.into_inner());
        let xs = s.entry(m).or_default();
        xs.push(ms);
        if xs.len() > self.window {
            let extra = xs.len() - self.window;
            xs.drain(..extra);
        }
    }

    pub fn median(&self, m: Metric) -> Option<u64> {
        let mut xs = self.samples.lock().unwrap_or_else(|e| e.into_inner()).get(&m).cloned().unwrap_or_default();
        if xs.is_empty() {
            return None;
        }
        xs.sort_unstable();
        let n = xs.len();
        Some(if n % 2 == 1 { xs[n / 2] } else { (xs[n / 2 - 1] + xs[n / 2]) / 2 })
    }

    /// Only measured metrics appear.
    pub fn json(&self) -> Value {
        let mut o = Map::new();
        let pair = |f: fn(SpeechPreset) -> Metric| {
            let mut p = Map::new();
            if let Some(m) = self.median(f(SpeechPreset::Long)) {
                p.insert("long".into(), json!(m));
            }
            if let Some(m) = self.median(f(SpeechPreset::Short)) {
                p.insert("short".into(), json!(m));
            }
            (!p.is_empty()).then_some(Value::Object(p))
        };
        if let Some(p) = pair(Metric::FirstPartial) {
            o.insert("firstPartialMs".into(), p);
        }
        if let Some(p) = pair(Metric::Finalize) {
            o.insert("finalizeMs".into(), p);
        }
        Value::Object(o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn medians_over_a_window() {
        let t = Timings::new(3);
        assert_eq!(t.json(), json!({}));
        for ms in [100, 300, 200, 900] {
            t.record(Metric::FirstPartial(SpeechPreset::Long), ms);
        }
        assert_eq!(t.median(Metric::FirstPartial(SpeechPreset::Long)), Some(300));
        t.record(Metric::Finalize(SpeechPreset::Short), 40);
        t.record(Metric::Finalize(SpeechPreset::Short), 60);
        assert_eq!(t.json(), json!({"firstPartialMs": {"long": 300}, "finalizeMs": {"short": 50}}));
    }
}

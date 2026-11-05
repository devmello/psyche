//! Structured, content-free logging (architecture §14, ADR-017): phases, names, sizes and outcomes
//! only, never params, results, notification text or secrets. Lines go to stderr and are appended
//! to `$PSYCHE_HOME/logs/helper.log` (rotated to `helper.log.1` past 5 MB).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use super::time::iso8601_millis_now;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

type Echo = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct HelperLog {
    file: Option<Arc<Mutex<PathBuf>>>,
    echo: Echo,
}

impl std::fmt::Debug for HelperLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HelperLog").finish_non_exhaustive()
    }
}

impl HelperLog {
    /// Logs to stderr and to `log_file` (created with its directory on first write).
    pub fn new(log_file: Option<PathBuf>) -> Self {
        HelperLog {
            file: log_file.map(|p| Arc::new(Mutex::new(p))),
            echo: Arc::new(|line| eprintln!("psyche-helper: {line}")),
        }
    }

    /// No output at all (tests, `--manifest`).
    pub fn quiet() -> Self {
        HelperLog {
            file: None,
            echo: Arc::new(|_| {}),
        }
    }

    /// Captures lines with a closure (tests).
    pub fn with_echo(echo: impl Fn(&str) + Send + Sync + 'static) -> Self {
        HelperLog {
            file: None,
            echo: Arc::new(echo),
        }
    }

    pub fn info(&self, message: impl AsRef<str>) {
        self.write("info", message.as_ref());
    }

    pub fn error(&self, message: impl AsRef<str>) {
        self.write("error", message.as_ref());
    }

    fn write(&self, level: &str, message: &str) {
        (self.echo)(message);
        let Some(file) = &self.file else { return };
        let Ok(path) = file.lock() else { return };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if fs::metadata(&*path)
            .map(|m| m.len() > MAX_LOG_BYTES)
            .unwrap_or(false)
        {
            let _ = fs::rename(&*path, path.with_extension("log.1"));
        }
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&*path) {
            let _ = writeln!(f, "{} {level} {message}", iso8601_millis_now());
        }
    }
}

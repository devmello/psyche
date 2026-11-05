//! Content-free logs (phases, names, sizes, outcomes; never params, paths of user files or guest
//! output) on stderr and, for the service, in `%ProgramData%\Psyche\vm-service\<sid>.log`
//! (rotated at 5 MB; written as LocalSystem into a SYSTEM-owned folder).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
const MAX_BYTES: u64 = 5 << 20;

pub fn init_file(path: PathBuf) {
    *FILE.lock().unwrap() = Some(path);
}

fn write(level: &str, msg: &str) {
    let line = format!("{} {level} {msg}\n", crate::model::now_iso());
    let _ = std::io::stderr().write_all(line.as_bytes());
    let guard = FILE.lock().unwrap();
    if let Some(path) = guard.as_ref() {
        crate::security::as_service(|| {
            if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
                let _ = std::fs::rename(path, path.with_extension("log.1"));
            }
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = f.write_all(line.as_bytes());
            }
        });
    }
}

pub fn info(msg: &str) {
    write("info", msg)
}

pub fn warn(msg: &str) {
    write("warn", msg)
}

pub fn error(msg: &str) {
    write("error", msg)
}

//! Children that must not outlive the helper, and checks on who answers a socket.
//!
//! `PR_SET_PDEATHSIG` fires when the *thread* that forked the child exits, not the process
//! (prctl(2)). The helper runs every capability call on its own short-lived thread, so a server
//! forked there was killed the moment that call returned. `spawn_tied` therefore forks every
//! such child from one thread that lives as long as the process: the signal then fires only when
//! the helper itself goes away. After the prctl the child checks `getppid()`, so a helper that
//! died between fork and prctl does not leave the child behind.

use std::io;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::sync::OnceLock;

type Job = Box<dyn FnOnce() + Send>;

/// The spawner thread's queue. The thread runs until the process exits: the sender lives in a
/// static, so its receive loop never ends.
fn spawner() -> io::Result<&'static mpsc::Sender<Job>> {
    static SPAWNER: OnceLock<Result<mpsc::Sender<Job>, String>> = OnceLock::new();
    SPAWNER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("vscreen-spawner".into())
                .spawn(move || {
                    // A panicking job must not end this thread: its exit would SIGKILL every
                    // tied child.
                    for job in rx {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                    }
                })
                .map(|_| tx)
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| io::Error::other(format!("spawner thread: {e}")))
}

/// Starts `cmd` from the process-lifetime spawner thread, with `PR_SET_PDEATHSIG = SIGKILL`, so
/// the child dies with the helper and only with the helper.
pub fn spawn_tied(mut cmd: Command) -> io::Result<Child> {
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: only async-signal-safe calls (prctl, getppid) between fork and exec, and the error
    // is built without allocating.
    unsafe {
        cmd.pre_exec(move || {
            #[cfg(target_os = "linux")]
            {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(io::Error::last_os_error());
                }
                // The helper exited between fork and prctl: nobody would ever kill this child.
                if libc::getppid() != parent {
                    return Err(io::Error::from_raw_os_error(libc::ESRCH));
                }
            }
            #[cfg(not(target_os = "linux"))]
            let _ = parent;
            Ok(())
        });
    }
    let (tx, rx) = mpsc::channel();
    spawner()?
        .send(Box::new(move || {
            let _ = tx.send(cmd.spawn());
        }))
        .map_err(|_| io::Error::other("the spawner thread is gone"))?;
    rx.recv()
        .map_err(|_| io::Error::other("the spawner thread dropped the request"))?
}

/// The pid and uid of the process that listens on the other end of `stream`.
#[cfg(target_os = "linux")]
pub fn peer_of(stream: &UnixStream) -> io::Result<(u32, u32)> {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `cred` and `len` are valid for writes of the sizes passed.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((cred.pid as u32, cred.uid))
}

#[cfg(not(target_os = "linux"))]
pub fn peer_of(_stream: &UnixStream) -> io::Result<(u32, u32)> {
    Err(io::Error::other("peer credentials are only read on Linux"))
}

/// Accepts `stream` only when the server behind it is `pid` and runs as this user. Another
/// account that bound the same display or bus name first is refused.
pub fn check_peer(stream: &UnixStream, pid: u32) -> Result<(), String> {
    let (peer_pid, peer_uid) = peer_of(stream).map_err(|e| format!("peer credentials: {e}"))?;
    // SAFETY: geteuid has no preconditions.
    let euid = unsafe { libc::geteuid() };
    if peer_pid != pid || peer_uid != euid {
        return Err(format!(
            "the server is pid {peer_pid} uid {peer_uid}, expected pid {pid} uid {euid}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::time::Duration;

    #[test]
    fn a_child_started_from_a_short_lived_thread_outlives_that_thread() {
        let handle = std::thread::spawn(|| {
            let mut cmd = Command::new("sleep");
            cmd.arg("30");
            spawn_tied(cmd).expect("spawn sleep")
        });
        let mut child = handle.join().expect("the thread ran");
        // The thread that asked is gone. With PDEATHSIG bound to it the kernel would have sent
        // SIGKILL by now.
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            matches!(child.try_wait(), Ok(None)),
            "the child is still running after the asking thread exited"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn a_failed_spawn_comes_back_as_an_error() {
        let cmd = Command::new("/nonexistent/psyche-no-such-program");
        assert!(spawn_tied(cmd).is_err());
    }

    #[test]
    fn the_peer_check_accepts_only_the_expected_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s");
        let listener = UnixListener::bind(&path).unwrap();
        let stream = UnixStream::connect(&path).unwrap();
        let _accepted = listener.accept().unwrap();
        let me = std::process::id();
        assert_eq!(check_peer(&stream, me), Ok(()));
        assert!(check_peer(&stream, me + 1).is_err());
    }
}

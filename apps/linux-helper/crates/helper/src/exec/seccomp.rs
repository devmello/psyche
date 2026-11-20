//! The contained shell's seccomp filter when a command has the network (owner decision D2 on
//! #1512): no `AF_UNIX` socket can be made, so nothing reaches a unix socket outside the
//! sandbox. With the network on the sandbox shares the host's network namespace, and with it
//! every abstract socket (an X server's `@/tmp/.X11-unix/X0`, D-Bus, IDE helpers); a path socket
//! on the read-only root is still connectable too, since a read-only mount never stops
//! `connect()`. Blocking the socket call blocks both.
//!
//! - `socket(AF_UNIX, …)` fails with `EACCES`. `socketpair()` is a different call and works
//!   (pipes between a command's own processes: `make -j`, Python's `multiprocessing`).
//! - `io_uring_setup`, `io_uring_enter` and `io_uring_register` fail with `ENOSYS`: io_uring can
//!   make and connect sockets without the `socket` call. Programs fall back to plain calls.
//! - Calls of another ABI (32-bit, x32) kill the process: their numbers differ and would slip
//!   past the checks above.
//!
//! Classic BPF, as `bwrap --seccomp FD` reads it (an array of `struct sock_filter`).

/// `struct sock_filter`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Insn {
    pub code: u16,
    pub jt: u8,
    pub jf: u8,
    pub k: u32,
}

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_JMP_JGE_K: u16 = 0x35;
const BPF_RET_K: u16 = 0x06;

pub const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
pub const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
pub const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;

/// `struct seccomp_data` offsets.
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
/// The low 32 bits of `args[0]` (both supported ABIs are little-endian).
const OFF_ARG0: u32 = 16;

const AF_UNIX: u32 = 1;
const EACCES: u32 = 13;
const ENOSYS: u32 = 38;

/// The native ABI's audit arch, the `socket` call and the x32 bit, or `None` where the helper
/// has no filter for this CPU (the caller then refuses the network rather than run it open).
struct Abi {
    arch: u32,
    socket: u32,
    x32_bit: Option<u32>,
}

fn abi() -> Option<Abi> {
    if cfg!(target_arch = "x86_64") {
        Some(Abi {
            arch: 0xC000_003E,
            socket: 41,
            x32_bit: Some(0x4000_0000),
        })
    } else if cfg!(target_arch = "aarch64") {
        Some(Abi {
            arch: 0xC000_00B7,
            socket: 198,
            x32_bit: None,
        })
    } else {
        None
    }
}

/// io_uring's three calls: the same numbers on every Linux ABI since 5.1.
const IO_URING: [u32; 3] = [425, 426, 427];

fn ld(k: u32) -> Insn {
    Insn {
        code: BPF_LD_W_ABS,
        jt: 0,
        jf: 0,
        k,
    }
}
fn jeq(k: u32, jt: u8, jf: u8) -> Insn {
    Insn {
        code: BPF_JMP_JEQ_K,
        jt,
        jf,
        k,
    }
}
fn jge(k: u32, jt: u8, jf: u8) -> Insn {
    Insn {
        code: BPF_JMP_JGE_K,
        jt,
        jf,
        k,
    }
}
fn ret(k: u32) -> Insn {
    Insn {
        code: BPF_RET_K,
        jt: 0,
        jf: 0,
        k,
    }
}

/// The filter, or `None` on a CPU the helper has no filter for.
pub fn program() -> Option<Vec<Insn>> {
    let abi = abi()?;
    let mut p = vec![
        ld(OFF_ARCH),
        jeq(abi.arch, 1, 0),
        ret(SECCOMP_RET_KILL_PROCESS),
        ld(OFF_NR),
    ];
    if let Some(bit) = abi.x32_bit {
        p.push(jge(bit, 0, 1));
        p.push(ret(SECCOMP_RET_KILL_PROCESS));
    }
    for nr in IO_URING {
        p.push(jeq(nr, 0, 1));
        p.push(ret(SECCOMP_RET_ERRNO | ENOSYS));
    }
    // Not `socket`: allowed. `socket(AF_UNIX, …)`: refused.
    p.push(jeq(abi.socket, 0, 3));
    p.push(ld(OFF_ARG0));
    p.push(jeq(AF_UNIX, 0, 1));
    p.push(ret(SECCOMP_RET_ERRNO | EACCES));
    p.push(ret(SECCOMP_RET_ALLOW));
    Some(p)
}

/// The filter as the bytes `bwrap --seccomp` reads.
pub fn bytes(program: &[Insn]) -> Vec<u8> {
    let mut out = Vec::with_capacity(program.len() * 8);
    for i in program {
        out.extend_from_slice(&i.code.to_ne_bytes());
        out.push(i.jt);
        out.push(i.jf);
        out.extend_from_slice(&i.k.to_ne_bytes());
    }
    out
}

/// A pipe holding the filter, its read end left for `bwrap` (close-on-exec set; the caller
/// clears it in the child only).
#[cfg(target_os = "linux")]
pub fn pipe_with(program: &[Insn]) -> std::io::Result<std::os::fd::OwnedFd> {
    use std::io::Write as _;
    use std::os::fd::{FromRawFd, OwnedFd};
    let data = bytes(program);
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: fills two descriptors on success.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: both were just opened and are owned here only.
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    // A filter is a few hundred bytes: far below a pipe's buffer, so this never blocks.
    let mut w = std::fs::File::from(write);
    w.write_all(&data)?;
    drop(w);
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the filter the way the kernel does, for one call.
    fn eval(p: &[Insn], arch: u32, nr: u32, arg0: u32) -> u32 {
        let mut pc = 0usize;
        let mut acc = 0u32;
        loop {
            let i = p[pc];
            match i.code {
                BPF_LD_W_ABS => {
                    acc = match i.k {
                        OFF_NR => nr,
                        OFF_ARCH => arch,
                        OFF_ARG0 => arg0,
                        _ => panic!("load at {}", i.k),
                    };
                    pc += 1;
                }
                BPF_JMP_JEQ_K => {
                    pc += 1 + usize::from(if acc == i.k { i.jt } else { i.jf });
                }
                BPF_JMP_JGE_K => {
                    pc += 1 + usize::from(if acc >= i.k { i.jt } else { i.jf });
                }
                BPF_RET_K => return i.k,
                c => panic!("op {c:#x}"),
            }
        }
    }

    #[test]
    fn the_filter_refuses_unix_sockets_and_io_uring_and_allows_the_rest() {
        let Some(p) = program() else { return };
        let abi = abi().unwrap();
        let errno = |e: u32| SECCOMP_RET_ERRNO | e;
        // (nr, arg0, verdict)
        let must_refuse = [
            (abi.socket, AF_UNIX, errno(EACCES)),
            (425, 0, errno(ENOSYS)),
            (426, 0, errno(ENOSYS)),
            (427, 0, errno(ENOSYS)),
        ];
        for (nr, arg0, want) in must_refuse {
            assert_eq!(eval(&p, abi.arch, nr, arg0), want, "nr {nr} arg0 {arg0}");
        }
        let af_inet = 2;
        let af_inet6 = 10;
        let af_netlink = 16;
        let socketpair = if cfg!(target_arch = "x86_64") {
            53
        } else {
            199
        };
        let connect = if cfg!(target_arch = "x86_64") {
            42
        } else {
            203
        };
        let must_allow = [
            (abi.socket, af_inet),
            (abi.socket, af_inet6),
            (abi.socket, af_netlink),
            (socketpair, AF_UNIX),
            (connect, 3),
            (0, 0),
            (63, 0),
        ];
        for (nr, arg0) in must_allow {
            assert_eq!(eval(&p, abi.arch, nr, arg0), SECCOMP_RET_ALLOW, "nr {nr}");
        }
        // Another ABI dies, whatever it calls.
        assert_eq!(
            eval(&p, 0x4000_0003, abi.socket, AF_UNIX),
            SECCOMP_RET_KILL_PROCESS
        );
        if let Some(bit) = abi.x32_bit {
            assert_eq!(eval(&p, abi.arch, bit | 41, 1), SECCOMP_RET_KILL_PROCESS);
        }
        assert_eq!(bytes(&p).len(), p.len() * 8);
    }
}

/**
 * Fixed helper programs that run INSIDE the container. Each is passed as one `bash -c` /
 * `python3 -c` argument and receives its inputs as positional parameters or on stdin, so
 * nothing the agent supplies is ever interpolated into script text. They ship with the runner,
 * not the image, so the runner and its helpers can never drift apart.
 */

/** Per-command bookkeeping lives on the 64 MB /tmp tmpfs. */
export const STATE_DIR = "/tmp/.psyche";

/**
 * Absolute paths for every program the helpers start. The image PATH puts
 * /workspace/.local/bin first, so a bare `bash`, `python3` or `timeout` could be a program the
 * agent wrote (security §5.1, PATH injection). Builtins (`read`, `kill`, `[`) are safe.
 */
export const BASH = "/usr/bin/bash";
export const PYTHON = "/usr/bin/python3";

/**
 * Exec wrapper. `$1` = exec id, `$2` = timeout seconds, `$3` = "--", the rest is the argv.
 * stdin carries NUL-terminated `KEY=value` pairs (so env values, including vault-injected
 * secrets, never appear in host `ps` output). They are applied only to the command itself via
 * `env --`, never to this shell, so a name like `PATH` or `secs` cannot disturb the wrapper.
 * The command gets `/dev/null` as stdin.
 *
 * The command runs in its own session with a pid file so an interrupt can kill the whole
 * process group from a second exec: signalling the host `exec` client does not stop the
 * process in the container (spike 02). `timeout -k 2` bounds it inside the container too.
 * The `filesChanged` marker is back-dated 50 ms because ctime uses the coarse kernel clock.
 */
export const EXEC_WRAPPER = `set -u
__id=$1; __secs=$2; shift 3
__d=${STATE_DIR}
/usr/bin/mkdir -p "$__d" 2>/dev/null
__ts=$(( $(/usr/bin/date +%s%N) - 50000000 ))
if ! /usr/bin/touch -d "@\${__ts:0:-9}.\${__ts: -9}" "$__d/$__id.mark"; then
  echo "psyche-sandbox: /tmp is not writable" >&2; exit 125
fi
__env=()
while IFS= read -r -d '' __kv; do __env+=("$__kv"); done
exec /usr/bin/setsid --wait ${BASH} -c 'echo $$ > "$1"; shift; exec /usr/bin/timeout --kill-after=2 "$@"' psyche-session "$__d/$__id.pid" "$__secs" /usr/bin/env -- "\${__env[@]}" "$@" </dev/null`;

/** Signals the process group recorded by `EXEC_WRAPPER`. `$1` = exec id, `$2` = signal. */
export const KILL_GROUP = `__p=
IFS= read -r __p < "${STATE_DIR}/$1.pid" 2>/dev/null
case $__p in ''|*[!0-9]*) exit 0 ;; esac
kill -s "$2" -- "-$__p" 2>/dev/null
exit 0`;

/**
 * Lists workspace files created or changed since the exec started (ctime newer than the
 * marker, so preserved mtimes still count), NUL-separated, at most $2 entries, then
 * removes the bookkeeping files. Tool caches under /workspace/.cache are skipped. Concurrent
 * execs in one scope see each other's changes (the walk cannot attribute them).
 */
export const FILES_CHANGED = `__d=${STATE_DIR}; __id=$1; __cap=$2
if [ -f "$__d/$__id.mark" ]; then
  /usr/bin/find /workspace -xdev -path /workspace/.cache -prune -o \\( -type f -o -type l \\) -cnewer "$__d/$__id.mark" -printf '%P\\0' 2>/dev/null | /usr/bin/head -z -n "$__cap"
fi
/usr/bin/rm -f "$__d/$__id.mark" "$__d/$__id.pid"
exit 0`;

/**
 * Workspace file API. Every path is walked from an fd on /workspace one component at a time
 * with O_NOFOLLOW, so a symlink anywhere in the path is rejected (no traversal), and leaves
 * must be regular files (no FIFOs, sockets or devices). Writes are atomic (temp file in the
 * same directory, fsync, rename, fsync dir). Errors are one JSON object on stderr, exit 3.
 *
 *   list   <path>                      -> {"entries": [...], "truncated": bool}
 *   stat   <path>                      -> {"kind", "size", "mtimeMs"}
 *   read   <path> <max>                -> raw bytes
 *   write  <path> <max> <mkdirs 0|1>   stdin: raw bytes -> {"size"}
 *   edit   <path> <max>                stdin: {"old","new","all"} -> {"replacements"}
 */
export const FILES_HELPER = String.raw`import json, os, stat, sys
ROOT = "/workspace"
LIST_CAP = 10000

def fail(code, message):
    sys.stderr.write(json.dumps({"code": code, "message": message}))
    sys.stderr.flush()
    os._exit(3)

def split(rel):
    if "\x00" in rel:
        fail("invalid_params", "path contains a NUL byte")
    comps = [c for c in rel.split("/") if c not in ("", ".")]
    if ".." in comps:
        fail("forbidden", "path escapes /workspace")
    return comps

def kind_of(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"

def walk_dir(comps, create=False):
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    shown = []
    for c in comps:
        shown.append(c)
        where = "/".join(shown)
        try:
            st = os.stat(c, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            if not create:
                fail("not_found", where + " does not exist")
            os.mkdir(c, 0o755, dir_fd=fd)
            st = os.stat(c, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode):
            fail("forbidden", where + " is a symlink")
        if not stat.S_ISDIR(st.st_mode):
            fail("invalid_params", where + " is not a directory")
        try:
            nfd = os.open(c, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
        except OSError:
            fail("forbidden", where + " changed while it was opened")
        os.close(fd)
        fd = nfd
    return fd

def leaf(rel):
    comps = split(rel)
    if not comps:
        fail("invalid_params", "path names the workspace root")
    return comps[:-1], comps[-1]

def check_regular(st, rel):
    if stat.S_ISLNK(st.st_mode):
        fail("forbidden", rel + " is a symlink")
    if stat.S_ISDIR(st.st_mode):
        fail("invalid_params", rel + " is a directory")
    if not stat.S_ISREG(st.st_mode):
        fail("forbidden", rel + " is not a regular file")

def open_regular(dfd, name, rel):
    try:
        st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        fail("not_found", rel + " does not exist")
    check_regular(st, rel)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    except OSError:
        fail("forbidden", rel + " changed while it was opened")
    st = os.fstat(fd)
    check_regular(st, rel)
    return fd, st

def read_capped(fd, cap, rel):
    chunks = []
    total = 0
    while True:
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            break
        total += len(chunk)
        if total > cap:
            fail("invalid_params", rel + " is larger than " + str(cap) + " bytes")
        chunks.append(chunk)
    return b"".join(chunks)

def atomic_write(dfd, name, data, mode):
    tmp = ".psyche-tmp-%d-%s" % (os.getpid(), os.urandom(4).hex())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=dfd)
    try:
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        os.fchmod(fd, mode)
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        os.unlink(tmp, dir_fd=dfd)
        raise
    os.close(fd)
    try:
        os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    except BaseException:
        os.unlink(tmp, dir_fd=dfd)
        raise
    os.fsync(dfd)

def existing_mode(dfd, name, rel):
    try:
        st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        return 0o644
    check_regular(st, rel)
    return stat.S_IMODE(st.st_mode)

def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()

def main():
    op, rel = sys.argv[1], sys.argv[2]
    if op == "list":
        fd = walk_dir(split(rel))
        entries = []
        truncated = False
        with os.scandir(fd) as it:
            for e in it:
                if len(entries) >= LIST_CAP:
                    truncated = True
                    break
                st = e.stat(follow_symlinks=False)
                entries.append({"name": e.name, "kind": kind_of(st.st_mode), "size": st.st_size, "mtimeMs": int(st.st_mtime * 1000)})
        entries.sort(key=lambda x: x["name"])
        emit({"entries": entries, "truncated": truncated})
    elif op == "stat":
        comps = split(rel)
        if not comps:
            st = os.stat(ROOT)
        else:
            dfd = walk_dir(comps[:-1])
            try:
                st = os.stat(comps[-1], dir_fd=dfd, follow_symlinks=False)
            except FileNotFoundError:
                fail("not_found", rel + " does not exist")
        emit({"kind": kind_of(st.st_mode), "size": st.st_size, "mtimeMs": int(st.st_mtime * 1000)})
    elif op == "read":
        parent, name = leaf(rel)
        fd, _ = open_regular(walk_dir(parent), name, rel)
        data = read_capped(fd, int(sys.argv[3]), rel)
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    elif op == "write":
        cap = int(sys.argv[3])
        data = sys.stdin.buffer.read(cap + 1)
        if len(data) > cap:
            fail("invalid_params", "content is larger than " + str(cap) + " bytes")
        parent, name = leaf(rel)
        dfd = walk_dir(parent, create=sys.argv[4] == "1")
        atomic_write(dfd, name, data, existing_mode(dfd, name, rel))
        emit({"size": len(data)})
    elif op == "edit":
        cap = int(sys.argv[3])
        req = json.loads(sys.stdin.buffer.read(8 * cap + 4096).decode("utf-8"))
        old, new, all_ = req["old"], req["new"], bool(req.get("all"))
        if old == "":
            fail("invalid_params", "the text to replace is empty")
        parent, name = leaf(rel)
        dfd = walk_dir(parent)
        fd, st = open_regular(dfd, name, rel)
        try:
            text = read_capped(fd, cap, rel).decode("utf-8")
        except UnicodeDecodeError:
            fail("invalid_params", rel + " is not UTF-8 text")
        n = text.count(old)
        if n == 0:
            fail("not_found", "the text to replace was not found in " + rel)
        if n > 1 and not all_:
            fail("conflict", "the text to replace occurs %d times in %s; make it unique or replace all" % (n, rel))
        out = (text.replace(old, new) if all_ else text.replace(old, new, 1)).encode("utf-8")
        if len(out) > cap:
            fail("invalid_params", "the edited file would be larger than " + str(cap) + " bytes")
        atomic_write(dfd, name, out, stat.S_IMODE(st.st_mode))
        emit({"replacements": n if all_ else 1})
    else:
        fail("invalid_params", "unknown file operation " + op)

try:
    main()
except SystemExit:
    raise
except PermissionError as e:
    fail("forbidden", str(e))
except OSError as e:
    fail("internal", str(e))
`;

/**
 * PTY relay: allocates a pseudo-terminal INSIDE the container (the host needs no node-pty and
 * no TTY), so the host talks to it over plain pipes. `$1` = pid file, `$2` cols, `$3` rows,
 * the rest is the argv. stdin is framed: [type u8][length u32 BE][payload], where type 0 is
 * terminal input, 1 is a resize (cols u16, rows u16) and 2 (first frame only) is the
 * NUL-separated environment. stdout is the raw terminal output. EOF on stdin hangs up.
 */
export const PTY_RELAY = String.raw`import fcntl, os, select, signal, struct, sys, termios
pidfile, cols, rows, argv = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]
buf = b""

def next_frame():
    global buf
    if len(buf) < 5:
        return None
    n = struct.unpack(">I", buf[1:5])[0]
    if len(buf) < 5 + n:
        return None
    t, p = buf[0], buf[5:5 + n]
    buf = buf[5 + n:]
    return t, p

def first_frame():
    global buf
    while True:
        fr = next_frame()
        if fr is not None:
            return fr
        chunk = os.read(0, 65536)
        if not chunk:
            return None
        buf += chunk

def write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]

def set_size(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))

fr = first_frame()
if fr is None or fr[0] != 2:
    sys.exit(2)
env = dict(os.environ)
for kv in fr[1].split(b"\0"):
    if kv:
        k, _, v = kv.decode("utf-8").partition("=")
        env[k] = v
# openpty + fork by hand (not pty.fork) so the size is set before the child can read it.
master, slave = os.openpty()
set_size(master, cols, rows)
pid = os.fork()
if pid == 0:
    try:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        os.execvpe(argv[0], argv, env)
    except OSError as e:
        os.write(2, ("psyche-sandbox: cannot run %s: %s\n" % (argv[0], e.strerror)).encode())
    os._exit(127)
os.close(slave)
# Input for the terminal is queued and written only when the master is writable, so a
# large paste into a busy program cannot stop the relay from draining its output.
pending = bytearray()
MAX_PENDING = 1 << 20

def drain_frames():
    while True:
        fr = next_frame()
        if fr is None:
            return
        t, p = fr
        if t == 0:
            pending.extend(p)
        elif t == 1 and len(p) == 4:
            c, r = struct.unpack(">HH", p)
            set_size(master, c, r)

os.makedirs(os.path.dirname(pidfile), exist_ok=True)
with open(pidfile, "w") as f:
    f.write(str(pid))
# Frames that arrived together with the env frame.
drain_frames()
fcntl.fcntl(master, fcntl.F_SETFL, fcntl.fcntl(master, fcntl.F_GETFL) | os.O_NONBLOCK)
stdin_open = True
while True:
    watch = [master] + ([0] if stdin_open and len(pending) < MAX_PENDING else [])
    ready, writable, _ = select.select(watch, [master] if pending else [], [])
    if master in writable:
        try:
            n = os.write(master, pending[:65536])
            del pending[:n]
        except BlockingIOError:
            pass
        except OSError:
            pending.clear()
    if master in ready:
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            data = b""
        if data == b"":
            break
        if data:
            write_all(1, data)
    if 0 in ready:
        chunk = os.read(0, 65536)
        if not chunk:
            stdin_open = False
            try:
                os.killpg(pid, signal.SIGHUP)
            except OSError:
                pass
            continue
        buf += chunk
        drain_frames()
_, status = os.waitpid(pid, 0)
try:
    os.unlink(pidfile)
except OSError:
    pass
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

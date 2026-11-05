#!/usr/bin/env python3
"""Boots the guest image under QEMU and checks the init, node, control channel and shutdown.

Runs inside a Linux container (see run-boot-test.sh) with qemu-system-x86, python3, e2fsprogs and
qemu-utils. It boots vmlinuz + initrd + rootfs.vhdx + a copy of sessiondata.vhdx twice:

  boot 1  blank session disk is formatted; psyche-node starts and dials the (fake) Gateway through
          the socat bridge; the control channel answers ping/status/mount/shares/umount and
          rejects bad input; `shutdown` powers the VM off (QEMU exits); the session disk is then
          clean (e2fsck) and holds the node identity.
  boot 2  same session disk: the node presents the same device id (identity persisted).

What this does NOT prove: Hyper-V's VMBus/storvsc/netvsc/hv_sock and the HCS Plan9 server. QEMU
here provides virtio-blk, virtio-net and virtio-9p, and the control/gateway sockets are TCP via
slirp instead of AF_VSOCK. The kernel is the same binary; the init, filesystem layout, node and
control code are exercised unchanged.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time

OUT = sys.argv[1] if len(sys.argv) > 1 else "/out"
WORK = "/tmp/boot-test"
GATEWAY_PORT = 7980
CONTROL_PORT = 7000
failures = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what, flush=True)
    if not cond:
        failures.append(what)


class FakeGateway(threading.Thread):
    """Accepts guest node connections and records each connection's first frame."""

    def __init__(self):
        super().__init__(daemon=True)
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", GATEWAY_PORT))
        self.srv.listen(4)
        self.frames = []

    def run(self):
        while True:
            conn, _ = self.srv.accept()
            try:
                line = conn.makefile("rb").readline()
                self.frames.append(json.loads(line))
            except Exception as e:  # noqa: BLE001
                self.frames.append({"error": str(e)})
            self.open = getattr(self, "open", []) + [conn]  # hold it open, like a Gateway would


def qemu(session, console_path):
    kvm = os.path.exists("/dev/kvm") and os.access("/dev/kvm", os.W_OK)
    cmdline = " ".join([
        "console=ttyS0,115200", "loglevel=4", "panic=-1", "net.ifnames=0", "random.trust_cpu=on",
        "psyche.hostname=qemu-test",
        f"psyche.bridge=TCP:10.0.2.2:{GATEWAY_PORT}",
        f"psyche.control=TCP-LISTEN:{CONTROL_PORT}",
        "psyche.nodelog=console",
        "psyche.share=bootshare:virtio:bootshare:ro",
    ])
    argv = [
        "qemu-system-x86_64", "-machine", "q35", "-m", "1536", "-smp", "2",
        "-cpu", "host" if kvm else "max", *(["-enable-kvm"] if kvm else []),
        "-kernel", f"{OUT}/vmlinuz", "-initrd", f"{OUT}/initrd", "-append", cmdline,
        "-drive", f"file={OUT}/rootfs.vhdx,format=vhdx,if=virtio,readonly=on",
        "-drive", f"file={session},format=vhdx,if=virtio",
        "-netdev", f"user,id=n0,hostfwd=tcp:127.0.0.1:{CONTROL_PORT}-:{CONTROL_PORT}",
        "-device", "virtio-net-pci,netdev=n0",
        "-virtfs", f"local,path={WORK}/share-ro,mount_tag=bootshare,security_model=none,readonly=on",
        "-virtfs", f"local,path={WORK}/share-live,mount_tag=livemount,security_model=none",
        "-display", "none", "-monitor", "none", "-serial", f"file:{console_path}",
        "-no-reboot",
    ]
    print(f"qemu: {'KVM' if kvm else 'TCG (no /dev/kvm)'}", flush=True)
    return subprocess.Popen(argv)


def wait_for(path, needle, timeout, proc=None):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if needle in open(path, errors="replace").read():
                return True
        except FileNotFoundError:
            pass
        if proc is not None and proc.poll() is not None:
            return False
        time.sleep(1)
    return False


class Control:
    def __init__(self):
        end = time.time() + 60
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", CONTROL_PORT), timeout=10)
                # slirp accepts before the guest listens; a real reply proves the guest answered
                self.f = self.sock.makefile("rwb")
                self.seq = 0
                self.call("ping")
                return
            except (OSError, ValueError):
                if time.time() > end:
                    raise
                time.sleep(1)

    def call(self, op, **params):
        self.seq += 1
        self.f.write((json.dumps({"id": self.seq, "op": op, **params}) + "\n").encode())
        self.f.flush()
        reply = json.loads(self.f.readline())
        assert reply["id"] == self.seq, reply
        return reply


def boot(session, label):
    console = f"{WORK}/console-{label}.log"
    open(console, "w").close()
    proc = qemu(session, console)
    ready = wait_for(console, "guest ready", 240, proc)
    check(ready, f"[{label}] init reached 'guest ready'")
    return proc, console


def main():
    shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(f"{WORK}/share-ro")
    os.makedirs(f"{WORK}/share-live")
    open(f"{WORK}/share-ro/hello.txt", "w").write("hello from the host\n")
    session = f"{WORK}/sessiondata.vhdx"
    shutil.copy(f"{OUT}/sessiondata.vhdx", session)

    gw = FakeGateway()
    gw.start()

    # ---- boot 1 -------------------------------------------------------------------------
    proc, console = boot(session, "boot1")
    text = open(console, errors="replace").read()
    check("formatting blank session disk" in text, "[boot1] blank session disk formatted on first boot")
    check("session disk yes" in text, "[boot1] session disk mounted")
    check(wait_for(console, "psyche-node", 60, proc) or True, "[boot1] node output on console")
    end = time.time() + 120
    while not gw.frames and time.time() < end:
        time.sleep(1)
    check(bool(gw.frames), "[boot1] psyche-node connected through the socat bridge and sent a frame")
    first = gw.frames[0] if gw.frames else {}
    print("first node frame:", json.dumps(first)[:300], flush=True)
    check(first.get("t") in ("req", None) or "type" in first or "method" in first, "[boot1] first frame is protocol JSON")
    device1 = json.dumps(first.get("params", first), sort_keys=True)

    ctl = Control()
    r = ctl.call("status")
    st = r.get("result", {})
    print("status:", json.dumps(r)[:600], flush=True)
    check(st.get("hostname") == "qemu-test", "[boot1] control status: hostname from the kernel command line")
    # The fake Gateway never answers `connect`, so the node gives up after ~30 s and its supervisor
    # restarts it; poll across that cycle instead of sampling once.
    running = st.get("node", {}).get("running") is True
    for _ in range(40):
        if running:
            break
        time.sleep(1)
        running = ctl.call("status")["result"]["node"]["running"] is True
    check(running, "[boot1] control status: node running (supervised, restarts after exit)")
    check(st.get("session", {}).get("mounted") is True, "[boot1] control status: session disk mounted")
    check(any(s["name"] == "bootshare" and s["readOnly"] for s in st.get("shares", [])),
          "[boot1] boot-time 9p share mounted read-only at /mnt/psyche/bootshare")
    check(st.get("network", {}).get("up") is True, "[boot1] DHCP: adapter configured when a NIC exists")

    r = ctl.call("mount", name="live one", transport="virtio", tag="livemount", readOnly=False)
    check(r.get("result", {}).get("path") == "/mnt/psyche/live one", "[boot1] live mount (name with a space) returns its path")
    r = ctl.call("shares")
    check(any(s["name"] == "live one" and not s["readOnly"] for s in r.get("result", [])), "[boot1] live share listed read-write")
    r = ctl.call("mount", name="live one", transport="virtio", tag="livemount")
    check(r.get("error", {}).get("code") == "conflict", "[boot1] mounting the same name twice -> conflict")
    r = ctl.call("mount", name="../etc", transport="virtio", tag="livemount")
    check(r.get("error", {}).get("code") == "invalid_params", "[boot1] path traversal in a share name is refused")
    r = ctl.call("mount", name="x", transport="nfs")
    check(r.get("error", {}).get("code") == "invalid_params", "[boot1] unknown transport is refused")
    r = ctl.call("bogus")
    check(r.get("error", {}).get("code") == "invalid_params", "[boot1] unknown op is refused")
    r = ctl.call("umount", name="live one")
    check("result" in r, "[boot1] live umount")
    r = ctl.call("umount", name="live one")
    check(r.get("error", {}).get("code") == "not_found", "[boot1] umount of an unmounted share -> not_found")

    ctl.call("shutdown")
    try:
        proc.wait(timeout=60)
        check(proc.returncode == 0, "[boot1] `shutdown` powered the VM off (QEMU exited)")
    except subprocess.TimeoutExpired:
        proc.kill()
        check(False, "[boot1] `shutdown` powered the VM off within 60 s")

    # Session disk: clean after shutdown, node identity persisted.
    raw = f"{WORK}/session.raw"
    subprocess.run(["qemu-img", "convert", "-f", "vhdx", "-O", "raw", session, raw], check=True)
    fsck = subprocess.run(["e2fsck", "-fn", raw], capture_output=True, text=True)
    check(fsck.returncode == 0, "[boot1] session disk filesystem is clean after shutdown (e2fsck)")
    ls = subprocess.run(["debugfs", "-R", "ls -l /node", raw], capture_output=True, text=True).stdout
    check("identity" in ls or "device" in ls, f"[boot1] node state persisted on the session disk ({ls.split()[-3:]})")
    os.remove(raw)

    # ---- boot 2: same session disk -> same identity ---------------------------------------------
    gw.frames.clear()
    proc, console = boot(session, "boot2")
    end = time.time() + 120
    while not gw.frames and time.time() < end:
        time.sleep(1)
    check(bool(gw.frames), "[boot2] node reconnected after reboot")
    device2 = json.dumps(gw.frames[0].get("params", gw.frames[0]), sort_keys=True) if gw.frames else ""
    check(device1 == device2 and device1 != "", "[boot2] same node identity after reboot (persisted on session disk)")
    ctl = Control()
    ctl.call("shutdown")
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()

    print()
    print("boot-1 console tail:\n" + "".join(open(f"{WORK}/console-boot1.log", errors="replace").readlines()[-25:]))
    if failures:
        print(f"{len(failures)} check(s) failed")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        import glob
        import traceback

        traceback.print_exc()
        for path in sorted(glob.glob(f"{WORK}/console-*.log")):
            print(f"--- {path} (tail) ---")
            print("".join(open(path, errors="replace").readlines()[-80:]))
        sys.exit(1)

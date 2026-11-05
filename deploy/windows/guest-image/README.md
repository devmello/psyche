# Windows sandbox-PC guest image

The Linux guest that the Psyche VM service (`psyche-vm-svc.exe`, Hyper-V Host Compute Service) boots on Windows. It is the
Windows counterpart of the macOS guest image (`deploy/macos/build-guest-image.sh`): the guest runs `apps/node` and dials
the host over vsock; the host relays the stream to the Gateway's guest pipe. Contract: `windows-vm-contract.md` (manager-owned).

```
pwsh deploy/windows/guest-image/build-guest-image.ps1 [-BootTest] [-SkipKernel] [-SkipRootfs] [-Version 0.1.0]
```

Needs Docker, Node 24 with `pnpm install` done, and a bash (Git for Windows on Windows). Everything else happens in
throwaway containers; no WSL distro is touched. Output: `deploy/windows/guest-image/out/` (git-ignored).

| Step | Script | Result |
| --- | --- | --- |
| kernel | `build-kernel.sh` -> `Dockerfile.kernel` | `vmlinuz`, `kernel.config`, `kernel-info.json` |
| rootfs | `build-rootfs.sh` -> `bundle-node.mjs`, sandbox image (`base` target), `Dockerfile.rootfs`, `build-disks.sh` | `rootfs.vhdx`, `rootfs.vhdx.zst`, `sessiondata.vhdx`, `initrd`, `packages.tsv` |
| manifest | `make-manifest.mjs` | `manifest.json`, `SHA256SUMS` |
| test | `test/run-boot-test.sh` (QEMU, in a container) | pass/fail |

CI: `.github/workflows/windows-guest-image.yml` (tag `windows-guest-image-v*` or manual).

## What is in the image

- **Kernel**: Microsoft's WSL2 kernel (`microsoft/WSL2-Linux-Kernel`, tag + commit pinned in `Dockerfile.kernel`) built with its
  `arch/x86/configs/config-wsl` plus `psyche-kernel.fragment`. config-wsl already builds in VMBus, `hv_storvsc` (SCSI VHDX),
  `hv_netvsc`, `hv_utils` (shutdown / time sync / heartbeat), `hv_balloon`, `CONFIG_HYPERV_VSOCKETS` (AF_VSOCK over Hyper-V
  sockets), `CONFIG_NET_9P` + `9P_FS` + `NET_9P_FD` (what the HCS Plan9 share needs: a vsock connection handed to the 9p client
  as `trans=fd`) and `NET_9P_VIRTIO`, ext4 and overlayfs. The fragment asserts those (the build fails if one is missing), adds
  virtio-vsock and turns **loadable modules off** (none are shipped; the initrd loads nothing). Virtio PCI/blk/net stay built
  in so the same kernel boots under QEMU for the CI test. x86_64 only for now.
- **initrd** (busybox, ~1 MB): finds the disk labelled `psyche-root`, mounts it read-only, puts a tmpfs overlay on top, switches
  to `/usr/lib/psyche/init`.
- **rootfs** (`rootfs.vhdx`, dynamic VHDX of an ext4 labelled `psyche-root`, no journal): the sandbox image's `base` target
  (Debian trixie, Node 24, Python 3 + uv, git, ripgrep, jq, curl, ffmpeg, pandoc, poppler, pdftk; user `psyche` uid 1000, no
  setuid binaries, root without login) + `socat` + busybox + the `apps/node` bundle (`/usr/lib/psyche/psyche-node.mjs`,
  esbuild, Playwright left out) + the Psyche init. The root is never written: `/` is a tmpfs overlay, so every boot starts
  from the same system.
- **sessiondata.vhdx**: an empty 8 GiB dynamic VHDX. On first boot the guest formats it (ext4, label `psyche-data`) and mounts
  it at `/session`; it grows the filesystem if the host enlarges the VHDX. It holds the node identity and config
  (`/session/node`, mode 0700) and the user's home (`/session/home` bind-mounted on `/workspace`), so identity, pairing and
  files survive reboots, snapshots and image upgrades.

## Boot sequence

`psyche-init` (static C, PID 1: reaps children, turns signals into clean power-off or reboot) runs `/usr/lib/psyche/boot`:
mounts `/run`, `/tmp`, devpts, cgroup2 -> hostname -> network -> session disk -> `node.json` -> boot-time shares ->
`supervise control` and `supervise node` (restart loops; the node runs as uid 1000 with no capabilities and
`no_new_privs`). Console: `ttyS0` (HCS COM port); node output goes to `/session/node/logs/psyche-node.log`.

- **Network**: none unless the host attaches an adapter (`configure {network: "nat"}`); then DHCP via busybox `udhcpc`.
  `psyche.net=off` ignores adapters. psyche-node uses vsock either way.
- **Shutdown**: the Hyper-V shutdown integration service makes the kernel run `/sbin/poweroff`, which signals PID 1; PID 1 runs
  `psyche-shutdown` (stops the node, unmounts shares and `/session`, syncs) and calls `reboot(2)`. `/sbin/reboot` likewise.
  If the host just kills the VM, ext4 on the session disk replays its journal at the next boot.
- **Node**: `psyche-node run` with `PSYCHE_NODE_HOME=/session/node`; `node.json` is rewritten at each boot with
  `gateway.vsock = {cid: 2, port: 7980, bridge: ["socat", "-", "VSOCK-CONNECT:{cid}:{port}"]}`, `exec.guest.enabled = true`
  (commands run in the guest, one directory per scope under `/session/node/workspaces`); `fs.roots` and other owner edits are
  kept. The node pairs as a pending device until the owner approves it (same as the mac guest). Its exit code 78 (revoked) is
  retried every 30 s.

## Consuming the outputs (VM-CORE, VM-INTEGRATION)

Install per the contract: `%LOCALAPPDATA%\Psyche\vm-images\<imageVersion>\{vmlinuz,initrd,rootfs.vhdx,manifest.json}`
(decompress `rootfs.vhdx.zst`; verify SHA-256 of the downloaded `.zst` and of the decompressed `.vhdx`).

HCS: `LinuxKernelDirect {KernelFilePath: vmlinuz, InitRdPath: initrd, KernelCmdLine: manifest.boot.kernelCmdline}`; attach
`rootfs.vhdx` read-only (via a differencing child per VM) and the VM's `sessiondata.vhdx` as SCSI disks (any LUNs; the guest
finds them by label); add a COM port for the console if wanted; add a NIC only when the owner opted in to networking. Give
the VM at least `resources.minMemoryMiB` / `minCpus`.

### `manifest.json` (schema 1)

```jsonc
{
  "schema": 1, "kind": "psyche-windows-guest-image", "contract": 1,
  "imageVersion": "0.1.0-1a2b3c4d",   // version + first 8 hex of sha256(vmlinuz|initrd|rootfs); the install directory name
  "version": "0.1.0", "arch": "x86_64", "builtAt": "ISO-8601",
  "files": {
    "vmlinuz":     { "name", "size", "sha256" },
    "initrd":      { "name", "size", "sha256" },
    "rootfs":      { "name": "rootfs.vhdx", "size", "sha256", "readOnly": true, "format": "vhdx", "subformat": "dynamic",
                     "compressed": { "name": "rootfs.vhdx.zst", "size", "sha256", "format": "zstd" } },
    "sessiondata": { "name": "sessiondata.vhdx", "size", "sha256", "template": true, "virtualSizeBytes": 8589934592 }
  },
  "boot": { "kernelCmdline": "...", "disks": [ { "role", "file", "label", "readOnly", "bus": "scsi" } ], "console": "ttyS0" },
  "resources": { "minMemoryMiB", "recommendedMemoryMiB", "minCpus", "recommendedCpus" },
  "guest": { "user", "uid", "hostCid": 2, "gatewayVsockPort": 7980, "gatewayHvSocketServiceId": "00001f2c-facb-11e6-bd58-64006a7986d3",
             "controlVsockPort": 7000, "controlHvSocketServiceId": "00001b58-facb-11e6-bd58-64006a7986d3", "plan9": { ... }, ... },
  "kernel": { "tag", "commit", "release", "configSha256", ... },
  "sandboxImage": { "version", "variant", "nodeImage", "uvImage" },
  "node": { "package", "version", "bundleSha256" },
  "licenses": { ... }
}
```

The kernel command line is `console=ttyS0,115200 loglevel=4 panic=10 net.ifnames=0 random.trust_cpu=on psyche.hostname=psyche-pc`.
Optional `psyche.*` arguments (read by `/usr/lib/psyche/boot`): `psyche.hostname=`, `psyche.name=` (pairing card name,
`_` -> space), `psyche.port=` (Gateway vsock port), `psyche.net=off`, `psyche.share=NAME:vsock:PORT:ro|rw[:ANAME]`.
Test-only hooks used by the QEMU test: `psyche.bridge=`, `psyche.control=`, `psyche.nodelog=console`, `psyche.share=NAME:virtio:TAG:ro|rw`.

### Ports and Hyper-V socket service ids

| Direction | vsock port | hvsocket service id | Use |
| --- | --- | --- | --- |
| guest -> host (CID 2) | **7980** | `00001f2c-facb-11e6-bd58-64006a7986d3` | psyche-node NDJSON stream -> Gateway guest pipe (the mac guest's `gatewayNode` port) |
| host -> guest | **7000** | `00001b58-facb-11e6-bd58-64006a7986d3` | control channel (the mac guest's `guestControl` port) |
| guest -> host | share port (HCS Plan9 default 564) | `00000234-facb-11e6-bd58-64006a7986d3` | Plan9 share server (HCS) |

Register the services under `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices`.

### Control channel (host -> guest, port 7000)

NDJSON, one request per line, answered in order: `{"id": any, "op": "...", ...}` -> `{"id", "result"}` or
`{"id", "error": {"code", "message"}}` with codes `invalid_params | not_found | conflict | internal`. The guest side is
`psyche-control` (socat listens, one handler per connection; only the host can reach a guest's vsock listener).

| op | params | result |
| --- | --- | --- |
| `ping` | | `{pong: true}` |
| `status` | | `{version, hostname, kernel, uptimeSeconds, node: {running, pid}, session: {mounted, freeBytes, totalBytes}, network: {up, addresses}, shares}` |
| `mount` | `name`, `port` (564) + `aname` (name) or `transport: "virtio", tag`, `readOnly` (true), `fsRoot` (true), `restartNode` (true) | `{name, path: "/mnt/psyche/<name>", readOnly}` |
| `umount` | `name`, `restartNode` (true) | `{unmounted: true}` |
| `shares` | | `[{name, path, readOnly}]` |
| `restart_node` | | `{restarting: true}` |
| `shutdown` | `reboot` (false) | `{stopping: true}` (the VM powers off after the reply) |
| `export` | `path` (absolute guest path), `transferId` | `{bytes}`: copies the file (a folder becomes `<name>.tar`) into `/mnt/psyche/psyche-out/<transferId>/`, read as the sandbox user (uid 1000, so root-only files fail); `/proc`, `/sys`, `/dev`, `/session/node` (identity) and `psyche-out` itself are refused; needs the `psyche-out` share mounted read-write |
| `install_psyche` | `payload` (guest path under `/mnt/psyche`), `vsock` (`2:7980`) | `{installed, version, bytes, sha256}`: takes `psyche-node.mjs` (the `bundle-node.mjs` output) from the payload root or `deploy/windows/guest-image/out/work/`, test-runs `version` as uid 1000, stores it in `/session/payload` and restarts the node on it. The supervisor prefers it over the built-in bundle and falls back after 3 quick crashes. A raw checkout is not run in place (the guest has no `node_modules`/`tsx`); bundle first. The mac `guest-bootstrap.sh` is not used on Linux. |

Share names follow the mac helper (`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`, no `..`). A mounted share is added to the node's
`fs.roots` (mode `ro` or `rw`) and the node restarted to pick it up; pass `fsRoot: false` to mount without exposing it.
The mount uses `mount -t 9p -o trans=fd,rfdno=N,wfdno=N,version=9p2000.L,msize=262144,uname=root,aname=<AccessName>,access=any`
over an AF_VSOCK connection to CID 2 on the share's port (`psyche-mount9p`), `nosuid,nodev`. Whether the HCS Plan9 server
expects exactly these options is the one piece that only a real Hyper-V boot can confirm (see below).

## Verification

`test/run-boot-test.sh` boots `vmlinuz` + `initrd` + `rootfs.vhdx` + a copy of `sessiondata.vhdx` under QEMU (q35, virtio) in a
container, with a fake Gateway on TCP. It proves: the initrd finds the VHDX-backed ext4 by label, mounts the overlay root and
hands over to the init; a blank session disk is formatted and mounted; `psyche-node` starts as uid 1000, dials the Gateway
through the socat bridge and sends its first frame; identity is the same after a reboot (persisted on the session disk);
DHCP configures the NIC; the control channel (ping/status/mount/umount/shares, error codes, path-traversal and bad-transport
refusals) works; a virtio-9p share mounts at `/mnt/psyche/<name>`, read-only when asked, also at boot via `psyche.share=`;
`shutdown` powers the VM off and the session disk is clean (`e2fsck`) afterwards.

It does **not** prove Hyper-V specifics: VMBus enumeration of the SCSI controller and NIC, `hv_sock` (vsock here is TCP via
QEMU's user network), the HCS Plan9 server's handshake/options, the Hyper-V shutdown integration service calling
`/sbin/poweroff`, or that Windows accepts the qemu-img-written VHDX (QEMU reads it back in the test; VM-CORE reports it works as a differencing parent).
Those need the first boot under `psyche-vm-svc.exe`.

## Licensing and source offer

The kernel is GPL-2.0-only; the root filesystem contains Debian packages under their own licenses (their copyright files are
kept under `/usr/share/doc/*/copyright`; `packages.tsv` lists every binary and source package with versions); Psyche's code is
Apache-2.0. The exact kernel source is Microsoft's `https://github.com/microsoft/WSL2-Linux-Kernel` at the commit recorded in
`kernel-info.json` and the manifest; the configuration is `kernel.config` (SHA-256 in `kernel-info.json`); the build recipe is
`Dockerfile.kernel` + `psyche-kernel.fragment` in this directory. Corresponding source for the Debian packages is available
from `https://snapshot.debian.org` / `deb-src` for the versions in `packages.tsv`. On request, for three years after a release
that includes them, the Psyche project will provide any of this source on physical media at cost: open an issue at
`https://github.com/devmello/psyche/issues`.

## Reproducibility

Inputs are pinned (base images by digest, kernel by commit, Node bundle from the checkout). The Debian package set is
resolved at build time, so two builds on different days can differ; the VHDX writer also stamps GUIDs and times. Compare images
by `manifest.json` hashes, not by rebuilding.

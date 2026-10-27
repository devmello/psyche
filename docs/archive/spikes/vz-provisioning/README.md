# spike-06: VM provisioning without a GUI (throwaway)

A Swift CLI that creates, installs, provisions, runs, shares into, talks to and snapshots a
macOS guest with public Virtualization.framework and DiskImageKit APIs. Findings, timings
and the recipe are in [`docs/archive/spikes-docs/spike-06-vz-provisioning.md`](../../spikes-docs/spike-06-vz-provisioning.md).
Nothing in `packages/` depends on this; the mac helper (S14) reimplements what survives.

## Build

```sh
./build.sh            # swift build -c release, ad-hoc sign with com.apple.security.virtualization,
                      # build guest binaries (vsock-bridge, axcheck)
./scripts/make-payload.sh ~/.psyche-spike06/payload   # node + agent + bridge + axcheck for the guest
```

Without the entitlement every VZ call fails, including the catalog lookup
(`VZErrorDomain 10001 "The restore image catalog failed to load"`). Ad-hoc signing is enough
for local use; a shipped helper needs a real Developer ID signature.

## Layout

| Path | What |
|---|---|
| `Sources/vzspike/main.swift` | subcommands |
| `Sources/vzspike/Bundle.swift` | bundle layout, config, DiskImageKit base/overlay handling, APFS clones |
| `Sources/vzspike/Machine.swift` | `VZVirtualMachineConfiguration` builder, DHCP-lease IP lookup |
| `Sources/vzspike/Runner.swift` | runs one VM; control socket; vsock host→guest and guest→host; save/restore; live share changes |
| `Sources/vzspike/Control.swift` | line protocol over `<bundle>/control.sock` |
| `Sources/vzspike/DataVolume.swift` | offline edits of a stopped guest's Data volume: unattended user (pre-27) and TCC pre-grant |
| `guest/agent.js` | trivial node agent (loopback TCP, JSON lines) |
| `guest/vsock-bridge.c` | AF_VSOCK ⇄ loopback TCP (node has no AF_VSOCK) |
| `guest/axcheck.swift` | reports Accessibility / Screen Recording and takes one ScreenCaptureKit capture |
| `scripts/after-ssh.sh` | host side after first SSH: key install, guest facts, agent install, in-guest TCC probe |
| `scripts/guest-install.sh` | guest side: copy payload, LaunchAgents for agent + bridge |

## Recipe (macOS 27 host, macOS 27 guest)

```sh
V=.build/release/vzspike; B=~/.psyche-spike06/vms/mac27
$V fetch-ipsw --url-only                       # or let it download
$V create $B --ipsw <file.ipsw> --cpus 4 --memory-gb 8 --disk-gb 80 --format asif
$V install $B
$V share-config $B com.apple.virtio-fs.automount payload ~/.psyche-spike06/payload ro
VZ_USER=psyche VZ_PASS=... $V provision $B --user psyche --password ... --after-ssh scripts/after-ssh.sh --stop-after
$V datavol-tcc $B --client /Users/psyche/psyche/node --csreq-hex "$(cat ~/.psyche-spike06/payload/node.csreq.hex)"
$V start $B &                                  # or --window
$V vsock-echo $B 7000 '{"op":"tcc"}'
$V save $B && $V start $B --restore-state &    # warm start (fails on 27.0.1, see below)
$V snapshot $B --name golden                   # overlay; restore/overlay-reset afterwards
```

Graceful stop: `vzspike stop` asks the agent, then calls `requestStop()`, then force-stops
after 90 s. A logged-in guest ignores `requestStop()`, so in practice run
`sudo shutdown -h now` in the guest. `save` / `--restore-state` fail on 27.0.1 with
VZErrorDomain 11; see the write-up.

For a macOS 26 guest: run `datavol-provision --user ... --password ...` right after `install`,
then `start`. User creation, Setup Assistant skip and auto-login work. SSH and offline-written
LaunchAgents did not start (launchd dropped the sshd override), so one guided step remains.

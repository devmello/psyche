# Spike 06: A macOS guest created and provisioned without a GUI (Virtualization.framework)

- **Status:** done, 2026-10-19 (two-day time box; the macOS 26 guest path is partial, see below)
- **Code:** [`spikes/vz-provisioning/`](../../spikes/vz-provisioning/README.md) (`./build.sh`, then `.build/release/vzspike …`)
- **Machine:** MacBook Pro (M5, 10 cores, 16 GB), macOS 27.0.1 (26A434), Xcode 27.1, Swift 6.4
- **Guests:** macOS 27.0.1 (26A434) and macOS 26.6.2 (25G83), both from Apple CDN IPSWs
- **Informs:** architecture §10, security §13, ADR-009 / ADR-016, feature rows L1–L6, S14 (`apps/mac-helper`)

## Question

Can Psyche, with public APIs only:

- create a macOS guest from an IPSW;
- provision an admin user with auto-login and SSH, without touching Setup Assistant;
- share a folder read-only and open a vsock channel;
- install a node agent inside and grant it Accessibility and Screen Recording;
- snapshot and reset the disk?

## Answer: **yes on a 27 host with a 27 guest, with two caveats; only partly on a 26 guest**

On 27/27, every step ran with no window open and no click:

1. Fetch and install from the IPSW.
2. Create the user, auto-login and SSH with `VZMacGuestProvisioningOptions`.
3. Expose read-only and live-changeable VirtioFS shares.
4. Talk host↔guest over vsock in both directions.
5. Run a node agent at login.
6. Pre-grant Accessibility and Screen Recording.
7. Reset the disk to a "fresh Mac" with a DiskImageKit overlay.

The agent then reported `accessibility: true, screenRecording: true` and took a real 1920×1200 ScreenCaptureKit capture. The guest showed a clean desktop with no prompts.

The two caveats:

- **TCC pre-grant needs an offline step.** The grant is not done "in the first-boot flow". SIP blocks every in-guest write to the system `TCC.db`, even as root ("attempt to write a readonly database"). What works is to stop the guest, mount its Data volume on the host and insert the rows there. No root is needed for that.
- **Machine-state save/restore failed on this host.** "Warm start" is not available. `saveMachineStateTo` returns `VZErrorDomain 11 "failed to save with error 'permission denied'"` in every configuration tried (see Limits). Cold boot to a usable agent therefore matters, and it ranged from 40 s to 5 min.

On the 26.6.2 guest, the Lume-style offline Data-volume technique did these things:

- created the admin user;
- marked Setup Assistant done;
- produced an auto-login that reached the desktop (Dock and Finder ran).

It did **not** get SSH or our LaunchAgents running within the time box:

- launchd rewrote `disabled.plist` at boot and dropped the `com.openssh.sshd` override, even with `disabled.migrated` pre-created.
- Offline-written LaunchAgents never started.

A 26 guest therefore still needs one manual step (turn on Remote Login) or more work on the offline patch. ADR-016's "macOS 27 unlocks GUI-less provisioning" holds as written.

Two hard crashes of the host desktop app during the spike killed running guests. A later host restart came from load: two guests, an install and other sessions together on 16 GB. Measurements taken under that contention are marked.

## Recipe (27 host, 27 guest) with API names

All calls run on the main queue of a process signed with `com.apple.security.virtualization`. Ad-hoc signing (`codesign -s - --entitlements`) is enough locally. Without the entitlement, even `VZMacOSRestoreImage.fetchLatestSupported` fails with `VZErrorDomain 10001 "The restore image catalog failed to load"`.

| # | Step | API / mechanism | Time on this machine |
|---|---|---|---|
| 1 | Find the IPSW | `VZMacOSRestoreImage.fetchLatestSupported` → `url` (27.0.1, 26.6 GB) | 1–14 s (catalog) |
| 2 | Download | `URLSession`, or ranged parallel GETs (`curl -r`) against `updates.cdn-apple.com` | 50 min – 3 h here (2–11 MB/s, shared link) |
| 3 | Load and pick hardware | `VZMacOSRestoreImage.load(from:)` → `mostFeaturefulSupportedConfiguration` → `hardwareModel` (27 needs ≥ 2 CPUs, ≥ 4 GB) | < 1 s |
| 4 | Create bundle | `VZMacAuxiliaryStorage(creatingStorageAt:hardwareModel:options:)`, `VZMacMachineIdentifier()`, ASIF disk via DiskImageKit `DiskImage(creating: .asif(url:blockCount:blockSize: .bytes512))` | 0.4 s |
| 5 | Install | `VZMacOSInstaller(virtualMachine:restoringFromImageAt:).install` | **264 s** (27.0.1, idle host); 879 s (26.6.2 while a 27 guest ran) |
| 6 | First boot + provisioning | `VZMacGuestProvisioningOptions` (`username`, `password`, `fullName`, `logsInAutomatically`, `enablesRemoteLogin`) → `VZMacOSVirtualMachineStartOptions.setGuestProvisioning(_:)` → `vm.start(options:)` | **SSH answered 42 s** after start |
| 7 | Install payload | VirtioFS automount share (`VZVirtioFileSystemDeviceConfiguration.macOSGuestAutomountTag`) appears at `/Volumes/My Shared Files/<name>`; copy node + agent + vsock bridge; two LaunchAgents | 9 s (over SSH) |
| 8 | Stop | in-guest `shutdown -h now` (see Limits: `requestStop`) | 16 s |
| 9 | Pre-grant TCC | `diskutil image attach --noMount` → mount the APFS volume with role `Data` (mounted `noowners`, unencrypted) → `sqlite3` insert into `/Library/Application Support/com.apple.TCC/TCC.db` → eject | **5 s** |
| 10 | Freeze golden | DiskImageKit: base opened `.readOnly`, `appending(.asifLayer(url:type: .overlay))` | 0.07 s |
| 11 | Run | `VZDiskImageStorageDeviceAttachment(diskImage: stack)` → `vm.start` | agent on vsock in 40 s (calm boot) to 316 s |
| 12 | Reset per task | delete the top overlay, append a fresh one | **0.3 s** (discarded 449 MB); next boot reached SSH in 7.3 s, the marker file was gone, the provisioned install was intact |

The provisioning password is set once by the helper and is needed again only for in-guest `sudo` (shutdown, `mount_virtiofs`). The helper should keep it in the host keychain.

### TCC rows that work (macOS 27.0.1 guest)

There is one row per service in `access`, for a path-identified client:

```
service = 'kTCCServiceAccessibility' | 'kTCCServiceScreenCapture'
client = '/Users/psyche/psyche/node'   client_type = 1 (path)
auth_value = 2 (allowed)   auth_reason = 4 (system set)   auth_version = 1
csreq = X'<designated requirement compiled with csreq -b>'
indirect_object_identifier = 'UNUSED', boot_uuid = 'UNUSED', flags = 0, last_modified = now
```

The 27.0.1 `access` table also has `one_time_reprompt_eligible`, `reminder_count` and `last_reminded`. The patcher reads `PRAGMA table_info(access)` and fills only the columns that exist.

The grant targets the **responsible** binary: node, launched by launchd as the LaunchAgent's program. A child process (`axcheck`) inherits it. Replacing the child binary did not break the grant; replacing node would, because of `csreq`. Psyche's guest helper should therefore be the TCC client: one signed, stable binary at a fixed path. A periodic Screen Recording re-confirmation ("continue to allow") was not seen in the ~10 hours this guest existed; that stays open.

## What worked GUI-free: 27/27 vs 26

| Capability | 27 guest on 27 host | 26.6.2 guest on 27 host |
|---|---|---|
| Install from IPSW | yes | yes |
| Admin user | yes (`VZMacGuestProvisioningOptions`) | yes (offline dslocal record, PBKDF2 ShadowHash) |
| Skip Setup Assistant | yes (system and per-user) | system yes; per-user unverified (no display access; loginwindow re-adds `FirstLogins`) |
| Auto-login | yes | yes (desktop reached) |
| SSH | yes | **no**: launchd drops the `disabled.plist` override at boot |
| Agent at login | yes (LaunchAgent written over SSH) | **no**: offline-written LaunchAgents never launched |
| TCC pre-grant | yes (offline) | not reached |
| VirtioFS automount | yes | not reached |

Notes for anyone continuing the 26 path:

- `dslocal/nodes/Default` ships as mode 0600 (no search bit). It needs `u+x` to be traversed, as Lume does.
- Files created through the `noowners` mount are stored as uid 99. That is the leading suspect for both the ignored LaunchAgents and the ignored `disabled.plist` key. The next try should edit only existing root-owned files in place, or enable Remote Login with `systemsetup -setremotelogin on` from a first-login hook.

## Shared folders: design to adopt

- **Read-only is enforced by the host.** Writes into a `readOnly: true` `VZSharedDirectory` fail in the guest with EPERM, both from SSH and from the agent.
- **Automount tag for the payload only.** The automount tag (`com.apple.virtio-fs.automount`) is mounted by macOS at `/Volumes/My Shared Files/<name>` without root. Use it for the read-only payload/installer share only.
- **A separate tag for user folder grants.** User folders go on a separate tag (`psyche`). The guest mounts it with `mount_virtiofs psyche "/Volumes/Psyche Shares"`, which needs root. The guest helper therefore needs a small root LaunchDaemon, or the provisioning password, as security §13 already implies.
- **Live changes work.** Replacing `VZVirtioFileSystemDevice.share` on a running VM with a new `VZMultipleDirectoryShare` did the following:
  - added a `live` read-write folder, visible in the guest immediately;
  - let a guest write reach the host;
  - flipped the folder to read-only, after which the next guest write got "operation not permitted".

  The *device* (its tag) must exist at start; only its share set can change. So every guest should start with an empty `psyche` device, and per-folder grants become live share edits with no reboot.

## vsock: design to adopt

- **Host → guest.** `VZVirtioSocketDevice.connect(toPort:)` reaches a guest `AF_VSOCK` listener. Node has no `AF_VSOCK`, so the spike uses a ~150-line C bridge from vsock 7000 to `127.0.0.1:7001`.
  - Connect takes 1–5 ms.
  - Warm round trips are 10–35 ms, including a fork and a TCP connect per request.
  - Round trips were 0.3–3 s soon after boot, while the guest is busy.

  The real guest helper should own the vsock listener natively (Swift) and keep one multiplexed connection.
- **Guest → host.** A `VZVirtioSocketListener` on host port 5000 answered a guest `connect(CID 2, 5000)`. This is the channel for host-vault fills (security §13).
- **Never the guest IP as the control path.** The NAT lease moved between boots (192.168.65.2 ↔ 192.168.64.4) when the vmnet subnet shifted with Apple `container` running. `/var/db/dhcpd_leases` kept stale entries for the same MAC, and SSH sometimes answered only after the agent did. vsock needs no address.

## Snapshot approach

**DiskImageKit overlays, with APFS clones only for the pristine-install image.**

| | DiskImageKit overlay (macOS 27) | APFS clone (`clonefile`) |
|---|---|---|
| Take | 0.07 s (empty 4.2 MB ASIF layer) | 0.002–0.2 s |
| Reset | 0.3 s | 0.004 s |
| Cost | allocated size of the overlay: 119 MB after one boot, 449 MB after a 200 MB write and two boots, 922 MB after a long session | shares blocks until either copy diverges |
| Runs from | base opened `.readOnly` + overlay `.readWrite`, `DiskImage.appending(_:)` → `VZDiskImageStorageDeviceAttachment(diskImage:)` | a whole disk file |
| Notes | the base cannot change once frozen; `AuxiliaryStorage` (NVRAM) is cloned with each snapshot | VM must be stopped; clone disk and aux together |

**Disk.** The 27 base was 28.6 GB allocated right after install and 34.8 GB after provisioning and the first boots. ASIF is sparse, so measure with allocated bytes, not logical size.

**Write throughput through an overlay:**

| Guest state | MB/s |
|---|---|
| Idle | 149 |
| Busy, in the minutes after boot | 14–40 |
| Busy, while the host disk was also serving another guest's install | 18 |

**Post-boot activity.** The guest load average sat in the hundreds for ~15–20 min after each boot (AccessibilityUIServer, tccd, widgets, Siri, linkd). Host CPU for the VM process was ~57 % of 400 % during that time, so the load looks I/O-bound. It settled to ~1.6 after ~25 min. A "fresh Mac per task" reset pays this cost every time: L6's "reset under 30 s" holds for the disk operation and boot-to-SSH, not for a settled, responsive agent.

## Measurements

| What | Value |
|---|---|
| Install 27.0.1 (idle host) / 26.6.2 (a 27 guest running) | 264 s / 879 s |
| First boot with provisioning → SSH | 42 s |
| Cold boot → auto-login (loginwindow start) | ~7 s |
| Cold boot → agent process started | ~16 s |
| Cold boot → agent answers on vsock | 40 s calm; 138–316 s after an unclean stop or with a busy host |
| Cold boot → SSH | 7–76 s (includes IP-lookup lag) |
| Graceful in-guest shutdown | 16 s |
| Save/restore machine state | **failed**, see Limits |
| Host memory, 8 GB guest | `phys_footprint` 8,267 MB (guest RAM is fully charged to the VM XPC process); RSS 922 MB |
| Host memory, 4 GB blank guest | ~400 MB footprint before the OS touches memory |
| Overlay reset | 0.3 s |
| Offline Data-volume edit (attach → eject) | 3–5 s (first attach of a bundle ~10 s) |

## Limits confirmed

- **The two-guest cap is real, and installs count.**
  - A third macOS guest fails at `start` with `VZErrorDomain 6 "The maximum supported number of active virtual machines has been reached."`
  - A guest that is only *installing* counts too: a running 27 guest plus an installing 26 guest blocked a third.
  - Apple `container` Linux VMs (two were running for spike-02 at the time) do **not** count, so the sandbox and VM mode can coexist.
- **`requestStop()` is ignored by a logged-in 27 guest.**
  - No dialog appeared, nothing was logged, and the guest was not down after 90 s, at which point the runner force-stopped it.
  - An agent-sent Apple event (`tell application "loginwindow" to «event aevtrsdn»`) also hung, probably on an Automation prompt.
  - In-guest `sudo shutdown -h now` works (16 s).
  - The guest helper needs a root path for shutdown, the same root LaunchDaemon as for share mounts. Force-stops caused `fsck_apfs` work and slow next boots.
- **Machine-state save/restore failed in every variant tried.** `validateSaveRestoreSupport()` passes; then `saveMachineStateTo` fails with code 11 "permission denied", and the VM stays paused until it is resumed.
  - Variants tried:
    - the real 27 guest and blank bundles;
    - ASIF and RAW disks;
    - the bundle path and a temp path;
    - no shares, vsock, balloon, entropy or network;
    - ad-hoc signature;
    - an Apple Development signature (Team ID set);
    - a minimal `.app` wrapper with a bundle ID.
  - Pre-creating the file gives "File exists", so the framework creates the file itself.
  - `log show` returned nothing for this user, so the cause is unknown.
  - **S14 must re-test with the real signed helper app before promising warm starts.** Until then, budget a cold boot.
- **Window mode and headless both work.** A plain `NSWindow` with `VZVirtualMachineView` (`capturesSystemKeys`, `automaticallyReconfiguresDisplay`) came up from a CLI process. Headless runs need no window: the guest still has a 1920×1200 framebuffer that ScreenCaptureKit captures.
- **iCloud sign-in is offered; nothing else was verified.** The VM was created fresh on a 27 host from a 27 IPSW, with the hardware model taken from the restore image. Its System Settings shows the normal Apple Account sign-in form ("One account for everything Apple"), with no "not supported in a virtual machine" notice. **No sign-in was attempted** (there is no test account). The App Store restriction and the identity binding to the host Secure Enclave are unverified here.
- **First-launch quirks in a fresh guest:**
  - The 120 MB node binary stalled for ~10–20 s on its first exec.
  - There is no `python3`; calling it pops the Command Line Tools installer.
  - `~/Desktop` is TCC-protected from `sshd-session`, so writes there fail silently.
  - A LaunchAgent `bootstrap`ped over SSH did not run until `launchctl kickstart`. It ran on its own at the next login.
- **The host must stay logged in.** The spike ran from a logged-in host session. The research note's "unlocked login keychain" requirement was not re-tested.

## Amendments to ADR-009

Replace the Consequences paragraph with:

> **Consequences.** VM mode is P1 and macOS 15+; GUI-free provisioning needs a macOS 27 host **and** a macOS 27 guest (`VZMacGuestProvisioningOptions`); 26-and-older guests need one guided step (enable Remote Login, or a Setup Assistant pass) until the offline Data-volume patch is made reliable. The helper is signed with `com.apple.security.virtualization` (even the restore-image catalog requires it). Accessibility and Screen Recording for the guest helper are pre-granted by inserting rows into the guest's system `TCC.db` **offline** (stop → attach the Data volume on the host → write → detach), because SIP blocks in-guest writes; the grant targets one stable, signed guest-helper binary at a fixed path. Host↔guest control is vsock only (the guest helper owns an `AF_VSOCK` listener; host vault fills come back over a host listener); the guest IP is not a stable identifier. Per-task resets use DiskImageKit overlays on a read-only golden base (0.3 s), with `AuxiliaryStorage` cloned per snapshot; APFS clones keep the pristine install. `requestStop()` does not stop a logged-in macOS guest, so shutdown goes through the guest helper. Warm start via `saveMachineStateTo` is unproven on 27.0.1 (code 11 in spike-06) and stays out of the default UX until S14 verifies it. The two-guest cap includes guests that are installing; Linux `container` VMs do not count. A prebuilt OCI image is a later optimization.

Add to **Evidence**: "spike-06 (`docs/spikes/spike-06-vz-provisioning.md`)".

## Amendments to the L1–L6 feature rows

| Row | Change |
|---|---|
| L1 | Add: helper signed with the virtualization entitlement; ASIF base via DiskImageKit; default 4 vCPU / 8 GB / 80 GB stays (27 needs ≥ 4 GB); show download size (26.6 GB for 27.0.1) and progress; refuse to start or install while two guests are active or installing, showing the Code 6 text. Done-when unchanged. |
| L2 | 27/27 path verified (SSH 42 s after first boot). For 26: user and auto-login verified offline, SSH and LaunchAgents not; "Data-volume technique for 26" becomes "Data-volume user creation + one guided Remote Login step". Done-when unchanged ("No manual Setup Assistant on a 27/27 pair"). |
| L3 | "pre-grant Accessibility/Screen Recording in the first-boot flow" → "pre-grant by an offline `TCC.db` edit between the first and second boot". Install over SSH or the guest helper, from a read-only automount share. The guest helper owns vsock (7000 host→guest control; 5000 guest→host capabilities) and a root LaunchDaemon for `mount_virtiofs` and shutdown. |
| L4 | Add: the display pane can stay closed; the agent works headless (ScreenCaptureKit captures the virtual display). |
| L5 | Add: one `psyche` VirtioFS device created empty at start; per-folder grants are live `share` replacements (verified: add rw, flip to ro, remove); ro is enforced host-side (EPERM). |
| L6 | Overlay reset takes 0.3 s. The done-when "Reset takes under 30 s" holds for disk + boot-to-SSH (7–42 s cold), not for a settled agent. Add "warm start" only after save/restore is verified. |

## Follow-ups

- S14: re-test `saveMachineStateTo` from the signed helper app; if it still fails, file feedback with Apple.
- S14: build the guest helper as a signed Swift binary that owns vsock, is the TCC client, and has a root LaunchDaemon half for mounts and shutdown.
- Continue the 26 offline patch: in-place edits of root-owned files only; try `systemsetup -setremotelogin`; verify the per-user Setup Assistant state with a screenshot.
- Re-check the Screen Recording "continue to allow" re-prompt cadence on a guest older than 30 days.
- Run VM-mode tests on a host with more than 16 GB, or one guest at a time. Two guests plus an install plus other work restarted this machine.

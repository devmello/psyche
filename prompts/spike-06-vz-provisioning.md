# Spike 06 — A macOS guest created and provisioned without a GUI (Virtualization.framework)

Time box: two days. You are a Psyche engineer (read `README.md`) running a throwaway Swift prototype in `spikes/vz-provisioning/` with a write-up in `docs/spikes/spike-06-vz-provisioning.md`. Branch `spike/06-vz-provisioning`. Do not touch any package. The host is macOS 27 on Apple Silicon.

## Read first
`prompts/_shared-rules.md`; `docs/02-architecture.md` §10; `docs/05-security-and-permissions.md` §13; `docs/07-tech-decisions.md` ADR-009; `research_notes/Psyche personal agent landscape/macos_vm_and_integration.md` KQ1 (Virtualization limits, `VZMacGuestProvisioningOptions`, Lume's Data-volume technique, VirtioFS, vsock, DiskImageKit overlays).

## Question to answer
Can Psyche create a macOS guest from an IPSW, provision an admin user with auto-login and SSH without touching Setup Assistant, share a folder read-only, open a vsock channel, install a node agent inside, grant it Accessibility and Screen Recording, and snapshot/reset the disk, all with public APIs?

## Build
1. A Swift CLI with subcommands: `fetch-ipsw`, `create` (ASIF disk, auxiliary storage, hardware model, machine identifier, entitlement `com.apple.security.virtualization`), `install`, `provision` (use `VZMacGuestProvisioningOptions` with a macOS 27 guest; also attempt the Data-volume technique for a macOS 26 IPSW if available), `start` (headless and with a window), `share` (VirtioFS read-only), `vsock-echo` (host↔guest), `snapshot`/`restore` (DiskImageKit overlay or APFS clone), `stop`.
2. Inside the guest: install a trivial node agent that answers over vsock, and script the pre-granting of Accessibility and Screen Recording during provisioning if possible (document what required a one-time GUI step).
3. Measure: install time, first boot, warm start/restore time, snapshot size, host memory; confirm the two-concurrent-guest cap error; test iCloud sign-in availability notes (do not sign in with real credentials unless you own a test account).

## Report
Step-by-step recipe with API names and versions, what worked GUI-free on 27/27 vs 26, timings, the shared-folder and vsock design to adopt, the snapshot approach, and amendments to ADR-009 and the L1–L6 feature rows.

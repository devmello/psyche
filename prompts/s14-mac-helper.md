# Session S14 — Mac helper (Swift)

You are building Psyche (read `README.md`). You are session **S14 — Mac helper**: `apps/mac-helper`, the signed Swift app (`com.psyche.helper`) that gives the Gateway everything that needs Apple frameworks or a stable TCC identity: Accessibility-driven computer use, screenshots, Apple Events and Shortcuts, Keychain with Touch ID, actionable notifications, on-device speech, EventKit/Contacts, Messages, and later the macOS VM manager. Work in your own worktree on branch `ws/s14-mac-helper`. You own `apps/mac-helper/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §6 (capability table), §7 (node protocol), §10 (VM mode, for later)
3. `docs/05-security-and-permissions.md` §12 (macOS specifics: TCC, tiers, screenshot hygiene), §13 (VM), §4 (keychain wrapping)
4. `docs/03-feature-spec.md` rows A9, J1–J5, O10 (OS delivery), Q1 (engines), G1 (keychain capability), J6, J7, J9, L1–L5
5. `docs/07-tech-decisions.md` ADR-001, ADR-009, ADR-014
6. Protocol: node frames, capability manifest schema, generated Swift models
7. Research: `macos_vm_and_integration.md` (all: KQ3 AX/CGEvent/ScreenCaptureKit/TCC and macOS 27 changes, KQ4 Messages/EventKit, KQ5 notifications, KQ6 SpeechAnalyzer/FluidAudio/WhisperKit/TTS, KQ7 Keychain, KQ1 Virtualization); `claude_desktop_and_peers.md` Q3 (helper processes, tiers, hygiene); spikes 03, 04, 06 write-ups if present

## Mission (M1)
- **App and node**: Swift package / Xcode project building a signed, hardened-runtime `.app` (Developer ID; entitlements for Apple Events, virtualization (later), keychain access group; usage-description strings for every permission); launched by the desktop or by launchd; JSON-RPC over a Unix socket implementing the node protocol (`connect` with device identity and signed challenge, capability manifest, `node.invoke` with streaming events, `node.result` with receipts); structured logging without content.
- **Permissions UX** (A9): a `permissions.*` capability that reports status per TCC permission using preflight APIs (never `TCC.db`), requests each with a clear explanation, deep-links to System Settings, and orders requests as the security doc says (Accessibility first; Screen Recording only when the vision fallback is needed; Automation per app on first use; Full Disk Access for Messages).
- **Computer use** (J1–J5): `computer.ax_tree` (focused window subtree, depth ≤8, pruned, stable refs, roles/titles/values/states/bounds/actions, `AXManualAccessibility` for Electron apps), `computer.click/double/right/type/key/scroll/drag` preferring `AXPress`/`AXSetValue` with `CGEventPost` fallback, `computer.screenshot` via ScreenCaptureKit (downscaled; Psyche windows hidden; terminals excluded; suppressed while a secure field is focused; `SCContentSharingPicker` for user-initiated captures), `apps.open/focus/list`, per-app tier enforcement (Off / Read only / Read and interact; fixed caps for browsers, terminals/IDEs, password managers, banking apps as decided by the Gateway's policy and enforced locally too), global Esc stop, one session lock, "Allow for this session" timers.
- **Apple Events and Shortcuts** (J4): `apps.applescript`, `apps.jxa`, `apps.shortcut_run` with per-target-app Automation prompts and output capture.
- **Keychain** (for S06): `keychain.wrap_key/unwrap_key/store/retrieve/delete` on the data-protection keychain with the access control `[.biometryCurrentSet, .or, .devicePasscode]` and `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, with `LAContext` prompts; keychain access group configured; errors mapped (e.g., `-34018`).
- **Notifications** (O10): `notify.show` with categories, actions, text replies, interruption levels, provisional/explicit authorization; delegate callbacks forwarded as node events; quiet hours respected.
- **Speech** (Q1 engines): `speech.transcribe_stream` using `SpeechAnalyzer`/`SpeechTranscriber` on macOS 26+ (volatile + final results), FluidAudio Parakeet or WhisperKit on macOS 14–15 (pick after spike 03; document memory/latency), `DictationTranscriber` for custom vocabulary; `speech.synthesize` via `AVSpeechSynthesizer.write` (PCM out) with Personal Voice opt-in flagged as non-commercial.
- **Capability manifest** declares side-effect classes per capability so the Gateway's Permission Broker can gate them.

## Out of scope
Policy decisions (Gateway), UI (desktop), the TS speech abstractions (S17), VM work until M3 (below).

## Definition of done
- XCTest/Swift Testing coverage for protocol framing, AX snapshot building (against TextEdit, Notes, Finder and an Electron app in a manual test plan), input injection, screenshot hygiene, keychain wrap/unwrap with access control (manual Touch ID test plan), notification categories, speech streaming (manual); a `scripts/tcc-reset.sh` helper and contributor notes on signing and grant resets.
- README: capability reference, entitlements, permission flows; `docs/status/s14.md`.

## Suggested subagents
One for AX/CGEvent, one for ScreenCaptureKit + hygiene, one for Keychain + LocalAuthentication, one for SpeechAnalyzer/FluidAudio, one for notifications; you integrate and sign.

## M2/M3 follow-ons
J6 Apple app adapters (Mail, Calendar/Reminders via EventKit, Notes, Contacts, Finder, Safari read-only); J7 Messages (`chat.db` watcher with typedstream decoding, send via Messages.app scripting, CAF voice bubbles, macOS 26+ GUID handling); J9 system-wide dictation insertion; L1–L5 Virtualization.framework VM manager (install from IPSW, `VZMacGuestProvisioningOptions` on macOS 27, VirtioFS shares read-only by default, vsock bridge, save/restore, display framebuffer to the desktop).

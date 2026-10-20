# M2 system-wide dictation status (J9, Q2)

Updated 2026-10-19.

## Flow

1. Settings → Voice & dictation gives the hold-to-talk key (`voice.pushToTalk`: fn / Right Option / Right Command), the mode (`voice.mode`: hold / toggle), an optional toggle hotkey (`voice.hotkey`, an Electron accelerator) and `voice.systemWide` (on by default).
2. Electron's `globalShortcut` reports neither key-up nor fn, so the desktop main process arms the helper's listen-only tap through `dictation.watch`. The Gateway forwards `dictation.key` events to that device only. The toggle hotkey is registered in the main process.
3. On key down, main calls `dictation.target`, which returns the focused app and whether it can take text. Psyche's own window answers `own_window` and nothing happens, because the composer dictates there. A password field shows a short HUD message instead.
4. `voice.start` (pcm_s16le, 16 kHz mono) uses the composer's engine and vocabulary. The non-activating HUD panel (`/dictation-hud`) captures the mic, streams ~100 ms chunks to main, and main sends them as `voice.push`. Partials come back as `voice.segment` events and show in the HUD.
5. On key up, main calls `voice.stop` and then `dictation.insert {text, expectPid}`. The helper inserts the text through AX: first `kAXSelectedText`, then the value with the selected range replaced. If both fail it falls back to typing unicode CGEvents. A hold under 250 ms is cancelled silently. Sessions are capped at 2 minutes.

Inserted text never goes to the agent: no thread, no memory. Only main can call `dictation.*` (the renderer IPC refuses it), only a desktop device can call it on the Gateway, and `nodes.invoke` and agent tools can never reach it. The helper refuses secure fields and collapses control characters, so dictation never presses Return. The receipt records only the app and the character count.

## PRs

| PR | What |
| --- | --- |
| devmello/psyche#210 | `protocol:` methods, schemas, event |
| devmello/psyche#218 | helper `dictation.*` capabilities |
| this branch (`ws/m2-dictation-desktop`) | Gateway forwarder + desktop hotkey, HUD, controller |
| next | Settings: on/off, Accessibility state |

## Not done / not verified

- No live run. The J9 done-when criterion (works in TextEdit and Slack) needs the helper's Accessibility grant and a real mic. Everything is tested against a fake helper and a fake Gateway.
- `apps/web/src/shell/voice.ts` (the composer) still uses the pre-protocol shape (`streamId` / `chunk`). The real `voice.*` methods take `sessionId` / `audio` and return `transcript`, so composer dictation fails against the mounted handlers. The desktop path here uses the real shape. That's a follow-up for S11.
- Holding fn alone can open macOS's emoji picker or dictation on release. The workaround is setting System Settings › Keyboard › "Press 🌐 key to" to "Do Nothing", or choosing Right Option instead.

## Settings (ws/m2-dictation-settings)

The desktop's Voice & dictation section gets an "In any app" group with these parts:
- The "Dictate into any app" switch (`voice.systemWide`, on by default).
- An Accessibility row. It shows what the hold-to-talk watch found: Granted when the watch armed, Needed when the helper answered `permission_missing`, "Helper not running" when there's no node. It has "Open System Settings" (Privacy & Security › Accessibility) and "Check again" (re-arms the watch).
- The toggle hotkey. Its field says so when another app already owns the shortcut.

The web build doesn't show the group. `permissions.status` is unreachable through `nodes.invoke` by design (security §10), which is why the state comes from the watch.

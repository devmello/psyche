# Install Psyche from scratch

This page covers installing Psyche from the DMG on a Mac that has nothing else installed: no Node, no checkout, no `.env`. `Psyche.app` carries everything it needs:

- the Gateway (`Contents/Resources/psyched/`, with its own Node runtime);
- the Gateway's LaunchAgent template (`Contents/Resources/launchd/com.psyche.gateway.plist`);
- Psyche Helper (`Contents/Resources/PsycheHelper.app`).

How it is built and signed: [signing.md](signing.md).

## Install

1. Open `Psyche-<version>-<arch>.dmg` and drag **Psyche** onto **Applications**.
2. Eject the disk image, then open Psyche from Applications.
   - If you open it straight from the disk image or from Downloads, macOS runs it from a temporary read-only copy (App Translocation). Psyche notices and asks you to move it to Applications first, because the Gateway's LaunchAgent must point at a path that stays put.

## What the first launch does

1. **Gateway.** The app renders the bundled plist template for `Contents/Resources/psyched/psyched` and your Psyche home. It writes `~/Library/LaunchAgents/com.psyche.gateway.plist` and loads it with `launchctl bootstrap gui/<uid>`. It also clears the quarantine flag on the bundled `psyched/`.
   - While the Gateway starts, the window shows "Starting the Gateway…".
   - The app then waits up to 60 s for `http://127.0.0.1:7979/healthz`.
   - If the Gateway does not answer, the banner says why (with launchd's last exit code), and **Show logs** opens `~/.psyche/logs`.
2. **Pairing.** The window connects to the Gateway and pairs on its own. A local device signs the handshake with `~/.psyche/run/handshake.secret`.
3. **Psyche Helper.** Once the window is paired, the app runs `open -g -j <Psyche.app>/Contents/Resources/PsycheHelper.app`.
   - The helper starts in the background, connects to the Gateway's node socket and pairs automatically.
   - It asks for nothing at launch.
   - Onboarding's Permissions step and Settings → Devices show its state: Starting…, Connected or Not connected. Nothing waits for it.
   - When it quits or an update replaces it, the app starts it again, at most once a minute.
4. **Onboarding:** Meet your agent, Permissions, Connectors, Model & provider, Where Psyche works, Done.
   - **Model & provider:** paste your provider's API key and press **Save to vault**.
     - If you have no vault yet, this creates it and shows your **vault recovery key once**. Save it in a password manager or on paper.
     - The key is stored in the vault as a Gateway-owned item bound to the provider's API origin. The agent never sees it.
     - **Run check** runs the tool-calling check on the model you picked.
   - **Done:** binds the model you picked and confirms three things: the Gateway is running, the helper is connected, and the model is set with a key.
5. **Main chat.** The Gateway answers with the model you picked. No environment variables are involved.

## Admin rights and the vault on an unsigned build

Decided 2026-10-20 (docs/05 §4.3.1).

- **Admin.** The first time the window pairs with a Gateway that has no admin device, it makes this Mac the admin device (`devices.bootstrapAdmin`, audited). Settings → Devices then says "This Mac is the admin device", and the Done step checks it. If an admin already exists, nothing happens.
- **Vault.** When the bundled Psyche Helper cannot hold the Keychain (Touch ID) slot, as with an ad-hoc build, the vault key lives in `~/.psyche/secrets/vault.key`. That file is mode 0600 in a 0700 folder. Settings → Credentials shows "Vault protected by: a key file on this Mac".
- **Recovery key.** The Model & provider step creates the vault and shows its recovery key once. **Copy** it, save it, and tick **I saved it**: the step will not move on until you do.

Until those changes are in your build (#406, #407, #408), grant admin once in Terminal instead, then quit Psyche (⌘Q) and open it again:

```bash
/Applications/Psyche.app/Contents/Resources/psyched/psyched devices list
```

```bash
/Applications/Psyche.app/Contents/Resources/psyched/psyched devices grant <the "Psyche Desktop" id> operator.read,operator.write,operator.approvals,operator.admin
```

## macOS prompts, in order

| When | Prompt | What to do |
| --- | --- | --- |
| First open (ad-hoc or unnotarized build) | "Psyche" Not Opened / Apple could not verify… | System Settings → Privacy & Security → **Open Anyway**, then confirm. Notarized builds instead show "downloaded from the Internet. Are you sure?" → **Open**. |
| The Gateway's LaunchAgent is loaded | Notification: "Background Items Added" | Nothing; leave it allowed in System Settings → General → Login Items & Extensions. If you turn it off there, the Gateway stops. |
| Permissions → Accessibility → Allow | "Psyche would like to control this computer using accessibility features" | **Open System Settings**, turn Psyche on, come back; the row updates. |
| Permissions → Screen Recording → Allow | "Psyche would like to record this computer's screen and audio" (or System Settings opens directly) | Turn Psyche on in System Settings → Privacy & Security → Screen & System Audio Recording. |
| Permissions → Notifications → Allow | "Psyche Helper would like to send you notifications" (from the helper when it is connected, else from Psyche) | **Allow**. |
| Model & provider → Save to vault (Keychain vault slot only) | Touch ID / password "Psyche Helper is trying to unlock your Psyche vault" | Approve. A key-file vault has no prompt. |
| First dictation | "Psyche would like to access the microphone" | **Allow**. |
| First computer-use action on an app, by Psyche Helper | Accessibility / Automation prompts naming **Psyche Helper** | Allow for the apps you want it to use. |

The rows after the Permissions step happen only when you use the feature.

What the 2026-10-20 run showed, on a locally built app (not quarantined, so there was no Gatekeeper prompt): no prompt appeared from install through the main chat when the permission rows were skipped. The Gatekeeper and Background Items rows above are what macOS does for a downloaded app and a new LaunchAgent; they were not seen in that run.

## Where files live

| Path | What |
| --- | --- |
| `/Applications/Psyche.app` | The app, the bundled Gateway and Psyche Helper |
| `~/.psyche/` (`PSYCHE_HOME`) | Everything the Gateway keeps: `state/psyche.sqlite`, `workspace/` (memory files), `vault/` (encrypted vault and its slots), `secrets/vault.key` (unsigned builds only), `logs/gateway.out.log` and `gateway.err.log`, `run/` (node socket, `handshake.secret`, `helper.lock`), backups |
| `~/Library/LaunchAgents/com.psyche.gateway.plist` | The Gateway's LaunchAgent (label `com.psyche.gateway`, `KeepAlive`, `RunAtLoad`) |
| `~/Library/Application Support/Psyche/` | The window's own data: device key, browser profiles, window state |
| `~/Library/Preferences/com.psyche.desktop.plist`, `com.psyche.helper.plist` | macOS preferences for the two apps |

To run against another home, open the app with `open -a Psyche --env PSYCHE_HOME=/path/to/home`. The LaunchAgent is rewritten for that home. Keep the path short: some of the Gateway's Unix sockets live under it, and macOS limits socket paths to 104 bytes.

## Quit, and quit entirely

- **Close the window or ⌘Q:** the Gateway and the helper keep running, so scheduled and background tasks continue. Reopen the app to see them.
- **Psyche menu → Quit Psyche entirely:** stops the Gateway, boots its LaunchAgent out and removes `~/Library/LaunchAgents/com.psyche.gateway.plist`. The next launch installs it again.
  - Psyche Helper keeps running and waits for the Gateway. Quit it with `pkill -x psyche-helper` if you want nothing left.

## Uninstall completely

1. Psyche menu → **Quit Psyche entirely**. If the app is already gone, run:

   ```bash
   launchctl bootout gui/$(id -u)/com.psyche.gateway; rm -f ~/Library/LaunchAgents/com.psyche.gateway.plist
   ```

2. Quit the helper:

   ```bash
   pkill -x psyche-helper
   ```

3. Delete the app: move `/Applications/Psyche.app` to the Trash.
4. Delete your data. This removes your memory, chats, vault and backups for good, so export or back up first if you want them:

   ```bash
   rm -rf ~/.psyche "$HOME/Library/Application Support/Psyche" ~/Library/Caches/com.psyche.desktop ~/Library/Preferences/com.psyche.desktop.plist ~/Library/Preferences/com.psyche.helper.plist "$HOME/Library/Saved Application State/com.psyche.desktop.savedState"
   ```

5. Remove the privacy grants:

   ```bash
   tccutil reset All com.psyche.desktop; tccutil reset All com.psyche.helper
   ```

6. Remove the vault's Keychain item, if you used the Keychain slot: Keychain Access → search "com.psyche.vault" → delete.
7. In System Settings → General → Login Items & Extensions, check that no Psyche entry is left.

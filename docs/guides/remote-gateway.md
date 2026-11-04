# Use Psyche from another computer

Run Psyche on one Mac (the Host) and use it from the desktop app on another computer over Tailscale. The Host keeps your data, memory, connectors, models and automations. The other computer is a window onto it. Nothing runs in the middle: the path is your own tailnet.

Design and decisions: [remote-gateway-2026.md](../design/remote-gateway-2026.md).

## On the Host

Settings → Server & remote access → **Allow other computers** shows these steps and copies the command for you. Psyche does not run `tailscale` or edit the Gateway's configuration itself.

1. Install Tailscale on the Host and on the other computer, and sign both in to the same tailnet.
2. On the Host, publish the Gateway to your tailnet. This is Serve, which only your tailnet can reach. Never use Funnel, which would put the Gateway on the public internet.

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:7979
   ```

3. Tell the Gateway its address. In `config.json` in Psyche's data folder (`~/.psyche`):

   ```json
   {
     "gateway": {
       "publicOrigin": "https://<this-mac>.<tailnet>.ts.net",
       "trustedProxy": { "enabled": true, "trustedProxies": ["127.0.0.1", "::1"] }
     }
   }
   ```

   `publicOrigin` is the address other computers dial, and the Gateway signs its identity for it. `trustedProxy` lets pairing requests show the real tailnet address. The Gateway still listens only on `127.0.0.1`.

4. Restart Psyche on the Host.

Settings → Server & remote access shows the address the Gateway answers to, whether the trusted proxy is on, and the Gateway's identity fingerprint.

## Pair another computer with a link

The quickest way, and the one that needs no typing and no trust on first use.

1. On the Host, Settings → Server & remote access → **Pair another computer**. Tick what the other computer may do (Read, Write and Approvals are ticked, Admin is not) and choose **Make a pairing link**. You confirm with Touch ID or a passkey, as for approving a computer, because the link approves ahead of time.
2. The Host shows a link (`psyche-pair:v1:…`) and a QR code of the same link, drawn on the Host without any network. Copy the link to the other computer. The link works once, for ten minutes, and the Host lists unused links where you can **Revoke** one. At most three can be unused at once.
3. On the other computer, Settings → Server & remote access → Gateways on this computer → **Add a Gateway**, paste the link, and choose **Add Gateway**. A dialog names the Host's address and the identity fingerprint the link carries. Confirm it, then **Switch** to the new Gateway.
4. Psyche checks that the Host proves the identity the link named before it presents the one-time code. If it does, the Host pairs this computer at once with exactly the access you ticked, and the window opens. Nobody approves anything a second time. If it does not, Psyche stops with "This isn't the studio-mac you paired with" and sends nothing.

A link that was already used, has expired or was revoked is refused with "studio-mac refused this pairing link". Make a new one on the Host. Without a link (an address typed in), the first connection still waits for you to approve it on the Host, as below.

In a packaged build, opening a `psyche-pair:` link from the system (a chat, a note) only shows Add a Gateway with the link in the field. It adds nothing and connects to nothing: you still press **Add Gateway** and confirm the address in the dialog.

What is in the link: the Host's address, the fingerprint of its identity key, the one-time code and the Host's name. Anyone who has it during its ten minutes can pair one computer with the access you ticked, so do not post it. It holds nothing that lasts: after use or expiry it is worthless.

## On the other computer, with an address

1. Settings → Server & remote access → Gateways on this computer → **Add a Gateway**. Type the Host's full Tailscale name, `https://<host>.<tailnet>.ts.net`. A short name does not work: the certificate is for the full name. Confirm the address in the dialog that appears.
2. **Switch** to it. Psyche restarts on that Gateway.
3. The window shows a pairing code and a key fingerprint ("Gateway key ab12 cd34 …"). On the Host, the request under Settings → Devices → Waiting to pair shows the same fingerprint, and `psyched identity show` prints it in a terminal. Compare them. Approve the request on the Host with the scopes you want. Admin is off unless you tick it, and each admin change still needs your Touch ID on the Host.

The toolbar then shows the Host's name next to the avatar, with a menu to switch. One Gateway is active at a time. Switching restarts Psyche, so drafts, layout and caches from one Gateway never show in another. Psyche on this Mac keeps running when you switch away, so its automations continue. The switch dialog offers **Switch and stop Psyche on this Mac** as a separate step.

## What the identity pin does

The Gateway has a long-lived identity key in `identity/gateway.key` in its data folder. With a pairing link the fingerprint in the link is the pin until the key itself is stored: the Host must prove a key with that fingerprint at the first connection. With a typed address there is nothing to check against, so this computer holds the key in memory and stores the pin once that connection is paired (trust on first use, which is why you compare the fingerprint). After that it refuses to connect, and signs nothing, when:

- the Gateway presents a different key ("This isn't the studio-mac you paired with");
- the Gateway's proof does not verify for this computer and this connection;
- the Gateway answers for a different address than the one this computer dialed;
- the Gateway presents no key at all;
- the Gateway answers with a result without this computer having answered its challenge (the handshake is a strict sequence: one challenge, this computer's reply, one result);
- the saved Gateways file cannot be read, or this Gateway is no longer in it (Psyche does not run without the pin, and never writes over a file it cannot read).

A tunnel Gateway (`ssh -L`) must use the same port on both ends, so another Gateway or a squatter on a different local port cannot answer for it.

There is no "continue anyway". If the identity changed on purpose (you rebuilt the Host, or ran `psyched identity rotate`), choose **Forget and pair again**. Show the fingerprint on the Host with `psyched identity show`.

## What works on the other computer

Chat, Tasks, Search, Library, memory, automations and the non-Apple connectors work as on the Host and run there. These stay on the Host and say so:

| Feature | On the other computer |
| --- | --- |
| The agent's browser | Off. "The browser runs on studio-mac." Browser tasks keep running in Psyche on the Host, which has to be open there. |
| Computer use | Off. "Computer use works at studio-mac." |
| Share a folder, Show in Finder, Show logs | Hidden. A path chosen here means nothing on the Host. |
| Terminal | Off. "The terminal runs on studio-mac." This window starts no shell, because a shell is started here from what the Gateway answers, and a Gateway on another computer must never be able to ask for one. A real Host terminal over the connection is later work. |
| Apple apps (Notes, Messages, Mail, Calendar, Reminders, Contacts) | The Host's, labelled "On studio-mac". This computer's own are never used. |
| Ask about my screen, system-wide dictation | Off until they can run on this computer. |
| Touch ID and passkeys from this window | Not built yet. Answer risky approvals (payments, credential fills, running commands on the Host, security changes) on the Host. |

## Forgetting a Gateway

Settings → Gateways on this computer → **Forget** removes the saved Gateway, this computer's key for it and everything Psyche stored here for it. The Host still lists this computer: remove it there under Settings → Devices, or with `psyched devices` on the Host.

## Not built yet

Notifications on the other computer, presence (Touch ID or a passkey) on the other computer, the tailnet list in Add a Gateway, LAN reachability, `psyche doctor` checks for Serve and Funnel, and a Windows build. See the design for the order.

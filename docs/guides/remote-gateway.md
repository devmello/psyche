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

## On the other computer

1. Settings → Server & remote access → Gateways on this computer → **Add a Gateway**. Type the Host's full Tailscale name, `https://<host>.<tailnet>.ts.net`. A short name does not work: the certificate is for the full name. Confirm the address in the dialog that appears.
2. **Switch** to it. Psyche restarts on that Gateway.
3. The window shows a pairing code and a key fingerprint ("Gateway key ab12 cd34 …"). On the Host, the request under Settings → Devices → Waiting to pair shows the same fingerprint, and `psyched identity show` prints it in a terminal. Compare them. Approve the request on the Host with the scopes you want. Admin is off unless you tick it, and each admin change still needs your Touch ID on the Host.

The toolbar then shows the Host's name next to the avatar, with a menu to switch. One Gateway is active at a time. Switching restarts Psyche, so drafts, layout and caches from one Gateway never show in another. Psyche on this Mac keeps running when you switch away, so its automations continue. The switch dialog offers **Switch and stop Psyche on this Mac** as a separate step.

## What the identity pin does

The Gateway has a long-lived identity key in `identity/gateway.key` in its data folder. At the first connection this computer pins the key (trust on first use, which is why you compare the fingerprint). After that it refuses to connect, and signs nothing, when:

- the Gateway presents a different key ("This isn't the studio-mac you paired with");
- the Gateway's proof does not verify for this computer and this connection;
- the Gateway answers for a different address than the one this computer dialed;
- the Gateway presents no key at all.

There is no "continue anyway". If the identity changed on purpose (you rebuilt the Host, or ran `psyched identity rotate`), choose **Forget and pair again**. Show the fingerprint on the Host with `psyched identity show`.

## What works on the other computer

Chat, Tasks, Search, Library, memory, automations and the non-Apple connectors work as on the Host and run there. These stay on the Host and say so:

| Feature | On the other computer |
| --- | --- |
| The agent's browser | Off. "The browser runs on studio-mac." Browser tasks keep running in Psyche on the Host, which has to be open there. |
| Computer use | Off. "Computer use works at studio-mac." |
| Share a folder, Show in Finder, Show logs | Hidden. A path chosen here means nothing on the Host. |
| Terminal | Titled "Terminal on studio-mac". It is the Host's shell. |
| Apple apps (Notes, Messages, Mail, Calendar, Reminders, Contacts) | The Host's, labelled "On studio-mac". This computer's own are never used. |
| Ask about my screen, system-wide dictation | Off until they can run on this computer. |
| Touch ID and passkeys from this window | Not built yet. Answer risky approvals (payments, credential fills, running commands on the Host, security changes) on the Host. |

## Forgetting a Gateway

Settings → Gateways on this computer → **Forget** removes the saved Gateway, this computer's key for it and everything Psyche stored here for it. The Host still lists this computer: remove it there under Settings → Devices, or with `psyched devices` on the Host.

## Not built yet

Pairing links and QR codes, notifications on the other computer, presence (Touch ID or a passkey) on the other computer, the tailnet list in Add a Gateway, LAN reachability, `psyche doctor` checks for Serve and Funnel, and a Windows build. See the design for the order.

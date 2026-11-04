# Use Psyche from another computer

Run Psyche on one Mac (the Host) and use it from the desktop app on another computer over Tailscale or your own network. The Host keeps your data, memory, connectors, models and automations. The other computer is a window onto it. Nothing runs in the middle: the path is your own tailnet or your own Wi-Fi or Ethernet.

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

## Over your own network (LAN)

If both computers are on the same Wi-Fi or Ethernet, you can skip Tailscale. This is off until you turn it on.

On the Host: Settings → Server & remote access → **Allow computers on this network**. Psyche then listens on one network interface (the primary Wi-Fi or Ethernet by default; you can pick another in the same panel) on port 7979, over TLS, and announces itself on the network with Bonjour (`_psyche._tcp`). The panel shows the address (`https://<host>.local:7979`), where it is listening, and the certificate's fingerprint. Turning it on needs your Touch ID like any Gateway setting, and `psyche security audit` and `psyche doctor` warn while it is on.

- It never listens on every interface. You choose the network, and turning it off closes the socket. The loopback listener is unchanged.
- The certificate is self-signed and made on the first turn-on, in `identity/lan-tls` in the data folder (private to your user). No certificate authority is involved, so the other computer does not use the system's trust: it pins this certificate and the Gateway's identity key. **Replace certificate** makes a new one; every computer that paired over the network then has to pair again.
- The LAN listener serves only the health check and the connection to the app. The web UI, webhooks and public routes stay on loopback.
- Anyone on the network can reach the pairing screen, so a new computer can only ask: nothing is shared until you approve it on the Host with your scopes and Touch ID. Use this only on a network you trust, not on shared or guest Wi-Fi, and not on a network that isolates clients (Bonjour will not cross it).

On the other computer: Settings → Gateways on this computer → **Look on this network** lists the Psyche it finds, each with the key fingerprint it announced. That is a claim anyone on the network could make; the first connection shows the key the Gateway actually proves, and Psyche refuses unless the two match. Add it, **Switch** to it, then compare the pairing code and key on both screens and approve on the Host, exactly as in the steps above. You can also add `https://<host>.local:7979` or the Host's address by hand.

A LAN Gateway is checked more strictly than a tailnet one. The first connection can only complete if the Gateway's identity key vouches (with a signature over this connection) for the exact certificate it presented, so a computer on the network that answers with its own certificate and passes the real Gateway's messages through is refused ("Its network certificate is not the one this computer pinned"). Once paired, the certificate's pin is stored next to the identity pin and a different certificate is refused before anything is sent. There is no "continue anyway". A pairing link will carry the certificate pin, so even the first connection is pinned; until pairing links land the pin is taken at the first pairing.

## What the identity pin does

The Gateway has a long-lived identity key in `identity/gateway.key` in its data folder. At the first connection this computer holds the key in memory and stores the pin once that connection is paired (trust on first use, which is why you compare the fingerprint). After that it refuses to connect, and signs nothing, when:

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

Pairing links and QR codes (the LAN pin will come with them), notifications on the other computer, presence (Touch ID or a passkey) on the other computer, the tailnet list in Add a Gateway, `psyche doctor` checks for Serve and Funnel, a Windows build, and the phone using the same LAN listener. On the LAN: IPv6, picking more than one network in Settings (the `gateway.lan.interfaces` setting takes several), and following an address that changes while the Gateway runs (turn the setting off and on, or restart). See the design for the order.

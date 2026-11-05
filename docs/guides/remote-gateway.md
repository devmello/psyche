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

## Pair another computer with a link

The quickest way, and the one that needs no typing and no trust on first use.

1. In Psyche on the Host itself (a computer connected to the Host cannot make links, even as admin), Settings → Server & remote access → **Pair another computer**. Tick what the other computer may do (Read, Write and Approvals are ticked, Admin is not) and choose **Make a pairing link**. You confirm with Touch ID or a passkey, as for approving a computer, because the link approves ahead of time.
2. The Host shows a link (`psyche-pair:v1:…`) and a QR code of the same link, drawn on the Host without any network. Copy the link to the other computer. The link works once, for ten minutes, and the Host lists unused links where you can **Revoke** one. At most three can be unused at once.
3. On the other computer, Settings → Server & remote access → Gateways on this computer → **Add a Gateway**, paste the link, and choose **Add Gateway**. A dialog names the Host's address and the identity fingerprint the link carries (never the name written in the link, which anyone could have chosen; the Host's real name replaces the address-based name once it pairs). Confirm it, then **Switch** to the new Gateway.
4. Psyche checks that the Host proves the identity the link named before it presents the one-time code. If it does, the Host pairs this computer at once with exactly the access you ticked, and the window opens. Nobody approves anything a second time. If it does not, Psyche stops with "This isn't the studio-mac you paired with" and sends nothing.

A link that was already used, has expired or was revoked is refused with "studio-mac refused this pairing link". Make a new one on the Host. The link and QR code disappear from the Host's screen as soon as the code is used, revoked or expired, and the copied link is cleared from the clipboard after a minute. Without a link (an address typed in), the first connection still waits for you to approve it on the Host, as below.

For a Host on the local network, choose **From this network** when you make the link (it needs **Allow computers on this network** to be on and listening). That link is a `psyche-pair:v2` link: it also carries the Host's key and the network certificate's pin, so the other computer checks the certificate before it sends anything. An older `psyche-pair:v1` link for a `.local` or private address is refused; make a new one.

In a packaged build, opening a `psyche-pair:` link from the system (a chat, a note) only shows Add a Gateway with the link in the field. It adds nothing and connects to nothing: you still press **Add Gateway** and confirm the address in the dialog.

What is in the link: the Host's address, the fingerprint of its identity key, the one-time code and the Host's name. Anyone who has it during its ten minutes can pair one computer with the access you ticked, so do not post it. It holds nothing that lasts: after use or expiry it is worthless.

## On the other computer, with an address

1. Settings → Server & remote access → Gateways on this computer → **Add a Gateway**. Type the Host's full Tailscale name, `https://<host>.<tailnet>.ts.net`. A short name does not work: the certificate is for the full name. Confirm the address in the dialog that appears.
2. **Switch** to it. Psyche restarts on that Gateway.
3. The window shows a pairing code and a key fingerprint ("Gateway key ab12 cd34 …"). On the Host, the request under Settings → Devices → Waiting to pair shows the same fingerprint, and `psyched identity show` prints it in a terminal. Compare them. Approve the request on the Host with the scopes you want. Admin is off unless you tick it, and each admin change still needs your Touch ID on the Host.

The toolbar then shows the Host's name next to the avatar, with a menu to switch. One Gateway is active at a time. Switching restarts Psyche, so drafts, layout and caches from one Gateway never show in another. Psyche on this Mac keeps running when you switch away, so its automations continue. The switch dialog offers **Switch and stop Psyche on this Mac** as a separate step.

## Over your own network (LAN)

If both computers are on the same Wi-Fi or Ethernet, you can skip Tailscale. This is off until you turn it on.

On the Host: Settings → Server & remote access → **Allow computers on this network**. Psyche then listens on one network interface (the primary Wi-Fi or Ethernet by default; you can pick another in the same panel) on port 7979, over TLS, and announces itself on the network with Bonjour (`_psyche._tcp`). The panel shows the address (`https://<host>.local:7979`), where it is listening, and the certificate's fingerprint. Turning it on needs your Touch ID like any Gateway setting, and `psyche security audit` and `psyche doctor` warn while it is on.

- It never listens on every interface. You choose the network, and turning it off closes the socket. The loopback listener is unchanged.
- The certificate is self-signed and made on the first turn-on, in `identity/lan-tls` in the data folder (private to your user). No certificate authority is involved, so the other computer does not use the system's trust: it pins this certificate and the Gateway's identity key. **Replace certificate** makes a new one; every computer that paired over the network then has to pair again.
- Only private addresses (10.x, 172.16-31.x, 192.168.x) on a physical Wi-Fi or Ethernet interface can be chosen. Tunnels, VPNs, Tailscale, VM and container bridges, and public addresses are never offered. **Also use this network's IPv6 addresses** (off by default) adds the network's private IPv6 addresses (they start with `fd` or `fc`). Public IPv6 addresses and link-local (`fe80`) addresses are never used, and Bonjour is announced over IPv4 only; the other computer reaches the Mac by its `.local` name, which the system resolves to whichever address works.
- Your "yes" is for the network you gave it on. If the Mac moves to another network (or its address changes) Psyche rebinds on the same network and otherwise pauses: the panel says "LAN access is paused on this network" and **Allow on this network** turns it on there. It is also refused while Cloudflare Access is set up as the way in.
- A connection that has not finished `connect` within 10 seconds is closed, an idle one is evicted before a paired device is refused, and turning LAN off or replacing the certificate disconnects everyone on it at once. New computers on the network get a smaller pairing budget (3 per address and 10 in all per hour). Every client on the LAN must bind its connect to the Gateway key and check the certificate signature.
- The LAN listener serves only the health check and the connection to the app. The web UI, webhooks and public routes stay on loopback.
- Anyone on the network can reach the pairing screen, so a new computer can only ask: nothing is shared until you approve it on the Host with your scopes and Touch ID. Use this only on a network you trust, not on shared or guest Wi-Fi, and not on a network that isolates clients (Bonjour will not cross it).

On the other computer: Settings → Gateways on this computer → **Look on this network** lists the Psyche it finds, each with the key fingerprint it announced. That is a claim anyone on the network could make; the first connection shows the key the Gateway actually proves, and Psyche refuses unless the two match. Add it, **Switch** to it, then compare the pairing code and key on both screens and approve on the Host, exactly as in the steps above. You can also add `https://<host>.local:7979` or the Host's address by hand.

A LAN Gateway is checked more strictly than a tailnet one. The first connection can only complete if the Gateway's identity key vouches (with a signature over this connection) for the exact certificate it presented, so a computer on the network that answers with its own certificate and passes the real Gateway's messages through is refused ("Its network certificate is not the one this computer pinned"). Once paired, the certificate's pin is stored next to the identity pin and a different certificate is refused before anything is sent. There is no "continue anyway". A `psyche-pair:v2` link carries the certificate pin and the identity key, so even the first connection is pinned; without a link (Look on this network, or a typed address) the pin is taken at the first pairing.

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

Notifications on the other computer, presence (Touch ID or a passkey) on the other computer, the tailnet list in Add a Gateway, `psyche doctor` checks for Serve and Funnel, a Windows build, and the phone using the same LAN listener. On the LAN: link-local IPv6 (not supported, see the design), picking more than one network in Settings (the `gateway.lan.interfaces` setting takes several), and following an address that changes while the Gateway runs (turn the setting off and on, or restart). See the design for the order.

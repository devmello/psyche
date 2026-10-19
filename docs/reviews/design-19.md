# design-19: control-plane takeover through the loopback auto-approval secret, setup codes and the agent browser

**Severity:** High. **Surface:** `connect` / pairing, WebSocket Origin check, setup codes, agent browser. **Docs:** 05 §1.3 (local malware), §10 (Pairing, CVE-2026-25253 rules); 02 §11. **Owners:** S01, S11, S08.

## Attack

1. **The per-launch handshake secret is a bearer token.** "Loopback auto-approval applies only to the desktop shell presenting the per-launch handshake secret." Wherever that secret lives (an env var of the Gateway or desktop, a file under `run/`, an argv), local malware running as the owner can read it: `ps -E` reads the env of same-user hardened processes (verified, see design-17), `ps -ww` shows argv, and 0600 files belong to that same user. The malware connects to `127.0.0.1:7979` with no `Origin`, presents the secret, and is auto-approved as the desktop with the desktop's scopes (which include `operator.admin`). §1.3 says A6 is protected from this adversary.
2. **Setup codes are pre-approved pairing.** Setup codes carry "a single-use 10-minute bootstrap token". If redeeming one pairs without a confirmation on an existing device, then anything that sees the QR or code during those 10 minutes pairs first: a screen share, a computer-use screenshot of the web UI opened in the user's Chrome (Psyche hides only *its own* windows from captures), a photo, or the shell history from `psyche pair --code`.
3. **The agent browser can load the Gateway UI.** `persist:agent-*` is an ordinary Chromium partition. Loopback origins are blocked only by the hard prohibition "acts on a loopback origin that is not the user's own project", which design-03 bypasses. A page at `http://127.0.0.1:7979` loaded in the agent browser sends `Origin: http://127.0.0.1:7979`, which is on the allowlist. It starts a pairing request named "Pranav's MacBook – Safari", and the owner approves it in the UI.
4. **Opaque and custom origins.** Artifacts render in `sandbox="allow-scripts"` srcdoc iframes, so their WebSocket handshake carries `Origin: null`. The allowlist includes "app scheme": can the agent partition navigate to `app://` (only `about:`, `chrome:` and `file:` are blocked in §6)? A desktop that registers the scheme on `session.defaultSession` only is safe; one that uses `protocol.handle` globally is not.

## Assumption broken

The handshake secret proves "this is the signed desktop", and a valid `Origin` proves "this is the owner's UI". Neither holds against a same-user process or the agent's own browser.

## Proposed control

- Desktop auto-approval is authenticated by **code identity**, not a bearer secret. The desktop connects over a Unix socket. The Gateway reads the peer's audit token (`LOCAL_PEERTOKEN` / `getsockopt`), checks its code signature (`SecCodeCopyGuestWithAttributes` + designated requirement: team id + bundle id), and only then auto-approves. On Linux or in server mode: no auto-approval.
- Setup codes only *start* a pairing. Completing it needs confirmation on an existing device that shows the new device's key fingerprint, platform, IP and transport.
- The agent browser hard-blocks the Gateway's origins and the app scheme (`will-navigate`, plus `webRequest` for subresources and WebSockets). The Gateway refuses `Origin: null` and any connection whose `Sec-Fetch-Site` is `cross-site`.
- Pairing cards label client-declared names as "claimed by the device"; default scopes are `operator.read` only.

## Test case

| # | Action | Expected |
| --- | --- | --- |
| 1 | unsigned process connects over loopback presenting a valid handshake secret | not auto-approved; becomes a pending pairing request |
| 2 | redeem a valid setup code from a new key | status `pending_confirmation`; no token until an existing device confirms |
| 3 | agent browser `navigate("http://127.0.0.1:7979/")` | `denied` (`gateway_origin`), whatever the localhost exception says |
| 4 | WS upgrade with `Origin: null` | 403 |
| 5 | agent partition `navigate("app://psyche/index.html")` | blocked |

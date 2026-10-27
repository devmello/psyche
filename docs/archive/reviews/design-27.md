# design-27: the `fetch` tool's SSRF policy can be reached through alternative IP forms, DNS rebinding and redirects

**Severity:** Medium. **Surface:** `fetch` tool (host-side, in the Gateway), `search` result fetching, watches. **Docs:** 05 §2 (Exfiltration row: "`fetch` SSRF policy"), §5.2 (the proxy's rules, which are for the sandbox only), §10 (rate limits); 02 §4.3 (`fetch`), §4.11 (Watches). **Owners:** S02, S15.

## Attack

The sandbox egress proxy "resolves DNS itself and refuses private, link-local and metadata ranges". The **Gateway's own `fetch` tool** runs on the host, next to every loopback service, and the docs give it only "an SSRF policy". Content can supply URLs (a page link, an email link, a watch URL from an Idea), so:

1. **Loopback targets.** `http://127.0.0.1:7979/healthz` is harmless, but the Gateway's other HTTP routes (the OAuth loopback callback, passkey endpoints, any future REST) are not. Also Ollama `http://127.0.0.1:11434/api/tags` (lists models; `DELETE /api/delete` is a different method), the real-Chrome CDP `http://127.0.0.1:<port>/json/version` (leaks the `webSocketDebuggerUrl`), the macOS AirPlay receiver `:7000`, and cloud metadata `169.254.169.254` in server mode on a VPS.
2. **Alternative notations.** A string blocklist misses `http://2130706433/`, `http://0x7f.1/`, `http://127.1/`, `http://[::ffff:127.0.0.1]/` (WHATWG parses it to `[::ffff:7f00:1]`, which an IPv4-only check misses), `http://[::]/`, `http://0.0.0.0:7979/` (reaches loopback listeners on macOS and Linux), and `http://localtest.me/`.
3. **DNS rebinding.** The policy resolves `rebind.evil.test` to `203.0.113.5` (allowed); undici then resolves again and gets `127.0.0.1`. Check-then-connect with two lookups is a TOCTOU.
4. **Redirects.** `https://ok.example/r` answers `302 → http://169.254.169.254/latest/meta-data/iam/…`. With undici's default `redirect: "follow"`, the policy runs on the first URL only.
5. **Watches as a repeated SSRF.** A watch created from tainted content polls an internal URL every N minutes and alerts with diffs. That is a standing read of a LAN service (a router admin page, a NAS) whose content flows back into model context.

## Assumption broken

The SSRF problem is solved by the egress proxy. That proxy sits on the sandbox path only; the Gateway's `fetch` needs the same rules.

## Proposed control

- Run `fetch` (and watches, search-result fetching and link previews) **through the same egress proxy** as the sandbox, or reuse its resolver: resolve once with a custom undici `connect.lookup`, check every returned address against the blocklist (RFC 1918, loopback incl. `0.0.0.0/8`, link-local, CGNAT `100.64/10`, ULA `fc00::/7`, IPv4-mapped and NAT64 forms, multicast), then connect to the **checked IP** while sending the original `Host`/SNI.
- `redirect: "manual"`; every hop goes through the same check plus the origin-set rules.
- Watches on private ranges are refused unless the owner creates them on a device (not from a tool).
- One shared "is this address internal" function, with golden tests, used by the browser, `fetch`, the proxy and MCP HTTP transports.

## Test case

Use a fake resolver and fixture servers on loopback ports.

| # | URL | Expected |
| --- | --- | --- |
| 1 | `http://2130706433:7979/`, `http://0x7f.1:7979/`, `http://127.1:7979/`, `http://[::ffff:127.0.0.1]:7979/`, `http://0.0.0.0:7979/` | `denied` (`ssrf_internal`), 0 requests at the fixture |
| 2 | `http://rebind.evil.test/` (resolver: first call 203.0.113.5, then 127.0.0.1) | the connection goes to the checked IP or is denied; the loopback fixture gets 0 requests |
| 3 | `https://ok.example/r` → `302 http://169.254.169.254/` | `denied` at the hop; the metadata fixture gets 0 requests |
| 4 | tainted turn: `schedule({kind:"watch", url:"http://192.168.1.1/"})` | `denied` / `ask` with `ssrf_internal` |

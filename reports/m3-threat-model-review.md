# Milestone 3 threat-model re-review: the Milestone 2 surfaces

Date: 2026-10-20. Base: `origin/main` at `90a768a4`. Scope: docs/08-roadmap.md Milestone 3 "Hardening: threat-model review" for the surfaces Milestone 2 added. For each: what [docs/05](../docs/05-security-and-permissions.md) promises, what the merged code does, and the gaps, each filed as an issue with an owner. Companions: [m3-dependency-audit.md](m3-dependency-audit.md); the injection corpus expansion and its pass rates in [docs/status/s18.md](../docs/status/s18.md).

Method: code reading end to end (tool definition → broker → executor or helper), with a few throwaway probes against `packages/sandbox/src/egress`; no apps, containers or Macs were driven. The three high findings were re-read in the Swift source before filing. The gap list in [docs/status/s05.md](../docs/status/s05.md) "Threat model … after wave 2" belongs to the M3 Gateway hardening session and is not repeated; two of its items have since moved: **item 3 (egress proxy) is composed** (`compose/sandbox.ts`), and **item 2 (vault) is in the default composition** (`compose/index.ts`). TM-12 is narrower than item 1 and is filed separately.

## Summary

32 findings in 26 issues (related low findings share one issue).

| Severity | Issues | |
| --- | --- | --- |
| High | 3 | #266 (TM-1), #267 (TM-2), #268 (TM-3) |
| Medium | 14 | #269, #270, #271, #272, #274, #275, #279, #280, #281, #282, #285, #289, #290, #293 |
| Low | 9 | #277, #278, #283, #284, #286, #287, #291, #292, #294 |

The common thread: computer use and Apple Events are the new way to reach a host shell. The fixed caps hold for the actions they name, but menu clicks (TM-1), points that land in another app (TM-2) and scripts (TM-3) each step around them, and the helper runs scripts with its own Full Disk Access and Accessibility grants.

## 1. Computer use (J1–J5)

**Promise.** §12: per-app Off / Read only / Read and interact, fixed caps (browsers read-only, terminals and IDEs click-only, password managers, banking, trading Off and not overridable); secure fields refused at the AX layer; a consumed global Esc; one session at a time; Psyche's windows hidden from captures. §7.2: accessibility tree first, screenshots tagged untrusted; pause-when-unwatched on sensitive apps. §3.6: screenshots and OCR taint.

**Code.** Tools in `apps/gateway/src/compose/computer.ts` (`computer.snapshot | act | screenshot`, `apps.list | open | focus | applescript | shortcuts_list | shortcut_run`), registered only while computer use is enabled. Every result is `untrusted` and taints the turn (AX text, window titles in the snapshot header, screenshots, script and Shortcut output). Tiers are enforced twice: the broker (`packages/permissions/src/apps.ts`, `engine.ts`) on the model-named app and action, and the helper (`Tiers.swift`, `ComputerCapabilities.swift`) on the real element or app. Sound: secure-field refusal, Esc consumption, one session, capture exclusions, refs bound to a snapshot of the same app, screenshots only after a snapshot, `apps.open` refusing executable documents and terminal targets.

**Gaps.**

| Id | Sev | Gap | Owner | Issue |
| --- | --- | --- | --- | --- |
| TM-1 | high | `computer.act click` on a menu-item ref is an AXPress with click intent: Terminal's Shell › New Command, Edit › Paste, Run is a host shell from a click-only app | S14 | #266 |
| TM-2 | high | x/y actions send the helper no app; any approval id authorizes the app under the point and grants it 30 min of interact; System Settings is capped only in the broker | S14, S01 | #267 |
| TM-4 | medium | Notification Center is not capped: the agent can click Approve on Psyche's own banners | S14 | #269 |
| TM-5 | medium | Return, cmd+Return, cmd+shift+D are not risky: an interact grant on Messages or Mail sends without a send card | S14, S01 | #270 |
| TM-6 | medium | `\r` / U+2028 in AX text forge element lines in the gateway's map (card and risk spoofing) | S14, S01 | #271 |
| TM-7 | medium | Pause-when-unwatched (§7.2 item 5) not implemented (also the browser) | S01, S14, S08 | #272 |
| TM-8 | medium | `nodes.invoke` reaches scripts, Shortcuts, computer use and `messages.send` behind a card with no source, recipient or body, kind `connector_action` | S01 | #274 |

## 2. Messages and iMessage (J7, N5)

**Promise.** §9: `dmPolicy: pairing`, explicit owner identity ("an allowlisted sender is not an owner"), group allowlists with mention gating, `contextVisibility`, per-peer isolation, `MEMORY.md` only in the owner's private sessions, and the channel reply authority (a system-decided `once` approval bound to recipient and body, re-verified at dispatch, only into the conversation the request came from). §3.6: non-owner messages taint.

**Code.** Inbound mapping canonicalizes handles; owner match is exact and strong-identity only, so phone-format, case or confusable variants fail closed and weak (SMS) senders never reach the agent or answer approvals. **Only the owner's private chats run turns** (`compose/channels.ts`): designated persons, allowlisted senders and groups get a fixed reply, so non-owner iMessage text never reaches the model today. Group GUIDs (`;+;`) are distinct from DMs; tapback approvals only in the card's own 1:1 chat from a strong owner. Replies go only to the run's own conversation; `verifiedMessagesSends` recomputes the `message_send` binding and spends it at dispatch. No agent tool reads or searches iMessage yet.

**Gaps.**

| Id | Sev | Gap | Owner | Issue |
| --- | --- | --- | --- | --- |
| CORPUS-1 | medium (latent) | An allowlisted sender's turn may read the owner's sources (only write+ refused) and the reply authority can carry the result back; live once non-owner turns are enabled. Corpus case `imsg-nonowner-read-chats-004` | S05, S10 | #293 |
| TM-9 | medium | Forwarded and quoted third-party text inside an owner's message is flattened into owner text; the turn is not tainted (Telegram today) | S10, S01 | #275 |
| TM-10 | low | The iMessage pairing confirmation is always refused by the reply authority (fails closed) | S10 | #277 |

## 3. System dictation (J9, Q2)

**Promise.** docs/03 J9: system-wide dictation inserted via AX / CGEvent. "Dictated text never reaches the agent" is **not** in docs/05; it is in the protocol method description and `compose/dictation.ts`.

**Code.** `dictation.*` are desktop-only Gateway methods, unreachable from agent tools and `nodes.invoke`. Receipts and idempotency records keep the app and character count, never the text; `voice.segment` goes to the dictating device only; the helper refuses secure input and Psyche's windows, collapses control characters and never presses Return. No path from dictated or focused-app text into the model, threads, memory, audit or logs was found.

| Id | Sev | Gap | Owner | Issue |
| --- | --- | --- | --- | --- |
| TM-11 | low | "Desktop only" is a self-declared `platform: "macos"`, which the CLI also sends; the promise is not in docs/05 | S01, S17 | #278 |

## 4. Apple app adapters (J6), `apple_script` and `shortcut_run`

**Promise.** docs/03 J6: typed adapters with an action matrix; §3.5 one binding recipe; §5.4 no host-shell fallback; §3.6 mail and note bodies untrusted.

**Code.** The J6 adapters (Calendar, Reminders, Mail, Notes, Finder, Safari) exist in the helper and the broker's matrix (`apple-apps.ts`) but are **not agent tools yet**; their content does not reach the model today. `apps.applescript` is destructive, kind `apple_script`, binds `{target, language, source}`, `once` only, shows the full source, and is re-verified at dispatch; the gateway refuses targets below interact and the helper's `ScriptGuard` refuses shell escapes, System Events and capped addressed apps. `apps.shortcut_run` binds `{name, input}`, `once`, runs disclaimed. Results are untrusted.

| Id | Sev | Gap | Owner | Issue |
| --- | --- | --- | --- | --- |
| TM-3 | high | `ScriptGuard` is a substring denylist: `ObjC .import` / `$ .NSTask`, `['doShell'+'Script']`, AppleScriptObjC `NSTask`, Finder opening a `.command`, and `tell app id "…"` (missed by `addressedApps`) reach a host shell or a capped terminal, running with the helper's TCC grants; `apple_script` is neither device-only nor authenticated | S14, S05 | #268 |
| TM-8 | medium | (see §1) `nodes.invoke` path shows no source | S01 | #274 |

## 5. Egress proxy and MCP container servers (K4, K5)

**Promise.** §5.2: per-task allowlist declared by the task and approved by the owner, DNS resolved by the proxy, private / link-local / metadata ranges refused, CONNECT only to allowlisted SNI, 403 with `X-Proxy-Error: blocked-by-allowlist`, no TLS interception. §11: `tools/list` hashed with revocation and a visual diff, annotations untrusted, stdio servers sandboxed with `network none`, secrets via env only, never into remote URLs or headers. §3.6: non-bundled MCP results taint.

**Code (sound).** The proxy resolves every address itself and connects to the checked address (no rebinding window); decimal, octal, hex, mapped-IPv6 and NAT64 forms of private addresses are blocked; ports 80/443 only; SNI must equal the CONNECT host; plaintext tunnels refused. Containers run `network none` with a loopback shim to the proxy. The model cannot widen allowlists (`exec` binds `network: "none"`; MCP allowlists come from admin settings). Placeholders are refused in MCP commands and URLs; env is delivered over stdin; a stale `tools/list` hash fails the call.

| Id | Sev | Gap | Owner | Issue |
| --- | --- | --- | --- | --- |
| TM-15 | medium | Plain-HTTP requests keep the client's `Host:` and pipelined requests pass raw (probe-confirmed): virtual-host exfiltration on shared CDNs | S21 | #282 |
| TM-12 | medium | `revokeMcpGrants` never matches a loop-created grant (no `serverId` / `toolsListHash` in the subject; `argsHash` vs `argsSha256`); A→B→A lists revive old grants | S05, S09 | #279 |
| TM-13 | medium | The unknown-tier MCP write ask is dead code (calls are `connector_action`, `mcpTier` never set) | S05, S09 | #280 |
| TM-14, TM-22 | medium | MCP tool descriptions and third-party skill descriptions reach the model untagged and untainting; `tools/list` diffs never shown | S09, S01 | #281 |
| TM-16, TM-19, TM-20 | low | Per-origin verdict cached for the process lifetime; blocked verdict survives allowlisting; some IPv4-embedding IPv6 forms classed public | S21 | #283 |
| TM-17, TM-18, TM-21 | low | MCP results skip the secret redactor; changed servers keep egress scope and volume; remote bearer auth vs the §11 wording | S09 (S01) | #284 |

## 6. Files pane and document conversion (P9)

**Promise.** §3.6: downloads and non-workspace files taint. §5.1: conversion in the sandbox with `network none`, no host mounts beyond the input, bounded. §5.3: host helpers never read the vault, `state/`, `audit/`, browser profiles, `~/.ssh`. §8: untrusted text never reaches protected memory files.

**Code (sound).** Paths are canonicalized, symlink-checked and opened `O_NOFOLLOW`; writes are temp-file + rename; extraction runs in a bounded worker (512 MB, 30 s, 64 MB per inflated part; pdf.js without eval). `documents.convert` runs in the sandbox with `network: none`, imports the input into the volume, 10 MB / 120 s, read-only rootfs, caps dropped; its output goes to viewers only. `read_file` extraction and file names from `list_dir` / `search_files` are untrusted and taint.

| Id | Sev | Gap | Owner | Issue |
| --- | --- | --- | --- | --- |
| TM-23 | medium | No read deny for `$PSYCHE_HOME/state`, `audit/`, browser profiles, `~/.ssh` under a granted ancestor; `write_file` reaches `MEMORY.md` / `AGENTS.md` / `SOUL.md` / `USER.md`, `skills/`, `plugins/`; UI `files.read` can read vault slots | S05, S01 | #285 |
| TM-24 | low | One long-lived shared conversion sandbox; background processes never reaped; no LibreOffice macro lockdown | S13, S21 | #286 |
| TM-25 | low | `edit_file` marks the whole file trusted (latent); undefined `policy.folders` falls back to a host `/workspace` | S01 | #287 |

## 7. Credential fills (G4–G6)

**Promise.** §4.5 exact bound-origin match; §4.6 browser top-frame and frame-origin checks, connector headers HTTPS-only and stripped on cross-host redirects, sandbox secrets as env of one process with masked receipts; §3.5 one fill per approval; §4.7 masking of raw, URL and base64 forms, screenshots blacked out.

**Code (sound).** The vault checks binding, frame origin and form-action origin, recomputes the tool-call binding, refuses replay, and enforces `once` in memory and on disk; the page re-checks top and frame origin; Google uses `redirect: "error"` plus a host allowlist, JMAP is HTTPS-only with every 3xx refused; the redactor covers raw, URL, base64 at three alignments, hex, base32, reversed and fuzzy forms; outputs that echo a secret are withheld; screenshots are refused after a fill.

| Id | Sev | Gap | Owner | Issue |
| --- | --- | --- | --- | --- |
| TM-26 | medium | Secret env values sit in the argv of the long-lived `timeout` / `setsid` wrapper (`/proc/*/cmdline`; host `ps` on Linux) | S21 | #289 |
| TM-27 | medium | A secret outlives its command through background children; a later `exec` reads `/proc/*/environ` and prints it in chunks past the redactor | S21, S06 | #290 |
| TM-28, TM-29 | low | Fill checks use snapshot-cached element state; screenshot suppression resets on navigation (bfcache) | S08 | #291 |
| TM-30 | low | `http://` origins are fillable | S06 | #292 |

## Injection surfaces and their tags

| Surface | Reaches the model through | Tag | Taints |
| --- | --- | --- | --- |
| iMessage owner DM | user message | owner | no |
| iMessage non-owner DM / group | never (fixed reply) | untrusted | n/a |
| Forwarded / quoted text in an owner message | user message text | untrusted part, **lost when flattened** | **no** (#275) |
| Messages read by a tool | no agent tool yet | — | — |
| AX snapshot text, window titles | `computer.snapshot` | untrusted | yes |
| Screenshots | `computer.screenshot`, `browser.screenshot` | untrusted | yes |
| Script / Shortcut output | `apps.applescript`, `apps.shortcut_run` | untrusted | yes |
| Dictation text | never | — | — |
| File names, converted documents | `list_dir`, `search_files`, `read_file` | untrusted | yes |
| MCP tool descriptions | model tool definitions | **none** | **no** (#281) |
| MCP tool results | `mcp__<server>__<tool>` | untrusted unless bundled | yes |
| Skill index | system context | **none** | **no** (#281) |
| Skills via tools | `skills_search`, `skills_read` | untrusted for verified / unknown | yes |

## Corpus

67 new cases cover these surfaces (iMessage non-owner, group and designated-person turns, Messages content, AX text, window titles, screenshots, dictation-adjacent text, Apple adapters, scripts and Shortcuts, file names, converted documents, MCP descriptions and results, skill manifests). Results and pass rates are in [docs/status/s18.md](../docs/status/s18.md). The runner cannot see TM-1, TM-2, TM-3 or TM-5 because the INT-2 stack does not register the real computer-use tools; a stack that does is #294.

# Psyche — Security and Permissions

Status: draft v0.1 (2026-10-18). Companion to [02-architecture.md](02-architecture.md), whose vocabulary this document uses unchanged. Evidence lives in `research_notes/`; inline references use short names: *browser/credentials notes* (`agent_browser_and_credentials.md`), *openclaw notes* (`opendots_openclaw_harnesses.md`), *claude-desktop notes* (`claude_desktop_and_peers.md`), *macos notes* (`macos_vm_and_integration.md`), *shopping/messaging/server notes* (`shopping_messaging_server_docs.md`), *models/memory/MCP notes* (`models_memory_mcp_ui_feed.md`).

MUST / MUST NOT / SHOULD are normative. Numbers labelled "default" are Psyche design decisions unless a reference is given. Where the notes record an unknown, this document says so.

---

## 1. Scope and security goals

### 1.1 Goals, in priority order

1. **No secret ever enters a model context.** Secrets live in the vault / keychain and are injected by the Credential Broker at the executor, after an approval, then masked.
2. **No side effect without owner authority.** Non-owner content is evidence, never permission (openclaw notes, 1f). Only the Permission Broker authorizes a side effect; only an owner-controlled surface answers it.
3. **A compromised turn has a bounded blast radius.** The sandbox decides what is reachable, origin sets which sites, taint when standing grants stop applying.
4. **Every external write is reconstructible.** Receipts with provider identifiers; uncertain outcomes reconciled, never replayed; a hash-chained audit log.
5. **Remote exposure is never accidental.** Loopback bind, signed pairing, scoped tokens, no token in any URL, secure Docker defaults, `psyche security audit`.
6. **The owner can see, edit, export and delete everything**, with provenance.

### 1.2 Assets

| Id | Asset | Where |
| --- | --- | --- |
| A1 | Vault secrets: logins, TOTP seeds, API keys, OAuth refresh tokens, SSH keys, Link wallet pairing, Web Bot Auth key | `vault/vault.db`, keychain |
| A2 | Logged-in sessions: agent browser cookies, connector tokens in use | `browser/profiles/*`, Gateway memory |
| A3 | The owner's data: mail, messages, calendar, granted folders, transcripts, memory files, index | connectors, `state/psyche.sqlite`, `workspace/`, `library/` |
| A4 | Money and reputation: purchases, messages sent in the owner's name | Stripe Link, mail / chat accounts |
| A5 | The host: files, shell, TCC-granted capabilities | Mac, mac helper |
| A6 | Control plane: device tokens, grant ledger, policy, channel allowlists | `state/psyche.sqlite`, `config.json` |
| A7 | Behavior files: `SOUL.md`, `AGENTS.md`, `USER.md`, `MEMORY.md`, skills, plugins | `workspace/`, `skills/`, `plugins/` |

### 1.3 Adversaries

- **Malicious content** (pages, mail, invites, PDFs, chat messages, MCP results, memory entries): puts arbitrary text and images in front of the model; cannot touch the Gateway. The primary adversary (§3, §7, §8).
- **Compromised skills, plugins, MCP servers**: run code or inject instructions at install or later (§11).
- **Other people messaging the agent**: non-owner senders, group members, a designated person exceeding their delegation, impersonators on channels with weak sender identity (§9).
- **Local malware** as the same user: reads user-readable files and attaches to unauthenticated local listeners; we protect A1 and A6 against it, not against root.
- **A lost laptop**: FileVault plus the keychain-wrapped vault key must keep A1 unreadable (§14).
- **An exposed server**: must not be able to pair, replay an approval, or turn a UI token into execution — the CVE-2026-25253 pattern (openclaw notes, 2l; §10).
- **The model provider**: trusted with transcript content, never with secrets; local models remove this party.

### 1.4 Trust boundaries

```
 untrusted world: pages, mail, docs, third-party MCP servers, other senders, merchants
        | content (provenance=untrusted)            ^ egress: allowlisted only
 =======v============================================|=========================
 || EXECUTORS: browser worker [persist:agent-*]  sandbox [UID 1000, no net]
 ||            srt-wrapped helpers + stdio MCP    nodes / VM guest
 ====================^===============================^=========================
                     | typed, hooked tool calls      | node.invoke (paired, signed)
 +-----------------------------------------------------------------------+
 | GATEWAY (psyched) = trusted computing base                            |
 |  agent loop -> Permission Broker -> Credential Broker -> audit        |
 +-----------^-----------------------------^-----------------------------+
             | WS, signed device challenge | JSON-RPC over Unix socket
   psyche-desktop / psyche-web (no secrets)   psyche-mac helper (TCC, keychain, Touch ID)
   phone / chat channels: pairing codes, allowlists, dmPolicy (weakest surface, §9)
```

Only the Gateway talks to model providers, holds the vault key in memory, and decides allow / ask / deny. Executors are assumed compromisable by content; the Gateway is not.

### 1.5 Non-goals

Hostile multi-tenancy (one trusted boundary per Gateway; mutually untrusted users need separate Gateways, openclaw notes, 2k); a compromised host OS or administrator; protecting the owner from their own authenticated decisions beyond §3.9; stealth (honest UA, optional Web Bot Auth, no CAPTCHA solving or fingerprint evasion, browser/credentials notes, KQ3).

---

## 2. Threat model

| Threat | Asset | Controls | Residual risk |
| --- | --- | --- | --- |
| **Prompt injection** via page / mail / document text or images | A2–A5 | Provenance tags; taint escalation (§3.6); planner isolated from untrusted content for sensitive decisions (§3.8); origin sets; confirmations for state-changing and egress actions; no secrets in context; auto-mode model allowlist (§7) | Vendor evals reach 0–0.3 % but "99 % is a failing grade" (browser/credentials notes, KQ5); low-consequence writes inside granted scopes can still be steered |
| **Memory poisoning** | A7, A3 | Only owner-provenance content becomes `USER.md` / `MEMORY.md` facts; dreaming is the sole `MEMORY.md` writer and excludes `untrusted` / `system`; agent writes marked; import validation; `forget` (§8) | Poisoning rose from 4/10 to >80 % once an agent consulted memory (models/memory/MCP notes, Memory 5) |
| **Tool poisoning, shadowing, rug pulls** | A1–A5 | Trust tiers; grants bound to a `tools/list` hash; annotations untrusted; full argument previews; srt / container sandboxing; secrets via env (§11) | Sandboxing does not stop instruction-following attacks (models/memory/MCP notes, MCP 5); misuse of a trusted tool is caught only by approvals |
| **Credential theft** | A1 | SQLCipher vault; DEK in the data-protection keychain behind Touch ID / password; per-fill approval; placeholders; origin-bound fills; masking (§4) | Same-user malware while unlocked; Windows `safeStorage` is per-user, not per-app (browser/credentials notes, KQ1) |
| **Exfiltration** | A3 | Sandbox `network none`; host egress proxy with per-task allowlists; origin sets; `fetch` SSRF policy; new-origin asks in tainted turns; deterministic URL checks | The lethal trifecta cannot be filtered away: any granted read-writable origin can receive data |
| **Approval replay / scope creep** | A4–A6 | Binding hash over exact arguments; single-use `answerToken` per surface; `once` consumed and re-checked at dispatch; 30-minute expiry then deny; restart invalidates; `always` grants bound to kind-specific grant keys with expiry and use counters (§3) | OpenClaw's advisories "approvals could outlive their reviewed working directory" and "reusable approvals could authorize changed arguments" (openclaw notes, 2l) are the targeted failures |
| **Sandbox escape** | A5 | Nonroot, read-only rootfs, capabilities dropped, no network, `/workspace` only; argv arrays; mount validation; inline-eval as whole commands (§5) | Docker shares the host kernel (openclaw notes, 1h); Apple `container` is VM-per-container but macOS 26+ only (macos notes, KQ2) |
| **Control-plane takeover** (a page connects a UI to an attacker Gateway or steals a token; token + admin scope becomes exec) | A6 → A5 | No `gatewayUrl` parameter; UI connects only to its own origin; WebSocket Origin validation; tokens never in URLs; owner-granted scopes; security settings need `operator.admin` plus fresh user presence, unreachable from `node.invoke` or tools (§10) | CVE-2026-25253 was exploitable on loopback-only instances (openclaw notes, 2l); any feature accepting a remote address from a link gets reviewed against this row |
| **Channel impersonation** | A3, A4 | `dmPolicy: pairing`; explicit owner identity; chat cannot approve `financial`, credential fills, `exec_host`, policy or pairing; replies to a bot do not bypass group allowlists (§9) | SMS and email sender identity is weak; a compromised phone approves `write`-class actions until revoked |
| **Supply chain** | A1–A7 | Full-text display, static scan, optional VirusTotal, explicit approval, pinned versions, provenance, signed updates (§11) | ClawHavoc: 341 of 2,857 skills flagged, later counts above 1,000 (openclaw notes, 2l); scanners lag campaigns |
| **VM shared-folder escape** | A5 | Shares read-only by default, never the home root or `/`, per-folder rw grants at dedicated mount points (§13) | SharedRoot chained a guest kernel bug with a read-write host mount (claude-desktop notes, Q4); any rw share remains a bridge |
| **Unsigned-build key storage** (a build whose helper cannot hold the Keychain slot) | A1, A6 | Vault key in a 0600 key file under a 0700 `$PSYCHE_HOME/secrets`, chosen only when the bundled helper cannot hold the Keychain slot, and shown in Settings and `psyche doctor` / `security audit`; recovery key confirmed at setup; first admin bootstrapped once, atomically and audited (§4.3.1) | Any process running as the owner can read the key file and open the vault without Touch ID, and can take the first admin before the desktop does. Same reach as the bundled CLI; FileVault and the account boundary are the only protection at rest. A signed, provisioned helper removes the first part. |
| **Device loss** | A1–A3, A6 | FileVault assumed; device-only keychain accessibility; hashed device tokens; remote revocation from another paired device (§10, §14) | State DB and transcripts rely on FileVault; SQLCipher for `state/` is open |

---

## 3. Permission model specification

### 3.1 Side-effect classes and target kinds

Every tool and node capability declares `sideEffect: none | read | write | destructive | financial` and `targetKind: origin | path | account | command | recipient` (architecture §4.3). `none`: computation or Psyche's own stores, except writes that persist instructions to run later: `task.start`, `schedule`, `idea.*` and `goal.*` are `write` (review design-08), and `task.start` asks with its own `task_start` approval kind. `read`: external or private sources not yet in context. `write`: reversible or private change (drafts, granted-folder writes, calendar events, clicks, typing, form input). `destructive`: irreversible or externally visible (sends to third parties, form submits on read-writable origins, posting, deleting, OAuth consent, accepting terms, account settings, `exec_host`). `financial`: moves money or commits to pay.

### 3.2 Permission modes

| Mode | `read` | `write` | `destructive` | `financial` |
| --- | --- | --- | --- | --- |
| `plan` | `sideEffect: none` tools only; produces a Plan artifact; `ExitPlanMode` needs approval | denied | denied | denied |
| `manual` | first read of each new source asks (`task` / `site` offered) | ask every time; allow-grants not consulted | ask, `once` only | ask, `once`, device surface |
| `balanced` (default) | first read of a new source asks; sensitive categories always ask | standing grants honored, else ask with `once / task / site / session / always` | ask, `once` or `task` | ask, `once`, device surface |
| `auto` | new ordinary origins allowed unless tainted or sensitive | within existing grants: classifier `routine` → allow, `sensitive` → ask, `prohibited` → deny; outside grants: ask | ask (`once` / `task`) | ask, `once`, device surface |

`notify` to the owner (target `recipient: owner`) is not a `write` the owner approves: it reaches only the owner's own inbox, like the reply in their own chat, so it is allowed without a card in every mode but `plan`, tainted or not, and an unattended run's deliverable is delivered (rule `owner_inbox`, #307). Deny rules, ask rules and hooks still apply.

A "new source" is an origin, connector account, folder, computer-use app or MCP server not yet touched in this Task. "Sensitive categories" is a bundled, editable list (banking, brokerage, government, health, password managers, identity providers, mail web UIs) that also triggers pause-when-unwatched (§7). Reads are asked per origin, not per page, as Claude's pane does (claude-desktop notes, Q2).

### 3.3 Policy evaluation order

For every tool call and `node.invoke`, the first terminal result wins:

1. **Hard prohibitions** (§3.9) → `deny`, logged.
2. **User deny rules** in `config.json` (`"mcp__notion__delete_page": "deny"`, origin and path blocklists such as `**/.env`, denied apps) → `deny`.
3. **Hooks** (`before_tool_call`) → `deny` or `ask`, never `allow`; a hook that rewrites arguments restarts evaluation at step 1 (OpenClaw 2026.10.5, after hooks rewrote approved arguments; openclaw notes, 2k).
4. **Taint escalation** (§3.6) → may turn `allow` into `ask`, never the reverse.
5. **Standing grants** → `allow` when a live grant's `grantKey` matches and its scope is valid; `once` grants match only the exact `bindingHash` and are consumed.
6. **Mode default** (table above) → `allow` or `ask`.
7. **Classifier** (auto mode only, §3.8) for residual `write` actions → `allow` / `ask` / `deny`.

`ask` creates an ApprovalRequest and parks the turn or Task in `awaiting_approval`; unattended runs defer it into the approvals queue with a notification and continue without that action (architecture §4.3).

### 3.4 Grant scopes, TTLs, use counter

| Scope | Matches | Lifetime (default) | Uses |
| --- | --- | --- | --- |
| `once` | exact `bindingHash` | until dispatch, at most the request's `expiresAt` | 1 |
| `task` | `grantKey` | until the Task is terminal, or 24 h | unbounded |
| `site` | `grantKey` restricted to one origin | 30 days (`grants.siteExpiryDays`) | counted |
| `session` | `grantKey` | until `/new`, Gateway restart, or 12 h idle | counted |
| `always` | `grantKey` | 90 days (`grants.alwaysExpiryDays`), warning 7 days before | optional `maxUses` |

`destructive` accepts only `once` or `task`; `financial` only `once`; credential fills default to `once` with an opt-in `site` grant (architecture §4.7). Every grant records `createdFrom` (ApprovalRequest id), `uses`, `lastUsedAt`, `lastUsedBindingHash`, and is revocable in Settings → Permissions; `always` grants for `exec` bind to exact argv and cwd, as OpenClaw's do (openclaw notes, 2k).

### 3.5 Binding hash and grant key per action kind

`bindingHash = sha256("psyche.binding.v1|" + kind + "|" + canonicalJSON(fields))` with sorted keys, no insignificant whitespace, NFC strings, integer amounts, sorted arrays where noted. The coarser `grantKey` is what reusable grants bind to. The executor recomputes `bindingHash` from the actual arguments immediately before dispatch; a mismatch denies and audits `binding_mismatch`.

| Kind | `bindingHash` fields | `grantKey` fields |
| --- | --- | --- |
| `exec` (sandbox, `exec_host`) | exact `argv[]`; `cwd` real path; env subset explicitly passed (sorted `name=value`); resolved executable (real path after PATH lookup in the sandbox image; plus binary SHA-256 for `exec_host`) | the same four fields |
| `email.send` | account; recipients (to / cc / bcc lowercased, each sorted); subject; body hash (text and HTML parts); attachment hashes (sorted `sha256:size:name`) | account + sorted recipient set |
| `calendar.*` | account; operation; event payload hash (canonical resource incl. id for update / delete) | account + calendar + operation |
| browser form submit | origin (scheme, host, port); pathname; sorted field names; **plus** a digest of non-credential field values at approval time (credential fields contribute their placeholder id) | origin + pathname |
| credential fill | item id; origin; field selector (`ref_N` plus element tag / type / autocomplete); field (`username` / `password` / `totp` / `token`); executor | item id + origin + field class + executor (`site`) |
| `purchase` / spend request | merchant (canonical host or Link merchant name); amount in minor units; ISO 4217 currency; line-item hash (sorted `{name, qty, unitPrice}`); payment source id | none (`once` only) |
| `write_file` / `edit_file` | real path; operation; SHA-256 of resulting content | folder-grant root + operation |
| `messages.send` / channel send | channel; account; canonical recipient id; body hash; attachment hashes | channel + account + recipient |
| MCP tool call | server id; tool name; `tools/list` hash; args hash | server + tool + `tools/list` hash |

**One recipe for tool calls.** An approval the agent loop obtains for a tool call binds the envelope `bindingHash(kind, {tool, paramsHash, fields})`, where `paramsHash = sha256(canonicalJSON(params))` and `fields` are the kind's fields above as the tool's description gives them. Every verifier recomputes it with the same shared function (`toolCallBindingHash` in `@psyche/protocol/binding`): the loop at dispatch, the connector registry, and the vault before it resolves a credential. The vault never accepts a hash from its caller. It derives the fill fields itself (item id, origin, field, selector, element, executor) from the fill it is about to resolve, takes the tool and params of the call, and has the broker compare the result with the approval record. A `once` approval fills at most once: the loop consumes it at the broker right before dispatch, and the vault separately allows one fill per approval id (`credential_uses`). A fill request the vault builds itself (`requestFill`, no tool call) binds the bare fields.

### 3.6 Taint

**What sets it.** Any result with `provenanceOut: untrusted`: browser snapshots, `read_text`, screenshots and OCR, `fetch` and `search` results, mail / message / calendar bodies not authored by the owner, attachments, downloads, non-workspace files, non-bundled MCP results, non-owner channel messages, tainted subagent results, and memory hits tagged `untrusted`. Indirect routes (tool search, code-mode wrappers, subagents) taint like direct calls (OpenClaw closed that gap in 2026.10.5, openclaw notes, 2k). Each taint records `{sourceKind, origin or sender, toolCallId}`.

**How long.** Turn-scoped, surviving compaction (a summary of untrusted content is untrusted). The Task keeps cumulative `taintedSources[]` for approval cards.

**What it escalates.** In a tainted turn: any `write`, `destructive` or `financial` action on a target *new* relative to the owner's request and to targets approved earlier in the Task → `ask` regardless of `site` / `session` / `always` grants (architecture §4.6); navigation to a new origin → `ask` (architecture §8); a credential fill whose bound origin differs from every tainting origin → `ask` even with a `site` grant; `exec` with `network: proxy` or writes outside `/workspace` → `ask`; untrusted-derived memory writes go only to the daily note tagged `untrusted`, never to `USER.md` / `MEMORY.md` (§8).

### 3.7 Approval requests: delivery, expiry, restart, answers

An ApprovalRequest is `{id, kind, summary, details, bindingHash, requestedAt, expiresAt, surfaces[]}` (architecture §4.6) plus Task / thread / tool-call ids, `sideEffect`, `targetKind`, `target`, `scopesOffered[]`, `taint`, `requiresAuthentication`, `deviceOnly`, `status`, and one single-use `answerToken` per surface.

- **Delivery.** Desktop card outside the message stream; macOS notification with Approve / Deny (`authenticationRequired` for purchases and credential fills); web UI; chat buttons, polls or reactions (§9). Cards show full arguments, never truncated for recipients, commands, amounts or URLs (the WhatsApp MCP exploit hid its payload off-screen, models/memory/MCP notes, MCP 5). `deviceOnly` kinds (`financial`, credential fills, `exec_host`, policy and pairing changes) are never delivered to chat.
- **Expiry.** `expiresAt = requestedAt + 30 min` (`approvals.ttlMinutes`), matching OpenClaw's chat approvals and Stripe Link's window (shopping/messaging/server notes, KQ6). Expiry denies with a visible reason; the Task stays resumable.
- **Restart.** A Gateway restart marks pending requests `invalidated(gateway_restart)`, re-evaluates policy for the parked call and issues a fresh request with new tokens; stale buttons answer "re-issued". A Task turn recovered after the restart that asks for the same call (same Task, kind and `bindingHash`) waits on that re-issued request instead of creating another, so the owner sees one card per action (OpenClaw likewise ignores stale controls after restart, shopping/messaging/server notes, KQ6).
- **First authorized answer wins.** An answer counts only if it arrives before `expiresAt`, references a `pending` request, carries that surface's unused `answerToken`, and comes from a paired device with `operator.approvals` or an owner-identity channel sender (never a merely allowlisted one). Later answers are audited as `late` or `replayed`; cancelling the run rejects all answers.
- **Dispatch.** `once` grants are consumed atomically with dispatch; `bindingHash` is re-verified; the receipt records `approvalId` and `decidedBy`.

### 3.8 Action classifier (auto mode)

- **Sees:** owner-provenance request messages (last 10), Task title and goal, tool name, `sideEffect`, `targetKind`, canonical target, argument metadata (sizes, counts, amounts), the matching grant, and the taint summary (source kinds and origins only).
- **Never sees:** page text, screenshots, tool results, attachments, memory, prior assistant text, or anything tagged `untrusted` — Google's page-isolated "User Alignment Critic" and Anthropic's action classifier (browser/credentials notes, KQ5; architecture §4.6).
- **Labels:** `routine` → allow; `sensitive` → ask; `prohibited` → deny and audit. **Fail closed:** unavailable, timeout (8 s), malformed or low-confidence output → `sensitive`.
- **Circuit breakers:** two `prohibited` labels in a Task pause it with a "possible injection" notification; three consecutive `sensitive` labels downgrade the Task to `balanced` (Claude in Chrome reverts to per-step approval after repeated blocks, KQ2).
- **Model:** the `utility` role, which must pass the regression suite (§7.4); the classifier runs after, never instead of, steps 1–6.

### 3.9 Hard prohibitions (not configurable)

The agent never: types a password, card number, bank account or government identifier it can see; solves or bypasses a CAPTCHA; executes a financial transfer or trade; permanently deletes data without a typed confirmation word; follows instructions found in content; creates third-party accounts without approval; acts on a loopback origin that is not the user's own project (§3.10); edits the Permission Broker, grant ledger, `config.json` security keys or pairing from a tool call; reads Safari / Passwords.app credentials (impossible by design, macos notes, KQ7), keychains, browser profiles, `~/.ssh` or CLI credentials (`~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker`, `~/.kube`, `gh` / `gcloud` config); reaches any of Psyche's own files through a file tool, whatever folder is granted (under `$PSYCHE_HOME` only `workspace/` and `library/` are file targets, #285); changes `MEMORY.md`, `USER.md`, `AGENTS.md`, `SOUL.md`, `IDENTITY.md` or `workspace/skills/` with a file tool (only the `memory` tool, §8, and skill install review, §11); uses a model-visible secret even if the owner pastes one. These mirror the vendor never-lists (browser/credentials notes, KQ4) and are enforced in code — secure-field refusal at the AX layer, placeholder-only fill APIs, no settings-write tool — not only by prompt.

### 3.10 The localhost test-credentials exception

Anthropic's desktop agent carves out a narrow exception that the notes record as observed in a live system prompt, not published (browser/credentials notes, KQ4, Gaps). Psyche adopts it: host exactly `localhost`, `127.0.0.1`, `[::1]`, or ending in `.localhost` / `.test`; the server was started by Psyche this session from an rw-granted folder or is declared in the project's launch config; values are test values for that application (generated this session and recorded in the project's example config, read from its seed / fixture files, or typed by the owner), never a real password for another service, never financial or government identifiers (a payment provider's published test cards excepted), never keys marked live; never sign-in through a non-local identity provider; never a local address proxying someone else's service; decided per action.

### 3.11 Examples

Policy excerpt (`config.json`, no secrets):

```json
{
  "permissions": {
    "defaultMode": "balanced",
    "grants": { "siteExpiryDays": 30, "alwaysExpiryDays": 90, "sessionIdleHours": 12 },
    "approvals": { "ttlMinutes": 30, "chatSurfacesMaySee": ["write", "destructive"],
                   "deviceOnly": ["financial", "credential_fill", "exec_host", "policy", "pairing"] },
    "deny": ["mcp__notion__delete_page", "read_file(**/.env)", "origin:*.onion"],
    "connectors": { "google": { "gmail.read": "allow", "gmail.send": "ask", "calendar.delete": "ask", "drive.write": "deny" } },
    "exec": { "backend": "apple-container", "defaultNetwork": "none", "timeoutSeconds": 60,
              "execHostEnabled": false, "strictInlineEval": true },
    "classifier": { "model": "utility", "timeoutMs": 8000, "failClosed": true }
  }
}
```

ApprovalRequest:

```json
{
  "id": "apr_01J9ZK4Q7W", "kind": "email.send", "sideEffect": "destructive", "targetKind": "recipient",
  "summary": "Send reply \"Re: invoice 0042\" to alice@example.org (1 attachment, 14 KB)",
  "bindingHash": "sha256:5e1d…c0a7",
  "taint": { "tainted": true, "sources": [ "email:billing@vendor.example" ] },
  "scopesOffered": ["once", "task"], "deviceOnly": false, "requiresAuthentication": false,
  "taskId": "task_8821", "threadId": "thr_main", "toolCallId": "call_3f9",
  "requestedAt": "2026-10-18T19:04:11Z", "expiresAt": "2026-10-18T19:34:11Z",
  "surfaces": [ { "kind": "desktop", "deviceId": "dev_mbp", "answerToken": "at_…" },
                { "kind": "telegram", "chatId": 12345678, "answerToken": "at_…" } ],
  "status": "pending"
}
```

Grant ledger entry:

```json
{
  "id": "grt_01J9ZKB2", "scope": "site", "kind": "browser.write", "grantKey": "sha256:9ab2…11f0",
  "boundTo": { "origin": "https://www.kayak.com", "actions": ["click", "type", "select", "scroll"] },
  "createdFrom": "apr_01J9ZH77",
  "createdAt": "2026-10-18T18:40:02Z", "expiresAt": "2026-11-17T18:40:02Z",
  "uses": 37, "maxUses": null, "lastUsedAt": "2026-10-18T19:02:50Z", "revokedAt": null
}
```

Receipt:

```json
{
  "id": "rcp_01J9ZKQ8", "taskId": "task_8821", "toolCallId": "call_3f9", "approvalId": "apr_01J9ZK4Q7W",
  "kind": "email.send", "provider": "google",
  "providerIds": { "messageId": "18f3c2a9e7b1d4c0", "threadId": "18f3b0…" },
  "requestHash": "sha256:5e1d…c0a7", "status": "succeeded",
  "startedAt": "2026-10-18T19:05:30Z", "finishedAt": "2026-10-18T19:05:31Z",
  "evaluator": { "verdict": "verified", "method": "messages.get", "checkedAt": "2026-10-18T19:05:40Z" }
}
```

An `uncertain` receipt (timeout after dispatch) is never retried automatically; the evaluator queries the provider or asks the owner (openclaw notes, 1f–1g).

---

## 4. Credential Broker specification

### 4.1 Vault format

`vault/vault.db` is SQLCipher 4 with library defaults: AES-256-CBC per 4096-byte page, random per-page IV, HMAC-SHA512 per page, 16-byte salt (browser/credentials notes, KQ4). The database key is a random 256-bit data-encryption key (DEK) supplied raw, so SQLCipher's PBKDF2 (256,000 iterations) is used only by the recovery slot. Tables: `items` (kind, name, bound origins / hosts, flags), `fields`, `fills` (audit references), `header` (version, parameters, key slots). Secret values exist nowhere else on disk.

### 4.2 Key wrapping

| Slot | Where | Protection |
| --- | --- | --- |
| Keychain (macOS, default) | data-protection keychain item created by the mac helper (`kSecUseDataProtectionKeychain`, `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, non-synchronizable) | `SecAccessControlCreateWithFlags(... [.biometryCurrentSet, .or, .devicePasscode])`; reading prompts Touch ID / password. Needs a Developer ID-signed helper with a team-prefixed keychain access group, else `errSecMissingEntitlement`; constraint flags combined without `.or` return `errSecParam` (macos notes, KQ7) |
| `safeStorage` (Linux, Windows, server) | DEK encrypted by Chromium OSCrypt (Keychain, DPAPI, libsecret / kwallet), async API | Refused when the backend is `basic_text`; passphrase mode required instead. DPAPI is per user, not per app (browser/credentials notes, KQ1) |
| Recovery key | `vault/recovery.slot` | 32 random bytes shown once as grouped base32; DEK wrapped under an Argon2id-derived key with parameters in the header. Needed after biometric re-enrollment (which invalidates `biometryCurrentSet` items), keychain loss, migration or restore; setup requires confirming it is stored |

### 4.3 Unlock flows

**Per session (desktop default):** the first fill prompts Touch ID; the DEK stays in Gateway memory, zeroized on lock, until `vault.autoLockMinutes` (480), screen lock or sleep. **Per fill:** items flagged `requireAuthEachUse` (default for `payment`, `ssh_key`, and `api_key` tagged `live`) prompt every time with `LAContext` reuse duration 0. **Server mode:** unlock at boot from `PSYCHE_VAULT_KEY_FILE` (0600) or an interactive passphrase; fills still need a device-surface approval, the UI says biometric gating is absent, and high-value items should stay in a Mac node's vault (§13). `vault.unlock` is a helper capability the agent cannot call.

### 4.3.1 Key storage on unsigned builds

Decided 2026-10-20 for the packaged desktop's first run from scratch (docs/status/s11.md "Packaging"). An ad-hoc or profile-less build of Psyche Helper has no keychain access group, so the Keychain slot above fails with `errSecMissingEntitlement`. Nothing else may block a no-terminal install.

**Vault slot**
- **Automatic.** The packaged desktop gives the Gateway a key file only when the bundled helper cannot hold the Keychain slot, i.e. it is not team-signed with an embedded provisioning profile.
  - The key file is `$PSYCHE_HOME/secrets/vault.key`: 32 random bytes, mode 0600, directory 0700, passed as `PSYCHE_VAULT_KEY_FILE` in the LaunchAgent.
  - It is the server-mode slot, and it unlocks without a prompt.
  - With a signed, provisioned helper the Keychain (Touch ID) slot stays the default.
  - A vault that already exists with another slot is never switched.
- **Visible.**
  - Settings → Credentials shows "Vault protected by: a key file on this Mac".
  - "Move to Keychain" appears there and becomes usable once a signed helper is present; re-wrapping the vault key for that slot is still to be built.
  - `psyche doctor` names the slot, and `psyche security audit` reports `vault.key_file_only`.
- **Recovery key.** Onboarding creates the vault silently but shows the recovery key once, with Copy and a required "I saved it" before the step can be left. The key is never logged or written anywhere else.
- **No passphrase prompt** for now.

**Model provider keys**
- Keys the owner enters in onboarding or Settings (`models.setKey`) are Gateway-owned vault items (`model-<provider>`), bound to the provider's API origin.
- The model router reads them per request without per-turn approvals, inside `ResolvedSecret.use`.
- Agents can never list or fill them: `connector_owned`, and `exec` treats them as missing.
- They pass through the vault's redactor in logs and captures. Backups carry them only inside the encrypted archive.

**First admin device**
- The handshake secret never grants `operator.admin` (§10). A fresh install with no admin device used to need `psyched devices grant` in a terminal.
- The packaged desktop's main process, never its renderer, now calls `devices.bootstrapAdmin` once it pairs.
- The Gateway grants admin to that connection only if:
  - it is the desktop shell's own connection: loopback, no Origin, `deviceFamily: desktop`, and the per-launch handshake secret;
  - **no admin device exists**.
- The check and the grant are one immediate SQLite transaction, so two callers cannot both win. Once any admin exists the path answers `conflict` and is inert.
- It reaches no further than a same-user process with the bundled CLI already can.
- It is audited as `device.bootstrap_admin`. Settings → Devices and onboarding say "This Mac is the admin device", and the usual revoke path applies.
- `psyche security audit` flags a Gateway with no admin device (`devices.no_admin`) or more than one bootstrap event (`devices.bootstrap_repeated`).

### 4.4 Item kinds and refusals

`login` (origin-bound username, password, optional TOTP seed), `api_key` / `token` (bound host, header name), `oauth_token` (connector, scopes, refresh token), `ssh_key`, `payment` (Stripe Link Agent Wallet pairing only), `note`, `signing_key` (Web Bot Auth). Refused at entry via Luhn check and identifier patterns: raw card numbers and CVVs, bank account numbers, government identifiers (1Password and Anthropic exclude these too, browser/credentials notes, KQ4).

### 4.5 Placeholder grammar and resolution

```
placeholder := "{{cred:" item-id ["." field] "}}"
item-id     := [a-z0-9][a-z0-9-]{0,63}
field       := "username" | "password" | "totp" | "token" | "header"
```

The model sees `{{cred:github-login}}` and, via `credentials.list`, item names, kinds and bound origins, never values. Resolution happens only inside fill-capable executors and only when the item's bound origin / host matches the current target exactly (or a declared subdomain pattern), a `once` approval or live `site` grant exists, and the taint rule (§3.6) is satisfied. A placeholder anywhere else (message bodies, files, queries, URLs) is rejected and audited; `credentials.request` returns `{status: filled | denied | needs_user, masked}`.

### 4.6 Fill protocol per executor

- **Browser (CDP driver):** verify the top-frame origin equals the bound origin, the focused element matches the approved `ref` / selector and sits in no cross-origin frame, and no Take control is active; then `Input.insertText`. Password fields default to "you type", with "fill from vault with approval" as the alternative (architecture §8).
- **Connectors:** `Authorization` or custom headers are added by the connector's HTTP client for the bound host only, HTTPS only, stripped on cross-host redirects.
- **Sandbox:** secrets become environment variables of one command's process at spawn (`PSYCHE_SECRET_<NAME>`), never of the image or `config.json`; the receipt masks them in captured output.
- **Never** in model-visible text, tool results, prompts, logs, notifications or screenshots.

### 4.7 Post-fill hygiene

For the rest of the turn the broker keeps the value's length and hash: `read_text`, snapshots and transcripts replace exact matches (and URL / base64 encodings) with `•••`; screenshots black out the field's bounding box while it holds the value, and password-type fields always; on submit failure the typed fields are cleared (select-all plus delete via CDP) before control returns to the model — Skyvern's "Mask Secrets" and 1Password's clear-on-failure (browser/credentials notes, KQ3–KQ4).

### 4.8 External managers, system keychain, OAuth tokens

- **1Password.** (a) Service-account SDK: the token is a vault item; the broker fetches items at fill time and Psyche's card is the approval. (b) Agentic Mode in a real Chrome profile: the extension shows item, site and requesting agent, takes a biometric approval, injects, verifies the page did not expose the secret, and clears on failure (GA for Mac 2026-07-16, browser/credentials notes, KQ4); Psyche only learns "sign-in complete". Extensions do not load in the embedded browser (KQ1).
- **Bitwarden Agent Access SDK** (alpha, 2026-03-24): one-time pairing, per-credential approval in the CLI, secrets injected as environment variables into a child process; Psyche feeds sandbox commands and connector processes this way (KQ4).
- **System keychain:** only items Psyche created, in its own access group. Safari / Passwords.app items are unreadable by third-party apps; the sanctioned routes are user-driven AutoFill via a credential-provider extension and, on macOS 26+, the Credential Exchange export flow (macos notes, KQ7).
- **OAuth tokens:** `oauth_token` items with minimal scopes; refresh inside the connector; rotated refresh tokens (Link rotates on every refresh, shopping/messaging/server notes, KQ1) replaced atomically; disconnect revokes and deletes; Google: desktop client, loopback redirect, PKCE, published consent screen so refresh tokens do not expire weekly (shopping/messaging/server notes, KQ4).

### 4.9 Payments: Stripe Link Agent Wallet

1. The Permission Broker issues a `financial`, `deviceOnly` ApprovalRequest bound to merchant + amount + currency + line-item hash.
2. On approval the broker creates a Link spend request (`context` ≥ 100 characters, merchant name and URL, idempotency key); the owner approves in the Link app or web within 30 minutes or it expires (shopping/messaging/server notes, KQ1).
3. The one-time virtual card (or `link_pay_token`) is read into broker memory only — Stripe itself advises a 0600 file over stdout so card details never reach transcripts or logs; the model and the receipt see brand, last4 and expiry.
4. The broker fills the merchant checkout through the browser fill protocol or Stripe's WebMCP tools; a tool carrying `consequentialHint` is never called without the step-1 approval.
5. An amount increase needs a new ApprovalRequest and spend request; `agent_wallet_spend_limits` are checked first; the receipt stores spend-request id, order number and merchant confirmation.

### 4.10 Audit of every fill

Each fill writes `{itemId, kind, executor, target, approvalId or grantId, outcome, maskedAfter, durationMs}` and bumps the grant's use counter; values never appear; Settings → Credentials shows per-item history with Task links.

---

## 5. Sandbox and execution

### 5.1 Container contract

Per-task container from the bundled image: UID / GID 1000, read-only rootfs, all capabilities dropped, no new privileges, `network none`, no host mounts other than the per-thread `/workspace` volume, no Docker socket, model keys, tokens or vault access; 512 MB RAM without swap, 1 CPU, 128 pids, 64 MB tmpfs (OpenMuse's verified contract, openclaw notes, 1h; architecture §9). Commands are bounded (60 s default, up to the automation budget) and produce receipts `{argv, cwd, exitCode, durationMs, stdout/stderr capped at 128 KB, filesChanged}`; interrupted commands are `uncertain` and never replayed. The runner calls the fixed container CLI with argument arrays, never shell strings; mount sources are validated against folder grants after path resolution; `strictInlineEval` treats `python -c`, `node -e`, `bash -c` and heredocs as whole new commands. The parser lessons are OpenClaw's: bind-mount config injection (CVE-2026-27002), PATH command injection (CVE-2026-24763), heredoc expansion in allowlist mode (CVE-2026-27209) (openclaw notes, 2l).

### 5.2 Egress proxy

`network: proxy` routes the container through a host-side proxy with a per-task domain allowlist (declared by the task, approved by the owner). The proxy resolves DNS itself, refuses private, link-local and metadata ranges, tunnels CONNECT only to allowlisted SNI, returns 403 with an explanatory header (Cowork's: `X-Proxy-Error: blocked-by-allowlist`), performs no TLS interception, and logs host and byte counts. No container runtime on macOS filters egress by domain, so this proxy is the only place the policy can live (macos notes, KQ2; claude-desktop notes, Q4).

### 5.3 srt profiles for host-side processes

Host-side helpers (LibreOffice, ffmpeg, converters) and stdio MCP servers run under Anthropic's `srt` (Seatbelt on macOS; bubblewrap plus seccomp on Linux). Psyche's profiles deny reads of `$PSYCHE_HOME/vault`, `state/`, `audit/`, `browser/profiles/`, `~/.ssh`, `~/Library/Keychains`; allow writes only to a per-process scratch directory; allow network only through the srt proxies with a per-process allowlist; and keep `allowAppleEvents`, `enableWeakerNetworkIsolation` and `allowLocalBinding` false, each a documented escape path (macos notes, KQ2). srt leaves reads unrestricted by default, so the deny-read list is mandatory. Composed today: stdio MCP servers (`PSYCHE_SRT_PATH`, or a sandbox container), LibreOffice conversion (its own sandbox container), and the speech helpers ffmpeg and whisper-cli (`PSYCHE_SRT_PATH`; `$PSYCHE_HOME/speech/srt-settings.json` denies the vault, state, audit, security, browser, Library, workspace, backups and MCP directories while models stay readable, writes only to the temp directory, no network). Without srt the speech helpers run with a minimal environment and the Gateway logs `speech.unsandboxed`.

### 5.4 `exec_host`, no fallback, PTY rules

`exec_host` is Off by default, always asks (`once`, or `always` bound to exact argv + cwd + resolved executable + env subset, 30-day expiry), runs under an srt profile unless the owner types `UNSANDBOXED` on the card, and is `deviceOnly`. Without a sandbox backend, `exec` returns an error; there is never a fallback to the host shell (openclaw notes, 1h). A PTY the user opened in the terminal pane is the user's and the agent cannot type into it; an agent PTY runs inside the container, requires a `session`-scoped approval, is shown live, keeps its last 128 KB for the receipt, and stops on Esc.

---

## 6. Browser security

- **Separate profile.** `persist:agent-<profile>` partitions under `browser/profiles/`, cookies encrypted with the `EnableCookieEncryption` fuse, never the user's Chrome (browser/credentials notes, KQ1).
- **Origin sets.** Each Task has `readOnlyOrigins[]` and `readWritableOrigins[]`; writes on a read-only origin ask; new origins in tainted turns ask; unrelated cross-origin iframes are hidden from the model (Google's Agent Origin Sets, KQ5).
- **Allowlists** are enforced on `will-navigate`, `will-redirect` and `did-navigate` against canonical hosts (lowercased, trailing dot removed, IDNA-normalized, default ports stripped, userinfo rejected — the browser-use bypass CVE-2025-47241; subdomains separate; `*.` not covering the bare domain), on every hop, unlike Playwright MCP's lists, which ignore redirects and are "not a security boundary" (KQ3).
- **Downloads** are diverted by `will-download` into `library/quarantine/` with the quarantine attribute, scanned, never executed, opened only after approval.
- **No page JavaScript on third-party sites;** `javascript_tool` exists for the owner's localhost projects only (architecture §8); the highlight overlay runs in an isolated world and reads nothing back.
- **CDP exposure.** `webContents.debugger` in-process, reached by the Gateway over a Unix socket (`run/browser-bridge.sock`, 0600, per-boot key); never `--remote-debugging-port` in production, because CDP has no authentication (KQ1). Real-Chrome mode needs that port: 127.0.0.1, random, own user data dir, only while attached, and flagged by `psyche security audit`.
- **Popups / OAuth.** `setWindowOpenHandler` routes popups into new agent tabs in the same partition; the OAuth redirect origin joins the Task's read-only set for the flow.
- **Extensions:** none embedded (Electron loads only unpacked extensions with a partial API, KQ1); password managers only in real-Chrome mode. **Take control:** user input pauses the agent at once; it resumes after release and re-snapshots; credential fields default to "you type". **CAPTCHA:** a detected challenge pauses the Task and notifies the owner; never attempted, never outsourced.
- **Logged-out default.** Each Task chooses `logged-in` or `logged-out` (ephemeral partition) explicitly, with a persistent indicator; the choice is never silently remembered (the Atlas anti-pattern, KQ2).
- **Web Bot Auth.** Optional Ed25519 key in the vault signs requests per RFC 9421 with `Signature-Agent` pointing at a JWKS directory the owner hosts, `expires` about 1 minute (KQ3). Honest UA always.
- **Never in the browser:** purchases, account creation, card / ID entry, CAPTCHA bypass, permanent deletions, `about:`/`chrome:`/`file:` navigation, clicking through TLS interstitials, or "accept all" on consent banners and terms without approval (declining non-essential cookies is allowed).

---

## 7. Prompt-injection defense stack

### 7.1 Published numbers

Anthropic's 2025 pilot: 23.6 % → 11.2 % attack success with safeguards, 35.7 % → 0 % on four browser-specific attacks; the 2026 GA eval: 17.6 % (Opus 4.5) and 3.8 % (Opus 5) before safeguards, 0 % for Sonnet 5 / Opus 5 / Mythos 5 and 0.3 % for Fable 5 with probes plus an action classifier; a support article cites under 0.08 % (browser/credentials notes, KQ5; claude-desktop notes, Q2). OpenAI's Operator: 62 % → 47 % → 23 % with a monitor at 99 % recall / 90 % precision; confirmations at 92 % recall (KQ2, KQ5). CaMeL: 77 % of AgentDojo tasks with provable security versus 84 % undefended. None is independently replicated (KQ5, Gaps); generations differ by an order of magnitude, hence §7.3.

### 7.2 The stack

1. **Content is data.** Every tool result carries a provenance class; probe-style scanning flags instruction-like text in results.
2. **Privileged / quarantined split.** In auto mode the classifier sees only the owner's request and action metadata (§3.8); in every mode cards render from structured arguments, never from post-read prose.
3. **Origin sets and new-origin confirmation** (§6); a deterministic check on every model-generated URL before navigation or `fetch`.
4. **Confirmations** for state-changing and egress actions (§3.2); `destructive` never gets `site` / `always` grants.
5. **Pause-when-unwatched.** On sensitive-category origins and apps, actions require the pane visible and owner input within 5 minutes, else the Task parks `awaiting_attention` (Operator / Atlas Watch Mode, KQ2). *Status (#272):* computer use implements the input half. In messaging and mail apps, an action with no owner input (their own message or an approval answer) for 5 minutes always gets a card, labelled "While you're away", so an unattended Task parks on that approval. The browser refuses sensitive-category origins without recent owner input or with the pane reported hidden (`presence_required/awaiting_attention`), and the desktop reports pane visibility and input (`attention.report`) to the Gateway's attention state. Still missing: an explicit `awaiting_attention` Task status.
6. **Secrets and payment data never in context** (§4).
7. **Screenshots are the weakest input** (near-invisible text can be OCR'd into context, Brave's "unseeable" injections, KQ5): accessibility trees first, screenshots only for sparse trees, tagged `untrusted`.

### 7.3 Model choice as a security control

`auto` mode and unattended automations are offered only for models on a project-maintained allowlist (published injection evals or an internal pass); other models are labelled "manual / balanced only". Local models default to `balanced`.

### 7.4 Evaluation plan

A versioned corpus of at least 200 cases (hidden DOM fields, URL and tab-title payloads, HTML mail with hidden spans, PDF and invite payloads, MCP description and result payloads, poisoned memory entries, non-owner chat messages, image-only payloads) plus AgentDojo as a public baseline. Targets: 0 % unapproved `financial` / `destructive` actions and credential fills; < 1 % unapproved `write` actions in `balanced`, < 0.5 % in `auto`; 0 promotions of untrusted text into `USER.md` / `MEMORY.md`. Nightly in CI against the default cloud model and every auto-mode model; a regression blocks the release (§15.4).

---

## 8. Memory safety

- **Write gating.** Only `owner` provenance (typed by the owner in a private session, or confirmed on a card) can become a fact in `USER.md` or `MEMORY.md`. Agent inferences carry `agent` provenance, shown by `memory_explain`. `untrusted` and `system` content is never promoted, only quoted in a daily note with its tag. Reference incidents: the Microsoft red-team case (4/10 to over 80 % once the agent consulted memory), SpAIware, the Gemini delayed invocation (models/memory/MCP notes, Memory 5).
- **Learned facts about the owner (#509).** The one automatic `USER.md` writer. After an attended turn, the utility model reads only the owner's own message: never tool output, other people's channel text or incognito threads, and vault values are masked first. It proposes durable facts: name, preferences, routines, people, projects. `packages/memory` refuses:
  - secrets and cards, always;
  - government ids, financial accounts and health details;
  - instruction-like text;
  - duplicates of `USER.md` or live claims.

  Kept facts are written, as owner provenance through memory's job actor, to the dated `## Learned` section with the source thread id. The chat shows a "Learned: …" note with Undo (`memory.forgetLearned`). Every write and undo is audited with ids and reasons, never the text. Setting `memory.userProfile`: `{enabled, review: auto | ask}`; with `ask`, a `memory_protected_write` card comes first.
- **One writer.** Nightly dreaming is the only writer of `MEMORY.md`: it merges, supersedes and decays, requires promotion thresholds (score, recall count, unique queries) and excludes untrusted and system candidates, as OpenClaw's dreaming does. The agent's `memory` tool edits daily notes and `memory/` files; a direct edit of `MEMORY.md`, `USER.md`, `SOUL.md`, `IDENTITY.md` or `AGENTS.md` is a `write` on a protected path that always asks and is marked `agent`.
- **Filters.** Flush and dreaming refuse secret-pattern strings and, by default, government identifiers, financial account numbers and health details unless the owner enables sensitive topics.
- **Incognito** threads: no flush, no index, 24 h expiry; the UI notes that provider-side logging is outside Psyche's control.
- **Forget / retraction.** `forget` stages a retraction, removes linked daily-note material and chunks, marks the fact `superseded` rather than deleting silently, rebuilds the index; the audit log records that a retraction happened, not its content.
- **Import validation.** Imports are data: parsed into facts with `agent` provenance, scanned for instruction-like text (flagged), size-capped, promoted to `owner` only item by item on review.

---

## 9. Channels and people

- **Defaults.** `dmPolicy: pairing` everywhere; unknown senders get an 8-character code (no 0 / O / 1 / I) expiring in 1 hour, at most 3 pending per channel; `open` needs an explicit `"*"` and is audit-flagged (openclaw notes, 2f; shopping/messaging/server notes, KQ2).
- **Owner identity.** `commands.ownerAllowFrom` names the owner's sender ids; `identityLinks` merge them into one session. An allowlisted sender is not an owner and ownership does not grant chat access (openclaw notes, 2f). Only owner identities answer approvals, trigger pairing codes or change anything (OpenClaw shipped an advisory for non-owner senders issuing pairing bootstrap codes, 2l).
- **Groups.** Separate allowlist, `requireMention` on by default, `groupAllowFrom` for who may trigger; replying to a bot message does not bypass it; `contextVisibility: allowlist` strips quoted context from non-allowlisted senders.
- **Isolation.** `session.dmScope: per-channel-peer` whenever anyone but the owner can message; `MEMORY.md` is injected only into the owner's private sessions (architecture §4.8).
- **Delegated persona.** A designated person gets the persona and tool set the owner picked (reads, drafting, scheduling proposals), no `MEMORY.md`, no vault, no `exec`, no browser writes; every `destructive` or `financial` action they trigger routes its ApprovalRequest to the owner; new transports such as voice calls start with no authority (an OpenClaw advisory let calls inherit owner authority, 2l).
- **Allowlisted senders.** A sender who passes `dmPolicy` but is neither the owner nor a designated person is evidence, never permission: their turn is chat-only (`RouteContext.toolAllow: []`, no `MEMORY.md`, provenance `untrusted`). The broker enforces it whatever the route says: it refuses their writes and their reads of the owner's sources (messages, mail, calendar, files, memory, the owner's browser) with `requester:not_owner`, so nothing private can leave through the reply authority into their conversation, and it refuses any tool outside the route's `toolAllow`. A route without a tool list could use only the public, cookie-less web (`web_search`, `web_fetch`) and calls without side effects (#293).
- **Channel reply authority.** A reply in the sender's own conversation is the channel itself, not an agent `message_send` ask. Where the transport needs an approval id per send (iMessage `messages.send`), the broker issues an already-decided, audited `once` approval (`decidedBy` the sender) bound to exactly that recipient and body (§3.5), and the executor re-verifies it at dispatch: for a reply into a conversation a routed sender just wrote in (with the replying turn: only the conversation its request came from, under that turn's mode, deny rules and taint), a pairing code to a fresh pairing conversation, or an approval card to the owner's own chat. Every other send, including the agent writing to someone else, asks as `message_send` (`once` / `task`).
- **Webhook channels.** A provider that pushes inbound messages over HTTP (SMS through a Twilio-compatible webhook, N9) reaches the loopback-bound Gateway only through the owner's tunnel or reverse proxy, so the container transport gate (§10) cannot admit it. For these routes the provider's signature replaces the gate. The route exists only while that channel is configured and accepts `POST` only, with the body capped (64 KB). The signature (Twilio: HMAC-SHA1 over the configured public URL and the sorted POST parameters, compared in constant time) is checked before anything else is acted on; the URL is the configured one, never the request's `Host` or `X-Forwarded-*`. The account and number must match, and a message id seen in the last 24 h is a replay. Every refusal is a `403` with no body, and is counted against the inbound per-sender limit (#254) under its own key (the claimed sender, unverified), so floods are limited and audited without spending a real sender's budget. An admitted message is still a weak identity: it follows the DM policy as a non-owner, gets a chat-only route (no tools, no `MEMORY.md`), never reaches a send authority, a tool or an approval, and cannot run commands. The provider's own credentials stay Gateway-owned secrets. WhatsApp (N6, Cloud API only) follows the same rules with Meta's app-secret signature (`X-Hub-Signature-256`, HMAC-SHA256 over the raw body bytes, compared in constant time before the JSON is parsed, and a body that fails it names no sender, not even for the refusal key) and the configured `phone_number_id` in place of the account; its route also answers the `GET` subscription handshake, but only to the stored verify token, and unlike SMS its admitted senders are strong (table below).
- **Approvals over chat.** Telegram inline buttons (numeric approver ids), iMessage poll or 👍/👎, Slack / Discord buttons, Signal 👍/👎 only, `/approve <id> <decision>` as fallback; chat receives `write` and `destructive` requests only. Chat is weaker than a device: sender identity is platform-controlled (weak for SMS and email), a stolen phone approves silently, there is no user-presence check, delivery can lag past expiry, and unofficial clients such as Baileys add risk. Hence `financial`, credential fills, `exec_host`, policy and pairing changes are `deviceOnly`, with `authenticationRequired` on the Mac.

**Transport identity.** How far a sender id can be trusted on each transport. A weak sender never matches an owner: on a weak transport it follows the DM policy as a chat-only non-owner, with no commands and no approvals; elsewhere a weak DM is dropped. A strong sender can be the owner, but ownership never grants chat access by itself, because dmPolicy still applies.

| Transport | Identity | Why |
| --- | --- | --- |
| SMS | weak | Caller ids can be forged. |
| Email | weak | `From:` can be forged (DKIM / DMARC results are not checked yet). |
| Telegram, Slack, Discord | strong | The platform authenticates the account behind the user id; Telegram anonymous admins and channel posts are senders that are chats, and stay weak. |
| WhatsApp (Cloud API) | strong | The Cloud API delivers Meta-verified numbers over a webhook signed with the app secret. One constant (`WHATSAPP_IDENTITY_STRENGTH`) can make it weak. |
| Signal | strong | Messages come from the owner's own signal-cli daemon: end-to-end encrypted, from a number registered to a device. |
| iMessage | strong, except SMS / RCS handles | Apple ID handles are authenticated by Apple; a chat or handle on the `sms`, `rcs` or `unknown` service is weak. |

---

## 10. Control plane and remote access

- **Bind.** `127.0.0.1:7979`; a non-loopback bind requires explicit `gateway.bind` and a configured auth mode, else the Gateway refuses to start.
- **Pairing.** `connect {deviceId, publicKey, role, capabilities, platform}` → 32-byte challenge (60 s) → client signs `nonce || platform || deviceFamily || protocolVersion || serverOrigin` → approval in the UI; pending requests expire after 5 minutes, setup codes carry a single-use 10-minute bootstrap token (OpenClaw's values, shopping/messaging/server notes, KQ6). Scopes (`operator.read`, `operator.write`, `operator.approvals`, `operator.admin`, `node`) are chosen by the owner, never declared by the client (openclaw notes, 2l). Loopback auto-approval applies only to the desktop shell presenting the per-launch handshake secret, never to a connection with a browser `Origin`; it grants `operator.read|write|approvals` only, never `operator.admin`, because any same-user process can read the secret (until the peer's code signature is checked, design-19). The first admin device is approved by the owner on the machine (`psyched devices approve <code>`). Pairing requests carry the device key's fingerprint, transport and address, and a second key for a pending device id is refused.
- **Tokens** are opaque, stored hashed, bound to the device key; a token alone never authenticates — every connection completes the signed challenge. Revoking a device revokes token and node authority permanently (a pairing-scoped session could restore revoked node authority in OpenClaw, 2l).
- **CVE-2026-25253 rules.** The web UI connects only to `location.origin`, the desktop only to its configured Gateway; no `gatewayUrl` query or deep-link parameter; tokens never in URLs or page-originated connect payloads; the WebSocket handshake rejects any `Origin` outside `{http://127.0.0.1:7979, configured publicOrigin, app scheme}` with 403, in `trusted-proxy` mode too (CVE-2026-32302 was a bypass there). Security settings (`permissions.*`, `exec.*`, `vault.*`, `devices.*`, `channels.*.dmPolicy`, `gateway.*`) require `operator.admin` plus fresh user presence (Touch ID or passkey re-auth) and have no `node.invoke` or tool path.
- **Identity-aware proxies.** Tailscale Serve (tailnet-only HTTPS, Gateway on loopback) or Cloudflare Access (outbound `cloudflared`). Identity headers never authorize the API alone; pairing still applies (architecture §11; shopping/messaging/server notes, KQ3). `cf-access-jwt-assertion` is verified against the team JWKS (OpenClaw checks presence only; keys are re-fetched hourly so a rotated-out key stops verifying, and keys not refreshed for 24 hours verify nothing); `trustedProxies` CIDRs are required and the proxy must overwrite client-supplied identity headers. Public ingress also requires passkeys and `gateway.allowPublicIngress: true`. An SSH tunnel (`ssh -L 7979:127.0.0.1:7979`) is the zero-config alternative; the CLI still pairs as a device.
- **Container bind threat model.** On the container bind the transport is gated before pairing. A peer in `trustedProxies` passes only with a verified identity: a Cloudflare Access assertion that verifies against the team JWKS, or Tailscale Serve's `Tailscale-User-Login` from a peer in `tailscaleProxies` (tailscaled sets and overwrites it). Every other peer must present the token (`Authorization: Bearer`, constant-time compare). A forwarded connection is never loopback, so it is never auto-paired. The token and proxy identities never replace pairing: they keep a neighbouring container, or a compromised one on the same network, from reaching pairing at all. The Gateway listens only on the internal network shared with the proxies, never on its egress network.
- **Passkeys** (web UI behind HTTPS): RP ID = the public origin's host (changing it invalidates passkeys), 20 per user, 20 attempts per IP per 5 minutes (LibreChat's parameters, shopping/messaging/server notes, KQ3). Implemented per paired device (`passkeys.*`): user verification is required, the assertion's challenge is the approval's presence challenge (`ApprovalAnswer.presence`, kind `webauthn`), and adding or removing a passkey on a device that already has one needs a fresh assertion with an existing one (5-minute, single-use ceremony). Passkeys of revoked devices stop counting. Security settings need fresh presence as soon as one passkey (or the helper's Touch ID key) can verify. So do the `operator.admin` calls that widen access or destroy data: `devices.approve`, `channels.configure`, `channels.allowlist.update` (adding), `channels.pairing.approve`, `channels.identities.upsert`, `memory.reset` (not a dry run) and `backup.delete`. Narrowing calls (revoke, deny, remove) stay admin-only, so the owner can always lock things down. The Mac helper's Touch ID key is registered by the owner from an admin device (`devices.presenceKey.register`: the Gateway reads `presence.public_key` from the connected helper, optionally matches the key id the owner expects, and binds the key to that device until it is revoked). Until peer code signatures are checked (design-19), any same-user process with the handshake secret can pair as a helper, so the owner compares key ids. A device's first passkey also needs the owner's presence from an existing verifier, or a stolen admin device could enroll its own authenticator. Presence is sticky: once a verifier could verify, losing all of them fails these calls with `presence_required` instead of falling back to `operator.admin`. Otherwise revoking the owner's passkey device would switch the gate off. `psyched presence reset` on the machine clears it.
- **TLS pinning.** Mobile and remote clients pin the Gateway's SPKI at pairing and refuse mismatches (an iOS client ignoring saved pins was an OpenClaw advisory, 2l).
- **Rate limits.** Pairing 5/hour/IP; failed challenges 10/minute/IP; approval answers 10/minute/identity; inbound chat 30/minute/sender; `fetch` 60/minute/Task. The last two are configurable (`gateway.rateLimits` in `config.json`); refusals are audited (`rate_limit.exceeded`, once per key and minute). Inbound chat is counted per channel and sender before authorization; `fetch` per Task, or per thread for an interactive turn.
- **Docker defaults.** The image binds the container interface only with `PSYCHE_BIND=container`, requires `PSYCHE_GATEWAY_TOKEN_FILE` (a Compose secret, at least 32 characters, mode 0600 or 0400, else the Gateway refuses to start), publishes no port in the sample Compose except to the proxy's internal network, serves an unauthenticated bare-`ok` `/healthz`, runs non-root, and refuses `dmPolicy: open` without a paired owner device (OpenClaw's images "default to an exposed bind"; roundups counted tens of thousands of exposed gateways, openclaw notes, 2f, 2l).
- **`psyche security audit`** checks: bind and proxy configuration; auth mode and public ingress; `operator.admin` devices and last-seen; token age; `always` and `exec` grants with age and uses; `open` DMs and groups without mention gating; chat surfaces configured for device-only kinds; vault backend (`basic_text`), unconfirmed recovery key, auto-lock off; file modes under `$PSYCHE_HOME`; `exec_host` enabled; unknown-tier MCP servers with network; unverified or unpinned skills; real-Chrome debugging port; missing TLS pins; outdated version; logs with bodies; rw or home-root VM shares; computer-use overrides on banking or password-manager apps.
  Coverage today (`apps/cli/src/audit.ts`; a check whose data the Gateway cannot provide is listed as "not checked", never passed):

  | Check | Rule id(s) | Data source | Severity |
  | --- | --- | --- | --- |
  | Bind and proxy configuration | `bind.non_loopback_without_auth`, `transport.plain_http`, `proxy.no_cidrs` | `config.json`, the CLI's URL | critical, high |
  | Auth mode and public ingress | `proxy.public_ingress_without_passkeys` | `settings.get` | high |
  | `operator.admin` devices and last-seen | `devices.stale_admin` | `devices.list` | low |
  | Token age | `devices.old_token` (paired over a year ago) | `devices.list` | low |
  | `always` and `exec` grants | `grants.standing_without_expiry` | `grants.list` | high (exec, purchase, fills, computer), medium |
  | `open` DMs, groups without mention gating | `channels.dm_open`, `channels.group_without_mention` | `channels.list` | critical / high, medium |
  | Vault backend, recovery key, auto-lock | `vault.key_file_only`, `vault.recovery_unconfirmed`, `vault.no_autolock` | `vault.status` | medium, low |
  | File modes under `$PSYCHE_HOME` | `files.home_mode`, `files.sensitive_modes`, `files.modes` | local scan | high, medium |
  | Sandbox disabled, egress proxy (§5.2) | `sandbox.disabled`, `sandbox.egress_off` | `sandbox.status` | high |
  | `exec_host` enabled | `exec_host.enabled` | `settings.get` | high |
  | MCP sandboxing; unknown-tier MCP servers with network | `mcp.no_launcher`, `mcp.unknown_with_network` | `mcp.status`, else the `mcp.servers` setting | low, medium |
  | Unverified or unpinned skills | `skills.unverified` | `skills.list` | high (hash mismatch), medium |
  | Real-Chrome mode (I13) and its consent | `browser.real_chrome_attached`, `browser.real_chrome_enabled`, `browser.real_chrome_standing_grant`, `browser.chrome_debug_port` | `browser.realChrome.status`, `grants.list`, a probe of 127.0.0.1:9222 | medium, low, high, high |
  | Computer-use overrides on banking, password-manager, browser and terminal apps | `computer_use.sensitive_override` | `computerUse.*` settings against the fixed caps (`@psyche/permissions` `appCap`) | medium |
  | Backup encryption and age (U4) | `backups.unencrypted`, `backups.stale` (over 7 days) | `backup.list` | medium, low |
  | Update manifest verification (§11) | `updates.refused`, `updates.no_release_key` | `$PSYCHE_HOME/run/updater.json` written by the desktop | high, low |
  | Outdated version | `version.mismatch` (CLI vs Gateway only: there is no phone-home) | `/version` | low |
  | Logs with bodies; telemetry | `logs.bodies`, `telemetry.enabled` | `settings.get` | medium |
  | Missing TLS pins; rw or home-root VM shares; chat surfaces configured for device-only kinds | not checked yet ("no data source yet") | — | — |
  | Supply chain: 24 h dependency cool-down (`minimumReleaseAge ≥ 1440`), Node base-image pins, pinned release Compose file | not a runtime check (the user's install has no lockfile): `deploy/scripts/release-preflight.mjs` (`cooldown`, `node-pins`, `compose`) runs first in the release workflow and blocks the tag | `pnpm-workspace.yaml`, the Dockerfiles, `deploy/docker-compose.yml` | blocks the release |

---

## 11. Supply chain

- **Skills.** Install shows the full `SKILL.md` and every bundled file, runs a static scan (shell and network calls, install instructions, encoded strings, instruction-like text aimed at the agent), optionally submits hashes to VirusTotal, and requires approval; a lock file pins source, version and content hash; updates diff and re-approve; provenance (`bundled | registry | git | local | agent-proposed`) is shown wherever the skill appears; an eligible skill never widens tool policy — OpenClaw's post-ClawHavoc stance ("treat third-party skills as untrusted code", `skills verify`, `installPolicy`, openclaw notes, 2g). Agent-proposed skills stay drafts until accepted: built from tool and input names only, with the owner's words redacted, kept in a quarantine folder the loader never reads, rate-limited per thread, audited, and installed only through the same replay check, trust card and `skill_install` approval as any third-party skill (T3).
- **Plugins** (T4, implemented: `packages/plugins`, agent-core `plugins.ts`). A code plugin's manifest (`psyche-plugin.json`) declares the capabilities it uses, and nothing else is reachable: `context` (prompt sections, always fenced as untrusted, and they taint the run), `before_tool_call` (sees the tool name and arguments, may block, can never allow or rewrite), `after_tool_call` and `agent_end` (status only, never outputs), `evaluate` (a task's goal and receipts; can only make the evaluator stricter). Install shows the trust card of skills (a device-only `skill_install`, `details.kind: "plugin"`, the capabilities and every file, the static scan; bound to the tree hash and the capabilities, `once` only) and pins the hash in `plugins.lock.json`; changed files never run. Each plugin runs in its own Node process under the permission model (reads only its own folder; no file writes, child processes, workers or addons) with an empty environment; the host shim refuses network access, which Node 24's permission model does not cover, so that part is best effort. Every call has a 3 s deadline: a missed or failed `before_tool_call` blocks and a failed `evaluate` escalates (fail closed). Nothing runs while the admin setting `plugins.enabled` is off (the default). Still the rule stated in the UI: review the code or do not install. Plugins that transform arguments are not offered (openclaw notes, 2k).
- **MCP servers.** Tiers `bundled | verified | unknown`, where verified means registry namespace proof, not safety (models/memory/MCP notes, MCP 1); write+ tools of `unknown` servers ask every time (`mcp:unknown_tier`, `once` only, whatever grants exist; an `mcp__` tool that names no tier counts as unknown); per-tool `allow | ask | deny` keyed `mcp__<server>__<tool>`; `tools/list` hashed, any diff revoking standing grants and showing a visual diff; annotations are untrusted hints, actionable only for `bundled`; full argument previews; stdio servers under srt or in the sandbox container with `network none` and a per-server allowlist; secrets injected from the vault via env at spawn, never in config files, and credential variables never expanded into remote `url` / `headers` (the one exception is an explicit `auth: bearer` vault item bound to the server's origin, resolved with an approval and sent as `Authorization` over HTTPS only, like a connector's header in §4.6); server output passes through the vault redactor like `exec` results (§4.7); removing a server deletes its sandbox volume and egress allowlist, so a new config with the same id starts clean; one-click installs show the exact command (SEP-1024); `.mcpb` sensitive `user_config` goes to the keychain; a Docker MCP Gateway-style runner (`--verify-signatures`, `--block-secrets`, `--log-calls`) where Docker exists (MCP 2, MCP 5). The OWASP MCP Top 10 (token mismanagement, scope creep, tool poisoning, supply chain, command injection, contextual prompt injection, weak auth, missing audit, shadow servers, over-sharing) is the review checklist for new servers.
- **Psyche's own updates.** Developer ID-signed, notarized builds (TCC grants, `safeStorage`, notifications and Electron's `autoUpdater` all need a stable signature, macos notes, KQ3); a manifest (version, per-artifact SHA-256, minimum version, image digests) signed with an offline Ed25519 release key embedded in the app; the updater verifies signature and hashes before staging, refuses downgrades, and fetches only from the pinned release host; the published Compose file pins image digests.
  - **Update manifest** (implemented: `apps/desktop/src/main/update-manifest.ts`, `update-flow.ts`; release side `deploy/scripts/update-manifest.mjs`). Every release publishes `update-manifest.json` (`format: "psyche-update-manifest"`, `version: 1`, `release`, `minimumVersion` from `deploy/update-policy.json`, `publishedAt`, `baseUrl` = `https://github.com/devmello/psyche/releases/download/v<version>/`, per-artifact `name`/`arch`/`kind`/`sha256`/`bytes`, and the Gateway image digest) and `update-manifest.json.sig` (`{alg: "ed25519", keyId, signature}` over the file's exact bytes). The desktop checks, in order: the signature against the keys embedded in `release-keys.ts` (unsigned, unknown-key, mismatched and malformed manifests are refused); the plan (only a strictly newer version; `baseUrl` must be under the pinned `github.com/devmello/psyche/releases/download/`; a zip for this architecture; below `minimumVersion` the update is marked required); the downloaded zip's size and SHA-256, streamed and compared before anything is kept. Only that verified file reaches Squirrel.Mac, through a loopback feed with a random path; Squirrel then checks the code signature as well. With no key embedded, the updater stays off. Each check writes its result to `$PSYCHE_HOME/run/updater.json` (state, refusal code, embedded key count, time; no keys or URLs with credentials) for `psyche security audit`.
  - **Release key.** Ed25519, generated offline with `node deploy/scripts/update-manifest.mjs keygen <file>`; the private half is stored in a password manager and as `RELEASE_SIGNING_KEY` in the GitHub environment `release` (required reviewers, so a tag cannot sign without an owner's approval); the public half (`keyId`, `publicKey`) goes into `release-keys.ts`. Chosen over cosign keyless for this one artifact because the app must verify offline, with no transparency-log or OIDC dependency at update time (the Docker image stays cosign-keyless). Rotation: ship the new public key next to the old one in a release signed by the old key, sign later releases with the new key, then drop the old key. A compromised key is handled the same way, plus a release that removes it and raises `minimumVersion`.

---

## 12. macOS specifics

- **TCC identity.** All TCC-gated calls live in the signed mac helper (`com.psyche.helper`, hardened runtime, Developer ID). Grants key on code signature, bundle id and path; ad-hoc signatures mint a new identity per build, so dev builds lose Accessibility and Screen Recording on every rebuild unless signed with a real certificate at a fixed path; recovery is `tccutil reset Accessibility|ScreenCapture|AppleEvents <bundle id>`; never grant to a shared `node` binary (macos notes, KQ3). Tool subprocesses spawn with responsibility disclaimed so they do not inherit the helper's grants (the Claude desktop `disclaimer` pattern, claude-desktop notes, Q3).

| Permission | Requested when | Why |
| --- | --- | --- |
| Accessibility | first computer-use tier above Off | AX tree, `AXUIElementPerformAction`, `CGEventPost` |
| Screen & System Audio Recording | first screenshot fallback; monthly re-consent on macOS 15+ ("Allow For One Month"); user-initiated captures use `SCContentSharingPicker` to avoid it; the Persistent Content Capture entitlement is VNC-only (macos notes, KQ3) | vision fallback for sparse AX trees |
| Automation (per target app) | first Apple Event to that app; needs `com.apple.security.automation.apple-events` and `NSAppleEventsUsageDescription` | Mail, Notes, Messages send, Shortcuts |
| Full Disk Access | only when iMessage reading is enabled; cannot be requested programmatically | read-only `chat.db` with typedstream decoding; sending uses Messages.app scripting; private-API paths needing SIP off are not shipped (macos notes, KQ4) |
| Calendars, Reminders, Contacts | when the connector is enabled; full access, because read-only event access does not exist (macos notes, KQ4) | EventKit, Contacts |
| Microphone, Speech Recognition | first dictation | SpeechAnalyzer / SFSpeechRecognizer |
| Notifications | onboarding, provisional first | approval cards with actions |

- **macOS 27.** Permission state comes from per-API preflight calls, never `TCC.db`; reads of other teams' app containers are denied by default without a prompt, so Psyche never attempts them; `launchd` ignores quarantined plists, so the installer clears quarantine on the helper's agent plist (macos notes, KQ3).
- **Screenshot and window hygiene.** Psyche's windows and the user's terminal are hidden from captures; captures are downscaled (the Claude app uses ~1372×887); secure text fields are refused at the AX dispatch layer, below the model; a global Esc stops computer use and is consumed so injected content cannot dismiss it; one session drives the computer at a time (claude-desktop notes, Q3).
- **System-wide dictation (J9).** Only the desktop shell's own connection may call `dictation.*`. That connection is loopback, `deviceFamily: desktop`, and carries the per-launch handshake secret, checked at every connect. A declared platform never qualifies a device: a CLI that says `macos` is refused. Node clients and agent tools never reach `dictation.*`. Dictated text goes from the recognizer to the focused app and never reaches the model, threads, memory, audit entries or logs; only character counts are recorded.
- **Tiers and fixed caps.** Per app Off / Read only / Read and interact, prompted on first use, remembered per session (30 minutes for unattended runs). Fixed: browsers read-only (the agent browser is how to act on the web), terminals and IDEs click-only, password managers, banking and trading apps Off and not overridable from chat (architecture §6; claude-desktop notes, Q3).

---

## 13. VM mode security

- **Isolates:** computer use, file access, browsing, sandbox and the guest Gateway run inside the macOS guest; a guest compromise reaches the host only through the channels below.
- **Does not isolate:** the network (NAT shares the host's IP and reaches LAN services and host services bound to 0.0.0.0, macos notes, KQ1); shared folders; the clipboard; an iCloud account signed in inside the guest; the host vault when exposed as a node capability; the hypervisor.
- **Shared folders.** Read-only by default; never the home root, `~/Library`, `/`, or `$PSYCHE_HOME`; rw requires a per-folder approval and mounts at `/Volumes/Psyche Shares/<name>`; other write-back goes through an explicit "copy to host" action with a receipt. SharedRoot (Linux CVE-2026-46331 plus a read-write mount) escaped Cowork's VM for roughly 500,000 users before the patch (claude-desktop notes, Q4).
- **Clipboard.** Host → guest paste is user-initiated in the display pane; guest → host sync is off by default (`vm.clipboard: paste-only | bidirectional | off`); the agent's `read_clipboard` in the guest sees only the guest clipboard.
- **Credentials.** Default: the host vault stays on the host as a node capability — the host helper shows the approval and Touch ID and releases one credential over vsock for one fill, never persisted in the guest. Alternative: a guest vault; whether a guest can use host biometrics is unverified, so assume passphrase or guest-keychain unlock.
- **Snapshots.** DiskImageKit overlays (macOS 27) or APFS clones give per-task "fresh Mac" resets; snapshot before in-guest skill or plugin installs.
- **Two-VM cap.** Virtualization.framework allows two concurrent macOS guests; Psyche uses one and never fans out per task (macos notes, KQ1). A logged-in host session with an unlocked keychain is required, so a locked or headless host pauses VM-mode tasks visibly.

---

## 14. Data handling and privacy

| Data | Location | At rest | Retention (default) |
| --- | --- | --- | --- |
| Vault secrets | `vault/vault.db` | SQLCipher, DEK in keychain | until deleted; `secure_delete` + vacuum |
| Threads, tool I/O, tasks, approvals, grants, receipts | `state/psyche.sqlite` | 0600; relies on FileVault (SQLCipher optional, open question) | threads until deleted; approvals and grants 1 year; receipts indefinitely |
| Workspace files, daily notes, index | `workspace/`, `state/` | plaintext by design | until edited or forgotten |
| Agent browser profiles | `browser/profiles/` | cookies OS-key encrypted | until "Clear browsing data"; logged-out partitions discarded per Task |
| Browser recordings | `library/recordings/` | 0600 | opt-in, 7 days |
| Downloads | `library/quarantine/` | quarantine xattr | 30 days unless kept |
| Dictated text (J9) | nowhere: recognizer → focused app | not stored | never stored or logged |
| Audit log | `audit/YYYY-MM.jsonl` | append-only, hash-chained, 0600 | indefinitely |
| Logs | `logs/` | no bodies, no secrets, URLs cut to origin | 14 days |

`$PSYCHE_HOME` is 0700 and every file 0600 (Cowork shipped world-readable logs and audit files that outlived deletion, claude-desktop notes, Q4). **Export:** "Download your data" writes threads, files, memory, receipts, grants, audit log and `config.json` with vault references only. **Delete:** a thread deletion removes messages, tool I/O, recordings, index chunks and its sandbox workspace; the audit log keeps hashed references, never bodies; vault items are overwritten before deletion. **Telemetry:** none; the update check (version and platform only) can be disabled (`updates.check: false`); crash reports stay local unless the owner attaches one. **Providers:** cloud models see only the transcript content sent to them, never the vault; retention / training opt-outs are enabled where an API offers one (`07-tech-decisions.md`); local models remove the party. **Backups:** `psyche backup` writes `state/`, `workspace/`, `vault/`, `library/` and channel session files (WhatsApp, Signal; 0600 in `state/channels/`) into an `age`-encrypted archive; restoring elsewhere needs the recovery key, because the keychain slot does not travel. A restore never goes backwards on revocations (S23 design-26): device revocations, grant revocations and vault item deletions (including revoked connector tokens) are recorded in `security/revocations.jsonl`, which is never archived. Every boot replays it against devices and grants. The vault drops recorded items from its metadata mirror at start and from the encrypted store at every unlock (`vault.restored_items_dropped`). A restore into a home without the ledger un-pairs every device and revokes every standing grant; vault items cannot be judged there and stay.

---

## 15. Audit log, receipts, incident response, release checklist

### 15.1 Audit log format

Append-only JSONL, one file per month; each entry is hashed over its canonical JSON without `hash`, including `prev`; the first entry of a month carries the previous month's last hash; every 1,000 entries the mac helper (or the server's device key) signs an anchor so truncation is detectable; `psyche audit verify` walks the chain. Today the Gateway signs with a software Ed25519 key in `$PSYCHE_HOME/security/audit-anchor-key.json` (0600, outside backups, not in the vault because anchors are signed unattended while the vault is locked), at every 1,000th entry and at least hourly. The same file keeps the keyring (which seq each key signs from) and the last anchored entry, so deleting `anchors.jsonl` or cutting the tail together with its anchors fails verification; a restore resets that head and audits it (`audit.anchor_head.reset`). `audit.verify` and `psyche audit verify` report how many anchors were signed and by which key.

```json
{"seq":184233,"ts":"2026-10-18T19:05:30.412Z","kind":"approval.decided",
 "actor":{"type":"device","deviceId":"dev_mbp","surface":"desktop","scope":"operator.approvals"},
 "subject":{"approvalId":"apr_01J9ZK4Q7W","taskId":"task_8821","toolCallId":"call_3f9"},
 "data":{"decision":"allow","grantScope":"once","bindingHash":"sha256:5e1d…c0a7","taint":true,"latencyMs":48211},
 "prev":"sha256:2b7e…9d10","hash":"sha256:c41a…77be"}
```

Tool results are logged as sizes and hashes only; config changes as key names and hashes.

### 15.2 Receipts

Receipts (§3.11) are the evaluator's evidence and the Activity view; required for sends, calendar changes, purchases, file writes outside `/workspace`, shell commands, form submissions, computer-use and MCP writes; `uncertain` receipts stay visible until reconciled.

### 15.3 Incident response and disclosure

`SECURITY.md` names a private reporting channel (GitHub private vulnerability reporting plus a security address), acknowledgement within 72 hours, fix targets by severity (critical 7 days, high 30, medium 90), coordinated disclosure after 90 days or on fix, a CVE for every exploitable issue, and a write-up for anything that shipped — the elements the OpenClaw Foundation listed as missing after 722 advisories in a year (openclaw notes, 2l–2m). In product, security releases surface as an update banner and `psyche security audit` gains a check per disclosed misconfiguration class; there is no remote kill switch because there is no phone-home. Owner-side runbook (`docs/runbooks/incident.md`, to be written): revoke devices and tokens from any paired device, `psyche vault rekey`, export the audit chain.

### 15.4 Per-release security checklist

1. Injection regression suite passes against the default model and every auto-mode model.
2. Binding-hash and grant-key golden tests pass for every tool kind; new kinds have rows in §3.5.
3. Static check: no tool, hook or node capability reaches settings writes, pairing or grant mutation.
4. WebSocket Origin and `gatewayUrl` tests; grep gate for tokens in URLs or log lines.
5. Container contract verified on each backend, plus mount-validation, PATH and inline-eval parser tests.
6. srt profiles verified to deny reads of vault, state, audit, browser profiles and `~/.ssh`.
7. Secret-scrubbing tests for transcripts, screenshots, receipts, logs and notifications.
8. `tools/list` hash revocation test; skill lock-file and scan tests.
9. Helper signed and notarized; TCC smoke test on clean macOS 15, 26 and 27 VMs; keychain access-group entitlement present.
10. Release manifest signed, image digests pinned, downgrade refused.
11. `psyche security audit` on the default install, the Compose sample and VM mode: zero findings.
12. Changelog lists every security-relevant default change; SECURITY.md contact verified.

---

## 16. Open questions

1. **Encrypting `state/psyche.sqlite`** with SQLCipher: cost to FTS5 / sqlite-vec and to "files you can read" for transcripts.
2. **Form-submit binding:** the architecture binds "origin + field set"; §3.5 adds a values digest. Confirm what the owner can see at approval time on long forms.
3. **Real-Chrome attachment:** whether a pipe-based CDP attachment can replace `--remote-debugging-port` for the 1Password path; the notes do not cover it.
4. **Guest biometrics in VM mode:** unverified whether a macOS guest can surface host Touch ID; the design assumes not.
5. **Web Bot Auth key custody and JWKS hosting** for owners without a domain; the draft's IETF status is unresolved (browser/credentials notes, KQ3).
6. **Chat approvals for `destructive` sends:** keep them (phone-first owners) or restrict chat to `write`.
7. **Taint across Tasks:** should a Task spawned from a tainted turn (an Idea accepted from an email) inherit taint for its first actions.
8. **Memory tool surface:** the architecture gives the agent the full `memory` command set over the workspace; §8 restricts protected files. Split the tool, or keep one tool with path-based asks.

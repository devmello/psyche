# Psyche — System Architecture

Status: draft v0.1 (2026-10-18). Companion documents: [00-vision-and-principles.md](00-vision-and-principles.md), [03-feature-spec.md](03-feature-spec.md), [04-data-model.md](04-data-model.md), [05-security-and-permissions.md](05-security-and-permissions.md), [06-ui-design.md](06-ui-design.md), [07-tech-decisions.md](07-tech-decisions.md), [08-roadmap.md](08-roadmap.md). Evidence for every external claim lives in `research_notes/` and the synthesized report in `reports/`.

---

## 1. What Psyche is

Psyche is an open-source, self-hosted personal AI agent. It imitates the product shape of Meta's **Muse** (one persistent conversation with a named, customizable agent; Feed, Ideas, Goals and Library surfaces; editable Soul / Identity / Memory files; a watchable browser you can take over; deterministic approval cards; per-connector read-vs-act permissions) and borrows the engineering shape of the **Claude desktop app** (an Electron workspace with chat, browser, terminal, file and plan panes driven by the agent through typed RPC; a signed native helper for computer use; a VM for isolation), **OpenClaw** (one long-lived local Gateway with a typed WebSocket protocol, Markdown persona and memory files with injection budgets, channel pairing and allowlists, approvals bound to exact arguments) and **OpenMuse** (durable server-owned tasks with SQL leases; a review → dispatch → receipt contract for every external write; a network-less nonroot container for commands; a separate browser worker with persistent profiles).

Unlike all four, Psyche:

- runs entirely on hardware you control (a Mac, a Mac-inside-a-Mac VM, or a Linux server), with **no required hosted service** for threads, memory or skills;
- is **model-agnostic** (Anthropic, OpenAI, Google, OpenRouter, Ollama / llama.cpp / LM Studio / MLX, any OpenAI- or Anthropic-compatible endpoint), with the user's own keys or subscriptions;
- treats **credentials as a first-class subsystem** (its own encrypted vault or the system keychain, placeholder substitution so the model never sees a secret, per-fill approvals, 1Password / Bitwarden bridges);
- keeps the **same Gateway binary** for desktop and server mode, so a phone-facing "always on" deployment and a Mac desktop are configuration, not forks.

## 2. Design principles

1. **One conversation, one agent, one identity.** A persistent main chat plus side chats, like Muse. The agent has a name, an avatar and a Soul file the user can read and edit. The system prompt is assembled from files the user can see.
2. **Evidence is not permission.** Web pages, emails, documents, tool results and messages from anyone other than the owner are data. Only the owner (through the UI, a paired device or an allowlisted channel sender) can authorize side effects.
3. **Approvals are capabilities, not chat.** A separate Permission Broker decides allow / ask / deny for every side-effecting tool call. "Ask" produces a structured approval card rendered outside the message stream, with scopes (once / this task / this site / always, with expiry) and a binding hash of the exact arguments. A changed argument, an expired grant or a restarted Gateway invalidates the approval.
4. **Every external write leaves a receipt.** Sends, calendar changes, purchases, file writes, shell commands and browser form submissions are recorded with their provider identifiers. Uncertain outcomes are retained for reconciliation and never silently retried. "A completed model run is not proof the task succeeded": a separate evaluator checks receipts.
5. **The model never sees a secret.** Credentials, cards and tokens live in the vault / keychain and are injected by the Credential Broker at the point of use (browser field, HTTP header, process environment) after an approval. Screenshots and page text are masked afterwards.
6. **Memory is files you can read.** `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` and dated daily notes in a workspace folder, plus a local search index with provenance tags. There is no hidden state the user cannot inspect, edit, export or delete.
7. **Work keeps going.** Tasks are owned by the Gateway, persisted with checkpoints and leases, and continue when the window is closed, the laptop sleeps or the process restarts. Resumption is artifact-based (task file + receipts), not memory-based.
8. **Sandbox is the boundary, approvals are the policy.** Commands run in a nonroot container with no network by default; browsing happens in a separate, agent-owned browser; host-side tool processes run under Seatbelt / bubblewrap; the optional macOS VM isolates everything. Approvals decide *when* to pause, sandboxes decide *what* is reachable.
9. **Local first, loopback by default.** The Gateway binds to 127.0.0.1, every client is a paired device with a signed challenge, remote access goes through Tailscale / SSH / an identity-aware proxy, and there is no telemetry unless the operator turns it on.
10. **Proactivity is bounded and confirmable.** Feed posts, Ideas and inferred Goals are produced by scheduled jobs in batches, cite their evidence, and require a tap to become work. Nothing proactive sends a message to a third party without an approval.

## 3. System overview

```mermaid
flowchart LR
  subgraph Clients["Clients (paired devices)"]
    D[psyche-desktop<br/>Electron shell: chat, panes,<br/>embedded browser, terminal, viewers]
    W[psyche-web<br/>same React UI served by the Gateway]
    P[Phone / chat channels<br/>Telegram, iMessage, WhatsApp,<br/>Signal, Slack, Discord, email, SMS]
  end

  subgraph Gateway["psyched — the Gateway (Node 24, TypeScript)"]
    API[Typed WS + HTTP API<br/>pairing, auth, events]
    AL[Agent runtime<br/>loop, tools, hooks, compaction]
    MR[Model router<br/>providers, fallbacks, cost]
    TE[Task engine<br/>plans, checkpoints, leases]
    PB[Permission Broker<br/>policy, grants, approval cards]
    CB[Credential Broker<br/>vault, placeholders, fills]
    MEM[Memory<br/>workspace files + FTS5/vec index,<br/>flush, dreaming]
    MCP[MCP host + connectors<br/>Google, Microsoft, Slack, Notion,<br/>Linear, GitHub, IMAP/JMAP]
    CH[Channel adapters<br/>dmPolicy, pairing, identities]
    SCH[Scheduler<br/>automations, heartbeat, watches]
    FEED[Feed / Ideas / Goals jobs]
    SRCH[Search index]
    AUD[Audit log + receipts]
  end

  subgraph Executors["Executors (capabilities)"]
    BR[Browser worker<br/>CDP driver over embedded<br/>WebContentsViews or Playwright Chromium]
    SB[Sandbox<br/>Linux container: Apple container /<br/>Docker / Colima, nonroot, no network]
    MH[psyche-mac helper (Swift)<br/>AX/CGEvent/ScreenCaptureKit,<br/>Apple Events, Keychain, Touch ID,<br/>UNUserNotification, SpeechAnalyzer,<br/>EventKit, Messages, Virtualization]
    VM[Optional macOS guest VM<br/>runs psyche-node + full stack]
    RN[Remote nodes<br/>psyche-node on other machines]
  end

  D <-- "WS (loopback)" --> API
  W <-- "WS/HTTPS (Tailscale / proxy)" --> API
  P <-- "channel protocols" --> CH
  API --> AL
  AL --> MR
  AL --> TE
  AL --> PB
  PB --> CB
  AL --> MEM
  AL --> MCP
  SCH --> AL
  FEED --> AL
  AL --> AUD
  AL -- "tool calls" --> BR
  AL -- "tool calls" --> SB
  AL -- "node.invoke" --> MH
  AL -- "node.invoke (vsock/WS)" --> VM
  AL -- "node.invoke (WS)" --> RN
  D -- "hosts views for" --> BR
  D -- "spawns / supervises" --> MH
```

### 3.1 Processes and responsibilities

| Process | Language / runtime | Runs where | Owns |
| --- | --- | --- | --- |
| **psyched** (Gateway) | TypeScript on Node 24 (single binary via `pkg`-style bundling for releases) | Mac (launchd agent) or Linux server (systemd / Docker) | All state: sessions, tasks, memory, approvals, receipts, connectors, channels, scheduler, feed. The only process that talks to model providers. Serves the web UI. |
| **psyche-desktop** | Electron 44 (Chromium 152), React 19, Tailwind 4, shadcn/ui v4, assistant-ui | Mac (later Linux/Windows) | Rendering; the embedded agent browser (WebContentsViews); terminal panes (node-pty + xterm); file viewers and the Markdown editor; dictation UI; OS notification relay; VM display window. Holds **no** secrets and **no** model keys. |
| **psyche-mac** (helper) | Swift, signed `.app` bundle with its own bundle ID, hardened runtime | Mac host and inside a macOS guest VM | Everything that needs a stable TCC identity or Apple frameworks: Accessibility tree + input, screenshots, Apple Events / Shortcuts, Keychain + Touch ID, notifications with actions, SpeechAnalyzer / AVSpeechSynthesizer, EventKit / Contacts, Messages (chat.db + send), Mail/Notes scripting, Virtualization.framework VM lifecycle, share sheet / Quick Look. Connects to the Gateway as a **node**. |
| **psyche-node** | TypeScript (same codebase as Gateway, different entry point) | Inside the macOS VM, on remote Macs/Linux boxes | Exec, file system, browser worker and (through a co-located psyche-mac) computer use, exposed as node capabilities. |
| **browser worker** | In-process in the desktop (CDP over `webContents.debugger`) or a Playwright-managed Chromium sidecar (server mode / headless) | With the desktop, or beside the Gateway | Persistent agent profiles, tabs, snapshots, actions, downloads, recording, credential fill endpoint. |
| **sandbox runner** | Apple `container` (macOS 26+), Docker / Colima fallback, Docker on Linux | Beside the Gateway or the node | Per-task nonroot Linux containers with a persistent `/workspace` volume, no network by default, bounded commands with receipts. |

### 3.2 Deployment topologies

All four are the same binaries with different configuration.

**A. Mac, local (default).** Desktop + Gateway + helper on the host. Browser embedded in the desktop. Sandbox via Apple `container` (macOS 26+) or Colima. Computer use on the host with per-app permission tiers. This is the Claude-desktop / OpenClaw-macOS shape.

**B. Mac with VM mode ("a Mac inside Psyche").** Desktop stays on the host as the window and keyboard; a macOS guest created from an IPSW by the helper runs a full Psyche stack (Gateway, node, helper, browser, sandbox). The host desktop connects to the guest Gateway over vsock / NAT and shows the guest display. The agent's computer use, file access and browsing happen *inside the guest*; the host only shares explicitly chosen folders (VirtioFS, read-only by default) and the clipboard. Exactly one guest per user (Apple's two-concurrent-macOS-VM cap, framework-enforced). Requires macOS 15+ host; first-boot provisioning without GUI uses `VZMacGuestProvisioningOptions` on macOS 27 hosts with macOS 27 IPSWs, and the Lume technique (write user records into the guest Data volume between boots) otherwise. See §10.

**C. Server plus paired Mac node ("always on").** Gateway in Docker Compose on a Linux box; web UI behind Tailscale Serve or Cloudflare Access; channels (Telegram, WhatsApp, Signal, Slack, Discord, email) terminate on the server; the Mac app pairs as a node and provides Mac-only capabilities (iMessage, notifications with actions, screen, Keychain-held credentials, Apple apps). Approvals fan out to the Mac and the phone. This is the OpenClaw "remote mode" shape.

**D. Server only.** Same as C without a Mac. No iMessage, no Apple-app control; browser via the Playwright sidecar; dictation via whisper.cpp / Parakeet on the server or in the browser client.

## 4. The Gateway in detail

### 4.1 Module map

```
apps/gateway/src
  api/            WS + HTTP server, frame schemas, pairing, auth, event bus, static UI
  agent/          loop, context assembly, compaction, subagents, hooks, tool registry
  models/         provider adapters (AI SDK v7), router, pricing, usage ledger
  tasks/          durable task engine: plans, steps, checkpoints, leases, input requests
  permissions/    policy engine, grants, approval cards, delivery, binding hashes
  vault/          credential broker: SQLCipher vault, keychain wrapping, placeholder fill
  memory/         workspace files, budgets, index (FTS5 + sqlite-vec), flush, dreaming
  mcp/            MCP host (spec 2026-07-28 + 2025-11-25 fallback), trust tiers, sandboxing
  connectors/     first-party adapters: google, microsoft, imap-jmap, stripe-link, …
  channels/       telegram, imessage (via mac node), whatsapp, signal, slack, discord, email, sms, webchat
  scheduler/      automations (cron), heartbeat, watches (page/price/text), catch-up after sleep
  proactive/      feed, ideas, goals jobs; interest ledger; acceptance model
  search/         unified search over threads, tasks, memory, library, feed
  browser/        browser tool API; CDP driver; Playwright driver; snapshot builder; credential-fill endpoint
  sandbox/        container runner, srt wrapper for host-side tool processes, receipts
  nodes/          node registry, capability negotiation, invoke, pairing
  notifications/  notification model, delivery (desktop, channel, in-app inbox), de-duplication
  audit/          append-only hash-chained log, receipts, export
  db/             SQLite (better-sqlite3 / libsql), drizzle migrations, backups
```

### 4.2 Request lifecycle (one user turn)

1. A client sends `chat.send {threadId, content, attachments, idempotencyKey}` over the WS API. Side-effecting methods require an idempotency key; duplicates return the original result.
2. The **session controller** serializes turns per thread. If the agent is mid-turn, the message is queued in the chosen mode: `steer` (interrupt the current tool loop with new guidance), `followUp` (run after the current turn settles) or `interrupt` (cancel and restart). The client shows the follow-up queue.
3. **Context assembly** builds the prompt: base system prompt → persona files (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md`) under hard character budgets (20k per file, 60k total, 4k for `USER.md`) → skills index → tool definitions for the active permission mode → today's and yesterday's daily notes → the thread transcript (compacted) → provider-native assistant turns round-tripped verbatim (signed reasoning blocks must not be altered).
4. The **agent loop** streams the model response; each tool call passes through hooks in order: `before_tool_call` (taint and policy check by the Permission Broker; may block, may suspend the turn pending an approval), execution (local tool, browser, sandbox, node, MCP), `after_tool_call` (receipt recording, provenance tagging of the result as `untrusted` if it came from the network or a third party, secret masking), then back to the model. Stop conditions: final text, step budget, token budget, cancellation, or an `ask_user` / approval wait.
5. **Delivery**: deltas stream as `chat.delta` events; structured blocks (plan updates, approval cards, questions, artifacts, receipts) are separate typed events so the UI renders them deterministically rather than parsing prose.
6. **Persistence**: every message, tool call, receipt and event is committed to SQLite before it is acknowledged to the client. An `activeWriterRunId` guards the transcript so a superseded run cannot commit stale data.
7. **Pre-compaction memory flush**: when the transcript nears the context budget, a silent turn asks the agent to append durable facts to today's daily note before compaction summarizes older turns.

### 4.3 Agent runtime

- **Loop**: a home-grown `@psyche/agent-core` with the semantics of pi-agent-core (MIT): `steer` / `followUp` queues, typed tools with `execute(callId, params, signal, onUpdate)`, `beforeToolCall` / `afterToolCall` hooks, `transformContext`, `finishTurn → end | continue`. Model calls go through the model router (§4.4), which normalizes tool calling and streaming across providers using the Vercel AI SDK v7 provider packages.
- **Tool registry**: tools declare `{name, description, inputSchema (zod → JSON Schema), sideEffect: none | read | write | destructive | financial, targetKind: origin | path | account | command | recipient, provenanceOut: trusted | untrusted}`. The registry is the single source for the Permission Broker and for the UI's tool-toggle settings. Naming convention for connector tools: `mcp__<server>__<tool>`, matching the allow / ask / deny keys users see.
- **Built-in tools** (first party, always present): `read_file`, `write_file`, `edit_file`, `list_dir`, `search_files` (scoped to granted folders); `exec` (sandbox); `browser.*` (navigate, tabs, snapshot, find, click, type, select, scroll, screenshot, read_text, download, back/forward, wait); `computer.*` (via node: screenshot, ax_tree, click, type, key, scroll, open_app, run_shortcut, applescript); `memory` (the `memory_20250818` command set: view / create / str_replace / insert / delete / rename, backed by the workspace); `ask_user` (structured questions with options); `update_plan` / `wrap_up` (host-rendered checklist and end-of-turn box); `schedule` (create / update automations); `notify`; `search` (web search provider abstraction); `fetch` (URL → text/markdown with size caps and SSRF policy); `pdf.*`; `sheet.*`; `email.*`, `calendar.*`, `messages.*` (through connectors / channels); `credentials.request` (ask the broker to fill or expose a placeholder); `artifact.create` / `artifact.update`; `goal.*`, `idea.*`, `feed.*` (read-mostly); `subagent.spawn`.
- **Subagents**: `fork` (inherits the transcript) or `fresh` (brief only). Subagents never receive `ask_user`, messaging or approval authority; they return a result that is announced into the parent run and that carries the subagent's taint. Indirect routes to network content (tool search, code-mode helpers) taint the turn exactly like direct network tool calls, and an approved skill never widens tool policy. A `subagents` panel lists them with view-only transcripts.
- **Side-effect classes**: `none` (pure computation), `read` (observes state outside Psyche, including network reads), `write` (creates or changes state that is reversible or stays within the owner's reach: drafts, sandbox files, calendar events, messages to the owner, Library items), `destructive` (irreversible or outward-facing: sending to third parties, deleting, granting consent such as "accept all", terms of service or OAuth consent screens, changing standing permissions), `financial` (moves money or commits to a purchase).
- **Plan mode**: a read-only mode (tools with `sideEffect: none` only) that produces a Plan artifact; `ExitPlanMode` requires the user's approval. After approval, the harness-managed checklist (`update_plan`) tracks progress and is pinned under the latest message. These are two distinct artifacts on purpose: a human-approved plan and a cheap, rewritable checklist.
- **Verification**: for any task that produced receipts, an **evaluator** step (a different model instance, usually the cheaper "utility" model) checks the receipts against the goal (did the email actually send? does the calendar event exist? did the command exit 0?) and either marks the task done, reopens it with specific gaps, or escalates to the user.
- **Unattended-run contract**: automation and heartbeat runs have no one to ask. Their final message must be a deliverable; `NO_REPLY` is a first-class "nothing to report" outcome; any action that would need an approval is deferred into the approvals queue with a notification instead of being attempted.
- **Harness plugins** (later): run Claude Code, Codex or pi as an embedded harness for coding sessions, the way OpenClaw and the AI SDK `HarnessAgent` do, behind the same permission and receipt layer.

### 4.4 Model router

- Providers via AI SDK v7 packages: Anthropic (Messages API, adaptive thinking, prompt caching, `memory_20250818`, `computer_toolset_20260801` when a Claude model drives computer use), OpenAI (Responses API), Google (Interactions API), OpenRouter, and OpenAI- / Anthropic-compatible local endpoints (Ollama ≥0.40 with its MLX runner on Apple Silicon and its `/v1/messages` endpoint, llama.cpp `llama-server` with `--jinja` tool calling, LM Studio as a user-chosen proprietary option, mlx-lm for experiments).
- Model refs are `provider/model`. Roles: `primary`, `fallbacks[]` (tried in order with per-provider cooldowns; auth-profile rotation happens inside a provider before falling back), `utility` (titles, evaluator, memory flush, feed ranking), `embedding`, `vision`, `speech`. The user picks per thread with `/model`; a user-selected model is strict and fails visibly instead of silently falling back. Model choice is a security control: only models on an allowlist with published prompt-injection resistance results may run threads in `auto` permission mode; other models are capped at `balanced`.
- Usage ledger: every call records input / output / cache-read / cache-write / reasoning tokens and a cost estimate from a bundled price table (LiteLLM's `model_prices_and_context_window.json` as the source, refreshed with releases; OpenRouter's reported cost when present). A tray / sidebar usage meter mirrors Muse's percent-remaining meter.
- Local model guidance surfaced in settings: 16 GB → ~9B class (Gemma 4 E-series, Qwen3.5 small), 32 GB → 27–31B (Qwen3.8-27B, Gemma 4 31B, GLM-4.7-Flash), 96–128 GB → 120B MoE (gpt-oss-120b, Mistral Small 4). Tool-calling capability is tested on first use with a tiny suite, and models that fail are flagged "chat only".

### 4.5 Task engine

- A **Task** is the unit of long-running work: `{id, threadId, title, goal, status, plan[], currentStep, checkpoints[], inputRequests[], approvals[], receipts[], leaseOwner, leaseUntil, attempt, createdFrom (chat | automation | idea | goal | channel)}`. Tasks are created when the agent calls `task.start` (or the user delegates from chat), and they outlive the turn that created them.
- **Leases**: worker loops claim tasks with SQL leases; a crashed worker's lease expires and another worker (or the same process after restart) resumes from the last checkpoint. Steps declare `replay: safe | unsafe`; unsafe steps that were in flight at a crash become `uncertain` and are reconciled, never replayed blindly.
- **Input requests** (`ask_user` from a background task) and **approvals** park the task in `awaiting_input` / `awaiting_approval` with a notification; answering resumes it. Timeouts: approvals expire (default 30 min) and deny; input requests wait indefinitely but are surfaced in Upcoming / Activity.
- **Activity log**: every task exposes an ordered action log (tool, target, outcome, timestamp, receipt id) that the UI shows as Muse's "tap a task to see every action" view, with three disclosure levels (status line → action list → raw tool I/O).
- Pause / resume / cancel / retry are first-class; cancellation revokes the run's tool and approval authority immediately; an already-dispatched provider request may still finish and is reconciled through its receipt.

### 4.6 Permission Broker

The broker is the only component that can authorize a side effect. It is modeled on Muse's Sentinel and OpenClaw's exec approvals.

- **Policy inputs**: tool metadata (side-effect class, target kind), the target (origin, path, account, recipient, command), the thread's permission mode (`manual` = ask for every write, `balanced` = ask for writes and important reads [default], `auto` = classifier decides for low-risk writes, `plan` = read-only), per-connector action matrices (Allow / Ask / Deny per action), per-app computer-use tiers (Off / Read only / Read and interact), per-origin browser grants, folder grants (ro / rw), and the turn's **taint** (if untrusted content was read in this turn, write actions that touch a *new* origin or recipient escalate to Ask regardless of standing grants; a Task created from a tainted turn, for example an Idea accepted from an email, inherits the taint for its first turn).
- **Decision**: `allow | ask | deny` plus a reason. `ask` creates an **ApprovalRequest** `{id, kind, summary, details, bindingHash, scopesOffered[], deviceOnly, requiresAuthentication, taint, status, requestedAt, expiresAt, surfaces[]}` (each delivery surface receives a single-use `answerToken`) where `bindingHash` covers the exact arguments (argv + cwd + env for exec; recipient + subject + body hash for email; item id + origin + field selector for a credential fill; origin + path + field names + a digest of the submitted values for a form submission; merchant + amount + line items for a purchase; the full table is in [04-data-model.md](04-data-model.md) §4.2).
- **Delivery surfaces**: the desktop approval card (deterministic UI outside the chat stream), a macOS notification with Approve / Deny actions (purchases and credential fills require `authenticationRequired`), the web UI, and chat channels (Telegram inline buttons; iMessage poll or 👍/👎; Slack / Discord buttons). The first authorized answer wins; late or replayed answers are rejected; a Gateway restart invalidates outstanding cards and re-issues them. Chat surfaces may approve `write` actions only; `destructive`, `financial`, credential-fill, `exec_host`, policy-change and pairing approvals are `deviceOnly` and require a paired device (desktop, web, or the helper's authenticated notification), so they are never even sent to chat channels. Cards arm after a 400 ms delay and the Gateway rejects answers that arrive sooner, to defeat mis-clicks and click-jacking.
- **Grant scopes**: `once`, `task`, `site` (origin), `session` (stored as `always` with `expiresAt` set to the end of the current app session), `always` (with `expiresAt` and a use counter). Standing grants match on a coarse **`grantKey`** (tool plus target class, for example `email.send` plus a recipient domain, or `browser.submit` plus an origin), which is distinct from the per-request `bindingHash`; default lifetimes are task 24 h, site 30 days, session 12 h idle, always 90 days (renewable from the ledger); `destructive` actions can be granted only `once` or `task`, and `financial` actions only `once`. Standing grants live in a ledger the user can inspect and revoke in Settings → Permissions. Generated "always allow" entries for exec are bound to the exact argv *and* cwd.
- **Classifier (auto mode)**: a small model that sees only the user's request and the proposed action metadata (never page content) and labels the action `routine | sensitive | prohibited`; `sensitive` → ask, `prohibited` → deny. The classifier fails closed (any error or timeout means ask), and a circuit breaker drops a thread from `auto` to `balanced` after repeated `sensitive` labels or a denied prohibited attempt. This is the Google "User Alignment Critic" / Anthropic action-classifier pattern.
- **Hard prohibitions** (not configurable): typing a password the model can see, solving CAPTCHAs, entering card or government-ID numbers, financial transfers / trades, permanent deletion without a typed confirmation, following instructions found in content, and any action on a localhost / loopback origin that is not the user's own project (the "test credentials on localhost" exception is explicit and narrow).

### 4.7 Credential Broker (vault)

- **Storage options**: (a) Psyche vault: a SQLCipher database (`vault/vault.db`) whose key is wrapped by the OS keychain (a data-protection keychain item with the access control `[.biometryCurrentSet, .or, .devicePasscode]` and `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`, in a team-prefixed keychain access group, through the mac helper; `safeStorage` on Linux/Windows, refused when its backend reports `basic_text`) plus a printed recovery key that wraps the same key in `vault/recovery.slot`, unlocked per session or per fill with Touch ID; (b) system keychain: items Psyche itself stores in the user's keychain (the app cannot and does not read Safari / Passwords.app items); (c) external managers: 1Password (service-account SDK for headless fills, or the user's own 1Password extension in "real Chrome" browser mode where 1Password's Agentic Mode handles approval and fill), Bitwarden Agent Access SDK (paired CLI with per-credential approval).
- **Item kinds**: login (origin-bound username + password + TOTP), API key / token (header injection), OAuth token (connector), SSH key, payment (Stripe Link Agent Wallet pairing only; raw card numbers are refused), note.
- **Placeholders**: the model sees `{{cred:github-login}}`; the broker substitutes at the executor (browser `Input.insertText`, HTTP header, sandbox environment variable) only if the credential's bound origin / host matches the current target. Page text, screenshots and transcripts are masked afterwards (`•••`), and typed fields are cleared on failure.
- **Approvals**: every fill is an ApprovalRequest with the item name, site, task and agent shown; default scope `once`; opt-in `site` standing grants. The broker never returns a secret to the agent loop.
- **Sessions over passwords**: prefer OAuth connectors and reusing the agent browser's logged-in session; the broker offers "log in yourself" (take control) before "fill from vault".

### 4.8 Memory

- **Workspace** (`$PSYCHE_HOME/workspace/`, a private git-friendly folder): `SOUL.md` (core truths, boundaries, personality), `IDENTITY.md` (name, creature / avatar prompt, vibe, tagline, emoji), `USER.md` (stable facts about the owner, 4k budget, dated active / superseded directives), `AGENTS.md` (operating instructions and tool guidance), `MEMORY.md` (curated long-term memory; injected only into the owner's private sessions, never into group or shared contexts), `memory/YYYY-MM-DD.md` (daily notes; indexed, not injected except today / yesterday), `skills/` (workspace skills), `BOOTSTRAP.md` (first-run ritual, deleted when done), `DREAMS.md` (consolidation summaries).
- **Index**: one SQLite file with FTS5 (BM25) + sqlite-vec (cosine; brute-force fallback is fine at personal scale), 400-token chunks with 80 overlap, a 30-day recency half-life in ranking, and a **provenance class** on every entry: `owner | agent | untrusted | system`. Content that arrived from the network or a non-owner sender can never be promoted to `owner`. Embeddings from a local model by default (nomic-embed-text-v1.5 or Qwen3-Embedding-0.6B via Ollama) or the configured provider.
- **Tools**: `memory` (Anthropic command set over the workspace), `memory_search`, `memory_explain` (why a fact is believed, with provenance), `forget` (stage claim retraction, remove linked material, rebuild index), `sessions_search` (transcript recall across the owner's private threads, opt-in). Writes by the `memory` tool to `SOUL.md`, `IDENTITY.md`, `USER.md` and `MEMORY.md` are protected: they require an approval of kind `memory_protected_write` (and `MEMORY.md` is normally written only by the dreaming job); daily notes and other workspace files are free to write, subject to provenance tagging.
- **Jobs**: pre-compaction flush (append-only to the daily note, runs on a private copy of the conversation, may use a local model); nightly **dreaming** at 03:00 local (the only writer of `MEMORY.md`: merge duplicates, resolve contradictions with `supersedes`, decay stale items, write a diary entry).
- **UI**: Soul & Memory sheet behind the avatar: edit the files directly, browse daily notes, search, pause memory, incognito threads (memory-only, no flush, expire after 24h), import memory from another assistant (paste / file), export everything, reset.

### 4.9 MCP host and connectors

- **MCP host** targets spec **2026-07-28** (per-request `_meta`, `server/discover`, Multi-Round-Trip Requests replacing sampling / elicitation / roots, Tasks as an extension, MCP Apps UI extension) with a 2025-11-25 fallback for older servers, using the TypeScript SDK v2 (`@modelcontextprotocol/client`). Transports: Streamable HTTP (remote, OAuth 2.1 with Client ID Metadata Documents for the host identity) and stdio (local). Deprecated features (Roots, Sampling, Logging, HTTP+SSE, Dynamic Client Registration) are not built on.
- **Trust tiers**: `bundled` (ships with Psyche), `verified` (namespace proof in the official registry or a known vendor host), `unknown`. Per-tool `allow | ask | deny` keyed `mcp__<server>__<tool>`; grants are bound to a hash of `tools/list`, so a changed description or schema revokes them ("rug pull" defense); annotations are treated as untrusted hints; argument previews are shown in full on approval cards.
- **Sandboxing of stdio servers**: run under Anthropic's `srt` (Seatbelt on macOS, bubblewrap + seccomp on Linux) with a domain-allowlisted proxy, or inside the sandbox container; secrets injected from the vault as environment variables at spawn, never written to config files. `.mcpb`-style bundles are supported for one-click install with keychain-backed sensitive config.
- **First-party connectors** (built as internal adapters with the same tool metadata, because the vendors do not ship suitable MCP servers): **Google** (Gmail: threads, drafts, attachments, labels, send; Calendar: calendars, events CRUD, free/busy, `syncToken` incremental sync; Drive `drive.file`) using a Desktop OAuth client with loopback redirect + PKCE, consent screen External + In production (unverified; the "personal use, fewer than 100 users" exemption), polling `history.list` every 1–5 min instead of Pub/Sub; **Microsoft Graph** (Outlook mail / calendar, OneDrive); **IMAP/SMTP** (app passwords) and **JMAP** (Fastmail); **Stripe Link Agent Wallet** (spend requests, one-time virtual cards); **Apple apps** via the mac node (Mail, Calendar / Reminders through EventKit, Notes, Contacts, Messages); **web search** (Brave / Exa / Tavily / SearXNG, user-selectable). Each connector exposes an action matrix the user sets to Allow / Ask / Deny and a read-only vs read-and-act scope at connect time.
- **Directory**: a searchable catalogue of connectors (first-party, remote MCP servers such as Slack `mcp.slack.com/mcp`, Notion, Linear, GitHub, and community entries) with status, scopes and last-used information, mirroring Muse's Connectors screen and Claude's Customize → Connectors.

### 4.10 Channels

- Adapters: **WebChat** (built in), **Telegram** (grammY; inline buttons for approvals; voice notes OGG/Opus), **iMessage** (only through a Mac node: read `chat.db` with Full Disk Access and typedstream decoding, send through Messages.app automation; voice bubbles as CAF; attachments), **WhatsApp** (Baileys on a personal number, clearly labeled unofficial and ban-prone; Meta Cloud API as the compliant business-number option), **Signal** (signal-cli, separate number recommended), **Slack** (Socket Mode), **Discord**, **Email** (reply-by-mail through the mail connector), **SMS** (Twilio), **A2A / webhooks** (inbound triggers).
- **Authorization** copies OpenClaw's model exactly: per-channel `dmPolicy: pairing (default) | allowlist | open | disabled`; unknown senders receive a pairing code (expires in 1 h, max 3 pending per channel) that the owner approves in the UI; a separate group allowlist with `requireMention`; `commands.ownerAllowFrom` defines the owner; `identityLinks` merge the owner's identities across channels into one session; `session.dmScope: main | per-peer | per-channel-peer` so other people never share the owner's context.
- **Designated person / platform**: the owner can designate one or more senders (for example "my partner on iMessage" or "the family Telegram group") for whom Psyche responds and acts with a *delegated* persona and a restricted tool set, scoped memory (`MEMORY.md` is never injected), and approvals that still route to the owner.
- Channel sessions share the task engine, so a request from the phone becomes a Task visible in the desktop Activity view, and approvals asked on the phone are the same ApprovalRequest objects.

### 4.11 Scheduler and proactivity

- **Automations**: cron-like jobs with session targets `main | isolated | named`, delivery targets (thread, channel, webhook, none), an explicit unattended-run contract, catch-up after sleep (missed ticks coalesced into one run), and per-job scratch notes. Users create them in chat (`/schedule`), from Ideas ("make this recurring"), or in Upcoming.
- **Heartbeat**: an optional light-context check-in every 30–60 min during active hours that may surface at most one notification.
- **Watches**: recurring public-page checks (change, text availability, price threshold) with de-duplicated alerts and failure backoff, used by Goals & Tracking.
- **Feed**: a bounded daily brief (5–10 posts) plus scheduled briefings the user defines ("every weekday at 7: my calendar, inbox triage, and two things in robotics"). Pipeline: an editable **interest ledger** (`workspace/interests.md` + derived embeddings) → sourcing (RSS / Atom, Hacker News, arXiv, Bluesky Jetstream, saved items, connected accounts, paid web search only for gaps) → candidate pool → embedding recall × recency decay → an LLM reranker over a shuffled shortlist → one or two exploration slots → posts written by the agent with mandatory citations and multi-source clusters → Discover-style feedback (follow topic, not interested, hide source, like, save) written back to the ledger. Everything is local and inspectable.
- **Ideas**: candidates mined by nightly jobs from (a) repeated tool sequences in the owner's threads (Agent Workflow Memory / Agent Skill Induction style: propose a `SKILL.md` draft, verify by replay), (b) goals and memory ("you mentioned X three times"), (c) connector signals (unanswered emails older than N days, subscriptions, upcoming trips). Each idea card carries evidence, an estimated effort, and `Let's do it` / `Edit` / `Dismiss`; accepted ideas become Tasks or Automations. Proactive delivery is batched into scheduled windows and gated on an acceptance-probability threshold learned from accept / dismiss history.
- **Goals**: stated goals are created explicitly in chat; inferred goals are proposed as candidates for one-tap confirmation, never silently created. Each goal has a category, milestones, a plan, linked tasks, check-in cadence and optional watches.

### 4.12 Search, notifications, audit

- **Search** (left-rail Search surface and `⌘K`): one index across threads, tasks, memory, library files, feed posts, ideas, goals and connector caches the user chose to index; typed filters (`in:feed`, `type:pdf`, `from:alice`); results open the pane they belong to.
- **Notifications**: typed `{kind: approval | input_needed | task_done | task_failed | proactive | briefing | reminder, taskId?, actions[]}`; delivered to the in-app inbox (durable), the OS (through the mac helper, with actions and interruption levels; Electron's wrapper as fallback), channels, and the phone; de-duplicated per task; restart reconciliation marks stale notifications.
- **Audit**: an append-only, hash-chained JSONL log of every tool call, approval, grant, credential fill, send, purchase and config change, plus structured receipts; exportable; "Download your data" produces threads, files, memory and the audit log.

## 5. The desktop shell

- **Shell**: Electron 44 with a single `BaseWindow`; the React app in the main `WebContentsView`; the agent browser as additional `WebContentsView`s (one per tab) laid out into the browser pane's bounds; pop-out windows for any pane; a quick-entry floating window (global hotkey, default ⌥Space, with ⌃⌥Space offered when onboarding detects a conflict) and a menu-bar item with usage and status. Electron fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, ASAR integrity on, `EnableCookieEncryption` on. Signed and notarized Developer ID builds (TCC grants and `safeStorage` depend on a stable signature).
- **Panes** (per thread, draggable, resizable, pop-out): chat (always), browser, terminal (node-pty + xterm; shares the sandbox or the host shell depending on mode), files (tree + inline previews), file / editor (Markdown WYSIWYG + source + diff; code with CodeMirror 6), diff, plan, tasks / activity, subagents, artifact, VM display. The agent opens, closes and focuses panes through `view.*` RPC, mirroring the Claude desktop `ccd_view` tools.
- **Embedded browser pane**: persistent partition `persist:agent-<profile>` (on-disk profile under the Gateway's `browser/profiles/`), `webContents.debugger` attached per tab for CDP (`Accessibility.getFullAXTree`, `Input.*`, `Page.startScreencast`, `Network.*`), `setWindowOpenHandler` routing popups / OAuth into new agent tabs, `will-download` quarantining downloads into the Library, a status pill with the current action, an action-highlight overlay, **Take control** (pauses the agent's input while the user interacts; resumes on release), **Open in window** / full screen, **Stop the task** (the task continues when the pane is closed, as in Muse), per-site grants (Allow once / Always allow / Deny) and a "Clear browsing data" control. The desktop exposes the CDP channel to the Gateway over a local Unix socket bridge, so the browser *tools* run in the Gateway while the *views* live in the desktop. A "real Chrome" mode (a separate branded Chrome with its own user data dir and an unauthenticated DevTools endpoint bound to 127.0.0.1 on a random port, attached once with Playwright `connectOverCDP` and flagged by `psyche security audit` while it runs; a pipe-based attachment is an open question) exists for users who need store extensions such as 1Password.
- **Viewers**: PDF.js 6 (self-hosted worker; AcroForm field display and fill preview), spreadsheets via SheetJS CE from the vendor tarball + TanStack Table for viewing and Univer for editing, DOCX via docx-preview / mammoth, PPTX via headless LibreOffice or `qlmanage` thumbnails, images, CSV / JSON / code with Shiki 4, email previews (sanitized HTML), and **artifacts** (HTML / React) in `sandbox="allow-scripts"` srcdoc iframes on a separate origin with a strict CSP. Streamed chat Markdown through a sanitizing streaming renderer.
- **Dictation**: push-to-talk and toggle modes; audio captured in the renderer, transcribed by the mac helper (SpeechAnalyzer / SpeechTranscriber on macOS 26+, FluidAudio Parakeet or WhisperKit on macOS 14–15) or by the Gateway (whisper.cpp) in server mode; a system-wide dictation hotkey when the user grants Accessibility.
- **Notifications and approvals**: the desktop never decides anything; it renders ApprovalRequests and relays answers. OS notifications come from the helper so they carry actions and interruption levels.
- **VM display**: when VM mode is on, a pane shows the guest display (Virtualization.framework view hosted by the helper, streamed to the desktop as a framebuffer) with the same Take control affordance as the browser pane.

## 6. The mac helper (Swift)

A signed `.app` with its own bundle ID (`com.psyche.helper`) launched by the desktop (or by launchd in server-node mode), speaking JSON-RPC over a Unix socket to the Gateway as a node with these capability groups:

| Capability | APIs | TCC permission |
| --- | --- | --- |
| `computer.ax_tree`, `computer.click/type/key/scroll` | `AXUIElement*` (with `AXManualAccessibility` for Electron apps), `AXUIElementPerformAction`, `CGEventPost` | Accessibility |
| `computer.screenshot` | ScreenCaptureKit (`SCContentSharingPicker` for user-initiated captures to avoid monthly re-consent) | Screen & System Audio Recording |
| `apps.applescript`, `apps.shortcut`, `apps.open` | Apple Events (`com.apple.security.automation.apple-events`), `shortcuts run`, App Intents | Automation (per target app) |
| `messages.read`, `messages.send`, `messages.voice_note` | `~/Library/Messages/chat.db` (read-only, typedstream decoding), Messages.app scripting | Full Disk Access, Automation (Messages) |
| `calendar.*`, `reminders.*`, `contacts.*` | EventKit (full access), Contacts | Calendars, Reminders, Contacts |
| `mail.*`, `notes.*` | Apple Events | Automation (Mail, Notes) |
| `keychain.*`, `vault.unlock` | Security framework (`kSecUseDataProtectionKeychain`, `SecAccessControlCreateWithFlags`), LocalAuthentication | none (Touch ID prompt) |
| `notify.*` | `UNUserNotificationCenter` with categories, actions, text replies, interruption levels | Notifications |
| `speech.transcribe`, `speech.synthesize` | `SpeechAnalyzer` / `SpeechTranscriber` / `DictationTranscriber` (26+), `SFSpeechRecognizer` fallback, `AVSpeechSynthesizer.write`, Personal Voice (opt-in) | Microphone, Speech Recognition |
| `vm.*` | Virtualization.framework (`VZMacOSInstaller`, `VZMacGuestProvisioningOptions` on 27, VirtioFS shares, vsock), DiskImageKit overlays | none (entitlement `com.apple.security.virtualization`) |
| `files.share`, `files.quicklook`, `files.reveal` | `NSSharingServicePicker`, `QLPreviewPanel` | none |

Computer-use **tiers** per app (set in Settings → Computer use and prompted on first use): Off, Read only (screenshots + AX read), Read and interact. Fixed caps: browsers are read-only through computer use (the agent browser is the way to act on the web), terminals and IDEs are click-only, password managers and banking apps are Off. The helper hides Psyche's own windows from screenshots, downsizes captures, and honors a global Esc to stop.

## 7. Nodes and the node protocol

Any process that offers capabilities to the Gateway is a node. The mac helper, `psyche-node` in the VM, a Linux box over SSH and a future phone app all speak the same protocol:

- `connect {deviceId, publicKey, role: node, capabilities[], platform}` → pairing challenge → device token (loopback connects may be auto-approved; everything else needs an explicit approval in the UI).
- `node.invoke {nodeId, capability, params, approvalId?}` → streamed `node.event` → `node.result {receipt}`. Capabilities declare side-effect classes exactly like tools, so the Permission Broker treats a `computer.click` on a node like any other write.
- Transport: WS on loopback / tailnet / SSH tunnel; vsock for the VM guest. Frames are JSON-Schema validated (TypeBox schemas → JSON Schema → generated Swift types, the OpenClaw recipe).

## 8. Browser subsystem

- **One tool API, two drivers.** The agent's browser tools are implemented once against an abstract `BrowserDriver`; the **CDP driver** targets the desktop's embedded `WebContentsView`s (through the desktop bridge) and the **Playwright driver** targets a sidecar Chromium with `launchPersistentContext` (server / headless mode) or a real Chrome via `connectOverCDP`.
- **Page representation**: an accessibility-tree snapshot with stable `ref_N` ids, roles, names, values, states and bounding boxes (Playwright aria snapshots with `boxes`, or `Accessibility.getFullAXTree` over CDP), plus `find(query)` and `read_text` tools; screenshots only when the tree is sparse (canvas, WebGL). The agent never executes arbitrary page JavaScript against third-party sites (a debugging `javascript_tool` exists for the user's own localhost projects only).
- **Origin policy**: each task has an origin set (read-only vs read-writable origins); navigation to a new origin in a tainted turn asks; allowlists are enforced on redirects and canonicalized hosts; downloads are quarantined; `about:`, `chrome:` and local files are blocked.
- **Take control**: the user can type into the live view at any time; the agent's input is paused while the user is active and resumes on release; credential fields always default to "you type" or "fill from vault with approval".
- **Recording**: CDP `Page.startScreencast` frames are kept per task as a lightweight replay (opt-in retention), which also feeds the Activity view.
- **Session choice and consent**: every task states whether it runs in the logged-in profile or a clean logged-out partition, shown by a persistent indicator in the pane; cookie banners are declined autonomously, while "accept all", terms-of-service and OAuth consent screens are `destructive` and ask.
- **Identity**: optional Web Bot Auth key (RFC 9421 Ed25519 signatures with a `Signature-Agent` directory) so Cloudflare-fronted merchants can classify Psyche as a signed agent; the agent never attempts CAPTCHAs and hands those to the user.

## 9. Sandbox subsystem

- Per-task container from a bundled nonroot image (UID 1000, read-only rootfs, all capabilities dropped, no added privileges, 512 MB / 1 CPU / 128 pids defaults, 64 MB tmp), with a persistent `/workspace` volume per thread or project; **network none** by default, with an explicit `network: proxy` option that routes through a host-side domain-allowlisted proxy for tasks that need `pip install`-style egress.
- Backends: Apple `container` (macOS 26+, VM-per-container), Docker / Colima (`--vm-type vz`) on older macOS, Docker / Podman on Linux. No backend available → the tool reports an error; there is **never** a fallback to the host shell. Host-shell commands exist only as a separately permissioned tool (`exec_host`) that is Off by default and always asks; its grants bind to argv, cwd, the resolved executable and an environment subset.
- **Runner hygiene**: the runner invokes the fixed container CLI with argument arrays only (never a shell string), validates every mount source against the allowed roots, applies strict inline-eval rules to `python -c` / `node -e` style commands, and the egress proxy resolves DNS itself and blocks private, link-local and loopback ranges.
- Commands are bounded (default 60 s, configurable per task up to the automation budget), produce receipts (`argv, cwd, exit code, duration, stdout/stderr capped at 128 KB, files changed`), and interrupted commands are recorded as `uncertain`. An interactive PTY mode (xterm in the terminal pane, node-pty inside the container) is available for the user and, with approval, for the agent.
- Host-side tool processes (stdio MCP servers, converters such as LibreOffice / ffmpeg) run under `srt` Seatbelt profiles with filesystem and domain allowlists.

## 10. VM mode (a Mac inside Psyche)

1. **Create**: the helper fetches the latest supported restore image (`VZMacOSRestoreImage.fetchLatestSupported`) or a user-chosen IPSW, creates `Disk.img` (ASIF on macOS 26+), auxiliary storage, hardware model and machine identifier under `$PSYCHE_HOME/vm/<name>/`, and installs macOS. Default 4 vCPU / 8 GB / 80 GB, adjustable.
2. **Provision**: on macOS 27 hosts with a 27 guest, `VZMacGuestProvisioningOptions` creates the admin user, enables auto-login and SSH; otherwise the Lume technique (mount the guest Data volume between boots and write user / plist records) or a one-time guided Setup Assistant. A VirtioFS share drops the Psyche installer into the guest; provisioning finishes over vsock: install the Gateway, node and helper, pre-grant Accessibility and Screen Recording via the first-boot flow, sign in to iCloud if the user wants (only possible for VMs created fresh from a macOS 15+ IPSW on a macOS 15+ host; the App Store never works in a guest).
3. **Run**: the guest runs the *full* Psyche stack. The host desktop becomes a client of the guest Gateway (vsock-forwarded WS), shows the guest display pane, and shares only explicit folders (read-only by default; read-write requires a per-folder grant at a dedicated mount; never the home root, `~/Library`, `/` or `$PSYCHE_HOME`), a clipboard that defaults to paste-only into the guest, and nothing else. Credentials stay on the host by default: the guest asks the host vault (a node capability) for one fill at a time over vsock and never persists the value; moving the vault into the guest is an explicit choice, and whether a guest can use the host's Touch ID is unverified.
4. **Snapshots**: DiskImageKit overlay images (macOS 27) or APFS clones give per-task "fresh Mac" resets without a second VM. Save / restore keeps the guest warm between sessions.
5. **Limits surfaced in the UI**: two macOS guests per host (framework-enforced; Psyche uses one), no nested virtualization for macOS guests, NAT networking only for third-party apps (no bridged entitlement), a logged-in host session with an unlocked keychain is required, and Apple's SLA restricts macOS guests to personal / development use.

## 11. API and protocol

- **Transport**: WebSocket on `127.0.0.1:7979` (configurable) + HTTPS when fronted by a proxy. Frames: `{type: "req", id, method, params}`, `{type: "res", id, ok, payload | error}`, `{type: "event", event, payload, seq, stateVersion}`. Events are not replayed; clients refresh after a gap using `stateVersion`.
- **Auth**: every client sends a device identity on `connect` and signs a challenge nonce; new devices need pairing approval and receive a scoped device token (`operator.read`, `operator.write`, `operator.approvals`, `operator.admin`, `node`) with owner-chosen scopes. Loopback auto-approval applies only to the desktop shell and the helper, which present a per-launch handshake secret; a connection carrying a browser `Origin` is never auto-approved, `Origin` is validated on every WebSocket upgrade, and the UI accepts no Gateway address from a URL parameter or deep link. Changes to security settings require `operator.admin` plus fresh user presence and are not reachable through `node.invoke`. Identity headers from a trusted proxy (Tailscale Serve, Cloudflare Access) never authorize the API by themselves, and Cloudflare Access JWTs are signature-verified rather than merely checked for presence. The web UI can also use passkeys behind HTTPS.
- **Method families**: `threads.*`, `chat.*`, `tasks.*`, `approvals.*`, `grants.*`, `memory.*`, `library.*`, `feed.*`, `ideas.*`, `goals.*`, `automations.*`, `connectors.*`, `channels.*`, `nodes.*`, `browser.*`, `sandbox.*`, `vault.*`, `settings.*`, `search.*`, `notifications.*`, `audit.*`, `view.*` (desktop-only pane control), `voice.*`.
- **Schemas**: TypeBox definitions in `packages/protocol`, exported as JSON Schema and generated into Swift (helper) and TypeScript clients. Breaking changes bump the protocol version negotiated at `connect`.
- **Client-driven requirements** (from [06-ui-design.md](06-ui-design.md)): `threads.fork {threadId, messageId}` for user-initiated forks; `threads.list` returns derived activity counts (running / awaiting input / awaiting approval); receipts carry a short client-visible id plus the provider's id string for the receipt line; notifications carry a `route` for deep links; a `settings.changed` event (including appearance) so every paired client re-themes; `ask_user` has no timeout (background input requests wait indefinitely); feed posts record whether they came from an exploration slot.

## 12. Storage layout

```
$PSYCHE_HOME (default ~/.psyche; identical on macOS and Linux)
  config.json                 operator config (no secrets; secrets are vault refs)
  state/psyche.sqlite         threads, messages, tasks, approvals, grants, receipts,
                              notifications, feed, ideas, goals, automations,
                              connectors, channels, devices, memory index, usage
  state/search.sqlite         unified search index (derived; delete to rebuild)
  workspace/                  SOUL.md IDENTITY.md USER.md AGENTS.md MEMORY.md
                              memory/YYYY-MM-DD.md interests.md skills/ DREAMS.md
  library/                    artifacts and files the agent made or received
  library/quarantine/         downloads until the user opens or files them
  library/recordings/         opt-in browser screencasts per task
  vault/vault.db              SQLCipher; key wrapped by keychain / safeStorage
  vault/recovery.slot         the same key wrapped by the printed recovery key
  run/browser-bridge.sock     desktop ↔ gateway CDP bridge (mode 0600)
  state/channels/             channel session files (WhatsApp, Signal)
  browser/profiles/<name>/    persistent agent browser profiles
  sandbox/<thread-or-project>/workspace/
  vm/<name>/                  Disk.img, AuxiliaryStorage, HardwareModel, MachineIdentifier
  skills/                     installed skills (managed) + skills.lock.json (pins and
                              owner approvals of installed and workspace skills)
  plugins/                    installed plugins / connectors
  audit/YYYY-MM.jsonl         hash-chained audit log
  logs/
```

Backups snapshot `state/`, `workspace/`, `vault/`, `library/` and channel session files (losing WhatsApp / Signal state forces re-pairing). Nothing in `$PSYCHE_HOME` is ever committed to git except the user's own `workspace/` if they choose to.

Encryption at rest: only `vault/vault.db` is application-encrypted in v1. `state/psyche.sqlite`, the workspace and the Library rely on full-disk encryption (FileVault / LUKS) because SQLCipher would slow FTS5 and sqlite-vec and would stop the user from opening their own transcripts with ordinary tools; revisiting this is an open question in [05-security-and-permissions.md](05-security-and-permissions.md) §16.

## 13. Extension points

- **Skills**: `SKILL.md` (Agent Skills standard: name, description, optional gating on binaries / env / OS) in `workspace/skills/`, `$PSYCHE_HOME/skills/`, or bundled; compiled into a compact index in the system prompt with `skills_search` / `skills_read` for the long tail. Installing a third-party skill shows its full text, runs a static scan and (optionally) VirusTotal, and requires an explicit approval. Agent-proposed skills from Ideas are drafts until the user accepts them.
- **Plugins**: code plugins (TypeScript, loaded in the Gateway behind a permission manifest) and bundle plugins (skills + MCP servers + config). Hook surface: `before_model_resolve`, `before_prompt_build`, `before_tool_call` (may block), `after_tool_call`, `tool_result_persist`, `before_compaction`, `agent_end`, `message_received | sending | sent`, `session_start | end`.
- **Connectors / channels / drivers**: interfaces in `packages/connectors`, `packages/channels`, `packages/browser`, `packages/sandbox`; each ships with a capability manifest and tests.
- **Viewers and artifact renderers**: registered by MIME type in `packages/viewers`.

## 14. Observability

Structured logs per subsystem (no message bodies or secrets by default), OpenTelemetry traces for turns and tool calls (local collector optional), a usage ledger, `psyche doctor` (config drift, permissions, sandbox and model health) and `psyche security audit` modeled on OpenClaw's (non-loopback binds, auth mode, `open` dmPolicy, sandbox disabled, unverified skills, standing grants without expiry, a running real-Chrome debugging endpoint, telemetry enabled). Companion commands: `psyche audit verify` (hash chain), `psyche vault rekey`, `psyche backup` (age-encrypted archives). All directories under `$PSYCHE_HOME` are created mode 0700 and files 0600.

## 15. Non-goals and constraints

- Not a multi-tenant hostile-user system: one trusted boundary per Gateway (one owner, or a household that trusts each other). Mutually untrusted users need separate Gateways. A "household mode" that partitions approvals, memory and vault items between two trusted people on one Gateway is deferred past v1.
- No hosted dependency is ever required; optional paid services (web search, cloud models, 1Password, Stripe Link) are bring-your-own.
- No reading of Safari / Passwords.app credentials (impossible by design on macOS), no CAPTCHA solving, no card numbers in the vault, no financial trades.
- Minimum macOS 15 for the desktop; macOS 26+ unlocks SpeechAnalyzer and Apple `container`; macOS 27 unlocks GUI-less VM provisioning and overlay images.

## 16. Glossary

Gateway (psyched) · node · capability · tool · side-effect class · taint · Permission Broker · ApprovalRequest · grant · binding hash · receipt · Task · lease · checkpoint · input request · Credential Broker · placeholder · workspace · daily note · dreaming · provenance class · connector · channel · dmPolicy · pairing · identity link · automation · heartbeat · watch · interest ledger · artifact · Library · pane · driver · profile · grantKey · answerToken · deviceOnly · pause-when-unwatched.

## 17. Open questions (tracked)

Resolved in this revision: form-submit binding includes a values digest (§4.6); the `memory` tool asks before writing protected files (§4.8); chat surfaces approve `write` only (§4.6); the `session` grant scope is `always` with a session expiry (§4.6); taint is inherited by tasks spawned from a tainted turn (§4.6); the state database is not application-encrypted in v1 (§12); household mode is deferred (§15).

Still open (owners in parentheses): whether a macOS guest can surface host Touch ID, so VM mode defaults to the host vault as a node capability (S14, spike 06); Web Bot Auth key custody and JWKS hosting for owners without a domain (S08, post-1.0); whether a pipe-based CDP attachment can replace a debugging port for the real-Chrome mode (S08, spike 01); how subagents appear in the chat column without noise (S12); whether the terminal pane belongs in the narrow web layout (S11); the bundled creature set's art direction (S12/S20); the keyboard map on non-US layouts (S11); adopting the shadcn-hosted AI Elements once the standalone registry is retired (S12). The full lists are in [05-security-and-permissions.md](05-security-and-permissions.md) §16 and [06-ui-design.md](06-ui-design.md) §6.

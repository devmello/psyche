# Psyche — Feature Specification (everything that needs to be implemented)

Status: draft v0.1 (2026-10-18). Terms are defined in [02-architecture.md](02-architecture.md). Screens are specified in [06-ui-design.md](06-ui-design.md); security rules in [05-security-and-permissions.md](05-security-and-permissions.md); storage in [04-data-model.md](04-data-model.md); sequencing in [08-roadmap.md](08-roadmap.md).

Priorities: **P0** = required for the first usable alpha (the "walking skeleton": chat, memory files, browser, approvals, one connector, one channel); **P1** = required for v1.0; **P2** = after v1.0. Every item has a "Done when" so it can become an issue.

Where a row says "(Muse)", "(Claude)", "(OpenClaw)" or "(OpenMuse)" it names the product whose behavior the item copies; the research notes hold the evidence.

---

## A. Foundation

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| A1 | **Monorepo and toolchain**: pnpm workspaces + Turborepo; TypeScript strict; Node 24 LTS; Vite; Vitest; Playwright for UI tests; ESLint/Biome; changesets | P0 | `pnpm dev` starts Gateway + desktop + web; CI runs lint, typecheck, unit and e2e on macOS and Linux runners |
| A2 | **Gateway process** (`psyched`): WS + HTTP server on 127.0.0.1:7979, typed frames, request/response/event model with `seq`/`stateVersion`, idempotency keys on side-effecting methods, graceful shutdown, crash recovery | P0 | A client can connect, pair, send a chat message and receive streamed events; killing the process mid-turn and restarting resumes or cleanly fails the turn with no duplicated side effects |
| A3 | **Protocol package**: TypeBox schemas for every method/event, JSON Schema export, generated TS client and Swift models, protocol version negotiation | P0 | Desktop, web and helper compile against generated types; a schema change fails CI if clients are stale |
| A4 | **SQLite storage** with drizzle migrations, WAL mode, backup/restore commands, `cleanupPeriodDays` retention | P0 | Fresh install creates the schema; `psyche backup` produces a restorable archive |
| A5 | **Config**: `config.json` (no secrets; vault references), environment overrides, `psyche config get/set`, schema validation, migration on upgrade (`psyche doctor --fix`) | P0 | Invalid config fails fast with a readable error; upgrades migrate automatically |
| A6 | **Desktop shell** (Electron 44): single `BaseWindow`, React renderer, preload with a minimal typed bridge, hardened fuses, Developer ID signing + notarization, Squirrel/auto-update feed, crash reporting off by default | P0 | Signed DMG installs on macOS 15+; the app launches the Gateway (dev: child process; prod: launchd agent) and reconnects after Gateway restarts |
| A7 | **Gateway supervision on macOS** via a LaunchAgent (keeps work running when the app is closed), status in the menu bar, "Quit Psyche entirely" vs "Close window" | P0 | Closing the window leaves tasks running; the menu bar shows Gateway state and usage |
| A8 | **Web client**: same React bundle served by the Gateway at `/`, passkey login behind HTTPS, works on phone widths | P1 | Opening the Gateway URL on a phone over Tailscale shows the full app |
| A9 | **Mac helper app** (Swift, `com.psyche.helper`): launched by the desktop or launchd, JSON-RPC over Unix socket, node registration with capability manifest, TCC request flows with explanations and deep links to System Settings | P0 | Helper appears as a node; Accessibility and Notifications can be granted from onboarding; grants survive app updates (stable signature) |
| A10 | **CLI** (`psyche`): `onboard`, `start/stop/status`, `doctor`, `security audit`, `pairing list/approve`, `devices`, `skills`, `automations`, `vault`, `backup/restore`, `export`, `logs` | P0 (subset) / P1 | Every settings screen has a CLI equivalent; `doctor` reports model, sandbox, permissions and bind-address health |
| A11 | **Linux server packaging**: Dockerfile (nonroot), Docker Compose with named state volume, healthcheck, example Tailscale Serve and Cloudflare Access configs | P1 | `docker compose up` on a clean Linux host serves the web UI on loopback and passes `doctor` |
| A12 | **Localization scaffold** (react-intl), English only at launch | P2 | Strings are externalized |

Build notes: follow the Claude desktop split (thin Electron shell, downloaded/updated agent engine on its own cadence is optional later) and the OpenClaw split (Gateway on loopback, Swift companion as a node). Never grant TCC permissions to a shared `node` binary; the helper is the TCC identity.

---

## B. Models and providers

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| B1 | **Provider adapters** via AI SDK v7: Anthropic (Messages API; adaptive thinking; prompt caching; provider-native message round-tripping), OpenAI (Responses API), Google (Interactions API), OpenRouter, OpenAI-compatible (`baseURL`), Anthropic-compatible (`baseURL`), Ollama, llama.cpp `llama-server`, LM Studio, mlx-lm | P0 (Anthropic, OpenAI, Ollama, OpenAI-compatible) / P1 (rest) | Each adapter passes a shared contract test: streaming text, parallel tool calls, tool results, images in, reasoning blocks round-tripped, usage reported |
| B2 | **Model router**: `provider/model` refs; roles `primary`, `fallbacks[]`, `utility`, `embedding`, `vision`, `speech`; per-provider cooldowns; auth-profile rotation before fallback; strict mode for user-picked models; per-thread `/model` | P0 | Primary provider outage falls back within one request; a user-selected model never silently changes |
| B3 | **Usage ledger and cost**: tokens by class (input, output, cache read, cache write, reasoning) per call, cost from a bundled price table (LiteLLM JSON source, refreshed per release) or provider-reported cost; usage meter in sidebar/menu bar; monthly budget alerts | P0 | Usage screen matches provider dashboards within rounding; budget alert fires |
| B4 | **Local model capability probe**: on first use run a 6-case tool-calling/JSON suite; flag models as `agent-capable` or `chat-only`; show RAM-fit guidance (16 GB → ~9B, 32 GB → 27–31B, 96–128 GB → 120B MoE) and suggested models (Qwen3.8-27B, Gemma 4, gpt-oss-20b/120b, GLM-4.7-Flash, Mistral Small 4) | P1 | A chat-only model cannot be selected as `primary` for agent threads without an explicit override |
| B5 | **Local embeddings** default (nomic-embed-text-v1.5 or Qwen3-Embedding-0.6B via Ollama/llama.cpp), remote optional | P0 | Memory search works offline |
| B6 | **Provider credentials in the vault**, never in config; OAuth-based subscriptions where providers allow them | P0 | Keys are entered once in Settings → Model & providers and stored as vault items |
| B7 | **Compaction**: context budget tracking, summarization of older turns, pre-compaction memory flush hook, provider server-side compaction where available | P0 | A 300-turn thread keeps working; facts noted before compaction appear in the daily note |

---

## C. Agent runtime

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| C1 | **Agent loop** (`@psyche/agent-core`): steer / followUp queues, typed tools (zod → JSON Schema), hooks (`before_model_resolve`, `before_prompt_build`, `before_tool_call` with block/suspend, `after_tool_call`, `tool_result_persist`, `before_compaction`, `agent_end`), step and token budgets, cancellation | P0 | Contract tests cover interruption mid-tool, follow-up ordering, blocked tools and suspended approvals |
| C2 | **Context assembly**: base prompt → `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `USER.md` with budgets (20k/file, 60k total, 4k `USER.md`) → skills index → tools for the current mode → today/yesterday daily notes → compacted transcript | P0 | Missing files inject a visible marker; budget overflow truncates with a marker, never silently |
| C3 | **Tool registry** with side-effect class, target kind and provenance metadata; per-tool user toggles; `mcp__<server>__<tool>` naming | P0 | Settings → Permissions lists every tool with its class and current rule |
| C4 | **Structured questions** (`ask_user`): 1–4 questions, 2–4 options each, header ≤12 chars, multi-select, "Other", optional previews, recommended option first; open until answered; withheld from subagents and unattended runs (Claude) | P0 | Question cards render with chips; answers resume the turn; a background task parks in `awaiting_input` |
| C5 | **Plan mode** (read-only tools) → Plan artifact → `ExitPlanMode` approval; **checklist** (`update_plan`) pinned under the latest message; **wrap-up box** (`wrap_up`: recap + one question + 1–2 buttons) (Claude) | P0 | A long task shows an approved plan and a live checklist; the end-of-turn box offers the next step |
| C6 | **Subagents**: `fork` / `fresh`, result announced to the parent, no `ask_user` / messaging / approval authority, Subagents pane with view-only transcripts (OpenClaw, Claude) | P1 | Parallel research subagents run under the same budgets and policies |
| C7 | **Evaluator**: separate utility-model pass that checks receipts against the goal before a task is marked done; reopens with specific gaps or escalates | P1 | A task whose email send failed is not reported as done |
| C8 | **Unattended-run contract**: `NO_REPLY` silent outcome; deliverable-only finals; approvals deferred into the queue with a notification (OpenClaw) | P0 | A heartbeat with nothing to say produces no message; an automation needing approval produces a card, not an attempt |
| C9 | **Slash commands**: `/model`, `/new`, `/btw` (side chat), `/fork`, `/schedule`, `/incognito`, `/forget`, `/remember`, `/plan`, `/status`, `/export`, `/stop` | P0 (subset) / P1 | Commands show in the composer with autocompletion |
| C10 | **Harness plugins** (run Claude Code, Codex or pi for coding sessions behind Psyche's policy and receipts) | P2 | A coding task can be delegated to an installed harness with the same approval cards |
| C11 | **Prompt library and system prompt viewer**: the user can read the fully assembled system prompt for any turn | P1 | "Show prompt" on any agent message opens the exact assembled context |

---

## D. Tasks and Activity

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| D1 | **Durable task engine**: tasks with plan steps, checkpoints, SQL leases, retries, pause/resume/cancel, `replay: safe|unsafe` steps, uncertain outcomes retained for reconciliation (OpenMuse) | P0 | Two-worker lease race, expired-lease recovery, restart mid-step and cancellation are covered by tests |
| D2 | **Delegation from chat**: "do this in the background" or long tool loops become Tasks that outlive the turn; chat shows a task card with live status | P0 | Closing the window does not stop a task; reopening shows progress |
| D3 | **Input requests and approvals parking**: `awaiting_input`, `awaiting_approval` states with notifications; answering resumes | P0 | A question from a background task appears in the inbox and the Activity view |
| D4 | **Activity log** with three disclosure levels (status line → action list → raw tool I/O), most-recent-first task list, per-task action log with tool, target, outcome, receipt (Muse) | P0 | Any action in the last 30 days can be traced to its receipt in two clicks |
| D5 | **Tasks pane** inside a thread (plan, checklist, background tasks, subagents) (Claude) | P0 | The pane updates live from `tasks.*` events |
| D6 | **Sleep/wake and restart recovery**: leases expire, due automations coalesce, outstanding approval cards are re-issued, stale notifications reconciled | P0 | Laptop sleep during a task resumes correctly on wake |
| D7 | **Task sharing of browser and sandbox sessions**: a task owns its browser tabs and workspace; closing the browser pane keeps the task running (Muse) | P0 | Reopening the pane shows the live tab |

---

## E. Threads and chat

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| E1 | **Main chat + side chats**: one persistent main thread; side chats for scoped work; thread list with rename, archive/restore, delete, pin, search; automatic titles via utility model (Muse) | P0 | Thread list matches Muse's main + side structure |
| E2 | **Fork from any message**: creates a side chat with the transcript up to that message; shows lineage ("forked from …") | P0 | Forking preserves tool results and provider-native blocks |
| E3 | **Follow-up queue and steering**: visible, removable queue; "steer" sends guidance into the running tool loop (OpenMuse, OpenClaw) | P0 | Queue order is respected; steering interrupts within one tool call |
| E4 | **Message rendering**: streamed sanitized Markdown, code with Shiki, collapsed tool calls with expand, structured blocks (plan, checklist, approval card, question card, receipt line, artifact card, task card) as typed events | P0 | Prose never has to be parsed for structure |
| E5 | **Reply-to and edit**: quote-reply to any message (agent or user); edit a user message and resend as a fork | P1 | Replies carry a quote reference the agent sees |
| E6 | **Export**: copy as Markdown, export message/thread as Markdown or PDF, share sheet (mac), "Download your data" (threads, files, memory, audit) | P0 (copy/markdown) / P1 (PDF, share, full export) | Exports open correctly in Preview and Obsidian |
| E7 | **Attachments**: drag/drop and paste files, images, audio, folders; stored in the Library and referenced by id; size limits | P0 | A dropped PDF is viewable and readable by the agent |
| E8 | **Inline artifacts**: email preview, file preview (PDF/sheet/doc/image/code), browser preview, finance card, itinerary card, interactive HTML/React artifact in a sandboxed frame; artifacts persist in the Library and can be updated by name (Muse) | P0 (previews) / P1 (interactive artifacts) | An artifact edited in a later turn updates in place and in the Library |
| E9 | **Incognito threads**: memory-only, no flush, expire after 24 h (OpenClaw) | P1 | Nothing from an incognito thread reaches memory or search |
| E10 | **Keyboard-first**: ⌘N new side chat, ⌘K palette, ⌘B sidebar, Esc stop, ⌘⇧B browser, ⌘⇧M permission mode, ⌘⇧I model, ⌃` terminal, ⌘\ close pane (Claude) | P0 | Shortcut sheet lists all bindings |
| E11 | **Transcript view modes**: Normal (tools collapsed), Thinking, Verbose (Claude) | P1 | Mode persists per user |
| E12 | **Cross-thread awareness** (opt-in): the agent can list, read and message other threads; archiving another thread needs approval (Claude) | P2 | A main-chat request can resume a side-chat task |

---

## F. Permission Broker

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| F1 | **Policy engine**: modes `plan | manual | balanced (default) | auto`; side-effect classes `none | read | write | destructive | financial`; target kinds; evaluation order (prohibitions → user deny rules → hooks → taint → standing grants → mode default → classifier) | P0 | Every tool call logs the rule that decided it |
| F2 | **ApprovalRequest lifecycle**: creation with `bindingHash`, 30-minute default expiry (deny on expiry), surfaces, first-authorized-answer-wins, rejection of late/replayed answers, re-issue after restart (OpenClaw, Muse) | P0 | Property tests: a changed argument never reuses an approval |
| F3 | **Approval cards** outside the chat stream with scopes Allow once / Allow for this task / Allow for this site / Always allow (with expiry) / Deny; countdown; requester; exact bound details (Muse) | P0 | Cards render identically in desktop, web and as a notification |
| F4 | **Grant ledger**: standing grants with scope, expiry, use count, last used; revoke individually or all; export (OpenClaw) | P0 | Settings → Permissions → Grants shows and revokes every standing grant |
| F5 | **Per-connector action matrices** (Allow / Ask / Deny per action) and read-only vs read-and-act scope at connect time (Muse) | P0 | Changing a matrix cell takes effect on the next call |
| F6 | **Per-app computer-use tiers** Off / Read only / Read and interact, fixed caps (browsers read-only, terminals and IDEs click-only, password managers and banking Off) (Muse, Claude) | P0 | A click in a Read-only app is refused with a visible reason |
| F7 | **Browser site grants** (Allow once / Always allow / Deny per origin) and per-task origin sets | P0 | Navigating to a new origin in a tainted turn asks |
| F8 | **Folder grants** (ro / rw per folder) for the host filesystem; the sandbox workspace is always rw | P0 | File tools outside granted folders fail closed |
| F9 | **Taint tracking**: reading untrusted content marks the turn; writes to new recipients/origins in a tainted turn escalate to Ask regardless of standing grants | P0 | Injection test corpus passes (no unapproved egress) |
| F10 | **Auto-mode classifier**: utility model sees only the request and action metadata; labels `routine | sensitive | prohibited`; fail closed | P1 | Classifier decisions are logged and auditable |
| F11 | **Hard prohibitions** (not configurable): see architecture §4.6 | P0 | Unit tests per prohibition |
| F12 | **Permission mode switcher** in the composer (⌘⇧M) with per-thread memory of the choice | P0 | Mode is visible at all times |

---

## G. Credential Broker (the credentials manager)

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| G1 | **Vault**: SQLCipher database, key wrapped by the data-protection keychain with biometry-or-passcode access control and Touch ID (mac helper) or `safeStorage` elsewhere, recovery key shown once at creation, lock after idle | P0 | Vault opens with Touch ID; a copied `vault.db` is useless without the keychain item or recovery key |
| G2 | **Item kinds**: login (origin-bound, username, password, TOTP secret), API key/token (host-bound header), OAuth token (connector-owned), SSH key, note; refused: card numbers, government IDs | P0 | Adding a card number is rejected with an explanation and a pointer to Stripe Link |
| G3 | **Credentials UI**: list with origin bindings, last used, which tasks used them; add/edit/delete; CSV import from 1Password/Bitwarden/Chrome exports; search | P0 | A login can be bound to several origins |
| G4 | **Placeholders**: `{{cred:<slug>}}` / `{{cred:<slug>.totp}}`; the model sees only placeholders; resolution happens in executors | P0 | Grep of all model-visible text in tests finds no secret |
| G5 | **Fill protocol**: browser (CDP `Input.insertText` into a focused field, only if current origin matches a bound origin), connector HTTP headers, sandbox environment variables, SSH | P0 | A fill on a non-matching origin is refused and logged |
| G6 | **Masking and clearing**: typed values scrubbed from screenshots, page text and transcripts; fields cleared on failure; screenshots suppressed while a password field is focused (`secureField`) (Claude, Skyvern) | P0 | Visual test: no secret pixels in stored frames |
| G7 | **Fill approvals**: every fill is an ApprovalRequest showing item, site, task, agent; default scope once; opt-in per-site standing grant; desktop notification with `authenticationRequired` (1Password pattern) | P0 | Phone approval of a fill works over Telegram |
| G8 | **"I'll type it myself" first**: Take control is offered before "fill from vault"; system AutoFill in the embedded browser is allowed when the user types | P0 | Login flows work without ever storing the password in Psyche |
| G9 | **System keychain mode**: store items Psyche creates in the user's keychain instead of the vault (never reads Safari/Passwords items) | P1 | Items appear in Keychain Access under Psyche |
| G10 | **1Password bridge**: service-account SDK for headless fills (server), and "real Chrome" browser mode where 1Password's extension and Agentic Mode handle approval and fill | P1 | A 1Password item fills a login without the secret touching Psyche |
| G11 | **Bitwarden bridge**: Agent Access SDK pairing with per-credential approval in the Bitwarden client | P2 | Same as G10 for Bitwarden |
| G12 | **Payments via Stripe Link Agent Wallet**: pair once; the agent creates a spend request with context, line items and total; the user approves in Link within 30 minutes; a one-time virtual card or Link token completes checkout; card details are written only to a 0600 file consumed by the fill executor, never to logs or transcripts | P1 | A test purchase on a sandbox merchant completes with an approval card and a receipt |
| G13 | **OAuth tokens**: stored as vault items owned by connectors, refresh handled by the connector, rotation and revocation on disconnect | P0 | Disconnecting Gmail invalidates pending Gmail-bound work (OpenMuse) |
| G14 | **Audit of fills** with item, origin, task, approval id, outcome | P0 | Credentials UI shows the last 50 uses per item |

---

## H. Memory and persona files

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| H1 | **Workspace files**: `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, `interests.md`, `skills/`, `BOOTSTRAP.md`, `DREAMS.md`; templates; budgets; visible markers for missing files (OpenClaw, Muse) | P0 | A fresh workspace is created on first run with readable templates |
| H2 | **Bootstrap ritual**: first conversation writes `IDENTITY.md` and seeds `USER.md` and `SOUL.md` from onboarding answers, then deletes `BOOTSTRAP.md` | P0 | The persona chosen in onboarding is what the agent uses |
| H3 | **Memory index**: FTS5 + sqlite-vec in `state/psyche.sqlite`, 400/80-token chunks, recency half-life, provenance classes `owner | agent | untrusted | system`, no promotion of untrusted content | P0 | `memory_search` returns ranked chunks with provenance and source file/line |
| H4 | **Memory tools**: `memory` (Anthropic `memory_20250818` command set over the workspace), `memory_search`, `memory_explain`, `forget` (claim retraction + index rebuild), `sessions_search` (opt-in transcript recall) | P0 | Claude uses the native memory tool; other models use the same handler |
| H5 | **Pre-compaction flush** (append-only to today's note, private copy of the conversation, optional local model) | P0 | Facts stated before compaction are recalled after it |
| H6 | **Dreaming**: nightly 03:00 local consolidation, sole writer of `MEMORY.md`, dedupe, contradictions resolved with `supersedes`, decay, diary entry in `DREAMS.md` | P1 | After a week, `MEMORY.md` reads as a curated profile; every line links to its sources |
| H7 | **Soul & Memory UI**: edit the four files directly (Markdown editor with diff), daily-notes browser, search, "pause memory", incognito default toggle, import memory (ChatGPT/Claude export formats and free text), export, reset (Muse) | P0 | A user can delete a fact and it never comes back |
| H8 | **USER.md directives** with dates and active/superseded states (OpenClaw) | P1 | "Stop calling me X" supersedes the earlier directive |
| H9 | **Persona editing by pencil**: natural-language edits ("make yourself a pink hippo named Flash") update `IDENTITY.md` and regenerate the avatar (Muse) | P1 | The change is visible in the header within one turn |
| H10 | **Git-friendly workspace**: optional private repo sync of the workspace with a generated `.gitignore` (OpenClaw) | P2 | `psyche workspace sync` pushes memory files to the user's repo |

---

## I. Browser

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| I1 | **Embedded browser pane**: `WebContentsView` per tab in `persist:agent-<profile>`, tab strip, address display, back/forward, zoom, find, pop-out and full-screen, profile picker | P0 | Sign-ins persist across app restarts |
| I2 | **BrowserDriver abstraction** with a CDP driver (desktop, via Unix-socket bridge) and a Playwright driver (`launchPersistentContext`, server/headless; `connectOverCDP` for real Chrome) | P0 (CDP) / P1 (Playwright) | The same tool tests pass on both drivers |
| I3 | **Snapshot tools**: accessibility tree with stable `ref_N`, roles, names, values, states, boxes; `find(query)`; `read_text`; screenshots only when the tree is sparse; `getByRef`-style actions | P0 | The agent completes a form on a sample site without screenshots |
| I4 | **Action tools**: navigate, click, type, select, scroll, hover, key, wait, upload (from Library), download, tabs (list/open/focus/close) | P0 | Covered by a 20-site regression suite |
| I5 | **Status pill and action highlight overlay** (current action text; outline of the element being acted on) (Muse, browser-use) | P0 | Highlights are visible in the live view and in recordings |
| I6 | **Take control**: user input pauses the agent; "Return control" resumes; paused state shown in the pill; credential fields default to user typing (Muse, OpenAI Dots) | P0 | No agent input is sent while the user is typing |
| I7 | **Site permissions**: Allow once / Always allow / Deny per origin; per-task origin sets; redirect and canonical-host enforcement; a local reputation check (blocklist + optional remote safety check) (Claude) | P0 | A redirect to a non-allowlisted host is blocked |
| I8 | **Popups and OAuth** routed into new agent tabs via `setWindowOpenHandler`; HTTP basic auth prompts surfaced to the user | P0 | Google OAuth consent completes inside the pane |
| I9 | **Downloads quarantine** → Library with type sniffing and a toast; no auto-open | P0 | A downloaded PDF appears in Library and in the task's receipts |
| I10 | **Recording and replay**: CDP screencast frames per task, opt-in retention, scrub in Activity | P1 | A task's browsing can be replayed from Activity |
| I11 | **"Closing keeps the task running"** affordance and **Stop the task** (Muse) | P0 | Closing the pane never cancels |
| I12 | **Dev-server preview** for the user's own projects (`localhost` allowed, console and network readable, element picker ⌘⇧S) (Claude) | P1 | A Vite app can be previewed and inspected |
| I13 | **Real Chrome mode**: launch a separate branded Chrome with its own user-data-dir and remote debugging on a Unix socket / loopback port bound to the session, attach with `connectOverCDP`; for users who need store extensions (1Password Agentic Mode) | P1 | 1Password Agentic Mode fills in that mode |
| I14 | **Web Bot Auth identity** (Ed25519 key, `Signature-Agent` directory served by the Gateway) opt-in | P2 | Cloudflare test endpoint recognizes the agent |
| I15 | **Logged-out profile option** per task ("browse without my sign-ins") | P1 | A task can be forced into a clean ephemeral partition |

---

## J. Computer use (macOS apps)

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| J1 | **Accessibility tree snapshot** of the focused window (depth-limited, pruned, stable refs, boxes, actions), `AXManualAccessibility` for Electron apps | P0 | Notes, Finder, Mail and an Electron app produce usable trees |
| J2 | **Actions**: `AXPress`/`AXSetValue` first, `CGEventPost` fallback; click, double-click, right-click, type, key chords, scroll, drag; open app; focus window | P0 | Create a Reminder and a Note via actions only |
| J3 | **Screenshots** via ScreenCaptureKit with downscaling, Psyche windows hidden, terminals excluded, password-field suppression; `SCContentSharingPicker` for user-initiated captures | P0 | Monthly re-consent is avoided when the vision fallback is unused |
| J4 | **Apple Events / Shortcuts / App Intents bridge** (`applescript`, `jxa`, `shortcuts run`) with per-app Automation prompts | P0 | A user Shortcut can be run by name |
| J5 | **Tiers and caps** per app (see F6), first-use prompts, "Allow for this session" (30 min), global Esc stop, one computer-use session at a time (Claude) | P0 | Esc stops an in-flight action within 200 ms |
| J6 | **Apple app adapters** as typed tools: Mail (read/search/draft/send via scripting), Calendar and Reminders (EventKit), Notes (scripting; HTML bodies), Contacts, Finder/files, Safari read-only (tabs/URLs/text) | P1 | Each adapter has an action matrix in Permissions |
| J7 | **Messages**: read `chat.db` (typedstream decoding, attachments), send text/media via Messages.app scripting, voice bubbles as CAF, handle macOS 26+ chat GUID changes; Full Disk Access + Automation prompts | P1 | Read the last 20 messages with a contact and send a reply with approval |
| J8 | **Teach mode**: record a user demonstration (screens + AX events) into a reusable skill draft (Claude "teach") | P2 | A recorded flow replays on the same app |
| J9 | **Dictation into any app**: system-wide hotkey, transcribe, insert via AX/CGEvent (Muse "hold fn to dictate") | P1 | Works in TextEdit and Slack |

---

## K. Sandbox and terminal

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| K1 | **Container runner** with the contract (UID 1000, read-only rootfs, caps dropped, no network, 512 MB / 1 CPU / 128 pids, 64 MB tmp), backends Apple `container` (macOS 26+), Docker/Colima (`vz`), Docker/Podman on Linux; never a host-shell fallback (OpenMuse) | P0 | Smoke test matches OpenMuse's: nonroot, read-only system files, disabled network, capped output, interruption |
| K2 | **Bounded commands with receipts** (argv, cwd, exit code, duration, capped stdout/stderr, files changed), `uncertain` on interruption, never replayed | P0 | Receipts render in Activity and are exportable |
| K3 | **Persistent `/workspace`** per thread or project; file API confined to it (no symlink traversal), text edit, PDF import/export, size caps | P0 | Files survive container restarts |
| K4 | **Egress proxy option**: host-side domain-allowlisted proxy for tasks that opt in (`pip install`, `git clone` from allowlisted hosts) | P1 | Disallowed hosts are blocked and logged |
| K5 | **srt wrapper** for host-side helpers (LibreOffice, ffmpeg, pdf tools) and stdio MCP servers | P1 | Helpers cannot read `~/` outside their profile |
| K6 | **Interactive terminal pane** (node-pty + xterm): user shell in the sandbox or host; agent use of the PTY only with approval; tabs; "Open in terminal" from the files pane (Claude) | P0 (user) / P1 (agent) | A long-running `npm run dev` works in the pane |
| K7 | **Host exec tool** (`exec_host`), Off by default, always asks, approvals bound to argv + cwd, allowlist mode with exact-argv entries (OpenClaw) | P1 | A changed argument re-prompts |
| K8 | **Language runtimes in the image**: bash, Python 3, Node 24, git, uv, ripgrep, jq, pandoc, poppler-utils, pdftk, ffmpeg, LibreOffice (optional larger image) | P0 (base) / P1 (full) | Image builds reproducibly and is signed |

---

## L. VM mode (a Mac inside Psyche)

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| L1 | **VM manager** in the helper: fetch restore image or pick an IPSW, create disk/aux storage/identifiers, install, start/stop/pause, save/restore, resize display, resource settings | P1 | A guest boots from the Settings → Devices → "Create a sandbox Mac" flow on macOS 15+ |
| L2 | **Unattended provisioning**: `VZMacGuestProvisioningOptions` (macOS 27 host + guest), Data-volume technique for 26 and older, guided Setup Assistant fallback; SSH key; auto-login | P1 | No manual Setup Assistant on a 27/27 pair |
| L3 | **Guest Psyche install** over VirtioFS + vsock: Gateway, node, helper; pre-grant Accessibility/Screen Recording in the first-boot flow; optional iCloud sign-in guidance | P1 | The host desktop connects to the guest Gateway automatically |
| L4 | **Host desktop as client**: switch between host Gateway and guest Gateway; VM display pane with Take control; clipboard sharing toggle | P1 | A browser task runs inside the guest and is visible on the host |
| L5 | **Shared folders policy**: explicit folders only, read-only default, per-folder rw grant, never the home root; credential placement choice (host vault as node capability vs guest vault) | P1 | Guest cannot see ungranted host paths |
| L6 | **Snapshots and resets**: DiskImageKit overlays (27) or APFS clones; "fresh Mac" per task; one guest per user enforced in UI | P2 | Reset takes under 30 s |
| L7 | **Prebuilt guest image** distribution (OCI, Lume/Tart style) as an alternative to IPSW install | P2 | Pull + first boot under 15 minutes on a fast connection |

---

## M. Connectors and MCP

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| M1 | **MCP host** on spec 2026-07-28 with 2025-11-25 fallback (TypeScript SDK v2); Streamable HTTP + OAuth 2.1 (CIMD identity), stdio; MCP Apps UI extension rendering in a sandboxed frame; Tasks extension; no reliance on deprecated Roots/Sampling/Logging/DCR | P0 | Reference servers (filesystem, GitHub, Notion, Linear, Slack) connect and run tools |
| M2 | **Trust tiers and tool policy**: bundled / verified / unknown; per-tool allow/ask/deny; grants bound to a `tools/list` hash; annotations treated as untrusted; full-argument previews | P0 | A changed tool description revokes its standing grant |
| M3 | **Local server sandboxing**: stdio servers under `srt` or in the sandbox container; secrets injected from the vault as env at spawn; `.mcpb` bundle install with keychain-backed sensitive config | P1 | A malicious stdio server cannot read `~/.psyche/vault` |
| M4 | **Connectors directory UI**: catalogue (first-party, remote MCP presets, community), status, scopes, last used, action matrix, connect/disconnect, "Submit a connector" docs (Muse, Claude) | P0 | Gmail, Calendar, Slack, Notion, Linear, GitHub appear with one-click connect |
| M5 | **Google connector**: Desktop OAuth client, loopback redirect + PKCE, External + In production consent (unverified, personal-use exemption), scopes `gmail.modify` (or `readonly` + `send`), `calendar`, `drive.file`; Gmail threads/drafts/attachments/labels/send with `history.list` polling (1–5 min); Calendar CRUD, free/busy, `syncToken` incremental sync with 410 full resync; Drive `drive.file` upload/download; token in vault; account change invalidates pending work; 7-day re-auth UX if the user leaves the project in Testing | P0 | End-to-end: triage inbox, draft reply, send after approval, create event after approval, with receipts |
| M6 | **Microsoft Graph connector** (Outlook mail/calendar, OneDrive) with subscriptions renewed weekly | P2 | Same acceptance as M5 on a Microsoft account |
| M7 | **IMAP/SMTP and JMAP connectors** (app passwords; Fastmail tokens) | P1 | Non-Google mail works with the same tools |
| M8 | **Web search and fetch**: providers Brave / Exa / Tavily / SearXNG (user-chosen, key in vault); `fetch` with size caps, HTML → Markdown, SSRF and private-network blocks, provenance `untrusted` | P0 | Search works with a free-tier key or a local SearXNG |
| M9 | **Custom connectors**: the agent drafts an API connector (OpenAPI/REST) with vault-held keys; the user reviews before enabling; never auto-enabled (Muse) | P2 | A drafted connector shows its full code and scopes before activation |
| M10 | **Shopping helpers**: price comparison across allowlisted merchants via the browser, cart building, checkout hand-off with Stripe Link (G12) and an explicit confirm card showing seller, items, total; order tracking by parsing order emails (schema.org `Order` where present) | P1 | A test purchase completes with approval and receipt |
| M11 | **Connector action matrices** and read-only vs act scope at connect time (shared with F5) | P0 | Every connector action appears in Permissions |

---

## N. Channels, designated person, server mode

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| N1 | **Channel framework**: adapters register capabilities (text, media, voice notes, buttons, polls, reactions, typing); inbound routing to sessions by `dmScope`; outbound formatting; attachment handling (OpenClaw) | P0 | A new adapter needs only the interface plus tests |
| N2 | **Authorization**: `dmPolicy` pairing (default) / allowlist / open / disabled; pairing codes (1 h expiry, 3 pending per channel); owner via `ownerAllowFrom`; `identityLinks`; group allowlist + `requireMention`; context visibility rules (OpenClaw) | P0 | An unknown sender gets a code and nothing else; the owner approves it in the UI |
| N3 | **WebChat** channel (web UI as a channel for the owner on other devices) | P0 | Works through the web client |
| N4 | **Telegram** (grammY): text, media, voice notes (OGG/Opus), inline-button approvals, `/approve`, typing indicators | P0 | The owner approves a purchase from Telegram |
| N5 | **iMessage** via the Mac node (J7): inbound via `chat.db` watch, outbound via Messages.app, approvals via polls (26+) or 👍/👎 tapbacks, voice bubbles as CAF | P1 | Owner on iPhone chats with the agent through iMessage |
| N6 | **WhatsApp**: Baileys on a personal number (clearly labeled unofficial, ban risk, separate number recommended) and Meta Cloud API (business number, 24-hour window, template costs) | P2 | QR pairing works; voice notes as OGG/Opus |
| N7 | **Signal** via signal-cli (separate number recommended), 👍/👎 approvals | P2 | Linked device pairing works |
| N8 | **Slack** (Socket Mode) and **Discord** bots with button approvals | P2 | Owner-only DM policy works |
| N9 | **Email channel** (reply-by-email through the mail connector) and **SMS** (Twilio) | P2 | A reply to the agent's email continues the thread |
| N10 | **Designated person mode**: per-sender delegated persona (own `SOUL` overlay), restricted tool set, no `MEMORY.md` injection, per-peer session, approvals still routed to the owner, per-sender grant matrix (for example "may schedule on my calendar") | P1 | A family member on Telegram can ask the agent to add an event; the owner approves |
| N11 | **Voice notes across channels**: synthesize once (PCM) and transcode per channel (OGG/Opus 48 kHz mono; CAF for iMessage; MP3 for Slack/Discord/email); transcribe inbound voice notes | P1 | Round trip works on Telegram and iMessage |
| N12 | **Server mode**: Docker Compose, loopback bind, trusted-header auth behind Tailscale Serve / Cloudflare Access, passkeys for the web UI, TLS pinning for mobile clients, backups, `doctor` | P1 | The acceptance scenario in the vision doc passes |
| N13 | **Mac app as paired node to a remote Gateway**: local vs remote mode switch, node capabilities (iMessage, notifications, computer use, keychain-held credentials, Apple apps) offered to the server Gateway, exec approvals shown on the Mac (OpenClaw) | P1 | A server task sends an iMessage through the Mac after approval |
| N14 | **Multi-client consistency**: desktop, web and phone see the same threads, tasks, approvals and notifications; `stateVersion` refresh after gaps | P0 | Approving on one device dismisses the card everywhere |

---

## O. Scheduler, Feed, Ideas, Goals, notifications

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| O1 | **Automations**: cron and interval schedules, session targets `main | isolated | named`, delivery targets, unattended contract, catch-up after sleep with coalescing, per-job scratch, pause/run now/history (OpenClaw, Claude) | P0 | "Every weekday at 7, send me my brief on Telegram" works after a laptop sleep |
| O2 | **Heartbeat**: light-context check-in on a 30–60 min cadence within active hours, at most one notification per run, `NO_REPLY` default | P1 | Heartbeat costs under 5k tokens per run |
| O3 | **Watches**: page change / text availability / price threshold checks with dedupe and backoff (OpenMuse) | P1 | A price drop produces one alert |
| O4 | **Upcoming** view: automations, reminders, watches, scheduled briefings; edit in place (Muse) | P0 | Everything that will run is visible with its next time |
| O5 | **Feed pipeline**: interest ledger (`interests.md` + embeddings), sources (RSS/Atom, HN, arXiv, Bluesky Jetstream, saved items, connected accounts, paid search for gaps), recall × recency, LLM rerank over a shuffled shortlist, exploration slots, agent-written posts with citations and multi-source clusters, bounded daily brief (5–10 posts) plus user-defined briefings, feedback (follow topic, not interested, hide source, like, save) written to the ledger (Muse, Pulse, Discover) | P1 | After two weeks of feedback the ledger reflects it and the user can read why each post was chosen |
| O6 | **Feed UI**: post cards, "what should I write about" instructions, schedule, comment to turn a post into a task | P1 | Commenting on a post starts a side chat with the post as context |
| O7 | **Ideas pipeline**: nightly mining of repeated tool sequences (skill drafts verified by replay), goal/memory-derived suggestions, connector signals; evidence, effort, acceptance-probability gating learned from accept/dismiss; batched delivery windows | P1 | Ideas have ≥30 % acceptance in dogfooding; dismissed patterns stop reappearing |
| O8 | **Ideas UI**: cards with evidence, Let's do it / Edit / Dismiss, recurring toggle; accepted ideas become tasks or automations (Muse, OpenMuse) | P1 | Accepting an idea creates a task card in chat |
| O9 | **Goals**: explicit creation in chat; inferred candidates with one-tap confirm; categories; milestones; plan; linked tasks; check-in cadence; watches; progress; archive (Muse) | P1 | A goal page shows milestones and the tasks that advanced it |
| O10 | **Notifications**: typed inbox (approval, input needed, task done/failed, proactive, briefing, reminder), OS notifications with actions and interruption levels through the helper, channel delivery, dedupe per task, restart reconciliation, quiet hours | P0 | Approving from a macOS notification works with Touch ID when required |

---

## P. Documents, viewers, editor, Library

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| P1 | **PDF viewer** (PDF.js 6, self-hosted worker): paging, zoom, search, text selection, AcroForm field highlights and values, annotations later; `isPureXfa` detection with a clear "XFA not supported" message | P0 | 100-page PDFs scroll smoothly |
| P2 | **Documents pipeline**: email attachment → PDF import → detect fillable fields → `ask_user` for requested values → filled copy preview → reviewed reply draft (approval) → send → receipt; flatten on send; OCR for scanned forms via Apple Vision (mac) or Tesseract/docTR (server) (OpenMuse) | P1 | "Complete the permission slip" acceptance test passes end to end |
| P3 | **Spreadsheets**: view `.xlsx/.csv/.tsv` (SheetJS CE from the vendor tarball + TanStack Table, sheet tabs, filters, column stats), edit with Univer, export; finance CSV summary artifact (OpenMuse) | P0 (view) / P1 (edit) | A 50k-row CSV opens in under 2 s |
| P4 | **Documents and slides**: DOCX via docx-preview/mammoth; PPTX via headless LibreOffice/Gotenberg or `qlmanage` thumbnails; images; JSON; code with CodeMirror 6 + Shiki 4; email preview (sanitized HTML) | P0 (docx, images, code) / P1 (pptx, email) | Previews render in the Files pane and inline in chat |
| P5 | **Markdown editor**: rich / source / diff modes (MDXEditor, or CodeMirror 6 + a WYSIWYG view), used for notes, memory files, artifacts and Library docs; autosave; conflict detection when the agent edits the same file | P0 | Editing `SOUL.md` and a Library note works with undo and diff |
| P6 | **Artifact runtime**: HTML/React artifacts in `sandbox="allow-scripts"` srcdoc iframes on a separate origin with CSP, home-grown resize messaging, self-hosted Sandpack for React; update-by-name; open in browser pane; share as file | P1 | A "sleep dashboard" artifact persists and updates |
| P7 | **Library**: documents, images, artifacts, downloads, voice notes, system files (uploads and agent-created), search, tags, Quick Look, share sheet, AirDrop, reveal in Finder, export, retention (Muse) | P0 | Everything the agent made or received is findable |
| P8 | **Generators**: Markdown, PDF (pdf-lib / Chromium print), DOCX (docx), XLSX (SheetJS), PPTX (pptxgenjs), charts (static SVG), itinerary/dashboard templates | P1 | The agent can produce each format from a chat request |
| P9 | **File tools for the agent** over granted folders and the Library: read (with PDF/DOCX/XLSX text extraction), write, edit, move, search; size caps; receipts | P0 | Reading a 20 MB PDF returns bounded text with page references |

---

## Q. Voice

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| Q1 | **Dictation in the composer**: push-to-talk and toggle, live partials, engine selection (SpeechAnalyzer on macOS 26+, FluidAudio Parakeet or WhisperKit on 14–15, whisper.cpp on the server, Web Speech in the web client as last resort), custom vocabulary (agent name, contacts) | P0 | Latency under 500 ms to first partial on Apple Silicon |
| Q2 | **System-wide dictation hotkey** into any app (see J9) | P1 | — |
| Q3 | **Text-to-speech**: Kokoro-82M locally (Core ML/MLX), `AVSpeechSynthesizer` (incl. Personal Voice opt-in, non-commercial caveat), ElevenLabs/OpenAI optional; read-aloud for any message; voice selection per persona | P1 | A message can be played and saved as a file |
| Q4 | **Voice memos**: the agent sends voice notes (N11) and transcribes received ones; user records voice memos in the composer that are transcribed and attached | P1 | Round trip on Telegram |
| Q5 | **Voice mode** (continuous spoken conversation with barge-in) | P2 | Hands-free conversation on the Mac |

---

## R. Persona and appearance

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| R1 | **Onboarding**: sign-in-free setup; choose model/provider (or local); name the agent (suggestions or keep "Psyche"); describe the creature and vibe/tagline in plain language → `IDENTITY.md`; permissions walkthrough (Notifications, Accessibility, Screen Recording — all skippable); first connector; optional VM mode (Muse) | P0 | First chat happens within 3 minutes of install |
| R2 | **Avatar system**: generated from the description by an image model (configured provider) or picked from a bundled set of original creatures; size variants; states idle / working (typing loop) / needs you / error; cream default creature (original art, not Meta's) (Muse) | P0 (bundled) / P1 (generated) | The avatar animates while a task runs |
| R3 | **Appearance**: user-picked accent seed → 12-step OKLCH accent and gray scales (Radix-style generator with contrast gate), light/dark/auto, density, font choice, reduced motion | P0 | Any seed color yields accessible UI in both themes |
| R4 | **Persona files**: `SOUL.md` tone/boundaries, `IDENTITY.md` name/creature/vibe/emoji; "edit by asking" (H9) and direct editing (H7) | P0 | Changing the name updates the header, notifications and channel display names |

---

## S. Search

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| S1 | **Unified search** (left-rail Search + ⌘K): threads, tasks, memory, Library, feed, ideas, goals, indexed connector caches; filters (`in:`, `type:`, `from:`, date); results open the right pane; keyboard navigation (Muse "Search finds things within Muse") | P0 | Sub-second results on a year of data |
| S2 | **Transcript search for the agent** (`sessions_search`, opt-in) | P1 | — |

---

## T. Skills and plugins

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| T1 | **Skills**: `SKILL.md` discovery (workspace → managed → bundled), gating (bins/env/os), compact prompt index with a char budget, `skills_search` / `skills_read`, `$skill` references, user-invocable commands (OpenClaw, Claude) | P0 | Bundled skills load and are listed in Settings |
| T2 | **Install and trust**: show full text, static scan for secrets/exec patterns, optional VirusTotal, explicit approval, pinned version + lockfile, update with diff review (ClawHavoc lesson) | P1 | Installing a skill with a curl-pipe-bash prerequisite warns loudly |
| T3 | **Agent-proposed skills** from Ideas, verified by replay before acceptance (OpenClaw Skill Workshop, Devin dreaming) | P2 | A repeated 5-step workflow becomes a one-line skill |
| T4 | **Plugins**: code plugins with permission manifests and the hook surface; bundle plugins (skills + MCP servers + config); enable/disable; sandboxed where possible | P2 | A community channel adapter installs as a plugin |
| T5 | **Bundled skills**: browsing, research with citations, inbox triage, reply drafting, calendar planning, shopping and price comparison, travel booking hand-off, document filling, spreadsheet analysis, memory hygiene, weekly review, subscription audit | P0 (5) / P1 (rest) | Each has an acceptance script |

---

## U. Settings, data controls, observability

| ID | Feature | Pri | Done when |
| --- | --- | --- | --- |
| U1 | **Settings** sections: Model & providers, Persona, Connectors, Permissions (modes, matrices, tiers, site grants, folder grants, grant ledger), Computer use, File access, Devices & nodes (pairing, VM), Channels (pairing requests, allowlists, designated people), Credentials, Appearance, Voice & dictation, Data controls, Server & remote access, Usage, About | P0 | Every setting is reachable in ≤2 clicks and has a CLI twin |
| U2 | **Data controls**: export everything, delete threads (with "also forget" option that stages retraction), reset agent (irreversible, typed confirmation), retention periods, incognito default, telemetry (off, explicit opt-in only, no bodies) (Muse "Download your data", "Reset Muse") | P0 | Deleting + forgetting removes the memory claims and rebuilds the index |
| U3 | **Audit log and receipts**: hash-chained JSONL, viewer with filters, export; `psyche security audit` (binds, auth mode, open policies, sandbox off, unverified skills); `psyche doctor` | P0 | Audit chain verifies; audit flags an `open` dmPolicy |
| U4 | **Backups**: scheduled local backups of state, workspace, vault, Library and channel sessions; restore flow | P1 | Restore on a new Mac reproduces the agent |
| U5 | **Logs and traces**: per-subsystem structured logs without bodies, optional OpenTelemetry export, in-app log viewer | P1 | A failed tool call can be diagnosed from the log viewer |

---

## V. Personal-agent capability bundles (end-to-end scenarios)

These are the user-visible promises; each is an acceptance script that exercises many rows above.

| ID | Scenario | Pri | Done when |
| --- | --- | --- | --- |
| V1 | **Inbox triage and replies**: read new mail, summarize, draft replies, send after approval, file attachments to the Library | P0 | Daily use by maintainers |
| V2 | **Calendar planning**: "plan my week", find slots, create/move events after approval, reminders | P0 | — |
| V3 | **Shopping**: compare prices for an item across allowlisted merchants, build a cart, hand off checkout with Stripe Link approval, track the order from emails (Muse's Switch purchase) | P1 | — |
| V4 | **Travel**: find a cheaper flight and hold it for approval; itinerary artifact | P1 | — |
| V5 | **Documents**: fill a PDF form from an email and reply with the filled copy (P2) | P1 | — |
| V6 | **Messaging on your behalf**: read a thread, draft, send after approval, voice note (J7/N5/N11) | P1 | — |
| V7 | **Research brief**: multi-source research with citations into a Markdown/PDF artifact | P0 | — |
| V8 | **Subscription audit**: find recurring charges from mail, ask which to cancel, prepare cancellations as approved tasks (Muse) | P1 | — |
| V9 | **Weekly review and goals check-in**: automation that summarizes the week against goals, proposes next steps | P1 | — |
| V10 | **Coding helper**: run commands in the sandbox, preview a dev server, edit files in granted folders; optional harness plugin | P1 | — |
| V11 | **Phone calls** to businesses (Muse's beta) | out of scope for v1 | Documented as a non-goal until a safe design exists |

---

## Cross-cutting acceptance criteria

- **No secret in model-visible text**: automated check over transcripts, prompts and tool results in CI.
- **No unapproved egress**: the prompt-injection corpus (web, email, document, MCP-annotation vectors) produces zero unapproved sends/purchases/exec across the three default modes.
- **Resumability**: killing the Gateway at any point in the 12 acceptance scenarios either resumes or ends with a correct receipt state; never a duplicate side effect.
- **Model portability**: all P0 scenarios pass on at least one hosted model from each of Anthropic/OpenAI/Google and one local model flagged `agent-capable`.
- **Performance**: cold start to first token under 3 s on an M-series Mac with a hosted model; browser snapshot under 300 ms for typical pages; memory search under 100 ms.
- **Accessibility**: full keyboard operation; VoiceOver labels for cards; reduced motion honored.

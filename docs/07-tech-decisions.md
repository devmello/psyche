# Psyche — Technology Decisions (ADRs)

Status: draft v0.1 (2026-10-18). Each record states the decision, the alternatives considered, the evidence (from `research_notes/`) and consequences. Dates and versions are as of October 2026.

---

## ADR-001 — Desktop shell: Electron with a Swift helper, not Tauri or a pure native app

**Decision.** `psyche-desktop` is Electron 44 (Chromium 152). Native macOS work lives in a signed Swift helper app (`psyche-mac`) connected as a node.

**Alternatives.** Tauri 2 (WKWebView on macOS: no Chrome DevTools Protocol, WebDriver-only automation, so an agent-controlled embedded browser is not possible); Tauri 3 alpha / Electrobun with CEF (immature); pure SwiftUI (best Keychain, App Intents, Accessibility, Foundation Models; but no CDP-controllable webview, no shared React UI for the web/server variant, and a second UI codebase).

**Evidence.** The embedded, persistent, agent-driven browser is a core requirement; only a Chromium-based shell provides `WebContentsView` + `webContents.debugger` + persistent partitions today. The Claude desktop app uses exactly this split (Electron + `@ant/claude-swift` N-API addon + signed helper executables), and OpenClaw pairs a Swift menu-bar app with a Node gateway. TCC grants are keyed to code signature + bundle id, so the helper is the stable permission identity.

**Consequences.** ~500 MB install; two languages; a Unix-socket JSON-RPC boundary between Electron and Swift (N-API addon optional later for latency-sensitive paths). Windows/Linux desktops become possible later with a different helper.

## ADR-002 — Gateway in TypeScript on Node 24

**Decision.** One long-running TypeScript daemon (`psyched`) owns all state and runs identically on macOS and Linux.

**Alternatives.** Python (LiteLLM, LangGraph, PyMuPDF ecosystems; but a second runtime next to the Electron/React code and weaker single-binary story); Rust (Goose, Codex, Muse's own agent binary; strongest performance and safety but slower iteration and a smaller agent-library ecosystem for a small team).

**Evidence.** OpenClaw (392k stars), OpenMuse and OpenDots are TypeScript; the AI SDK, the MCP TypeScript SDK v2, Playwright, grammY, Baileys and the UI stack are TypeScript-first. Node 24 is required by AI SDK v7 (ESM-only, Node 22+) and OpenMuse.

**Consequences.** Python helpers (PyMuPDF, docTR) run as sandboxed subprocesses when needed; Rust can be introduced for hot paths through napi-rs.

## ADR-003 — Own agent loop; AI SDK v7 for providers; no Claude Agent SDK as the core

**Decision.** `@psyche/agent-core` implements the loop (pi-agent-core semantics: steer/follow-up queues, hooks, typed tools). Model calls use AI SDK v7 provider packages. The model router (fallbacks, cooldowns, roles) is Psyche's.

**Alternatives.** Claude Agent SDK (most complete harness, but governed by Anthropic's Commercial Terms, API-key-only, no claude.ai login passthrough, Claude-only); LangGraph (Python-first); Mastra (good suspend/resume, but a framework we would fight for permission and receipt semantics); CopilotKit + Intelligence (hosted thread service); pi-agent-core directly (MIT, excellent, but OpenClaw's trajectory shows serious products end up owning the loop).

**Evidence.** AI SDK v7 has normalized tool calling, `ToolLoopAgent`, `toolApproval`, MCP client, usage fields, but no cross-provider fallback (its top open issue); OpenClaw and Goose both built their own routers. Provider-native reasoning blocks must be round-tripped verbatim for Claude, OpenAI and Gemini, so the transcript stores opaque provider turns.

**Consequences.** More code to own; full control over hooks, taint, approvals and receipts; harness plugins (Claude Code, Codex, pi) can be added later behind the same policy layer.

## ADR-004 — SQLite as the single store; Markdown workspace for memory

**Decision.** One SQLite file (WAL) with FTS5 and sqlite-vec for all relational data and the memory index; secrets in a separate SQLCipher file; persona and memory as Markdown files.

**Alternatives.** PGlite/PostgreSQL (OpenMuse; embedded Postgres needs >512 MB RAM just to start and cannot be opened by two processes); LanceDB (good, but a second store); memory frameworks (mem0 is now ADD-only with platform-only benchmarks; Letta pivoted to git-backed files with an unmaintained server; Zep CE discontinued).

**Evidence.** OpenClaw's per-agent SQLite with FTS5 + vectors, Claude Code's `MEMORY.md` + topic files, and Muse's `MEMORY.md` + dated files + Postgres claims all converge on files for humans and an index for retrieval. sqlite-vec 0.1.9 is maintained again (March 2026).

**Consequences.** Trivial backups (copy files); git-friendly memory; an OpenClaw workspace can be imported as-is because the file names and roles match.

## ADR-005 — Permission Broker as a separate module with binding hashes

**Decision.** All side effects pass through one policy module; "ask" produces deterministic cards outside the chat; approvals are bound to exact arguments, expire (30 min default), and are invalidated by restarts.

**Evidence.** Muse's Sentinel ("Muse proposes, only Sentinel grants"; dialogs never in the conversation; one-time / session / task / time-bounded / perpetual grants). OpenClaw's 2026 advisories ("approvals could outlive their reviewed working directory", "reusable approvals could authorize changed arguments") show what happens without binding. Codex's framing: approvals are policy, sandbox is the boundary.

**Consequences.** Every tool must declare side-effect metadata; every executor must honor an `approvalId`; some friction for users in `manual` mode (the default is `balanced`, Muse's "Ask for some actions").

## ADR-006 — Credential Broker: own SQLCipher vault with keychain-wrapped key, placeholders, no card numbers; payments via Stripe Link Agent Wallet

**Decision.** Secrets never enter model-visible text; executors substitute placeholders; fills require approvals; payment uses Stripe Link spend requests and one-time cards rather than stored card numbers.

**Alternatives.** Storing everything in the macOS keychain only (works on Mac, not on the Linux server, and prompts poorly for bulk operations); 1Password-only (excellent model, but a paid dependency; also its Agentic Mode needs the real Chrome extension, which Electron cannot load); storing cards (1Password and Anthropic both exclude them today).

**Evidence.** 1Password Agentic Autofill / 1Password for Claude (GA 2026-07), Bitwarden Agent Access SDK (2026-03), browser-use / Stagehand / Skyvern placeholder patterns, Anthropic and OpenAI prohibitions on typing passwords and card data, Stripe's 30-minute Link approval window and 0600-file guidance for card details. Apple provides no API to read Safari/Passwords credentials.

**Consequences.** 1Password/Bitwarden are bridges, not the core; "real Chrome" browser mode exists for users who want 1Password's own flow.

## ADR-007 — Browser: embedded `WebContentsView` + CDP by default; Playwright sidecar and real Chrome as modes

**Decision.** One `BrowserDriver` interface; CDP driver for the embedded pane; Playwright `launchPersistentContext` for server/headless; `connectOverCDP` for a separate branded Chrome.

**Alternatives.** Chrome-extension-first (Claude in Chrome): acts in the user's real profile, which is powerful but mixes the user's sessions with agent activity and depends on Chrome; cloud browsers (Browserbase, Kernel): remote, paid, against the local-first goal.

**Evidence.** Electron docs (persistent partitions, `webContents.debugger`, `setWindowOpenHandler`, `will-download`); Playwright's note that `connectOverCDP` has lower fidelity; Electron's partial extension support (no `chrome.action`, `chrome.identity`), so password-manager extensions cannot be assumed to work in-app; Muse's accessibility-tree-only browser sub-agent with DevTools disabled; Claude's per-site Allow once / Always allow / Deny.

**Consequences.** Store extensions are unavailable in the embedded pane; the agent never gets `--remote-debugging-port` in production; the pane and the user share the same renderer, which makes Take control natural.

## ADR-008 — Sandbox: per-task nonroot container with no network; Apple `container` first; no host-shell fallback

**Decision.** Commands run in a container (UID 1000, read-only rootfs, caps dropped, network none, resource caps, bounded time, receipts). Backends: Apple `container` on macOS 26+, Docker/Colima (`vz`) otherwise, Docker/Podman on Linux. Host exec is a separate always-ask tool, off by default.

**Evidence.** OpenMuse's container contract and smoke tests; Cowork's VM + gVisor + egress proxy; the July 2026 Cowork SharedRoot escape (rw host mount + CVE); no container tool offers domain egress filtering, so a host-side allowlisting proxy (the `srt` design) is needed for opt-in network.

**Consequences.** First-run image pull; users on macOS 15 need Colima or Docker Desktop; LibreOffice/ffmpeg helpers run under `srt` Seatbelt profiles on the host instead of in every container.

## ADR-009 — VM mode through Virtualization.framework in the Swift helper; one guest per user

**Decision.** Psyche creates and manages its own macOS guest with public Virtualization.framework APIs; the host desktop becomes a client of the guest Gateway.

**Alternatives.** Depending on UTM / Tart / Lume as external tools (good for power users; fragile as a product dependency); Linux-only VM like Cowork (does not let the agent use Mac apps).

**Evidence.** Two-concurrent-macOS-guest cap (framework-enforced), iCloud sign-in rules (15+ host and fresh 15+ IPSW), macOS 27 `VZMacGuestProvisioningOptions` and DiskImageKit overlays, Lume's unattended-install technique, no bridged networking for third parties, Apple SLA limits (personal/dev use).

**Consequences.** VM mode is P1 and macOS 15+; the best experience needs macOS 27 on both sides; a prebuilt OCI image is a later optimization.

## ADR-010 — MCP spec 2026-07-28 with TypeScript SDK v2; first-party Google/Microsoft/mail adapters

**Decision.** The MCP host follows the current spec (per-request `_meta`, `server/discover`, MRTR, Tasks extension, MCP Apps) with a 2025-11-25 fallback, and does not build on deprecated Roots/Sampling/Logging/DCR. Google Workspace is a first-party adapter (no official Google MCP server exists; the `gws` CLI is "not officially supported").

**Evidence.** Spec changelog 2026-07-28; MCP Apps official extension (2026-01); registry still preview; Invariant Labs tool-poisoning research; Anthropic's directory policy; Google OAuth facts (restricted scopes, personal-use exemption, Testing-mode 7-day tokens, `history.list` polling recommended for installed apps).

**Consequences.** Per-tool allow/ask/deny keyed by `mcp__<server>__<tool>` with `tools/list` hashing; Google connector ships with "publish your consent screen to production" onboarding; Slack/Notion/Linear/GitHub use their first-party remote servers.

## ADR-011 — Channels follow OpenClaw's authorization semantics; iMessage only through a Mac node

**Decision.** `dmPolicy` (pairing default), pairing codes, owner allowlist, identity links, group mention gating, per-peer session scopes. iMessage requires a signed-in Mac with Full Disk Access and Automation; WhatsApp personal-number support is unofficial and labeled as such.

**Evidence.** OpenClaw access-control docs and the macOS 26 chat-GUID change that broke BlueBubbles; Meta Cloud API pricing and 24-hour window; Telegram Bot API 10.3 voice formats; Signal via signal-cli.

**Consequences.** Telegram is the P0 channel (fully supported API, buttons for approvals); WhatsApp/Signal/Slack/Discord are P2.

## ADR-012 — Proactivity is bounded, batched and confirmable

**Decision.** Feed posts, Ideas and inferred Goals are produced by scheduled jobs, cite evidence, require a tap to become work, and are gated by a learned acceptance probability.

**Evidence.** ChatGPT Pulse retired (June 2026) in favor of scheduled tasks; OpenClaw removed "inferred commitments" (v2026.8.1); Muse's own restraint ("worth the interruption"); the 2026 proactivity literature (PRISM thresholds, near-chance human agreement on interruption timing).

**Consequences.** No real-time interrupts for suggestions; a visible interest ledger; Ideas acceptance is a tracked metric.

## ADR-013 — UI stack and license policy for viewers

**Decision.** React 19, Tailwind 4, shadcn/ui v4 (Base UI), assistant-ui primitives, Lucide icons, OKLCH tokens with Radix-style 12-step scales; MDXEditor (or CodeMirror 6 + WYSIWYG) for Markdown; PDF.js 6; SheetJS CE from the vendor tarball + TanStack Table (view) and Univer (edit); docx-preview/mammoth; LibreOffice headless/Gotenberg or `qlmanage` for PPTX; CodeMirror 6 + Shiki 4 for code; sandboxed srcdoc iframes for artifacts; self-hosted Sandpack for React artifacts.

**Excluded on license or maintenance grounds.** npm `xlsx` 0.18.5 (unfixed advisories), Handsontable/HyperFormula (commercial / GPL), BlockNote XL (GPL or proprietary), iframe-resizer (GPL/commercial), ONLYOFFICE (AGPL), WebContainers (commercial), Monaco (100 MB, breaks on `file://`), Vercel AI Elements standalone (deprecated).

## ADR-014 — Speech: Apple frameworks first, open models second

**Decision.** `SpeechAnalyzer`/`SpeechTranscriber` on macOS 26+, FluidAudio Parakeet or WhisperKit on macOS 14–15, whisper.cpp on Linux; Kokoro-82M for local TTS with `AVSpeechSynthesizer` and cloud voices optional; Piper excluded (now GPL).

**Evidence.** SpeechAnalyzer has no one-minute limit and system-managed models; FluidAudio Parakeet ~0.19 s latency on ANE; Personal Voice carries non-commercial SLA language.

## ADR-015 — Protocol and codegen

**Decision.** TypeBox schemas → JSON Schema → generated TypeScript and Swift types; WS frames `req/res/event` with `seq`/`stateVersion`; device pairing with signed challenges; scoped tokens; no gateway-URL parameters accepted by the UI; WebSocket origin validation.

**Evidence.** OpenClaw's protocol pipeline and its CVE-2026-25253 (Control UI auto-connecting to a `gatewayUrl` query parameter and leaking the token).

## ADR-016 — Minimum OS and feature gates

**Decision.** Desktop requires macOS 15; macOS 26+ unlocks SpeechAnalyzer and Apple `container`; macOS 27 unlocks GUI-less VM provisioning and overlay images; the Linux server has no OS gate beyond Docker.

## ADR-017 — Telemetry and privacy defaults

**Decision.** No telemetry, no crash reports and no update pings beyond a version check unless explicitly enabled; logs contain no message bodies or secrets by default.

**Evidence.** OpenMuse's SDK telemetry defaults to full capture to PostHog (a cautionary example); Muse's training toggle defaulting to on drew criticism; OpenClaw's "phones home for nothing but a daily version check".

## ADR-018 — Workspace file compatibility with OpenClaw

**Decision.** Use the same file names and roles (`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`, `BOOTSTRAP.md`, `skills/`) so an OpenClaw workspace imports without conversion, and so users can move between the two.

## ADR-019 — License for Psyche itself

**Decision (proposed, owner to confirm).** Apache-2.0 for all first-party code (patent grant; compatible with the MIT/Apache dependencies); bundled creature art under CC-BY-4.0; no copyleft code linked into the core (optional external services such as Karakeep may be integrated over their APIs).

## ADR-020 — Naming the processes

**Decision.** `psyched` (Gateway daemon), `psyche` (CLI), `Psyche.app` (desktop), `Psyche Helper.app` (`com.psyche.helper`), `psyche-node`. The agent persona name is the user's choice and never appears in process names.

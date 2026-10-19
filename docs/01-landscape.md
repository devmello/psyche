# Psyche — Landscape Summary (what others do, and what we take from them)

Status: v0.1 (2026-10-18). This is the two-page version. The full research report (about 14,700 words, 534 inline citations) is at [`reports/Psyche personal agent landscape.md`](../reports/Psyche%20personal%20agent%20landscape.md); the seven sourced note files behind it are in [`research_notes/Psyche personal agent landscape/`](../research_notes/Psyche%20personal%20agent%20landscape/). Everything below was current on 2026-10-18.

## Corrections to the original brief

- The feature table in the brief ("Documents: email attachment → PDF → requested form values → filled copy → reviewed reply → receipt", "Gmail & Calendar", "Personal context", "Nonroot Docker container…", "Rich Threads… CopilotKit Intelligence") is quoted from **CopilotKit/openmuse (OpenMuse)**, created 2026-09-15, one week after Meta launched Muse. **CopilotKit/OpenDots** (2026-09-29) is a different, team-shaped project that clones OpenAI's Dots. Psyche's framing ("personal agent") is closer to OpenMuse.
- "The official Psyche app" in the brief means **Meta's Muse**: a standalone personal-agent app launched 2026-09-08 (iOS, Android, web, WhatsApp; Mac app 2026-09-17; iPad 2026-10-07), running on Muse Spark models inside a per-user cloud Linux VM, priced free / $20 / $100 per month with weekly token caps.

## What to imitate from Muse

- **Surfaces**: five phone tabs (Chat, Feed, Ideas, Goals, Library) and a Mac left rail (Chat, Search, Feed, Ideas, Goals, Library); a thread list with one persistent main chat plus side chats; an animated creature avatar in the chat header that "types" while working and opens an agent sheet with Activity (task list → per-task actions → raw logs), Approvals, Upcoming (scheduled work) and Soul & Memory.
- **Identity files**: Memory, Soul ("core truths, boundaries and personality") and Identity ("name, creature, vibe or tagline"), all user-editable Markdown.
- **Trust UX**: approvals as deterministic cards outside the conversation, issued by a separate "Sentinel" process, with Allow once / for this task / for this site / Always / Deny; "Ask for some actions" as the default; per-connector read-vs-act scopes and per-action Allow / Ask / Deny; per-Mac-app Off / Read only / Read and interact; credentials in a secure store the agent cannot read; payments through single-use cards approved each time.
- **Browser**: a watchable view with a status pill, Take control, Stop the task, and "closing keeps the task running".
- **Design stance**: "How would this work if you were talking to another human?", restrained proactivity ("worth the interruption"), progressive disclosure, generative UI with fixed card structure, "You are not a chatbot".

## What to avoid from Muse

Training on by default; memory that keeps dossiers on people who are not the user; deleting a conversation without forgetting; silently inferred goals; human-staffed phone calls presented as AI; a Mac dictation-endpoint zero-day; a required card on file; cloud-only.

## How the peers implement the same things

| Capability | Claude desktop app | OpenMuse | OpenClaw | What Psyche does |
| --- | --- | --- | --- | --- |
| Shell | Electron 44 + Swift N-API addon + signed helpers; panes driven by agent RPC | Expo / React Native + CopilotKit | Swift menu-bar app + Node gateway on 127.0.0.1:18789 | Electron 44 shell + Swift helper node + TypeScript Gateway (ADR-001/002) |
| Agent browser | In-app pane with its own partitions, accessibility-tree tools, per-site Allow once / Always / Deny | Separate Playwright worker with persistent profiles and takeover console | Managed Chromium profile or user's Chrome via DevTools MCP | Embedded `WebContentsView` + CDP; Playwright sidecar for server mode; real-Chrome mode for extensions |
| Isolation | Linux VM (Virtualization.framework) with gVisor egress proxy for Cowork | Nonroot Docker, network none, 30 s commands, receipts | Optional Docker/Podman sandbox, off by default | Container per task, no network, receipts; optional macOS guest VM |
| Approvals | Hooks → deny → ask → mode → allow; modes Manual / Accept edits / Plan / Auto; `AskUserQuestion` | Stored review bound to account + content hash + provider version before dispatch | Exec approvals bound to argv + cwd, 30-min TTL, `askFallback: deny` | Permission Broker with binding hashes, scopes, TTL, grant ledger |
| Memory | `MEMORY.md` index + topic files; claude.ai Topics | Editable name, tone, avatar, memories | `SOUL.md`, `AGENTS.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, daily notes; budgets; flush; nightly dreaming | Same file layout as OpenClaw (import-compatible) + FTS5/vec index with provenance |
| Long-running work | Desktop scheduled tasks, cloud routines, Dispatch, `update_plan` checklist | Durable tasks with SQL leases, input requests, receipts | Automations with session targets, heartbeat, unattended-run contract | Task engine with leases + automations + heartbeat + evaluator |
| Channels | Telegram / Discord / iMessage with pairing | — | 30+ channels; `dmPolicy` pairing default; owner allowlist; identity links | OpenClaw semantics; Telegram first; iMessage via Mac node |
| Credentials | 1Password for Claude (secrets never in context); refuses passwords, CAPTCHAs, payments | Google tokens encrypted at rest | Secret store (criticized as unencrypted at rest) | SQLCipher vault with keychain-wrapped key, placeholders, fills with approval; Stripe Link for payments |

## Technology picks the evidence supports

Electron 44 (Chromium 152) because only a Chromium shell gives an embedded, persistent, CDP-controllable browser; a TypeScript Gateway on Node 24; AI SDK v7 provider packages with Psyche's own router (the SDK has no cross-provider fallback); Ollama ≥0.40 (MLX runner, Anthropic-compatible endpoint) for local models such as Qwen3.8-27B, Gemma 4, gpt-oss-20b, GLM-4.7-Flash; SQLite with FTS5 + sqlite-vec; MCP spec 2026-07-28 with TypeScript SDK v2; Virtualization.framework for VM mode (two-guest cap, GUI-less provisioning only on macOS 27); Apple `container` on macOS 26+ with Colima/Docker fallback and `srt` for host-side helpers; `SpeechAnalyzer` on macOS 26+ with FluidAudio/WhisperKit fallbacks; Kokoro for local TTS; PDF.js 6, SheetJS CE + Univer, MDXEditor, CodeMirror 6 + Shiki; shadcn/ui v4 + assistant-ui + Tailwind 4 with OKLCH theming.

## Market signals that shaped the proactivity design

ChatGPT Pulse (daily proactive cards) was retired in June 2026 in favor of scheduled tasks; OpenClaw removed "inferred commitments" in v2026.8.1; Gemini ships a user-configured Daily Brief. Psyche therefore treats Feed, Ideas and inferred Goals as bounded, scheduled batches of evidence-linked candidates that need a tap to become work.

## Known gaps in the research

Muse's exact colors, typography, motion and whether it renders multiple-choice chips are undocumented (Psyche defines its own in `06-ui-design.md`); OpenAI's own pages for Pulse, Atlas and scheduled tasks were unfetchable, so those facts rest on dated secondary coverage; the iMessage voice-memo codec (CAF with Opus) is community-reported; Apple `container` and OrbStack startup times have no independent benchmarks; Tauri 3's CEF runtime on Apple Silicon is unverified.

# Psyche

**An open-source, self-hosted personal AI agent for macOS (and your own server).**

Psyche is the open alternative to Meta's Muse: one persistent conversation with a named, customizable agent that remembers you in files you can read, browses in a browser you can watch and take over, reads and sends your mail and messages, fills forms, shops, runs commands in a sandbox, controls your Mac apps, writes you a Feed, proposes Ideas, tracks Goals, and keeps working after you close the window. It asks before anything that matters, keeps a receipt for everything it does, never sees your passwords, and runs on whichever model you choose, including local ones. Run it on your Mac, inside a macOS virtual machine that Psyche creates, or on a Linux server that answers you on Telegram or iMessage.

> Status: **Milestone 1 integration**. The packages are on `main` and the walking skeleton (below) runs end to end against a scripted model in CI. The documents below are the architecture and implementation plan.

## Documents

| Doc | What it answers |
| --- | --- |
| [docs/00-vision-and-principles.md](docs/00-vision-and-principles.md) | What Psyche is, who it is for, what "imitate Muse" means, non-goals, v1.0 success criteria |
| [docs/01-landscape.md](docs/01-landscape.md) | Two-page summary of the research: corrections to the brief, what to imitate and avoid from Muse, how Claude desktop / OpenMuse / OpenClaw implement each capability, technology picks, gaps |
| [docs/02-architecture.md](docs/02-architecture.md) | Processes, deployment topologies, Gateway internals (agent loop, tasks, Permission Broker, Credential Broker, memory, MCP, channels, scheduler), desktop shell, Mac helper, browser, sandbox, VM mode, protocol, storage |
| [docs/03-feature-spec.md](docs/03-feature-spec.md) | **Everything that needs to be implemented**, ~190 items with priorities and "done when" criteria, plus end-to-end acceptance scenarios |
| [docs/04-data-model.md](docs/04-data-model.md) | SQLite schema, vault schema, workspace file formats, message blocks, approval and receipt shapes, audit entries, retention |
| [docs/05-security-and-permissions.md](docs/05-security-and-permissions.md) | Threat model, permission model, credential handling, sandboxing, prompt-injection defenses, channel authorization, remote access, supply chain, VM mode, audit |
| [docs/06-ui-design.md](docs/06-ui-design.md) | Information architecture, screen-by-screen specs with wireframes, design language, component inventory, theming, accessibility, keyboard map |
| [docs/07-tech-decisions.md](docs/07-tech-decisions.md) | ADRs: Electron + Swift helper, TypeScript Gateway, own loop on AI SDK v7, SQLite + Markdown memory, binding-hash approvals, vault, browser drivers, sandbox, VM, MCP, channels, proactivity, UI libraries, speech, licenses |
| [docs/08-roadmap.md](docs/08-roadmap.md) | Milestones 0–3 and v1.0, spikes, workstreams, risks, metrics |
| [docs/09-execution-plan.md](docs/09-execution-plan.md) | How to build it with many parallel Claude Code sessions : ownership map, waves, coordination rules, session roster |
| [prompts/](prompts/README.md) | One ready-to-paste prompt per session: bootstrap/integrator, 20 workstreams, 6 spikes, 3 integration sessions, plus sandbox, CLI/deploy and adversarial-review sessions |
| [reports/Psyche personal agent landscape.md](reports/Psyche%20personal%20agent%20landscape.md) | Research report: what Muse, the Claude desktop app, OpenMuse, OpenClaw, Codex/ChatGPT and browser-agent frameworks do, and what to build on |
| [research_notes/](research_notes/Psyche%20personal%20agent%20landscape/) | Seven sourced research files (~1 MB, ~2,000 citations) behind the report |

## Run the skeleton

The walking skeleton is one path through the real Gateway, agent loop, model router, Permission Broker, memory and task engine: onboarding writes the persona files, a chat turn streams, the agent reads a file in a granted folder and proposes a write, you approve it once and get a receipt, it asks a question with chips, the checklist and wrap-up box update, a delegated task keeps running after the window closes, the memory flush writes today's daily note, and the workspace exports as a zip.

```bash
pnpm install
pnpm --filter @psyche/integration-tests test
```

That runs the scenario in [tests/integration/walking-skeleton/](tests/integration/walking-skeleton/) with the scripted model, as CI does. The same scenario runs in the desktop app (Playwright for Electron, macOS):

```bash
pnpm --filter @psyche/desktop package
```

```bash
pnpm --filter @psyche/integration-tests e2e
```
 To run it against a live model (Anthropic, OpenAI or a local `agent-capable` model through Ollama), set the model and its key:

```bash
PSYCHE_LIVE_TESTS=1 PSYCHE_MODEL=anthropic/claude-sonnet-5-5 ANTHROPIC_API_KEY=… pnpm --filter @psyche/integration-tests exec vitest run live
```

To run the Gateway itself (`psyched`) with a model, then point the desktop app at it:

```bash
PSYCHE_MODEL=ollama/qwen3.8:27b pnpm --filter @psyche/gateway start
```

```bash
pnpm --filter @psyche/desktop dev
```

For a local model, install Ollama and pull an `agent-capable` model first (`ollama pull qwen3.8:27b`), then use `PSYCHE_MODEL=ollama/qwen3.8:27b` (and `PSYCHE_OLLAMA_URL` for a non-default server). Without `PSYCHE_MODEL`, `psyched` still starts and answers each turn with "No model is configured yet". Grant the agent a folder from Settings → File access ("Choose a folder…" on the desktop, or a typed path on the web), or by setting `permissions.policy` to `{"folders":[{"path":"/Users/you/Notes","mode":"rw"}]}` from the CLI; either way the device needs `operator.admin` (`psyched devices grant`), and the broker applies the grant without a restart. Remaining gaps per package are in [docs/status/int-1.md](docs/status/int-1.md).

## Architecture in one picture

```
 Clients ──────────────┐            ┌──────────── Executors ─────────────┐
 Psyche.app (Electron) │  WS/loop   │ embedded browser (CDP)             │
 web UI (same React)   ├──────────▶ │ Linux sandbox (Apple container /   │
 Telegram / iMessage / │            │   Docker), nonroot, no network     │
 WhatsApp / Signal …   │            │ Psyche Helper.app (Swift node):    │
                       │            │   AX/input, screenshots, Apple     │
   psyched — the Gateway (Node 24)  │   Events, Keychain + Touch ID,     │
   sessions · agent loop · model    │   notifications, SpeechAnalyzer,   │
   router · task engine · Permission│   Messages, Virtualization         │
   Broker · Credential Broker ·     │ optional macOS guest VM running    │
   memory files + index · MCP host  │   the whole stack                  │
   · channels · scheduler · Feed/   │ remote nodes                       │
   Ideas/Goals · search · audit     └────────────────────────────────────┘
```

Same Gateway on a Mac (launchd) or a Linux server (Docker Compose). State in `~/.psyche`: `state/psyche.sqlite`, `workspace/` (`SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, daily notes), `vault/` (SQLCipher), `library/`, `browser/profiles/`, `audit/`.

## Principles

1. One conversation, one agent, one identity. 2. Evidence is not permission. 3. Approvals are capabilities, not chat. 4. Every external write leaves a receipt. 5. The model never sees a secret. 6. Memory is files you can read. 7. Work keeps going. 8. Sandbox is the boundary, approvals are the policy. 9. Local first, loopback by default. 10. Proactivity is bounded and confirmable.

## What it borrows, and from whom

- **Muse** (Meta, Sept 2026): surfaces (Chat, Search, Feed, Ideas, Goals, Library), the agent sheet behind the avatar (Activity, Approvals, Upcoming, Soul & Memory), editable Soul / Identity / Memory files, browser Take control, approval scopes, per-connector and per-app permission matrices, persona customization.
- **Claude desktop app**: the pane workspace (chat, browser, terminal, files, diff, plan, tasks), agent-driven pane RPC, computer-use tiers and a signed helper, plan mode and the pinned checklist, structured questions, Electron + Swift stack.
- **OpenClaw**: one Gateway with a typed WS protocol, device pairing, `dmPolicy` pairing/allowlists for channels, the workspace files and injection budgets, pre-compaction memory flush, nightly consolidation, approvals bound to exact arguments, security lessons from its 2026 incidents.
- **OpenMuse** (CopilotKit): durable tasks with SQL leases, the review → dispatch → receipt contract, the nonroot network-less container, the separate browser worker with persistent profiles, the Documents pipeline.

## Planned stack

TypeScript / Node 24 · Electron 44 · React 19 · Tailwind 4 · shadcn/ui v4 · assistant-ui · AI SDK v7 providers with an own router · SQLite (FTS5 + sqlite-vec) · SQLCipher vault · MCP TypeScript SDK v2 (spec 2026-07-28) · Playwright (sidecar) · Swift helper (Accessibility, ScreenCaptureKit, Keychain, UNUserNotificationCenter, SpeechAnalyzer, EventKit, Virtualization.framework) · Apple `container` / Docker · grammY · PDF.js 6 · SheetJS CE + Univer · MDXEditor · CodeMirror 6 + Shiki · Kokoro TTS.

## License

Proposed Apache-2.0 (see ADR-019). Not final.

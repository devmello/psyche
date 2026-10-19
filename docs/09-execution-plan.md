# Psyche — Parallel Execution Plan

Status: v0.1 (2026-10-18). How to build Psyche with many Claude Code sessions (Max 20x, each using its own subagents) plus a Codex session on a basic plan, without them stepping on each other. Prompts for every session are in [`prompts/`](../prompts/README.md). Feature ids refer to [03-feature-spec.md](03-feature-spec.md).

## 1. Approach: contracts first, one package per session, fakes everywhere

Parallel sessions only work if they do not share files and do not wait on each other. Three rules make that true:

1. **Contracts first.** A single bootstrap session creates the monorepo, the `packages/protocol` schemas (TypeBox → JSON Schema → TS/Swift types) and, crucially, the TypeScript **interfaces** every subsystem implements or consumes (`ModelProvider`, `AgentLoop`, `PermissionBroker`, `CredentialBroker`, `MemoryStore`, `TaskEngine`, `BrowserDriver`, `SandboxRunner`, `McpHost`, `ChannelAdapter`, `NodeClient`, `Notifier`, `SearchIndex`, `SkillLoader`, `SpeechEngine`), each with an in-memory fake in `packages/testing`. Nothing else merges before this does.
2. **One package per session.** Each workstream owns a disjoint set of paths and may not edit anything else, except `packages/protocol` through a clearly labeled, additive "protocol:" PR that the integrator merges first.
3. **Fakes, not neighbors.** A session builds and tests against the fakes of the packages it depends on, never against another session's branch. Integration happens in dedicated integration sessions after packages land.

## 2. Repository layout and ownership

```
psyche/
  apps/
    gateway/        S01  composition root, WS/HTTP API, pairing/auth, session controller
    desktop/        S11  Electron shell, panes, browser pane host, terminal pane, settings shell
    web/            S11  same React app served by the Gateway
    mac-helper/     S14  Swift helper (node): AX, screenshots, Apple Events, Keychain, notifications, speech, VM
    node/           S19  psyche-node for VM guests and remote machines (M2)
    cli/            C2   psyche CLI
  packages/
    protocol/       S00  schemas, interfaces, codegen (changes via "protocol:" PRs only)
    db/             S00→S01  SQLite, drizzle, migrations (each package adds its own migration files)
    testing/        S00→S18  fakes, fixtures, injection corpus, secret-leak checker, scenario runner
    agent-core/     S02  loop, tools registry, context assembly, compaction, ask_user, plan/checklist
    model-router/   S03  provider adapters, router, usage ledger, price table, capability probe
    tasks/          S04  durable task engine
    scheduler/      S04  automations, heartbeat, watches, catch-up
    permissions/    S05  policy engine, approvals, grants, binding hashes, classifier hook
    audit/          S05  hash-chained audit log, receipts store
    vault/          S06  SQLCipher vault, key wrapping, placeholders, fill protocol
    memory/         S07  workspace files, index, memory tools, flush, dreaming
    browser/        S08  BrowserDriver, CDP driver, Playwright driver, snapshots, origin policy, bridge protocol
    sandbox/        C1   container runner backends, image, receipts, srt wrapper
    mcp-host/       S09  MCP client host, trust tiers, tool policy integration
    connectors/     S09  Google (Gmail/Calendar/Drive), search/fetch, IMAP/JMAP later
    channels/       S10  channel framework, WebChat, Telegram; iMessage glue later
    ui/             S12  React components: message blocks, cards, screens, theme
    viewers/        S13  PDF, sheets, DOCX, code, Markdown editor, artifact frame, extraction, generators
    proactive/      S15  feed, ideas, goals pipelines
    notifications/  S15  notification model and delivery routing
    search/         S16  unified index and query
    skills/         S16  SKILL.md loading, index, install/trust
    speech/         S17  STT/TTS abstractions, whisper.cpp path, voice-note transcoding
  skills/           S20  bundled SKILL.md files
  templates/        S20  default SOUL.md / AGENTS.md / USER.md / IDENTITY.md / interests.md
  deploy/           C2   Dockerfile, compose, launchd plists, Tailscale/Cloudflare examples
  spikes/           SP*  throwaway prototypes (never imported by packages)
  docs/             all  (each session may add docs/plans/<id>.md and docs/status/<id>.md)
  prompts/          S00  session prompts
```

Each package owns the database tables listed for it in [04-data-model.md](04-data-model.md) and adds migrations named `packages/db/migrations/<YYYYMMDDHHMM>_<package>_<desc>.sql`.

## 3. Waves and gates

| Wave | Sessions | Starts when | Gate to next wave |
| --- | --- | --- | --- |
| **0 — Init** | You (or this session): `git init`, commit docs + prompts, create the GitHub repo | now | `main` exists with docs and prompts |
| **0 — Bootstrap** | S00 | after init | scaffold + protocol v0 + fakes merged to `main`; `pnpm -r test` green in CI |
| **1 — Spikes and content** (parallel with Bootstrap; no shared code) | SP1–SP6, S20, S18 (corpus and scenario scripts only) | after init | spike write-ups in `docs/spikes/`; findings folded into prompts if they change a decision |
| **2 — Core packages** | S01–S10, S12–S17, C1 | after Bootstrap merges | each package: contract tests green against fakes, README, status file |
| **2b — Shells** | S11 (desktop/web), S14 (helper) | after Bootstrap merges | shells run against fakes/mock Gateway |
| **3 — Integration** | INT-1 walking skeleton, INT-2 server mode, INT-3 acceptance V1/V2/V7, C2 CLI/deploy | when the packages a scenario needs are merged | Milestone 1 acceptance in [08-roadmap.md](08-roadmap.md) |
| **4 — M2 features** | re-use the same sessions with M2 scopes | after M1 | — |

The integrator (S00 after bootstrap) merges in this order whenever PRs are ready: protocol → db → testing → everything else → apps.

## 4. Session roster

| Id | Session | Owns | Feature ids (M1 scope; M2 in parentheses) | Depends on (via fakes) | Prompt |
| --- | --- | --- | --- | --- | --- |
| S00 | Bootstrap, then Integrator | root configs, `packages/protocol`, `packages/db` v0, `packages/testing` skeleton, CI | A1, A3, A4, A5 | — | `prompts/s00-bootstrap-integrator.md` |
| S01 | Gateway core | `apps/gateway`, `packages/db` evolution | A2, N14, E1/E2/E3 persistence and session controller | agent-core, tasks, permissions, memory | `prompts/s01-gateway-core.md` |
| S02 | Agent runtime | `packages/agent-core` | C1–C5, C8, C9, C11, B7 (C6, C7) | model-router, permissions, memory | `prompts/s02-agent-runtime.md` |
| S03 | Model router | `packages/model-router` | B1–B6 | vault | `prompts/s03-model-router.md` |
| S04 | Tasks and scheduler | `packages/tasks`, `packages/scheduler` | D1–D3, D6, O1, O4 (O2, O3) | agent-core, permissions, notifications | `prompts/s04-tasks-scheduler.md` |
| S05 | Permissions and audit | `packages/permissions`, `packages/audit` | F1–F12, U3 | vault (for fill approvals), notifications | `prompts/s05-permissions-audit.md` |
| S06 | Vault | `packages/vault` | G1–G9, G13, G14 (G10–G12) | permissions, helper keychain capability | `prompts/s06-vault.md` |
| S07 | Memory | `packages/memory` | H1–H5, H7 logic, H8 (H6, H9, H10) | model-router (embeddings, utility model) | `prompts/s07-memory.md` |
| S08 | Browser | `packages/browser` | I2–I4, I7–I9, I15 (I10, I12–I14) | permissions, vault (fill endpoint) | `prompts/s08-browser.md` |
| S09 | MCP host and connectors | `packages/mcp-host`, `packages/connectors` | M1, M2, M4 data, M5, M8, M11 (M3, M7, M10) | permissions, vault, sandbox | `prompts/s09-mcp-connectors.md` |
| S10 | Channels | `packages/channels` | N1–N4 (N5 glue, N10, N11) | gateway API, permissions, notifications | `prompts/s10-channels.md` |
| S11 | Desktop and web shells | `apps/desktop`, `apps/web` | A6, A7, A8, E10, I1, I5, I6, I11, K6, D5, O10 relay, Q1 UI | protocol, ui, browser bridge, viewers | `prompts/s11-desktop-web-shell.md` |
| S12 | UI kit | `packages/ui` | E4, E8 cards, F3, C4 UI, O6/O8/O9 screens, P7 screen, S1 UI, R2, R3, U1 screens | protocol only | `prompts/s12-ui-kit.md` |
| S13 | Viewers, editor, documents | `packages/viewers` | P1, P3, P4, P5, P6, P9 (P2, P8) | protocol only | `prompts/s13-viewers-editor.md` |
| S14 | Mac helper | `apps/mac-helper` | A9, J1–J5, O10 OS delivery, Q1 engines, keychain capability for G1 (J6, J7, J9, L1–L5) | protocol (node capability specs) | `prompts/s14-mac-helper.md` |
| S15 | Proactive and notifications | `packages/proactive`, `packages/notifications` | O10 model (O5–O9) | scheduler, memory, model-router, connectors | `prompts/s15-proactive-notifications.md` |
| S16 | Search and skills | `packages/search`, `packages/skills` | S1, T1, T5 loading (S2, T2) | db, memory | `prompts/s16-search-skills.md` |
| S17 | Speech and voice notes | `packages/speech` | Q1 TS side (Q3, Q4, N11) | helper engines via node capability | `prompts/s17-speech.md` |
| S18 | Security and test harness | `packages/testing` content, `tests/` | cross-cutting acceptance criteria; corpus; secret-leak checker; scenario runner | all (as fakes) | `prompts/s18-security-test-harness.md` |
| S19 | Node agent (M2) | `apps/node` | L3, N13 node side | protocol | `prompts/s19-node-agent.md` |
| S20 | Content: skills and templates | `skills/`, `templates/` | T5 content, H1 templates, R1 copy | — | `prompts/s20-content-skills-templates.md` |
| SP1–SP6 | Spikes | `spikes/<name>`, `docs/spikes/` | roadmap M0 spikes | — | `prompts/spike-*.md` |
| INT-1..3 | Integration | cross-package wiring only | walking skeleton, server mode, acceptance | merged packages | `prompts/int-*.md` |
| C1 | Codex: sandbox | `packages/sandbox`, `deploy/sandbox-image` | K1–K3, K8 base | protocol | `prompts/codex-c1-sandbox.md` |
| C2 | Codex: CLI and deploy | `apps/cli`, `deploy/`, release CI | A10 subset, A11 | protocol, gateway API | `prompts/codex-c2-cli-deploy.md` |
| C3 | Codex: adversarial review | reviews only | — | — | `prompts/codex-c3-adversarial-review.md` |

Running fewer sessions: merge S02+S03, S04+S05, S12+S13, S16+S17+S20, and run the spikes inside S08/S14/S03 as their first task.

## 5. Coordination rules (also in `prompts/_shared-rules.md`)

- **Branches and worktrees.** One worktree per session, branch `ws/<id>-<name>` (for example `ws/s05-permissions`). Rebase on `main` at least daily. Small PRs (under ~800 lines of diff) with a checklist in the description.
- **Ownership.** Edit only your owned paths. Need something from another package? Code against its interface and fake; if the interface is missing something, open a `protocol:` PR that adds it (additive only) and continue against your local copy until it merges.
- **Protocol changes** are additive until v1: new optional fields, new methods, new events. Removing or renaming requires the integrator's sign-off.
- **Migrations** use the timestamped naming above and touch only your tables.
- **Tests.** Every package ships contract tests that run against the fakes, plus unit tests. CI gates: typecheck, lint, tests, the secret-leak checker, and (from Wave 3) the injection corpus.
- **Status.** Keep `docs/status/<id>.md` current at each milestone (what works, what is stubbed, what blocked you, what you need from others). The integrator reads these daily.
- **Security rules are not optional.** Follow [05-security-and-permissions.md](05-security-and-permissions.md): no secrets in model-visible text, every side effect through the Permission Broker interface, receipts for every write, no host-shell fallback, loopback bind, no telemetry.
- **Versions.** Verify library versions with `npm view <pkg> version` before pinning; do not rely on memory.
- **Subagents.** Use them for library research, writing tests, and independent review of your own PR before you open it; never for cross-package edits.
- **Conflicts.** If two sessions need the same file, stop and leave a note in `docs/status/<id>.md`; the integrator decides.

## 6. Codex (basic plan) assignments

Codex usage is limited, so it gets self-contained, test-heavy work with a clear finish line:

1. **C1 sandbox** (best fit): the nonroot container image, the `SandboxRunner` implementation for Apple `container`, Docker and Colima, receipts, and the smoke test adapted from OpenMuse's (nonroot, read-only system files, disabled network, capped output, interruption, workspace persistence).
2. **C2 CLI and deploy**: `psyche` CLI commands that only call the Gateway API, the Dockerfile and Compose, launchd plists, release workflow.
3. **C3 adversarial review**: a red-team read of `docs/05` and the permissions/vault PRs: binding-hash gaps, approval replay, taint bypasses, placeholder leaks, with concrete failing test cases.

## 7. Integration milestones (map to roadmap M1)

- **INT-1 walking skeleton**: desktop ↔ gateway ↔ agent-core ↔ model-router ↔ memory ↔ permissions; a chat turn with a tool call and an approval card; persona onboarding writes the workspace files.
- **INT-2 browser and connectors**: embedded browser pane driven by the CDP driver; Google connector; Telegram channel with pairing; tasks visible in Activity.
- **INT-3 acceptance**: V1 inbox triage, V2 calendar planning, V7 research brief, on one hosted and one local model; resumability and secret-leak checks in CI.

## 8. What the first day looks like

1. Init: `git init`, commit docs and prompts, create a private GitHub repo, push `main`.
2. Start S00 (bootstrap). In parallel start SP1–SP6, S20 and S18's corpus work; they do not touch the scaffold.
3. When S00's bootstrap PR merges (target: end of day 1), start S01–S17 and C1 from the prompts.
4. S00 becomes the integrator; C3 starts reviewing as soon as the first permissions/vault PRs appear.
5. After the core packages land, start INT-1 and C2; then INT-2 and INT-3.

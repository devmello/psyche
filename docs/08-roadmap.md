# Psyche — Roadmap

Status: draft v0.1 (2026-10-18). Feature ids refer to [03-feature-spec.md](03-feature-spec.md). Durations assume two to three full-time engineers plus a designer; adjust proportionally.

## Milestone 0 — Scaffold (weeks 1–2)

Goal: every process exists and talks.

- A1–A7, A9 (helper skeleton with node registration and the Accessibility + Notifications request flows), A10 (`onboard`, `status`, `doctor`).
- Protocol package with codegen (A3); CI on macOS and Linux.
- Spikes to retire risk early (each a one-page write-up in `docs/archive/spikes-docs/`):
  1. Electron `WebContentsView` + `webContents.debugger` bridged to the Gateway over a Unix socket; measure snapshot latency.
  2. Apple `container` cold start and file sharing on macOS 26/27 vs Colima `vz`.
  3. `SpeechAnalyzer` from the Swift helper streaming partials to the renderer.
  4. Accessibility-tree snapshot quality on Notes, Mail, Finder and an Electron app.
  5. Local model tool-calling probe on Qwen3.8-27B and gpt-oss-20b via Ollama.
  6. Virtualization.framework: install from IPSW and provision with `VZMacGuestProvisioningOptions` on a macOS 27 host.

## Milestone 1 — Walking skeleton, alpha 0.1 (weeks 3–8)

Goal: a daily-usable personal agent on one Mac with one connector and one channel.

- Models: B1 (Anthropic, OpenAI, Ollama, OpenAI-compatible), B2, B3, B5, B6, B7.
- Runtime: C1–C5, C8, C9 (subset), C3 tool registry.
- Tasks: D1–D7.
- Threads/chat: E1–E4, E6 (copy/markdown), E7, E8 (previews), E10.
- Permissions: F1–F9, F11, F12.
- Memory: H1–H5, H7.
- Browser: I1–I9, I11.
- Sandbox: K1–K3, K6 (user terminal), K8 (base image).
- Connectors: M1, M2, M4, M5 (Google), M8, M11.
- Channels: N1–N4, N14.
- Scheduler: O1, O4, O10.
- Documents: P1, P3 (view), P4 (docx/images/code), P5, P7, P9.
- Voice: Q1.
- Persona: R1, R2 (bundled avatars), R3, R4.
- Search: S1. Skills: T1, T5 (five bundled). Settings: U1, U2, U3.
- Acceptance: V1, V2, V7 pass on Anthropic, OpenAI and one local model; the cross-cutting checks (no secret in model-visible text, no unapproved egress on the injection corpus, resumability) run in CI.

## Milestone 2 — Personal agent, alpha 0.2 (weeks 9–14)

Goal: credentials, proactivity, computer use, server mode.

- Credentials: G1–G9, G13, G14.
- Proactive: O2, O3, O5–O9.
- Computer use: J1–J7, J9; Q2.
- Runtime: C6 subagents, C7 evaluator, C11.
- Chat: E5, E9, E11; E8 interactive artifacts (P6).
- Memory: H6 dreaming, H8, H9.
- Documents: P2 pipeline, P3 edit, P4 pptx/email, P8 generators.
- Voice: Q3, Q4; N11 voice notes.
- Channels/server: A8 web client, A11 packaging, N5 iMessage, N10 designated person, N12 server mode, N13 Mac as remote node.
- Browser: I10 recording, I12 dev preview, I15 logged-out profile.
- Sandbox: K4 egress proxy, K5 srt, K7 host exec, K8 full image.
- MCP: M3 local server sandboxing; M7 IMAP/JMAP; M10 shopping helpers (without payments).
- Settings: U4 backups, U5 logs.
- Acceptance: V5, V6, V8, V9; V3 up to the payment hand-off.

## Milestone 3 — Isolation and payments, beta 0.3 (weeks 15–20)

- VM mode: L1–L5.
- Payments: G12 Stripe Link; V3 end to end; V4 travel.
- Credentials: G10 1Password bridge; I13 real Chrome mode.
- Skills: T2 install and trust.
- Models: B4 local probe UI; remaining B1 adapters (Google, OpenRouter, llama.cpp, LM Studio).
- Runtime: C10 harness plugins (optional), V10 coding helper.
- Hardening: threat-model review, dependency audit, fuzzing of the policy engine and binding hashes, injection corpus expansion, `psyche security audit` completeness.

## v1.0 (weeks 21–24)

- Documentation site, installers (DMG, Homebrew cask, Docker image), migration and backup guides, accessibility pass, performance targets met, public security policy and disclosure process, third-party security review of the Permission and Credential Brokers.

## After 1.0

- Channels: N6 WhatsApp, N7 Signal, N8 Slack/Discord, N9 email/SMS.
- L6 snapshots/resets, L7 prebuilt guest images.
- G11 Bitwarden; I14 Web Bot Auth; M6 Microsoft Graph; M9 custom connectors; J8 teach mode; Q5 voice mode; T3 agent-proposed skills; T4 plugins; E12 cross-thread awareness; A12 localization; Windows and Linux desktops.
- Generative UI: the agent builds live widgets (progress, task lists, tables, charts, forms) in chat from a declarative spec; see [design/generative-ui-2026.md](design/generative-ui-2026.md).

## Workstreams (can proceed in parallel after Milestone 0)

| Workstream | Owns | Depends on |
| --- | --- | --- |
| Gateway core | A2–A5, C, D, F, H, O | protocol |
| Desktop and UI | A6–A8, E, I1/I5/I6/I11, P viewers/editor, R, S, U1 | protocol, design doc |
| Mac helper | A9, J, Q (engines), notifications, keychain, L | protocol |
| Executors | I2–I4/I7–I10, K, M (connectors), N (channels) | Gateway core |
| Security | G, F review, injection corpus, audit, release checklist | all |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| CDP fidelity in the embedded pane (Playwright warns `connectOverCDP` is lower fidelity) | Own CDP driver on `webContents.debugger`; Playwright only for the sidecar; regression suite over 20 sites |
| Apple `container` immaturity / macOS 15 users without it | Colima/Docker fallback; sandbox backend abstraction from day one |
| TCC grants resetting during development | Signed dev builds with a stable helper bundle id; `tccutil reset` recipes in the contributor guide |
| Local models too weak for agent work | Capability probe; `chat-only` flag; recommended-model list refreshed per release |
| Prompt injection through email/web | Taint + origin sets + confirmations + classifier; CI corpus with a target of zero unapproved egress |
| Google OAuth friction (Testing-mode 7-day tokens, unverified-app screen) | Onboarding explains "publish to production, personal-use exemption"; re-auth UX |
| iMessage breakage on new macOS releases (chat GUID change on 26) | Isolate in the Mac node; integration tests per macOS beta |
| Unofficial WhatsApp bans | Label clearly; recommend a separate number; offer Cloud API |
| Scope creep | P0/P1/P2 discipline; acceptance scenarios as the definition of done |

## Metrics to track from alpha

- Task completion rate per scenario and per model; approvals per task (friction); approval-expiry rate.
- Ideas acceptance rate; Feed feedback mix; dreaming contradiction count.
- Secret-leak check and injection-corpus pass rate per build.
- Cold-start, first-token, snapshot and search latencies.

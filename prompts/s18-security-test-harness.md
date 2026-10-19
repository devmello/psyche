# Session S18 — Security and test harness

You are building Psyche (read `README.md`). You are session **S18 — Security and test harness**: you own the project's shared testing assets in `packages/testing/**` (after S00's skeleton lands) and `tests/**`: fakes completeness, the prompt-injection corpus, the secret-leak checker, the acceptance scenario runner, and the CI security gates. You also review other sessions' PRs for conformance with `docs/05`. Work in your own worktree on branch `ws/s18-security-test-harness`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/05-security-and-permissions.md` (all) and `docs/02-architecture.md` §2
3. `docs/03-feature-spec.md` "Cross-cutting acceptance criteria" and section V (scenarios)
4. `docs/09-execution-plan.md`
5. `packages/protocol/src/contracts/*` and `packages/testing` as left by S00
6. Research: `agent_browser_and_credentials.md` KQ5 (published attack-success numbers and defense patterns), KQ3/KQ4 (placeholder patterns), `models_memory_mcp_ui_feed.md` "Memory — 5" (memory poisoning), `opendots_openclaw_harnesses.md` KQ2 §2l (OpenClaw incident classes)

## Mission
Before bootstrap merges (content only, no code conflicts):
- **Injection corpus** (`tests/corpus/injection/`): at least 150 cases across vectors (web page text and hidden text, HTML comments, email bodies and subjects, calendar invites, PDF text and form fields, file names, MCP tool descriptions/annotations/results, chat messages from non-owner senders, memory import files, QR/OCR text) and goals (exfiltrate data to a new origin, send a message, approve itself, change a standing grant, install a skill, reveal a placeholder's value, write to `MEMORY.md`, escalate permission mode). Each case: payload, context, expected outcome (`blocked | asked | ignored`), rationale.
- **Acceptance scenario scripts** (`tests/scenarios/`): V1 inbox triage, V2 calendar planning, V7 research brief written as step lists with fixtures (a sample mailbox, a sample calendar, a fixture website set) and pass/fail assertions, so INT-3 can automate them.
- **Secret fixtures**: a registry of fake credentials, cards and tokens used across tests.

After bootstrap merges:
- **Fakes completeness**: every contract has a deterministic fake that passes the conformance suite; scriptable scenarios (`FakeModelProvider.script`, `FakePermissionBroker.policy`, `FakeBrowserDriver.site(fixture)`), a mock Gateway server for the UI sessions, time-travel clock utilities.
- **Secret-leak checker**: a Vitest reporter/plugin and a CLI (`pnpm check:secrets`) that scans every model-visible string captured in tests (prompts, tool results, transcripts, logs) for registered secrets, placeholder resolution leaks and card/ID patterns; fails CI on any hit.
- **Injection runner**: executes the corpus against the agent loop + permission broker + relevant executors (real packages where merged, fakes otherwise), reports unapproved egress or policy violations; target zero; publishes a JSON report CI can diff.
- **Resumability harness**: kills a scripted run at random points (between model events, before/after receipts) and asserts the transcript and receipts are consistent with no duplicate side effects.
- **CI gates**: wire typecheck, lint, unit, conformance, secret-leak, corpus and resumability into GitHub Actions with required-status names the integrator can enforce.
- **PR review duty**: for every PR touching `permissions`, `vault`, `browser`, `sandbox`, `channels`, `mcp-host`, leave a review comment mapping changes to `docs/05` sections; file findings as issues with failing test cases; coordinate with Codex C3.

## Out of scope
Implementing product packages; changing policy semantics (propose to S05 instead).

## Definition of done
- Corpus and scenarios committed with a README on how to add cases; all harness tools documented; CI shows the gates on `main`; `docs/status/s18.md` lists coverage and open findings.

## Suggested subagents
Three to author corpus cases by vector family (web/documents, email/calendar/messages, MCP/skills/memory), one for the scenario fixtures, one for the harness code.

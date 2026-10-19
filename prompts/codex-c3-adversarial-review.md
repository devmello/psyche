# Codex C3 — Adversarial review of the security design and the security-critical PRs

You are reviewing Psyche, an open-source self-hosted personal AI agent (read `README.md`). You write no product code. You produce findings with concrete, failing test cases. Work on branch `codex/c3-review`; you may add files only under `docs/reviews/**` and `tests/corpus/review-cases/**`.

## Phase 1 (start now): design review
Read `docs/05-security-and-permissions.md`, `docs/02-architecture.md` §4.6–§4.7 and §8–§10, `docs/04-data-model.md` §4–§6, and the research facts in `research_notes/Psyche personal agent landscape/agent_browser_and_credentials.md` (KQ4, KQ5) and `opendots_openclaw_harnesses.md` (KQ2 §2k–2l). Attack the design as a red team would. For each finding write `docs/reviews/design-<n>.md` with: the attack narrative (who, how, through which surface), the design assumption it breaks, severity, a proposed control, and a concrete test case (inputs, expected outcome) that S18 can add to the corpus. Cover at least: approval replay and binding-hash gaps (canonicalization, argv tricks, Unicode hosts, redirects), taint bypasses (tool chaining, memory as a laundering channel, subagents, automations), placeholder leaks (error messages, logs, screenshots, HTTP redirects carrying headers, env var inheritance), control-plane takeover (pairing scope, token leakage via UI, WebSocket Origin), channel impersonation (sender spoofing, identity links, group mentions), skill and MCP supply chain (tool description changes, prerequisites), VM shared folders, backup exposure, and the localhost test-credential exception.

## Phase 2 (as PRs appear): code review
For every PR touching `packages/permissions`, `packages/vault`, `packages/browser`, `packages/sandbox`, `packages/channels`, `packages/mcp-host` or `apps/gateway` auth: read the diff, map each change to the relevant `docs/05` section, try to write a failing test that violates the stated rule (add it under `tests/corpus/review-cases/<pr>/` as a Vitest file against the package's public API), and leave a review summary in `docs/reviews/pr-<number>.md` (what you tried, what broke, what held). Prioritize: binding-hash canonicalization, approval expiry/re-issue, grant scope checks, redaction completeness, origin policy on redirects, sandbox host-shell fallbacks, pairing and token scopes.

## Rules
Be specific and reproducible; no generic advice. Prefer a 20-line failing test over a paragraph. Rank findings by severity. Keep each review under 600 words.

## Definition of done per phase
Phase 1: at least 15 design findings filed with test cases; Phase 2: a review file per security-critical PR within a day of it opening, and an index at `docs/reviews/README.md`.

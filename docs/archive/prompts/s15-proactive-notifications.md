# Session S15 — Proactive surfaces and notifications

You are building Psyche (read `README.md`). You are session **S15 — Proactive and notifications**: `packages/proactive` (Feed, Ideas, Goals pipelines) and `packages/notifications` (the notification model and delivery routing). Work in your own worktree on branch `ws/s15-proactive-notifications`. You own `packages/proactive/**` and `packages/notifications/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §2 (principle 10), §4.11 (feed, ideas, goals), §4.12 (notifications)
3. `docs/03-feature-spec.md` rows O5–O10
4. `docs/04-data-model.md` §8 (feed_posts, ideas, goals, notifications) and §7.1 (`interests.md`)
5. `docs/06-ui-design.md` (Feed, Ideas, Goals, notifications inbox sections; you supply their data)
6. `docs/07-tech-decisions.md` ADR-012
7. Contracts: `Scheduler`, `MemoryStore`, `ModelProvider`, `Notifier`, `NodeClient` (OS notifications via the helper), `ChannelAdapter`; fakes
8. Research: `models_memory_mcp_ui_feed.md` "Feed/ideas/goals" (Pulse retirement, Gemini Daily Brief, OpenClaw removing inferred commitments, Discover feedback vocabulary, sourcing options and prices, ranking references, proactivity research thresholds, skill-induction papers) and `meta_muse_app.md` Q2, Q3 (how Muse's Feed, Ideas and Goals behave)

## Mission (M1: notifications; M2: proactive pipelines — start the pipelines once notifications are solid)
- **Notifications model**: typed kinds (`approval | input_needed | task_done | task_failed | proactive | briefing | reminder | system`), durable inbox rows, actions, surfaces (`desktop`, `os`, `web`, `channel:<id>`), delivery routing with per-surface adapters (desktop via Gateway events, OS via the helper node capability, channels via adapters), dedupe per task/kind, quiet hours, restart reconciliation (stale notifications marked), read/resolve lifecycle, `notifications.*` API handlers and events.
- **Interest ledger**: parse and update `interests.md` (topics, weights, exclusions, evidence) with derived embeddings through `ModelProvider.embed`; feedback writes (`follow topic`, `not interested`, `hide source`, `like`, `save`) adjust weights with documented rules and an audit line.
- **Feed pipeline** (O5): sources (RSS/Atom via a fetcher, Hacker News API, arXiv API, Bluesky Jetstream, saved Library items, connector summaries exposed by S09, paid web search only for gaps and only if configured) → candidate pool with dedupe/clustering by URL and embedding similarity → recall × recency decay → utility-model rerank over a shuffled shortlist (position-bias mitigation) → one or two exploration slots → post generation with mandatory citations and multi-source clusters → bounded daily brief (5–10 posts) plus user-defined briefings scheduled through `Scheduler`; every post stores `reasons`.
- **Ideas pipeline** (O7): nightly job producing candidates from (a) repeated tool sequences in the owner's threads (mine `tool_calls` for recurring patterns; draft a `SKILL.md` and mark it unverified until replay), (b) goals and memory (`MEMORY.md` claims mentioned repeatedly), (c) connector signals (unanswered mail older than N days, subscriptions, upcoming trips); each with evidence, effort estimate and an acceptance probability from a simple learned model over accept/dismiss history; batched delivery windows; accept → task or automation via `TaskEngine`/`Scheduler`; dismissed patterns suppressed.
- **Goals** (O9): CRUD, categories, milestones, plan, linked tasks/automations/watches, check-in cadence via `Scheduler`, progress summaries; inferred goal candidates proposed only as confirm-first cards (never auto-created); archive.
- **API handlers**: `feed.*`, `ideas.*`, `goals.*` and events.

## Out of scope
UI (S12), the scheduler itself (S04), web fetch/search implementation (S09; you call it).

## Definition of done
- Tests: notification routing matrix, dedupe, quiet hours, reconciliation; ledger parsing/feedback rules; feed ranking determinism with a seeded shuffle; citation enforcement (a post without sources is rejected); cluster dedupe; idea mining on fixture transcripts producing the expected candidates; acceptance-probability gating; goal lifecycle; confirm-first invariant for inferred goals.
- README: pipeline diagrams and the exact feedback-weight rules; `docs/status/s15.md`.

## Suggested subagents
One for source fetchers and clustering, one for ranking and the reranker prompt with offline evaluation on fixtures, one for idea mining, one for the notifications routing tests.

## Later
Bandit exploration tuning, briefing templates, replay-verified skill drafts with S16, goal check-in automations with S04.

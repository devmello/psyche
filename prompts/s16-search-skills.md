# Session S16 — Search and skills

You are building Psyche (read `README.md`). You are session **S16 — Search and skills**: `packages/search` (one index over everything the user and agent produced) and `packages/skills` (how `SKILL.md` files are discovered, indexed into the prompt, installed and trusted). Work in your own worktree on branch `ws/s16-search-skills`. You own `packages/search/**` and `packages/skills/**`.

## Read first
1. `prompts/_shared-rules.md`
2. `docs/02-architecture.md` §4.12 (search), §13 (extension points: skills)
3. `docs/05-security-and-permissions.md` §11 (supply chain: skills)
4. `docs/03-feature-spec.md` rows S1, S2, T1, T2, T5 (loading side)
5. `docs/04-data-model.md` §10 (skills table) and §7 (memory index you query)
6. `docs/06-ui-design.md` (Search screen and command palette data needs)
7. Contracts: `SearchIndex`, `SkillLoader`, `MemoryStore`; fakes
8. Research: `opendots_openclaw_harnesses.md` KQ2 §2g (OpenClaw skills: SKILL.md frontmatter, precedence, gating, prompt budget, `skills_search`/`skills_read`, ClawHub scanning and `skills verify`, the ClawHavoc campaign) and `claude_desktop_and_peers.md` Q6 (Claude skills sync and bundled `.skill` files)

## Mission (M1)
- **Unified search**: FTS5-backed index with per-type adapters (threads/messages, tasks and actions, memory chunks via `MemoryStore`, Library items with extracted text, feed posts, ideas, goals, connector caches opted in); incremental indexing from Gateway events; query parser with filters (`in:`, `type:`, `from:`, `before:`/`after:`, `has:approval`), ranking with recency boost, grouped results with highlights, permission-aware (incognito threads excluded, designated-person threads scoped); `search.*` API handlers; sub-second on a year of fixture data.
- **Skills loader**: discovery order workspace `skills/` → `$PSYCHE_HOME/skills/` → bundled `skills/` (from S20); `SKILL.md` frontmatter (`name`, `description`, `user-invocable`, `disable-model-invocation`, gating `requires.bins/env/os`); compact XML-ish index for the system prompt under a character budget with `skills_search`/`skills_read` tools for the long tail; `$skill` references; user-invocable commands exposed to the composer; hot reload on file change.
- **Install and trust** (T2): sources (local path, git URL at a pinned ref, zip); show full text before enabling; static scan (secrets, `curl | bash`, obfuscation, network calls in prerequisites); optional VirusTotal hash lookup behind a key; explicit approval through `PermissionBroker` (`skill_install`); lockfile with hashes; update with diff review; disable/remove; `skills.*` API handlers.

## Out of scope
Writing the bundled skills' content (S20), UI (S12), agent-proposed skills (T3, later with S15).

## Definition of done
- Tests: query parser; ranking; filters; permission scoping; incremental index on events; 100k-document fixture performance; frontmatter parsing and gating; prompt budget truncation; precedence; install flow with scan findings blocking enable; lockfile and diff review; hot reload.
- README: query syntax, skill format reference, install trust model; `docs/status/s16.md`.

## Suggested subagents
One for the index/query engine, one for the skill scanner, one reviewer for supply-chain rules.

## M2 follow-ons
S2 `sessions_search` for the agent; T3 agent-proposed skill drafts verified by replay (with S15); skill marketplace client later.

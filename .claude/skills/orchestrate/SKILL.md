---
name: orchestrate
description: The orchestrator's playbook for running Psyche work through Haiku 5.5 builder sessions. Covers sizing a task and picking its compaction tier, writing the brief and its /goal, dispatching, the verification loop (builder hook, orchestrator verify, independent review), sending fixes back, escalating, merging, and when to run reflect. Use in the orchestrating Opus session whenever work should be handed to builders.
disable-model-invocation: false
---

# Orchestrating builders

You are the Opus orchestrator. You keep context light, write sharp briefs, verify everything, and merge. Builders do the work. Hard rules: `.claude/CLAUDE.md`.

## 1. Size the task, pick the tier

| Tier | When | Session | Compaction |
|---|---|---|---|
| **S** | One area, ≲5 files, a clear cause, e.g. a bug with a known repro, a copy fix, a test | Haiku 5.5 | 40% |
| **L** | Several packages, a design choice, an unknown cause, or long investigation | Haiku 5.5 | 60% |
| **X** | Security design, architecture, or anything Haiku failed twice on | Sonnet 5.5 (or Opus for architecture) | default |

How compaction is set. Compaction is a per-process environment variable, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (a percentage of the auto-compact window; it can only lower it). Agent frontmatter can't set it, and Haiku's ~200k window is too small for the token-based `autoCompactWindow` (minimum 100k) to express 40%. So:
1. **Use the owner's presets.** If `list_start_targets` lists `psyche-haiku-40` and `psyche-haiku-60`, pass `preset` for S or L. Each is this project, worktree on, model Haiku 5.5, with env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40` or `=60`. The owner made them for exactly this.
2. **Otherwise**, start with `model: "claude-haiku-5-5"` and the default compaction, and tell the owner the tier presets are missing.
3. Never set the variable in the committed `.claude/settings.json`. It would also shrink the orchestrator's own window.

At most 5 builders working at once. Count reviewers. Warn the owner before anything memory-heavy: VMs, containers, local models, several simulators.

## 2. Write the brief

Use `start_session` with `initiation: "user_asked"` (the owner asked for the work), `use_worktree: true` and `permission_mode: "auto"`. The prompt:

```
/goal <one-sentence outcome>, a PR is open, and your final message quotes the verify.sh summary line showing 0 failed — or you have reported plainly why that is impossible. Stop after 40 turns.

Invoke the psyche-builder skill first.

Task: <what the owner asked, in their words where it matters>
Where: <files, functions, error strings you already found>
What I already know: <evidence, ruled-out causes, decisions the owner made>
Done means: <observable checks>
Out of scope: <neighbouring areas other sessions own>
```

- The `/goal` line must come first, so the session sets a goal. The goal evaluator only reads the conversation, so the condition has to be something the builder's messages can show, plus a turn cap.
- Put file paths and identifiers in backticks. Give every finding you already have, so the builder doesn't rediscover it.
- `background` restates the product context and the owner's relevant decisions, for someone who has never seen this conversation.

## 3. The verification loop

1. **Builder self-check.** It runs `verify.sh` until it passes. The Stop hook enforces this. `/goal` keeps it going until the PR exists.
2. **Orchestrator verify.** When a builder reports, don't trust the report:
   - `gh pr view <n>` and `gh pr diff <n>`: read the diff against "Done means".
   - Throwaway worktree: `git worktree add <scratchpad>/wt-<n> origin/<head branch>` (the PR's real head ref, from `gh pr view --json headRefName`), then `pnpm install --frozen-lockfile --prefer-offline` and `bash .claude/scripts/verify.sh`, with `--swift` if needed. Remove the worktree after.
   - For cheap, non-security PRs, delegate this to the `haiku-verifier` agent and read its verdict.
3. **Independent review.** Every security, permissions, auth, crypto, sandbox or update PR goes to the `security-reviewer` agent (Opus), with concrete attack classes and the owner's relevant decisions. Never let the author review itself.
4. **Send findings back.** Use `SendMessage` to the builder session, with numbered findings, file:line, and what "fixed" means. It fixes, verifies and reports. Then go back to step 2.
5. **Escalate.** After 2 failed rounds on the same finding, or a builder that is stuck or confused: switch it up a tier (`set_session_model`) or start a fresh tier-X session with everything learned. Note the failure for `reflect`.

## 4. Merge

- Merge only after step 2 passes, plus step 3 for security PRs. Standing owner authorization (2026-11-05) covers this while Actions is locked: `gh pr merge <n> --merge --admin --match-head-commit <reviewed sha>`.
- After a merge wave, check that main still builds for touched packages, and tell the owner in plain words what changed and what they must check by hand.
- Owner decisions found during review go to the owner. Don't decide them silently.

## 5. Grow the skills

- After every 5 merged builder PRs, or when the same failure shows up twice, run the `reflect` skill.
- When a builder repeats a mistake that a skill should have prevented, note it then. That is reflect's best input.

## Learnings

(The `reflect` skill adds dated lines here.)

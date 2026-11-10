---
name: reflect
description: Self-reflection pass that improves Psyche's agent skills from evidence. It reads what recent builder sessions did, where verification failed, what reviewers caught and what builders wrote under "Learnings". Then it edits the skills in .claude/skills, creates a new skill when a pattern keeps recurring, prunes stale advice, and logs every change. Run it after every 5 merged builder PRs, when one failure recurs, or when the owner asks.
argument-hint: "[since <date or PR number>]"
---

# Reflect and improve the skills

Goal: the next builder makes fewer of the mistakes the last ones made. Every change must trace to evidence. This skill may edit any skill in `.claude/skills/`, including itself, under the guardrails below.

## 1. Gather evidence since the last pass

The last pass's date and last PR number are the top entry of `changelog.md` next to this file. Use the argument instead if one was given.

- **Merged builder PRs:**
  - `gh pr list --repo devmello/psyche --state merged --search "merged:>=<date>" --limit 50 --json number,title,body,headRefName`
  - Pull each body's "Learnings", "Not verified" and "Noticed" sections.
- **Review rounds:**
  - `gh pr view <n> --comments` is usually empty: reviews travel as `SendMessage`, not as GitHub comments.
  - Read the orchestrator's messages to builders with `mcp__ccd_session_mgmt__list_events` on the builder session. They are the user turns that start "Another Claude session sent a message". For a transcript over ~300 messages, have a subagent page through it and write the rounds to a scratchpad file.
  - Count the fix rounds each PR needed and why. Note which findings an earlier fix caused.
  - Each commit's `Co-Authored-By` trailer shows which model built it.
- **Verify failures:**
  - `cat "$(git rev-parse --git-common-dir)/agent-verify/failures.tsv"`: one line per hook block (time, branch, failing checks).
  - Group the lines by check name and branch.
- **Escalations:**
  - Sessions moved up a tier.
  - Haiku sessions that stalled or gave up. Look for `/goal` impossible verdicts, or 3 failed verify attempts.
- **Skill usage gaps:**
  - Builders that never invoked `psyche-builder`.
  - Failures a skill already warned about, which means the warning was ignored or too buried.

Write a short evidence table in your scratchpad: *pattern → occurrences (PR or branch refs) → which skill should have prevented it*.

## 2. Decide what to change

Act on a pattern only if it occurred **at least twice**, or once with high cost: a broken main, a security hole, or lost owner data. For each pattern pick the smallest fix:

| Situation | Change |
|---|---|
| A skill lacked the knowledge | Add one dated line under that skill's `## Learnings`, or to `psyche-builder/learnings.md` |
| A skill had it but builders still missed it | Move it up into the main steps, make it a checklist item, or add it to `verify.sh` if a script can catch it |
| Several learnings say the same thing | Merge them into one sentence in the skill body, and delete the duplicates |
| A recurring area has no skill (≥3 PRs touched it with repeat trouble) | Create `.claude/skills/<new-name>/SKILL.md` with a `description` that triggers on that area, and mention it in `psyche-builder` step 1 |
| Advice is stale (the code moved, the tool changed, or the owner reversed a decision) | Fix or delete it. Verify against the current code first |
| The orchestrator's briefs keep missing something | Edit `orchestrate` (the brief template or loop steps) |
| The reflection process itself was weak | Edit this file, and say why in the changelog |

## 3. Guardrails (never break these)

- **Hard rules stay.** Never remove or weaken anything in `.claude/CLAUDE.md`'s hard rules, the security review requirement, or the "never skip or weaken tests" rule. You may only add to them or clarify them, and only with the owner's decision as evidence.
- **Never loosen verification.** `verify.sh` and `stop-verify.sh` may gain checks, but never lose one, and the 3-attempt cap stays. If a check is wrong, fix it so it still checks.
- **Evidence or nothing.** Every edit cites its refs in the changelog. No speculative "best practices".
- **Stay small.** Keep each SKILL.md under ~150 lines and each Learnings list under ~25 lines. Fold or prune instead of growing.
- **Facts about the code** (paths, commands, function names) must be checked against current `origin/main` before you write them.

## 4. Apply and land

1. Work in your own worktree on a branch `claude/reflect-<date>`.
2. Edit the skills.
3. Add a top entry to `changelog.md`: date, the PR range covered, and each change with its evidence refs.
4. Run `bash .claude/scripts/verify.sh`. If you changed `verify.sh`, test it on a branch with a known failure.
5. Open a PR titled `skills: reflect <date>`. The body shows the evidence table and the diff summary. The orchestrator reviews and merges it like any other PR. Builders only see the changes after the merge, because their worktrees come from `origin/main`.

## 5. Report

Report in a few lines:
- the patterns found, with counts;
- the skills changed or created;
- anything you decided not to change, and why;
- the PR link;
- suggestions for the owner: decisions only they can make.

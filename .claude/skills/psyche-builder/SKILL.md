---
name: psyche-builder
description: How a builder session works on Psyche from brief to PR. Covers reading the brief and goal, finding the code, making the change, the local verification loop, opening the PR and the report format. Invoke it first in any session the orchestrator started to build, fix or investigate something in this repo.
---

# Building on Psyche

The orchestrator gave you a brief and usually a `/goal`. Your job is one focused PR that meets the "Done means" in the brief, verified locally, with an honest report. The hard rules in `.claude/CLAUDE.md` apply at all times.

## 1. Understand before editing

- Restate the task to yourself in one line. If the brief names files, read them first. Otherwise search: `grep -rn` on the user-visible string or error text is usually the fastest way in.
- Check the domain skills under `.claude/skills/`:
  - `psyche-i18n` for any string;
  - `psyche-apple` for Swift, iOS or the Mac helper;
  - `psyche-permissions` for permissions, approvals, presence, the seal, the Auto allowlist or any payment or risk classifier;
  - any other skill whose description matches your area.
- Read `learnings.md` next to this file. It holds traps earlier builders hit.
- If the brief is ambiguous or seems wrong once you read the code, say so in your report rather than guessing at something large. Small, obvious choices you just make, and you note them in the report.

## 2. Make the change

- Smallest change that fully solves it. Fix the cause, not the symptom, and say what the cause was.
- Add or update tests that would have caught the bug or prove the feature works. Follow the patterns of the nearest existing test file.
- **Behaviour changes break old tests.** If you change a rule, a default, an allowlist, an error code or copy a test asserts, `git grep` the tests for the old value and update them in the same commit. This includes an owner decision relayed mid-PR. Eight existing tests broke this way in #1299, #1300 and #1301. One was `model-settings.test.ts` after the small-models decision, left for the orchestrator to fix.
- **Classifier-like work:** any rule that sorts inputs into "asks" and "doesn't ask", or "counts" and "doesn't count". Write a table-driven test with both lists before you change the rule: inputs that must match, and near-misses that share a word and must not. Every review finding becomes a row. See `psyche-permissions` §3.
- **Negative tests need a positive control.** A test that only asserts absence (reduced motion #1318, "picker hidden" #1325) passes when the feature is broken. Pair it with a case where the thing does appear, and run the test against the code it is meant to guard: #1327's redaction test built its own redactor, and #1329 B1/B2 tests covered only normal cases while the hole stayed open.
- **Merging main brings other PRs' tests.** #1325 asserted the Persona picker hidden, #1328 brought it back, and main broke (#1331). If `git merge origin/main` touches the same UI, re-run the tests of both before you push.
- **A fix that changes a shared predicate** (who is local, enrolled, ready, financial): list its callers and test one you didn't mean to change. Fixes opened new holes in #1299 and #1301. See `psyche-permissions` §2.
- Keep to the brief's scope. Unrelated problems you notice go in the report under "Noticed", not in the diff. If you do widen the scope (a fix you can't leave out), say so in the report. In #1309 the builder added a label fix the brief never mentioned.
- Protocol changes: `pnpm protocol:gen`. If you add an enum value, update the Swift helper's exhaustive `switch` sites and the TS `Record<Kind, …>` maps.

## 3. Verify (the loop)

The owner's rule (2026-11-18): don't overheat the Mac. Size checks to the change.
1. While you work, run only the test files you touched: `pnpm exec vitest run <files> --maxWorkers=1`. Don't run `verify.sh` after every small fix.
2. When the change is done, run `pnpm exec biome check --write <touched dirs>`, then `bash .claude/scripts/verify.sh` once (add `--swift` if you touched Swift). It typechecks the touched packages and runs the touched tests. Fix failures by re-running just the failing files, then run `verify.sh` once more before you push.
3. If you changed widely imported code (a shared hook, store, protocol type or permission rule), also run `verify.sh --related` once before the PR. It runs every existing test that imports what you changed, which is where builders most often break things unnoticed (#1299, #1300). Otherwise the merge gate runs it.

verify.sh compares your failures with a run on the merge base. "also failing on the base" is not your problem. "new in" is. "base could not run" means unknown: run that file yourself on `origin/main` before you call it pre-existing. Delete untracked build output first (`apps/ios/.build-ios`): biome lints it (#1305).

Run `verify.sh` in the foreground and wait for it. Don't end your turn while it runs in the background: the Stop hook then starts a second full verify, and load hit 26. Don't wait with `pgrep -f "verify.sh"`: it matches itself. In a fresh worktree `pnpm install` can fail on the better-sqlite3 rebuild; use `pnpm install --frozen-lockfile --ignore-scripts`, which is enough for vitest.

The Stop hook runs `verify.sh --quick` (lint, secrets, protocol, i18n; seconds) when you try to finish with changes it hasn't seen pass. If it blocks you, fix what it reports. Never skip, weaken, `.skip` or delete a test to get it passing. If you truly cannot fix a failure after 3 attempts, stop and report it plainly.

UI changes: if the brief asks for screenshots, use the browser preview or simulator as it says. Never run the built Psyche.app.

## 4. Open the PR

If the brief says not to push or not to open a PR (a dry run, an investigation, a local-only fix), stop after the local commit and go straight to the report.

- Commit with a clear message ending in your session's `Co-Authored-By` line (see `.claude/CLAUDE.md`).
- Push, then run `gh pr create --draft` with a body in this shape:
  - **What and why:** the cause and the fix, in plain words.
  - **Verification:** the verify.sh summary line and anything else you ran.
  - **Not verified:** what you could not check (real app, device, CI).
  - **Owner checks:** manual steps, if any.
  - **Learnings:** 0–3 one-line, non-obvious things a future builder should know (a trap, a command that works, a file that's easy to miss). Leave it empty if there is nothing new. The `reflect` skill harvests this section into the skills.
  - The 🤖 footer.
- Then `gh pr ready <n>`.
- **Before every later push**, run `gh pr view <n> --json state`. If it is MERGED or CLOSED, the push goes nowhere (#1309: two commits stranded until #1310). Branch from `origin/main`, cherry-pick the new commits, open a new PR, and say so in the report.

## 5. Report

End your turn with:
- one line on the outcome, with the PR link;
- the cause, the fix, and the verification result;
- "Not verified", "Noticed" and any question for the orchestrator.

Send the report once. Don't re-send it while waiting on background work. No praise or filler. If something failed, say it failed.

When the orchestrator sends review findings, fix them on the same branch, verify, push, and report again in the same shape:
- Each finding gets a test that fails without your fix.
- Check the PR is still open before you push (§4).
- Each round: run the tests for what you changed, then `verify.sh` once before you push. Add `--related` when the round touched shared code; "this change doesn't touch them" was wrong in #1300's last round.

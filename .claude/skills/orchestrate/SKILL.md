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
1. **Use the owner's presets.** If `list_start_targets` lists `psyche-haiku-40` and `psyche-haiku-60`, pass `preset` for S or L. Each is this project and worktree, with env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40` or `=60`. **A preset does not store the model**: always pass `model: "claude-haiku-5-5"` (or the tier's model) together with `preset`. Without it two builders ran on Opus 5.5. After starting, check the model with `get_session`. Proposal cards (`initiation: "own_initiative"`) can't carry a preset, so start those with `user_asked` or tell the owner.
2. **Otherwise**, start with `model: "claude-haiku-5-5"` and the default compaction, and tell the owner the tier presets are missing.
3. Never set the variable in the committed `.claude/settings.json`. It would also shrink the orchestrator's own window.

At most 5 builders working at once. Count reviewers. Warn the owner before anything memory-heavy: VMs, containers, local models, several simulators.

## 2. Write the brief

Before dispatching a queued item, grep or run a test for it on `origin/main`. Drop items already fixed and remove them from memory: 3 of 5 queued items (`sandbox.list`, `MACHINE_TOKENS_ENABLED`, the ⌘Q unsaved-edit prompt) were already on main (2026-11-23).

Use `start_session` with `initiation: "user_asked"` (the owner asked for the work), `use_worktree: true` and `permission_mode: "auto"`. The prompt:

```
/goal <one-sentence outcome>, a PR is open, and your final message quotes the verify.sh summary line showing 0 failed — or you have reported plainly why that is impossible. Stop after 40 turns.

Invoke the psyche-builder skill first.

Task: <what the owner asked, in their words where it matters>
Check main first: <the one-line check, e.g. `git log origin/main -S'<name>'`>. If it is already there, report the commit and stop.
Where: <files, functions, error strings you already found>
What I already know: <evidence, ruled-out causes, decisions the owner made>
Done means: <observable checks>
Out of scope: <neighbouring areas other sessions own>
```

- The `/goal` line must come first, so the session sets a goal. The goal evaluator only reads the conversation, so the condition has to be something the builder's messages can show, plus a turn cap.
- Pass explicit file lists; an empty one runs a whole suite.
- **Check main yourself before you dispatch each follow-up** (`git log origin/main -S'<identifier>'`, or read the code), and put the "check main first" line in the brief. A brief built from a research note or report says "check each item against main first": #1430 found R6's capture poll and panel throttle already fixed, so only the HUD was left. Quote the grep in the brief for any premise of the form "X has no caller / lacks Y": wave 2026-11-24 had three wrong ones that builders caught (`connectors.setMatrix` "no caller" when the UI existed, `normalizeWorkspacePath` already an allowlist, `memory.explain` on review rows that have no claim id: #1612). Three more in #1624-#1630: `chat.greet` already had a caller in `apps/web` (grep `apps/desktop/src/shell` too), `dropSecrets` runs on abandoned proposals not on remove, `memory.entities.forget` needs `operator.admin`. Name the gate or role in the brief. Stale dispatches so far: the cross-window lockout, "helper quits with Psyche" and the web-client copy (#1392) were already done.
- Put file paths and identifiers in backticks. Give every finding you already have, so the builder doesn't rediscover it.
- `background` restates the product context and the owner's relevant decisions, for someone who has never seen this conversation.

## 3. The verification loop

1. **Builder self-check.** It runs touched tests while working and `verify.sh` once before the PR. The Stop hook only runs `--quick`. `/goal` keeps it going until the PR exists. Owner rule (2026-11-18): don't overheat the Mac. One full check per PR head, and full checks queue one at a time. Write `verify.sh` output to a file and grep the summary line from it: `| tail -4` lost it (#1606).
2. **Orchestrator verify.** When a builder reports, don't trust the report:
   - `gh pr view <n>` and `gh pr diff <n>`: read the diff against "Done means".
   - Throwaway worktree: `git worktree add <scratchpad>/wt-<n> origin/<head branch>` (the PR's real head ref, from `gh pr view --json headRefName`), then `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts` (a plain install fails on better-sqlite3 here; if pnpm still reinstalls, set `pnpm_config_verify_deps_before_run=false`) and `bash .claude/scripts/verify.sh --related`, with `--swift` if needed. Remove the worktree after. This is the merge gate: run it once per PR head. If a `haiku-verifier` or `security-reviewer` already ran it on the same head SHA, read theirs instead of running it again. Docs, copy or i18n-only PRs need no `--related`.
   - For cheap, non-security PRs, delegate this to the `haiku-verifier` agent and read its verdict.
3. **Independent review.** Every security, permissions, auth, crypto, sandbox or update PR goes to the `security-reviewer` agent (Opus), with concrete attack classes and the owner's relevant decisions. Never let the author review itself.
4. **Send findings back.** Use `SendMessage` to the builder session, with numbered findings, file:line, and what "fixed" means. It fixes, verifies and reports. Then go back to step 2.
   - **Classifier-like work:** have the reviewer write its probes as two lists, "must match" and "must not". Send them as rows for the builder's table test. In #1301 the two-way probe lists caught what three rounds of one-way fixes missed.
   - **Owner decisions:** when you relay one that flips behaviour, tell the builder to grep the tests for the old expectation and run `verify.sh` before reporting. #1300 left `model-settings.test.ts` stale.
   - **Narrowing or classifier checks:** ask the reviewer to probe through the real engine (`decide()`), not only the pure function (#1354 r1 to r3).
   - **Re-reviews after a main merge** diff the PR's own first-parent commits, so the merge doesn't bury the fix (#1354 r2). They read the whole diff since the last reviewed head, not only the listed findings. In #1299 R2 and #1301 R2–R4, a fix opened the next hole.
5. **Escalate.** Escalate after 2 failed rounds on the same finding, after 2 rounds of blocking findings in one area even if each finding differs (#1301 was switched to Opus after R2), or when a builder is stuck or confused. A Haiku builder hit its 60-turn cap on a round that carried several security findings (#1545): send round-2 security fixes to Sonnet from the start, and cap the brief's `/goal` turn count accordingly. Switch it up a tier (`set_session_model`) or start a fresh tier-X session with everything learned. For a small, contained area, fix it yourself after the second blocking round: #1354 r2, #1368 r1 and #1372 r1 did, and the next round came back clean. Note the failure for `reflect`.

## 4. Merge

- **Two PRs on the same UI or module:** before the second merges, merge `origin/main` into it and re-run the first PR's tests (#1325 and #1328 broke main until #1331).
- **New action path:** for a PR that adds a tool or route that acts, put "check against every existing prohibition" into the review brief (#1315 skipped #1321's block).
- **Brief wording by area:** decoder or redaction: three-way fuzz (before, main, head) with counts (#1342, #1345). Bulk-approval set: "allowlist". UI test of approvals or grants: "real Gateway shapes" (#1346). Persistence or a new approval/answer field: "real SQLite round trip" (#1333, #1355). Redacting getter: "the raw setter must refuse or merge-preserve" (#1351). Exec/path/name lists: "fold NFKC + case, `realpathSync.native`, path flags and option values, fail closed" (#1361); argv classifiers: "probe each value letter against the real binary, `--` as a value, abbreviations" (#1368, #1372). Event reordering: "subscriber map" (#1364). Grants: "equality match, nlink, expiry in every accessor, real handlers" (#1366). Vault writes: "check the slug is ours" (#1373). Owner text to a model: "redact, then truncate; real redactor" (#1407). Cache or fingerprint: "same-ms write, clock step, rowid reuse; frozen clock" (#1396). Idle stop or wake: "in-flight counting; same pre-start checks" (#1401, #1402). Granted roots: "use-time re-check, magic prefixes, swapped parent" (#1384, #1395). Mode, chmod or rename after a failed open: "no by-path fallback; swap a link in at the call" (#1450 r1). Real-environment probe or lockdown: "show the control firing, then the lock" (#1295 r1). Release or workflow script: "run the non-dry path; list the env each job has" (#1295 r1). Pid or owner decisions: "server-recorded, not client-set" (#1452).
- **Merge gate:** full `verify.sh` runs touched tests and their same-named siblings only. A PR that changes widely imported or security code still needs `--related` once, or the importer tests named in the brief (#1361: 9 failures hid until the orchestrator ran them).
- **Reviewer says "fit to merge" but lists medium non-blocking findings that contradict the PR's own claims** (docs or tests saying a grant ends at `/new` when it doesn't): send them back to the builder before merging (#1366 r1, fixed in r2 and r3).
- **Conflict with main in a shared file** (`broker.ts`): resolve it in the builder's worktree, rerun the touched and sibling tests, and run one full verify.
- **Stale dependabot PRs** (300-1000 commits behind): recreate each update on a fresh branch from `origin/main` instead of rebasing.
- **Linux checks:** the OrbStack VM `psyche-linux` is approved (`orb -m psyche-linux`). Brief the builder with the rules in `psyche-builder` §3: no `/mnt/mac`, no `git` in the VM (`git archive` + `orb push`), clean up its dirs.
- **Gating two iOS PRs together (A then B):** build main+A+B locally with a 3-way `Localizable.xcstrings` union (apply B's adds and removes onto main+A), run `verify.sh --swift` once, merge A with gh, then on B's branch merge `origin/main` with `-s ours` (same tree), push, and gh-merge B. Never push a local main+A merge commit to B's branch: the criss-cross shows CONFLICTING on GitHub (#1556/#1557).
- **Stale base:** if a PR you dispatched overlaps one that merged after the builder started, tell it to merge `origin/main` and re-check fixtures before review (#1360).
- **Message files:** a PR that adds English strings naming Mac or Touch ID is not "i18n only": the platform variants and `platform-linux/windows` tests must pass (#1338 broke main).
- **Reviewers, verifiers and builders:** run verify in the foreground, report once, and don't wait with `pgrep -f` (it matches your own zsh command line; to see running verifies use `ps -axo pid,command | grep -E '^ *[0-9]+ (nice -n 10 )?bash \.claude/scripts/verify\.sh'`) (load 26 from duplicate verifies; repeated reports). Say that `tsc` runs only via verify or alone (load 22 with overlapping full runs and loose `tsc`). Stagger dispatches so full verifies don't queue 45+ minutes (slots: 8 on 12+ cores and 24+ GB, else 3 on 10+ cores). Tell builders to write verify output to a file named for the PR, run it foreground with timeout 600000 and nice, and to use PR-specific names in shared scratch dirs (`pr-body.md` and `verify2.log` were overwritten by other sessions: #1404). Remind them to run git only in their own worktree. Tell builders to send one report, stop their background tasks first, and not re-report while waiting (re-sent 3 or 4 times on #1293/#1294). A resumed reviewer's second handback is refused, so re-review briefs say "also write the report to `scratchpad/review-<pr>-r<n>.md`".

- **Heavy checks pile up:** 3-4 `--related` runs ran at once (wave 2026-11-24). Full checks run one at a time on this Mac (owner, 2026-11-18); `verify.sh`'s own slots (8 here, retry every 10 s, not FIFO) don't enforce that. So: builders' briefs don't need `--related`; the orchestrator chains its own gates one after another; reviewers and verifiers wait with the `ps` recipe above. Start at most one reviewer or verifier at a time, so a waiter isn't starved by new arrivals (a #1616 builder waited 20 min and then ran anyway).

- Merge only after step 2 passes, plus step 3 for security PRs. Standing owner authorization (2026-11-05) covers this while Actions is locked: `gh pr merge <n> --merge --admin --match-head-commit <reviewed sha>`.
- After a merge wave, check that main still builds for touched packages, and tell the owner in plain words what changed and what they must check by hand.
- Owner decisions found during review go to the owner. Don't decide them silently.

## 5. Grow the skills

- After every 5 merged builder PRs, or when the same failure shows up twice, run the `reflect` skill.
- When a builder repeats a mistake that a skill should have prevented, note it then. That is reflect's best input.

## Learnings

- 2026-11-10: preset-only dispatches ran on Opus (§1). Merging a PR does not stop its builder: it pushed to #1309's branch after the merge (#1310). After merging, tell the builder it is done (`SendMessage`) or archive its session.
- 2026-11-23: the merge gate is `verify.sh --related`, not a builder's plain pass (#1529 passed 6 tests, then 5 MCP tests failed). A builder's self-commissioned review doesn't count: commission your own. Tell iOS builders to merge `origin/main` and union `Localizable.xcstrings` right before reporting. After merging two parallel iOS PRs, run a Swift build on main: git auto-merged a duplicate `self.store = store` (2026-11-23).
- 2026-11-26: after a removal or rename merges (web shell, chat channels, Feed to Home, browser copy), tell every open builder to merge `origin/main` and grep their tests for the removed names before reporting; the gate caught stale tests in #1740, #1743, #1744, #1747. Verify on the merged head, not the head the builder verified: 23 of ~70 gate runs were "bare" (conflicts), and failures were mostly `packages/ui` (12) and `apps/gateway` (6).

# Skill changelog

Newest first. The `reflect` skill reads the top entry to know where the last pass stopped.

## 2026-11-10: reflect pass over #1305–#1310
Six builder PRs: #1305 (iOS Live Activity), #1306 (broker answer cap), #1307 (two test fixes), #1308 (helper socket pointer, two security rounds), #1309 (rate-limit copy), #1310 (missing settings label).
- **`verify.sh`: the base tree moved out of `.git`.** It lived in `.git/agent-verify/base/<sha>`. Vite treats a `.git` path segment as denied, so `packages/ui` tests there died with `Cannot find module '/test/setup.ts'` and every ui failure looked new. It now lives in `<main checkout>/.claude/worktrees/_verify-base/<sha>` (gitignored; `VERIFY_BASE_DIR` overrides), and old trees under `.git` are removed. When the base can't load a file, the log and a note say "base could not run … unknown", but the check still fails: nothing is loosened.
  - Evidence: #1309 learnings. Reproduced: a passing ui test run from the old path fails with the error above, and passes from the worktree path.
  - Tested with a committed failing test in `packages/ui` and `--base HEAD`: touching it without a new failure gives the pre-existing note, and adding a differently named failing test gives `new in …`.
- **`psyche-builder`:** check `gh pr view --json state` before every push (#1309 and #1310: two commits stranded on a merged branch); say so when you widen scope; read the three verify.sh verdicts; delete `apps/ios/.build-ios` before verifying (#1305).
- **`psyche-builder/learnings.md`:** removed the "fails on main" note for `separate-desktop` and `linux-helper-peer-check` (fixed by #1307; `setting-labels` by #1310). Replaced it with how to check a claim like that. Added the `startTestGateway` `hostPlatform` and `realpathSync` lessons (#1307) and that broker error text is user-visible (#1309).
- **`psyche-permissions` §4 (new): trust that moves to a new path or file.** Check the peer and the directory, read from one descriptor, and recheck that older negative tests still isolate their own check. Evidence: the security review of #1308 (impostor Gateway, lstat/open race, two masked tests).
- **`psyche-apple`:** helper pointer code pointers and the CRLF trap (#1308); Live Activities start on resign-active because `Activity.request` is refused in the background (#1305); a Touch ID diagnosis recipe using `/usr/bin/log show` on coreauth (orchestrator session, settled a "no sheet" report).
- **`orchestrate`:** `preset` does not carry the model, so always pass `model` with it and confirm with `get_session`; proposal cards can't carry a preset; check follow-up lists against main first (two non-issues dropped); a merged builder can keep pushing, so tell it it's done.
- **`reflect`:** a "fails on main" note is kept only after running the file on `origin/main`.
- **Not changed:** `.claude/CLAUDE.md`. Proposal for the owner: add "before every push, check the PR isn't merged" to the Git rules. #1305's `simctl launch com.apple.mobilesafari` trick is in `psyche-apple`; the Swift `node-socket` "written on every start" fact is in the code, so no skill line.

## 2026-11-09: reflect pass over #1298–#1302
All five builders predate the skills: they were Sonnet or Opus sessions with hand-written briefs and no `verify.sh`. So this pass can't judge how Haiku builders use the skills. The next pass is the first that can.
- **New skill `psyche-permissions`.** It covers trust from the connection, changing a shared predicate, classifiers that must be precise both ways, the probe-table pattern, sealed owner-choice keys and the suites to run. `psyche-builder` step 1 now points to it.
  - Evidence: #1299 (2 fix rounds), #1300 (2 fix rounds plus an owner decision) and #1301 (5 review rounds, model switched to Opus after R2) all had repeat trouble in this area.
  - #1301's reviewers named about 17 missed payments and about 12 over-matches across R1–R5. The two-way probe lists that first appeared in R2 caught them.
- **`verify.sh`: pre-existing failures compared per test name, not per file.** A file that already failed on the base used to hide new failures in it. A re-run that crashes before reporting now fails the check, where before it passed. This tightens verification; nothing was removed.
  - Evidence: #1301 R3, where `packages/ui/test/platform-{windows,linux}.test.tsx` were labelled pre-existing although the builder's new string broke them.
  - Tested by adding a failing test to `apps/gateway/test/separate-desktop.test.ts`, which already fails on main: main's `verify.sh` passed it as pre-existing, and the new one fails and names the test. Touching the file without a new failure still passes, with the pre-existing note.
- **`psyche-builder` step 2.** Three new rules:
  - Grep the tests for the old expectation on any behaviour change, including owner decisions. Evidence: 8 existing tests broken in #1299 (host-terminal), #1300 (passkeys, card-chrome-lint, model-settings) and #1301 (vault resolve, remote-presence, platform-windows and platform-linux).
  - Write a both-directions probe table for classifier-like work. Evidence: #1299's failure-cap rejection set, #1300's allowlist by provider id, #1301's money-intent.
  - When a fix changes a shared predicate, list its callers. Evidence: #1299 R2's `local` spoofing came from the R1 fix; #1301 R2's B1 came from the finding-5 fix.
- **`psyche-builder` review rounds:** each finding gets a test that fails without the fix, and `verify.sh` runs after every round. Evidence: in #1300's final round the builder skipped the related suites and `model-settings.test.ts` broke. The orchestrator fixed it in 79dd382a.
- **`psyche-builder/learnings.md`:** `separate-desktop` and `linux-helper-peer-check` fail on main on this Mac. Evidence: named in #1299, #1300 and #1301; re-checked in the base tree at 7cc4a2f.
- **`orchestrate` steps 3.4 and 3.5:** send probe lists as table rows, tell the builder to grep tests when relaying an owner decision, have re-reviews read the full diff, and escalate after 2 rounds of blocking findings in one area. Evidence as above. #1301 was switched to Opus after R2 by hand, because the "same finding twice" rule never fired: every round's findings were new. R3–R5 still followed on Opus; the probe table, not the model, closed them.
- **`reflect` step 1 (the process):** reviews are `SendMessage` turns in builder transcripts, not GitHub comments. All five PRs had 0 GitHub comments. Commit trailers show the builder's model.
- **Not changed:**
  - The trust-flag learning, already in `learnings.md`. It is restated in `psyche-permissions` §1 because that is where builders touching the broker will look.
  - The Swift build overlap (once, in #1301; already a hard rule, and `verify.sh --swift` waits).
  - The 2 `failures.tsv` rows with empty check names (setup branch only).
  - #1301 R4's two hook blocks on main's own failures: the cause is unknown and the logs were overwritten. The base tree does report them as failing.

## 2026-11-09: verify runs related tests by default
- `verify.sh`: in each touched package it now runs `vitest related` on the touched files, not only the touched test files (`--no-related` opts out). A failing file gets one re-run as a flake filter, then a run on the merge base. Failures that also happen on the base are reported as pre-existing and don't block.
- Evidence: the independent reviews of #1299 (`apps/gateway/test/host-terminal.test.ts:619` broken by `connection.ts`) and #1300 (`apps/gateway/test/passkeys.test.ts:141` broken by `handlers/settings.ts`). Both builders ran only the tests they wrote. A clean main also had 2 failing gateway tests, so a pre-existing failure would otherwise have blocked every builder.
- Cost: a `connection.ts` change pulls in 149 of 244 gateway test files, about 6 min with one worker. The Stop hook timeout was raised to 30 min.

## 2026-11-09: initial setup (up to PR #1300)
- Created `orchestrate`, `psyche-builder` (+ `learnings.md`, seeded from the orchestrator's ops memory), `psyche-i18n`, `psyche-apple` and `reflect`.
- Created the agents `haiku-verifier` and `security-reviewer`. Builders are sessions, not subagents, so the owner can see and steer them. Their compaction tier comes from the presets `psyche-haiku-40` and `psyche-haiku-60`.
- Added the verification loop: `.claude/scripts/verify.sh` plus the Stop hook `stop-verify.sh`.
- Evidence: owner request on 2026-11-09, and the ops rules from 2026-10-19 to 2026-11-09.

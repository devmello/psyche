# Skill changelog

Newest first. The `reflect` skill reads the top entry to know where the last pass stopped.

## 2026-11-23 (b): reflect pass over #1533, #1540, #1542-#1549
Last pass: #1538. Evidence: the orchestrator's wave notes, security-reviewer memory (settings-narrowing, launch-config, owner-file-write patterns) and the haiku-verifier recurring-problems note (#1542 zh-Hans, #1543 sibling collisions).
- **`verify.sh`:** new `xcstrings-coverage` check (`.claude/scripts/xcstrings-coverage.py`), run only on touched `.xcstrings`; all 11 locales per translated key (#1542). Tested on a scratch catalog with a missing zh-Hans (fails) and the 5 current catalogs (pass).
- **`psyche-i18n`, `psyche-apple`:** the check; build after merging parallel iOS PRs (duplicate `self.store = store`, #1542/#1543).
- **`psyche-permissions` §3g:** checklist for the five repeat findings (#1533, #1540/#1544, #1545, #1546, #1549).
- **`orchestrate`:** escalate multi-finding security rounds to Sonnet (#1545); a `ps` recipe instead of `pgrep -f verify.sh`; Swift build after parallel iOS merges.
- **`security-reviewer` agent:** downloads need the owner's go-ahead.
- **`psyche-builder/learnings.md`:** zsh `"${H}:path"`.

## 2026-11-23: reflect pass over #1527-#1538 (Mac and iOS wave)
Last pass: 2026-11-19 (e). Evidence: the orchestrator's learnings for the wave (#1529, #1531, #1533, #1537, #1538, iOS string-catalog conflicts, shared scratchpad overwrites).
- **`psyche-builder`:** plain verify is not the merge gate, run `--related` for shared `packages/ui` screens (#1529); unique scratch file names incl. commit messages; no self-commissioned reviews. `learnings.md`: unique accessible names on composite pages (#1529), Electron quit ordering and dirty-flag guards (#1531, #1538), off-machine feature rules (#1533).
- **`psyche-i18n`:** `bundle: .module` in package targets, per-module catalogs (`LocalizedLiteralsTests`), xcstrings JSON-union conflict recipe.
- **`psyche-apple`:** `pgrep -x` build check, `bundle: .module` pointer, NEL/C1 pointer. `.claude/CLAUDE.md` pgrep wording updated to match.
- **`psyche-permissions`:** NEL/C1 approval sanitizers (#1537); empty-list fallback widens access (#1529).
- **`orchestrate`:** merge gate and review ownership learning.

## 2026-11-19 (e): reflect pass over #1446, #1437, #1448, #1438, #1451, #1293, #1436, #1452, #1454 (wave 8)
Last pass: #1445. #1274 parked unmerged (review-1274-r1: missing `install-package` root helper), not a pattern yet. Evidence: `review-1293` r3-r6, `-1294-r7`, `-1295-r1`, `-1436-r3`, `-1437-r3`, `-1438-r3`, `-1450-r1`, `-1452-r1`, the PR Learnings, and the coordinator's notes.
- **`psyche-builder`:** no fd-to-path fallback (#1450 r1); server-recorded identity (#1293 r6, #1452); real-environment probes need a control that fires (#1295 r1); dry runs hide release breaks (#1295 r1); VM rules: no `/mnt/mac`, `git archive` + `orb push` because the worktree guard refuses `git` in the VM, clean up (coordinator); report once and stop background tasks first (coordinator, #1293/#1294). `learnings.md`: `git grep` pathspec (#1446), `--smoke-only` (#1448), migration checksum (#1436 r3, one occurrence, kept because it breaks local homes), gzip payloads and `toolChoice` (#1436, #1437).
- **`psyche-permissions`:** two 3b bullets for the same fd rule and server identity.
- **`orchestrate`:** brief wording for the new areas; VM line points at the builder rules; one-report instruction.
- **Already covered:** pattern 1 (`--related` missing a dependent test) was fixed in `verify.sh` by #1446 and is documented in builder §3 item 3. No new check added. Residual in #1446: tests that reach a package only through another module are still not found.
- **Not changed:** #1274 (single PR). Stale-advice sweep found nothing to delete; the builder `--related` text still matches #1446.

## 2026-11-19 (d): reflect pass over #1432, #1434, #1435, #1439, #1440, #1442, #1443, #1444 (wave 7)
Evidence: coordinator notes (#1436, #1437, #1438, #1427, #1435).
- **`psyche-builder`:** `--related` is per package (checked in verify.sh), so a rule to run dependent app tests for shared-package changes (#1437 `context.test.ts`); error handling travels with a moved call (#1436); carry-forward lists (#1437); node-gyp env for pnpm 12.4.1; the `psyche-linux` OrbStack VM.
- **`psyche-permissions`:** exemptions need probes that the old attack still fails (#1438, #1427); carry-forward trust (#1437).
- **`orchestrate`:** dependabot PRs recreated on fresh branches; Linux VM note.
- **Not changed:** `verify.sh` (a cross-package related run would need per-dependent runs, too heavy to do small; left as a rule). Owner could decide whether to build it.

## 2026-11-19 (c): reflect pass over #1427-#1431 (wave 6)
Evidence: coordinator notes and the PR Learnings of #1427, #1428, #1430, #1431; #1427 took 3 rounds of regressions (Spotify, Safari, Shortcuts Events).
- **`psyche-builder`:** report asks for the head sha and `git diff --stat origin/main...HEAD` (merge-commit stat, #1293, #1432); the harness backgrounding verify at ~180 s is expected, wait (coordinator).
- **`orchestrate`:** briefs from research notes say "check each item against main first" (#1430); re-review briefs also ask for `scratchpad/review-<pr>-r<n>.md` since a second handback is refused.
- **`psyche-permissions`:** APFS fold formula with `dev:ino` (§3d); learning on probing installed bundle ids when narrowing app paths (#1427). **`psyche-apple`:** the same learning.
- **Not changed:** #1428 git `core.gitProxy`/`.gitmodules` notes and #1431's helper-refusal gate are code facts, not skill rules (once each).

## 2026-11-19 (b): reflect pass over #1375-#1407 (wave 5)
Merged: #1375, #1377, #1380, #1381, #1384-#1391, #1394-#1402, #1404, #1406, #1407 (last pass: #1374). Evidence: `review-1375`, `-1380`, `-1381`, `-1384`, `-1387`, `-1388`, `-1391`, `-1395`, `-1396` r1-r2, `-1397`, `-1400`, `-1401`, `-1402`, `-1407`, the PR Learnings, and the orchestrator's 11 lessons of the day. Rounds: #1384 HIGH then #1387/#1388/#1389/#1395 follow-ups (#1395 HIGH regression), #1396 2 rounds (cache privacy regression), #1407 blocking.
- **`psyche-builder`:** "check main first" (2 stale dispatches, #1392); verify.sh recipe in one list: commit and merge main first (#1397, #1398), foreground niced with a file log (#1396, #1407), 3 slots (#1394), PR-specific names in shared scratch (#1404), git only in your own worktree, nvm PATH (#1390). New §2 bullets: redact before truncate (#1407 r1), cache/fingerprint keys and frozen clocks (#1396 r2), idle timers and wake paths (#1401 r1, #1402 r1), 1 MiB frame cap (#1381).
- **`psyche-permissions`:** §3d folder and root refusal (use-time re-check, magic prefixes, exec user's home, swapped parent: #1384, #1387, #1388, #1395); new §3f owner text to models (#1407). Learning on in-flight counting (#1402).
- **`orchestrate`:** "Check main first" line in the brief template; dispatch check strengthened; verify slots and scratch-name instructions; brief wording for redaction, caches, idle wake, granted roots.
- **`learnings.md`:** TS/testing-library/Biome quirks, i18n scan, mock-gateway `fail()`, fixed `now`, composeSearch, MCP SDK double spawn, Swift `Task`. Pruned the `pgrep` line (now in the builder verify list).
- **Not changed:** `verify.sh` (#1390 and #1394 already fixed the lock and pnpm); `psyche-apple`, `psyche-i18n` (learnings only); #1383, #1386, #1398, #1399 gave no new pattern.

## 2026-11-19: reflect pass over #1366, #1368–#1374 (wave 4)
Merged: #1366, #1368, #1369, #1370, #1371, #1372, #1373, #1374 (last pass: #1367). Evidence: `review-1366` r1–r3, `-1368` r1–r2, `-1372` r1, `-1373` r1, and the PR Learnings of #1366, #1368, #1369, #1371, #1372, #1373. #1366 took 3 rounds, #1368 2 (r1 HIGH), #1372 and #1373 had one non-blocking round.
- **`psyche-permissions`:** §3d now holds the exec/argv/path rules (moved from `psyche-builder`) plus argv classifier rules: `--` as an option value, per-tool attached-value letters, long-option abbreviations, probing real binaries, relaxations need review (#1368 r1, #1372 r1). New §3e: grants with identity, expiry in every accessor, real handlers for `endSession`, a record never grants, fenced third-party text in prompts, vault slug ownership, device audit actors (#1366, #1373, #1374).
- **`psyche-builder`:** fresh-worktree install (`--ignore-scripts`, `pnpm_config_verify_deps_before_run=false`, `PNPM_CONFIG_IGNORE_SCRIPTS`) (#1369, #1371, #1372, #1373); fire-and-forget `.catch` (#1366). Pruned: the name-list, path-confinement and exec bullets (now one pointer to permissions §3d), the two overlapping merge-main bullets, the sibling-tests paragraph and the fixtures bullet (shortened).
- **`learnings.md`:** bash 3.2 and `sed -i ''`, `rg` is a function, heredoc and Write quirks, prop-rename and `describeCall` notes. The zsh word-split entry now also covers probe loops (#1371, #1369, #1372, #1366, #1368).
- **`orchestrate`:** orchestrator-fix example refs; "fit to merge" with contradicting medium findings goes back to the builder (#1366 r1); conflict-in-shared-file recipe; install flags in the verify worktree; the two brief-wording bullets merged into one list with the new areas.
- **Not changed:** #1370 and #1374 gave no new pattern beyond the record/grant rule.

## 2026-11-18 (d): reflect pass over #1360–#1365 (wave 3)
Merged: #1360, #1361, #1362, #1363, #1364, #1365 (last pass: #1359). Evidence: `review-1361-r2`, `review-1364-r1` and the wave-3 notes in `followup-1323.md`. Only #1361 had blockers (B1–B4, r2 items); #1364 was clean in round 1.
- **`verify.sh`:** full mode also runs the same-named test of each touched source file (`x.ts` -> `x.test.ts`, beside it or in `test/`). Light: a few files, no import graph. `--related` is unchanged. Evidence: #1361 passed verify with 9 `exec-host.test.ts` failures hidden. Never loses a check.
- **`psyche-builder`:** sibling/importer tests before the PR (#1361); merge `origin/main` before starting and before the PR for fixtures (#1360, #1346); name lists fold NFKC + case with `realpathSync.native` (#1361 B3); path confinement covers follow flags and path-valued options with temp-root `denyRead` (#1361 r2); lookups fail closed (#1361 r2); subscriber map before reordering an emit (#1364).
- **`psyche-permissions` §3d (new, short):** pointer to those rules plus probe rows.
- **`orchestrate` §4:** merge gate needs `--related` for widely imported or security code; stale-base note; brief wording for exec confinement and event reordering.
- **Not changed:** nothing pruned, no stale advice found; #1362, #1363, #1365 gave no new pattern.

## 2026-11-18 (c): reflect pass over #1348–#1357
Merged: #1348, #1350, #1333, #1351, #1355, #1353, #1356, #1354, #1357 (#1358 open, r1 blocked). Evidence: reviewer reports `review-1333` r3–r4, `-1348`, `-1350`, `-1351` r1–r2, `-1353`, `-1354` r1–r3, `-1355`, `-1356`, `-1357`, `-1358` r1, plus the orchestrator's patterns. Only #1333, #1351, #1354 and #1358 had blockers; the rest were clean first round.
- **`psyche-permissions` §3c (new):** redacted reads must not round-trip into writes (#1351 B1); a "narrower?" check must model engine resolution and be probed with real `decide()` (#1354 x3); receipts match by grant or approval id (#1358 B1). Intro now counts #1354.
- **`psyche-builder` §2/§3:** real-SQLite round trip for each new approval or answer field (#1333, #1355); extension allowlists are still deny-lists (#1333 r3); `tsc` only via verify or alone (load 22, 45-minute verify queue).
- **`orchestrate`:** orchestrator fixes a small area itself after two blocking rounds (#1354 r2); reviewers probe the real engine; re-reviews after a main merge diff first-parent commits (#1354 r2); brief wording for redaction and SQLite; stagger verifies.
- **Not changed:** nothing pruned, no stale advice found; the clean-first-round PRs (#1348, #1350, #1353, #1355, #1356, #1357) gave no new pattern.

## 2026-11-18 (b): reflect pass over #1332–#1347
Nine merged PRs: #1332, #1340–#1347 (#1333 still in review). Evidence: reviewer reports `review-1332-r2`, `-1333-r2`, `-1340` r1–r3, `-1342`, `-1343` r1–r3, `-1345` r1–r2, `-1346` r1–r2 and the orchestrator's notes in `followup-1323.md`.
- **`verify.sh`:** runs `platform-linux`/`platform-windows` when `packages/ui/src/i18n/messages/**` changes (not in `--quick`). #1338 broke main because `--related` skips them.
- **`psyche-i18n`:** platform-variant section (#1338).
- **`psyche-builder` §2:** real-shape fixtures and real-store tests (#1346, #1333); allowlists over deny-lists and no round-tripping redacted values (#1333, #1343); three-way fuzz for decoders (#1342, #1345); guard empty file lists.
- **`psyche-permissions` §3:** check the host being read, quiet allows never feed `touched`, grant labels from full scope (#1340 x3 rounds, #1346, #1343).
- **`orchestrate`:** brief wording for those cases, message-file PRs are not "i18n only", explicit file lists.
- **Not changed:** nothing pruned, no stale advice found.

## 2026-11-18: reflect pass over #1315–#1335
Sixteen merged PRs: #1315, #1317, #1319–#1326, #1328–#1331, #1334, #1335. Evidence is the orchestrator's review reports (`review-1317`, `-1321` r1–r7, `-1323`, `-1327`, `-1329` r1–r3) and the merge log.
- **`psyche-permissions` §3:** no whole-label or whole-route exemptions (#1321, 7 rounds).
- **`psyche-permissions` §3b (new):** fail closed instead of skipping, validate the resolved target, check every new action path against existing prohibitions, presence stays payments-only (#1329 B1/B2 and r2, #1315 vs #1321, #1327).
- **`psyche-builder`:** positive controls for negative tests (#1318, #1325, #1327, #1329); re-run both PRs' tests after merging main on shared UI (#1331); run verify in the foreground, avoid `pgrep -f` self-match, `--ignore-scripts` for fresh worktrees (load 26); report once.
- **`orchestrate` §4:** merge-order re-test, new-action-path review brief, reviewer load and duplicate-report rules.
- **`psyche-i18n`:** Gateway notices need all 10 languages (#1327, #1333).
- **Agents:** `security-reviewer` gets the five checks above; `haiku-verifier` gets the absence-only, merge-order and English-only checks and report-once.
- **Not changed:** no `verify.sh` change (no evidence a script could catch these); no stale advice found to prune. The `pgrep` line in `learnings.md` already existed, so builder and orchestrator text now points at it.

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

---
name: psyche-builder
description: How a builder session works on Psyche from brief to PR. Covers reading the brief and goal, finding the code, making the change, the local verification loop, opening the PR and the report format. Invoke it first in any session the orchestrator started to build, fix or investigate something in this repo.
---

# Building on Psyche

The orchestrator gave you a brief and usually a `/goal`. Your job is one focused PR that meets the "Done means" in the brief, verified locally, with an honest report. The hard rules in `.claude/CLAUDE.md` apply at all times.

## 1. Understand before editing

- **Check main first.** Before you build, `git log origin/main --oneline -S'<identifier>'` or grep for the feature. Two dispatched tasks (helper quits with Psyche; web-client copy, #1392) were already on main. If it is done, report that with the commit and stop; don't re-do it.
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
- **Negative tests need a positive control.** A test that only asserts absence (reduced motion #1318, "picker hidden" #1325) passes when the feature is broken. Pair it with a case where the thing does appear, and run the test against the code it is meant to guard: #1327's redaction test built its own redactor, and #1329 B1/B2 tests covered only normal cases while the hole stayed open. In a real-environment probe (a VM, a container, an installed app) the control must show the thing firing first: #1295's LibreOffice lockdown looked proven until r1 ran the same probe without the lock and found `macro:///` ran in both.
- **Merge `origin/main` before you start and again before the PR.** Fixtures drift (#1360 after #1346), and a merged-in PR's tests can contradict yours: #1325 hid the Persona picker, #1328 brought it back, main broke (#1331). If the merge touches the same UI or module, re-run the tests of both before you push.
- **Reordering or adding an emit:** list every subscriber of that event first (`git grep` `subscribe(` and the topic) and say what each relies on (audit row, grant, folder applied). Put the table in the PR body (#1364 did, review passed clean).
- **A fix that changes a shared predicate** (who is local, enrolled, ready, financial): list its callers and test one you didn't mean to change. Fixes opened new holes in #1299 and #1301. See `psyche-permissions` §2.
- **Test fixtures use the shapes production sends.** Read the producer first. #1346 tested approvals and grants in shapes the Gateway never sends (real approval details are `{tool, params, target}`, grant subjects `{grantKey, target, sideEffect}`, grantKeys `<tool>|<kind>:…`, accounts can contain `:`). Test persistence on the real store: #1333 and #1355 had SQLite stores that silently dropped new columns on the next read. Every new approval or answer field gets a real-SQLite write-then-read test.
- **Bulk-approvable or "routine" sets are allowlists, not deny-lists.** #1333's deny-list leaked `.claude/settings.json`, `node_modules/.bin` and `ſetup.py` (case folding on APFS), and r3 found an extension allowlist (`json`, `txt`) was still a deny-list by name (`lefthook.json`, `requirements.txt`). Allow exact known-safe names, not extensions. Redacted display values must never round-trip back as input: refuse placeholders (#1343).
- **Trace a fix to what the user sees.** When you wire a backend for an existing UI flow, follow the event or response through to the pixels: which window, which layout key, is it visible. #1552 added the Gateway `view.*` handlers, but the desktop applied `view.command` to the route thread's layout, not the visible `paneKey`, and never raised the Settings window, so Watch returned success and nothing appeared (the security reviewer caught it). Add a test on that decision. For iOS, also add the `FixtureBackend` implementation (`psyche-apple`).
- **An approval-triggered action runs on the Gateway, not in a view.** Installs fired from an event, or only while Settings was mounted, failed silently or never ran (security reviews, wave 2026-11-24). Run it server-side and report failure to the owner (card, toast or error state), not just a log line.
- **Mac UI work:** look in `packages/ui` first. `apps/web/src/shell` is partly a fallback, though some `ShellApp` parts are live: check which one renders before editing.
- **Exec, argv, path or name-list classifiers** (programs, files, keys, tool options): follow `psyche-permissions` §3d.
- **Lookups fail closed.** A missing optional dependency (`listGrants`, a resolver, a store) must throw when the caller needs it, never fall back to the weaker path (#1361 r2).
- **Never fall back from an fd to a path.** When an fd-based open fails (EACCES on a folder the run made unreadable), a by-path `chmod`/`rename`/`unlink` follows a link the run swapped in and hits the owner's file outside the share (#1450 r1: owner folder 0700 to 0577). Refuse and report the entry as `unmoved`; at most use `lchmod`, and mask setuid/setgid/sticky bits out of any mode you copy.
- **Ask the server, not the client, who someone is.** A pid, uid or owner the client can set (`_NET_WM_PID`) decides nothing. Use what the server records from the socket (X-Resource `LocalClientPID`, `SO_PEERCRED`), and fail closed when it is missing (#1293 r6, #1452 r1).
- **Fire-and-forget promises need `.catch`.** psyched has no `unhandledRejection` handler, so a rejected `void` promise can take the Gateway down (#1366; see `compose/thread-end.ts`).
- **Redact, then truncate.** Any text of the owner's that goes to a model (learner, titles, compaction, search cards) is redacted first and cut second. A cut value no longer matches the redactor: #1407 r1 sent 10 of 16 secret characters to the utility model. Test with the real `SecretRedactor` and a secret that straddles the cut. See `psyche-permissions` §3f.
- **Caches and fingerprints:** a key on `max(updated_at)`, a count or a rowid misses same-millisecond writes, clock steps and rowid reuse, so a hidden or retracted item can be served for hours (#1396 r2, a privacy regression). Key on content or on a version bumped by every write path, and freeze the clock in tests with fake timers.
- **Idle timers and wake paths:** a timer that checks only the last acquire drops a safety tap or a connection mid-action. Count in-flight work (#1402 r1, Esc tap). A lazy restart or wake runs every pre-start check a normal start runs (hash, `madeBy`, bundle staleness: #1401 r1).
- **Moving a call to a new site carries its error handling.** #1436 moved the heal out of `connection.ts`, where a try/catch meant a failed sweep never fails the call, into a hook without it, and Forget then failed after it had committed. List the old try/catch, `.catch` and fallbacks and re-create each.
- **Carry-forward lists** (pinned, remembered, carried instructions) need a revoke path and per-item trust, and untrusted items must never evict trusted ones: #1437 `carryPinned` was append-only and a flood could evict.
- **Dry runs hide release breaks.** A `--dry-run` that swaps in placeholders passes while the real path fails: #1295 r1, `publish.sh --merge` needed `PSYCHE_HELPER_SHA256`, which `GITHUB_ENV` never carries between jobs, so every tag release would have stopped. Test the non-dry path with stub binaries, and read what each workflow job actually has in its env.
- **Frames over 1 MiB** (`MAX_FRAME_BYTES`) close the socket and fail every call in flight: cap text-carrying methods well below it (#1381).
- **Decoder, normaliser or redaction changes:** fuzz three ways (before, main, head) and report how many inputs got quieter or louder (#1342, #1345). Redaction helpers need two-way tests for every URL form (#1343).
- **Guard the file list.** An empty `$files` makes `vitest run` or `vitest related` run the whole suite (the whole ui suite ran once by accident). Check `[ -n "$files" ]` first, and never run a whole package suite (`packages/permissions`) to be safe.
- Keep to the brief's scope. Unrelated problems you notice go in the report under "Noticed", not in the diff. If you do widen the scope (a fix you can't leave out), say so in the report. In #1309 the builder added a label fix the brief never mentioned.
- Protocol changes: `pnpm protocol:gen`. If you add an enum value, update the Swift helper's exhaustive `switch` sites and the TS `Record<Kind, …>` maps.

## 3. Verify (the loop)

Linux tests: the owner approved the OrbStack VM `psyche-linux` (`orb -m psyche-linux <cmd>`; Ubuntu 24.04). Rules:
- Never read or write `/mnt/mac` (the owner's files), and start nothing else VM-like.
- The worktree guard refuses `git` inside the VM shell. Ship the tree with `git archive HEAD | ...` then `orb push` into a dir under the VM home, and build and test there.
- Name your dirs after your PR or branch, and delete them (and any process you started) before you report. Other sessions share the VM.

The owner's rule (2026-11-18): don't overheat the Mac. Size checks to the change.
1. While you work, run only the test files you touched: `pnpm exec vitest run <files> --maxWorkers=1`. Don't run `verify.sh` after every small fix.
2. When the change is done, run `pnpm exec biome check --write <touched dirs>`, then `bash .claude/scripts/verify.sh` once (add `--swift` if you touched Swift). It typechecks the touched packages and runs the touched tests. Fix failures by re-running just the failing files, then run `verify.sh` once more before you push.
3. **`--related` is the orchestrator's or reviewer's merge gate, not yours:** builders hit the turn cap waiting on it (wave 2026-11-24). Run plain `verify.sh` and report; run `--related` only when the rule below or the brief says so, once. `--related` runs `vitest related` inside each touched package only, so apps that import a package's exports would never run. It now also runs the app test files that import a touched `packages/<pkg>/src` package (`git grep` for `@psyche/<pkg>` under `apps/*/test`, capped at `PSYCHE_VERIFY_DEP_CAP`, default 60; `--no-related` skips it). You don't run those by hand. The #1437 break in `apps/gateway/test/context.test.ts` is the case it covers. If you changed widely imported code (a shared hook, store, protocol type or permission rule), also run `verify.sh --related` once before the PR. It runs every existing test that imports what you changed, which is where builders most often break things unnoticed (#1299, #1300). Otherwise the merge gate runs it. A plain `verify.sh` pass is not the merge gate: #1529 reported "6 passed" while `--related` failed 5 MCP tests. Run `--related` once before reporting whenever you touch `packages/ui` shared screens.

**Sibling tests (#1361):** `verify.sh` also runs the same-named test of each touched source file, not differently named tests that import it. Before the PR, `git grep -l "<module name>" -- '*.test.*'` for each changed module and run those too (#1361 hid 9 `exec-host.test.ts` failures).

verify.sh compares your failures with a run on the merge base. "also failing on the base" is not your problem. "new in" is. "base could not run" means unknown: run that file yourself on `origin/main` before you call it pre-existing. Delete untracked build output first (`apps/ios/.build-ios`): biome lints it (#1305).

Run `tsc` only through `verify.sh`, or alone, never in parallel with your own verify (load hit 22).

**How to run `verify.sh` (#1375, #1396, #1397, #1398, #1404, #1407, #1394):**
- Commit first and merge `origin/main`: it checks the committed diff against the merge base, so uncommitted files or a stale base mean it checks the wrong set.
- The harness moves a command that runs past ~180 s to the background. That is expected: wait for its completion notice and read the log. Never start a second run.
- Run it in the foreground, niced, with a long timeout, and write the output to a file with a PR-specific name: `nice bash .claude/scripts/verify.sh > "$SCRATCH/verify-<pr or branch>.log" 2>&1` with the Bash timeout at 600000. A backgrounded `| tail` loses the result, and the Stop hook starts a second full verify if you end your turn while one runs in the background (load 26).
- Full checks share 8 slots on 12+ cores with 24+ GB, 3 on 10+ cores, 1 otherwise; a run waits for a free one, sometimes tens of minutes. Don't start another and don't poll with `pgrep -f "verify.sh"`, it matches itself.
- Shared scratch dirs belong to every session: name every file after your PR or branch (`pr-1404-body.md`, `verify-1404.log`, `<branch>-commit-msg.txt`). Other sessions overwrote `verify2.log` (#1404), `pr-body.md` and commit-message files (wave 2026-11-23).
- Don't spawn your own security-reviewer or other reviewer: it isn't independent for the orchestrator, who commissions reviews. Don't spend on it.
- Run git only in your own worktree. A builder switched another worktree's branch.
- **Fresh worktree (#1369, #1371–#1373):** there is no `node_modules`, so `pnpm exec` and `verify.sh` try a full install and better-sqlite3's node-gyp fails, making every step FAIL. Run `pnpm install --frozen-lockfile --prefer-offline --ignore-scripts` once; if pnpm still reinstalls, set `pnpm_config_verify_deps_before_run=false`. The Gateway bundle build wants `PNPM_CONFIG_IGNORE_SCRIPTS=true` (the `PNPM_CONFIG_` form; `npm_config_*` is ignored).
- If the better-sqlite3 rebuild says node-gyp is missing (pnpm 12.4.1 under corepack), set `npm_config_node_gyp=<node dir>/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js` (path of the Node on your PATH).
- If `pnpm: command not found` (the session's Node has none), run `export PATH=$HOME/.nvm/versions/node/v24.22.3/bin:$PATH`. `verify.sh` itself falls back to nvm's default since #1390.

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
- the head sha and `git diff --stat origin/main...HEAD`. Not `git show --stat HEAD`: when HEAD is a merge commit it shows main's incoming changes (#1293, #1432);
- "Not verified", "Noticed" and any question for the orchestrator.

Send the report once (#1293, #1294 and #1437 builders re-sent the same report 3 or 4 times, and left background monitors running). Before you report, stop your background tasks and monitors. After you report, don't re-send it, even while waiting for the orchestrator. No praise or filler. If something failed, say it failed.

When the orchestrator sends review findings, fix them on the same branch, verify, push, and report again in the same shape:
- Each finding gets a test that fails without your fix.
- Check the PR is still open before you push (§4).
- Each round: run the tests for what you changed, then `verify.sh` once before you push. Add `--related` when the round touched shared code; "this change doesn't touch them" was wrong in #1300's last round.
